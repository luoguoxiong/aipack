/**
 * 可观测性模块
 *
 * - Metrics: 指标收集器
 *   记录压缩历史、token 节省量、各级别统计、健康检查历史等
 */

export { Metrics } from './metrics';
export type { MetricsSnapshot, CompressionRecord } from './metrics';
