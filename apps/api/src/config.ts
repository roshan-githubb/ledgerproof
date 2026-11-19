export interface Config {
  databaseUrl: string;
  dbPoolMax: number;
  host: string;
  port: number;
  /** pino level. 'warn' turns off per-request logs (used for load tests). */
  logLevel: string;
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
  };
}
