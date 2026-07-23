import type { Config } from "../config/schema";
import { getWorkspacePath } from "../config/paths";

export interface ContextBuilderOptions {
  timezone?: string;
  botName?: string;
  botIcon?: string;
  workspace?: string;
  channel?: string;
}

export class ContextBuilder {
  private timezone: string;
  private botName: string;
  private botIcon: string;
  private workspace: string;
  private channel: string;

  constructor(options: ContextBuilderOptions = {}) {
    this.timezone = options.timezone || 'UTC';
    this.botName = options.botName || 'kobot';
    this.botIcon = options.botIcon || '🐈';
    this.workspace = options.workspace ? getWorkspacePath(options.workspace) : process.cwd();
    this.channel = options.channel || 'cli';
  }

  buildSystemPrompt(): string {
    const now = new Date();
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    
    return `你是 ${this.botIcon} ${this.botName}，一个有用的 AI 助手。

当前时间：${now.toISOString()}（时区：${timezone}）

你可以使用以下工具：
- 文件系统操作（读取、写入、列出、创建、删除）
- Shell 命令执行
- 网络搜索和抓取
- 内存管理
- Cron 调度
- 搜索工具

核心准则：
1. 始终为任务选择合适的工具
2. 回复时简洁直接
3. 如果需要更多信息，请询问用户
4. 仔细遵循用户的指令
5. 对代码块和结构化信息使用 markdown 格式
6. 搜索项目源文件时，使用 "src/" 目录代替根目录 "."，避免搜索 node_modules

错误处理准则：
7. 如果工具调用失败并返回错误，仔细分析错误信息：
   - "无效参数"或"未知字段"：检查工具模式并修正参数
   - "权限被拒绝"：你无法访问该资源，请告知用户
   - "文件未找到"：验证路径后重试
   - "网络错误"或"超时"：服务可能暂时不可用
   - "请求频率限制"或"429"：等待后重试
   - "服务不可用"（500/502/503）：尝试替代方法
8. 自我修正：如果参数出错，自动修复并重试
9. 备选方案：如果某个工具不可用，尝试其他工具或根据知识直接回答
10. 部分成功：如果任务部分成功部分失败，报告哪些成功了哪些没有
11. 请求帮助：如果无法完成任务，说明问题并请求用户指导

工作空间：${this.workspace}
频道：${this.channel}`;
  }

  static create(config: Config): ContextBuilder {
    const defaults = config.agents.defaults;
    return new ContextBuilder({
      timezone: defaults.timezone,
      botName: defaults.bot_name,
      botIcon: defaults.bot_icon,
      workspace: defaults.workspace,
    });
  }
}

export function createContextBuilder(config: Config): ContextBuilder {
  return ContextBuilder.create(config);
}
