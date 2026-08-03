/**
 * 诊断工具 — 用于在 AssistantMessage 中记录结构化的诊断信息
 */

import type { AssistantMessage } from './types';

// ─── 类型 ──────────────────────────────────────────────────────────

export interface DiagnosticError {
  name?: string;
  message: string;
  stack?: string;
  code?: string | number;
}

export interface DiagnosticRecord {
  type: string;
  timestamp: number;
  error: DiagnosticError;
  details?: unknown;
}

// ─── 格式化 ────────────────────────────────────────────────────────

function formatThrownValue(value: unknown): string {
  if (value instanceof Error) return value.message || value.name;
  if (typeof value === 'string') return value;
  return String(value);
}

// ─── 提取 ──────────────────────────────────────────────────────────

export function extractDiagnosticError(error: unknown): DiagnosticError {
  if (!(error instanceof Error)) {
    return { name: 'ThrownValue', message: formatThrownValue(error) };
  }
  const code = (error as any).code;
  return {
    name: error.name || undefined,
    message: error.message || error.name,
    stack: error.stack,
    code: typeof code === 'string' || typeof code === 'number' ? code : undefined,
  };
}

// ─── 创建与追加 ────────────────────────────────────────────────────

export function createDiagnostic(
  type: string,
  error: unknown,
  details?: unknown,
): DiagnosticRecord {
  return {
    type,
    timestamp: Date.now(),
    error: extractDiagnosticError(error),
    details,
  };
}

export function appendDiagnostic(
  message: AssistantMessage,
  diagnostic: DiagnosticRecord,
): void {
  const diags = (message as any).diagnostics ?? [];
  diags.push(diagnostic);
  (message as any).diagnostics = diags;
}
