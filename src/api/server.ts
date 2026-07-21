import http from 'http';
import crypto from 'crypto';
import express from 'express';
import { WebSocketServer } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../utils/logger.js';
import { Nanobot } from '../nanobot.js';
import { getConfigPath } from '../config/loader.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../../');
import {
  webuiSettingsPayload,
  updateWebuiSettings,
} from '../webui/settings_api.js';
import {
  webuiSkillsPayload,
  webuiSkillDetailPayload,
} from '../webui/skills_api.js';
import {
  filePreviewPayload,
  filePreviewAvailabilityPayload,
} from '../webui/file_preview.js';
import { checkForUpdate } from '../webui/version_check.js';
import {
  tokenUsagePayload,
  recordTokenUsage,
} from '../webui/token_usage.js';
import {
  readWebuiSidebarState,
  writeWebuiSidebarState,
} from '../webui/sidebar_state.js';
import { listWebuiSessions } from '../webui/session_list_index.js';
import {
  readTranscriptLines,
  appendTranscriptObject,
  deleteWebuiTranscript,
} from '../webui/transcript.js';
import {
  saveAttachment,
  getAttachment,
  deleteAttachment,
} from '../webui/attachment_ingress.js';
import { wsLogger } from '../webui/websocket_logging.js';
import {
  webuiWorkspaceController,
  validateWorkspaceScope,
  workspaceScopeFromQuery,
} from '../webui/workspaces.js';
import { signMediaPath, serveSignedMedia } from '../webui/media_api.js';
import type { WorkspaceScope } from '../webui/workspaces.js';
import { cronStore } from '../agent/tools/cron_store.js';
import { setupSettingsRoutes } from './settings_routes.js';

export interface ApiServerConfig {
  host?: string;
  port?: number;
  apiKeys?: string[];
  corsOrigins?: string[];
}

function chatIdFromKey(key: string): string {
  const idx = key.indexOf(':');
  return idx >= 0 ? key.slice(idx + 1) : key;
}

export class ApiServer {
  private config: ApiServerConfig;
  private server?: http.Server;
  private app: express.Express;
  private wss?: WebSocketServer;
  private chatWss?: WebSocketServer;
  private bot: Nanobot;
  private running = false;
  private mediaSecret: Buffer;
  private defaultWorkspace: string;

  constructor(bot: Nanobot, config: ApiServerConfig = {}) {
    this.bot = bot;
    this.config = {
      host: '127.0.0.1',
      port: 8000,
      apiKeys: [],
      corsOrigins: [],
      ...config,
    };
    this.mediaSecret = crypto.randomBytes(32);
    this.defaultWorkspace = (bot as any).config?.agents?.defaults?.workspace || process.cwd();
    this.app = express();
    this.setupMiddleware();
    this.setupRoutes();
  }

  private setupMiddleware(): void {
    this.app.use(express.json({ limit: '10mb' }));
    this.app.use(express.urlencoded({ extended: true, limit: '10mb' }));
    this.app.use((req, res, next) => {
      this.setCorsHeaders(res, req);
      if (req.method === 'OPTIONS') {
        res.sendStatus(204);
        return;
      }
      next();
    });
    this.app.use((req, _res, next) => {
      logger.debug({ method: req.method, path: req.path }, 'API request');
      next();
    });
  }

  private getDefaultWorkspace(): string {
    return this.defaultWorkspace;
  }

  private getScope(req: express.Request): WorkspaceScope {
    return workspaceScopeFromQuery(req.query as Record<string, string>);
  }

  private setupRoutes(): void {
    const router = express.Router();

    router.get('/health', (_req, res) => {
      res.json({ status: 'ok' });
    });

    // --- WebUI Bootstrap endpoint ---
    // Returns token + WebSocket path for frontend connection
    this.app.get('/webui/bootstrap', (_req, res) => {
      const token = crypto.randomBytes(24).toString('hex');
      const apiToken = crypto.randomBytes(24).toString('hex');
      const config = (this.bot as any).config;
      res.json({
        token,
        api_token: apiToken,
        ws_path: '/api/ws/chat',
        ws_url: null,
        expires_in: 3600,
        model_name: config.agents.defaults.model,
        runtime_surface: 'browser',
        runtime_capabilities: {
          can_export_diagnostics: false,
          can_open_logs: false,
          can_pick_folder: false,
          can_restart_engine: false,
        },
      });
    });

    // --- /api/settings endpoints ---
    setupSettingsRoutes(this.app);

    router.get('/settings/version-check', async (_req, res) => {
      try {
        const pkg = await import('../../package.json', { with: { type: 'json' } });
        const currentVersion = (pkg.default as { version: string }).version || '0.0.0';
        const result = await checkForUpdate(currentVersion);
        res.json(result || { updateAvailable: false });
      } catch {
        res.json({ updateAvailable: false });
      }
    });

    router.get('/settings/api-service', (_req, res) => {
      res.json({ running: this.running, host: this.config.host, port: this.config.port });
    });

    // --- Sessions list (for WebUI sidebar) ---
    router.get('/sessions', async (_req, res) => {
      try {
        const sessionManager = this.bot.getSessionManager();
        const keys = await sessionManager.listSessions();
        const sessions = [];
        for (const key of keys) {
          if (!key.startsWith('websocket:')) continue;
          const session = await sessionManager.getSession(key);
          if (!session) continue;
          // Find first user message for preview
          const firstUserMsg = session.messages.find(m => m.role === 'user');
          const preview = firstUserMsg
            ? (typeof firstUserMsg.content === 'string' ? firstUserMsg.content : '').slice(0, 100)
            : '';
          sessions.push({
            key,
            channel: 'websocket',
            chatId: chatIdFromKey(key),
            createdAt: session.created_at,
            updatedAt: session.updated_at,
            title: '',
            preview,
            runStartedAt: null,
            workspaceScope: null,
          });
        }
        res.json({ sessions });
      } catch (err) {
        logger.error({ err }, 'Failed to list sessions');
        res.json({ sessions: [] });
      }
    });

    // --- WebUI thread (chat history for a session) ---
    router.get('/sessions/:key/webui-thread', async (req, res) => {
      try {
        const key = decodeURIComponent(req.params.key);
        if (!key.startsWith('websocket:')) {
          res.status(404).json({ error: 'session not found' });
          return;
        }
        const sessionManager = this.bot.getSessionManager();
        const session = await sessionManager.getSession(key);
        if (!session) {
          res.status(404).json({ error: 'session not found' });
          return;
        }
        // Convert session messages to UIMessage format
        // Filter out empty assistant messages (tool call wrappers with no text content)
        const messages = session.messages
          .filter(m => m.role === 'user' || m.role === 'assistant')
          .filter(m => {
            const content = typeof m.content === 'string' ? m.content : '';
            return m.role === 'user' || content.trim().length > 0;
          })
          .map((m, i) => ({
            id: `${key}-${i}`,
            role: m.role,
            content: typeof m.content === 'string' ? m.content : '',
            createdAt: new Date(m.timestamp).getTime(),
          }));
        res.json({
          schemaVersion: 1,
          sessionKey: key,
          savedAt: session.updated_at,
          messages,
        });
      } catch (err) {
        logger.error({ err }, 'Failed to get webui thread');
        res.status(500).json({ error: 'Failed to get thread' });
      }
    });

    // --- File preview ---
    router.get('/sessions/:key/file-preview', async (req, res) => {
      try {
        const key = decodeURIComponent(req.params.key);
        if (!key.startsWith('websocket:')) {
          res.status(404).json({ error: 'session not found' });
          return;
        }
        const filePath = req.query.path as string;
        if (!filePath) {
          res.status(400).json({ error: 'path is required' });
          return;
        }

        const probe = req.query.probe === '1';

        // Resolve path
        const fs = await import('fs/promises');
        const pathModule = await import('path');
        let resolvedPath = filePath;
        if (!pathModule.isAbsolute(resolvedPath)) {
          const workspace = this.getDefaultWorkspace();
          resolvedPath = pathModule.resolve(workspace, resolvedPath);
        }

        // For probe requests, just check if file exists and is readable
        if (probe) {
          try {
            const stat = await fs.stat(resolvedPath);
            res.json({ available: stat.isFile() });
          } catch {
            res.json({ available: false });
          }
          return;
        }

        // Read file content
        const stat = await fs.stat(resolvedPath);
        if (!stat.isFile()) {
          res.status(404).json({ error: 'not a file' });
          return;
        }

        const MAX_SIZE = 512 * 1024; // 512KB
        const truncated = stat.size > MAX_SIZE;
        const content = await fs.readFile(resolvedPath, 'utf-8');

        // Detect language from extension
        const ext = pathModule.extname(resolvedPath).slice(1).toLowerCase();
        const langMap: Record<string, string> = {
          ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
          py: 'python', json: 'json', md: 'markdown', html: 'html', css: 'css',
          scss: 'scss', go: 'go', rs: 'rust', java: 'java', c: 'c', cpp: 'cpp',
          sh: 'bash', yml: 'yaml', yaml: 'yaml', xml: 'xml', sql: 'sql',
        };

        const workspace = this.getDefaultWorkspace();
        const relativePath = pathModule.relative(workspace, resolvedPath);
        const displayPath = relativePath && !relativePath.startsWith('..')
          ? relativePath
          : pathModule.basename(resolvedPath);

        res.json({
          path: filePath,
          display_path: displayPath,
          project_path: workspace,
          language: langMap[ext] || 'plaintext',
          content: truncated ? content.slice(0, MAX_SIZE) : content,
          size: stat.size,
          truncated,
        });
      } catch (err) {
        logger.error({ err }, 'Failed to get file preview');
        res.status(404).json({ error: 'file not found' });
      }
    });

    // --- Delete session ---
    router.delete('/sessions/:key', async (req, res) => {
      try {
        const key = decodeURIComponent(req.params.key);
        const sessionManager = this.bot.getSessionManager();
        await sessionManager.deleteSession(key);
        res.json({ deleted: true, key });
      } catch (err) {
        logger.error({ err }, 'Failed to delete session');
        res.status(500).json({ error: 'Failed to delete session' });
      }
    });

    // --- Delete session (alternate path) ---
    router.delete('/sessions/:key/delete', async (req, res) => {
      try {
        const key = decodeURIComponent(req.params.key);
        const sessionManager = this.bot.getSessionManager();
        await sessionManager.deleteSession(key);
        res.json({ deleted: true, key });
      } catch (err) {
        logger.error({ err }, 'Failed to delete session');
        res.status(500).json({ error: 'Failed to delete session' });
      }
    });

    // --- Commands list ---
    router.get('/commands', (_req, res) => {
      res.json({ commands: [] });
    });

    // --- Workspaces ---
    router.get('/workspaces', (_req, res) => {
      const workspace = this.getDefaultWorkspace();
      res.json({
        schema_version: 1,
        default_access_mode: 'default',
        default_scope: {
          project_path: workspace,
          project_name: path.basename(workspace) || 'workspace',
          access_mode: 'default',
          source_channel: 'webui',
        },
        controls: {
          can_change_project: false,
          can_use_full_access: false,
        },
      });
    });

    // --- Automations ---
    router.get('/webui/automations', (_req, res) => {
      const jobs = cronStore.list().map(job => ({
        id: job.id,
        name: job.description || job.message.slice(0, 50),
        enabled: job.enabled,
        schedule: { kind: job.schedule.kind, expr: job.schedule.kind === 'cron' ? job.schedule.expr || '' : '', tz: job.schedule.tz || '', at_ms: null, every_ms: job.schedule.kind === 'every' ? job.schedule.every_ms || null : null },
        payload: { message: job.message, kind: 'message' },
        state: { next_run_at_ms: null, last_status: null, pending: false },
        protected: false,
        delete_after_run: false,
        created_at_ms: new Date(job.created_at).getTime(),
        updated_at_ms: new Date(job.created_at).getTime(),
        origin: { session_key: '', channel: 'webui', chat_id: '', title: '', preview: '' },
      }));
      res.json({ jobs });
    });
    router.get('/sessions/:key/automations', (req, res) => {
      const sessionKey = decodeURIComponent(req.params.key);
      const jobs = cronStore.list()
        .map(job => ({
          id: job.id,
          name: job.description || job.message.slice(0, 50),
          enabled: job.enabled,
          schedule: { kind: 'cron', expr: job.schedule, tz: '', at_ms: null, every_ms: null },
          payload: { message: job.message, kind: 'message' },
          state: { next_run_at_ms: null, last_status: null, pending: false },
        }));
      res.json({ jobs });
    });
    router.get('/webui/automations/enable', (req, res) => {
      const jobId = req.query.id as string;
      if (!jobId) {
        res.status(400).json({ error: 'missing automation id' });
        return;
      }
      const job = cronStore.get(jobId);
      if (!job) {
        res.status(404).json({ error: 'automation not found' });
        return;
      }
      if (jobId === 'heartbeat') {
        res.status(403).json({ error: 'system automation is protected' });
        return;
      }
      job.enabled = true;
      const jobs = cronStore.list().map(j => ({
        id: j.id,
        name: j.description || j.message.slice(0, 50),
        enabled: j.enabled,
        schedule: { kind: j.schedule.kind, expr: j.schedule.kind === 'cron' ? j.schedule.expr || '' : '', tz: j.schedule.tz || '', at_ms: null, every_ms: j.schedule.kind === 'every' ? j.schedule.every_ms || null : null },
        payload: { message: j.message, kind: 'message' },
        state: { next_run_at_ms: null, last_status: null, pending: false },
        protected: j.id === 'heartbeat',
        delete_after_run: false,
        created_at_ms: new Date(j.created_at).getTime(),
        updated_at_ms: new Date(j.created_at).getTime(),
        origin: { session_key: '', channel: 'webui', chat_id: '', title: '', preview: '' },
      }));
      res.json({ jobs });
    });

    router.get('/webui/automations/disable', (req, res) => {
      const jobId = req.query.id as string;
      if (!jobId) {
        res.status(400).json({ error: 'missing automation id' });
        return;
      }
      const job = cronStore.get(jobId);
      if (!job) {
        res.status(404).json({ error: 'automation not found' });
        return;
      }
      if (jobId === 'heartbeat') {
        res.status(403).json({ error: 'system automation is protected' });
        return;
      }
      job.enabled = false;
      const jobs = cronStore.list().map(j => ({
        id: j.id,
        name: j.description || j.message.slice(0, 50),
        enabled: j.enabled,
        schedule: { kind: j.schedule.kind, expr: j.schedule.kind === 'cron' ? j.schedule.expr || '' : '', tz: j.schedule.tz || '', at_ms: null, every_ms: j.schedule.kind === 'every' ? j.schedule.every_ms || null : null },
        payload: { message: j.message, kind: 'message' },
        state: { next_run_at_ms: null, last_status: null, pending: false },
        protected: j.id === 'heartbeat',
        delete_after_run: false,
        created_at_ms: new Date(j.created_at).getTime(),
        updated_at_ms: new Date(j.created_at).getTime(),
        origin: { session_key: '', channel: 'webui', chat_id: '', title: '', preview: '' },
      }));
      res.json({ jobs });
    });

    router.get('/webui/automations/delete', async (req, res) => {
      const jobId = req.query.id as string;
      if (!jobId) {
        res.status(400).json({ error: 'missing automation id' });
        return;
      }
      if (jobId === 'heartbeat') {
        res.status(403).json({ error: 'system automation is protected' });
        return;
      }
      const removed = await cronStore.remove(jobId);
      if (!removed) {
        res.status(404).json({ error: 'automation not found' });
        return;
      }
      const jobs = cronStore.list().map(j => ({
        id: j.id,
        name: j.description || j.message.slice(0, 50),
        enabled: j.enabled,
        schedule: { kind: j.schedule.kind, expr: j.schedule.kind === 'cron' ? j.schedule.expr || '' : '', tz: j.schedule.tz || '', at_ms: null, every_ms: j.schedule.kind === 'every' ? j.schedule.every_ms || null : null },
        payload: { message: j.message, kind: 'message' },
        state: { next_run_at_ms: null, last_status: null, pending: false },
        protected: j.id === 'heartbeat',
        delete_after_run: false,
        created_at_ms: new Date(j.created_at).getTime(),
        updated_at_ms: new Date(j.created_at).getTime(),
        origin: { session_key: '', channel: 'webui', chat_id: '', title: '', preview: '' },
      }));
      res.json({ jobs });
    });

    router.get('/webui/automations/run', async (req, res) => {
      const jobId = req.query.id as string;
      if (!jobId) {
        res.status(400).json({ error: 'missing automation id' });
        return;
      }
      const job = cronStore.get(jobId);
      if (!job) {
        res.status(404).json({ error: 'automation not found' });
        return;
      }
      if (jobId === 'heartbeat') {
        res.status(403).json({ error: 'system automation is protected' });
        return;
      }
      if (!job.enabled) {
        res.status(409).json({ error: 'automation is disabled' });
        return;
      }
      res.json({ ok: true });
      try {
        await this.bot.run(job.message);
        logger.info({ jobId }, 'Automation run completed');
      } catch (err) {
        logger.error({ jobId, err }, 'Automation run failed');
      }
    });

    // --- WebUI thread transcript ---
    router.get('/webui/threads/:chatId', (req, res) => {
      res.json({
        chat_id: req.params.chatId,
        messages: [],
        goal_state: null,
      });
    });

    // --- Delete WebUI thread ---
    router.delete('/webui/threads/:chatId', (req, res) => {
      res.json({ ok: true, chat_id: req.params.chatId });
    });

    router.get('/v1/models', async (_req, res) => {
      const config = (this.bot as any).config;
      const models: Array<{ id: string; object: string; owned_by: string }> = [];
      models.push({
        id: config.agents.defaults.model,
        object: 'model',
        owned_by: 'nanobot',
      });
      for (const presetName of Object.keys(config.agents.model_presets)) {
        const preset = config.agents.model_presets[presetName];
        models.push({
          id: preset.model,
          object: 'model',
          owned_by: 'nanobot',
        });
      }
      res.json({ object: 'list', data: models });
    });

    router.post('/v1/chat/completions', async (req, res) => {
      await this.handleChatCompletions(req, res);
    });

    router.get('/webui/settings', (_req, res) => {
      res.json(webuiSettingsPayload());
    });

    router.put('/webui/settings', (req, res) => {
      const updated = updateWebuiSettings(req.body || {});
      res.json(updated);
    });

    router.get('/webui/skills', (_req, res) => {
      try {
        const result = webuiSkillsPayload(this.getDefaultWorkspace());
        res.json(result);
      } catch (err) {
        logger.error({ err }, 'Failed to get skills');
        res.status(500).json({ error: 'Failed to get skills' });
      }
    });

    router.get('/webui/skills/:name', (req, res) => {
      try {
        const result = webuiSkillDetailPayload(
          this.getDefaultWorkspace(),
          req.params.name,
        );
        if (!result) {
          res.status(404).json({ error: 'Skill not found' });
          return;
        }
        res.json(result);
      } catch (err) {
        logger.error({ err }, 'Failed to get skill detail');
        res.status(500).json({ error: 'Failed to get skill detail' });
      }
    });

    router.get('/webui/version-check', async (_req, res) => {
      try {
        const pkg = await import('../../package.json', { with: { type: 'json' } });
        const currentVersion = (pkg.default as { version: string }).version || '0.0.0';
        const result = await checkForUpdate(currentVersion);
        res.json(result || { updateAvailable: false });
      } catch (err) {
        logger.error({ err }, 'Failed to check version');
        res.status(500).json({ error: 'Failed to check version' });
      }
    });

    router.get('/webui/token-usage', (_req, res) => {
      res.json(tokenUsagePayload());
    });

    router.post('/webui/token-usage', (req, res) => {
      const body = req.body;
      const usage = body && typeof body === 'object' ? body : {};
      recordTokenUsage(usage as Record<string, unknown>, {
        source: (body as Record<string, unknown>)?.source as string | undefined,
      });
      res.json({ ok: true });
    });

    router.get('/webui/sidebar-state', (_req, res) => {
      res.json(readWebuiSidebarState());
    });

    router.put('/webui/sidebar-state', (req, res) => {
      const state = writeWebuiSidebarState(req.body || {});
      res.json(state);
    });

    router.post('/webui/sidebar-state/update', (req, res) => {
      const state = writeWebuiSidebarState(req.body || {});
      res.json(state);
    });

    router.get('/webui/sessions', (_req, res) => {
      const sessions = listWebuiSessions();
      res.json({ sessions });
    });

    router.delete('/webui/sessions/:id', (req, res) => {
      const sessionKey = `websocket:${req.params.id}`;
      const deleted = deleteWebuiTranscript(sessionKey);
      res.json({ deleted });
    });

    router.get('/webui/sessions/:id/transcript', (req, res) => {
      const sessionKey = `websocket:${req.params.id}`;
      const lines = readTranscriptLines(sessionKey);
      res.json({ transcript: lines });
    });

    router.post('/webui/sessions/:id/transcript', (req, res) => {
      const sessionKey = `websocket:${req.params.id}`;
      if (req.body && typeof req.body === 'object') {
        appendTranscriptObject(sessionKey, req.body as Record<string, unknown>);
      }
      res.json({ ok: true });
    });

    router.get('/webui/workspaces', (_req, res) => {
      res.json(webuiWorkspaceController.statePayload());
    });

    router.get('/webui/file-preview', (req, res) => {
      try {
        const filePath = typeof req.query.path === 'string' ? req.query.path : '';
        const scope = this.getScope(req);
        const availability = typeof req.query.availability !== 'undefined';
        if (availability) {
          res.json(filePreviewAvailabilityPayload(filePath, { scope }));
        } else {
          const limit = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : undefined;
          res.json(filePreviewPayload(filePath, { scope, maxBytes: limit }));
        }
      } catch (err: any) {
        if (err?.code === 'NOT_FOUND' || err?.name === 'WebUIFilePreviewError') {
          res.status(404).json({ error: err.message });
        } else {
          logger.error({ err }, 'Failed to get file preview');
          res.status(500).json({ error: 'Failed to get file preview' });
        }
      }
    });

    router.post('/webui/attachments', async (req, res) => {
      try {
        if (req.is('multipart/form-data')) {
          res.status(400).json({ error: 'multipart/form-data not yet supported, send raw bytes with X-Filename header' });
          return;
        }
        const filename = (req.headers['x-filename'] as string) || 'file';
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(chunk);
        }
        const data = Buffer.concat(chunks);
        const attachment = await saveAttachment(filename, data);
        res.json(attachment);
      } catch (err: any) {
        logger.error({ err }, 'Failed to save attachment');
        res.status(400).json({ error: err.message });
      }
    });

    router.get('/webui/attachments/:id', (req, res) => {
      const attachment = getAttachment(req.params.id);
      if (!attachment) {
        res.status(404).json({ error: 'Attachment not found' });
        return;
      }
      res.json(attachment);
    });

    router.delete('/webui/attachments/:id', (req, res) => {
      const deleted = deleteAttachment(req.params.id);
      res.json({ deleted });
    });

    router.get('/webui/media/sign', (req, res) => {
      try {
        const mediaPath = typeof req.query.path === 'string' ? req.query.path : '';
        const signed = signMediaPath(mediaPath, { secret: this.mediaSecret });
        res.json({ url: signed });
      } catch (err) {
        logger.error({ err }, 'Failed to sign media path');
        res.status(500).json({ error: 'Failed to sign media path' });
      }
    });

    router.get('/webui/media/:sig/:payload', (req, res) => {
      try {
        const result = serveSignedMedia(req.params.sig, req.params.payload, {
          secret: this.mediaSecret,
          rangeHeader: req.headers.range,
        });
        res.status(result.status);
        if (result.headers) {
          for (const [key, value] of Object.entries(result.headers)) {
            if (value !== undefined) {
              res.setHeader(key, value as string);
            }
          }
        }
        if (result.body) {
          res.send(result.body);
        } else {
          res.end();
        }
      } catch (err: any) {
        if (err?.code === 'NOT_FOUND' || err?.code === 'INVALID_SIGNATURE') {
          res.status(404).json({ error: 'Not found' });
        } else {
          logger.error({ err }, 'Failed to serve media');
          res.status(500).json({ error: 'Failed to serve media' });
        }
      }
    });

    router.get('/webui/workspaces/validate', (req, res) => {
      try {
        const scope = this.getScope(req);
        const valid = validateWorkspaceScope(scope);
        res.json({ valid });
      } catch (err) {
        logger.error({ err }, 'Failed to validate workspace');
        res.status(500).json({ error: 'Failed to validate workspace' });
      }
    });

    this.app.use('/api', router);

    const webuiDist = path.join(projectRoot, 'webui', 'dist');
    const webuiSrc = path.join(projectRoot, 'webui');

    this.app.use(express.static(webuiDist, { index: false }));
    this.app.use(express.static(webuiSrc, { index: false }));

    // Catch-all: serve index.html for non-API routes (SPA routing)
    this.app.use((req, res, next) => {
      // Don't intercept API or WebSocket routes
      if (req.path.startsWith('/api/') || req.path.startsWith('/webui/') || req.path.startsWith('/auth/') || req.path.startsWith('/v1/')) {
        return next();
      }
      const indexPath = path.join(webuiDist, 'index.html');
      const fallbackIndex = path.join(webuiSrc, 'index.html');
      res.sendFile(indexPath, (err) => {
        if (err) {
          res.sendFile(fallbackIndex, (fallbackErr) => {
            if (fallbackErr) {
              res.status(404).json({ error: 'WebUI not found' });
            }
          });
        }
      });
    });

    // Final 404 handler for unmatched API routes
    this.app.use((_req, res) => {
      res.status(404).json({ error: 'Not found', path: _req.path });
    });
  }

  async start(): Promise<void> {
    if (this.running) return;

    this.server = http.createServer(this.app);

    // Use noServer mode to avoid conflicts between multiple WebSocket servers
    this.wss = new WebSocketServer({ noServer: true });
    this.chatWss = new WebSocketServer({ noServer: true });

    this.server.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url || '', `http://${request.headers.host}`);
      const pathname = url.pathname;

      if (pathname === '/api/ws/logs') {
        this.wss!.handleUpgrade(request, socket, head, (ws) => {
          this.wss!.emit('connection', ws, request);
        });
      } else if (pathname === '/api/ws/chat') {
        this.chatWss!.handleUpgrade(request, socket, head, (ws) => {
          this.chatWss!.emit('connection', ws, request);
        });
      } else {
        socket.destroy();
      }
    });

    this.wss.on('connection', (ws) => {
      wsLogger.addConnection(ws);
    });

    // Chat WebSocket - for real-time chat with the agent
    this.chatWss.on('connection', (ws) => {
      logger.info('Chat WebSocket client connected');

      const send = (obj: Record<string, unknown>) => {
        if (ws.readyState === 1) ws.send(JSON.stringify(obj));
      };

      ws.on('message', async (data) => {
        try {
          const msg = JSON.parse(data.toString());

          // --- new_chat: provision a new chat_id ---
          if (msg.type === 'new_chat') {
            const chatId = `chat-${crypto.randomUUID()}`;
            send({ event: 'attached', chat_id: chatId });
            return;
          }

          // --- attach: re-attach to an existing chat ---
          if (msg.type === 'attach') {
            send({ event: 'attached', chat_id: msg.chat_id });
            return;
          }

          // --- fork_chat: create a fork ---
          if (msg.type === 'fork_chat') {
            const chatId = `chat-${crypto.randomUUID()}`;
            send({ event: 'attached', chat_id: chatId });
            return;
          }

          // --- set_workspace_scope ---
          if (msg.type === 'set_workspace_scope') {
            send({ event: 'session_updated', chat_id: msg.chat_id, scope: 'metadata' });
            return;
          }

          // --- transcribe_audio ---
          if (msg.type === 'transcribe_audio') {
            send({ event: 'transcription_error', request_id: msg.request_id, detail: 'transcription not available' });
            return;
          }

          // --- message: run the agent ---
          if (msg.type === 'message') {
            const chatId = msg.chat_id as string;
            const content = msg.content as string;
            const startedAt = Math.floor(Date.now() / 1000);

            // Signal turn start
            send({ event: 'goal_status', chat_id: chatId, status: 'running', started_at: startedAt });

            try {
              for await (const event of this.bot.stream(content, {
                sessionKey: `websocket:${chatId}`,
                chatId,
                channel: 'webui',
              })) {
                // Map internal stream events to frontend WebSocket events
                switch (event.type) {
                  case 'text_delta':
                    send({ event: 'delta', chat_id: chatId, text: (event as { content?: string }).content || '' });
                    break;
                  case 'reasoning_delta':
                    send({ event: 'reasoning_delta', chat_id: chatId, text: (event as { content?: string }).content || '' });
                    break;
                  case 'tool_started':
                    send({ event: 'tool_started', chat_id: chatId, ...(event as unknown as Record<string, unknown>) });
                    break;
                  case 'tool_completed':
                    send({ event: 'tool_completed', chat_id: chatId, ...(event as unknown as Record<string, unknown>) });
                    break;
                  case 'file_edit': {
                    const fe = (event as { file_edit?: { edit_type?: string; call_id?: string; tool_name?: string; file_path?: string; action?: string; error?: string } }).file_edit;
                    if (fe) {
                      const status = fe.edit_type === 'start' ? 'editing' : fe.edit_type === 'error' ? 'error' : 'done';
                      const operation = fe.tool_name === 'write_file' ? 'edit' : fe.tool_name === 'delete_file' ? 'delete' : 'edit';
                      send({
                        event: 'file_edit',
                        chat_id: chatId,
                        edits: [{
                          call_id: fe.call_id || '',
                          tool: fe.tool_name || '',
                          path: fe.file_path || '',
                          absolute_path: fe.file_path,
                          phase: fe.edit_type,
                          status,
                          operation,
                          added: 0,
                          deleted: 0,
                          error: fe.error,
                        }],
                      });
                    }
                    break;
                  }
                  case 'run_completed':
                    send({ event: 'turn_end', chat_id: chatId });
                    break;
                  case 'run_failed':
                    send({ event: 'error', chat_id: chatId, detail: (event as { error?: string }).error || 'unknown error' });
                    break;
                  default:
                    // Forward other events as-is with chat_id
                    send({ event: event.type, chat_id: chatId, ...(event as unknown as Record<string, unknown>) });
                    break;
                }
              }
              // Ensure turn_end is always sent
              send({ event: 'turn_end', chat_id: chatId });
            } catch (err) {
              send({ event: 'error', chat_id: chatId, detail: (err as Error).message });
              send({ event: 'turn_end', chat_id: chatId });
            }

            // Signal turn end
            send({ event: 'goal_status', chat_id: chatId, status: 'idle' });
            return;
          }
        } catch (err) {
          logger.error({ err }, 'Chat WebSocket error');
          send({ event: 'error', detail: (err as Error).message });
        }
      });

      ws.on('close', () => {
        logger.info('Chat WebSocket client disconnected');
      });
    });

    const { host, port } = this.config;
    await new Promise<void>((resolve) => {
      this.server!.listen(port!, host!, () => {
        logger.info({ host, port }, 'API server started');
        resolve();
      });
    });

    this.running = true;
  }

  async stop(): Promise<void> {
    if (!this.running) return;

    if (this.wss) {
      this.wss.close();
    }
    if (this.chatWss) {
      this.chatWss.close();
    }

    await new Promise<void>((resolve) => {
      this.server?.close(() => resolve());
    });

    this.running = false;
    logger.info('API server stopped');
  }

  private async handleChatCompletions(req: express.Request, res: express.Response): Promise<void> {
    const body = req.body;
    const messages = body.messages || [];
    const stream = body.stream || false;
    const model = typeof body.model === 'string' ? body.model : undefined;

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      res.status(400).json({ error: 'messages is required' });
      return;
    }

    const lastUserMsg = messages.filter((m: { role: string }) => m.role === 'user').pop();
    if (!lastUserMsg) {
      res.status(400).json({ error: 'No user message found' });
      return;
    }

    const content = typeof lastUserMsg.content === 'string'
      ? lastUserMsg.content
      : (lastUserMsg.content as Array<{ type: string; text?: string }>)
          .filter(c => c.type === 'text')
          .map(c => c.text)
          .join('\n');

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();

      try {
        for await (const event of this.bot.stream(content, { model })) {
          if (event.type === 'text_delta' && event.content) {
            const chunk = {
              id: `chatcmpl-${Date.now()}`,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: model || 'nanobot',
              choices: [{
                index: 0,
                delta: { role: 'assistant', content: event.content },
                finish_reason: null,
              }],
            };
            res.write(`data: ${JSON.stringify(chunk)}\n\n`);
          }
          if (event.type === 'run_completed') {
            const chunk = {
              id: `chatcmpl-${Date.now()}`,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: model || 'nanobot',
              choices: [{
                index: 0,
                delta: {},
                finish_reason: 'stop',
              }],
            };
            res.write(`data: ${JSON.stringify(chunk)}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
          }
          if (event.type === 'run_failed') {
            res.write(`data: ${JSON.stringify({ error: event.error })}\n\n`);
            res.end();
          }
        }
      } catch (err) {
        logger.error({ err }, 'Stream error');
        res.end();
      }
    } else {
      try {
        const result = await this.bot.run(content, { model });
        const response = {
          id: `chatcmpl-${Date.now()}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: model || 'nanobot',
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: result.content,
            },
            finish_reason: result.stopReason || 'stop',
          }],
          usage: result.usage,
        };
        res.json(response);
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    }
  }

  private setCorsHeaders(res: express.Response, req: express.Request): void {
    const origin = req.headers['origin'];
    if (origin && this.config.corsOrigins!.includes(origin as string)) {
      res.setHeader('Access-Control-Allow-Origin', origin as string);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Filename');
    }
  }

  isRunning(): boolean {
    return this.running;
  }
}
