import { logger } from './logger.js';
import { renderPrompt } from './prompt_templates.js';
import {
  WORKSPACE_PROMPT_MAX_CHARS,
  hasWorkspacePromptOverride,
  loadWorkspacePromptOverride,
  workspacePromptFile,
} from './workspace_prompts.js';
import type { LLMProvider, LLMRuntime, ProviderMessage, ProviderToolDefinition } from '../providers/base.js';

const EVALUATOR_PROMPT_MAX_CHARS = WORKSPACE_PROMPT_MAX_CHARS;

export function evaluatorPromptFile(workspace: string): string {
  return workspacePromptFile(workspace, 'evaluator');
}

export function hasEvaluatorPromptOverride(workspace: string): boolean {
  return hasWorkspacePromptOverride(evaluatorPromptFile(workspace));
}

export function defaultEvaluatorPrompt(): string {
  return '# Evaluator\n\nYou are a notification evaluator.';
}

export function resolveEvaluatorPrompt(workspace: string): string {
  const { text, original_chars } = loadWorkspacePromptOverride(evaluatorPromptFile(workspace));
  if (text !== null) {
    if (original_chars > EVALUATOR_PROMPT_MAX_CHARS) {
      logger.warn(
        `Workspace heartbeat evaluator prompt exceeds ${EVALUATOR_PROMPT_MAX_CHARS} chars (${original_chars}); truncating.`,
      );
    }
    return text;
  }
  return defaultEvaluatorPrompt();
}

const _EVALUATE_TOOL: ProviderToolDefinition[] = [
  {
    name: 'evaluate_notification',
    description: 'Decide whether the user should be notified about this background task result.',
    input_schema: {
      type: 'object',
      properties: {
        should_notify: {
          type: 'boolean',
          description: 'true = result contains actionable/important info the user should see; false = routine or empty, safe to suppress',
        },
        reason: {
          type: 'string',
          description: 'One-sentence reason for the decision',
        },
      },
      required: ['should_notify'],
    },
  },
];

export async function evaluateResponse(
  response: string,
  taskContext: string,
  provider: LLMProvider,
  model: string,
  evaluatorPrompt: string,
  defaultNotify: boolean = false,
): Promise<boolean> {
  try {
    const runtime: LLMRuntime = {
      model,
      provider: provider.name,
      max_tokens: 4096,
      context_window_tokens: 4096,
      temperature: 0.0,
    };

    const messages: ProviderMessage[] = [
      { role: 'system', content: evaluatorPrompt },
      {
        role: 'user',
        content: renderPrompt('Task: {{task_context}}\n\nResponse: {{response}}', {
          task_context: taskContext,
          response,
        }),
      },
    ];

    const llmResponse = await provider.complete(messages, _EVALUATE_TOOL, runtime);

    if (!llmResponse.tool_calls.length) {
      logger.warn(`evaluate_response: no tool call returned, defaulting to notify=${defaultNotify}`);
      return defaultNotify;
    }

    const args = llmResponse.tool_calls[0].arguments as Record<string, unknown> || {};
    const shouldNotify = args.should_notify ?? defaultNotify;
    const reason = args.reason ?? '';
    logger.info(`evaluate_response: should_notify=${shouldNotify}, reason=${reason}`);
    return Boolean(shouldNotify);
  } catch {
    logger.error(`evaluate_response failed, defaulting to notify=${defaultNotify}`);
    return defaultNotify;
  }
}