/**
 * JSON 修复与流式解析
 *
 * repairJson: 修复 LLM 流式输出中常见的损坏 JSON（控制字符、无效转义等）
 * parseStreamingJson: 四级降级策略解析不完整/损坏的 JSON
 */

// ─── 惰性加载 partial-json ────────────────────────────────────────

type PartialParser = (input: string) => unknown;

let cachedParser: PartialParser | null = null;
let parserLoaded = false;

async function getPartialParser(): Promise<PartialParser> {
  if (parserLoaded) return cachedParser!;
  parserLoaded = true;
  try {
    const mod: any = await import('partial-json');
    const parse = mod.parse || mod.parseJSON || mod.default?.parse;
    if (typeof parse === 'function') {
      cachedParser = (s: string) => {
        try {
          return parse(s);
        } catch {
          return {};
        }
      };
      return cachedParser;
    }
  } catch {
    // fall through to default
  }
  cachedParser = (s: string) => {
    try {
      return JSON.parse(s);
    } catch {
      return {};
    }
  };
  return cachedParser;
}

// ─── JSON 修复 ─────────────────────────────────────────────────────

const VALID_JSON_ESCAPES = new Set([
  '"', '\\', '/', 'b', 'f', 'n', 'r', 't', 'u',
]);

function isControlCharacter(char: string): boolean {
  const codePoint = char.codePointAt(0);
  return codePoint !== undefined && codePoint >= 0x00 && codePoint <= 0x1f;
}

function escapeControlCharacter(char: string): string {
  switch (char) {
    case '\b': return '\\b';
    case '\f': return '\\f';
    case '\n': return '\\n';
    case '\r': return '\\r';
    case '\t': return '\\t';
    default:
      return `\\u${char.codePointAt(0)?.toString(16).padStart(4, '0') ?? '0000'}`;
  }
}

/**
 * 修复损坏的 JSON 字符串字面量：
 * - 转义字符串内的原始控制字符
 * - 加倍非法的反斜杠转义序列
 */
export function repairJson(json: string): string {
  let repaired = '';
  let inString = false;

  for (let index = 0; index < json.length; index++) {
    const char = json[index];

    if (!inString) {
      repaired += char;
      if (char === '"') inString = true;
      continue;
    }

    if (char === '"') {
      repaired += char;
      inString = false;
      continue;
    }

    if (char === '\\') {
      const nextChar = json[index + 1];
      if (nextChar === undefined) {
        repaired += '\\\\';
        continue;
      }
      if (nextChar === 'u') {
        const unicodeDigits = json.slice(index + 2, index + 6);
        if (/^[0-9a-fA-F]{4}$/.test(unicodeDigits)) {
          repaired += `\\u${unicodeDigits}`;
          index += 5;
          continue;
        }
      }
      if (VALID_JSON_ESCAPES.has(nextChar)) {
        repaired += `\\${nextChar}`;
        index += 1;
        continue;
      }
      repaired += '\\\\';
      continue;
    }

    repaired += isControlCharacter(char) ? escapeControlCharacter(char) : char;
  }

  return repaired;
}

export function parseJsonWithRepair(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    const repairedJson = repairJson(json);
    if (repairedJson !== json) {
      return JSON.parse(repairedJson);
    }
    throw new Error('Failed to parse JSON after repair');
  }
}

/**
 * 尝试解析不完整的流式 JSON，始终返回有效对象。
 *
 * 降级策略：JSON.parse → repairJson + JSON.parse → partial-json → repairJson + partial-json → {}
 */
export async function parseStreamingJson(partialJson: string): Promise<Record<string, unknown>> {
  if (!partialJson || partialJson.trim() === '') return {};

  // 第一级：直接解析
  try {
    const result = JSON.parse(partialJson);
    return (result ?? {}) as Record<string, unknown>;
  } catch {
    // fall through
  }

  // 第二级：修复后重试
  try {
    const repaired = repairJson(partialJson);
    if (repaired !== partialJson) {
      const result = JSON.parse(repaired);
      return (result ?? {}) as Record<string, unknown>;
    }
  } catch {
    // fall through
  }

  // 第三级：partial-json
  try {
    const parser = await getPartialParser();
    const result = parser(partialJson);
    return (result ?? {}) as Record<string, unknown>;
  } catch {
    // fall through
  }

  // 第四级：fix + partial-json
  try {
    const parser = await getPartialParser();
    const repaired = repairJson(partialJson);
    const result = parser(repaired);
    return (result ?? {}) as Record<string, unknown>;
  } catch {
    return {};
  }
}
