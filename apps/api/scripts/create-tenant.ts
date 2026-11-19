// Usage: ADMIN_DATABASE_URL=... pnpm --filter @ledgerproof/api create-tenant "Acme Ltd"
import { createTenantWithKey } from '../src/admin.js';
import { createPool } from '../src/db/pool.js';

const name = process.argv[2];
const url = process.env.ADMIN_DATABASE_URL;
if (!name || !url) {
  console.error('usage: ADMIN_DATABASE_URL=<owner url> create-tenant "<tenant name>"');
  process.exit(1);
}

const pool = createPool(url, { max: 1 });
const { tenantId, apiKey } = await createTenantWithKey(pool, name);
await pool.end();
console.log(`tenant:  ${tenantId}`);
console.log(`api key: ${apiKey}`);
console.log('The key is shown once and only its hash is stored. Keep it somewhere safe.');
