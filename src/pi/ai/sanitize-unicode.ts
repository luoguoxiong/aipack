/**
 * 移除字符串中未配对的 Unicode 代理项（surrogate pairs）。
 *
 * 未配对的 surrogates 会导致许多 API 提供商出现 JSON 序列化错误。
 * 有效的 emoji 和其他基本多语言平面外的字符使用正确配对的 surrogates，
 * 不会受此函数影响。
 */
export function sanitizeSurrogates(text: string): string {
  return text.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    '',
  );
}
