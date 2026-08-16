/**
 * AI 工具层测试：retry / json-parse / sse-parser / sanitize-unicode / overflow / diagnostics
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateDelay,
  isRetryableHttpStatus,
  isRetryableNetworkError,
  isRetryableError,
  retry,
  ok,
  matchesRetryablePattern,
  extractRetryAfterMs,
} from '../ai/retry.ts';
import {
  repairJson,
  parseJsonWithRepair,
  parseStreamingJson,
} from '../ai/json-parse.ts';
import {
  parseSSEEvents,
  extractDataLines,
  tryParseJSON,
} from '../ai/sse-parser.ts';
import { sanitizeSurrogates } from '../ai/sanitize-unicode.ts';
import {
  isContextOverflow,
  getOverflowPatterns,
} from '../ai/overflow.ts';
import {
  extractDiagnosticError,
  createDiagnostic,
  appendDiagnostic,
} from '../ai/diagnostics.ts';
import type { AssistantMessage } from '../core/index.ts';

// ─── retry.ts ──────────────────────────────────────────────────────

describe('calculateDelay', () => {
  it('attempt=0 时约为 baseDelay', () => {
    const delay = calculateDelay(0, 1000, 30000);
    // base=1000, jitter=250, 范围 [750, 1250]
    assert.ok(delay >= 750 && delay <= 1250, `delay=${delay} 应在 [750,1250]`);
  });

  it('指数退避递增', () => {
    const d0 = calculateDelay(0, 100, 30000);
    const d2 = calculateDelay(2, 100, 30000);
    assert.ok(d2 > d0, `attempt=2 (${d2}) 应大于 attempt=0 (${d0})`);
  });

  it('指数部分被 maxDelayMs 封顶（jitter 可超出 ±25%）', () => {
    // calculateDelay 的 exponential = min(base * 2^attempt, maxDelayMs)
    // jitter = exponential * 0.25，最终值范围 [exp - jitter, exp + jitter]
    // 当 exponential == maxDelayMs 时，结果可达 maxDelayMs * 1.25
    const delay = calculateDelay(20, 1000, 5000);
    assert.ok(
      delay <= 5000 * 1.25,
      `delay=${delay} 不应超过 maxDelayMs * 1.25 = ${5000 * 1.25}`,
    );
  });

  it('jitter 产生随机性', () => {
    const delays = new Set<number>();
    for (let i = 0; i < 20; i++) {
      delays.add(calculateDelay(1, 1000, 30000));
    }
    assert.ok(delays.size > 1, '多次计算应有随机性');
  });
});

describe('isRetryableHttpStatus', () => {
  it('429 可重试', () => assert.equal(isRetryableHttpStatus(429), true));
  it('500-599 可重试', () => {
    assert.equal(isRetryableHttpStatus(500), true);
    assert.equal(isRetryableHttpStatus(503), true);
    assert.equal(isRetryableHttpStatus(599), true);
  });
  it('400/404/200 不可重试', () => {
    assert.equal(isRetryableHttpStatus(400), false);
    assert.equal(isRetryableHttpStatus(404), false);
    assert.equal(isRetryableHttpStatus(200), false);
  });
});

describe('isRetryableNetworkError', () => {
  it('AbortError 不可重试', () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    assert.equal(isRetryableNetworkError(err), false);
  });

  it('fetch failed 可重试', () => {
    assert.equal(isRetryableNetworkError(new Error('fetch failed')), true);
  });

  it('ECONNREFUSED 可重试', () => {
    assert.equal(isRetryableNetworkError(new Error('ECONNREFUSED')), true);
  });

  it('普通错误不可重试', () => {
    assert.equal(isRetryableNetworkError(new Error('invalid input')), false);
  });

  it('字符串错误也可判断', () => {
    assert.equal(isRetryableNetworkError('network timeout'), true);
  });
});

describe('isRetryableError', () => {
  it('数字走 HTTP 判断', () => {
    assert.equal(isRetryableError(429), true);
    assert.equal(isRetryableError(400), false);
  });
  it('对象走网络错误判断', () => {
    assert.equal(isRetryableError(new Error('fetch failed')), true);
    assert.equal(isRetryableError(new Error('bad request')), false);
  });
});

describe('retry', () => {
  it('首次成功直接返回', async () => {
    const result = await retry(async () => ok('success'));
    assert.equal(result, 'success');
  });

  it('可重试错误时重试到成功', async () => {
    let attempts = 0;
    const result = await retry(
      async (attempt) => {
        attempts++;
        if (attempt < 1) throw new Error('fetch failed');
        return ok('ok');
      },
      { maxRetries: 2, baseDelayMs: 1 },
    );
    assert.equal(result, 'ok');
    assert.equal(attempts, 2);
  });

  it('不可重试错误立即抛出', async () => {
    let attempts = 0;
    await assert.rejects(
      async () =>
        retry(
          async () => {
            attempts++;
            throw new Error('invalid input');
          },
          { maxRetries: 3, baseDelayMs: 1 },
        ),
      /invalid input/,
    );
    assert.equal(attempts, 1);
  });

  it('达到最大重试次数后抛出最后一个错误', async () => {
    let attempts = 0;
    await assert.rejects(
      async () =>
        retry(
          async () => {
            attempts++;
            throw new Error('fetch failed');
          },
          { maxRetries: 2, baseDelayMs: 1 },
        ),
      /fetch failed/,
    );
    assert.equal(attempts, 3); // attempt 0,1,2
  });

  it('429 带 Retry-After 时延迟取 max(退避, Retry-After) 封顶 maxDelayMs', async () => {
    // 模拟 fetch Response：429 + Retry-After: 1（秒）
    const rateLimited = new Response('too many requests', {
      status: 429,
      headers: { 'retry-after': '1' },
    });

    const delays: number[] = [];
    let attempts = 0;
    const started = Date.now();
    await assert.rejects(
      async () =>
        retry(
          async () => {
            attempts++;
            throw rateLimited;
          },
          {
            maxRetries: 1,
            baseDelayMs: 1,
            maxDelayMs: 50, // 封顶，避免测试真的等 1s
            onRetryAttempt: ({ delayMs }) => delays.push(delayMs),
          },
        ),
    );
    assert.equal(attempts, 2);
    assert.equal(delays.length, 1);
    // backoff(≈1ms) 与 Retry-After(1000ms) 取较大值后封顶 maxDelayMs(50)
    assert.equal(delays[0], 50);
    assert.ok(Date.now() - started >= 40, '应至少等待封顶后的延迟');
  });
});

describe('extractRetryAfterMs', () => {
  it('秒数格式解析为毫秒', () => {
    const res = new Response('', { status: 429, headers: { 'retry-after': '30' } });
    assert.equal(extractRetryAfterMs(res), 30_000);
  });

  it('HTTP-date 格式解析为剩余毫秒', () => {
    const date = new Date(Date.now() + 60_000).toUTCString();
    const res = new Response('', { status: 429, headers: { 'retry-after': date } });
    const ms = extractRetryAfterMs(res)!;
    assert.ok(ms > 55_000 && ms <= 60_000, `应约为 60s，实际 ${ms}`);
  });

  it('过去的 HTTP-date 解析为 0', () => {
    const date = new Date(Date.now() - 60_000).toUTCString();
    const res = new Response('', { status: 429, headers: { 'retry-after': date } });
    assert.equal(extractRetryAfterMs(res), 0);
  });

  it('无 header 或普通错误返回 undefined', () => {
    assert.equal(extractRetryAfterMs(new Error('fetch failed')), undefined);
    assert.equal(
      extractRetryAfterMs(new Response('', { status: 500 })),
      undefined,
    );
  });
});

describe('matchesRetryablePattern', () => {
  it('匹配模式返回 true', () => {
    assert.equal(matchesRetryablePattern('Connection timeout', ['timeout', 'reset']), true);
  });
  it('不匹配返回 false', () => {
    assert.equal(matchesRetryablePattern('all good', ['timeout', 'reset']), false);
  });
  it('大小写不敏感', () => {
    assert.equal(matchesRetryablePattern('TIMEOUT occurred', ['timeout']), true);
  });
});

// ─── json-parse.ts ─────────────────────────────────────────────────

describe('repairJson', () => {
  it('合法 JSON 原样返回', () => {
    assert.equal(repairJson('{"a":1}'), '{"a":1}');
  });

  it('转义字符串内控制字符', () => {
    const repaired = repairJson('{"text":"hello\nworld"}');
    assert.ok(repaired.includes('\\n'), '应转义换行符');
    const parsed = JSON.parse(repaired);
    assert.equal(parsed.text, 'hello\nworld');
  });

  it('修复非法反斜杠转义', () => {
    const repaired = repairJson('{"path":"C:\\Users\\test"}');
    // \U \t 不是合法转义（\U 不是，\t 是），\U 应被加倍为 \\U
    const parsed = JSON.parse(repaired);
    assert.ok(parsed.path.includes('Users'));
  });

  it('处理末尾孤立反斜杠', () => {
    const repaired = repairJson('{"a":"end\\');
    assert.ok(repaired.endsWith('\\\\'));
  });

  it('保留合法 \\u 转义', () => {
    const repaired = repairJson('{"emoji":"\\u0041"}');
    const parsed = JSON.parse(repaired);
    assert.equal(parsed.emoji, 'A');
  });
});

describe('parseJsonWithRepair', () => {
  it('合法 JSON 直接解析', () => {
    assert.deepEqual(parseJsonWithRepair('{"a":1}'), { a: 1 });
  });

  it('修复后解析含控制字符的 JSON', () => {
    const result = parseJsonWithRepair('{"text":"hi\nthere"}') as { text: string };
    assert.equal(result.text, 'hi\nthere');
  });

  it('无法修复时抛错', () => {
    assert.throws(() => parseJsonWithRepair('not json at all'), /Failed to parse/);
  });
});

describe('parseStreamingJson', () => {
  it('空字符串返回空对象', async () => {
    assert.deepEqual(await parseStreamingJson(''), {});
  });

  it('空白返回空对象', async () => {
    assert.deepEqual(await parseStreamingJson('   '), {});
  });

  it('完整 JSON 直接解析', async () => {
    assert.deepEqual(await parseStreamingJson('{"a":1}'), { a: 1 });
  });

  it('不完整 JSON 降级解析', async () => {
    // 缺少闭合括号，partial-json 应能补全
    const result = await parseStreamingJson('{"a":1,"b":2');
    assert.ok(result && typeof result === 'object');
  });

  it('完全无法解析时返回空对象', async () => {
    const result = await parseStreamingJson(';;;not json;;;');
    assert.deepEqual(result, {});
  });
});

// ─── sse-parser.ts ─────────────────────────────────────────────────

describe('parseSSEEvents', () => {
  it('解析完整事件块', () => {
    const buffer = 'event: message\ndata: {"a":1}\n\n';
    const { events, remaining } = parseSSEEvents(buffer);
    assert.equal(events.length, 1);
    assert.equal(events[0].event, 'message');
    assert.equal(events[0].data, '{"a":1}');
    assert.equal(remaining, '');
  });

  it('解析多个事件块', () => {
    const buffer = 'data: chunk1\n\ndata: chunk2\n\n';
    const { events } = parseSSEEvents(buffer);
    assert.equal(events.length, 2);
    assert.equal(events[0].data, 'chunk1');
    assert.equal(events[1].data, 'chunk2');
  });

  it('不完整块保留到 remaining', () => {
    const buffer = 'data: complete\n\ndata: incomplete';
    const { events, remaining } = parseSSEEvents(buffer);
    assert.equal(events.length, 1);
    assert.equal(remaining, 'data: incomplete');
  });

  it('多行 data 拼接', () => {
    const buffer = 'data: line1\ndata: line2\n\n';
    const { events } = parseSSEEvents(buffer);
    assert.equal(events[0].data, 'line1line2');
  });

  it('无 data 行的事件被忽略', () => {
    const buffer = 'event: ping\n\n';
    const { events } = parseSSEEvents(buffer);
    assert.equal(events.length, 0);
  });

  it('自定义 event 类型', () => {
    const buffer = 'event: tool_call\ndata: {"id":"tc1"}\n\n';
    const { events } = parseSSEEvents(buffer);
    assert.equal(events[0].event, 'tool_call');
  });

  it('处理块内 \\r\\n 行尾', () => {
    // parseSSEEvents 按 \n\n 切分块，块内每行去尾部 \r
    const buffer = 'data: hello\r\ndata: world\n\n';
    const { events } = parseSSEEvents(buffer);
    assert.equal(events.length, 1);
    assert.equal(events[0].data, 'helloworld');
  });
});

describe('extractDataLines', () => {
  it('提取所有 data 行', () => {
    const buffer = 'data: a\ndata: b\n';
    const { lines, rest } = extractDataLines(buffer);
    assert.deepEqual(lines, ['a', 'b']);
    assert.equal(rest, '');
  });

  it('忽略非 data 行', () => {
    const buffer = 'event: msg\ndata: keep\n: comment\n';
    const { lines } = extractDataLines(buffer);
    assert.deepEqual(lines, ['keep']);
  });

  it('不完整行保留到 rest', () => {
    const buffer = 'data: complete\ndata: incomplete';
    const { lines, rest } = extractDataLines(buffer);
    assert.deepEqual(lines, ['complete']);
    assert.equal(rest, 'data: incomplete');
  });
});

describe('tryParseJSON', () => {
  it('合法 JSON 返回 value', () => {
    const result = tryParseJSON<{ a: number }>('{"a":1}');
    assert.ok(result);
    assert.equal(result.value.a, 1);
  });

  it('[DONE] 返回 null', () => {
    assert.equal(tryParseJSON('[DONE]'), null);
  });

  it('空字符串返回 null', () => {
    assert.equal(tryParseJSON(''), null);
  });

  it('非法 JSON 返回 null', () => {
    assert.equal(tryParseJSON('not json'), null);
  });
});

// ─── sanitize-unicode.ts ───────────────────────────────────────────

describe('sanitizeSurrogates', () => {
  it('普通字符串不受影响', () => {
    assert.equal(sanitizeSurrogates('hello world'), 'hello world');
  });

  it('合法 emoji 不受影响', () => {
    const emoji = '😀';
    assert.equal(sanitizeSurrogates(emoji), emoji);
  });

  it('移除未配对的高代理项', () => {
    const str = 'before\uD800after';
    assert.equal(sanitizeSurrogates(str), 'beforeafter');
  });

  it('移除未配对的低代理项', () => {
    const str = 'before\uDC00after';
    assert.equal(sanitizeSurrogates(str), 'beforeafter');
  });

  it('空字符串返回空', () => {
    assert.equal(sanitizeSurrogates(''), '');
  });
});

// ─── overflow.ts ───────────────────────────────────────────────────

describe('isContextOverflow', () => {
  it('匹配 OpenAI 溢出错误消息', () => {
    const msg = {
      stopReason: 'error',
      errorMessage: 'This model maximum context length is 8192 tokens',
      usage: { input: 0, output: 0, total: 0 },
    };
    assert.equal(isContextOverflow(msg), true);
  });

  it('匹配 Anthropic 溢出错误消息', () => {
    const msg = {
      stopReason: 'error',
      errorMessage: 'prompt is too long',
      usage: { input: 0, output: 0, total: 0 },
    };
    assert.equal(isContextOverflow(msg), true);
  });

  it('限流错误不算溢出', () => {
    const msg = {
      stopReason: 'error',
      errorMessage: 'Rate limit exceeded',
      usage: { input: 0, output: 0, total: 0 },
    };
    assert.equal(isContextOverflow(msg), false);
  });

  it('静默溢出：usage.input > contextWindow', () => {
    const msg = {
      stopReason: 'stop',
      usage: { input: 10000, output: 10, total: 10010 },
    };
    assert.equal(isContextOverflow(msg, 8000), true);
  });

  it('截断溢出：stopReason=length + output=0 + input≈contextWindow', () => {
    const msg = {
      stopReason: 'length',
      errorMessage: undefined,
      usage: { input: 8000, output: 0, total: 8000 },
    };
    assert.equal(isContextOverflow(msg, 8000), true);
  });

  it('正常成功消息不算溢出', () => {
    const msg = {
      stopReason: 'stop',
      usage: { input: 100, output: 50, total: 150 },
    };
    assert.equal(isContextOverflow(msg, 8000), false);
  });

  it('普通错误不算溢出', () => {
    const msg = {
      stopReason: 'error',
      errorMessage: 'Internal server error',
      usage: { input: 0, output: 0, total: 0 },
    };
    assert.equal(isContextOverflow(msg), false);
  });
});

describe('getOverflowPatterns', () => {
  it('返回非空正则数组', () => {
    const patterns = getOverflowPatterns();
    assert.ok(patterns.length > 0);
    assert.ok(patterns.every(p => p instanceof RegExp));
  });

  it('返回拷贝，修改不影响内部', () => {
    const p1 = getOverflowPatterns();
    p1.push(/injected/);
    const p2 = getOverflowPatterns();
    assert.ok(!p2.some(p => p.source === 'injected'));
  });
});

// ─── diagnostics.ts ───────────────────────────────────────────────

describe('extractDiagnosticError', () => {
  it('从 Error 对象提取', () => {
    const err = new Error('something broke');
    const diag = extractDiagnosticError(err);
    assert.equal(diag.message, 'something broke');
    assert.equal(diag.name, 'Error');
    assert.ok(diag.stack);
  });

  it('从带 code 的 Error 提取', () => {
    const err = new Error('fail') as Error & { code: string };
    err.code = 'ECONNREFUSED';
    const diag = extractDiagnosticError(err);
    assert.equal(diag.code, 'ECONNREFUSED');
  });

  it('从字符串提取', () => {
    const diag = extractDiagnosticError('plain string');
    assert.equal(diag.name, 'ThrownValue');
    assert.equal(diag.message, 'plain string');
  });

  it('从其他类型提取', () => {
    const diag = extractDiagnosticError(42);
    assert.equal(diag.name, 'ThrownValue');
    assert.equal(diag.message, '42');
  });

  it('Error 无 message 时用 name', () => {
    class CustomErr extends Error {
      constructor() {
        super('');
        this.name = 'CustomErr';
      }
    }
    const diag = extractDiagnosticError(new CustomErr());
    assert.equal(diag.message, 'CustomErr');
  });
});

describe('createDiagnostic', () => {
  it('创建完整诊断记录', () => {
    const diag = createDiagnostic('retry', new Error('timeout'), { attempt: 2 });
    assert.equal(diag.type, 'retry');
    assert.ok(diag.timestamp > 0);
    assert.equal(diag.error.message, 'timeout');
    assert.deepEqual(diag.details, { attempt: 2 });
  });

  it('无 details 时为 undefined', () => {
    const diag = createDiagnostic('init', new Error('fail'));
    assert.equal(diag.details, undefined);
  });
});

describe('appendDiagnostic', () => {
  it('追加诊断到 AssistantMessage', () => {
    const msg = {
      role: 'assistant',
      content: [],
      stopReason: 'stop',
      timestamp: Date.now(),
    } as AssistantMessage;
    const diag1 = createDiagnostic('retry', new Error('timeout'));
    const diag2 = createDiagnostic('retry', new Error('conn reset'));
    appendDiagnostic(msg, diag1);
    appendDiagnostic(msg, diag2);
    assert.equal((msg as any).diagnostics.length, 2);
    assert.equal((msg as any).diagnostics[0].error.message, 'timeout');
  });

  it('首次追加创建 diagnostics 数组', () => {
    const msg = {
      role: 'assistant',
      content: [],
      timestamp: Date.now(),
    } as AssistantMessage;
    assert.equal((msg as any).diagnostics, undefined);
    appendDiagnostic(msg, createDiagnostic('test', new Error('e')));
    assert.ok(Array.isArray((msg as any).diagnostics));
    assert.equal((msg as any).diagnostics.length, 1);
  });
});
