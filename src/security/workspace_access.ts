import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger.js';
import { WorkspacePolicy, isPathAllowed, isFileReadAllowed, isFileWriteAllowed } from './workspace_policy.js';

export class WorkspaceAccess {
  private policy: WorkspacePolicy;
  private workspaceRoot: string;

  constructor(workspaceRoot: string, policy?: WorkspacePolicy) {
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.policy = policy || {
      allow_network: true,
      allow_file_read: true,
      allow_file_write: true,
      allow_system: false,
    };
  }

  getPolicy(): WorkspacePolicy {
    return { ...this.policy };
  }

  setPolicy(policy: WorkspacePolicy): void {
    this.policy = policy;
  }

  resolvePath(filePath: string): string {
    const resolved = path.resolve(this.workspaceRoot, filePath);
    if (!resolved.startsWith(this.workspaceRoot)) {
      throw new Error(`Path traversal detected: ${filePath}`);
    }
    return resolved;
  }

  canRead(filePath: string): boolean {
    if (!isFileReadAllowed(this.policy)) {
      return false;
    }
    const resolved = this.resolvePath(filePath);
    return isPathAllowed(this.policy, resolved);
  }

  canWrite(filePath: string): boolean {
    if (!isFileWriteAllowed(this.policy)) {
      return false;
    }
    const resolved = this.resolvePath(filePath);
    return isPathAllowed(this.policy, resolved);
  }

  async readFile(filePath: string): Promise<string> {
    if (!this.canRead(filePath)) {
      throw new Error(`File read not allowed: ${filePath}`);
    }
    const resolved = this.resolvePath(filePath);
    return fs.promises.readFile(resolved, 'utf-8');
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    if (!this.canWrite(filePath)) {
      throw new Error(`File write not allowed: ${filePath}`);
    }
    const resolved = this.resolvePath(filePath);
    const dir = path.dirname(resolved);
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(resolved, content, 'utf-8');
  }

  async listDirectory(dirPath: string): Promise<string[]> {
    if (!this.canRead(dirPath)) {
      throw new Error(`Directory read not allowed: ${dirPath}`);
    }
    const resolved = this.resolvePath(dirPath);
    try {
      const entries = await fs.promises.readdir(resolved);
      return entries;
    } catch (err) {
      logger.debug({ err, path: resolved }, 'Failed to list directory');
      return [];
    }
  }

  async exists(filePath: string): Promise<boolean> {
    if (!isFileReadAllowed(this.policy)) {
      return false;
    }
    try {
      const resolved = this.resolvePath(filePath);
      await fs.promises.access(resolved);
      return true;
    } catch {
      return false;
    }
  }

  async stat(filePath: string): Promise<fs.Stats | null> {
    if (!isFileReadAllowed(this.policy)) {
      return null;
    }
    try {
      const resolved = this.resolvePath(filePath);
      return await fs.promises.stat(resolved);
    } catch {
      return null;
    }
  }
}