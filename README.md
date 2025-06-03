# 打字交互音画记忆单词 (Typing Interactive Audio-Visual Word Memorization)

这是一个基于 Gradio 构建的创新型单词学习应用程序，旨在通过多感官交互（打字、发音、图像）提升用户的单词记忆效率。它集成了有道词典发音和 ComfyUI 图像生成功能，为用户提供一个沉浸式、个性化的学习体验。

## ✨ 主要特性

*   **交互式打字练习**：实时反馈打字速度（WPM）、准确率，并以颜色高亮显示输入与目标单词的匹配情况。支持不区分大小写的单词匹配和输入错误时自动清空输入框。
*   **智能发音辅助**：通过有道词典 API 获取单词的英式或美式发音，帮助用户掌握正确读音。音频文件会被智能缓存到本地，提高加载速度。
*   **视觉记忆强化**：利用 ComfyUI 强大的图像生成能力，根据当前学习的单词动态生成相关图像，通过视觉刺激加深记忆。支持自定义 ComfyUI 工作流和服务器设置，并对生成的图像进行本地缓存。
*   **灵活的词典管理**：支持加载 `data` 目录下多种 JSON 格式的词典文件，并可通过 `data/字典.ts` 元数据文件为词典提供友好的中文描述，方便用户选择和管理。
*   **学习进度控制**：用户可以自由选择词典，并从任意单词索引开始学习，支持会话重启和词典切换。

## 🚀 快速开始

### 1. 克隆仓库

```bash
git clone https://github.com/kungful/VocabTypeAI.git
cd VocabTypeAI
```

### 2. 安装依赖

确保您已安装 Python 3.8+。然后安装所需的 Python 库：

```bash
pip install -r requirements.txt
```

### 3. 准备 ComfyUI (可选，但强烈推荐)

为了使用图像生成功能，您需要运行一个 ComfyUI 服务器。
*   **下载 ComfyUI**: 访问 [ComfyUI GitHub 仓库](https://github.com/comfyanonymous/ComfyUI) 并按照其说明进行安装。
*   **启动 ComfyUI 服务器**: 通常通过运行 `python main.py` 来启动。确保 ComfyUI 服务器在可访问的地址和端口上运行（例如 `http://127.0.0.1:8188`）。
*   **放置工作流文件**: 将您希望使用的 ComfyUI 工作流 JSON 文件放置在 `websocket_simple_comfyui/` 目录下。本项目默认使用 `websocket_simple_comfyui/` 目录下的第一个 JSON 文件。
    *   **重要提示**: 确保您的工作流包含一个 `GeminiFlash` 节点（用于接收单词作为 `Additional_Context`）和一个 `SaveImageWebsocket` 类型的节点（用于输出图像）。如果工作流包含 `Hua_gradio_Seed` 节点，脚本将自动为其填入随机种子。

### 4. 准备词典数据

将您的 JSON 格式词典文件放置在 `data/` 目录下。
*   **词典格式**: 每个 JSON 文件应是一个数组，其中每个元素是一个单词对象，至少包含 `name` (单词), `trans` (翻译，可以是字符串数组), `usphone` (美式音标) 等字段。
    ```json
    [
      {
        "name": "apple",
        "trans": ["苹果"],
        "usphone": "ˈæpl"
      },
      {
        "name": "banana",
        "trans": ["香蕉"],
        "usphone": "bəˈnænə"
      }
    ]
    ```
*   **词典元数据 (可选)**: 您可以编辑 `data/字典.ts` 文件来为您的词典文件提供更友好的中文描述。例如：
    ```typescript
    export const DICTIONARIES = [
      { description: '雅思词汇圣经', url: 'IELTSVocabularyBible.json' },
      { description: '大学英语四级', url: 'CET4_T.json' },
      // 更多词典...
    ];
    ```

### 5. 运行应用程序

```bash
python gradioqwerty.py
```

应用程序将在您的浏览器中打开一个 Gradio 界面。

## 📺 项目演示

<!-- 注意：GitHub 的 Markdown 渲染器对直接嵌入视频的支持有限。如果视频无法播放，建议将其上传到 YouTube/Bilibili 等平台，然后在此处嵌入链接，或将视频转换为 GIF 格式。 -->
<video src="https://raw.githubusercontent.com/kungful/VocabTypeAI/7df52ff12e466555ba46e8cc235c21775ff11f7e/new_logic/Example.mp4" controls muted loop style="max-width: 100%; height: auto;">
  您的浏览器不支持视频播放。请点击 <a href="https://raw.githubusercontent.com/kungful/VocabTypeAI/7df52ff12e466555ba46e8cc235c21775ff11f7e/new_logic/Example.mp4">这里</a> 下载视频。
</video>

## ⚙️ ComfyUI 设置

在 Gradio 界面的 "ComfyUI 设置" 标签页中，您可以配置以下参数：

*   **ComfyUI 服务器地址**：您的 ComfyUI 服务器运行的地址（例如 `127.0.0.1:8188` 或 `https://your-domain.com/comfyui`）。
*   **选择工作流 JSON 文件**：从 `websocket_simple_comfyui/` 目录中选择一个 ComfyUI 工作流文件。
*   **SaveImageWebsocket 节点ID (可选)**：如果您想指定一个特定的 `SaveImageWebsocket` 节点来接收图像，可以在此输入其 ID。留空则自动检测。

## 📚 词典数据格式

您的词典 JSON 文件应遵循以下结构：

```json
[
  {
    "name": "word_name_1",
    "trans": ["translation_1a", "translation_1b"],
    "usphone": "us_phonetic_1",
    "ukphone": "uk_phonetic_1"
  },
  {
    "name": "word_name_2",
    "trans": ["translation_2a"],
    "usphone": "us_phonetic_2"
  }
  // ... 更多单词对象
]
```
其中：
*   `name` (字符串): 单词本身 (必填)。
*   `trans` (字符串数组): 单词的中文翻译或解释 (必填)。
*   `usphone` (字符串): 美式音标 (可选)。
*   `ukphone` (字符串): 英式音标 (可选)。

## 🤝 贡献

欢迎任何形式的贡献！如果您有任何建议、错误报告或功能请求，请随时提交 Issue 或 Pull Request。

## 📄 许可证

本项目采用 MIT 许可证。详见 `LICENSE` 文件 (如果存在)。
