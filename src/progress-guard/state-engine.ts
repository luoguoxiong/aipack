/**
 * State Engine — 维护资源状态，生成 StateSnapshot
 */

import type {
  ResourceState,
  ResourceType,
  StateSnapshot,
  ToolIntent,
} from './types';
import { simpleHash } from './trace-collector';

export class StateEngine {
  private resources: Record<string, ResourceState> = {};
  private lastSnapshot: StateSnapshot;
  private errorHashes: string[] = [];

  constructor() {
    this.lastSnapshot = this.createSnapshot();
  }

  /** 获取当前快照 */
  getSnapshot(): StateSnapshot {
    return this.lastSnapshot;
  }

  /** 更新读操作 */
  recordRead(resourceType: ResourceType, resourceId: string, outputHash: string): StateSnapshot {
    const key = `${resourceType}:${resourceId}`;
    const existing = this.resources[key];

    if (existing) {
      existing.accessCount++;
      existing.lastModified = Date.now();
    } else {
      this.resources[key] = {
        type: resourceType,
        id: resourceId,
        hash: outputHash,
        lastModified: Date.now(),
        accessCount: 1,
        modifyCount: 0,
      };
    }

    this.lastSnapshot = this.createSnapshot();
    return this.lastSnapshot;
  }

  /** 更新写操作，返回新旧快照 */
  recordWrite(
    resourceType: ResourceType,
    resourceId: string,
    contentHash: string,
  ): { before: StateSnapshot; after: StateSnapshot } {
    const before = this.lastSnapshot;
    const key = `${resourceType}:${resourceId}`;
    const existing = this.resources[key];

    if (existing) {
      existing.hash = contentHash;
      existing.modifyCount++;
      existing.lastModified = Date.now();
    } else {
      this.resources[key] = {
        type: resourceType,
        id: resourceId,
        hash: contentHash,
        lastModified: Date.now(),
        accessCount: 0,
        modifyCount: 1,
      };
    }

    this.lastSnapshot = this.createSnapshot();
    return { before, after: this.lastSnapshot };
  }

  /** 记录错误 */
  recordError(errorHash: string): void {
    this.errorHashes.push(errorHash);
    if (this.errorHashes.length > 20) {
      this.errorHashes = this.errorHashes.slice(-20);
    }
    this.lastSnapshot = this.createSnapshot();
  }

  /** 处理不可追踪操作（如 shell），保守假设状态可能变化 */
  recordUntracked(): void {
    // 不可追踪操作不改变具体资源，但更新时间戳
    this.lastSnapshot = this.createSnapshot();
  }

  /** 根据意图更新状态，返回 before/after */
  update(
    intent: ToolIntent,
    resourceType: ResourceType,
    resourceId: string | undefined,
    outputHash: string,
    errorHash?: string,
  ): { before: StateSnapshot; after: StateSnapshot } {
    const before = this.lastSnapshot;

    switch (intent) {
      case 'READ':
      case 'RESEARCH':
        if (resourceId) {
          this.recordRead(resourceType, resourceId, outputHash);
        }
        break;

      case 'MODIFY':
        if (resourceId) {
          this.recordWrite(resourceType, resourceId, outputHash);
        } else {
          this.recordUntracked();
        }
        break;

      case 'VERIFY':
        // 验证操作只更新错误状态
        break;

      case 'MEMORY':
        if (resourceId) {
          this.recordWrite(resourceType, resourceId, outputHash);
        }
        break;

      case 'SCHEDULE':
      case 'OTHER':
        this.recordUntracked();
        break;
    }

    if (errorHash) {
      this.recordError(errorHash);
    }

    return { before, after: this.lastSnapshot };
  }

  /** 获取指定资源 */
  getResource(key: string): ResourceState | undefined {
    return this.resources[key];
  }

  /** 获取所有被修改过的资源 ID */
  getModifiedResourceIds(): string[] {
    return Object.values(this.resources)
      .filter(r => r.modifyCount > 0)
      .map(r => `${r.type}:${r.id}`);
  }

  /** 获取最近的错误哈希 */
  getRecentErrors(n: number = 5): string[] {
    return this.errorHashes.slice(-n);
  }

  /** 生成快照 */
  private createSnapshot(): StateSnapshot {
    const resourceEntries = Object.entries(this.resources);
    const modifiedCount = resourceEntries.filter(([, r]) => r.modifyCount > 0).length;

    // 综合哈希：所有资源的 hash 拼接
    const hashParts = resourceEntries
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, r]) => `${key}:${r.hash}`)
      .join('|');
    const stateHash = simpleHash(hashParts);

    // 错误哈希
    const errorHash = simpleHash(this.errorHashes.join('|'));

    return {
      resources: { ...this.resources },
      stateHash,
      modifiedCount,
      errorHash,
      timestamp: Date.now(),
    };
  }

  /** 重置 */
  reset(): void {
    this.resources = {};
    this.errorHashes = [];
    this.lastSnapshot = this.createSnapshot();
  }
}
