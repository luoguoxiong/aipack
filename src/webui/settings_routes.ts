import express from 'express';
import {
  webuiSettingsPayload,
  updateWebuiSettings,
} from './settings_api.js';
import {
  nanobotFeaturesPayload,
  nanobotFeaturesEnable,
  nanobotFeaturesDisable,
} from './nanobot_features_api.js';
import {
  listMCPPresets,
  addMCPPreset,
  updateMCPPreset,
  deleteMCPPreset,
  enableMCPPreset,
  disableMCPPreset,
} from './mcp_presets_runtime.js';
import { logger } from '../utils/logger.js';

export function createSettingsRouter(): express.Router {
  const router = express.Router();

  router.get('/', (_req, res) => {
    res.json(webuiSettingsPayload());
  });

  router.put('/', (req, res) => {
    const updated = updateWebuiSettings(req.body || {});
    res.json(updated);
  });

  router.get('/nanobot-features', (_req, res) => {
    res.json(nanobotFeaturesPayload());
  });

  router.post('/nanobot-features/enable', async (req, res) => {
    const name = req.body?.name as string;
    if (!name) {
      res.status(400).json({ ok: false, error: 'name is required' });
      return;
    }
    const result = await nanobotFeaturesEnable({ name });
    res.json(result);
  });

  router.post('/nanobot-features/disable', async (req, res) => {
    const name = req.body?.name as string;
    if (!name) {
      res.status(400).json({ ok: false, error: 'name is required' });
      return;
    }
    const result = await nanobotFeaturesDisable({ name });
    res.json(result);
  });

  router.get('/mcp-presets', (_req, res) => {
    res.json({ presets: listMCPPresets() });
  });

  router.post('/mcp-presets/add', (req, res) => {
    const preset = req.body;
    if (!preset || !preset.id || !preset.name || !preset.server_url) {
      res.status(400).json({ ok: false, error: 'Invalid preset' });
      return;
    }
    addMCPPreset(preset);
    res.json({ ok: true });
  });

  router.post('/mcp-presets/update', (req, res) => {
    const { id, ...updates } = req.body;
    if (!id) {
      res.status(400).json({ ok: false, error: 'id is required' });
      return;
    }
    const updated = updateMCPPreset(id, updates);
    res.json({ ok: updated });
  });

  router.post('/mcp-presets/delete', (req, res) => {
    const id = req.body?.id as string;
    if (!id) {
      res.status(400).json({ ok: false, error: 'id is required' });
      return;
    }
    const deleted = deleteMCPPreset(id);
    res.json({ ok: deleted });
  });

  router.post('/mcp-presets/enable', (req, res) => {
    const id = req.body?.id as string;
    if (!id) {
      res.status(400).json({ ok: false, error: 'id is required' });
      return;
    }
    const enabled = enableMCPPreset(id);
    res.json({ ok: enabled });
  });

  router.post('/mcp-presets/disable', (req, res) => {
    const id = req.body?.id as string;
    if (!id) {
      res.status(400).json({ ok: false, error: 'id is required' });
      return;
    }
    const disabled = disableMCPPreset(id);
    res.json({ ok: disabled });
  });

  router.post('/restart', (_req, res) => {
    logger.info('Restart requested via settings route');
    res.json({ ok: true, message: 'Restart scheduled' });
  });

  return router;
}