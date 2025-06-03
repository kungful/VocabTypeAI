import json
import os
import re

def load_dictionary_metadata(filepath="data/字典.ts"):
    """
    加载并解析 data/字典.ts 文件，返回一个从 url 到 description 的映射。
    """
    metadata = {}
    try:
        with open(filepath, "r", encoding="utf-8") as f:
            content = f.read()
            # 使用正则表达式匹配 description 和 url
            # 假设格式是 { description: '...', url: '...' },
            matches = re.findall(r"\{\s*description:\s*'(.*?)',\s*url:\s*'(.*?)',?\s*\},?", content)
            for desc, url in matches:
                metadata[url] = desc
    except FileNotFoundError:
        print(f"错误: 未找到文件 {filepath}")
    except Exception as e:
        print(f"加载或解析 {filepath} 时出错: {e}")
    return metadata

def get_translated_dictionary_names(dictionary_filenames, metadata):
    """
    根据词典文件名列表和元数据，返回一个包含中文描述的列表。
    如果找不到对应的中文描述，则使用原始文件名。
    """
    translated_names = []
    for filename in dictionary_filenames:
        translated_name = metadata.get(filename, filename)
        translated_names.append(translated_name)
    return translated_names

def get_filename_to_description_map(metadata):
    """
    返回一个从中文描述到文件名的映射，用于 Gradio Dropdown 的 value 匹配。
    """
    return {v: k for k, v in metadata.items()}

if __name__ == "__main__":
    # 示例用法
    metadata = load_dictionary_metadata()
    print("加载的词典元数据:")
    for url, desc in metadata.items():
        print(f"  URL: {url}, Description: {desc}")

    test_filenames = ["CET4_T.json", "NonExistent.json", "IELTS_3_T.json"]
    translated = get_translated_dictionary_names(test_filenames, metadata)
    print("\n翻译后的词典名称:")
    print(translated)

    filename_to_desc_map = get_filename_to_description_map(metadata)
    print("\n中文描述到文件名的映射:")
    print(filename_to_desc_map)
