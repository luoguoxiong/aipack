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
export { ensureToolPairing, countOrphanedPairs } from './pairing';
export { createTransitionMessage } from './transition';
