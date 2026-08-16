/**
 * 初始消息组装：位置参数消息 + @file 引用 + 管道 stdin
 */
import fs from 'node:fs/promises';
import path from 'node:path';

/** 判定文件是否为图片（走 Request.media 通道） */
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);

export interface InitialMessage {
  /** 文本消息（拼接 @文本文件 与管道内容） */
  text: string;
  /** 图片附件（base64） */
  media: string[];
}

export async function buildInitialMessage(
  messages: string[],
  fileArgs: string[],
  stdinText: string | undefined,
): Promise<InitialMessage> {
  const parts: string[] = [];
  const media: string[] = [];

  for (const file of fileArgs) {
    const abs = path.resolve(process.cwd(), file);
    const ext = path.extname(abs).toLowerCase();
    try {
      if (IMAGE_EXT.has(ext)) {
        const buf = await fs.readFile(abs);
        media.push(`data:image/${ext.slice(1)};base64,${buf.toString('base64')}`);
      } else {
        const content = await fs.readFile(abs, 'utf8');
        parts.push(`--- 文件: ${file} ---\n${content}\n--- 结束 ---`);
      }
    } catch (err) {
      parts.push(`[文件 ${file} 读取失败: ${err instanceof Error ? err.message : err}]`);
    }
  }

  if (stdinText && stdinText.trim()) {
    parts.push(`--- stdin ---\n${stdinText.trim()}\n--- 结束 ---`);
  }

  if (messages.length > 0) {
    parts.unshift(messages.join('\n'));
  }

  return { text: parts.join('\n\n'), media };
}
