import type pg from 'pg';

export type Db = pg.PoolClient;

/**
 * Runs `fn` inside one database transaction with the tenant context set for row-level
 * security. This is the only way request code gets a connection: the pool itself is never
 * handed to route handlers, so no query can run without a tenant.
 *
 * set_config(..., true) is transaction-scoped. It reverts at COMMIT or ROLLBACK, so a pooled
 * connection never carries one tenant's context into the next request.
 */
export async function withTenantTx<T>(
  pool: pg.Pool,
  tenantId: string,
  fn: (db: Db) => Promise<T>,
  opts: { readOnly?: boolean } = {},
): Promise<T> {
  const client = await pool.connect();
  // If the connection dies mid-transaction (backend killed, network drop), pg emits 'error'
  // on the client. Without a listener that would crash the process; with one, we remember
  // the failure and destroy the client instead of returning it to the pool.
  let broken: Error | undefined;
  const onError = (err: Error) => {
    broken = err;
  };
  client.on('error', onError);
  try {
    // READ ONLY makes Postgres reject any write in this transaction, whatever the code tries.
    await client.query(opts.readOnly ? 'BEGIN READ ONLY' : 'BEGIN');
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      broken ??= rollbackErr as Error;
    }
    throw err;
  } finally {
    client.off('error', onError);
    client.release(broken);
  }
}
