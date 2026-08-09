import { useState } from 'react';
import { message } from 'antd';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';

interface CodeBlockProps {
  code: string;
  language?: string;
  showLineNumbers?: boolean;
  compact?: boolean;
}

/**
 * 代码块组件
 *
 * 实现思路：把传入的纯文本 code 包装成一个 markdown 代码块字符串，
 * 交给 react-markdown 解析，再由 rehype-highlight (基于 highlight.js)
 * 做语法高亮。
 *
 * 这样代码字符串本身不需要做任何 HTML 转义，也不会和 JSX / 正则冲突，
 * 彻底解决了手写正则高亮在嵌套替换时破坏 HTML 的问题。
 */
export default function CodeBlock({
  code,
  language = 'typescript',
  compact = false,
}: CodeBlockProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      message.success('已复制到剪贴板');
      setTimeout(() => setCopied(false), 2000);
    } catch {
      message.error('复制失败');
    }
  };

  // 构造 markdown 代码块：```ts\n<code>\n```
  const markdown = '```' + language + '\n' + code + '\n```';

  return (
    <div
      className="code-block"
      style={compact ? { padding: '12px 16px', margin: '8px 0' } : undefined}
    >
      <button
        className="copy-button"
        onClick={handleCopy}
        style={compact ? { top: 8, right: 8 } : undefined}
      >
        {copied ? '✓' : '复制'}
      </button>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
        components={{
          // 让外层 .code-block 控制背景/边框/padding，pre 只负责排版
          pre: ({ children }) => (
            <pre
              style={
                compact
                  ? { fontSize: 13, lineHeight: 1.55, margin: 0, background: 'transparent', padding: 0 }
                  : { margin: 0, background: 'transparent', padding: 0 }
              }
            >
              {children}
            </pre>
          ),
          // 去掉 react-markdown 默认给行内 code 加的 className 干扰；
          // 块级 code 保留 hljs / language-xxx 以触发高亮样式
          code: ({ className, children: codeChildren, ...rest }) => (
            <code className={className} {...rest}>
              {codeChildren}
            </code>
          ),
        }}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  );
}
