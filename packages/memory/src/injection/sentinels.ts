/**
 * 注入哨兵（sentinel）：在 user 消息内容中包裹记忆块。
 *
 * 为何用 sentinel 而非 resource.meta：
 *   aipack 的 messageToResource/resourceToMessage 对 user 消息不保留 meta
 *   （context-resource/index.ts:30-38, 112-119）。sentinel 是 content 的一部分，
 *   随消息持久化，下一轮 messagesToResources 重建后仍可在 content 文本中识别并剥离。
 */

import type { MemorySearchResult } from '../types';

export const MEMORY_BLOCK_START = '<<<AIPACK_MEMORY>>>';
export const MEMORY_BLOCK_END = '<<</AIPACK_MEMORY>>>';

/** 剥离 sentinel 包裹块（含其后的多余空行），返回干净原文 */
export function stripMemoryBlock(text: string): string {
  if (!text) return text;
  // 匹配 START ... END（非贪婪）及紧随其后的空行
  const re = new RegExp(
    `${escapeRegex(MEMORY_BLOCK_START)}[\\s\\S]*?${escapeRegex(MEMORY_BLOCK_END)}\\s*`,
    'g',
  );
  return text.replace(re, '').trim();
}

/** 判断文本是否包含 sentinel 块 */
export function hasMemoryBlock(text: string): boolean {
  if (!text) return false;
  return text.includes(MEMORY_BLOCK_START);
}

/** 将若干行用 sentinel 包裹（含头尾换行，便于前插进 content） */
export function wrapMemoryBlock(lines: string[]): string {
  const body = lines.join('\n').trimEnd();
  return `${MEMORY_BLOCK_START}\n${body}\n${MEMORY_BLOCK_END}`;
}

/** 由检索结果构造可读的记忆块文本 */
export function buildMemoryBlock(results: MemorySearchResult[]): string {
  if (results.length === 0) return '';
  const lines = ['[Relevant memories]'];
  for (const r of results) {
    const score = r.score.toFixed(2);
    const content = r.entry.content.replace(/\s+/g, ' ').trim().slice(0, 500);
    lines.push(`- ${content} (score=${score}, id=${r.entry.id})`);
  }
  return wrapMemoryBlock(lines);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
