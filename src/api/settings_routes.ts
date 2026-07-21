import express, { Request, Response } from 'express';
import {
  settingsPayload,
  settingsUsagePayload,
  updateAgentSettings,
  createModelConfiguration,
  updateModelConfiguration,
  updateProviderSettings,
  updateWebSearchSettings,
  updateNetworkSafetySettings,
  updateImageGenerationSettings,
  updateTranscriptionSettings,
  providerModelsPayload,
} from './settings_api.js';

export function setupSettingsRoutes(app: express.Application): void {
  app.get('/api/settings', async (_req: Request, res: Response) => {
    try {
      const payload = await settingsPayload();
      res.json(payload);
    } catch (err) {
      console.error('Error getting settings:', err);
      res.status(500).json({ ok: false, error: 'Internal server error' });
    }
  });

  app.get('/api/settings/usage', async (_req: Request, res: Response) => {
    try {
      const payload = await settingsUsagePayload();
      res.json(payload);
    } catch (err) {
      console.error('Error getting settings usage:', err);
      res.status(500).json({ ok: false, error: 'Internal server error' });
    }
  });

  app.post('/api/settings/update', async (req: Request, res: Response) => {
    try {
      const payload = await updateAgentSettings(req.body || req.query as Record<string, string>);
      res.json(payload);
    } catch (err) {
      console.error('Error updating settings:', err);
      res.status(500).json({ ok: false, error: (err as Error).message });
    }
  });

  app.post('/api/settings/model-configurations/create', async (req: Request, res: Response) => {
    try {
      const payload = await createModelConfiguration(req.body || req.query as Record<string, string>);
      res.json(payload);
    } catch (err) {
      console.error('Error creating model configuration:', err);
      res.status(500).json({ ok: false, error: (err as Error).message });
    }
  });

  app.post('/api/settings/model-configurations/update', async (req: Request, res: Response) => {
    try {
      const payload = await updateModelConfiguration(req.body || req.query as Record<string, string>);
      res.json(payload);
    } catch (err) {
      console.error('Error updating model configuration:', err);
      res.status(500).json({ ok: false, error: (err as Error).message });
    }
  });

  app.post('/api/settings/provider/update', async (req: Request, res: Response) => {
    try {
      const payload = await updateProviderSettings(req.body || req.query as Record<string, string>);
      res.json(payload);
    } catch (err) {
      console.error('Error updating provider settings:', err);
      res.status(500).json({ ok: false, error: (err as Error).message });
    }
  });

  app.post('/api/settings/provider/oauth-login', async (_req: Request, res: Response) => {
    res.json({ ok: false, error: 'OAuth login is not implemented' });
  });

  app.post('/api/settings/provider/oauth-logout', async (_req: Request, res: Response) => {
    res.json({ ok: true });
  });

  app.post('/api/settings/web-search/update', async (req: Request, res: Response) => {
    try {
      const payload = await updateWebSearchSettings(req.body || req.query as Record<string, string>);
      res.json(payload);
    } catch (err) {
      console.error('Error updating web search settings:', err);
      res.status(500).json({ ok: false, error: (err as Error).message });
    }
  });

  app.post('/api/settings/network-safety/update', async (req: Request, res: Response) => {
    try {
      const payload = await updateNetworkSafetySettings(req.body || req.query as Record<string, string>);
      res.json(payload);
    } catch (err) {
      console.error('Error updating network safety settings:', err);
      res.status(500).json({ ok: false, error: (err as Error).message });
    }
  });

  app.post('/api/settings/image-generation/update', async (req: Request, res: Response) => {
    try {
      const payload = await updateImageGenerationSettings(req.body || req.query as Record<string, string>);
      res.json(payload);
    } catch (err) {
      console.error('Error updating image generation settings:', err);
      res.status(500).json({ ok: false, error: (err as Error).message });
    }
  });

  app.post('/api/settings/transcription/update', async (req: Request, res: Response) => {
    try {
      const payload = await updateTranscriptionSettings(req.body || req.query as Record<string, string>);
      res.json(payload);
    } catch (err) {
      console.error('Error updating transcription settings:', err);
      res.status(500).json({ ok: false, error: (err as Error).message });
    }
  });

  app.get('/api/settings/provider-models', async (req: Request, res: Response) => {
    try {
      const payload = await providerModelsPayload(req.query as Record<string, string>);
      res.json(payload);
    } catch (err) {
      console.error('Error getting provider models:', err);
      res.status(500).json({ ok: false, error: (err as Error).message });
    }
  });

  app.get('/api/settings/cli-apps', async (_req: Request, res: Response) => {
    res.json({ apps: [] });
  });

  app.post('/api/settings/cli-apps/install', async (_req: Request, res: Response) => {
    res.json({ ok: false, error: 'CLI apps install is not implemented' });
  });

  app.post('/api/settings/cli-apps/update', async (_req: Request, res: Response) => {
    res.json({ ok: false, error: 'CLI apps update is not implemented' });
  });

  app.post('/api/settings/cli-apps/uninstall', async (_req: Request, res: Response) => {
    res.json({ ok: false, error: 'CLI apps uninstall is not implemented' });
  });

  app.get('/api/settings/nanobot-features', async (_req: Request, res: Response) => {
    res.json({ features: [] });
  });

  app.post('/api/settings/nanobot-features/enable', async (_req: Request, res: Response) => {
    res.json({ ok: false, error: 'Nanobot features enable is not implemented' });
  });

  app.post('/api/settings/nanobot-features/disable', async (_req: Request, res: Response) => {
    res.json({ ok: false, error: 'Nanobot features disable is not implemented' });
  });

  app.get('/api/settings/mcp-presets', async (_req: Request, res: Response) => {
    res.json({ presets: [] });
  });

  app.post('/api/settings/mcp-presets/create', async (_req: Request, res: Response) => {
    res.json({ ok: false, error: 'MCP presets create is not implemented' });
  });

  app.post('/api/settings/mcp-presets/update', async (_req: Request, res: Response) => {
    res.json({ ok: false, error: 'MCP presets update is not implemented' });
  });

  app.post('/api/settings/mcp-presets/delete', async (_req: Request, res: Response) => {
    res.json({ ok: false, error: 'MCP presets delete is not implemented' });
  });

  app.get('/api/settings/pairing', async (_req: Request, res: Response) => {
    res.json({ requests: [] });
  });

  app.post('/api/settings/pairing/approve', async (_req: Request, res: Response) => {
    res.json({ ok: false, error: 'Pairing approve is not implemented' });
  });

  app.post('/api/settings/pairing/deny', async (_req: Request, res: Response) => {
    res.json({ ok: false, error: 'Pairing deny is not implemented' });
  });

  app.get('/api/settings/channels', async (_req: Request, res: Response) => {
    res.json({ channels: [] });
  });

  app.post('/api/settings/channels/connect', async (_req: Request, res: Response) => {
    res.json({ ok: false, error: 'Channels connect is not implemented' });
  });

  app.post('/api/settings/channels/start', async (_req: Request, res: Response) => {
    res.json({ ok: false, error: 'Channels start is not implemented' });
  });

  app.post('/api/settings/channels/poll', async (_req: Request, res: Response) => {
    res.json({ ok: false, error: 'Channels poll is not implemented' });
  });

  app.post('/api/settings/channels/cancel', async (_req: Request, res: Response) => {
    res.json({ ok: false, error: 'Channels cancel is not implemented' });
  });

  app.post('/api/settings/api-service/start', async (_req: Request, res: Response) => {
    res.json({ ok: false, error: 'API service start is not implemented' });
  });

  app.post('/api/settings/api-service/stop', async (_req: Request, res: Response) => {
    res.json({ ok: false, error: 'API service stop is not implemented' });
  });
}