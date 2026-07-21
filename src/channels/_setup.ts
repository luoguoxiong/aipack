export interface ChannelSetupOptions {
  channelType: string;
  config: Record<string, unknown>;
  workspace?: string;
}

export interface ChannelSetupResult {
  success: boolean;
  message: string;
  channelId?: string;
  errors?: string[];
}

export interface ChannelValidator {
  validate(config: Record<string, unknown>): string[];
  canSetup(): boolean;
  setup(options: ChannelSetupOptions): Promise<ChannelSetupResult>;
}

export const CHANNEL_VALIDATORS: Map<string, ChannelValidator> = new Map();

export function registerValidator(channelType: string, validator: ChannelValidator): void {
  CHANNEL_VALIDATORS.set(channelType, validator);
}

export function getValidator(channelType: string): ChannelValidator | undefined {
  return CHANNEL_VALIDATORS.get(channelType);
}

export async function setupChannel(options: ChannelSetupOptions): Promise<ChannelSetupResult> {
  const validator = getValidator(options.channelType);
  if (!validator) {
    return {
      success: false,
      message: `No validator found for channel type: ${options.channelType}`,
    };
  }

  const errors = validator.validate(options.config);
  if (errors.length > 0) {
    return {
      success: false,
      message: 'Validation failed',
      errors,
    };
  }

  return await validator.setup(options);
}