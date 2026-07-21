export function ensureSingleModelSelector(options: {
  model?: string;
  model_preset?: string;
}): void {
  if (options.model !== undefined && options.model_preset !== undefined) {
    throw new Error("model and model_preset are mutually exclusive");
  }
}

export function buildProcessDirectKwargs(options: {
  session_key: string;
  channel: string;
  chat_id: string;
  sender_id: string;
  media?: string[];
  ephemeral: boolean;
  on_stream?: unknown;
  on_stream_end?: unknown;
}): Record<string, unknown> {
  const kwargs: Record<string, unknown> = { session_key: options.session_key };
  if (options.channel !== "cli") {
    kwargs.channel = options.channel;
  }
  if (options.chat_id !== "direct") {
    kwargs.chat_id = options.chat_id;
  }
  if (options.sender_id !== "user") {
    kwargs.sender_id = options.sender_id;
  }
  if (options.media !== undefined) {
    kwargs.media = options.media;
  }
  if (options.ephemeral) {
    kwargs.ephemeral = true;
    kwargs._run_extra_hooks_for_ephemeral = true;
  }
  if (options.on_stream !== undefined) {
    kwargs.on_stream = options.on_stream;
  }
  if (options.on_stream_end !== undefined) {
    kwargs.on_stream_end = options.on_stream_end;
  }
  return kwargs;
}