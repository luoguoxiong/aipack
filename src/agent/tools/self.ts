import { BaseTool, ToolContext, ToolResult, createToolResult, createToolError } from './base.js';
import { z } from 'zod';
import { RuntimeState } from './runtime_state.js';
import { currentRequestContext } from './context.js';
import { logger } from '../../utils/logger.js';

const MyToolSchema = z.object({
  action: z.enum(['check', 'set']).describe('Action to perform'),
  key: z.string().optional().describe(
    'Dot-path for check/set. Examples: \'max_iterations\', \'workspace\', \'provider_retry_mode\'. ' +
    'Use \'request.channel\', \'request.chat_id\', or \'request.sender_id\' for current routing metadata. ' +
    'Use \'model_preset\' to switch named model presets. For check without key, shows all config values.',
  ),
  value: z.unknown().optional().describe(
    'New value (for set). Type must match target (int for max_iterations/context_window_tokens, str for model/model_preset).',
  ),
});

const BLOCKED = new Set([
  'bus', 'provider', 'runtime_resolver', '_running', 'tools',
  '_runtime_vars',
  'runner', 'sessions', 'consolidator',
  'dream', 'auto_compact', 'context', 'commands',
  '_mcp_servers', '_mcp_stacks', '_pending_queues',
  '_session_locks', '_active_tasks', '_background_tasks',
  'restrict_to_workspace', 'channels_config',
  '_concurrency_gate', '_unified_session', '_extra_hooks', '_hook_factories',
]);

const READ_ONLY = new Set([
  'subagents',
  '_current_iteration',
  'exec_config',
  'web_config',
  'workspace_sandbox',
  'request',
]);

const REQUEST_FIELDS = ['channel', 'chat_id', 'sender_id'];

const DENIED_ATTRS = new Set([
  '__class__', '__dict__', '__bases__', '__subclasses__', '__mro__',
  '__init__', '__new__', '__reduce__', '__getstate__', '__setstate__',
  '__del__', '__call__', '__getattr__', '__setattr__', '__delattr__',
  '__code__', '__globals__', 'func_globals', 'func_code',
  '__wrapped__', '__closure__',
]);

const SENSITIVE_NAMES = new Set([
  'api_key', 'secret', 'password', 'token', 'credential',
  'private_key', 'access_token', 'refresh_token', 'auth',
]);

interface RestrictedSpec {
  type: 'number' | 'string';
  min?: number;
  max?: number;
  min_len?: number;
}

const RESTRICTED: Record<string, RestrictedSpec> = {
  max_iterations: { type: 'number', min: 1, max: 100 },
  context_window_tokens: { type: 'number', min: 4096, max: 1000000 },
  model: { type: 'string', min_len: 1 },
};

const MAX_RUNTIME_KEYS = 64;
const MODEL_RUNTIME_FIELDS = new Set([
  'model',
  'model_preset',
  'context_window_tokens',
]);

function isSensitiveFieldName(name: string): boolean {
  const lowered = name.toLowerCase();
  if (SENSITIVE_NAMES.has(lowered)) return true;
  return lowered.split('_').some((part) => SENSITIVE_NAMES.has(part));
}

function hasRealAttr(obj: unknown, key: string): boolean {
  if (typeof obj === 'object' && obj !== null) {
    if (key in obj) return true;
  }
  return false;
}

export class MyTool extends BaseTool {
  name = 'my';
  description = (
    'Check and set your own runtime state.\n' +
    'Actions: check, set.\n' +
    '- check (no key): full config overview — start here.\n' +
    '- check (key): drill into a value. Dot-paths allowed ' +
    '(e.g. \'_last_usage.prompt_tokens\', \'web_config.enable\').\n' +
    '- set (key, value): change config or store notes in your scratchpad. ' +
    'Scratchpad keys persist across turns but not restarts.\n' +
    'Key values: _current_iteration (current progress), ' +
    'max_iterations - _current_iteration = remaining iterations.\n' +
    'Current routing metadata is available read-only via request.channel, ' +
    'request.chat_id, and request.sender_id.\n' +
    'Note: web_config and exec_config are readable but read-only.\n' +
    '\n' +
    'When to use:\n' +
    '- User asks about your model, settings, or token usage → check that key.\n' +
    '- User asks to switch to a named model preset → set model_preset to that preset name.\n' +
    '- A tool fails or behaves unexpectedly → check the related config to diagnose.\n' +
    '- User asks you to remember a preference for this session → set to store it in your scratchpad.\n' +
    '- About to start a large task → check context_window_tokens and max_iterations first.'
  );
  input_schema = MyToolSchema;
  tags = ['self', 'config'];
  scope = 'global';

  private _runtime_state: RuntimeState | null = null;
  private _modify_allowed: boolean;

  constructor(runtimeState?: RuntimeState, modifyAllowed = true) {
    super();
    this._runtime_state = runtimeState ?? null;
    this._modify_allowed = modifyAllowed;
  }

  setRuntimeState(state: RuntimeState): void {
    this._runtime_state = state;
  }

  private _audit(action: string, detail: string): void {
    const ctx = currentRequestContext();
    const session = ctx?.session_key
      ? ctx.session_key
      : ctx?.channel && ctx?.chat_id
        ? `${ctx.channel}:${ctx.chat_id}`
        : 'unknown';
    logger.info(`self.${action} | ${detail} | session:${session}`);
  }

  private _resolvePath(pathStr: string): { value: unknown; error: string | null } {
    const parts = pathStr.split('.');
    let obj: unknown = this._runtime_state;
    for (const part of parts) {
      if (DENIED_ATTRS.has(part) || part.startsWith('__')) {
        return { value: null, error: `'${part}' is not accessible` };
      }
      if (BLOCKED.has(part)) {
        return { value: null, error: `'${part}' is not accessible` };
      }
      if (isSensitiveFieldName(part)) {
        return { value: null, error: `'${part}' is not accessible` };
      }
      try {
        if (typeof obj === 'object' && obj !== null) {
          if (part in obj) {
            obj = (obj as Record<string, unknown>)[part];
          } else {
            return { value: null, error: `'${part}' not found in object` };
          }
        } else {
          return { value: null, error: `'${part}' not found` };
        }
      } catch (e) {
        return { value: null, error: `'${part}' not found: ${(e as Error).message}` };
      }
    }
    return { value: obj, error: null };
  }

  private static _validateKey(key: string | null | undefined): string | null {
    if (!key || !key.trim()) {
      return "Error: 'key' cannot be empty or whitespace";
    }
    return null;
  }

  private static _formatValue(val: unknown, key = ''): string {
    if (val === null || val === undefined) {
      return key ? `${key}: ${String(val)}` : String(val);
    }
    if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') {
      const r = JSON.stringify(val);
      return key ? `${key}: ${r}` : r;
    }
    if (Array.isArray(val)) {
      if (val.length > 20) {
        return key ? `${key}: [${val.length} items]` : `[${val.length} items]`;
      }
      const r = JSON.stringify(val);
      return key ? `${key}: ${r}` : r;
    }
    if (typeof val === 'object') {
      const keys = Object.keys(val as Record<string, unknown>);
      if (keys.length === 0) {
        return key ? `${key}: {}` : '{}';
      }
      if (keys.length <= 5) {
        const r = JSON.stringify(val);
        if (r.length <= 200) {
          return key ? `${key}: ${r}` : r;
        }
      }
      const preview = keys.slice(0, 15).join(', ');
      const suffix = keys.length > 15 ? ', ...' : '';
      return key ? `${key}: {${preview}${suffix}}` : `{${preview}${suffix}}`;
    }
    const r = String(val);
    return key ? `${key}: ${r}` : r;
  }

  async execute(args: unknown, _context: ToolContext): Promise<ToolResult> {
    try {
      const params = this.input_schema.parse(args);
      if (params.action === 'check') {
        return createToolResult(this._inspect(params.key));
      }
      if (!this._modify_allowed) {
        return createToolError('Error: set is disabled (tools.my.allow_set is false)');
      }
      if (params.action === 'set') {
        return createToolResult(this._modify(params.key, params.value));
      }
      return createToolResult(`Unknown action: ${params.action}`);
    } catch (e) {
      return createToolError(`Error: ${(e as Error).message}`);
    }
  }

  private _currentRuntimeValue(key: string): { found: boolean; value: unknown } {
    const requestCtx = currentRequestContext();
    const runtime = requestCtx?.runtime;
    if (!runtime || !MODEL_RUNTIME_FIELDS.has(key)) {
      return { found: false, value: null };
    }
    return { found: true, value: (runtime as Record<string, unknown>)[key] };
  }

  private _inspect(key: string | undefined): string {
    if (!key) {
      return this._inspectAll();
    }
    if (key === 'request' || key.startsWith('request.')) {
      const requestCtx = currentRequestContext();
      if (!requestCtx) {
        return 'Error: current request context is unavailable';
      }
      if (key === 'request') {
        const obj: Record<string, unknown> = {};
        for (const field of REQUEST_FIELDS) {
          obj[field] = (requestCtx as unknown as Record<string, unknown>)[field];
        }
        return MyTool._formatValue(obj, key);
      }
      const field = key.replace(/^request\./, '');
      if (!REQUEST_FIELDS.includes(field)) {
        return `Error: '${key}' not found`;
      }
      return MyTool._formatValue((requestCtx as unknown as Record<string, unknown>)[field], key);
    }
    if (!key.includes('.')) {
      const { found, value } = this._currentRuntimeValue(key);
      if (found) {
        return MyTool._formatValue(value, key);
      }
    }
    const top = key.split('.')[0];
    if (DENIED_ATTRS.has(top) || top.startsWith('__')) {
      return `Error: '${top}' is not accessible`;
    }
    const { value, error } = this._resolvePath(key);
    if (error) {
      if (key === 'scratchpad' && this._runtime_state) {
        const rv = this._runtime_state._runtime_vars;
        return Object.keys(rv).length > 0
          ? MyTool._formatValue(rv, 'scratchpad')
          : 'scratchpad is empty';
      }
      if (!key.includes('.') && this._runtime_state && key in this._runtime_state._runtime_vars) {
        return MyTool._formatValue(this._runtime_state._runtime_vars[key], key);
      }
      return `Error: ${error}`;
    }
    if (!key.includes('.') && !hasRealAttr(this._runtime_state, key)) {
      if (this._runtime_state && key in this._runtime_state._runtime_vars) {
        return MyTool._formatValue(this._runtime_state._runtime_vars[key], key);
      }
      return `Error: '${key}' not found`;
    }
    return MyTool._formatValue(value, key);
  }

  private _inspectAll(): string {
    if (!this._runtime_state) return 'No runtime state available';
    const state = this._runtime_state;
    const parts: string[] = [];
    for (const k of Object.keys(RESTRICTED)) {
      const { found, value } = this._currentRuntimeValue(k);
      parts.push(MyTool._formatValue(found ? value : (state as unknown as Record<string, unknown>)[k], k));
    }
    const { found: presetFound, value: presetValue } = this._currentRuntimeValue('model_preset');
    parts.push(MyTool._formatValue(
      presetFound ? presetValue : state.model_preset,
      'model_preset',
    ));
    const otherKeys = [
      'workspace', 'provider_retry_mode', 'max_tool_result_chars',
      '_current_iteration', 'web_config', 'exec_config',
      'workspace_sandbox', 'subagents',
    ];
    for (const k of otherKeys) {
      if (hasRealAttr(state, k)) {
        parts.push(MyTool._formatValue((state as unknown as Record<string, unknown>)[k], k));
      }
    }
    const usage = state._last_usage;
    if (usage) {
      parts.push(MyTool._formatValue(usage, '_last_usage'));
    }
    const rv = state._runtime_vars;
    if (rv && Object.keys(rv).length > 0) {
      parts.push(MyTool._formatValue(rv, 'scratchpad'));
    }
    return parts.join('\n');
  }

  private _modify(key: string | undefined, value: unknown): string {
    const keyError = MyTool._validateKey(key);
    if (keyError) return keyError;
    const k = key!;
    const top = k.split('.')[0];
    if (BLOCKED.has(top) || DENIED_ATTRS.has(top) || top.startsWith('__') || isSensitiveFieldName(top)) {
      this._audit('modify', `BLOCKED ${k}`);
      return `Error: '${k}' is protected and cannot be modified`;
    }
    if (READ_ONLY.has(top)) {
      this._audit('modify', `READ_ONLY ${k}`);
      return `Error: '${k}' is read-only and cannot be modified`;
    }
    if (k.includes('.')) {
      const lastDot = k.lastIndexOf('.');
      const parentPath = k.slice(0, lastDot);
      const leaf = k.slice(lastDot + 1);
      if (DENIED_ATTRS.has(leaf) || leaf.startsWith('__')) {
        this._audit('modify', `BLOCKED leaf '${leaf}'`);
        return `Error: '${leaf}' is not accessible`;
      }
      if (isSensitiveFieldName(leaf)) {
        this._audit('modify', `BLOCKED sensitive leaf '${leaf}'`);
        return `Error: '${leaf}' is not accessible`;
      }
      const { value: parent, error } = this._resolvePath(parentPath);
      if (error) {
        return `Error: ${error}`;
      }
      if (typeof parent === 'object' && parent !== null) {
        (parent as Record<string, unknown>)[leaf] = value;
      }
      this._audit('modify', `${k} = ${JSON.stringify(value)}`);
      return `Set ${k} = ${JSON.stringify(value)}`;
    }
    if (k === 'model_preset') {
      return this._modifyModelPreset(value);
    }
    if (k in RESTRICTED) {
      return this._modifyRestricted(k, value);
    }
    return this._modifyFree(k, value);
  }

  private _modifyModelPreset(value: unknown): string {
    if (typeof value !== 'string' || !value.trim()) {
      return "Error: 'model_preset' must be a non-empty string";
    }
    const name = value.trim();
    const result = this._modifyFree('model_preset', name);
    if (result.startsWith('Error:')) {
      return result;
    }
    if (!this._runtime_state) return result;
    return (
      `${result}; model is now ${JSON.stringify(this._runtime_state.model)}; ` +
      `context_window_tokens is now ${JSON.stringify(this._runtime_state.context_window_tokens)}`
    );
  }

  private _modifyRestricted(key: string, value: unknown): string {
    const spec = RESTRICTED[key];
    if (!this._runtime_state) return 'Error: no runtime state';

    let coerced: number | string;
    if (spec.type === 'number') {
      if (typeof value === 'boolean') {
        return `Error: '${key}' must be number, got boolean`;
      }
      if (typeof value !== 'number') {
        try {
          coerced = Number(value);
          if (isNaN(coerced)) throw new Error('NaN');
        } catch {
          return `Error: '${key}' must be number, got ${typeof value}`;
        }
      } else {
        coerced = value;
      }
    } else {
      if (typeof value !== 'string') {
        coerced = String(value);
      } else {
        coerced = value;
      }
    }

    const state = this._runtime_state as unknown as Record<string, unknown>;
    const old = state[key];

    if (spec.type === 'number') {
      const numVal = coerced as number;
      if (spec.min !== undefined && numVal < spec.min) {
        return `Error: '${key}' must be >= ${spec.min}`;
      }
      if (spec.max !== undefined && numVal > spec.max) {
        return `Error: '${key}' must be <= ${spec.max}`;
      }
    } else {
      const strVal = coerced as string;
      if (spec.min_len !== undefined && strVal.length < spec.min_len) {
        return `Error: '${key}' must be at least ${spec.min_len} characters`;
      }
    }

    if (key === 'model') {
      this._runtime_state.set_runtime_model(coerced as string);
    } else if (key === 'context_window_tokens') {
      this._runtime_state.set_runtime_context_window(coerced as number);
    } else {
      state[key] = coerced;
    }

    if (key === 'max_iterations') {
      const syncFn = (this._runtime_state as unknown as Record<string, unknown>)['_sync_subagent_runtime_limits'];
      if (typeof syncFn === 'function') {
        syncFn.call(this._runtime_state);
      }
    }

    this._audit('modify', `${key}: ${JSON.stringify(old)} -> ${JSON.stringify(coerced)}`);
    return `Set ${key} = ${JSON.stringify(coerced)} (was ${JSON.stringify(old)})`;
  }

  private _modifyFree(key: string, value: unknown): string {
    if (!this._runtime_state) return 'Error: no runtime state';
    const state = this._runtime_state as unknown as Record<string, unknown>;

    if (hasRealAttr(this._runtime_state, key)) {
      const old = state[key];
      if (typeof old === 'string' || typeof old === 'number' || typeof old === 'boolean') {
        const oldType = typeof old;
        const newType = typeof value;
        if (!(oldType === 'number' && newType === 'number') && oldType !== newType) {
          if (!(oldType === 'number' && newType === 'string')) {
            this._audit(
              'modify',
              `REJECTED type mismatch ${key}: expects ${oldType}, got ${newType}`,
            );
            return `Error: '${key}' expects ${oldType}, got ${newType}`;
          }
        }
      }
      try {
        state[key] = value;
      } catch (e) {
        const message = (e as Error).message;
        this._audit('modify', `REJECTED ${key}: ${message}`);
        return `Error: ${message}`;
      }
      this._audit('modify', `${key}: ${JSON.stringify(old)} -> ${JSON.stringify(value)}`);
      return `Set ${key} = ${JSON.stringify(value)} (was ${JSON.stringify(old)})`;
    }

    if (typeof value === 'function') {
      this._audit('modify', `REJECTED callable ${key}`);
      return 'Error: cannot store callable values';
    }

    const jsonError = this._validateJsonSafe(value);
    if (jsonError) {
      this._audit('modify', `REJECTED ${key}: ${jsonError}`);
      return `Error: ${jsonError}`;
    }

    const rv = this._runtime_state._runtime_vars;
    if (!(key in rv) && Object.keys(rv).length >= MAX_RUNTIME_KEYS) {
      this._audit('modify', `REJECTED ${key}: max keys (${MAX_RUNTIME_KEYS}) reached`);
      return `Error: scratchpad is full (max ${MAX_RUNTIME_KEYS} keys). Remove unused keys first.`;
    }

    const old = rv[key];
    rv[key] = value;
    this._audit('modify', `scratchpad.${key}: ${JSON.stringify(old)} -> ${JSON.stringify(value)}`);
    return `Set scratchpad.${key} = ${JSON.stringify(value)}`;
  }

  private _validateJsonSafe(value: unknown, depth = 0): string | null {
    if (depth > 10) {
      return 'value nesting too deep (max 10 levels)';
    }
    if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      return null;
    }
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        const err = this._validateJsonSafe(value[i], depth + 1);
        if (err) return `list[${i}] contains ${err}`;
      }
      return null;
    }
    if (typeof value === 'object' && value !== null) {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (typeof k !== 'string') {
          return `dict key must be str, got ${typeof k}`;
        }
        const err = this._validateJsonSafe(v, depth + 1);
        if (err) return `dict key '${k}' contains ${err}`;
      }
      return null;
    }
    return `unsupported type ${typeof value}`;
  }
}

export function getSelfTools(runtimeState?: RuntimeState): BaseTool[] {
  return [new MyTool(runtimeState)];
}
