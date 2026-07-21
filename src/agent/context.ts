import { ProviderMessage, LLMRuntime } from '../providers/base.js';

export interface ContextBuilderOptions {
  systemPrompt?: string;
  identityPrompt?: string;
  toolPolicy?: string;
  platformPolicy?: string;
  skillSections?: string[];
  memory?: string;
  timezone?: string;
  botName?: string;
  botIcon?: string;
  workspace?: string;
  channel?: string;
}

export class ContextBuilder {
  private options: ContextBuilderOptions;

  constructor(options: ContextBuilderOptions = {}) {
    this.options = {
      timezone: 'UTC',
      botName: 'nanobot',
      botIcon: '🐈',
      ...options,
    };
  }

  buildSystemPrompt(): string {
    const parts: string[] = [];

    if (this.options.identityPrompt) {
      parts.push(this.options.identityPrompt);
    } else {
      parts.push(this.getDefaultIdentity());
    }

    if (this.options.toolPolicy) {
      parts.push(this.options.toolPolicy);
    }

    if (this.options.platformPolicy) {
      parts.push(`# Platform Policy\n${this.options.platformPolicy}`);
    }

    if (this.options.skillSections && this.options.skillSections.length > 0) {
      parts.push(`# Skills\n${this.options.skillSections.join('\n\n')}`);
    }

    if (this.options.memory) {
      parts.push(`# Long-term Memory\n${this.options.memory}`);
    }

    parts.push(this.getRuntimeContext());

    return parts.join('\n\n');
  }

  buildContextMessages(history: ProviderMessage[]): ProviderMessage[] {
    const systemPrompt = this.buildSystemPrompt();
    const messages: ProviderMessage[] = [];

    messages.push({
      role: 'system',
      content: systemPrompt,
    });

    messages.push(...history);

    return messages;
  }

  private getDefaultIdentity(): string {
    const { botName, botIcon, timezone } = this.options;
    return `# Identity

You are ${botName}${botIcon ? ` ${botIcon}` : ''}, a helpful AI assistant.

Current time: ${new Date().toISOString()}
Timezone: ${timezone}

You are helpful, concise, and honest. You use tools when appropriate and always explain what you're doing.`;
  }

  private getRuntimeContext(): string {
    const now = new Date();
    return `# Runtime Info

Current date and time: ${now.toISOString()}
Timezone: ${this.options.timezone || 'UTC'}
Channel: ${this.options.channel || 'unknown'}`;
  }
}

export function createContextBuilder(options?: ContextBuilderOptions): ContextBuilder {
  return new ContextBuilder(options);
}
