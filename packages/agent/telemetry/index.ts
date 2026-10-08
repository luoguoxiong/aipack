/**
 * packages/telemetry - 轻量可观测性
 *
 * 契约（类型 + Telemetry 接口 + noopTelemetry）已下沉至 core/telemetry.ts，
 * 本文件保持深路径导入兼容（`../telemetry` / `../telemetry/index.ts`）的 re-export 壳。
 * 依赖方向：telemetry → core（单向），不再有 core ↔ telemetry 循环依赖。
 */

export * from '../core/telemetry';
