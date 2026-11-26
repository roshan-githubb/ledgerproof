import { DEFAULT_ASSISTANT_MODEL } from './assistant/model.js';

export interface Config {
  databaseUrl: string;
  dbPoolMax: number;
  host: string;
  port: number;
  /** pino level. 'warn' turns off per-request logs (used for load tests). */
  logLevel: string;
  /** null when no Anthropic credentials are set: the assistant endpoint then answers 503. */
  assistantModelId: string | null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  return {
    databaseUrl,
    dbPoolMax: Number(env.DB_POOL_MAX ?? 10),
    host: env.HOST ?? '0.0.0.0',
    port: Number(env.PORT ?? 3000),
    logLevel: env.LOG_LEVEL ?? 'info',
    assistantModelId:
      env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN ? (env.ASSISTANT_MODEL ?? DEFAULT_ASSISTANT_MODEL) : null,
  };
}
