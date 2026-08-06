// apps/ai_teaching_agent_team/frontend/src/api.ts
// 与后端 /api/config、/api/teach(SSE) 的类型约定与调用封装。
// SSE 解析逻辑对齐 apps/ai_travel_agent/public/app.js(fetch + ReadableStream + \n\n 分帧)。

export type AgentRole = 'professor' | 'advisor' | 'librarian' | 'ta';

/** 后端 /api/config 返回的模型条目 */
export interface ModelOption {
  provider: string;
  providerName: string;
  modelId: string;
  modelName: string;
  /** 该 provider 是否已配置 API Key(决定前端是否禁用输入) */
  available: boolean;
  reasoning: boolean;
  /** 缺 Key 时提示用户设置的环境变量名 */
  envVar: string;
}

export interface ServerConfig {
  provider: string;
  model: string;
  llmReady: boolean;
  searchBackend: string;
  defaultModel: { provider: string; modelId: string };
  models: ModelOption[];
}

export interface ModelChoice {
  provider: string;
  modelId: string;
}

/** 拉取服务配置 */
export async function fetchConfig(): Promise<ServerConfig> {
  const res = await fetch('/api/config');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as ServerConfig;
}

/** 阶段名 → agent 角色(用于从 stage 事件推断当前 agent) */
const STAGE_AGENT: Record<string, AgentRole> = {
  professor_start: 'professor',
  professor_done: 'professor',
  advisor_start: 'advisor',
  advisor_done: 'advisor',
  librarian_start: 'librarian',
  librarian_done: 'librarian',
  ta_start: 'ta',
  ta_done: 'ta',
};

export type StageName = keyof typeof STAGE_AGENT;

export interface TeachCallbacks {
  onStage?: (stage: StageName, section?: string) => void;
  onDelta?: (agent: AgentRole, delta: string) => void;
  onDone?: (course: string) => void;
  onError?: (message: string) => void;
  signal?: AbortSignal;
}

export interface TeachParams {
  topic: string;
  model?: ModelChoice;
  apiKey?: string;
}

/**
 * 调用 /api/teach 并消费 SSE 流。
 * 解析 event:/data: 帧,分发到对应回调。客户端取消(abort)时静默退出。
 */
export async function streamTeach(params: TeachParams, cb: TeachCallbacks): Promise<void> {
  const { topic, model, apiKey } = params;
  const res = await fetch('/api/teach', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ topic, model, apiKey }),
    signal: cb.signal,
  });

  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error || `HTTP ${res.status}`);
  }

  if (!res.body) throw new Error('响应无 body 流');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE 以 \n\n 分隔事件
    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const raw = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const evt = parseSse(raw);
      if (!evt) continue;

      if (evt.event === 'stage') {
        const stage = evt.data.stage as StageName;
        if (stage && STAGE_AGENT[stage]) {
          cb.onStage?.(stage, typeof evt.data.section === 'string' ? evt.data.section : undefined);
        }
      } else if (evt.event === 'delta') {
        const agent = evt.data.agent as AgentRole;
        if (agent && typeof evt.data.delta === 'string') {
          cb.onDelta?.(agent, evt.data.delta);
        }
      } else if (evt.event === 'done') {
        cb.onDone?.(typeof evt.data.course === 'string' ? evt.data.course : '');
      } else if (evt.event === 'error') {
        cb.onError?.(typeof evt.data.message === 'string' ? evt.data.message : '生成失败');
      }
    }
  }
}

/** 解析单条 SSE 帧 → { event, data } */
function parseSse(raw: string): { event: string; data: Record<string, unknown> } | null {
  let event = 'message';
  const dataLines: string[] = [];
  for (const line of raw.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
  }
  if (dataLines.length === 0) return null;
  try {
    return { event, data: JSON.parse(dataLines.join('\n')) as Record<string, unknown> };
  } catch {
    return { event, data: { raw: dataLines.join('\n') } };
  }
}

/** localStorage key:按 provider 持久化 API Key */
export function apiKeyStorageKey(provider: string): string {
  return `teaching_agent_apikey_${provider}`;
}
