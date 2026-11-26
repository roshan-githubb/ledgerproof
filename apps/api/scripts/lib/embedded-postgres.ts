import { execFile } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import type EmbeddedPostgres from 'embedded-postgres';

/**
 * Stops an embedded Postgres without leaving processes behind.
 *
 * On Windows, embedded-postgres's stop() force-kills the process tree (`taskkill /f /t`) and
 * treats the server as stopped as soon as the main process dies. If this process exits right
 * after (for example when Vitest shuts down late), that kill can be cut short, leaving orphaned
 * postgres.exe io_worker processes. Seen twice during development. `pg_ctl stop -w` asks for a
 * fast shutdown and returns only once every child process has exited.
 */
export async function stopEmbeddedPostgres(
  ep: EmbeddedPostgres,
  opts: { databaseDir: string; persistent: boolean },
): Promise<void> {
  if (process.platform !== 'win32') {
    await ep.stop(); // SIGINT = Postgres fast shutdown; waits for exit
    return;
  }
  const require = createRequire(import.meta.url);
  const binaries = createRequire(require.resolve('embedded-postgres')).resolve('@embedded-postgres/windows-x64');
  const { pg_ctl } = (await import(pathToFileURL(binaries).href)) as { pg_ctl: string };
  await promisify(execFile)(pg_ctl, ['stop', '-D', opts.databaseDir, '-m', 'fast', '-w', '-t', '30']);
  // Not ep.stop(): it waits for an 'exit' event that has already happened and would hang.
  if (!opts.persistent) await rm(opts.databaseDir, { recursive: true, force: true });
}
