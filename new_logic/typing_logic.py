import gradio as gr
import time

def process_typing_with_clear(user_input_text, current_word_data, start_time):
    """
    处理用户输入，并在单词正确完成后清除输入框。
    """
    if not current_word_data:
        # 如果没有加载单词，或者词典已完成，返回空状态
        # 返回 8 个值，包括清除输入框的更新
        return "", "", "", "0.00 WPM", "0.00%", [], gr.update(visible=True), ""

    target_word = current_word_data['name']

    # 在第一个字符输入时启动计时器
    if not start_time and user_input_text:
        start_time = time.time()

    correct_chars = 0
    highlight_data = [] # 用于 gr.HighlightedText 的数据
    colored_word_html = "" # 用于 word_and_details_display 的带颜色 HTML

    len_target = len(target_word)
    len_input = len(user_input_text)

    # 构建用于高亮显示的样式目标文本 (for highlighted_output_display)
    for i in range(len_target):
        if i < len_input:
            user_char = user_input_text[i].lower() # 转换为小写进行比较
            target_char = target_word[i].lower() # 转换为小写进行比较
            if user_char == target_char:
                correct_chars += 1
                highlight_data.append((target_word[i], "correct")) # 原始字符用于显示
                colored_word_html += f"<span style='color: #39FF14;'>{target_word[i]}</span>" # 高亮绿
            else:
                highlight_data.append((target_word[i], "incorrect")) # 原始字符用于显示
                colored_word_html += f"<span style='color: red;'>{target_word[i]}</span>" # 红色
        else:
            highlight_data.append((target_word[i], "untyped"))
            colored_word_html += f"<span style='color: grey;'>{target_word[i]}</span>" # 灰色

    # 如果用户输入了额外字符 (for highlighted_output_display)
    if len_input > len_target:
        for i in range(len_target, len_input):
            highlight_data.append((user_input_text[i], "extra"))
            # 对于额外字符，目标单词显示不需要额外字符，所以这里不添加到 colored_word_html

    # 包装 colored_word_html 到 word_and_details_display 的结构中
    word_html_content = f"""
        <div style='font-size: 4em; text-align: center; font-weight: bold;'>{colored_word_html}</div>
        <div style='font-size: 1.5em; text-align: center; margin-top: 10px;'>/{current_word_data.get('usphone', '')}/</div>
        <div style='font-size: 1.2em; text-align: center; margin-top: 10px;'>{"<br>".join(current_word_data['trans'])}</div>
    """

    # WPM 计算
    wpm_val = 0.0
    if start_time and user_input_text:
        elapsed_time_seconds = time.time() - start_time
        if elapsed_time_seconds > 0:
            words_equivalent = len(user_input_text) / 5
            minutes = elapsed_time_seconds / 60
            wpm_val = round(words_equivalent / minutes if minutes > 0 else 0, 2)

    # 准确率计算 (不区分大小写)
    accuracy_val = 0.0
    if len_input > 0:
        relevant_typed_length = min(len_input, len_target)
        if relevant_typed_length > 0:
            correct_up_to_target = 0
            for k in range(min(len_input, len_target)):
                if user_input_text[k].lower() == target_word[k].lower(): # 不区分大小写比较
                    correct_up_to_target +=1
            accuracy_val = round((correct_up_to_target / relevant_typed_length) * 100, 2)
        elif len_target == 0 :
            accuracy_val = 100.0
        else:
            accuracy_val = 0.0
    elif len_target > 0 :
         accuracy_val = 0.0
    else:
         accuracy_val = 100.0

    # 检查单词是否正确完成 (不区分大小写)
    if user_input_text.lower() == target_word.lower(): # 不区分大小写比较
        return_input_clear = "" # 清除输入框
        return word_html_content, gr.update(), gr.update(), f"{wpm_val:.2f} WPM", f"{accuracy_val:.2f}%", highlight_data, gr.update(visible=False), return_input_clear
    else:
        # 单词尚未完成，但如果输入错误，则清空输入框
        should_clear_input = False
        # 判断是否输入错误：如果输入长度大于目标单词长度，或者输入的前缀与目标单词不匹配 (不区分大小写)
        if len_input > 0 and (len_input > len_target or user_input_text.lower() != target_word[:len_input].lower()): # 不区分大小写比较
            should_clear_input = True

        return_input_clear = "" if should_clear_input else gr.update()

        # 如果需要清空输入框，同时重置单词上色为灰色
        if should_clear_input:
            reset_colored_word_html = ""
            for char in target_word:
                reset_colored_word_html += f"<span style='color: white;'>{char}</span>" # 改为白色
            word_html_content = f"""
                <div style='font-size: 4em; text-align: center; font-weight: bold;'>{reset_colored_word_html}</div>
                <div style='font-size: 1.5em; text-align: center; margin-top: 10px;'>/{current_word_data.get('usphone', '')}/</div>
                <div style='font-size: 1.2em; text-align: center; margin-top: 10px;'>{"<br>".join(current_word_data['trans'])}</div>
            """
            highlight_data = [(char, "untyped") for char in target_word] # 确保HighlightedText也重置

        return word_html_content, gr.update(), gr.update(), f"{wpm_val:.2f} WPM", f"{accuracy_val:.2f}%", highlight_data, gr.update(visible=False), return_input_clear
