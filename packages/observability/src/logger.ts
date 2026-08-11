/**
 * 结构化 logger（P1-1 日志关联）。
 *
 * 约定：logfmt 或 JSON 输出，可通过 context() 动态注入当前上下文（如 traceId），
 * 使应用日志与 Trace 关联（排障时按 traceId 检索日志流）。
 *
 *   const logger = createLogger({ format: 'logfmt', context: () => telemetry.currentContext() });
 *   logger.info('tool called', { tool: 'search_flights', durationMs: 120 });
 *   // => time=2026-08-11T10:00:00.000Z level=info msg="tool called" tool=search_flights durationMs=120
 *
 * 与收集服务 webhook/告警日志不同：本 logger 只负责"应用日志"输出约定，
 * 不参与上报（上报走 telemetry）。
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFormat = 'logfmt' | 'json';

export interface LoggerOptions {
  /** 输出格式，默认 logfmt */
  format?: LogFormat;
  /** 最低输出级别，默认 info */
  level?: LogLevel;
  /** 每行日志的固定字段（如 service/app），会被动态 context / 单行 fields 覆盖 */
  tags?: Record<string, unknown>;
  /** 动态上下文（每行调用），例如 () => telemetry.currentContext() 注入 traceId */
  context?: () => Record<string, unknown> | undefined;
  /** 输出目标，默认 console（line 已含换行） */
  dest?: (line: string) => void;
  /** 是否注入 ISO 时间戳字段 time，默认 true */
  timestamps?: boolean;
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  /** 派生子 logger：合并部分配置（如固定业务标签） */
  child(overrides: Partial<LoggerOptions>): Logger;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** 隐藏敏感字段名（值以 *** 代替），防止 token/key 明文进日志 */
const REDACTED_KEYS = /(secret|token|password|key|authorization|apikey)/i;

export function createLogger(opts: LoggerOptions = {}): Logger {
  const { format = 'logfmt', dest = defaultDest } = opts;
  const minLevel = LEVEL_ORDER[opts.level ?? 'info'];
  const timestamps = opts.timestamps ?? true;

  const emit = (level: LogLevel, msg: string, fields?: Record<string, unknown>): void => {
    if (LEVEL_ORDER[level] < minLevel) return;
    const context = opts.context?.() ?? {};
    dest(formatLine({ format, level, msg, fields, context, tags: opts.tags, timestamps }));
  };

  return {
    debug: (msg, fields) => emit('debug', msg, fields),
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
    child: (overrides) =>
      createLogger({
        format: overrides.format ?? opts.format,
        level: overrides.level ?? opts.level,
        tags: { ...opts.tags, ...overrides.tags },
        context: overrides.context ?? opts.context,
        dest: overrides.dest ?? opts.dest,
        timestamps: overrides.timestamps ?? opts.timestamps,
      }),
  };
}

interface FormatInput {
  format: LogFormat;
  level: LogLevel;
  msg: string;
  fields?: Record<string, unknown>;
  context?: Record<string, unknown>;
  tags?: Record<string, unknown>;
  timestamps: boolean;
}

function formatLine(input: FormatInput): string {
  const data: Record<string, unknown> = {};
  if (input.timestamps) data.time = new Date().toISOString();
  data.level = input.level;
  data.msg = input.msg;
  // 顺序：tags → context → fields（后者覆盖前者）
  for (const src of [input.tags, input.context, input.fields]) {
    if (!src) continue;
    for (const [k, v] of Object.entries(src)) {
      data[k] = REDACTED_KEYS.test(k) ? '***' : v;
    }
  }
  return input.format === 'json' ? JSON.stringify(data) : toLogfmt(data);
}

/** logfmt 渲染：值含空白/引号/等号/反斜杠时按 RFC 引号包裹并转义 */
function toLogfmt(data: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined || v === null) continue;
    parts.push(`${k}=${logfmtValue(v)}`);
  }
  return parts.join(' ');
}

function logfmtValue(v: unknown): string {
  if (typeof v === 'string') return quoteLogfmt(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'bigint') return v.toString();
  // 对象/数组 → JSON 序列化后引号包裹
  return quoteLogfmt(JSON.stringify(v));
}

function quoteLogfmt(s: string): string {
  if (!/[ \t"=\\]/u.test(s)) return s;
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"';
}

function defaultDest(line: string): void {
  // 走 console.log 而非 process.stdout.write，便于宿主拦截/重定向
  console.log(line);
}
