import gradio as gr
import time
import random
import os
import json
from new_logic.typing_logic import process_typing_with_clear
from new_logic.youdao_api import test_youdao_api_with_audio
from new_logic.image_generation import generate_image_for_word, AVAILABLE_WORKFLOW_FILES # Import image generation logic
from new_logic.dictionary_translator import load_dictionary_metadata, get_translated_dictionary_names, get_filename_to_description_map

# --- Global State ---
dictionaries = {} # Stores all loaded dictionaries: {filename: [word_data, ...]}
dictionary_metadata = {} # Stores metadata from 字典.ts: {url: description}
filename_to_description_map = {} # Stores {description: filename} for reverse lookup
current_audio_path = None # To store the path of the current word's audio
current_image_path = None # To store the path of the current word's image
current_dictionary_name = None # This will now store the filename (URL)
current_words = [] # Words for the current session
current_word_index = 0
current_word_data = None # {name, trans, usphone, ukphone}

start_time = 0
typed_history = [] # To store (char, is_correct) for rich text display

# ComfyUI Global Settings (will be updated via UI)
comfyui_server_address = "127.0.0.1:8188"
comfyui_workflow_file = AVAILABLE_WORKFLOW_FILES[0] if AVAILABLE_WORKFLOW_FILES else None
comfyui_output_node_id = "" # Optional, auto-detect if empty

# --- Helper Functions ---
def load_dictionaries(data_dir="data"):
    global dictionaries, dictionary_metadata, filename_to_description_map
    dictionaries = {}
    dictionary_metadata = load_dictionary_metadata()
    filename_to_description_map = get_filename_to_description_map(dictionary_metadata)

    for filename in os.listdir(data_dir):
        if filename.endswith(".json"):
            filepath = os.path.join(data_dir, filename)
            try:
                with open(filepath, "r", encoding="utf-8") as f:
                    dictionaries[filename] = json.load(f)
                print(f"Loaded dictionary: {filename}")
            except Exception as e:
                print(f"Error loading {filename}: {e}")
    return dictionaries

def get_next_word():
    global current_word_index, current_word_data, current_words
    if current_word_index < len(current_words):
        current_word_data = current_words[current_word_index]
        current_word_index += 1
        return current_word_data
    else:
        current_word_data = None
        return None # Dictionary completed

# --- Core Logic Functions ---
async def initial_load_handler():
    # Use translated names for display, but internally work with filenames
    display_names = get_translated_dictionary_names(list(dictionaries.keys()), dictionary_metadata)
    if display_names:
        # Pass the filename (URL) to start_new_session
        initial_filename = filename_to_description_map.get(display_names[0], list(dictionaries.keys())[0])
        return await start_new_session(initial_filename)
    else:
        return ("<div style='font-size: 2em; text-align: center; color: red;'>未找到任何词典文件。请在 'data' 目录中放置 JSON 词典文件。</div>",
                "", "", "0.00 WPM", "0.00%", [], gr.update(visible=False), gr.update(maximum=0, value=0, visible=False), None, None) # Added None for image_output

async def next_dict_handler(current_dict_description):
    # Convert description back to filename
    current_filename = filename_to_description_map.get(current_dict_description)
    if not current_filename:
        return ("请选择一个词典。", "", "", "0.00 WPM", "0.00%", [], gr.update(visible=False), gr.update(maximum=0, value=0, visible=False), None, None)

    all_filenames = list(dictionaries.keys())
    if all_filenames and current_filename in all_filenames:
        next_index = (all_filenames.index(current_filename) + 1) % len(all_filenames)
        next_filename = all_filenames[next_index]
        return await start_new_session(next_filename, 0)
    else:
        return ("请选择一个词典。", "", "", "0.00 WPM", "0.00%", [], gr.update(visible=False), gr.update(maximum=0, value=0, visible=False), None, None) # Added None for image_output

async def start_new_session(dictionary_filename, start_index=0):
    global current_dictionary_name, current_words, current_word_index, start_time, typed_history, current_audio_path, current_image_path

    if dictionary_filename not in dictionaries:
        # Return 8 values (including audio_path), with empty strings for phonetic and translation, and hidden buttons
        return "请选择一个词典。", "", "", "0.00 WPM", "0.00%", [], gr.update(visible=False), gr.update(maximum=0, value=0, visible=False), None, None # Added None for image_output

    current_dictionary_name = dictionary_filename # Store the filename
    current_words = list(dictionaries[dictionary_filename]) # Make a copy
    # random.shuffle(current_words) # Shuffle words for a new session - 暂时不打乱，以便进度条按顺序
    
    # Ensure start_index is within bounds
    if not (0 <= start_index < len(current_words)):
        start_index = 0 # Default to beginning if out of bounds

    current_word_index = start_index
    start_time = 0
    typed_history = []
    current_audio_path = None # Reset audio path
    current_image_path = None # Reset image path

    word_data = get_next_word()
    if word_data:
        word_html_content = f"""
            <div style='font-size: 4em; text-align: center; font-weight: bold;'>{word_data['name']}</div>
            <div style='font-size: 1.5em; text-align: center; margin-top: 10px;'>/{word_data.get('usphone', '')}/</div>
            <div style='font-size: 1.2em; text-align: center; margin-top: 10px;'>{"<br>".join(word_data['trans'])}</div>
        """
        initial_highlight = [(char, "untyped") for char in word_data['name']]
        
        # Get audio for the current word asynchronously
        _, audio_file_path = await test_youdao_api_with_audio(word_data['name'], 'us', current_dictionary_name) # Default to US pronunciation
        current_audio_path = audio_file_path

        # Trigger image generation immediately when a new word is displayed
        if word_data and comfyui_workflow_file and comfyui_server_address:
            print(f"Attempting to generate/load image for word: {word_data['name']} on word display.")
            generated_image, image_status_message = await generate_image_for_word(
                word_data['name'],
                current_dictionary_name,
                comfyui_workflow_file,
                comfyui_server_address,
                comfyui_output_node_id
            )
            if generated_image:
                current_image_path = generated_image # Store the PIL Image object
                print(f"Image display successful: {image_status_message}")
            else:
                current_image_path = None
                print(f"Image display failed: {image_status_message}")
        else:
            current_image_path = None
            print("Image generation/load skipped on word display: Missing word data, workflow file, or server address.")

        # Return 8 values + slider update + audio path + image path
        return word_html_content, "", "", "0.00 WPM", "0.00%", initial_highlight, gr.update(visible=False), gr.update(maximum=len(current_words) - 1, value=start_index, visible=True), current_audio_path, current_image_path
    else:
        # Return 8 values + slider update + audio path + image path
        return "所选词典为空。", "", "", "0.00 WPM", "0.00%", [], gr.update(visible=False), gr.update(maximum=0, value=0, visible=False), None, None # Initial image is None


async def process_typing(user_input_text):
    global current_word_data, start_time, current_word_index, current_words, current_audio_path, current_image_path, \
           comfyui_server_address, comfyui_workflow_file, comfyui_output_node_id

    # 调用新逻辑函数
    # process_typing_with_clear 返回 8 个值：
    # word_html_content, phonetic_display_hidden, translation_display_hidden, wpm_val, accuracy_val, highlight_data, completion_buttons_visibility, clear_input_value
    word_html_content, phonetic_display_hidden, translation_display_hidden, wpm_val, accuracy_val, highlight_data, completion_buttons_visibility, clear_input_value = \
        process_typing_with_clear(user_input_text, current_word_data, start_time)

    audio_output = current_audio_path # Keep current audio if not moving to next word
    image_output = current_image_path # Keep current image if not moving to next word

    # 如果单词正确完成，需要更新全局状态并获取下一个单词 (不区分大小写)
    if user_input_text.lower() == current_word_data['name'].lower(): # 修改为不区分大小写比较
        next_word_data = get_next_word()
        if next_word_data:
            word_html_content = f"""
                <div style='font-size: 4em; text-align: center; font-weight: bold;'>{next_word_data['name']}</div>
                <div style='font-size: 1.5em; text-align: center; margin-top: 10px;'>/{next_word_data.get('usphone', '')}/</div>
                <div style='font-size: 1.2em; text-align: center; margin-top: 10px;'>{"<br>".join(next_word_data['trans'])}</div>
            """
            highlight_data = [(char, "untyped") for char in next_word_data['name']]
            start_time = 0 # 重置计时器
            
            # Get audio for the next word asynchronously
            _, audio_file_path = await test_youdao_api_with_audio(next_word_data['name'], 'us', current_dictionary_name) # Default to US pronunciation
            current_audio_path = audio_file_path
            audio_output = current_audio_path
            
            # Trigger image generation/load for the *new* word
            if next_word_data and comfyui_workflow_file and comfyui_server_address:
                print(f"Attempting to generate/load image for next word: {next_word_data['name']} on word completion.")
                generated_image, image_status_message = await generate_image_for_word(
                    next_word_data['name'],
                    current_dictionary_name,
                    comfyui_workflow_file,
                    comfyui_server_address,
                    comfyui_output_node_id
                )
                if generated_image:
                    image_output = generated_image
                    current_image_path = generated_image # Store the PIL Image object
                    print(f"Image display successful for next word: {image_status_message}")
                else:
                    image_output = None
                    current_image_path = None
                    print(f"Image display failed for next word: {image_status_message}")
            else:
                image_output = None
                current_image_path = None
                print("Image generation/load skipped for next word: Missing word data, workflow file, or server address.")

        else:
            # 词典完成
            word_html_content = "恭喜！您已完成当前词典。"
            highlight_data = []
            completion_buttons_visibility = gr.update(visible=True)
            start_time = 0 # 重置计时器
            current_audio_path = None # Clear audio path
            audio_output = None
            current_image_path = None # Clear image path
            image_output = None

    # Return 9 values + slider update + audio path + image output
    return word_html_content, phonetic_display_hidden, translation_display_hidden, wpm_val, accuracy_val, highlight_data, completion_buttons_visibility, clear_input_value, gr.update(value=current_word_index), audio_output, image_output

async def regenerate_image_handler():
    global current_word_data, current_dictionary_name, comfyui_workflow_file, comfyui_server_address, comfyui_output_node_id, current_image_path
    
    if not current_word_data:
        return None, "请先开始一个学习会话。" # No word to generate image for

    print(f"Attempting to regenerate image for word: {current_word_data['name']}")
    generated_image, image_status_message = await generate_image_for_word(
        current_word_data['name'],
        current_dictionary_name,
        comfyui_workflow_file,
        comfyui_server_address,
        comfyui_output_node_id,
        force_regenerate=True # Force regeneration
    )
    if generated_image:
        current_image_path = generated_image
        print(f"Image regeneration successful: {image_status_message}")
        return generated_image, image_status_message
    else:
        current_image_path = None
        print(f"Image regeneration failed: {image_status_message}")
        return None, image_status_message

# Helper async function for Gradio events
async def _start_session_wrapper(desc, idx):
    filename = filename_to_description_map.get(desc, desc)
    return await start_new_session(filename, idx)

# --- Gradio Interface Definition ---
with gr.Blocks(theme=gr.themes.Soft()) as app:


    # Load dictionaries on startup
    loaded_dictionaries = load_dictionaries()
    # Get translated names for display
    display_dictionary_names = get_translated_dictionary_names(list(loaded_dictionaries.keys()), dictionary_metadata)
    
    # Determine initial value for dropdown
    initial_dropdown_value = None
    if display_dictionary_names:
        # Try to find the description for the first loaded filename
        first_filename = list(loaded_dictionaries.keys())[0]
        initial_dropdown_value = dictionary_metadata.get(first_filename, first_filename)


    with gr.Tab("单词学习"): # Main tab for word learning
        with gr.Row():
            with gr.Column():
                with gr.Row():
                    with gr.Column(scale=1):
                        dictionary_dropdown = gr.Dropdown(
                            choices=display_dictionary_names, # Use translated names here
                            label="选择词典（可以搜索）",
                            value=initial_dropdown_value, # Use translated initial value
                            interactive=True,
                            filterable=True # Add search box to dropdown
                        )
                    with gr.Column(scale=1):
                        start_button = gr.Button("开始学习")
                        gr.Markdown("## [给作者一颗星星](https://github.com/kungful/VocabTypeAI.git)")
        
                with gr.Row():
                    # Initial max based on the first loaded dictionary's actual filename
                    initial_max_slider = 0
                    if initial_dropdown_value and filename_to_description_map.get(initial_dropdown_value) in dictionaries:
                        initial_max_slider = len(dictionaries.get(filename_to_description_map.get(initial_dropdown_value), [])) - 1

                    word_index_slider = gr.Slider(
                        minimum=0,
                        maximum=initial_max_slider,
                        value=0,
                        step=1,
                        label="从第几个单词开始练习 (索引)",
                        interactive=True,
                        visible=True if display_dictionary_names else False # Initially visible if dictionaries exist
                    )
        
                with gr.Column():
                    # Combined display for word, phonetic, and translation
                    word_and_details_display = gr.HTML(
                        value="<div style='font-size: 4em; text-align: center; font-weight: bold;'></div>",
                        label="单词 / 音标 / 中文意思"
                    )
                    # These components are now redundant for display but kept for output consistency
                    phonetic_display_hidden = gr.HTML(visible=False)
                    translation_display_hidden = gr.Textbox(visible=False)
        
        
                    user_input = gr.Textbox(
                        label="在此输入单词",
                        lines=1,
                        placeholder="选择词典并点击'开始学习'...",
                        autofocus=True
                    )
                highlighted_output_display = gr.HighlightedText(
                    label="您的输入",
                    combine_adjacent=True,
                    show_legend=True,
                    color_map={"correct": "green", "incorrect": "red", "extra": "orange", "untyped": "grey"}
                )
        
        

                with gr.Row():
                    with gr.Column(scale=1):
                        wpm_display = gr.Textbox(label="速度", value="0.00 WPM", interactive=False)
                        accuracy_display = gr.Textbox(label="准确率", value="0.00%", interactive=False)
                    audio_player = gr.Audio(label="单词发音", autoplay=True, streaming=True) # Add audio player
                
                    
        
                with gr.Row(visible=False) as completion_buttons:
                    restart_button = gr.Button("重新学习当前词典")
                    next_dict_button = gr.Button("选择下一个词典")
                outputs=[gr.Textbox(value="设置已保存！", interactive=False, visible=True)] # Provide a temporary status message

            with gr.Column():
                image_display = gr.Image(label="单词图像", type="filepath", show_download_button=True, height=768, width=1024) # Add image display
                regenerate_image_button = gr.Button("重新生成图像") # New button for regenerating image
                image_status_message_display = gr.Textbox(label="图像生成状态", interactive=False, value="") # New textbox for status messages
        

    with gr.Tab("ComfyUI 设置"): # New tab for ComfyUI settings
        gr.Markdown("### ComfyUI 图像生成参数设置")
        gr.Markdown(
            "**确保**: \n"
            "1. 选定的JSON工作流包含一个 `GeminiFlash` 节点 (用于 'Additional Context')。\n"
            "2. 如果工作流包含 `Hua_gradio_Seed` 节点, **脚本将自动为其填入随机种子**。\n"
            "3. 工作流中必须包含至少一个 `SaveImageWebsocket` 类型的节点，用于通过WebSocket输出图像。\n"
            "4. ComfyUI 服务器地址可以是 `127.0.0.1:8188`，也可以是完整的URL，如 `https://your-domain.com/comfyui-path`。"
        )
        comfyui_server_address_input = gr.Textbox(
            label="ComfyUI 服务器地址", 
            value="127.0.0.1:8188", 
            placeholder="例如: 127.0.0.1:8188 或 https://your-domain.com/comfyui"
        )
        comfyui_workflow_file_dropdown = gr.Dropdown(
            label="选择工作流 JSON 文件",
            choices=AVAILABLE_WORKFLOW_FILES,
            value=AVAILABLE_WORKFLOW_FILES[0] if AVAILABLE_WORKFLOW_FILES else None,
            interactive=True
        )
        comfyui_output_node_id_input = gr.Textbox(
            label="SaveImageWebsocket 节点ID (可选)",
            value="",
            placeholder="留空则自动检测, 或指定特定ID (如 '16')"
        )
        # Button to save settings (optional, can also update on change)
        save_comfyui_settings_button = gr.Button("保存 ComfyUI 设置")

    # Event Handling
    start_button.click(
        fn=_start_session_wrapper, # Use the async wrapper
        inputs=[dictionary_dropdown, word_index_slider],
        outputs=[word_and_details_display, phonetic_display_hidden, translation_display_hidden, wpm_display, accuracy_display, highlighted_output_display, completion_buttons, word_index_slider, audio_player, image_display] # Added image_display
    )

    user_input.input(
        fn=process_typing,
        inputs=[user_input],
        outputs=[word_and_details_display, phonetic_display_hidden, translation_display_hidden, wpm_display, accuracy_display, highlighted_output_display, completion_buttons, user_input, word_index_slider, audio_player, image_display], # Added image_display
        show_progress="hidden"
    )

    restart_button.click(
        fn=_start_session_wrapper, # Use the async wrapper
        inputs=[dictionary_dropdown, word_index_slider],
        outputs=[word_and_details_display, phonetic_display_hidden, translation_display_hidden, wpm_display, accuracy_display, highlighted_output_display, completion_buttons, word_index_slider, audio_player, image_display] # Added image_display
    )

    next_dict_button.click(
        fn=next_dict_handler, # This is already an async handler
        inputs=[dictionary_dropdown],
        outputs=[word_and_details_display, phonetic_display_hidden, translation_display_hidden, wpm_display, accuracy_display, highlighted_output_display, completion_buttons, word_index_slider, audio_player, image_display] # Added image_display
    )

    # New event: Update slider when dictionary changes
    dictionary_dropdown.change(
        fn=lambda display_name: gr.update(
            maximum=len(dictionaries.get(filename_to_description_map.get(display_name, display_name), [])) - 1, # Convert display name back to filename for lookup
            value=0, # Reset slider to 0 when dictionary changes
            visible=True if dictionaries.get(filename_to_description_map.get(display_name, display_name)) else False,
            label=f"从第几个单词开始练习 (0-{len(dictionaries.get(filename_to_description_map.get(display_name, display_name), [])) - 1})"
        ),
        inputs=[dictionary_dropdown],
        outputs=[word_index_slider]
    )

    # New event: Start session when slider is released
    word_index_slider.release(
        fn=_start_session_wrapper, # Use the async wrapper
        inputs=[dictionary_dropdown, word_index_slider],
        outputs=[word_and_details_display, phonetic_display_hidden, translation_display_hidden, wpm_display, accuracy_display, highlighted_output_display, completion_buttons, word_index_slider, audio_player, image_display] # Added image_display
    )

    # Initial setup (moved to app.load event for async handling)
    app.load(
        fn=initial_load_handler, # Use the new async handler
        outputs=[word_and_details_display, phonetic_display_hidden, translation_display_hidden, wpm_display, accuracy_display, highlighted_output_display, completion_buttons, word_index_slider, audio_player, image_display], # Added image_display
        queue=False # Do not queue initial load
    )

    # ComfyUI settings update handlers
    def update_comfyui_settings(server_addr, workflow_file, output_node_id):
        global comfyui_server_address, comfyui_workflow_file, comfyui_output_node_id
        comfyui_server_address = server_addr
        comfyui_workflow_file = workflow_file
        comfyui_output_node_id = output_node_id
        print(f"ComfyUI settings updated: Server={comfyui_server_address}, Workflow={comfyui_workflow_file}, Node ID={comfyui_output_node_id}")
        return "设置已保存！"

    comfyui_server_address_input.change(
        fn=update_comfyui_settings,
        inputs=[comfyui_server_address_input, comfyui_workflow_file_dropdown, comfyui_output_node_id_input],
        outputs=[] # No direct output, just update global state
    )
    comfyui_workflow_file_dropdown.change(
        fn=update_comfyui_settings,
        inputs=[comfyui_server_address_input, comfyui_workflow_file_dropdown, comfyui_output_node_id_input],
        outputs=[]
    )
    comfyui_output_node_id_input.change(
        fn=update_comfyui_settings,
        inputs=[comfyui_server_address_input, comfyui_workflow_file_dropdown, comfyui_output_node_id_input],
        outputs=[]
    )
    save_comfyui_settings_button.click(
        fn=update_comfyui_settings,
        inputs=[comfyui_server_address_input, comfyui_workflow_file_dropdown, comfyui_output_node_id_input],

    )
    
    # Initial update of ComfyUI settings on app load
    app.load(
        fn=lambda: (comfyui_server_address, comfyui_workflow_file, comfyui_output_node_id),
        outputs=[comfyui_server_address_input, comfyui_workflow_file_dropdown, comfyui_output_node_id_input],
        queue=False
    )

    # New event: Regenerate image button click
    regenerate_image_button.click(
        fn=regenerate_image_handler,
        inputs=[], # No direct inputs needed from UI components for this handler
        outputs=[image_display, image_status_message_display] # Update the image display and status message
    )


if __name__ == "__main__":
    app.launch()
