// ============================================================
//   VocabTypeAI - Frontend Logic (Mode-based typing)
// ============================================================

const STATE = {
    dicts: [],
    currentDict: null,
    currentWords: [],
    currentWordIndex: 0,
    currentWordData: null,
    typingBuffer: '',
    typingStartTime: 0,
    typingActive: false,
    audioCache: {},
    sentenceHistory: [],
    sentenceIndex: -1,
    sentenceBusy: false,
    mode: 'word',
    sentenceWordIndex: 0,
    referenceWord: null,
    config: {},
    isZenMode: false,
    ttsCache: {},
    loopAudio: false,
    _playWordThenSentence: false,
    _loopPending: false,
    _pendingSentencePlay: false,
    currentDictFile: null,
    sentencePromises: {},
    sentenceRequestToken: 0,
    audioPlayToken: 0,
    ttsInflight: {},
    wordAudioPreload: {},
    settings: {},
    stats: {
        typed: 0,
        correct: 0,
        mistakes: 0,
        streak: 0,
        bestStreak: 0,
        completed: 0,
        startTime: 0,
        totalChars: 0,
        sessionWords: 0
    },
    mistakeWords: {},
    reviewQueue: [],
    lastTypingAt: 0
};

const DEFAULT_SETTINGS = {
    autoPlayWord: true,
    autoPlaySentence: true,
    pauseLoopWhileTyping: true,
    prefetchNextAudio: true,
    dictationReview: true,
    strictTyping: true,
    showPhonetic: true,
    showTranslation: true,
    wordOrder: 'sequence'
};

function loadLearningSettings() {
    try {
        const saved = JSON.parse(localStorage.getItem('vocab_learning_settings') || '{}');
        STATE.settings = { ...DEFAULT_SETTINGS, ...saved };
    } catch (e) {
        STATE.settings = { ...DEFAULT_SETTINGS };
    }
    try {
        STATE.mistakeWords = JSON.parse(localStorage.getItem('vocab_mistake_words') || '{}');
    } catch (e) {
        STATE.mistakeWords = {};
    }
    try {
        STATE.reviewQueue = JSON.parse(localStorage.getItem('vocab_review_queue') || '[]');
    } catch (e) {
        STATE.reviewQueue = [];
    }
    updateStatsBar();
}

function saveLearningSettings() {
    localStorage.setItem('vocab_learning_settings', JSON.stringify(STATE.settings));
}

function persistMistakeWords() {
    localStorage.setItem('vocab_mistake_words', JSON.stringify(STATE.mistakeWords));
    localStorage.setItem('vocab_review_queue', JSON.stringify(STATE.reviewQueue));
}

function stopWordAudio() {
    const a = document.getElementById('word-audio-player');
    if (a) { a.pause(); a.currentTime = 0; a.removeAttribute('src'); }
}
function stopSentenceAudio() {
    const a = document.getElementById('sentence-audio-player');
    if (a) { a.pause(); a.currentTime = 0; }
}
function cancelAudioPlayback() {
    STATE.audioPlayToken++;
    stopWordAudio();
    stopSentenceAudio();
    STATE._playWordThenSentence = false;
    STATE._loopPending = false;
    STATE._pendingSentencePlay = false;
}

function isTypingInProgress() {
    return STATE.typingActive && STATE.typingBuffer.length > 0;
}

function isModalOpen() {
    return !!document.querySelector('.modal-overlay.open');
}

function canAutoLoop() {
    if (!STATE.loopAudio) return false;
    if (STATE._playWordThenSentence) return false;
    if (STATE._loopPending) return false;
    if (STATE.settings.pauseLoopWhileTyping && isTypingInProgress()) return false;
    if (STATE.settings.pauseLoopWhileTyping && Date.now() - STATE.lastTypingAt < 1500) return false;
    if (isModalOpen()) return false;
    return true;
}

// ==================== INIT ====================
document.addEventListener('DOMContentLoaded', async () => {
    loadLearningSettings();
    await Promise.all([loadConfig(), loadDictionaries()]);
    await loadVoices();
    setupDictDropdown();
    setupSentenceToggle();
    setupUppercaseToggle();
    setupLoopToggle();
    setupFontPanel();
    setupAudioLoops();
    CodeRain.init();
    setupTypingEvents();
    setupSentenceEvents();
    setupSettingsEvents();
    setupPasswordToggle();
    setupClickOutside();
    setupModeTabs();
});

// ==================== MODE TABS ====================
function setupModeTabs() {
    document.querySelectorAll('.mode-tab').forEach(tab => {
        tab.addEventListener('click', () => switchMode(tab.dataset.mode));
    });
    updateWordInfoCard();
}

function switchMode(mode) {
    cancelAudioPlayback();
    STATE.mode = mode;
    STATE.typingBuffer = '';
    STATE.typingStartTime = 0;
    STATE._pendingSentencePlay = false;
    document.querySelectorAll('.mode-tab').forEach(t => t.classList.toggle('active', t.dataset.mode === mode));
    document.body.classList.toggle('sentence-mode', mode !== 'word');
    document.body.classList.toggle('complex-mode', mode === 'complex');
    updateTypingDisplay();
    updateWordInfoCard();
    if (mode !== 'word' && document.getElementById('sentence-toggle').checked) {
        const word = getActiveWordForSentence();
        if (word) generateSentenceForWord(word, false);
    }
}

function updateWordInfoCard() {
    const card = document.getElementById('word-info-card');
    const ph = document.getElementById('info-card-placeholder');
    const body = document.getElementById('info-card-body');

    if (STATE.mode === 'word') {
        card.style.display = 'none';
        return;
    }

    const entry = getCurrentSentenceEntry();
    if (!entry || !entry.word) {
        card.style.display = '';
        if (ph) ph.style.display = '';
        if (body) body.style.display = 'none';
        return;
    }

    card.style.display = '';
    if (ph) ph.style.display = 'none';
    if (body) body.style.display = '';

    document.getElementById('info-word').textContent = entry.word;

    let phStr = '';
    if (STATE.referenceWord) {
        phStr = STATE.referenceWord.usphone || STATE.referenceWord.ukphone || '';
    } else if (STATE.currentWordData) {
        phStr = STATE.currentWordData.usphone || STATE.currentWordData.ukphone || '';
    }
    if (!phStr && entry.phonetics) phStr = entry.phonetics;
    document.getElementById('info-phonetic').textContent = phStr ? (phStr.startsWith('/') ? phStr : '/' + phStr + '/') : '';

    let trans = '';
    if (entry && entry.translations && entry.translations.length) {
        trans = entry.translations.map(t => (t.partOfSpeech || '') + ' ' + (t.definition || '')).join('；');
    }
    if (!trans && STATE.referenceWord && STATE.referenceWord.trans && STATE.referenceWord.trans.length) {
        trans = STATE.referenceWord.trans.join('；');
    }
    if (!trans && STATE.currentWordData && STATE.currentWordData.trans && STATE.currentWordData.trans.length) {
        trans = STATE.currentWordData.trans.join('；');
    }
    document.getElementById('info-trans').textContent = trans;
}

// ==================== SENTENCE TOGGLE ====================
function setupSentenceToggle() {
    const toggle = document.getElementById('sentence-toggle');
    const section = document.getElementById('sentence-section');
    const update = () => section.classList.toggle('hidden', !toggle.checked);
    toggle.addEventListener('change', update);
    update();
}

// ==================== UPPERCASE TOGGLE ====================
function setupUppercaseToggle() {
    const toggle = document.getElementById('uppercase-toggle');
    const saved = localStorage.getItem('vocab_uppercase');
    if (saved !== null) {
        toggle.checked = saved === 'true';
    }
    const update = () => {
        document.body.classList.toggle('no-uppercase', !toggle.checked);
        localStorage.setItem('vocab_uppercase', toggle.checked);
    };
    toggle.addEventListener('change', update);
    update();
}

// ==================== LOOP TOGGLE ====================
function setupLoopToggle() {
    const toggle = document.getElementById('loop-toggle');
    const saved = localStorage.getItem('vocab_loop');
    if (saved !== null) toggle.checked = saved === 'true';
    STATE.loopAudio = toggle.checked;
    toggle.addEventListener('change', () => {
        STATE.loopAudio = toggle.checked;
        localStorage.setItem('vocab_loop', toggle.checked);
    });
}

// ==================== FONT PANEL ====================
function setupFontPanel() {
    const toggle = document.getElementById('font-panel-toggle');
    const body = document.getElementById('font-panel-body');

    toggle.addEventListener('click', () => {
        const showing = body.style.display !== 'none';
        body.style.display = showing ? 'none' : 'flex';
    });

    const defaults = { type: 42, sentence: 16, trans: 18, grammar: 13 };
    ['type', 'sentence', 'trans', 'grammar'].forEach(key => {
        const slider = document.getElementById('font-' + key);
        const valEl = document.getElementById('font-' + key + '-val');
        const saved = localStorage.getItem('vocab_font_' + key);
        const initVal = saved ? parseInt(saved) : defaults[key];
        slider.value = initVal;
        valEl.textContent = initVal;
        document.documentElement.style.setProperty('--font-' + key, initVal + 'px');
        slider.addEventListener('input', () => {
            const v = slider.value;
            valEl.textContent = v;
            document.documentElement.style.setProperty('--font-' + key, v + 'px');
            localStorage.setItem('vocab_font_' + key, v);
        });
    });
}

// ==================== API ====================
async function apiGet(path) { const r = await fetch(path); return r.json(); }
async function apiPost(path, data) {
    const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    return r.json();
}

// ==================== CONFIG ====================
async function loadConfig() {
    try { STATE.config = await apiGet('/api/config'); applyConfig(); } catch (e) { console.error('Config load error:', e); }
}
function applyConfig() {
    const c = STATE.config;
    setVal('setting-deepseek-key', c.deepseek_api_key || '');
    setVal('setting-sentence-key', c.sentence_api_key || '');
    setVal('setting-sentence-system', c.sentence_system_prompt || '');
    setVal('setting-sentence-template', c.sentence_prompt_template || '');
    setVal('setting-comfyui-addr', c.comfyui_server || '');
    if (c.voice) { const sel = document.getElementById('setting-voice'); if (sel) sel.value = c.voice; }
    setVal('setting-speed', c.speed || 1.0);
    setVal('setting-tts-gpu', c.tts_use_gpu || 'auto');
    applyLearningSettingsToForm();
    updateSpeedLabel();
}
function setVal(id, v) { const el = document.getElementById(id); if (el) el.value = v || ''; }
function setChecked(id, v) { const el = document.getElementById(id); if (el) el.checked = !!v; }

function applyLearningSettingsToForm() {
    setChecked('setting-auto-word', STATE.settings.autoPlayWord);
    setChecked('setting-auto-sentence', STATE.settings.autoPlaySentence);
    setChecked('setting-loop-idle', STATE.settings.pauseLoopWhileTyping);
    setChecked('setting-prefetch-audio', STATE.settings.prefetchNextAudio);
    setChecked('setting-dictation-review', STATE.settings.dictationReview);
    setChecked('setting-strict-typing', STATE.settings.strictTyping);
    setChecked('setting-show-phonetic', STATE.settings.showPhonetic);
    setChecked('setting-show-translation', STATE.settings.showTranslation);
    setVal('setting-word-order', STATE.settings.wordOrder || 'sequence');
}

// ==================== DICTIONARY ====================
async function loadDictionaries() {
    try {
        const data = await apiGet('/api/dictionaries');
        STATE.dicts = data.dictionaries || [];
        renderDictList(STATE.dicts);
        const saved = localStorage.getItem('vocablast_dict');
        if (saved && STATE.dicts.includes(saved)) { await selectDict(saved); }
        else if (STATE.dicts.length > 0) { await selectDict(STATE.dicts[0]); }
    } catch (e) { console.error('Dict load error:', e); }
}

function renderDictList(dicts) {
    const list = document.getElementById('dict-list');
    list.innerHTML = dicts.map((d, i) =>
        `<div class="dict-item" data-dict="${d}" data-idx="${i}">${d}</div>`
    ).join('');
    list.querySelectorAll('.dict-item').forEach(item => {
        item.addEventListener('click', () => selectDict(item.dataset.dict));
    });
}

function setupDictDropdown() {
    const toggle = document.getElementById('dict-toggle-btn');
    const dropdown = document.getElementById('dict-dropdown');
    const searchInput = document.getElementById('dict-search-input');
    toggle.addEventListener('click', e => { e.stopPropagation(); dropdown.classList.toggle('open'); if (dropdown.classList.contains('open')) searchInput.focus(); });
    searchInput.addEventListener('input', () => {
        const q = searchInput.value.toLowerCase();
        document.querySelectorAll('.dict-item').forEach(item => { item.style.display = item.textContent.toLowerCase().includes(q) ? '' : 'none'; });
    });
    searchInput.addEventListener('keydown', e => { if (e.key === 'Escape') dropdown.classList.remove('open'); });
}

async function selectDict(name) {
    document.getElementById('dict-btn-label').textContent = name;
    document.querySelectorAll('.dict-item').forEach(i => i.classList.remove('active'));
    const item = document.querySelector(`.dict-item[data-dict="${CSS.escape(name)}"]`);
    if (item) item.classList.add('active');
    document.getElementById('dict-dropdown').classList.remove('open');
    STATE.currentDict = name;
    localStorage.setItem('vocablast_dict', name);
    STATE.referenceWord = null;
    await startTypingSession();
}

function setupClickOutside() {
    document.addEventListener('click', e => {
        const dd = document.getElementById('dict-dropdown');
        const toggle = document.getElementById('dict-toggle-btn');
        if (dd.classList.contains('open') && !toggle.contains(e.target) && !dd.contains(e.target)) dd.classList.remove('open');
        const modal = document.getElementById('settings-modal');
        const card = modal.querySelector('.modal-card');
        if (modal.classList.contains('open') && !card.contains(e.target) && e.target === modal) modal.classList.remove('open');
    });
}

// ==================== VOICES ====================
async function loadVoices() {
    const select = document.getElementById('setting-voice');
    try {
        const data = await apiGet('/api/voices');
        (data.voices || []).forEach(v => { const o = document.createElement('option'); o.value = v; o.textContent = v; select.appendChild(o); });
    } catch (e) {}
    if (STATE.config.voice && select.options.length > 0) select.value = STATE.config.voice;
}

function getVoiceCode(displayName) {
    const m = {
        "🇺🇸 Heart (Female)":"af_heart","🇺🇸 Bella (Female)":"af_bella","🇺🇸 Nicole (Female)":"af_nicole",
        "🇺🇸 Aoede (Female)":"af_aoede","🇺🇸 Kore (Female)":"af_kore","🇺🇸 Sarah (Female)":"af_sarah",
        "🇺🇸 Nova (Female)":"af_nova","🇺🇸 Sky (Female)":"af_sky","🇺🇸 Alloy (Female)":"af_alloy",
        "🇺🇸 Jessica (Female)":"af_jessica","🇺🇸 River (Female)":"af_river",
        "🇺🇸 Michael (Male)":"am_michael","🇺🇸 Fenrir (Male)":"am_fenrir","🇺🇸 Puck (Male)":"am_puck",
        "🇺🇸 Echo (Male)":"am_echo","🇺🇸 Eric (Male)":"am_eric","🇺🇸 Liam (Male)":"am_liam",
        "🇺🇸 Onyx (Male)":"am_onyx","🇺🇸 Santa (Male)":"am_santa","🇺🇸 Adam (Male)":"am_adam",
        "🇬🇧 Emma (Female)":"bf_emma","🇬🇧 Isabella (Female)":"bf_isabella","🇬🇧 Alice (Female)":"bf_alice",
        "🇬🇧 Lily (Female)":"bf_lily","🇬🇧 George (Male)":"bm_george","🇬🇧 Fable (Male)":"bm_fable",
        "🇬🇧 Lewis (Male)":"bm_lewis","🇬🇧 Daniel (Male)":"bm_daniel",
        "🇯🇵 Alpha (Female)":"jf_alpha","🇯🇵 Bravo (Male)":"jm_bravo",
        "🇨🇳 Alpha (Female)":"zf_alpha","🇨🇳 Bravo (Male)":"zm_bravo"
    };
    return m[displayName] || displayName;
}

// ==================== TYPING ====================
function setupTypingEvents() {
    document.getElementById('play-audio-btn').addEventListener('click', playCurrentAudio);
    document.getElementById('info-play-btn').addEventListener('click', () => {
        const w = getActiveWordForSentence();
        if (w) { loadWordAudio(w); playWordAudio({ manual: true }); }
    });
    document.getElementById('regen-btn').addEventListener('click', handleRegenerate);
    document.addEventListener('keydown', handleGlobalHotkeys);
    document.addEventListener('keydown', handleKeydown);
}

function handleRegenerate() {
    if (STATE.mode === 'word') {
        const wd = STATE.currentWordData;
        if (wd) {
            playCurrentWordAudio();
            if (document.getElementById('sentence-toggle').checked) {
                generateSentenceForWord(wd.name, true);
            }
        }
    } else {
        const word = getActiveWordForSentence();
        if (word) generateSentenceForWord(word, true);
    }
}

function playCurrentAudio() {
    STATE._pendingSentencePlay = false;
    if (STATE.mode !== 'word') {
        playCurrentSentenceTTS();
    } else {
        stopSentenceAudio();
        playCurrentWordAudio();
    }
}

function playCurrentSentenceTTS(options = {}) {
    const entry = getCurrentSentenceEntry();
    if (!entry) return;
    const text = STATE.mode === 'short' ? entry.short_sentence : entry.complex_sentence;
    if (text) playKokoroTTS(text, document.getElementById('play-audio-btn'), options);
}

function handleGlobalHotkeys(e) {
    // Tab: Skip current word
    if (e.key === 'Tab') {
        e.preventDefault();
        if (STATE.typingActive) nextDictionaryWord();
        return;
    }

    // Ctrl+L: Toggle Zen Mode
    if (e.ctrlKey && e.key === 'l') {
        e.preventDefault();
        toggleZenMode();
        return;
    }

    // Ctrl+Enter: Replay audio
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        playCurrentAudio();
        return;
    }

    // Alt+1-9: Quick switch dictionary
    if (e.altKey && e.key >= '1' && e.key <= '9') {
        e.preventDefault();
        const idx = parseInt(e.key) - 1;
        if (STATE.dicts[idx]) selectDict(STATE.dicts[idx]);
        return;
    }

    // F1: Toggle settings
    if (e.key === 'F1') {
        e.preventDefault();
        const modal = document.getElementById('settings-modal');
        modal.classList.toggle('open');
        return;
    }

    // F2: Show session stats
    if (e.key === 'F2') {
        e.preventDefault();
        showSessionStats();
        return;
    }

    // F3: Review error words
    if (e.key === 'F3') {
        e.preventDefault();
        startErrorWordReview();
        return;
    }

    // Ctrl+R: Restart current dict
    if (e.ctrlKey && e.key === 'r') {
        e.preventDefault();
        if (STATE.currentDict) startTypingSession();
        return;
    }
}

function toggleZenMode() {
    STATE.isZenMode = !STATE.isZenMode;
    document.body.classList.toggle('zen-mode', STATE.isZenMode);
}

function showSessionStats() {
    const elapsed = STATE.stats.startTime > 0 ? (Date.now() - STATE.stats.startTime) / 60000 : 0;
    const wpm = elapsed > 0 ? (STATE.stats.sessionWords / elapsed) : 0;
    const accuracy = STATE.stats.typed > 0 ? (STATE.stats.correct / STATE.stats.typed * 100) : 100;
    const errorCount = Object.keys(STATE.mistakeWords).length;
    const reviewCount = STATE.reviewQueue.length;

    const statsHtml = `
        <div class="stats-modal-content">
            <div class="stats-grid">
                <div class="stat-item">
                    <span class="stat-label">本次时长</span>
                    <span class="stat-value">${elapsed.toFixed(1)} MIN</span>
                </div>
                <div class="stat-item">
                    <span class="stat-label">词/分钟</span>
                    <span class="stat-value">${wpm.toFixed(1)}</span>
                </div>
                <div class="stat-item">
                    <span class="stat-label">准确率</span>
                    <span class="stat-value">${accuracy.toFixed(1)}%</span>
                </div>
                <div class="stat-item">
                    <span class="stat-label">已完成</span>
                    <span class="stat-value">${STATE.stats.completed}</span>
                </div>
                <div class="stat-item">
                    <span class="stat-label">最长连击</span>
                    <span class="stat-value">${STATE.stats.bestStreak}</span>
                </div>
                <div class="stat-item">
                    <span class="stat-label">错词数</span>
                    <span class="stat-value">${errorCount}</span>
                </div>
                <div class="stat-item">
                    <span class="stat-label">复习队列</span>
                    <span class="stat-value">${reviewCount}</span>
                </div>
                <div class="stat-item">
                    <span class="stat-label">总按键</span>
                    <span class="stat-value">${STATE.stats.typed}</span>
                </div>
            </div>
            ${errorCount > 0 ? `
            <div class="stats-errors">
                <h4>高频错词 TOP</h4>
                <div class="error-word-list">
                    ${Object.entries(STATE.mistakeWords)
                        .sort((a, b) => b[1] - a[1])
                        .slice(0, 10)
                        .map(([word, count]) => `<span class="error-word-tag">${word} (${count})</span>`)
                        .join('')}
                </div>
            </div>` : ''}
        </div>
    `;

    // Create temporary modal
    let modal = document.getElementById('stats-modal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'stats-modal';
        modal.className = 'modal-overlay';
        modal.innerHTML = `
            <div class="modal-card glass-card" style="width:480px">
                <div class="modal-header">
                    <h2>[ 训练统计 ]</h2>
                    <button class="btn-icon-sm modal-close" onclick="document.getElementById('stats-modal').classList.remove('open')">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                    </button>
                </div>
                <div class="modal-body" id="stats-modal-body"></div>
            </div>
        `;
        document.body.appendChild(modal);
        modal.addEventListener('click', e => {
            if (e.target === modal) modal.classList.remove('open');
        });
    }
    document.getElementById('stats-modal-body').innerHTML = statsHtml;
    modal.classList.add('open');
}

function startErrorWordReview() {
    const errorWords = Object.keys(STATE.mistakeWords);
    if (errorWords.length === 0) {
        const status = document.createElement('div');
        status.className = 'access-granted';
        status.textContent = '[ 暂无错词 ]';
        status.style.fontSize = '24px';
        document.body.appendChild(status);
        setTimeout(() => status.remove(), 1500);
        return;
    }

    // Find the error words in current dictionary
    const reviewWords = STATE.currentWords.filter(w =>
        errorWords.includes((w.name || '').toLowerCase())
    );

    if (reviewWords.length === 0) {
        // If no error words in current dict, use the mistake words directly
        showWordPickModal(errorWords);
        return;
    }

    // Start a review session with error words
    STATE.currentWords = reviewWords;
    STATE.currentWordIndex = 0;
    STATE.typingActive = true;
    showWord(0);
}

function showAccessGranted() {
    const el = document.createElement('div');
    el.className = 'access-granted';
    el.textContent = '[ ACCESS GRANTED ]';
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 1500);
}

function showRedAlert() {
    const el = document.createElement('div');
    el.className = 'red-alert';
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 300);
}

function getActiveTypingWord() {
    if (STATE.mode === 'word') {
        const wd = STATE.referenceWord || STATE.currentWordData;
        return wd ? wd.name : '';
    }
    const words = getSentenceWords();
    return words[STATE.sentenceWordIndex] || getActiveWordForSentence() || '';
}

function registerMistake() {
    STATE.stats.mistakes++;
    STATE.stats.streak = 0;
    const word = (getActiveTypingWord() || '').replace(/[^a-zA-Z'-]/g, '').toLowerCase();
    if (word) {
        STATE.mistakeWords[word] = (STATE.mistakeWords[word] || 0) + 1;
        // Add to review queue if not already there
        if (!STATE.reviewQueue.includes(word)) {
            STATE.reviewQueue.push(word);
        }
        persistMistakeWords();
    }
    updateStatsBar();
}

function registerCompletion() {
    STATE.stats.completed++;
    STATE.stats.streak++;
    STATE.stats.bestStreak = Math.max(STATE.stats.bestStreak, STATE.stats.streak);
    STATE.stats.sessionWords++;
    const word = (getActiveTypingWord() || '').replace(/[^a-zA-Z'-]/g, '').toLowerCase();
    // Remove from review queue if completed successfully
    if (word) {
        const idx = STATE.reviewQueue.indexOf(word);
        if (idx >= 0) STATE.reviewQueue.splice(idx, 1);
    }
    updateStatsBar();
}

function updateStatsBar() {
    const accEl = document.getElementById('accuracy-value');
    if (accEl && STATE.stats.typed > 0) {
        accEl.textContent = (STATE.stats.correct / STATE.stats.typed * 100).toFixed(2) + '%';
    }
    const streakEl = document.getElementById('streak-value');
    if (streakEl) streakEl.textContent = 'STRK ' + STATE.stats.streak;
    const errEl = document.getElementById('mistake-value');
    if (errEl) errEl.textContent = 'ERR ' + STATE.stats.mistakes;
    // Update progress with session info
    const progEl = document.getElementById('progress-value');
    if (progEl && STATE.currentWords.length > 0) {
        progEl.textContent = (STATE.currentWordIndex + 1) + '/' + STATE.currentWords.length;
    }
}

function handleKeydown(e) {
    if (!STATE.typingActive) return;
    if (e.key === 'Escape' || e.key === 'Tab') return; // Handled by global hotkeys
    const mode = STATE.mode;

    if (e.key === 'Enter') {
        e.preventDefault();
        if (mode === 'word') { nextDictionaryWord(); return; }
        const words = getSentenceWords();
        if (words.length > 0 && STATE.sentenceWordIndex < words.length) {
            const w = words[STATE.sentenceWordIndex].replace(/[^a-zA-Z'-]/g, '');
            if (w) showLookupWord(w);
        }
        return;
    }

    if (e.ctrlKey || e.altKey || e.metaKey) return;
    STATE.lastTypingAt = Date.now();

    const target = getCurrentTypingTarget();
    if (!target) return;

    if (e.key === 'Backspace') {
        e.preventDefault();
        if (STATE.typingBuffer.length > 0) {
            STATE.typingBuffer = STATE.typingBuffer.slice(0, -1);
            updateTypingDisplay();
            updateWPM();
        }
        return;
    }

    if (e.key.length !== 1) return;
    if (mode === 'word' && !/[a-zA-Z]/.test(e.key)) return;
    if (mode !== 'word' && /[\x00-\x1F]/.test(e.key)) return;
    e.preventDefault();

    if (STATE.typingStartTime === 0) STATE.typingStartTime = Date.now();
    const pos = STATE.typingBuffer.length;
    const expected = target[pos] || '';

    if (pos >= target.length || e.key.toLowerCase() !== expected.toLowerCase()) {
        registerMistake();
        showRedAlert();
        if (STATE.settings.strictTyping) return;
    }

    STATE.typingBuffer += e.key;
    STATE.stats.typed++;
    if (expected && e.key.toLowerCase() === expected.toLowerCase()) STATE.stats.correct++;
    updateTypingDisplay();
    updateWPM();
    updateStatsBar();

    if (STATE.typingBuffer.toLowerCase() === target.toLowerCase()) {
        if (mode === 'word') {
            document.getElementById('wpm-value').textContent = calcWPM().toFixed(2) + ' WPM';
            document.getElementById('accuracy-value').textContent = '100.00%';
            showAccessGranted();
            registerCompletion();
            setTimeout(() => nextDictionaryWord(), 400);
        } else {
            STATE.typingStartTime = 0;
            STATE.typingBuffer = '';
            const words = getSentenceWords();
            STATE.sentenceWordIndex++;
            if (STATE.sentenceWordIndex >= words.length) {
                document.getElementById('wpm-value').textContent = calcWPM().toFixed(2) + ' WPM';
                document.getElementById('accuracy-value').textContent = '100.00%';
                showAccessGranted();
                registerCompletion();
                STATE.typingActive = false;
                if (STATE.settings.dictationReview) setTimeout(() => showWordPickModal(words), 300);
                else setTimeout(() => { STATE.typingActive = true; nextDictionaryWord(); }, 300);
            }
            updateTypingDisplay();
        }
    }
}

function getCurrentTypingTarget() {
    if (STATE.mode === 'word') {
        return STATE.currentWordData ? STATE.referenceWord ? STATE.referenceWord.name : STATE.currentWordData.name : null;
    }
    const words = getSentenceWords();
    if (words.length === 0) {
        return STATE.currentWordData ? STATE.referenceWord ? STATE.referenceWord.name : STATE.currentWordData.name : null;
    }
    if (STATE.sentenceWordIndex < words.length) return words[STATE.sentenceWordIndex];
    return null;
}

function getSentenceWords() {
    const entry = getCurrentSentenceEntry();
    if (!entry) return [];
    const text = STATE.mode === 'short' ? (entry.short_sentence || '') : (entry.complex_sentence || '');
    return text.split(/\s+/).filter(w => w.length > 0);
}

function getCurrentSentenceEntry() {
    if (STATE.sentenceIndex >= 0 && STATE.sentenceIndex < STATE.sentenceHistory.length) {
        return STATE.sentenceHistory[STATE.sentenceIndex];
    }
    return null;
}

function nextDictionaryWord() {
    if (!STATE.typingActive) return;
    STATE.currentWordIndex++;
    STATE.referenceWord = null;
    STATE.sentenceWordIndex = 0;
    STATE.typingBuffer = '';
    STATE.typingStartTime = 0;
    showWord(STATE.currentWordIndex);
}

function updateTypingDisplay() {
    const el = document.getElementById('typing-text');
    const hint = document.getElementById('typing-hint');

    if (STATE.mode === 'word') {
        const wd = STATE.referenceWord || STATE.currentWordData;
        if (!wd) { el.innerHTML = '<span class="char-untyped">[ 请选择词库开始 ]</span>'; hint.style.display = ''; return; }
        hint.style.display = 'none';
        renderSingleWord(wd.name, STATE.typingBuffer, el);
        const ph = wd.usphone || wd.ukphone || getDeepseekPhonetic(wd.name);
        document.getElementById('word-phonetic').textContent = ph ? (ph.startsWith('/') ? ph : '/' + ph + '/') : '';
        const dsTrans = getDeepseekTrans(wd.name);
        if (dsTrans) {
            document.getElementById('word-trans').textContent = dsTrans;
        } else if (!document.getElementById('sentence-toggle').checked) {
            document.getElementById('word-trans').textContent = (wd.trans || []).join('；');
        } else {
            document.getElementById('word-trans').textContent = '';
        }
        return;
    }

    const words = getSentenceWords();
    if (words.length === 0) {
        if (STATE.sentenceBusy) {
            const word = getActiveWordForSentence();
            const dots = '.'.repeat((Math.floor(Date.now() / 350) % 3) + 1);
            el.innerHTML = '<span class="char-untyped loading-pulse">[ \u52a0\u8f7d\u4e2d' + dots + (word ? ' // ' + escHtml(word) : '') + ' ]</span>';
            hint.style.display = 'none';
            return;
        }
        el.innerHTML = '<span class="char-untyped">[ 暂无句子数据，请切换单词模式 ]</span>';
        document.getElementById('word-phonetic').textContent = '';
        document.getElementById('word-trans').textContent = '';
        hint.style.display = '';
        return;
    }
    hint.style.display = 'none';

    const idx = STATE.sentenceWordIndex;
    const buf = STATE.typingBuffer;
    let html = '';
    for (let i = 0; i < words.length; i++) {
        if (i > 0) html += '<span class="word-sep"> </span>';
        const w = words[i];
        if (i < idx) {
            html += '<span class="char-done">' + escHtml(w) + '</span>';
        } else if (i === idx) {
            html += '<span class="word-active">';
            for (let c = 0; c < w.length; c++) {
                if (c < buf.length) {
                    html += buf[c].toLowerCase() === w[c].toLowerCase()
                        ? '<span class="char-correct">' + escHtml(w[c]) + '</span>'
                        : '<span class="char-incorrect">' + escHtml(w[c]) + '</span>';
                } else {
                    html += '<span class="char-untyped">' + escHtml(w[c]) + '</span>';
                }
            }
            html += '</span>';
        } else {
            html += '<span class="char-untyped">' + escHtml(w) + '</span>';
        }
    }
    el.innerHTML = html;

    const currentWord = words[idx] || '';
    const wd = STATE.referenceWord || STATE.currentWordData;
    const stOn = document.getElementById('sentence-toggle').checked;
    if (wd && currentWord.toLowerCase() === wd.name.toLowerCase()) {
        const ph = wd.usphone || wd.ukphone || getDeepseekPhonetic(currentWord);
        document.getElementById('word-phonetic').textContent = ph ? (ph.startsWith('/') ? ph : '/' + ph + '/') : '';
        const dsTrans = getDeepseekTrans(currentWord);
        const dictTrans = (wd.trans || []).join('；');
        document.getElementById('word-trans').textContent = dsTrans || (stOn ? '' : dictTrans);
    } else {
        const ph = getDeepseekPhonetic(currentWord);
        document.getElementById('word-phonetic').textContent = ph || '';
        document.getElementById('word-trans').textContent = getDeepseekTrans(currentWord);
    }
}

function renderSingleWord(target, buf, el) {
    const b = buf.split('');
    let html = '';
    for (let i = 0; i < target.length; i++) {
        if (i < b.length) {
            html += b[i].toLowerCase() === target[i].toLowerCase()
                ? '<span class="char-correct">' + escHtml(target[i]) + '</span>'
                : '<span class="char-incorrect">' + escHtml(target[i]) + '</span>';
        } else {
            html += '<span class="char-untyped">' + escHtml(target[i]) + '</span>';
        }
    }
    for (let i = target.length; i < b.length; i++) {
        html += '<span class="char-extra">' + escHtml(b[i]) + '</span>';
    }
    el.innerHTML = html;
}

function escHtml(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function loadingLabel() {
    return '\u52a0\u8f7d\u4e2d';
}

function loadingDots() {
    return '.'.repeat((Math.floor(Date.now() / 350) % 3) + 1);
}

function getDeepseekPhonetic(word) {
    const entry = STATE.sentenceHistory.find(e => e.word && e.word.toLowerCase() === word.toLowerCase());
    return entry ? (entry.phonetics || '') : '';
}

function getDeepseekTrans(word) {
    const entry = STATE.sentenceHistory.find(e => e.word && e.word.toLowerCase() === word.toLowerCase());
    if (entry && entry.translations) return entry.translations.map(t => (t.partOfSpeech || '') + ' ' + (t.definition || '')).join('；');
    return '';
}

function calcWPM() {
    if (STATE.typingStartTime <= 0) return 0;
    const target = getCurrentTypingTarget() || '';
    const elapsed = (Date.now() - STATE.typingStartTime) / 60000;
    return elapsed > 0 ? (target.length / 5) / elapsed : 0;
}

function updateWPM() {
    if (STATE.typingStartTime <= 0) return;
    const elapsed = (Date.now() - STATE.typingStartTime) / 60000;
    const c = STATE.typingBuffer.length;
    document.getElementById('wpm-value').textContent = (elapsed > 0 ? (c / 5) / elapsed : 0).toFixed(2) + ' WPM';
    const target = getCurrentTypingTarget() || '';
    let correct = 0;
    for (let i = 0; i < Math.min(c, target.length); i++) {
        if (STATE.typingBuffer[i].toLowerCase() === target[i].toLowerCase()) correct++;
    }
    document.getElementById('accuracy-value').textContent = (c > 0 ? (correct / c * 100) : 100).toFixed(2) + '%';
}

// ==================== WORD MANAGEMENT ====================
function prepareWordOrder(words) {
    const list = [...words];
    const mode = STATE.settings.wordOrder || 'sequence';
    if (mode === 'random') {
        for (let i = list.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [list[i], list[j]] = [list[j], list[i]];
        }
        return list;
    }
    if (mode === 'review') {
        const review = list.filter(w => STATE.mistakeWords[(w.name || '').toLowerCase()]);
        return review.length ? review : list;
    }
    if (mode === 'smart') {
        // Prioritize error words, then randomize the rest
        const errorWords = list.filter(w => STATE.mistakeWords[(w.name || '').toLowerCase()]);
        const normalWords = list.filter(w => !STATE.mistakeWords[(w.name || '').toLowerCase()]);
        // Shuffle both arrays
        for (let i = errorWords.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [errorWords[i], errorWords[j]] = [errorWords[j], errorWords[i]];
        }
        for (let i = normalWords.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [normalWords[i], normalWords[j]] = [normalWords[j], normalWords[i]];
        }
        return [...errorWords, ...normalWords];
    }
    return list;
}

async function startTypingSession() {
    const dictName = STATE.currentDict;
    if (!dictName) return;
    const resp = await apiGet('/api/dictionary/' + encodeURIComponent(dictName));
    if (resp.error) return;
    // Always use the server-resolved filename as the canonical cache key
    STATE.currentDictFile = resp.filename || dictName;
    STATE.currentWords = prepareWordOrder(resp.words || []);
    STATE.currentWordIndex = 0;
    STATE.typingActive = true;
    STATE.referenceWord = null;
    STATE.sentenceWordIndex = 0;
    STATE.sentenceHistory = [];
    STATE.sentenceIndex = -1;
    // Reset session stats
    STATE.stats.startTime = Date.now();
    STATE.stats.sessionWords = 0;
    await loadSentenceCache();
    document.getElementById('typing-panel').classList.add('active');
    document.getElementById('word-info-card').style.display = 'none';
    showWord(0);
}

// ==================== SENTENCE CACHE (Server) ====================
function getSentenceCacheKey() {
    // Prefer the resolved filename from server, fallback to display name
    return STATE.currentDictFile || STATE.currentDict || 'default';
}

async function loadSentenceCache() {
    try {
        const key = getSentenceCacheKey();
        if (!key) return;
        const data = await apiGet('/api/sentence-cache/' + encodeURIComponent(key));
        if (data && data.sentences) STATE.sentenceHistory = normalizeSentenceHistory(data.sentences);
    } catch (e) {}
}

async function saveSentenceCache() {
    try {
        const key = getSentenceCacheKey();
        STATE.sentenceHistory = normalizeSentenceHistory(STATE.sentenceHistory);
        await apiPost('/api/sentence-cache/' + encodeURIComponent(key), { sentences: STATE.sentenceHistory });
    } catch (e) {}
}

function normalizeSentenceHistory(list) {
    const seen = new Map();
    (list || []).forEach(item => {
        if (!item || !item.word) return;
        const clean = { ...item };
        delete clean.cached;
        seen.set(clean.word.toLowerCase(), clean);
    });
    return [...seen.values()];
}

function getSentenceHistoryIndex(word) {
    const key = (word || '').toLowerCase();
    return STATE.sentenceHistory.findIndex(e => e && e.word && e.word.toLowerCase() === key);
}

function showWord(index) {
    if (index >= STATE.currentWords.length) {
        document.getElementById('typing-text').innerHTML = '<span style="color:var(--matrix-green);text-shadow:var(--glow-green);letter-spacing:4px">[ 全部完成 ]</span>';
        document.getElementById('word-phonetic').textContent = '';
        document.getElementById('word-trans').textContent = '';
        document.getElementById('wpm-value').textContent = '0.00 WPM';
        document.getElementById('accuracy-value').textContent = '0.00%';
        document.getElementById('progress-value').textContent = STATE.currentWords.length + '/' + STATE.currentWords.length;
        STATE.typingActive = false;
        const idx = STATE.dicts.indexOf(STATE.currentDict);
        if (idx >= 0 && idx < STATE.dicts.length - 1) {
            setTimeout(() => selectDict(STATE.dicts[idx + 1]), 1500);
        }
        return;
    }

    const wd = STATE.currentWords[index];
    STATE.currentWordData = wd;
    STATE.currentWordIndex = index;
    STATE.typingStartTime = 0;
    STATE.typingBuffer = '';
    STATE.referenceWord = null;
    STATE.sentenceWordIndex = 0;

    document.getElementById('progress-value').textContent = (index + 1) + '/' + STATE.currentWords.length;
    document.getElementById('wpm-value').textContent = '0.00 WPM';
    document.getElementById('accuracy-value').textContent = '0.00%';

    loadWordAudio(wd.name);
    updateTypingDisplay();

    if (document.getElementById('sentence-toggle').checked) {
        generateSentenceForWord(wd.name, false);
    }
    scheduleNextWordWarmup(index + 1);
    if (STATE.settings.autoPlayWord) {
        STATE._pendingSentencePlay = (STATE.settings.autoPlaySentence && STATE.mode !== 'word');
        setTimeout(autoPlayCurrentWord, 160);
    } else if (STATE.settings.autoPlaySentence && STATE.mode !== 'word') {
        // No word auto-play, but sentence should auto-play
        STATE._pendingSentencePlay = false;
        setTimeout(() => { if (STATE.mode !== 'word') playCurrentSentenceTTS(); }, 300);
    }
}

function loadWordAudio(word) {
    const audio = document.getElementById('word-audio-player');
    const key = word.toLowerCase();
    if (STATE.audioCache[key]) { audio.src = STATE.audioCache[key]; return; }
    const url = '/api/word-audio/' + encodeURIComponent(word);
    STATE.audioCache[key] = url;
    audio.src = url;
}

function preloadWordAudio(word) {
    if (!word || !STATE.settings.prefetchNextAudio) return;
    const key = word.toLowerCase();
    if (STATE.wordAudioPreload[key]) return;
    const audio = new Audio('/api/word-audio/' + encodeURIComponent(word));
    audio.preload = 'auto';
    STATE.wordAudioPreload[key] = audio;
}

function scheduleNextWordWarmup(index) {
    const next = STATE.currentWords[index];
    if (!next || !next.name) return;
    const run = () => preloadWordAudio(next.name);
    if ('requestIdleCallback' in window) requestIdleCallback(run, { timeout: 800 });
    else setTimeout(run, 120);
}

function playCurrentWordAudio() {
    playWordAudio({ manual: true });
}

function autoPlayCurrentWord() {
    playWordAudio({ manual: false });
}

function playWordAudio({ manual = false, token = null } = {}) {
    const audio = document.getElementById('word-audio-player');
    if (!audio || !audio.src) return Promise.resolve(false);
    const playToken = token || ++STATE.audioPlayToken;
    stopSentenceAudio();
    STATE._loopPending = false;
    audio.currentTime = 0;
    audio.dataset.playToken = String(playToken);
    return audio.play().then(() => true).catch(() => false);
}

function waitForAudioEnd(audio, token) {
    return new Promise(resolve => {
        if (!audio || audio.paused || audio.ended) return resolve();
        const done = () => {
            audio.removeEventListener('ended', done);
            audio.removeEventListener('error', done);
            resolve();
        };
        audio.addEventListener('ended', done, { once: true });
        audio.addEventListener('error', done, { once: true });
        setTimeout(done, Math.max(1500, ((audio.duration || 0) + 1) * 1000));
    }).then(() => token === STATE.audioPlayToken);
}

function setupAudioLoops() {
    document.getElementById('word-audio-player').addEventListener('ended', () => {
        // Auto-play sentence after word if requested
        if (STATE._pendingSentencePlay) {
            STATE._pendingSentencePlay = false;
            if (STATE.mode !== 'word' && document.getElementById('sentence-toggle').checked) {
                playCurrentSentenceTTS({ auto: true });
                return;
            }
        }
        if (!canAutoLoop()) return;
        STATE._loopPending = true;
        setTimeout(() => {
            if (!canAutoLoop()) { STATE._loopPending = false; return; }
            STATE._loopPending = false;
            if (STATE.mode !== 'word' && document.getElementById('sentence-toggle').checked) {
                playCurrentSentenceTTS({ auto: true });
            } else {
                const a = document.getElementById('word-audio-player');
                if (a.src) { a.currentTime = 0; a.play().catch(() => {}); }
            }
        }, 300);
    });
    document.getElementById('sentence-audio-player').addEventListener('ended', () => {
        if (!canAutoLoop()) return;
        STATE._loopPending = true;
        setTimeout(() => {
            if (!canAutoLoop()) { STATE._loopPending = false; return; }
            STATE._loopPending = false;
            stopSentenceAudio();
            const a = document.getElementById('word-audio-player');
            if (a.src) { a.currentTime = 0; a.play().catch(() => {}); }
        }, 300);
    });
}

function getActiveWordForSentence() {
    if (STATE.referenceWord) return STATE.referenceWord.name;
    if (STATE.currentWordData) return STATE.currentWordData.name;
    const entry = getCurrentSentenceEntry();
    return entry ? entry.word : null;
}

// ==================== LOOKUP ====================
async function showLookupWord(word) {
    try {
        const resp = await apiGet('/api/lookup/' + encodeURIComponent(word));
        if (resp.found && resp.word) {
            const wd = resp.word;
            STATE.referenceWord = wd;
            STATE.sentenceWordIndex = 0;
            STATE.typingBuffer = '';
            STATE.typingStartTime = 0;
            STATE.typingActive = true;
            loadWordAudio(wd.name);
            updateWordInfoCard();
            updateTypingDisplay();
            if (document.getElementById('sentence-toggle').checked && STATE.mode !== 'word') {
                showLoading(true);
                document.getElementById('sentence-result').style.display = 'none';
                playWordThenSentence();
            } else {
                playWordAudio({ manual: true });
            }
            return;
        }
    } catch (e) { console.warn('Lookup error:', e); }

    STATE.referenceWord = { name: word, usphone: '', ukphone: '', trans: [] };
    STATE.sentenceWordIndex = 0;
    STATE.typingBuffer = '';
    STATE.typingStartTime = 0;
    STATE.typingActive = true;
    loadWordAudio(word);
    updateWordInfoCard();
    updateTypingDisplay();
    if (document.getElementById('sentence-toggle').checked && STATE.mode !== 'word') {
        showLoading(true);
        document.getElementById('sentence-result').style.display = 'none';
        playWordThenSentence();
    } else {
        playWordAudio({ manual: true });
    }
}

function playWordThenSentence() {
    const wordAudio = document.getElementById('word-audio-player');
    const playToken = ++STATE.audioPlayToken;
    stopSentenceAudio();
    STATE._playWordThenSentence = true;
    let done = false;

    const cleanup = () => {
        wordAudio.removeEventListener('ended', onEnd);
        STATE._playWordThenSentence = false;
    };

    const run = async () => {
        if (done) return;
        done = true;
        cleanup();
        const word = STATE.referenceWord ? STATE.referenceWord.name : (STATE.currentWordData ? STATE.currentWordData.name : null);
        if (word) await generateSentenceForWord(word, false, { autoPlay: false });
        showLoading(false);
        document.getElementById('sentence-result').style.display = '';
        if (playToken === STATE.audioPlayToken && STATE.settings.autoPlaySentence) {
            playCurrentSentenceTTS({ token: playToken });
        }
    };

    const onEnd = () => { run(); };
    wordAudio.addEventListener('ended', onEnd);

    wordAudio.currentTime = 0;
    wordAudio.dataset.playToken = String(playToken);
    const promise = wordAudio.play();
    if (promise) {
        promise.catch(() => { run(); });
    }
}

// ==================== SENTENCE ====================
function setupSentenceEvents() {
    document.getElementById('sentence-prev-btn').addEventListener('click', () => navSentence(-1));
    document.getElementById('sentence-next-btn').addEventListener('click', () => navSentence(1));
    document.getElementById('sentence-play-all-btn').addEventListener('click', playWordAndSentences);

    const result = document.getElementById('sentence-result');
    result.addEventListener('click', e => {
        const pb = e.target.closest('.sentence-play-btn');
        if (pb && STATE.sentenceIndex >= 0) {
            const entry = STATE.sentenceHistory[STATE.sentenceIndex];
            if (entry) {
                const t = pb.dataset.type === 'short' ? entry.short_sentence : entry.complex_sentence;
                playKokoroTTS(t, pb);
            }
        }
    });

    result.addEventListener('click', e => {
        const rb = e.target.closest('.sentence-regen-btn');
        if (rb) {
            const word = getActiveWordForSentence();
            if (word) generateSentenceForWord(word, true);
        }
    });

    result.addEventListener('click', async e => {
        const wl = e.target.closest('.word-link');
        if (!wl) return;
        const word = wl.textContent.trim();
        if (!word) return;
        await showLookupWord(word);
    });
}

async function generateSentenceForWord(word, force, options = {}) {
    if (!word) return;
    if (!document.getElementById('sentence-toggle').checked) return;
    const autoPlay = options.autoPlay !== undefined ? options.autoPlay : (STATE.settings.autoPlaySentence && STATE.mode !== 'word');
    const wordKey = word.toLowerCase();
    const requestToken = ++STATE.sentenceRequestToken;
    const isCurrentRequest = () => requestToken === STATE.sentenceRequestToken && (getActiveWordForSentence() || '').toLowerCase() === wordKey;

    if (!force) {
        const ex = getSentenceHistoryIndex(word);
        if (ex >= 0) {
            STATE.sentenceIndex = ex;
            if (requestToken === STATE.sentenceRequestToken) showLoading(false);
            document.getElementById('sentence-result').style.display = '';
            displaySentenceEntry(STATE.sentenceHistory[ex]);
            fillTopInfo(word, STATE.sentenceHistory[ex]);
            updateNav();
            STATE.sentenceWordIndex = 0;
            if (STATE.mode !== 'word') {
                STATE.typingBuffer = '';
                STATE.typingStartTime = 0;
                updateTypingDisplay();
                if (autoPlay) playCurrentSentenceTTS();
            }
            updateWordInfoCard();
            return;
        }
        if (STATE.sentencePromises[wordKey]) return STATE.sentencePromises[wordKey];
    }

    STATE.sentenceBusy = true;
    if (!force) STATE.sentencePromises[wordKey] = true;
    if (STATE.mode !== 'word') updateTypingDisplay();
    showLoading(true);
    document.getElementById('sentence-result').style.display = 'none';

    try {
        const c = STATE.config;
        const data = await apiPost('/api/sentence-generate', {
            word, api_key: c.sentence_api_key || '',
            system_prompt: c.sentence_system_prompt || '',
            prompt_template: c.sentence_prompt_template || '',
            dict_name: getSentenceCacheKey(),
            force
        });
        if (data.error) {
            showLoading(false);
            STATE.sentenceBusy = false;
            delete STATE.sentencePromises[wordKey];
            return;
        }

        if (force && STATE.sentenceIndex >= 0) {
            STATE.sentenceHistory[STATE.sentenceIndex] = data;
        } else {
            const ex = getSentenceHistoryIndex(word);
            if (ex >= 0) { STATE.sentenceHistory[ex] = data; STATE.sentenceIndex = ex; }
            else { STATE.sentenceHistory.push(data); STATE.sentenceIndex = STATE.sentenceHistory.length - 1; }
        }
        saveSentenceCache();

        if (!isCurrentRequest() && !force) {
            if (requestToken === STATE.sentenceRequestToken) showLoading(false);
            STATE.sentenceBusy = false;
            delete STATE.sentencePromises[wordKey];
            return data;
        }

        fillTopInfo(word, data);
        displaySentenceEntry(data);
        updateNav();
        showLoading(false);
        document.getElementById('sentence-result').style.display = '';

        STATE.sentenceWordIndex = 0;
        if (STATE.mode !== 'word') {
            STATE.typingBuffer = '';
            STATE.typingStartTime = 0;
            updateTypingDisplay();
            if (autoPlay && isCurrentRequest()) playCurrentSentenceTTS();
        }
        updateWordInfoCard();

    } catch (e) {
        showLoading(false);
        delete STATE.sentencePromises[wordKey];
    }
    delete STATE.sentencePromises[wordKey];
    STATE.sentenceBusy = false;
}

function fillTopInfo(word, data) {
    if (!data) return;
    const currentTopWord = STATE.referenceWord ? STATE.referenceWord.name : (STATE.currentWordData ? STATE.currentWordData.name : '');
    if (word.toLowerCase() !== currentTopWord.toLowerCase()) return;
    const phEl = document.getElementById('word-phonetic');
    const transEl = document.getElementById('word-trans');
    if (data.phonetics) {
        phEl.textContent = data.phonetics.startsWith('/') ? data.phonetics : '/' + data.phonetics + '/';
    }
    if (data.translations && data.translations.length) {
        transEl.textContent = data.translations.map(t => (t.partOfSpeech || '') + ' ' + (t.definition || '')).join('；');
    }
}

function displaySentenceEntry(e) {
    document.getElementById('short-sentence-trans').innerHTML = e.short_sentence_translation || '';
    document.getElementById('short-sentence-text').innerHTML = makeClickable(e.short_sentence || '');
    document.getElementById('short-sentence-grammar').innerHTML = e.short_sentence_grammar || '';
    document.getElementById('complex-sentence-trans').innerHTML = e.complex_sentence_translation || '';
    document.getElementById('complex-sentence-text').innerHTML = makeClickable(e.complex_sentence || '');
    document.getElementById('complex-sentence-grammar').innerHTML = e.complex_sentence_grammar || '';
}

function makeClickable(text) {
    if (!text) return '';
    const words = [...new Set(text.match(/\b[a-zA-Z]+\b/g) || [])].sort((a, b) => b.length - a.length);
    let r = text;
    words.forEach(w => {
        if (w.length <= 1) return;
        r = r.replace(new RegExp('\\b' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'g'), '<span class="word-link">' + w + '</span>');
    });
    return r;
}

function showLoading(s) {
    const card = document.getElementById('sentence-loading');
    card.style.display = s ? 'flex' : 'none';
    const text = card.querySelector('p');
    if (text && s) text.textContent = '[ ' + loadingLabel() + loadingDots() + ' ]';
}
function updateNav() {
    const i = STATE.sentenceIndex, l = STATE.sentenceHistory.length;
    document.getElementById('sentence-prev-btn').disabled = i <= 0;
    document.getElementById('sentence-next-btn').disabled = i >= l - 1;
    document.getElementById('sentence-history-info').textContent = l > 0 ? (i + 1) + '/' + l : '—';
}

function navSentence(d) {
    const n = STATE.sentenceIndex + d;
    if (n >= 0 && n < STATE.sentenceHistory.length) {
        STATE.sentenceIndex = n;
        const e = STATE.sentenceHistory[n];
        loadWordAudio(e.word);
        displaySentenceEntry(e);
        updateNav();
        STATE.sentenceWordIndex = 0;
        STATE.typingBuffer = '';
        STATE.typingStartTime = 0;
        if (STATE.mode !== 'word') updateTypingDisplay();
        updateWordInfoCard();
    }
}

// ==================== KOKORO TTS ====================
function btnLoading(btn, loading) {
    if (!btn) return;
    if (loading) {
        if (btn.classList.contains('btn-loading')) return;
        btn._origHTML = btn.innerHTML;
        btn.innerHTML = '<div class="mini-spinner"></div>';
        btn.classList.add('btn-loading');
        btn.disabled = true;
    } else {
        if (!btn.classList.contains('btn-loading')) return;
        btn.innerHTML = btn._origHTML || btn.innerHTML;
        btn.classList.remove('btn-loading');
        btn.disabled = false;
        btn._origHTML = null;
    }
}

async function playKokoroTTS(text, btn, options = {}) {
    if (!text) return;
    const c = STATE.config;
    const voiceCode = getVoiceCode(c.voice || 'af_heart');
    const speed = c.speed || 1.0;
    const gpuMode = c.tts_use_gpu || 'auto';
    const cacheKey = text + '|' + voiceCode + '|' + speed + '|' + gpuMode;
    const playToken = options.token || ++STATE.audioPlayToken;

    const audio = document.getElementById('sentence-audio-player');

    if (STATE.ttsCache[cacheKey]) {
        if (playToken !== STATE.audioPlayToken) return;
        stopWordAudio();
        audio.pause();
        audio.src = STATE.ttsCache[cacheKey];
        audio.currentTime = 0;
        audio.dataset.playToken = String(playToken);
        audio.play().catch(() => {});
        btnLoading(btn, false);
        return;
    }

    btnLoading(btn, true);
    try {
        if (!STATE.ttsInflight[cacheKey]) {
            STATE.ttsInflight[cacheKey] = fetch('/api/kokoro-tts', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text, voice: voiceCode, speed, use_gpu: gpuMode })
            }).then(async resp => {
                if (!resp.ok) return null;
                const blob = await resp.blob();
                const url = URL.createObjectURL(blob);
                STATE.ttsCache[cacheKey] = url;
                return url;
            }).finally(() => {
                delete STATE.ttsInflight[cacheKey];
            });
        }
        const url = await STATE.ttsInflight[cacheKey];
        if (!url || playToken !== STATE.audioPlayToken) return;
        stopWordAudio();
        audio.pause();
        audio.src = url;
        audio.currentTime = 0;
        audio.dataset.playToken = String(playToken);
        await audio.play();
    } catch (e) {
        console.warn('TTS error:', e);
    } finally {
        btnLoading(btn, false);
    }
}

async function playWordAndSentences() {
    if (STATE.sentenceIndex < 0) return;
    const e = STATE.sentenceHistory[STATE.sentenceIndex];
    if (!e) return;
    const token = ++STATE.audioPlayToken;
    const btn = document.getElementById('sentence-play-all-btn');
    STATE._playWordThenSentence = true;
    btnLoading(btn, true);
    try {
        loadWordAudio(e.word);
        await playWordAudio({ token });
        if (!(await waitForAudioEnd(document.getElementById('word-audio-player'), token))) return;
        if (e.short_sentence) {
            await playKokoroTTS(e.short_sentence, null, { token });
            if (!(await waitForAudioEnd(document.getElementById('sentence-audio-player'), token))) return;
        }
        if (e.complex_sentence) {
            await playKokoroTTS(e.complex_sentence, null, { token });
            await waitForAudioEnd(document.getElementById('sentence-audio-player'), token);
        }
    } finally {
        STATE._playWordThenSentence = false;
        btnLoading(btn, false);
    }
}

// ==================== SETTINGS ====================
function setupSettingsEvents() {
    document.getElementById('settings-toggle-btn').addEventListener('click', () => { document.getElementById('settings-modal').classList.add('open'); });
    document.getElementById('settings-close-btn').addEventListener('click', () => { document.getElementById('settings-modal').classList.remove('open'); });
    document.getElementById('save-settings-btn').addEventListener('click', saveSettings);
    document.getElementById('setting-speed').addEventListener('input', updateSpeedLabel);
    document.getElementById('clear-review-btn').addEventListener('click', () => {
        STATE.mistakeWords = {};
        persistMistakeWords();
        const s = document.getElementById('settings-status');
        s.textContent = '[ 错词本已清空 ]';
        s.className = 'settings-status visible';
        setTimeout(() => { s.className = 'settings-status'; }, 1800);
    });
}
function updateSpeedLabel() { document.getElementById('speed-value').textContent = parseFloat(document.getElementById('setting-speed').value || 1).toFixed(1) + 'x'; }

async function saveSettings() {
    const nextLearningSettings = {
        autoPlayWord: document.getElementById('setting-auto-word').checked,
        autoPlaySentence: document.getElementById('setting-auto-sentence').checked,
        pauseLoopWhileTyping: document.getElementById('setting-loop-idle').checked,
        prefetchNextAudio: document.getElementById('setting-prefetch-audio').checked,
        dictationReview: document.getElementById('setting-dictation-review').checked,
        strictTyping: document.getElementById('setting-strict-typing').checked,
        showPhonetic: document.getElementById('setting-show-phonetic').checked,
        showTranslation: document.getElementById('setting-show-translation').checked,
        wordOrder: document.getElementById('setting-word-order').value || 'sequence'
    };
    const data = {
        deepseek_api_key: document.getElementById('setting-deepseek-key').value,
        sentence_api_key: document.getElementById('setting-sentence-key').value,
        sentence_system_prompt: document.getElementById('setting-sentence-system').value,
        sentence_prompt_template: document.getElementById('setting-sentence-template').value,
        comfyui_server: document.getElementById('setting-comfyui-addr').value,
        voice: document.getElementById('setting-voice').value,
        speed: parseFloat(document.getElementById('setting-speed').value) || 1.0,
        tts_use_gpu: document.getElementById('setting-tts-gpu').value || 'auto'
    };
    try {
        await apiPost('/api/config', data);
        STATE.config = { ...STATE.config, ...data };
        STATE.settings = { ...DEFAULT_SETTINGS, ...nextLearningSettings };
        saveLearningSettings();
        const s = document.getElementById('settings-status');
        s.textContent = '[ 设置已保存 ]'; s.className = 'settings-status visible';
        setTimeout(() => { s.className = 'settings-status'; }, 2000);
    } catch (e) {
        const s = document.getElementById('settings-status');
        s.textContent = '[ 错误: ' + e.message + ' ]'; s.className = 'settings-status visible error';
        setTimeout(() => { s.className = 'settings-status'; }, 3000);
    }
}

function setupPasswordToggle() {
    document.querySelectorAll('.toggle-password').forEach(btn => {
        btn.addEventListener('click', () => {
            const inp = document.getElementById(btn.dataset.target);
            if (inp) {
                const isPw = inp.type === 'password';
                inp.type = isPw ? 'text' : 'password';
                btn.innerHTML = isPw
                    ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>'
                    : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
            }
        });
    });
}

// ==================== CYBER CODE RAIN ====================
const CodeRain = {
    canvas: null,
    ctx: null,
    columns: [],
    fontSize: 18,
    active: true,
    animationId: null,
    lastFrame: 0,
    frameInterval: 1000 / 30,

    init() {
        this.canvas = document.getElementById('cyber-canvas');
        if (!this.canvas) return;
        this.ctx = this.canvas.getContext('2d');
        this.resize();
        window.addEventListener('resize', () => this.resize());

        const colCount = Math.max(1, Math.floor(this.canvas.width / this.fontSize));
        this.columns = [];
        for (let i = 0; i < colCount; i++) {
            this.columns[i] = {
                x: i * this.fontSize + 10,
                y: Math.random() * this.canvas.height,
                speed: 2 + Math.random() * 6
            };
        }

        const toggle = document.getElementById('matrix-toggle');
        const savedState = localStorage.getItem('codeRainEnabled');
        this.active = savedState === null ? true : savedState === 'true';
        if (toggle) toggle.checked = this.active;

        if (toggle) {
            toggle.addEventListener('change', (e) => {
                this.active = e.target.checked;
                localStorage.setItem('codeRainEnabled', this.active);
                if (this.active) this.draw();
                else {
                    if (this.animationId) cancelAnimationFrame(this.animationId);
                    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
                }
            });
        }

        if (this.active) this.draw();
    },

    resize() {
        if (!this.canvas) return;
        this.canvas.width = window.innerWidth;
        this.canvas.height = window.innerHeight;
        const colCount = Math.max(1, Math.floor(this.canvas.width / this.fontSize));
        const oldLen = this.columns.length;
        this.columns.length = colCount;
        for (let i = oldLen; i < colCount; i++) {
            this.columns[i] = {
                x: i * this.fontSize + 10,
                y: Math.random() * this.canvas.height,
                speed: 2 + Math.random() * 6
            };
        }
    },

    draw() {
        if (!this.active || !this.ctx) return;
        if (document.hidden) {
            this.animationId = requestAnimationFrame(() => this.draw());
            return;
        }
        const now = performance.now();
        if (now - this.lastFrame < this.frameInterval) {
            this.animationId = requestAnimationFrame(() => this.draw());
            return;
        }
        this.lastFrame = now;

        this.ctx.fillStyle = 'rgba(3, 3, 5, 0.12)';
        this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

        this.ctx.font = `bold ${this.fontSize}px monospace`;

        for (let i = 0; i < this.columns.length; i++) {
            const col = this.columns[i];
            if (!col) continue;
            const char = Math.random() > 0.5 ? '1' : '0';

            const alpha = 1 - Math.min(col.y / this.canvas.height, 1) * 0.5;
            this.ctx.fillStyle = `rgba(${Math.random()>0.5?'0,240,255':'57,255,20'},${alpha})`;
            this.ctx.shadowBlur = 6;
            this.ctx.shadowColor = col.y < this.canvas.height * 0.3 ? '#00f0ff' : '#39ff14';
            this.ctx.shadowOffsetX = 1;

            this.ctx.fillText(char, col.x, col.y);

            col.y += col.speed;

            if (col.y > this.canvas.height + 50) {
                col.y = -10;
                col.x = i * this.fontSize + 10;
                col.speed = 2 + Math.random() * 6;
            }
        }

        this.ctx.shadowBlur = 0;
        this.ctx.shadowOffsetX = 0;
        this.animationId = requestAnimationFrame(() => this.draw());
    }
};

// ==================== WORD PICK MODAL ====================
let WORDPICK = { words: [], cursor: 0, selected: new Set(), cols: 0 };

function showWordPickModal(sentenceWords) {
    const cleanWords = [...new Set(sentenceWords.map(w => w.replace(/[^a-zA-Z'-]/g, '').toLowerCase()).filter(w => w.length > 0))];
    WORDPICK.words = cleanWords;
    WORDPICK.cursor = 0;
    WORDPICK.selected = new Set();
    WORDPICK.cols = 0;

    const upper = localStorage.getItem('vocab_uppercase') !== 'false';
    const grid = document.getElementById('wordpick-grid');
    grid.innerHTML = cleanWords.map((w, i) =>
        `<div class="wordpick-item" data-idx="${i}">${upper ? w.toUpperCase() : w}</div>`
    ).join('');

    const items = grid.querySelectorAll('.wordpick-item');
    items.forEach((item, i) => {
        item.addEventListener('click', () => {
            WORDPICK.cursor = i;
            updateWordPickUI();
            toggleWordPickSelection(i);
        });
        item.addEventListener('mouseenter', () => {
            WORDPICK.cursor = i;
            updateWordPickUI();
        });
    });

    WORDPICK.cols = Math.max(1, Math.floor(grid.clientWidth / 120));
    if (cleanWords.length > 0) updateWordPickUI();

    document.getElementById('wordpick-modal').classList.add('open');
    document.getElementById('wordpick-learn-btn').focus();

    document.getElementById('wordpick-learn-btn').onclick = () => {
        const pick = WORDPICK.selected.size > 0
            ? cleanWords.filter((_, i) => WORDPICK.selected.has(i))
            : [cleanWords[WORDPICK.cursor]];
        closeWordPickModal();
        if (pick.length === 1) { showLookupWord(pick[0]); return; }
        learnWord(pick[0], 0, pick);
    };

    document.getElementById('wordpick-skip-btn').onclick = () => {
        closeWordPickModal();
        STATE.typingActive = true;
        setTimeout(() => nextDictionaryWord(), 100);
    };

    document.addEventListener('keydown', handleWordPickKeys);
}

function updateWordPickUI() {
    const grid = document.getElementById('wordpick-grid');
    const items = grid.querySelectorAll('.wordpick-item');
    items.forEach((item, i) => {
        item.classList.toggle('focused', i === WORDPICK.cursor);
        item.classList.toggle('selected', WORDPICK.selected.has(i));
    });
}

function toggleWordPickSelection(idx) {
    if (WORDPICK.selected.has(idx)) WORDPICK.selected.delete(idx);
    else WORDPICK.selected.add(idx);
    updateWordPickUI();
}

function handleWordPickKeys(e) {
    if (!document.getElementById('wordpick-modal').classList.contains('open')) {
        document.removeEventListener('keydown', handleWordPickKeys);
        return;
    }

    if (e.key === 'ArrowLeft') {
        e.preventDefault();
        WORDPICK.cursor = Math.max(0, WORDPICK.cursor - 1);
        updateWordPickUI();
        return;
    }
    if (e.key === 'ArrowRight') {
        e.preventDefault();
        WORDPICK.cursor = Math.min(WORDPICK.words.length - 1, WORDPICK.cursor + 1);
        updateWordPickUI();
        return;
    }
    if (e.key === 'ArrowUp') {
        e.preventDefault();
        const c = Math.max(1, Math.floor(document.getElementById('wordpick-grid').clientWidth / 120));
        WORDPICK.cursor = Math.max(0, WORDPICK.cursor - c);
        updateWordPickUI();
        return;
    }
    if (e.key === 'ArrowDown') {
        e.preventDefault();
        const c = Math.max(1, Math.floor(document.getElementById('wordpick-grid').clientWidth / 120));
        WORDPICK.cursor = Math.min(WORDPICK.words.length - 1, WORDPICK.cursor + c);
        updateWordPickUI();
        return;
    }
    if (e.key === 'Enter') {
        e.preventDefault();
        document.getElementById('wordpick-learn-btn').click();
        return;
    }
    if (e.key === ' ') {
        e.preventDefault();
        document.getElementById('wordpick-skip-btn').click();
        return;
    }
    if (e.key === 'Escape') {
        e.preventDefault();
        document.getElementById('wordpick-skip-btn').click();
        return;
    }
}

function closeWordPickModal() {
    document.getElementById('wordpick-modal').classList.remove('open');
    document.removeEventListener('keydown', handleWordPickKeys);
}

function learnWord(word, idx, list) {
    showLookupWord(word).then(() => {
        if (idx + 1 < list.length) {
            setTimeout(() => learnWord(list[idx + 1], idx + 1, list), 500);
        } else {
            STATE.typingActive = true;
        }
    });
}
