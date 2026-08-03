/**
 * 分词器：支持 latin（小写化 + 按非字母数字分割）与 CJK（逐字符）。
 * 零依赖，适配中英文混合文本的 BM25 索引。
 */

/** 判断字符是否为 CJK 统一表意文字（\u4e00-\u9fff） */
export function isCJK(ch: string): boolean {
  if (!ch) return false;
  const code = ch.charCodeAt(0);
  return code >= 0x4e00 && code <= 0x9fff;
}

/** 判断字符是否为 CJK 兼容标点 / 全角符号（粗略范围，常见中文标点） */
function isCJKSymbol(ch: string): boolean {
  const code = ch.charCodeAt(0);
  // CJK 标点 \u3000-\u303f、全角 ascii \uff00-\uffef
  return (code >= 0x3000 && code <= 0x303f) || (code >= 0xff00 && code <= 0xffef);
}

/**
 * 常见停用词（中英文小集合），用于概念抽取去停用词。
 * BM25 索引本身不去停用词（保留其 IDF 权重），仅概念抽取时过滤。
 */
export const STOPWORDS = new Set<string>([
  // 英文
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'else', 'when', 'of', 'to', 'in',
  'on', 'at', 'by', 'for', 'with', 'without', 'is', 'are', 'was', 'were', 'be', 'been',
  'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'can', 'could',
  'should', 'shall', 'may', 'might', 'must', 'i', 'you', 'he', 'she', 'it', 'we', 'they',
  'this', 'that', 'these', 'those', 'my', 'your', 'his', 'her', 'its', 'our', 'their',
  'me', 'him', 'us', 'them', 'as', 'from', 'so', 'not', 'no', 'yes',
  // 中文高频虚词
  '的', '了', '是', '在', '我', '你', '他', '她', '它', '们', '这', '那', '和', '与', '或',
  '也', '都', '就', '把', '被', '让', '给', '对', '为', '从', '到', '向', '着', '过', '吧',
  '吗', '呢', '啊', '哦', '嗯', '个', '些', '上', '下', '里', '中',
]);

/**
 * 将文本切分为 token 数组。
 * - latin 部分：小写化后按非字母数字字符分割。
 * - CJK 部分：逐字符成 token（适合短文本语义检索）。
 * - 标点 / 空白忽略。
 */
export function tokenize(text: string): string[] {
  if (!text) return [];
  const tokens: string[] = [];
  let latinBuf = '';

  const flushLatin = () => {
    if (latinBuf) {
      // 小写化 + 按非字母数字分割
      const parts = latinBuf.toLowerCase().match(/[a-z0-9]+/g);
      if (parts) tokens.push(...parts);
      latinBuf = '';
    }
  };

  for (const ch of text) {
    if (isCJK(ch)) {
      flushLatin();
      tokens.push(ch);
    } else if (isCJKSymbol(ch)) {
      flushLatin();
      // CJK 标点视为分隔符，忽略
    } else {
      // 累积 latin（含数字与ASCII标点，分割在 flushLatin 中处理）
      latinBuf += ch;
    }
  }
  flushLatin();

  return tokens;
}

/** 概念抽取：返回非停用词 token 的频次 top-N（用于记忆 concepts 字段） */
export function extractConcepts(text: string, maxConcepts = 8): string[] {
  const tokens = tokenize(text);
  const freq = new Map<string, number>();
  for (const t of tokens) {
    if (STOPWORDS.has(t)) continue;
    if (t.length < 2 && !isCJK(t)) continue; // 单字符英文跳过（CJK 单字保留）
    freq.set(t, (freq.get(t) ?? 0) + 1);
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxConcepts)
    .map(([t]) => t);
}
