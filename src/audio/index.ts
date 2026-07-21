export {
  TRANSCRIPTION_PROVIDERS,
  transcriptionProviderNames,
  getTranscriptionProvider,
  resolveTranscriptionProvider,
} from './transcription_registry.js';
export type { TranscriptionProviderSpec, TranscriptionProviderAdapter } from './transcription_registry.js';

export {
  TranscriptionIngressError,
  isTranscriptionConfigured,
  resolveTranscriptionConfig,
  transcribeAudioDataUrl,
  transcribeAudioFile,
} from './transcription.js';
export type { EffectiveTranscriptionConfig, TranscriptionProviderName } from './transcription.js';
