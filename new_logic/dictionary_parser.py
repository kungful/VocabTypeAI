import json
import os

def get_dictionary_names(file_path="data/字典名字汉化.txt"):
    """
    读取字典名字汉化文件，并返回一个字典，
    其中键是字典的url（文件名），值是对应的description（汉化名称）。
    """
    dictionary_names = {}
    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            data = json.load(f)
            for item in data:
                if 'url' in item and 'description' in item:
                    # 确保url是文件名，不包含路径
                    file_name = os.path.basename(item['url'])
                    dictionary_names[file_name] = item['description']
    except FileNotFoundError:
        print(f"错误: 文件未找到 - {file_path}")
    except json.JSONDecodeError:
        print(f"错误: 无法解析JSON文件 - {file_path}")
    return dictionary_names

if __name__ == '__main__':
    # 示例用法
    names = get_dictionary_names()
    for url, description in names.items():
        print(f"URL: {url}, Description: {description}")
