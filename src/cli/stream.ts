import { logger } from '../utils/logger.js';

export interface StreamRendererOptions {
  showReasoning?: boolean;
  showToolCalls?: boolean;
  showFileEdits?: boolean;
  colorEnabled?: boolean;
}

export class StreamRenderer {
  private options: StreamRendererOptions;
  private buffer: string = '';

  constructor(options: StreamRendererOptions = {}) {
    this.options = {
      showReasoning: true,
      showToolCalls: true,
      showFileEdits: true,
      colorEnabled: true,
      ...options,
    };
  }

  private color(text: string, color: string): string {
    if (!this.options.colorEnabled) return text;
    const colors: Record<string, string> = {
      reset: '\x1b[0m',
      bold: '\x1b[1m',
      green: '\x1b[32m',
      yellow: '\x1b[33m',
      cyan: '\x1b[36m',
      gray: '\x1b[90m',
      red: '\x1b[31m',
    };
    return `${colors[color] || ''}${text}${colors.reset}`;
  }

  renderTextDelta(delta: string): void {
    this.buffer += delta;
    process.stdout.write(delta);
  }

  renderReasoningDelta(delta: string): void {
    if (!this.options.showReasoning) return;
    process.stdout.write(this.color(delta, 'gray'));
  }

  renderToolStarted(opts: { tool_name: string; call_id: string }): void {
    if (!this.options.showToolCalls) return;
    process.stdout.write('\n' + this.color(`🔧 ${opts.tool_name}`, 'cyan') + '\n');
  }

  renderToolCompleted(opts: { tool_name: string; call_id: string; result?: string }): void {
    if (!this.options.showToolCalls) return;
    if (opts.result) {
      process.stdout.write(this.color(`↩️  ${opts.tool_name}:\n`, 'green'));
      process.stdout.write(opts.result + '\n');
    }
  }

  renderFileEdit(opts: { file_path: string; edit_type: string; action?: string }): void {
    if (!this.options.showFileEdits) return;
    const icon = opts.edit_type === 'start' ? '📝' : opts.edit_type === 'error' ? '❌' : '✅';
    const color = opts.edit_type === 'error' ? 'red' : 'green';
    process.stdout.write('\n' + this.color(`${icon} ${opts.action || ''} ${opts.file_path}`, color) + '\n');
  }

  renderError(error: string): void {
    process.stdout.write('\n' + this.color(`❌ Error: ${error}`, 'red') + '\n');
  }

  renderComplete(): void {
    if (this.buffer.trim()) {
      process.stdout.write('\n');
    }
    this.buffer = '';
  }

  renderHeader(title: string): void {
    process.stdout.write('\n' + this.color(`=== ${title} ===`, 'bold') + '\n');
  }

  renderSeparator(): void {
    process.stdout.write(this.color('─'.repeat(60), 'gray') + '\n');
  }
}

export async function streamToConsole(
  stream: AsyncIterable<Record<string, unknown>>,
  options: StreamRendererOptions = {},
): Promise<void> {
  const renderer = new StreamRenderer(options);

  try {
    for await (const event of stream) {
      const type = event.type as string;
      switch (type) {
        case 'text_delta':
          renderer.renderTextDelta((event.content as string) || '');
          break;
        case 'reasoning_delta':
          renderer.renderReasoningDelta((event.content as string) || '');
          break;
        case 'tool_started':
          renderer.renderToolStarted({
            tool_name: event.tool_name as string,
            call_id: event.call_id as string,
          });
          break;
        case 'tool_completed':
          renderer.renderToolCompleted({
            tool_name: event.tool_name as string,
            call_id: event.call_id as string,
            result: event.result as string,
          });
          break;
        case 'file_edit': {
          const fe = event.file_edit as Record<string, unknown>;
          renderer.renderFileEdit({
            file_path: fe.file_path as string,
            edit_type: fe.edit_type as string,
            action: fe.action as string,
          });
          break;
        }
        case 'run_completed':
          renderer.renderComplete();
          break;
        case 'run_failed':
          renderer.renderError((event.error as string) || 'Unknown error');
          renderer.renderComplete();
          break;
        default:
          break;
      }
    }
  } catch (err) {
    logger.error({ err }, 'Stream rendering error');
    renderer.renderError((err as Error).message);
  }
}