/**
 * 观察者模块
 *
 * - WorkspaceObserver: 工作区观察者
 *   基于 Git 状态获取工作区真实变更，支持防抖检查和工具推断降级
 */

export { WorkspaceObserver } from './workspace-observer';
