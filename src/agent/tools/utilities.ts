import { BaseTool, ToolContext, ToolResult, createToolResult, createToolError } from './base.js';
import { z } from 'zod';
import os from 'os';

const SystemInfoSchema = z.object({});

export class SystemInfoTool extends BaseTool {
  name = 'system_info';
  description = 'Get information about the current system and environment.';
  input_schema = SystemInfoSchema;
  tags = ['system'];

  async execute(_args: unknown, _context: ToolContext): Promise<ToolResult> {
    const info = {
      platform: os.platform(),
      arch: os.arch(),
      release: os.release(),
      hostname: os.hostname(),
      cpus: os.cpus().length,
      total_memory_mb: Math.round(os.totalmem() / (1024 * 1024)),
      free_memory_mb: Math.round(os.freemem() / (1024 * 1024)),
      homedir: os.homedir(),
      uptime_seconds: Math.round(os.uptime()),
      node_version: process.version,
    };
    
    return createToolResult(JSON.stringify(info, null, 2));
  }
}

export function getUtilityTools(): BaseTool[] {
  return [new SystemInfoTool()];
}
