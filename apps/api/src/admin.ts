import type pg from 'pg';
import { generateApiKey, hashApiKey } from './auth.js';

/**
 * Admin operations. These take an owner connection (bypasses row-level security) and are
 * only used by the CLI scripts and tests, never by the API.
 */
export async function createTenantWithKey(adminPool: pg.Pool, name: string) {
  const client = await adminPool.connect();
  try {
    await client.query('BEGIN');
    const tenant = await client.query<{ id: string }>(
      'INSERT INTO tenants (name) VALUES ($1) RETURNING id',
      [name],
    );
    const tenantId = tenant.rows[0]!.id;
    const apiKey = generateApiKey();
    const key = await client.query<{ id: string }>(
      'INSERT INTO api_keys (tenant_id, key_hash, label) VALUES ($1, $2, $3) RETURNING id',
      [tenantId, hashApiKey(apiKey), 'default'],
    );
    await client.query('COMMIT');
    return { tenantId, apiKey, apiKeyId: key.rows[0]!.id };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function revokeApiKey(adminPool: pg.Pool, apiKeyId: string) {
  await adminPool.query('UPDATE api_keys SET revoked_at = now() WHERE id = $1', [apiKeyId]);
}
