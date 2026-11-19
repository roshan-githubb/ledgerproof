import pg from 'pg';

export interface PoolOptions {
  max?: number;
  /** How long an idle connection stays open (ms). 0 keeps it open until the pool ends. */
  idleTimeoutMillis?: number;
}

export function createPool(connectionString: string, opts: PoolOptions = {}): pg.Pool {
  return new pg.Pool({
    connectionString,
    max: opts.max ?? 10,
    idleTimeoutMillis: opts.idleTimeoutMillis ?? 10_000,
    // A statement that waits this long (including waiting for a row lock) is cancelled
    // instead of holding a connection forever.
    statement_timeout: 5_000,
    idle_in_transaction_session_timeout: 10_000,
  });
}
