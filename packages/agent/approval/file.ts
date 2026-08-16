/**
 * FileApprovalStore - 审批单文件持久化（Phase 2）
 *
 * 布局（默认 ~/.aipack/approvals/，与 sessions/ 平级）：
 * - <id>.json      未决审批单（temp + rename 原子写；结算即删除）
 * - history.jsonl  结算审计记录（每行一条 ApprovalAuditRecord，追加写）
 * - <id>.corrupt   损坏文件隔离（load 时改名保留现场，不阻塞恢复）
 *
 * 与 FileSessionStorage 同风格：原子写防半截文件、损坏隔离防单文件拖垮全局。
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ApprovalAuditRecord, ApprovalStore, StoredApproval } from '../core';

export interface FileApprovalStoreOptions {
  /** 审批单目录（默认 ~/.aipack/approvals） */
  baseDir?: string;
}

export function defaultApprovalDir(): string {
  return path.join(os.homedir(), '.aipack', 'approvals');
}

/** 校验反序列化结果的基本字段（损坏 / 篡改文件防御） */
function isValidStored(value: unknown): value is StoredApproval {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    v.id.length > 0 &&
    typeof v.toolName === 'string' &&
    Array.isArray(v.permissions) &&
    typeof v.createdAt === 'number' &&
    typeof v.sessionKey === 'string'
  );
}

export class FileApprovalStore implements ApprovalStore {
  private readonly _baseDir: string;

  constructor(options: FileApprovalStoreOptions = {}) {
    this._baseDir = options.baseDir ?? defaultApprovalDir();
  }

  private _approvalPath(id: string): string {
    // id 由框架生成（apr_xxx），仍做白名单防御防路径穿越
    const safeId = id.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this._baseDir, `${safeId}.json`);
  }

  private get _historyPath(): string {
    return path.join(this._baseDir, 'history.jsonl');
  }

  async load(): Promise<StoredApproval[]> {
    let files: string[];
    try {
      files = await fs.readdir(this._baseDir);
    } catch {
      return []; // 目录不存在 = 无未决审批单
    }

    const results: StoredApproval[] = [];
    for (const file of files) {
      if (!file.endsWith('.json')) continue; // 跳过 history.jsonl / .corrupt / .tmp
      const fullPath = path.join(this._baseDir, file);
      try {
        const raw = await fs.readFile(fullPath, 'utf8');
        const parsed: unknown = JSON.parse(raw);
        if (isValidStored(parsed)) {
          results.push(parsed);
        } else {
          await fs.rename(fullPath, `${fullPath}.corrupt`).catch(() => undefined);
          console.warn(`[approval] invalid stored approval, quarantined: ${file}`);
        }
      } catch (err) {
        await fs.rename(fullPath, `${fullPath}.corrupt`).catch(() => undefined);
        console.warn(`[approval] failed to load ${file}, quarantined:`, err);
      }
    }
    // 创建时间升序：恢复后超时结算顺序与创建顺序一致
    return results.sort((a, b) => a.createdAt - b.createdAt);
  }

  async save(stored: StoredApproval): Promise<void> {
    await fs.mkdir(this._baseDir, { recursive: true });
    const target = this._approvalPath(stored.id);
    const tmp = `${target}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(stored, null, 2), 'utf8');
    await fs.rename(tmp, target);
  }

  async settle(id: string, record: ApprovalAuditRecord): Promise<void> {
    // 未决文件不存在（已结算 / 从未保存）视为幂等成功
    await fs.rm(this._approvalPath(id), { force: true });
    await fs.mkdir(this._baseDir, { recursive: true });
    await fs.appendFile(this._historyPath, `${JSON.stringify(record)}\n`, 'utf8');
  }
}
