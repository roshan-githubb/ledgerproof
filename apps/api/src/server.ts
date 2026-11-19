import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createPool } from './db/pool.js';

const config = loadConfig();
const pool = createPool(config.databaseUrl);
const app = buildApp({ pool, logger: true });

// An idle pooled connection can fail (database restart, network blip). Without a listener
// node-postgres would crash the process; the pool replaces the client on its own.
pool.on('error', (err) => app.log.error({ err }, 'idle database client error'));

async function shutdown(signal: string) {
  app.log.info({ signal }, 'shutting down');
  await app.close(); // stop accepting requests, let in-flight ones finish
  await pool.end();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: config.host, port: config.port });
