/**
 * HttpReporter — 把批量事件上报到收集服务（埋点模式）。
 *
 * - POST {endpoint}/api/v1/ingest，携带 x-app-id / x-app-secret 鉴权头
 * - 上报失败（网络错误 / 5xx / 429）→ 写入本地缓存文件（{cacheDir}/{appId}.json），
 *   下次 send 前先补报缓存，全部成功才删除
 * - 4xx（鉴权失败、参数错误）判定为不可重试，直接丢弃并 warn，避免缓存无限重试
 * - 缓存条数上限 maxCacheSize，超出后丢弃最旧记录
 * - 并发保护：send 串行执行，重复调用合并为一次
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { EventBatch } from './types';

export interface ReporterOptions {
  /** 收集服务地址，如 http://localhost:8787（必填） */
  endpoint: string;
  appId: string;
  appSecret: string;
  /** 缓存目录，默认 ./.aipack/observability */
  cacheDir?: string;
  /** 缓存条数上限（含 runs/spans/toolCalls/permissions），默认 2000 */
  maxCacheSize?: number;
  /** 上报超时（ms），默认 5000 */
  timeoutMs?: number;
  /** 便于测试注入；默认全局 fetch */
  fetchImpl?: typeof fetch;
}

const EMPTY_BATCH = (): EventBatch => ({ runs: [], spans: [], toolCalls: [], permissions: [] });

export class HttpReporter {
  private endpoint: string;
  private appId: string;
  private appSecret: string;
  private cachePath: string;
  private maxCacheSize: number;
  private timeoutMs: number;
  private fetchImpl: typeof fetch;
  /** 串行发送锁：true 表示有发送在进行中 */
  private sending = false;
  /** 发送期间新到的批次，发送完成后继续补发 */
  private pending: EventBatch[] = [];

  constructor(opts: ReporterOptions) {
    this.endpoint = opts.endpoint.replace(/\/+$/, '');
    this.appId = opts.appId;
    this.appSecret = opts.appSecret;
    this.cachePath = path.join(
      opts.cacheDir ?? path.join(process.cwd(), '.aipack', 'observability'),
      `${opts.appId}.json`,
    );
    this.maxCacheSize = opts.maxCacheSize ?? 2000;
    this.timeoutMs = opts.timeoutMs ?? 5000;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  }

  /** 上报批次；失败自动落缓存，返回是否成功（测试断言用） */
  async send(batch: EventBatch): Promise<boolean> {
    this.pending.push(batch);
    if (this.sending) return false; // 已有一轮发送在跑，数据会被顺带带走
    this.sending = true;
    try {
      return await this.drain();
    } finally {
      this.sending = false;
    }
  }

  /** 排空所有批次（含缓存补报）。返回最后一轮是否成功 */
  private async drain(): Promise<boolean> {
    let lastOk = false;
    for (;;) {
      const cache = await this.readCache();
      const batch = mergeBatches(cache, ...this.pending);
      this.pending = [];
      if (isEmpty(batch)) return lastOk;

      lastOk = await this.tryUpload(batch);
      if (!lastOk) {
        // 失败 → 写回缓存，等待下次 flush
        await this.writeCache(batch);
        return false;
      }
      // 成功 → 清缓存
      await this.removeCache();
    }
  }

  /** 尝试上报；返回是否成功（4xx 视为最终失败，不再重试） */
  private async tryUpload(batch: EventBatch): Promise<boolean> {
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), this.timeoutMs);
      try {
        const res = await this.fetchImpl(`${this.endpoint}/api/v1/ingest`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-app-id': this.appId,
            'x-app-secret': this.appSecret,
          },
          body: JSON.stringify({ appId: this.appId, ...batch }),
          signal: ac.signal,
        });
        if (res.ok) return true;
        if (res.status >= 400 && res.status < 500 && res.status !== 429) {
          // 鉴权/参数错误：重试无意义，丢弃
          console.warn(
            `[aipack/observability] 上报被拒绝(${res.status})，丢弃 ${count(batch)} 条。检查 appId/appSecret 与 endpoint。`,
          );
          return true; // 视为已处理（丢弃），不再缓存
        }
        // 5xx / 429：可重试
        console.warn(`[aipack/observability] 上报失败(${res.status})，将缓存补报。`);
        return false;
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      // 网络错误 / 超时：可重试
      console.warn('[aipack/observability] 上报网络错误，将缓存补报:', (err as Error).message);
      return false;
    }
  }

  // ─── 本地缓存 ──────────────────────────────────────────────────

  private async readCache(): Promise<EventBatch> {
    try {
      const raw = await fs.readFile(this.cachePath, 'utf8');
      const parsed = JSON.parse(raw) as EventBatch;
      return {
        runs: Array.isArray(parsed.runs) ? parsed.runs : [],
        spans: Array.isArray(parsed.spans) ? parsed.spans : [],
        toolCalls: Array.isArray(parsed.toolCalls) ? parsed.toolCalls : [],
        permissions: Array.isArray(parsed.permissions) ? parsed.permissions : [],
      };
    } catch {
      return EMPTY_BATCH();
    }
  }

  private async writeCache(batch: EventBatch): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.cachePath), { recursive: true });
      await fs.writeFile(this.cachePath, JSON.stringify(trimBatch(batch, this.maxCacheSize)), 'utf8');
    } catch (err) {
      console.warn('[aipack/observability] 缓存写入失败（数据丢弃）:', (err as Error).message);
    }
  }

  private async removeCache(): Promise<void> {
    try {
      await fs.unlink(this.cachePath);
    } catch {
      // 无缓存文件属正常
    }
  }
}

// ─── 工具 ─────────────────────────────────────────────────────────

function isEmpty(batch: EventBatch): boolean {
  return !batch.runs.length && !batch.spans.length && !batch.toolCalls.length && !batch.permissions.length;
}

function count(batch: EventBatch): number {
  return batch.runs.length + batch.spans.length + batch.toolCalls.length + batch.permissions.length;
}

function mergeBatches(...batches: EventBatch[]): EventBatch {
  const out = EMPTY_BATCH();
  for (const b of batches) {
    out.runs.push(...b.runs);
    out.spans.push(...b.spans);
    out.toolCalls.push(...b.toolCalls);
    out.permissions.push(...b.permissions);
  }
  return out;
}

/** 超过上限时按 runs → spans → toolCalls → permissions 顺序从头部裁剪（保留最新） */
function trimBatch(batch: EventBatch, max: number): EventBatch {
  const total = count(batch);
  if (total <= max) return batch;
  let excess = total - max;
  const out = { ...batch, runs: [...batch.runs], spans: [...batch.spans], toolCalls: [...batch.toolCalls], permissions: [...batch.permissions] };
  for (const key of ['runs', 'spans', 'toolCalls', 'permissions'] as const) {
    if (excess <= 0) break;
    const removed = Math.min(out[key].length, excess);
    out[key].splice(0, removed);
    excess -= removed;
  }
  return out;
}
