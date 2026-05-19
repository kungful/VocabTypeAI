import json
import os
import sys
import hashlib
import asyncio
import wave
import tempfile
import threading
import numpy as np

from flask import Flask, request, jsonify, send_file, render_template
from flask_cors import CORS
from openai import OpenAI

# --- Path setup ---
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PARENT_DIR = os.path.dirname(BASE_DIR)
sys.path.insert(0, PARENT_DIR)

from new_logic.dictionary_translator import (
    load_dictionary_metadata,
    get_translated_dictionary_names,
    get_filename_to_description_map,
)

app = Flask(__name__)
CORS(app)

_tts_locks = {}
_tts_locks_mutex = threading.Lock()
_sentence_locks = {}
_sentence_locks_mutex = threading.Lock()

# --- Configuration ---
CONFIG_FILE = os.path.join(BASE_DIR, "config.json")
AUDIO_CACHE_DIR = os.path.join(BASE_DIR, "audio_cache")
SENTENCE_CACHE_DIR = os.path.join(BASE_DIR, "sentence_cache")
os.makedirs(AUDIO_CACHE_DIR, exist_ok=True)
os.makedirs(SENTENCE_CACHE_DIR, exist_ok=True)

DATA_DIR = os.path.join(PARENT_DIR, "data")

# --- Kokoro TTS (lazy load) ---
_kokoro_models = None
_kokoro_pipelines = None
_CUDA_AVAILABLE = False


def _get_kokoro():
    global _kokoro_models, _kokoro_pipelines, _CUDA_AVAILABLE
    if _kokoro_models is None:
        try:
            import torch
            from kokoro import KModel, KPipeline

            _CUDA_AVAILABLE = torch.cuda.is_available()
            _kokoro_models = {
                gpu: KModel().to("cuda" if gpu else "cpu").eval()
                for gpu in [False] + ([True] if _CUDA_AVAILABLE else [])
            }
            _kokoro_pipelines = {
                code: KPipeline(lang_code=code, model=False) for code in "ab"
            }
        except ImportError:
            print("WARNING: kokoro not installed. TTS will be unavailable.")
            _kokoro_models = False
            _kokoro_pipelines = False
    return _kokoro_models, _kokoro_pipelines, _CUDA_AVAILABLE


# --- Config management ---
def load_config():
    default = {
        "deepseek_api_key": "",
        "sentence_api_key": "",
        "sentence_system_prompt": (
            "You are a helpful assistant that provides sentence examples, phonetics, "
            "and detailed translations with parts of speech in a JSON format. "
            "Use common abbreviations for parts of speech (e.g., n., v., adj.)."
        ),
        "sentence_prompt_template": """For the word "{word}", provide the following in a JSON format:
1. A short, concise English sentence using the word (5-8 words, everyday conversational style).
2. The Chinese translation of the short sentence.
3. A grammatical explanation of the short sentence in Chinese.
4. A complex English sentence using the word (with clauses, advanced vocabulary, academic or literary context, 15+ words).
5. The Chinese translation of the complex sentence.
6. A grammatical explanation of the complex sentence in Chinese.
7. The International Phonetic Alphabet (IPA) transcription.
8. A list of its Chinese translations, including part of speech and definition.

Example JSON format for the word "book":
{
  "short_sentence": "Let's book a table for tonight.",
  "short_sentence_translation": "我们订张今晚的桌子吧。",
  "short_sentence_grammar": "这是一个祈使句。'Let's' 是 'Let us' 的缩写，表示建议。'book' 在此作及物动词。",
  "complex_sentence": "Although I had already booked a table at the renowned restaurant overlooking the harbor, the concierge insisted that I confirm my reservation at least 24 hours in advance.",
  "complex_sentence_translation": "尽管我已经预订了那家俯瞰海港的著名餐厅的桌子，前台还是坚持要我至少提前24小时确认预订。",
  "complex_sentence_grammar": "这是一个让步状语从句。'Although' 引导让步状语从句。'booked' 是过去完成时。",
  "phonetics": "/bʊk/",
  "translations": [
    {"partOfSpeech": "n.", "definition": "书, 书籍; 卷, 册"},
    {"partOfSpeech": "v.", "definition": "预订, 预约"}
  ]
}""",
        "voice": "af_heart",
        "speed": 1.0,
        "tts_use_gpu": "auto",  # "auto", "gpu", "cpu"
    }
    try:
        if os.path.exists(CONFIG_FILE):
            with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                loaded = json.load(f)
                default.update(loaded)
    except Exception as e:
        print(f"Error loading config: {e}")
    return default


def save_config(data):
    try:
        with open(CONFIG_FILE, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
    except Exception as e:
        print(f"Error saving config: {e}")


def _safe_cache_name(name):
    return "".join(c if c.isalnum() or c in "-_" else "_" for c in (name or "default"))


def _atomic_json_write(path, data):
    fd, tmp_path = tempfile.mkstemp(suffix=".json", dir=os.path.dirname(path))
    os.close(fd)
    try:
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)
        os.replace(tmp_path, path)
    except BaseException:
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)
        raise


# --- Dictionary helpers ---
_dictionaries_cache = {}
_metadata_cache = {}
_fname_to_desc = {}


def _load_dicts():
    global _dictionaries_cache, _metadata_cache, _fname_to_desc
    if not _dictionaries_cache:
        metadata_path = os.path.join(PARENT_DIR, "data", "字典.ts")
        _metadata_cache = load_dictionary_metadata(filepath=metadata_path)
        _fname_to_desc = get_filename_to_description_map(_metadata_cache)
        for fn in os.listdir(DATA_DIR):
            if fn.endswith(".json"):
                try:
                    with open(os.path.join(DATA_DIR, fn), "r", encoding="utf-8") as f:
                        _dictionaries_cache[fn] = json.load(f)
                except Exception:
                    pass
    return _dictionaries_cache, _metadata_cache, _fname_to_desc


def _resolve_dict_filename(dict_name):
    """Resolve translated display names back to the dictionary JSON filename."""
    if not dict_name:
        return "default"
    _load_dicts()
    if dict_name in _dictionaries_cache:
        return dict_name
    desc_to_fn = {v: k for k, v in _metadata_cache.items()}
    return desc_to_fn.get(dict_name, dict_name)


# ==================== API ROUTES ====================


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/config", methods=["GET"])
def api_get_config():
    return jsonify(load_config())


@app.route("/api/config", methods=["POST"])
def api_save_config():
    data = request.get_json(force=True)
    current = load_config()
    current.update(data)
    save_config(current)
    return jsonify({"status": "ok"})


@app.route("/api/dictionaries")
def api_dictionaries():
    _, metadata, _ = _load_dicts()
    names = get_translated_dictionary_names(list(_dictionaries_cache.keys()), metadata)
    return jsonify({"dictionaries": names})


@app.route("/api/dictionary/<path:filename>")
def api_dictionary_words(filename):
    _load_dicts()
    if filename in _dictionaries_cache:
        words = _dictionaries_cache[filename]
        return jsonify({"filename": filename, "count": len(words), "words": words})
    # Try reversed lookup by description
    desc_to_fn = {v: k for k, v in _metadata_cache.items()}
    fn = desc_to_fn.get(filename, filename)
    if fn in _dictionaries_cache:
        words = _dictionaries_cache[fn]
        return jsonify({"filename": fn, "count": len(words), "words": words})
    return jsonify({"error": "Dictionary not found"}), 404


@app.route("/api/word-audio/<word>")
def api_word_audio(word):
    """Download word pronunciation from Youdao and cache it as MP3."""
    cache_file = os.path.join(AUDIO_CACHE_DIR, f"{word}_us.mp3")
    if os.path.exists(cache_file):
        return send_file(cache_file, mimetype="audio/mpeg")

    import httpx
    import asyncio

    async def _fetch():
        url = f"https://dict.youdao.com/dictvoice?audio={word}&type=2"
        async with httpx.AsyncClient(timeout=10, follow_redirects=True) as client:
            resp = await client.get(url)
            if resp.status_code == 200:
                with open(cache_file, "wb") as f:
                    f.write(resp.content)
                return cache_file
            return None

    try:
        result = asyncio.run(_fetch())
        if result:
            return send_file(cache_file, mimetype="audio/mpeg")
    except Exception as e:
        print(f"Audio fetch error: {e}")

    return jsonify({"error": "Audio not available"}), 404


@app.route("/api/sentence-generate", methods=["POST"])
def api_sentence_generate():
    data = request.get_json(force=True)
    word = data.get("word", "").strip()
    if not word:
        return jsonify({"error": "No word provided"}), 400

    raw_dict = data.get("dict_name") or data.get("dictionary") or ""
    dict_name = _resolve_dict_filename(raw_dict)
    force = bool(data.get("force"))
    cache_path = _sentence_cache_path(dict_name)
    word_key = word.lower()

    # Always check cache first (server-side fallback even if frontend missed it)
    if not force:
        cached = _find_cached_sentence(cache_path, word_key)
        if cached:
            cached["cached"] = True
            return jsonify(cached)
        # Also try the raw dict_name path in case resolution changed
        if raw_dict and raw_dict != dict_name:
            alt_path = _sentence_cache_path(raw_dict)
            if alt_path != cache_path:
                cached = _find_cached_sentence(alt_path, word_key)
                if cached:
                    cached["cached"] = True
                    _upsert_cached_sentence(cache_path, cached)
                    return jsonify(cached)

    config = load_config()
    api_key = data.get("api_key") or config.get("sentence_api_key", "")
    if not api_key:
        return jsonify({"error": "请先设置造句API密钥"}), 401

    system_prompt = data.get("system_prompt") or config.get(
        "sentence_system_prompt", ""
    )
    prompt_template = data.get("prompt_template") or config.get(
        "sentence_prompt_template", ""
    )
    base_url = data.get("base_url") or "https://api.deepseek.com"

    lock_key = f"{dict_name}:{word_key}"
    with _sentence_locks_mutex:
        lock = _sentence_locks.get(lock_key)
        if lock is None:
            lock = threading.Lock()
            _sentence_locks[lock_key] = lock

    with lock:
        if not force:
            cached = _find_cached_sentence(cache_path, word_key)
            if cached:
                cached["cached"] = True
                return jsonify(cached)

        try:
            client = OpenAI(api_key=api_key, base_url=base_url)
            prompt = prompt_template.replace("{word}", word)
            response = client.chat.completions.create(
                model="deepseek-chat",
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": prompt},
                ],
                response_format={"type": "json_object"},
                temperature=0.7,
            )
            content = response.choices[0].message.content
            parsed = json.loads(content)

            result = {
                "word": word,
                "short_sentence": parsed.get(
                    "short_sentence", parsed.get("sentence", "")
                ),
                "short_sentence_translation": parsed.get(
                    "short_sentence_translation", parsed.get("sentence_translation", "")
                ),
                "short_sentence_grammar": parsed.get(
                    "short_sentence_grammar", parsed.get("sentence_grammar", "")
                ),
                "complex_sentence": parsed.get("complex_sentence", ""),
                "complex_sentence_translation": parsed.get(
                    "complex_sentence_translation", ""
                ),
                "complex_sentence_grammar": parsed.get("complex_sentence_grammar", ""),
                "phonetics": parsed.get("phonetics", ""),
                "translations": parsed.get("translations", []),
                "cached": False,
            }
            _upsert_cached_sentence(cache_path, result)
            return jsonify(result)

        except Exception as e:
            err = str(e)
            if "Incorrect API key" in err:
                return jsonify({"error": "API key incorrect"}), 401
            return jsonify({"error": f"Request failed: {err}"}), 500


@app.route("/api/kokoro-tts", methods=["POST"])
def api_kokoro_tts():
    data = request.get_json(force=True)
    text = data.get("text", "").strip()
    if not text:
        return jsonify({"error": "No text provided"}), 400

    voice = data.get("voice", "af_heart")
    speed = float(data.get("speed", 1.0))
    use_gpu_raw = data.get("use_gpu", "auto")
    if use_gpu_raw == "gpu":
        use_gpu = True
    elif use_gpu_raw == "cpu":
        use_gpu = False
    else:
        use_gpu = None  # auto

    models, pipelines, cuda = _get_kokoro()
    if not models or not pipelines:
        return jsonify(
            {"error": "Kokoro TTS not available (kokoro package not installed)"}
        ), 503

    text_hash = hashlib.sha1(
        f"{text}-{voice}-{speed}-{use_gpu_raw}".encode()
    ).hexdigest()
    cache_file = os.path.join(AUDIO_CACHE_DIR, f"kokoro_{text_hash}.wav")

    if os.path.exists(cache_file) and os.path.getsize(cache_file) > 44:
        response = send_file(cache_file, mimetype="audio/wav")
        response.headers["X-Cache"] = "HIT"
        return response

    if use_gpu_raw == "gpu" and not cuda:
        return jsonify({"error": "GPU requested but CUDA not available"}), 400
    use_gpu = cuda if use_gpu_raw == "auto" else (use_gpu_raw == "gpu")

    with _tts_locks_mutex:
        lock = _tts_locks.get(text_hash)
        if lock is None:
            lock = threading.Lock()
            _tts_locks[text_hash] = lock
    with lock:
        if os.path.exists(cache_file) and os.path.getsize(cache_file) > 44:
            response = send_file(cache_file, mimetype="audio/wav")
            response.headers["X-Cache"] = "HIT"
            return response

        try:
            pipeline = pipelines.get(voice[0])
            if pipeline is None:
                return jsonify({"error": f"Unknown voice: {voice}"}), 400

            pack = pipeline.load_voice(voice)

            for _, ps, _ in pipeline(text, voice, speed):
                ref_s = pack[len(ps) - 1]
                try:
                    if use_gpu:
                        audio = models[True](ps, ref_s, speed)
                    else:
                        audio = models[False](ps, ref_s, speed)
                except Exception as e:
                    print(f"GPU error: {e}, falling back to CPU")
                    audio = models[False](ps, ref_s, speed)

                audio_np = audio.numpy()

                if np.max(np.abs(audio_np)) > 0:
                    audio_int = np.int16(audio_np / np.max(np.abs(audio_np)) * 32767)
                else:
                    audio_int = np.int16(audio_np)

                fd, tmp_path = tempfile.mkstemp(suffix=".wav", dir=AUDIO_CACHE_DIR)
                os.close(fd)
                try:
                    with wave.open(tmp_path, "wb") as wf:
                        wf.setnchannels(1)
                        wf.setsampwidth(2)
                        wf.setframerate(24000)
                        wf.writeframes(audio_int.tobytes())
                    os.replace(tmp_path, cache_file)
                except BaseException:
                    if os.path.exists(tmp_path):
                        os.unlink(tmp_path)
                    raise

                response = send_file(cache_file, mimetype="audio/wav")
                response.headers["X-Cache"] = "MISS"
                return response

            return jsonify({"error": "TTS generation failed"}), 500

        except Exception as e:
            return jsonify({"error": f"TTS error: {str(e)}"}), 500


def _sentence_cache_path(dict_name):
    dict_name = _resolve_dict_filename(dict_name)
    safe = _safe_cache_name(dict_name)
    return os.path.join(SENTENCE_CACHE_DIR, f"{safe}.json")


def _read_sentence_cache_file(path):
    if not os.path.exists(path):
        return []
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    except Exception:
        return []


def _dedupe_sentences(sentences):
    deduped = {}
    ordered = []
    for item in sentences:
        if not isinstance(item, dict):
            continue
        word = (item.get("word") or "").strip()
        if not word:
            continue
        key = word.lower()
        cleaned = dict(item)
        cleaned.pop("cached", None)
        if key not in deduped:
            ordered.append(key)
        deduped[key] = cleaned
    return [deduped[key] for key in ordered]


def _find_cached_sentence(path, word_key):
    for item in _read_sentence_cache_file(path):
        if (item.get("word") or "").lower() == word_key:
            return dict(item)
    return None


def _upsert_cached_sentence(path, entry):
    sentences = _read_sentence_cache_file(path)
    word_key = (entry.get("word") or "").lower()
    updated = False
    clean_entry = dict(entry)
    clean_entry.pop("cached", None)
    for idx, item in enumerate(sentences):
        if (item.get("word") or "").lower() == word_key:
            sentences[idx] = clean_entry
            updated = True
            break
    if not updated:
        sentences.append(clean_entry)
    _atomic_json_write(path, _dedupe_sentences(sentences))


@app.route("/api/sentence-cache/<path:dict_name>")
def api_load_sentence_cache(dict_name):
    # Resolve to canonical filename first
    resolved = _resolve_dict_filename(dict_name)
    path = _sentence_cache_path(resolved)
    paths_to_try = [path]

    # Also try the raw dict_name if different from resolved
    if dict_name != resolved:
        alt = _sentence_cache_path(dict_name)
        if alt not in paths_to_try:
            paths_to_try.append(alt)

    # Also try legacy safe-name path
    legacy_path = os.path.join(
        SENTENCE_CACHE_DIR, f"{_safe_cache_name(dict_name)}.json"
    )
    if legacy_path not in paths_to_try:
        paths_to_try.append(legacy_path)

    sentences = []
    for item_path in paths_to_try:
        sentences.extend(_read_sentence_cache_file(item_path))
    sentences = _dedupe_sentences(sentences)

    # Consolidate to canonical path if we found data elsewhere
    if sentences and path not in paths_to_try[:1]:
        try:
            _atomic_json_write(path, sentences)
        except Exception:
            pass
    return jsonify({"sentences": sentences})


@app.route("/api/sentence-cache/<path:dict_name>", methods=["POST"])
def api_save_sentence_cache(dict_name):
    data = request.get_json(force=True)
    sentences = data.get("sentences", [])
    path = _sentence_cache_path(dict_name)
    try:
        _atomic_json_write(path, _dedupe_sentences(sentences))
        return jsonify({"status": "ok"})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


KOKORO_VOICES = {
    "🇺🇸 Heart (Female)": "af_heart",
    "🇺🇸 Bella (Female)": "af_bella",
    "🇺🇸 Nicole (Female)": "af_nicole",
    "🇺🇸 Aoede (Female)": "af_aoede",
    "🇺🇸 Kore (Female)": "af_kore",
    "🇺🇸 Sarah (Female)": "af_sarah",
    "🇺🇸 Nova (Female)": "af_nova",
    "🇺🇸 Sky (Female)": "af_sky",
    "🇺🇸 Alloy (Female)": "af_alloy",
    "🇺🇸 Jessica (Female)": "af_jessica",
    "🇺🇸 River (Female)": "af_river",
    "🇺🇸 Michael (Male)": "am_michael",
    "🇺🇸 Fenrir (Male)": "am_fenrir",
    "🇺🇸 Puck (Male)": "am_puck",
    "🇺🇸 Echo (Male)": "am_echo",
    "🇺🇸 Eric (Male)": "am_eric",
    "🇺🇸 Liam (Male)": "am_liam",
    "🇺🇸 Onyx (Male)": "am_onyx",
    "🇺🇸 Santa (Male)": "am_santa",
    "🇺🇸 Adam (Male)": "am_adam",
    "🇬🇧 Emma (Female)": "bf_emma",
    "🇬🇧 Isabella (Female)": "bf_isabella",
    "🇬🇧 Alice (Female)": "bf_alice",
    "🇬🇧 Lily (Female)": "bf_lily",
    "🇬🇧 George (Male)": "bm_george",
    "🇬🇧 Fable (Male)": "bm_fable",
    "🇬🇧 Lewis (Male)": "bm_lewis",
    "🇬🇧 Daniel (Male)": "bm_daniel",
    "🇯🇵 Alpha (Female)": "jf_alpha",
    "🇯🇵 Bravo (Male)": "jm_bravo",
    "🇨🇳 Alpha (Female)": "zf_alpha",
    "🇨🇳 Bravo (Male)": "zm_bravo",
}


@app.route("/api/voices")
def api_voices():
    return jsonify({"voices": list(KOKORO_VOICES.keys())})


_word_index = None


def _build_word_index():
    global _word_index
    if _word_index is None:
        _load_dicts()
        _word_index = {}
        for fn, words in _dictionaries_cache.items():
            for w in words:
                name = (w.get("name") or "").lower()
                if name and name not in _word_index:
                    _word_index[name] = w
    return _word_index


@app.route("/api/lookup/<word>")
def api_lookup_word(word):
    idx = _build_word_index()
    wd = idx.get(word.lower())
    if wd:
        return jsonify({"found": True, "word": wd})
    return jsonify({"found": False})


if __name__ == "__main__":
    print("=" * 60)
    print("  VocabTypeAI Web Edition")
    print("  Server starting on http://0.0.0.0:5000")
    print("=" * 60)
    debug = os.environ.get("VOCABTYPE_DEBUG") == "1"
    app.run(host="0.0.0.0", port=5000, debug=debug, use_reloader=debug)
