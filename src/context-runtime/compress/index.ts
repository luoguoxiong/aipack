/**
 * 压缩策略模块
 *
 * 五级压缩策略：
 * - L1 Clean: 无损清理（去重、移除空消息、工具摘要）
 * - L2 Window: 窗口化（锚点 + 滑动窗口）
 * - L3 Collapse: 折叠（折叠失败尝试、合并重复读取）
 * - L4 Snapshot: 快照重写（基于状态重建上下文）
 * - L5 Emergency: 紧急压缩（只保留最小状态 + 最近消息）
 *
 * 辅助模块：
 * - pairing: 工具配对完整性保证
 * - transition: 压缩过渡消息
 */

export { runL1Clean } from './l1-clean';
export type { L1CleanResult } from './l1-clean';
export { runL2Window } from './l2-window';
export type { L2WindowResult } from './l2-window';
export { runL3Collapse } from './l3-collapse';
export type { L3CollapseResult } from './l3-collapse';
export { runL4Snapshot } from './l4-snapshot';
export type { L4SnapshotResult } from './l4-snapshot';
export { runL5Emergency } from './l5-emergency';
export type { L5EmergencyResult } from './l5-emergency';
export { ensureToolPairing, countOrphanedPairs } from './pairing';
export { createTransitionMessage } from './transition';
