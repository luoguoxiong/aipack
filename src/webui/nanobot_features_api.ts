import { logger } from '../utils/logger.js';
import { listOptionalFeatures, enableOptionalFeature, disableOptionalFeature, OptionalFeature } from '../optional_features.js';

export interface NanobotFeaturesPayload {
  features: Array<{
    name: string;
    label: string;
    description: string;
    enabled: boolean;
    installed: boolean;
    requires_restart: boolean;
    provider_name?: string;
    install_state?: string;
  }>;
}

export function nanobotFeaturesPayload(): NanobotFeaturesPayload {
  const features = listOptionalFeatures().map(f => ({
    name: f.name,
    label: f.label,
    description: f.description,
    enabled: f.enabled,
    installed: f.installed,
    requires_restart: f.requiresRestart,
    provider_name: f.providerName,
    install_state: f.installState,
  }));
  return { features };
}

export async function nanobotFeaturesEnable(opts: {
  name: string;
}): Promise<{ ok: boolean; error?: string }> {
  try {
    const feature = await enableOptionalFeature(opts.name);
    if (!feature) {
      return { ok: false, error: 'Feature not found' };
    }
    return { ok: true };
  } catch (err) {
    logger.error({ err, feature: opts.name }, 'Failed to enable feature');
    return { ok: false, error: (err as Error).message };
  }
}

export async function nanobotFeaturesDisable(opts: {
  name: string;
}): Promise<{ ok: boolean; error?: string }> {
  try {
    const feature = disableOptionalFeature(opts.name);
    if (!feature) {
      return { ok: false, error: 'Feature not found' };
    }
    return { ok: true };
  } catch (err) {
    logger.error({ err, feature: opts.name }, 'Failed to disable feature');
    return { ok: false, error: (err as Error).message };
  }
}