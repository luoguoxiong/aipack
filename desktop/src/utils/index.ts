import { message } from 'antd';
export function copyTextToClipboard(text) {
  const textarea = document.createElement('textarea');
  textarea.value = text;

  document.body.appendChild(textarea);

  textarea.select();
  document.execCommand('copy');

  document.body.removeChild(textarea);
  message.success('已复制');
}
