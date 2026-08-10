/**
 * AgentError 统一错误分类测试
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AgentError,
  AgentErrorCategory,
  isAgentError,
  isRetryableCategory,
  classifyHttpStatus,
  classifyErrorMessage,
  classifyError,
  isContextOverflowError,
  categoryLabel,
  formatCategoryError,
  formatHttpError,
} from '../ai/errors';
import { isRetryableError } from '../ai/retry';

describe('AgentError 基础', () => {
  it('默认分类为 unknown，且不可重试', () => {
    const err = new AgentError('boom');
    assert.equal(err.name, 'AgentError');
    assert.equal(err.category, AgentErrorCategory.UNKNOWN);
    assert.equal(err.retryable, false);
  });

  it('retryable 分类默认可重试', () => {
    const err = new AgentError('network', { category: AgentErrorCategory.RETRYABLE });
    assert.equal(err.retryable, true);
  });

  it('显式 retryable 覆盖分类默认', () => {
    const err = new AgentError('slow', {
      category: AgentErrorCategory.TIMEOUT,
      retryable: true,
    });
    assert.equal(err.retryable, true);
  });

  it('携带 status 与 cause', () => {
    const cause = new Error('root');
    const err = new AgentError('upstream', { status: 429, cause });
    assert.equal(err.status, 429);
    assert.equal(err.cause, cause);
  });

  it('isAgentError 识别实例与跨包复制对象', () => {
    assert.equal(isAgentError(new AgentError('x')), true);
    assert.equal(
      isAgentError({ name: 'AgentError', category: 'auth', message: 'x' }),
      true,
    );
    assert.equal(isAgentError(new Error('x')), false);
    assert.equal(isAgentError(null), false);
  });
});

describe('classifyHttpStatus', () => {
  it('401/403 → auth', () => {
    assert.equal(classifyHttpStatus(401), AgentErrorCategory.AUTH);
    assert.equal(classifyHttpStatus(403), AgentErrorCategory.AUTH);
  });
  it('429 → rate-limit', () => {
    assert.equal(classifyHttpStatus(429), AgentErrorCategory.RATE_LIMIT);
  });
  it('413 → context-overflow', () => {
    assert.equal(classifyHttpStatus(413), AgentErrorCategory.CONTEXT_OVERFLOW);
  });
  it('5xx → retryable', () => {
    assert.equal(classifyHttpStatus(500), AgentErrorCategory.RETRYABLE);
    assert.equal(classifyHttpStatus(503), AgentErrorCategory.RETRYABLE);
  });
  it('其他 4xx → invalid-request', () => {
    assert.equal(classifyHttpStatus(400), AgentErrorCategory.INVALID_REQUEST);
    assert.equal(classifyHttpStatus(422), AgentErrorCategory.INVALID_REQUEST);
  });
  it('2xx/3xx → unknown', () => {
    assert.equal(classifyHttpStatus(200), AgentErrorCategory.UNKNOWN);
  });
});

describe('classifyErrorMessage', () => {
  it('上下文超限模式', () => {
    assert.equal(
      classifyErrorMessage('This model maximum context length is 8192 tokens'),
      AgentErrorCategory.CONTEXT_OVERFLOW,
    );
    assert.equal(classifyErrorMessage('prompt is too long'), AgentErrorCategory.CONTEXT_OVERFLOW);
  });
  it('限流模式', () => {
    assert.equal(classifyErrorMessage('Rate limit exceeded'), AgentErrorCategory.RATE_LIMIT);
  });
  it('认证模式', () => {
    assert.equal(classifyErrorMessage('401 Invalid API key'), AgentErrorCategory.AUTH);
    assert.equal(classifyErrorMessage('Permission denied'), AgentErrorCategory.AUTH);
  });
  it('超时模式', () => {
    assert.equal(classifyErrorMessage('request timed out'), AgentErrorCategory.TIMEOUT);
  });
  it('未匹配 → unknown', () => {
    assert.equal(classifyErrorMessage('Internal server error'), AgentErrorCategory.UNKNOWN);
  });
});

describe('classifyError / isContextOverflowError', () => {
  it('AgentError 分类优先', () => {
    const err = new AgentError('slow', { category: AgentErrorCategory.TIMEOUT });
    assert.equal(classifyError(err), AgentErrorCategory.TIMEOUT);
  });
  it('status 优先于消息模式', () => {
    const err = Object.assign(new Error('prompt is too long'), { status: 401 });
    assert.equal(classifyError(err), AgentErrorCategory.AUTH);
  });
  it('普通错误按消息推导', () => {
    assert.equal(classifyError(new Error('prompt is too long')), AgentErrorCategory.CONTEXT_OVERFLOW);
  });
  it('isContextOverflowError 命中上下文超限', () => {
    assert.equal(isContextOverflowError(new Error('maximum context length exceeded')), true);
    assert.equal(isContextOverflowError(new Error('server 500')), false);
  });
});

describe('格式化', () => {
  it('categoryLabel 仅非 unknown 输出前缀', () => {
    assert.equal(categoryLabel(AgentErrorCategory.AUTH), '[auth] ');
    assert.equal(categoryLabel(AgentErrorCategory.UNKNOWN), '');
  });
  it('formatCategoryError 拼接前缀', () => {
    assert.equal(
      formatCategoryError(AgentErrorCategory.TIMEOUT, 'Stream idle timeout after 60000ms'),
      '[timeout] Stream idle timeout after 60000ms',
    );
  });
  it('formatHttpError 带状态码与分类', () => {
    assert.equal(
      formatHttpError(401, 'Invalid API key'),
      '[auth] API error 401: Invalid API key',
    );
    assert.equal(
      formatHttpError(500, 'boom', 'Anthropic API error'),
      '[retryable] Anthropic API error 500: boom',
    );
  });
});

describe('retry 集成', () => {
  it('AgentError retryable 分类 → isRetryableError 为 true', () => {
    const err = new AgentError('net', { category: AgentErrorCategory.RETRYABLE });
    assert.equal(isRetryableError(err), true);
  });
  it('AgentError timeout 分类 → 不可重试（不因消息含 "timed out" 误判）', () => {
    const err = new AgentError('Stream idle timeout after 60000ms', {
      category: AgentErrorCategory.TIMEOUT,
    });
    assert.equal(isRetryableError(err), false);
  });
  it('AgentError auth 分类 → 不可重试', () => {
    const err = new AgentError('401', { category: AgentErrorCategory.AUTH });
    assert.equal(isRetryableError(err), false);
  });
  it('rate-limit 分类 → 可重试', () => {
    const err = new AgentError('rate', { category: AgentErrorCategory.RATE_LIMIT });
    assert.equal(isRetryableError(err), true);
  });
});

describe('isRetryableCategory', () => {
  it('仅 retryable / rate-limit 可重试', () => {
    assert.equal(isRetryableCategory(AgentErrorCategory.RETRYABLE), true);
    assert.equal(isRetryableCategory(AgentErrorCategory.RATE_LIMIT), true);
    assert.equal(isRetryableCategory(AgentErrorCategory.TIMEOUT), false);
    assert.equal(isRetryableCategory(AgentErrorCategory.AUTH), false);
    assert.equal(isRetryableCategory(AgentErrorCategory.CONTEXT_OVERFLOW), false);
  });
});
