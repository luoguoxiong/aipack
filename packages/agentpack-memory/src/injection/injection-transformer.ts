/**
 * 记忆注入转换器。
 *
 * 在 Pipeline 中最先执行（priority 5），每轮「先剥后注」：
 *   1. 剥除所有 user_message 资源内容中已存在的 sentinel 记忆块（清上轮注入，
 *      含已持久化进 session 的）。
 *   2. 取最新 user_message 的纯文本作为检索 query。
 *   3. HybridRetriever 取 top-K，过滤 minScore。
 *   4. 非空则把记忆块前插进最新 user 消息内容（string / ContentBlock[] 两分支）。
 *
 * 为何合并进最新 user 消息而非新增独立资源或 system 资源：
 *   - agentpack buildContext 会过滤 role==='system' 消息（runtime/index.ts:585），
 *     故 system 注入不会到达模型；
 *   - 新增独立 user 资源会产生「连续两条 user 消息」，部分 provider 解析异常；
 *   - 合并进最新 user 消息语义自然，且 content 中的 sentinel 可跨轮识别剥离。
 */

import { BaseTransformer } from 'agentpack';
import type { ContextResource, ContentBlock, TextContent } from 'agentpack';
import { ContextResourceBuilder } from 'agentpack';
import type { HybridRetriever } from '../retrieval/hybrid-retriever';
import {
  buildMemoryBlock,
  hasMemoryBlock,
  stripMemoryBlock,
} from './sentinels';

export interface InjectionOptions {
  enabled?: boolean;
  /** 优先级，默认 5（最先执行） */
  priority?: number;
  /** 注入 top-K，默认 5 */
  maxMemories?: number;
  /** 最低分数阈值，默认 0.1 */
  minScore?: number;
  /** 可选：对检索 query 做变换（如抽取提问主体） */
  queryTransform?: (latestUserText: string) => string;
  /** 可选：命中记忆后的回调（插件层装配为 store.touchRecall，更新检索统计） */
  onRecall?: (ids: string[]) => void | Promise<void>;
}

export class MemoryInjectionTransformer extends BaseTransformer {
  readonly name = 'memory-injection';

  private retriever: HybridRetriever;
  private maxMemories: number;
  private queryTransform?: (text: string) => string;
  private onRecall?: (ids: string[]) => void | Promise<void>;

  constructor(retriever: HybridRetriever, options: InjectionOptions = {}) {
    super({
      enabled: options.enabled ?? true,
      priority: options.priority ?? 5,
    });
    this.retriever = retriever;
    this.maxMemories = options.maxMemories ?? 5;
    this.queryTransform = options.queryTransform;
    this.onRecall = options.onRecall;
    // minScore 由 retriever 内部过滤；这里同步更新 retriever 阈值
    if (options.minScore != null) {
      this.retriever.minScore = options.minScore;
    }
  }

  protected async run(
    resources: ContextResource[],
    _context: import('agentpack').TransformContext,
  ): Promise<ContextResource[]> {
    if (resources.length === 0) return resources;

    // 1. 剥除所有 user_message 资源中的旧 sentinel 块（不可变：重建新资源）
    let cleaned = resources.map((r) => this.stripResource(r));

    // 2. 找最新 user_message（数组中最后一个 user_message）
    let latestIdx = -1;
    for (let i = cleaned.length - 1; i >= 0; i--) {
      if (cleaned[i].type === 'user_message') {
        latestIdx = i;
        break;
      }
    }
    if (latestIdx === -1) return cleaned;

    const latest = cleaned[latestIdx];
    const queryText = this.extractUserText(latest);
    if (!queryText || !queryText.trim()) return cleaned;

    const query = this.queryTransform ? this.queryTransform(queryText) : queryText;

    // 3. 检索 top-K
    const results = await this.retriever.search(query, this.maxMemories);
    if (results.length === 0) return cleaned;

    // 更新检索统计（best-effort，不阻塞注入）
    if (this.onRecall) {
      try {
        await this.onRecall(results.map((r) => r.entry.id));
      } catch {
        // 忽略统计失败
      }
    }

    // 4. 构造记忆块并前插进最新 user 消息内容
    const block = buildMemoryBlock(results);
    const injected = this.injectIntoResource(latest, block);

    cleaned = [...cleaned];
    cleaned[latestIdx] = injected;
    return cleaned;
  }

  // ─── 工具方法 ───────────────────────────────────────────────────

  /** 从资源中抽取纯文本（兼容 string 与 ContentBlock[]） */
  private extractUserText(resource: ContextResource): string {
    const content = resource.content;
    if (typeof content === 'string') return stripMemoryBlock(content);
    if (Array.isArray(content)) {
      // 拼接所有文本块（已剥除 sentinel）
      return content
        .map((b) => (this.isTextBlock(b) ? stripMemoryBlock(b.text) : ''))
        .join('')
        .trim();
    }
    return '';
  }

  private isTextBlock(b: ContentBlock): b is TextContent {
    return (b as TextContent).type === 'text';
  }

  /** 剥除单个资源中的 sentinel 块，返回新资源（若无需剥除返回原资源） */
  private stripResource(resource: ContextResource): ContextResource {
    if (resource.type !== 'user_message') return resource;
    const content = resource.content;

    if (typeof content === 'string') {
      if (!hasMemoryBlock(content)) return resource;
      return this.rebuildResource(resource, stripMemoryBlock(content));
    }

    if (Array.isArray(content)) {
      let changed = false;
      const newBlocks: ContentBlock[] = [];
      for (const b of content) {
        if (this.isTextBlock(b)) {
          if (!hasMemoryBlock(b.text)) {
            newBlocks.push(b);
            continue;
          }
          const stripped = stripMemoryBlock(b.text);
          if (stripped) {
            newBlocks.push({ type: 'text', text: stripped } as TextContent);
          }
          changed = true;
        } else {
          newBlocks.push(b);
        }
      }
      if (!changed) return resource;
      return this.rebuildResource(resource, newBlocks);
    }

    return resource;
  }

  /** 把记忆块前插进资源内容 */
  private injectIntoResource(resource: ContextResource, block: string): ContextResource {
    const content = resource.content;

    if (typeof content === 'string') {
      const original = stripMemoryBlock(content);
      const injected = `${block}\n\n${original}`;
      return this.rebuildResource(resource, injected);
    }

    if (Array.isArray(content)) {
      // 过滤掉旧 sentinel 文本块，再前插新 sentinel 文本块（保留图片等非文本块）
      const kept: ContentBlock[] = content.filter(
        (b) => !(this.isTextBlock(b) && hasMemoryBlock(b.text)),
      );
      const injected: ContentBlock[] = [
        { type: 'text', text: `${block}\n\n` } as TextContent,
        ...kept,
      ];
      return this.rebuildResource(resource, injected);
    }

    return resource;
  }

  /** 重建资源（保持 id/type/role/timestamp/dependencies/meta/pinned，替换 content） */
  private rebuildResource(
    resource: ContextResource,
    content: string | ContentBlock[],
  ): ContextResource {
    return new ContextResourceBuilder()
      .id(resource.id)
      .type(resource.type)
      .role(resource.role)
      .content(content)
      .timestamp(resource.timestamp)
      .pinned(resource.pinned)
      .build();
  }
}
