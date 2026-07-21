export interface TranscriptionProviderAdapter {
  transcribe(filePath: string): Promise<string>;
}

export interface TranscriptionProviderSpec {
  name: string;
  default_model: string;
  adapter: string;
  aliases: string[];
}

export const TRANSCRIPTION_PROVIDERS: TranscriptionProviderSpec[] = [
  {
    name: 'groq',
    default_model: 'whisper-large-v3',
    adapter: '../providers/transcription.js:GroqTranscriptionProvider',
    aliases: [],
  },
  {
    name: 'openai',
    default_model: 'whisper-1',
    adapter: '../providers/transcription.js:OpenAITranscriptionProvider',
    aliases: [],
  },
  {
    name: 'openrouter',
    default_model: 'openai/whisper-1',
    adapter: '../providers/transcription.js:OpenRouterTranscriptionProvider',
    aliases: [],
  },
  {
    name: 'xiaomi_mimo',
    default_model: 'mimo-v2.5-asr',
    adapter: '../providers/transcription.js:XiaomiMiMoTranscriptionProvider',
    aliases: ['mimo', 'xiaomi'],
  },
  {
    name: 'stepfun',
    default_model: 'stepaudio-2.5-asr',
    adapter: '../providers/transcription.js:StepFunTranscriptionProvider',
    aliases: [],
  },
  {
    name: 'assemblyai',
    default_model: 'universal-3-pro,universal-2',
    adapter: '../providers/transcription.js:AssemblyAITranscriptionProvider',
    aliases: [],
  },
  {
    name: 'siliconflow',
    default_model: 'FunAudioLLM/SenseVoiceSmall',
    adapter: '../providers/transcription.js:OpenAITranscriptionProvider',
    aliases: ['silicon'],
  },
];

const _BY_NAME = new Map(TRANSCRIPTION_PROVIDERS.map(spec => [spec.name, spec]));
const _BY_ALIAS = new Map(
  TRANSCRIPTION_PROVIDERS.flatMap(spec => spec.aliases.map(alias => [alias, spec])),
);

export function transcriptionProviderNames(): string[] {
  return TRANSCRIPTION_PROVIDERS.map(spec => spec.name);
}

export function getTranscriptionProvider(name: string): TranscriptionProviderSpec | undefined {
  return _BY_NAME.get(name);
}

export function resolveTranscriptionProvider(value: unknown): TranscriptionProviderSpec | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const name = value.trim().toLowerCase();
  return _BY_NAME.get(name) || _BY_ALIAS.get(name);
}
