/**
 * 审批持久化（Phase 2）：ApprovalStore 契约实现
 *
 * - FileApprovalStore：文件持久化（未决 <id>.json + history.jsonl 审计）
 * - MemoryApprovalStore：内存实现（测试 / 嵌入式）
 *
 * 契约（ApprovalStore）与转换（toStoredApproval / fromStoredApproval）见 core/permission.ts
 */
export { FileApprovalStore, defaultApprovalDir } from './file';
export type { FileApprovalStoreOptions } from './file';
export { MemoryApprovalStore } from './memory';
