export interface RuntimeState {
  model: string;
  max_iterations: number;
  current_iteration: number;
  tool_names: string[];
  workspace: string;
  provider_retry_mode: string;
  max_tool_result_chars: number;
  context_window_tokens: number;
  web_config: unknown;
  exec_config: unknown;
  workspace_sandbox: unknown;
  subagents: unknown;
  _runtime_vars: Record<string, unknown>;
  _last_usage: unknown;
  model_preset: string | null;

  _sync_subagent_runtime_limits(): void;

  set_runtime_model(model: string): void;

  set_runtime_context_window(context_window_tokens: number): void;
}
