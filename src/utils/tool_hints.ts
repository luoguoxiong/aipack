import { abbreviatePath } from './path.js';

interface ToolFormat {
  keyArgs: string[];
  template: string;
  isPath: boolean;
  isCommand: boolean;
}

const _TOOL_FORMATS: Record<string, ToolFormat> = {
  read_file: { keyArgs: ['path', 'file_path'], template: 'read {}', isPath: true, isCommand: false },
  write_file: { keyArgs: ['path', 'file_path'], template: 'write {}', isPath: true, isCommand: false },
  edit: { keyArgs: ['file_path', 'path'], template: 'edit {}', isPath: true, isCommand: false },
  find_files: { keyArgs: ['query', 'glob', 'path'], template: 'find {}', isPath: false, isCommand: false },
  grep: { keyArgs: ['pattern'], template: 'grep "{}"', isPath: false, isCommand: false },
  exec: { keyArgs: ['command'], template: '$ {}', isPath: false, isCommand: true },
  list_exec_sessions: { keyArgs: [], template: 'exec sessions', isPath: false, isCommand: false },
  web_search: { keyArgs: ['query'], template: 'search "{}"', isPath: false, isCommand: false },
  web_fetch: { keyArgs: ['url'], template: 'fetch {}', isPath: true, isCommand: false },
  list_dir: { keyArgs: ['path'], template: 'ls {}', isPath: true, isCommand: false },
};

const _PATH_IN_CMD_RE = new RegExp(
  '"(?P<double>(?:[A-Za-z]:[/\\\\]|~/|/)[^"]+)"' +
  "|'(?P<single>(?:[A-Za-z]:[/\\\\]|~/|/)[^']+)'" +
  "|(?P<bare>(?:[A-Za-z]:[/\\\\]|~/|(?<=\\s)/)[^\\s;&|<>\"']+)",
);

export function formatToolHints(toolCalls: Array<{ name?: string; arguments?: Record<string, unknown> | unknown[] }>, maxLength: number = 40): string {
  if (!toolCalls.length) return '';

  const formatted: string[] = [];
  for (const tc of toolCalls) {
    const name = tc.name;
    if (typeof name !== 'string' || !name) continue;

    const fmt = _TOOL_FORMATS[name];
    if (fmt) {
      formatted.push(_fmtKnown(tc, fmt, maxLength));
    } else if (name.startsWith('mcp_')) {
      formatted.push(_fmtMcp(tc, maxLength));
    } else {
      formatted.push(_fmtFallback(tc, maxLength));
    }
  }

  const hints: Array<[string, number]> = [];
  for (const hint of formatted) {
    if (hints.length && hints[hints.length - 1][0] === hint) {
      hints[hints.length - 1] = [hint, hints[hints.length - 1][1] + 1];
    } else {
      hints.push([hint, 1]);
    }
  }

  return hints.map(([h, c]) => (c > 1 ? `${h} × ${c}` : h)).join(', ');
}

function _getArgs(tc: { arguments?: Record<string, unknown> | unknown[] }): Record<string, unknown> {
  if (tc.arguments === null || tc.arguments === undefined) return {};
  if (Array.isArray(tc.arguments)) return tc.arguments[0] as Record<string, unknown> || {};
  if (typeof tc.arguments === 'object') return tc.arguments as Record<string, unknown>;
  return {};
}

function _extractArg(tc: { arguments?: Record<string, unknown> | unknown[] }, keyArgs: string[]): string | null {
  const args = _getArgs(tc);
  if (typeof args !== 'object') return null;

  for (const key of keyArgs) {
    const val = args[key];
    if (typeof val === 'string' && val) return val;
  }

  for (const val of Object.values(args)) {
    if (typeof val === 'string' && val) return val;
  }
  return null;
}

function _fmtKnown(tc: { name?: string; arguments?: Record<string, unknown> | unknown[] }, fmt: ToolFormat, maxLength: number = 40): string {
  if (!fmt.keyArgs.length && !fmt.template.includes('{}')) return fmt.template;
  let val = _extractArg(tc, fmt.keyArgs);
  if (val === null) return tc.name || '';
  if (fmt.isPath) {
    val = abbreviatePath(val, maxLength);
  } else if (fmt.isCommand) {
    val = _abbreviateCommand(val, maxLength);
  }
  return fmt.template.replace('{}', val);
}

function _abbreviateCommand(cmd: string, maxLen: number = 40): string {
  const pathMax = Math.max(Math.floor(maxLen / 2), 25);

  const abbreviated = cmd.replace(_PATH_IN_CMD_RE, (match, double, single, bare) => {
    if (double !== undefined) return `"${abbreviatePath(double, pathMax)}"`;
    if (single !== undefined) return `'${abbreviatePath(single, pathMax)}'`;
    return abbreviatePath(bare || '', pathMax);
  });

  if (abbreviated.length <= maxLen) return abbreviated;
  return abbreviated.slice(0, maxLen - 1) + '…';
}

function _fmtMcp(tc: { name?: string; arguments?: Record<string, unknown> | unknown[] }, maxLength: number = 40): string {
  const name = tc.name || '';
  let server: string, tool: string;

  if (name.includes('__')) {
    const parts = name.split('__', 1);
    server = parts[0].replace(/^mcp_/, '');
    tool = parts[1];
  } else {
    const rest = name.replace(/^mcp_/, '');
    const parts = rest.split('_', 1);
    server = parts[0] || rest;
    tool = parts[1] || '';
  }

  if (!tool) return name;

  const args = _getArgs(tc);
  const val = Object.values(args).find((v): v is string => typeof v === 'string' && !!v) || null;
  if (val === null) return `${server}::${tool}`;
  return `${server}::${tool}("${abbreviatePath(val, maxLength)}")`;
}

function _fmtFallback(tc: { name?: string; arguments?: Record<string, unknown> | unknown[] }, maxLength: number = 40): string {
  const args = _getArgs(tc);
  const val = typeof args === 'object' ? Object.values(args)[0] : null;
  if (typeof val !== 'string') return tc.name || '';
  if (val.length > maxLength) return `${tc.name}("${abbreviatePath(val, maxLength)}")`;
  return `${tc.name}("${val}")`;
}