/**
 * MemoryApprovalStore - 内存审批存储（测试 / 嵌入式场景）
 *
 * 与 FileApprovalStore 同契约：未决集合 + 审计记录；
 * 进程内有效，不做持久化。
 */
import type { ApprovalAuditRecord, ApprovalStore, StoredApproval } from '../core';

export class MemoryApprovalStore implements ApprovalStore {
  private readonly _pending = new Map<string, StoredApproval>();
  private readonly _audit: ApprovalAuditRecord[] = [];

  async load(): Promise<StoredApproval[]> {
    return [...this._pending.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  async save(stored: StoredApproval): Promise<void> {
    this._pending.set(stored.id, stored);
  }

  async settle(id: string, record: ApprovalAuditRecord): Promise<void> {
    this._pending.delete(id);
    this._audit.push(record);
  }

  /** 已结算审计记录（测试断言用） */
  auditRecords(): readonly ApprovalAuditRecord[] {
    return this._audit;
  }
}
