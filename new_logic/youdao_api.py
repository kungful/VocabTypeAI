import gradio as gr
import httpx # Import httpx for async requests
import asyncio # Import asyncio for async operations
import os # Import os for path operations and directory creation

def generate_audio_url(text, pronunciation):
    """生成有道发音API的音频URL，支持单词或句子"""
    base_url = 'https://dict.youdao.com/dictvoice?audio='
    if pronunciation == 'uk':
        return f"{base_url}{text}&type=1"
    elif pronunciation == 'us':
        return f"{base_url}{text}&type=2"
    else:
        return None

# 定义母文件夹
AUDIO_OUTPUT_DIR = "generated_audio"

async def test_youdao_api_with_audio(text, pronunciation, dictionary_name="default"):
    """测试有道发音API并返回音频URL，支持单词或句子，保存为wav格式"""
    url = generate_audio_url(text, pronunciation)
    if not url:
        return "无效的发音类型，请选择 'uk' 或 'us'。", None

    try:
        async with httpx.AsyncClient() as client:
            response = await client.get(url)
            if response.status_code == 200 and response.headers['Content-Type'].startswith('audio'):
                # 根据词典名字创建子文件夹
                # 假设 dictionary_name 是词典的名字，用于创建子文件夹
                # 如果没有提供词典名字，可以使用默认值或者根据text生成一个
                sub_folder = os.path.join(AUDIO_OUTPUT_DIR, dictionary_name.replace(' ', '_'))
                os.makedirs(sub_folder, exist_ok=True)

                # 保存音频为wav格式
                sanitized_text = text.replace(' ', '_')  # 替换空格以适应文件名
                audio_filename = f"{sanitized_text}_{pronunciation}.wav"
                audio_path = os.path.join(sub_folder, audio_filename)

                # 使用 asyncio.to_thread 将阻塞的文件写入操作放到单独的线程中
                await asyncio.to_thread(lambda: open(audio_path, 'wb').write(response.content))
                return f"API 可用，音频文件已成功获取并保存为: {audio_path}", audio_path
            else:
                return "API 不可用，未能获取音频文件。", None
    except Exception as e:
        return f"请求失败: {e}", None

def gradio_interface():
    """创建Gradio界面"""
    def api_test(word, pronunciation, dictionary_name):
        message, audio_url = test_youdao_api_with_audio(word, pronunciation, dictionary_name)
        return message, audio_url

    interface = gr.Interface(
        fn=api_test,
        inputs=[
            gr.Textbox(label="单词"),
            gr.Radio(choices=["uk", "us"], label="发音类型"),
            gr.Textbox(label="词典名字", value="default_dictionary") # 添加词典名字输入框
        ],
        outputs=[
            gr.Textbox(label="测试结果"),
            gr.Audio(label="音频播放")
        ],
        title="有道发音API测试",
        description="输入单词、选择发音类型和词典名字，测试有道发音API是否可用，并播放音频。音频将保存到以词典名字命名的子文件夹中。"
    )
    return interface

if __name__ == "__main__":
    app = gradio_interface()
    app.launch()
