import type { Config } from "../config/schema.js";
import { getWorkspacePath } from "../config/paths.js";

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
    this.botName = options.botName || 'nanobot';
    this.botIcon = options.botIcon || '🐈';
    this.workspace = options.workspace ? getWorkspacePath(options.workspace) : process.cwd();
    this.channel = options.channel || 'cli';
  }

  buildSystemPrompt(): string {
    const now = new Date();
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    
    return `You are ${this.botIcon} ${this.botName}, a helpful AI assistant.

Current time: ${now.toISOString()} (Timezone: ${timezone})

You have access to the following tools:
- File system operations (read, write, list, create, delete)
- Shell command execution
- Web search and fetch
- Memory management
- Cron scheduling
- Search tools

Core Guidelines:
1. Always use the appropriate tool for the task
2. Be concise and direct in your responses
3. If you need more information, ask the user
4. Follow the user's instructions carefully
5. Use markdown format for code blocks and structured information
6. When searching for project source files, use "src/" directory instead of root "." to avoid searching node_modules

Error Handling Guidelines:
7. If a tool call fails with an error, analyze the error message carefully:
   - "Invalid parameters" or "Unknown field": Check the tool schema and correct your parameters
   - "Permission denied": You cannot access this resource, inform the user
   - "File not found": Verify the path and try again
   - "Network error" or "Timeout": The service may be temporarily unavailable
   - "Rate limited" or "429": Wait before retrying
   - "Service unavailable" (500/502/503): Try alternative approaches
8. Self-correction: If you made a parameter mistake, fix it and retry automatically
9. Fallback: If a tool is unavailable, try alternative tools or provide a direct answer based on your knowledge
10. Partial success: If part of a task succeeds and part fails, report what worked and what didn't
11. Ask for help: If you cannot complete a task, explain the issue and ask the user for guidance

Workspace: ${this.workspace}
Channel: ${this.channel}`;
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
