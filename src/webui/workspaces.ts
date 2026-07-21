import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger.js';
import { getProjectConfigDir } from '../config/paths.js';

export const WEBUI_WORKSPACE_STATE_SCHEMA_VERSION = 1;
const MAX_STATE_FILE_BYTES = 128 * 1024;
const DEFAULT_ACCESS_MODES = new Set(['default', 'full']);
const LEGACY_RESTRICTED_DEFAULT_ACCESS_MODE = 'restricted';
const WEBUI_SCOPE_CHANNEL = 'websocket';

export const WORKSPACE_SCOPE_METADATA_KEY = 'workspace_scope';

export interface WorkspaceScope {
  project_path: string;
  restrict_to_workspace: boolean;
  source_channel?: string;
}

export interface WorkspaceState {
  schema_version: number;
  default_access_mode: string;
  updated_at: string | null;
}

export interface WorkspaceControls {
  can_change_project: boolean;
  can_use_full_access: boolean;
}

export interface WorkspacePayload {
  schema_version: number;
  default_access_mode: string;
  default_scope: WorkspaceScope;
  controls: WorkspaceControls;
}

function getWebuiDir(): string {
  return path.join(getProjectConfigDir(), 'webui');
}

export function webuiWorkspaceStatePath(): string {
  return path.join(getWebuiDir(), 'workspace-state.json');
}

export function defaultWebuiWorkspaceState(): WorkspaceState {
  return {
    schema_version: WEBUI_WORKSPACE_STATE_SCHEMA_VERSION,
    default_access_mode: 'default',
    updated_at: null,
  };
}

export function normalizeWebuiWorkspaceState(raw: unknown): WorkspaceState {
  const state = defaultWebuiWorkspaceState();
  if (!raw || typeof raw !== 'object') {
    return state;
  }
  const r = raw as Record<string, unknown>;
  const updatedAt = r.updated_at;
  state.updated_at = typeof updatedAt === 'string' ? updatedAt : null;
  const defaultAccessMode = r.default_access_mode;
  if (typeof defaultAccessMode === 'string' && DEFAULT_ACCESS_MODES.has(defaultAccessMode)) {
    state.default_access_mode = defaultAccessMode;
  }
  return state;
}

export function readWebuiWorkspaceState(): WorkspaceState {
  const filePath = webuiWorkspaceStatePath();
  if (!fs.existsSync(filePath)) {
    return defaultWebuiWorkspaceState();
  }
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_STATE_FILE_BYTES) {
      logger.warn({ path: filePath }, 'webui workspace state too large, ignoring');
      return defaultWebuiWorkspaceState();
    }
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    return normalizeWebuiWorkspaceState(raw);
  } catch (err) {
    logger.warn({ err, path: filePath }, 'read webui workspace state failed');
    return defaultWebuiWorkspaceState();
  }
}

export function writeWebuiWorkspaceState(raw: Partial<WorkspaceState>): WorkspaceState {
  const state = normalizeWebuiWorkspaceState(raw);
  state.updated_at = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const encoded = Buffer.from(JSON.stringify(state, null, 2) + '\n', 'utf-8');
  if (encoded.length > MAX_STATE_FILE_BYTES) {
    throw new Error('workspace state is too large');
  }

  const filePath = webuiWorkspaceStatePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = filePath + '.tmp';
  fs.writeFileSync(tmpPath, encoded);
  fs.renameSync(tmpPath, filePath);
  return state;
}

export function readWebuiDefaultAccessMode(): string {
  const state = readWebuiWorkspaceState();
  const mode = state.default_access_mode;
  return DEFAULT_ACCESS_MODES.has(mode) ? mode : 'default';
}

export function writeWebuiDefaultAccessMode(mode: string): boolean {
  if (mode === LEGACY_RESTRICTED_DEFAULT_ACCESS_MODE) {
    mode = 'default';
  }
  if (!DEFAULT_ACCESS_MODES.has(mode)) {
    throw new Error('default access mode must be default or full');
  }
  const state = readWebuiWorkspaceState();
  const changed = state.default_access_mode !== mode;
  if (changed) {
    state.default_access_mode = mode;
    writeWebuiWorkspaceState(state);
  }
  return changed;
}

function defaultWorkspaceScope(
  defaultWorkspace: string,
  defaultRestrictToWorkspace: boolean,
  sourceChannel?: string,
): WorkspaceScope {
  return {
    project_path: defaultWorkspace,
    restrict_to_workspace: defaultRestrictToWorkspace,
    source_channel: sourceChannel,
  };
}

function buildWorkspaceScope(
  defaultWorkspace: string,
  mode: string,
  sourceChannel?: string,
): WorkspaceScope {
  if (mode === 'full') {
    return {
      project_path: defaultWorkspace,
      restrict_to_workspace: false,
      source_channel: sourceChannel,
    };
  }
  return defaultWorkspaceScope(defaultWorkspace, true, sourceChannel);
}

export function defaultScopeForWebui(
  defaultWorkspace: string,
  defaultRestrictToWorkspace: boolean,
): WorkspaceScope {
  const mode = readWebuiDefaultAccessMode();
  if (mode === 'default') {
    return defaultWorkspaceScope(defaultWorkspace, defaultRestrictToWorkspace, WEBUI_SCOPE_CHANNEL);
  }
  return buildWorkspaceScope(defaultWorkspace, mode, WEBUI_SCOPE_CHANNEL);
}

export function workspacesPayload(options: {
  defaultWorkspace: string;
  defaultRestrictToWorkspace: boolean;
  controlsAvailable: boolean;
}): WorkspacePayload {
  const defaultAccessMode = readWebuiDefaultAccessMode();
  const defaultScope =
    defaultAccessMode === 'default'
      ? defaultWorkspaceScope(
          options.defaultWorkspace,
          options.defaultRestrictToWorkspace,
          WEBUI_SCOPE_CHANNEL,
        )
      : buildWorkspaceScope(options.defaultWorkspace, defaultAccessMode, WEBUI_SCOPE_CHANNEL);
  return {
    schema_version: WEBUI_WORKSPACE_STATE_SCHEMA_VERSION,
    default_access_mode: defaultAccessMode,
    default_scope: defaultScope,
    controls: {
      can_change_project: options.controlsAvailable,
      can_use_full_access: options.controlsAvailable,
    },
  };
}

export class WebUIWorkspaceController {
  private sessions: any;
  private defaultWorkspace: string;
  private defaultRestrictToWorkspace: boolean;

  constructor(options: {
    sessionManager?: any;
    defaultWorkspace: string;
    defaultRestrictToWorkspace: boolean;
  }) {
    this.sessions = options.sessionManager;
    this.defaultWorkspace = options.defaultWorkspace;
    this.defaultRestrictToWorkspace = options.defaultRestrictToWorkspace;
  }

  defaultScope(): WorkspaceScope {
    return defaultScopeForWebui(this.defaultWorkspace, this.defaultRestrictToWorkspace);
  }

  scopeForSessionKey(sessionKey: string): WorkspaceScope {
    if (!this.sessions) {
      return this.defaultScope();
    }
    let data: any;
    try {
      if (typeof this.sessions.readSessionMetadata === 'function') {
        data = this.sessions.readSessionMetadata(sessionKey);
      } else if (typeof this.sessions.readSessionFile === 'function') {
        data = this.sessions.readSessionFile(sessionKey);
      } else if (typeof this.sessions.getSession === 'function') {
        const session = this.sessions.getSession(sessionKey);
        data = session || {};
      } else {
        data = {};
      }
    } catch {
      data = {};
    }
    const metadata = (data && data.metadata) || {};
    if (!metadata || !metadata[WORKSPACE_SCOPE_METADATA_KEY]) {
      return this.defaultScope();
    }
    try {
      const scope = metadata[WORKSPACE_SCOPE_METADATA_KEY] as WorkspaceScope;
      return {
        project_path: scope.project_path || this.defaultWorkspace,
        restrict_to_workspace:
          scope.restrict_to_workspace ?? this.defaultRestrictToWorkspace,
        source_channel: WEBUI_SCOPE_CHANNEL,
      };
    } catch {
      return this.defaultScope();
    }
  }

  payload(controlsAvailable: boolean): WorkspacePayload {
    return workspacesPayload({
      defaultWorkspace: this.defaultWorkspace,
      defaultRestrictToWorkspace: this.defaultRestrictToWorkspace,
      controlsAvailable,
    });
  }

  private scopeChangeIsNonEscalating(
    current: WorkspaceScope,
    requested: WorkspaceScope,
  ): boolean {
    return (
      requested.project_path === current.project_path &&
      (!current.restrict_to_workspace || requested.restrict_to_workspace)
    );
  }

  scopeFromEnvelope(
    envelope: Record<string, unknown>,
    options: {
      sessionKey?: string;
      controlsAvailable: boolean;
    },
  ): WorkspaceScope {
    const current = options.sessionKey
      ? this.scopeForSessionKey(options.sessionKey)
      : this.defaultScope();
    const raw = envelope[WORKSPACE_SCOPE_METADATA_KEY];
    let scope: WorkspaceScope;
    if (!raw) {
      scope = current;
    } else {
      const rawScope = raw as Partial<WorkspaceScope>;
      scope = {
        project_path: rawScope.project_path || this.defaultWorkspace,
        restrict_to_workspace: rawScope.restrict_to_workspace ?? this.defaultRestrictToWorkspace,
        source_channel: WEBUI_SCOPE_CHANNEL,
      };
    }
    if (
      !options.controlsAvailable &&
      !this.scopeChangeIsNonEscalating(current, scope)
    ) {
      throw new Error('workspace controls are localhost-only');
    }
    return scope;
  }

  scopeForNewChat(
    envelope: Record<string, unknown>,
    controlsAvailable: boolean,
  ): WorkspaceScope {
    return this.scopeFromEnvelope(envelope, { controlsAvailable });
  }

  scopeForSetRequest(
    envelope: Record<string, unknown>,
    options: {
      chatId: string;
      chatRunning: boolean;
      controlsAvailable: boolean;
    },
  ): WorkspaceScope {
    if (options.chatRunning) {
      throw new Error('chat_running');
    }
    return this.scopeFromEnvelope(envelope, {
      sessionKey: `websocket:${options.chatId}`,
      controlsAvailable: options.controlsAvailable,
    });
  }

  scopeForMessage(
    envelope: Record<string, unknown>,
    options: {
      chatId: string;
      chatRunning: boolean;
      controlsAvailable: boolean;
    },
  ): WorkspaceScope {
    const scope = this.scopeFromEnvelope(envelope, {
      sessionKey: `websocket:${options.chatId}`,
      controlsAvailable: options.controlsAvailable,
    });
    if (
      WORKSPACE_SCOPE_METADATA_KEY in envelope &&
      options.chatRunning &&
      JSON.stringify(scope) !==
        JSON.stringify(this.scopeForSessionKey(`websocket:${options.chatId}`))
    ) {
      throw new Error('chat_running');
    }
    return scope;
  }

  persistScope(chatId: string, scope: WorkspaceScope): void {
    if (this.sessions && typeof this.sessions.getOrCreate === 'function') {
      const session = this.sessions.getOrCreate(`websocket:${chatId}`);
      if (session) {
        if (!session.metadata) {
          session.metadata = {};
        }
        session.metadata.webui = true;
        session.metadata[WORKSPACE_SCOPE_METADATA_KEY] = {
          project_path: scope.project_path,
          restrict_to_workspace: scope.restrict_to_workspace,
        };
        if (typeof this.sessions.save === 'function') {
          this.sessions.save(session);
        }
      }
    }
  }

  statePayload(): WorkspacePayload {
    return this.payload(true);
  }
}

export const webuiWorkspaceController = new WebUIWorkspaceController({
  defaultWorkspace: path.join(getProjectConfigDir(), 'workspace'),
  defaultRestrictToWorkspace: false,
});

export function validateWorkspaceScope(scope: WorkspaceScope | null | undefined): boolean {
  if (!scope || typeof scope !== 'object') return false;
  return typeof scope.project_path === 'string' && scope.project_path.length > 0;
}

export function workspaceScopeFromQuery(query: Record<string, string>): WorkspaceScope {
  return {
    project_path: query.workspace_path || path.join(getProjectConfigDir(), 'workspace'),
    restrict_to_workspace: query.restrict_to_workspace === 'true',
    source_channel: 'websocket',
  };
}
