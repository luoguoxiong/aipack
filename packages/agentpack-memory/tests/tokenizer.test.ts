/**
 * 分词器测试：CJK bigram、假名/谚文、中英混合、概念抽取。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, isCJK, extractConcepts } from '../src/retrieval/tokenizer';

describe('tokenize', () => {
  it('CJK 使用相邻两字 bigram（偶数串无单字）', () => {
    assert.deepEqual(tokenize('数据科学'), ['数据', '据科', '科学']);
  });

  it('奇数长度 CJK 串尾部补单字（保证单字查询可命中）', () => {
    const tokens = tokenize('技术栈');
    assert.deepEqual(tokens, ['技术', '术栈', '栈']);
    // 单字查询仍可命中
    assert.ok(tokens.includes('栈'));
    // 3 字串同样补尾部单字
    assert.deepEqual(tokenize('数据库'), ['数据', '据库', '库']);
  });

  it('单字 CJK 直接成 token', () => {
    assert.deepEqual(tokenize('中'), ['中']);
  });

  it('latin 小写化并按非字母数字分割', () => {
    assert.deepEqual(tokenize('React + TypeScript'), ['react', 'typescript']);
    assert.deepEqual(tokenize('node.v2'), ['node', 'v2']);
  });

  it('中英混合：latin 与 CJK 分别处理', () => {
    const tokens = tokenize('React技术栈');
    assert.deepEqual(tokens, ['react', '技术', '术栈', '栈']);
  });

  it('CJK 标点视为分隔符', () => {
    const tokens = tokenize('你好，世界。');
    assert.deepEqual(tokens, ['你好', '世界']);
  });

  it('支持日文假名', () => {
    assert.ok(isCJK('あ'));
    assert.ok(isCJK('カ'));
    const tokens = tokenize('こんにちは');
    // 5 个假名 → 4 个 bigram + 1 个尾部单字
    assert.equal(tokens.length, 5);
    assert.ok(tokens.includes('こん'));
  });

  it('支持韩文谚文', () => {
    assert.ok(isCJK('한'));
    const tokens = tokenize('한국어');
    assert.ok(tokens.includes('한국'));
  });

  it('空文本返回空数组', () => {
    assert.deepEqual(tokenize(''), []);
    assert.deepEqual(tokenize('   '), []);
  });
});

describe('extractConcepts', () => {
  it('按频次提取 top-N', () => {
    const concepts = extractConcepts('redis redis redis mysql mysql node', 2);
    assert.deepEqual(concepts, ['redis', 'mysql']);
  });

  it('过滤停用词与单字符英文', () => {
    const concepts = extractConcepts('the a is redis b', 4);
    assert.deepEqual(concepts, ['redis']);
  });

  it('CJK bigram 可作为概念', () => {
    const concepts = extractConcepts('用户偏好深色主题', 4);
    assert.ok(concepts.includes('偏好') || concepts.includes('深色'));
  });
});
