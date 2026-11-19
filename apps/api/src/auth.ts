import { createHash, randomBytes } from 'node:crypto';
import type pg from 'pg';

/** 32 random bytes: too much entropy to brute-force, so a fast hash is enough to store it. */
export function generateApiKey(): string {
  return `lp_${randomBytes(32).toString('base64url')}`;
}

export function hashApiKey(key: string): Buffer {
  return createHash('sha256').update(key, 'utf8').digest();
}

/** Returns the tenant id for an active key, or null. */
export async function authenticateApiKey(pool: pg.Pool, key: string): Promise<string | null> {
  const { rows } = await pool.query<{ tenant_id: string | null }>(
    'SELECT authenticate_api_key($1) AS tenant_id',
    [hashApiKey(key)],
  );
  return rows[0]?.tenant_id ?? null;
}
