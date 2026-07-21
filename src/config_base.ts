import { z } from 'zod';

const BaseConfig = z.object({}).passthrough();

export type BaseConfigType = z.infer<typeof BaseConfig>;

export { BaseConfig };
