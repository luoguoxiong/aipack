/**
 * 初始消息组装：位置参数消息 + @file 引用 + 管道 stdin
 */
import fs from 'node:fs/promises';
import path from 'node:path';

/** 判定文件是否为图片（走 Request.media 通道） */
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);

/** @文本文件 内容上限（字符），超出截断（避免大文件撑爆上下文） */
const MAX_TEXT_CHARS = 200_000;

/** 图片大小上限（字节） */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** 扩展名 → MIME 子类型（jpg 的正确 MIME 是 jpeg） */
function imageMimeSubtype(ext: string): string {
  return ext === '.jpg' ? 'jpeg' : ext.slice(1);
}

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
        if (buf.length > MAX_IMAGE_BYTES) {
          parts.push(`[文件 ${file} 超过图片大小上限（${(buf.length / 1024 / 1024).toFixed(1)}MB > 10MB），已跳过]`);
          continue;
        }
        media.push(`data:image/${imageMimeSubtype(ext)};base64,${buf.toString('base64')}`);
      } else {
        let content = await fs.readFile(abs, 'utf8');
        if (content.length > MAX_TEXT_CHARS) {
          content = content.slice(0, MAX_TEXT_CHARS) + `\n...[截断，共 ${content.length} 字符]`;
        }
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

/**
 * 从 REPL 输入行中提取 @文件 引用（词首 @，前为行首或空白）。
 * 返回剥离引用后的文本与文件列表；无引用时 files 为空（不做任何 IO）。
 */
export function extractFileRefs(line: string): { text: string; files: string[] } {
  const files: string[] = [];
  if (!line.includes('@')) return { text: line, files };
  // 仅匹配行首或空白后的 @token（避免误吞 email、@scope/pkg 等）
  const re = /(^|\s)@([^\s]+)/g;
  const stripped = line.replace(re, (_m, lead: string, ref: string) => {
    files.push(ref);
    return lead;
  });
  // 有引用时返回剥离后的文本（纯附件行为空串）；无引用时原样返回（如 email 地址）
  return { text: files.length > 0 ? stripped.trim() : line, files };
}
