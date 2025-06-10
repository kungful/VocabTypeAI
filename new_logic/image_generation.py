import websocket # NOTE: websocket-client (https://github.com/websocket-client/websocket-client)
import uuid
import json
import urllib.request
import urllib.parse
import io
from PIL import Image
import os
import random
import asyncio # For async file operations

# --- Global Configuration ---
IMAGE_OUTPUT_DIR = "generated_images" # New directory for images

def get_json_files_in_root(directory="."):
    """扫描指定目录下的JSON文件列表"""
    files = []
    try:
        for f_name in os.listdir(directory):
            if os.path.isfile(os.path.join(directory, f_name)) and f_name.lower().endswith(".json"):
                files.append(f_name)
    except Exception as e:
        print(f"Error scanning for JSON files: {e}")
    return files

# This will be used by gradioqwerty.py to populate the dropdown
AVAILABLE_WORKFLOW_FILES = get_json_files_in_root("websocket_simple_comfyui") # Scan in the comfyui folder

# --- ComfyUI API Call Functions ---
def queue_prompt(prompt, request_url, client_id):
    p = {"prompt": prompt, "client_id": client_id}
    data = json.dumps(p).encode('utf-8')
    req = urllib.request.Request(request_url, data=data)
    try:
        response = urllib.request.urlopen(req)
        return json.loads(response.read())
    except urllib.error.URLError as e:
        print(f"Error queueing prompt (URLError): {e} to {request_url}")
        return None
    except json.JSONDecodeError as e:
        print(f"Error decoding queue response (JSONDecodeError): {e}")
        return None
    except Exception as e:
        print(f"An unexpected error occurred in queue_prompt: {e}")
        return None


def get_images_from_websocket(ws, prompt_id_to_wait_for, target_image_node_name):
    output_images = {}
    current_node_for_image = ""
    print(f"Waiting for images from prompt_id: {prompt_id_to_wait_for} on node: {target_image_node_name}")

    while True:
        try:
            out = ws.recv()
            if isinstance(out, str):
                message = json.loads(out)
                if message['type'] == 'status':
                    pass
                elif message['type'] == 'executing':
                    data = message['data']
                    if data.get('prompt_id') == prompt_id_to_wait_for:
                        if data['node'] is None:
                            print(f"Execution finished for prompt_id: {prompt_id_to_wait_for}")
                            if not output_images.get(target_image_node_name):
                                print(f"Warning: No image received from target node '{target_image_node_name}' before execution finished.")
                            break
                        else:
                            current_node_for_image = data['node']
            elif isinstance(out, bytes):
                if current_node_for_image == target_image_node_name or not output_images.get(target_image_node_name): # Prioritize target, but accept if nothing else has been stored for target yet
                    images_output_list = output_images.get(target_image_node_name, [])
                    images_output_list.append(out[8:]) # First 8 bytes are header
                    output_images[target_image_node_name] = images_output_list
                    print(f"Image received and stored for target node '{target_image_node_name}'. Total for this node: {len(images_output_list)}")

        except websocket.WebSocketConnectionClosedException:
            print("WebSocket connection closed.")
            break
        except ConnectionResetError:
            print("WebSocket connection reset by peer.")
            break
        except json.JSONDecodeError as e:
            print(f"Error decoding WebSocket JSON message: {e} - Message: {out if isinstance(out, str) else '<binary_data>'}")
        except Exception as e:
            print(f"WebSocket error during recv: {e}")
            break
    return output_images


# --- Main Generation Function ---
async def generate_image_for_word(
    word_to_generate: str,
    dictionary_name: str,
    selected_workflow_file: str,
    server_addr_input: str,
    image_output_node_id_from_ui: str,
    force_regenerate: bool = False,
    allow_api_call: bool = True # New parameter to control API calls
):
    # Construct local image path
    sub_folder = os.path.join(IMAGE_OUTPUT_DIR, dictionary_name.replace(' ', '_'))
    sanitized_word = word_to_generate.replace(' ', '_').replace('/', '_')
    local_image_path = os.path.join(sub_folder, f"{sanitized_word}.png")

    # Always check if image exists locally, unless force_regenerate is True
    if not force_regenerate and os.path.exists(local_image_path):
        try:
            print(f"Found local image for '{word_to_generate}' at: {local_image_path}")
            # Use asyncio.to_thread for file I/O to keep event loop free
            return local_image_path, f"已从本地加载图像: {local_image_path}"
        except Exception as e:
            print(f"Error loading local image {local_image_path}: {e}")
            # If local image fails to load, proceed to generate (if allowed)
            pass 

    # If local image not found or force_regenerate is True, proceed to API call if allowed
    if not allow_api_call:
        print(f"Image generation API call skipped for '{word_to_generate}': API calls are disabled.")
        return None, "图像推理已关闭，未从本地加载到图像。"

    if not selected_workflow_file:
        return None, "错误：请先选择一个工作流JSON文件。"
    
    # Ensure workflow_path is correct, assuming it's in websocket_simple_comfyui
    workflow_path = os.path.join("websocket_simple_comfyui", selected_workflow_file)
    if not os.path.exists(workflow_path):
        return None, f"错误：选择的工作流文件 '{workflow_path}' 不存在。"

    parsed_url = urllib.parse.urlparse(server_addr_input)
    scheme = parsed_url.scheme
    netloc = parsed_url.netloc
    path = parsed_url.path.rstrip('/')

    if not scheme:
        if not netloc and path:
            parts = path.split('/', 1)
            netloc = parts[0]
            path = '/' + parts[1] if len(parts) > 1 else ''
            path = path.rstrip('/')
        http_scheme = "http"
        ws_scheme = "ws"
    elif scheme.lower() == "https":
        http_scheme = "https"
        ws_scheme = "wss"
    elif scheme.lower() == "http":
        http_scheme = "http"
        ws_scheme = "ws"
    else:
        print(f"Warning: Unknown scheme '{scheme}' in server address. Defaulting to http/ws.")
        http_scheme = "http"
        ws_scheme = "ws"

    if not netloc:
        return None, f"无法从输入 '{server_addr_input}' 解析服务器地址/主机名。"

    prompt_request_url = urllib.parse.urlunparse((http_scheme, netloc, f"{path}/prompt", '', '', ''))
    websocket_url_base = urllib.parse.urlunparse((ws_scheme, netloc, f"{path}/ws", '', '', ''))

    client_id = str(uuid.uuid4())
    websocket_connect_url = f"{websocket_url_base}?clientId={client_id}"
    
    print(f"Attempting to connect to ComfyUI API at: {prompt_request_url}")
    print(f"Attempting to connect to WebSocket at: {websocket_connect_url}")

    ws = websocket.WebSocket()
    try:
        ws.connect(websocket_connect_url)
        print(f"WebSocket connected to {websocket_connect_url}")
    except Exception as e:
        return None, f"无法连接WebSocket ({websocket_connect_url}): {e}"

    try:
        with open(workflow_path, 'r', encoding='utf-8') as f:
            prompt = json.loads(f.read())
        print(f"Successfully loaded workflow from: {workflow_path}")
    except Exception as e:
        ws.close()
        print(f"Error loading or parsing workflow file '{workflow_path}': {e}")
        return None, f"加载或解析工作流文件时出错: {e}"

    # Modify GeminiFlash node with the word
    gemini_flash_node_id = None
    for node_id, node_data in prompt.items():
        if node_data.get("class_type") == "GeminiFlash":
            gemini_flash_node_id = node_id
            break # Found the first one

    if gemini_flash_node_id:
        if "inputs" in prompt[gemini_flash_node_id] and "Additional_Context" in prompt[gemini_flash_node_id]["inputs"]:
            prompt[gemini_flash_node_id]["inputs"]["Additional_Context"] = word_to_generate
            print(f"Applied 'Additional_Context': '{word_to_generate}' to GeminiFlash node '{gemini_flash_node_id}'")
        else:
            print(f"Warning: GeminiFlash node '{gemini_flash_node_id}' found, but 'Additional_Context' input not present or 'inputs' field missing.")
    else:
        print("Warning: No 'GeminiFlash' node found in the workflow. 'Additional_Context' from UI not applied.")

    # --- MODIFIED SECTION FOR Hua_gradio_Seed ---
    found_hua_seed_node_id = None
    for node_id_iter, node_data_iter in prompt.items():
        if node_data_iter.get("class_type") == "Hua_gradio_Seed":
            found_hua_seed_node_id = node_id_iter
            break # Use the first one found

    if found_hua_seed_node_id:
        if "inputs" in prompt[found_hua_seed_node_id] and "seed" in prompt[found_hua_seed_node_id]["inputs"]:
            random_seed_value = random.randint(0, 2**64 - 1) # Generate a large random seed
            prompt[found_hua_seed_node_id]["inputs"]["seed"] = random_seed_value
            print(f"Dynamically found Hua_gradio_Seed node '{found_hua_seed_node_id}'. Applied *random* seed: {random_seed_value}.")
        else:
            print(f"Warning: Hua_gradio_Seed node '{found_hua_seed_node_id}' found, but its 'inputs' field or 'seed' key is missing. Random seed not applied.")
    else:
        print(f"Warning: No 'Hua_gradio_Seed' node found in the workflow. Cannot apply a targeted random seed.")
    # --- END OF MODIFIED SECTION ---
    
    actual_image_output_node_id = None
    if image_output_node_id_from_ui and image_output_node_id_from_ui.strip():
        user_id = image_output_node_id_from_ui.strip()
        if user_id in prompt and prompt[user_id].get("class_type") == "SaveImageWebsocket":
            actual_image_output_node_id = user_id
            print(f"Using user-specified SaveImageWebsocket node ID: '{actual_image_output_node_id}'")
        else:
            print(f"Warning: User-specified SaveImageWebsocket ID '{user_id}' is invalid or not a SaveImageWebsocket node. Attempting auto-detection.")

    if not actual_image_output_node_id:
        found_auto_node = False
        for node_id, node_data in prompt.items():
            if node_data.get("class_type") == "SaveImageWebsocket":
                actual_image_output_node_id = node_id
                found_auto_node = True
                print(f"Auto-detected SaveImageWebsocket node ID: '{actual_image_output_node_id}' (using the first one found).")
                break
        if not found_auto_node:
             print("Info: Auto-detection for SaveImageWebsocket node did not find any.")

    if not actual_image_output_node_id:
        ws.close()
        return None, f"错误: 在工作流 '{selected_workflow_file}' 中未能找到任何 'SaveImageWebsocket' 类型的节点 (用户也未提供有效的ID)."

    queued_data = queue_prompt(prompt, prompt_request_url, client_id)
    if not queued_data or 'prompt_id' not in queued_data:
        ws.close()
        return None, f"无法提交工作流 ({prompt_request_url}) 或获取prompt_id."
    prompt_id = queued_data['prompt_id']
    print(f"Prompt queued with ID: {prompt_id}")

    all_output_images = get_images_from_websocket(ws, prompt_id, actual_image_output_node_id)
    ws.close()
    print("WebSocket closed.")

    if all_output_images and actual_image_output_node_id in all_output_images:
        image_data_list = all_output_images[actual_image_output_node_id]
        if image_data_list:
            try:
                image_bytes = image_data_list[0]
                # No need to open PIL Image here if we are returning filepath
                
                # --- Save the image ---
                sub_folder = os.path.join(IMAGE_OUTPUT_DIR, dictionary_name.replace(' ', '_'))
                os.makedirs(sub_folder, exist_ok=True)
                sanitized_word = word_to_generate.replace(' ', '_').replace('/', '_') # Sanitize for filename
                image_filename = f"{sanitized_word}.png" # Assuming PNG for now
                image_path = os.path.join(sub_folder, image_filename)
                
                # Save the image bytes directly to file
                await asyncio.to_thread(lambda: open(image_path, 'wb').write(image_bytes))
                print(f"Image saved to: {image_path}")

                return image_path, f"图像生成成功并保存到: {image_path}"
            except Exception as e:
                print(f"Error opening or saving image: {e}")
                return None, f"打开或保存图像时出错: {e}"
        else:
            return None, f"节点 '{actual_image_output_node_id}' 未返回图像数据。"
    else:
        return None, f"未从节点 '{actual_image_output_node_id}' 收到期望的图像数据。"
