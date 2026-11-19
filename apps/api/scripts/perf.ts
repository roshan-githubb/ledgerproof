// One-command load test: hot (shared funding account) vs control (independent wallets).
// Usage: pnpm --filter @ledgerproof/api perf <label>
// Tunables: PERF_VUS (32), PERF_DURATION (20s), PERF_ROUNDS (2), PERF_POOL (20), K6_BIN.
// Plan and decision rule: docs/plans/0002-hot-account.md. Results: docs/perf/<label>.json.
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { createTenantWithKey } from '../src/admin.js';
import { migrate } from '../src/db/migrate.js';
import { createPool } from '../src/db/pool.js';
import { createAccount } from '../src/ledger/accounts.js';
import { findViolations } from '../src/ledger/reconcile.js';
import { createTransfer } from '../src/ledger/transfers.js';

const label = process.argv[2] ?? 'run';
const VUS = Number(process.env.PERF_VUS ?? 32);
const DURATION = process.env.PERF_DURATION ?? '20s';
const ROUNDS = Number(process.env.PERF_ROUNDS ?? 2);
const POOL = Number(process.env.PERF_POOL ?? 20);
const WALLETS = 2 * VUS; // two per virtual user (see perf/transfers.js)

const apiDir = fileURLToPath(new URL('..', import.meta.url));
const repoDir = path.resolve(apiDir, '../..');

function findK6(): string {
  if (process.env.K6_BIN) return process.env.K6_BIN;
  const tools = path.join(repoDir, '.tmp/tools');
  if (existsSync(tools)) {
    for (const dir of readdirSync(tools)) {
      for (const sub of readdirSync(path.join(tools, dir), { withFileTypes: true })) {
        const exe = path.join(tools, dir, sub.name, process.platform === 'win32' ? 'k6.exe' : 'k6');
        if (sub.isDirectory() && existsSync(exe)) return exe;
      }
    }
  }
  return 'k6';
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: apiDir, env: { ...process.env, ...env } });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('exit', (code) => resolve({ code: code ?? 1, out }));
  });
}

/** Samples what the API's database sessions are doing, every 50ms. */
function startWaitSampler(adminPool: pg.Pool) {
  const counts: Record<string, number> = {};
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const { rows } = await adminPool.query<{ w: string; n: number }>(
        `SELECT coalesce(wait_event_type || ':' || wait_event, 'CPU') AS w, count(*)::int AS n
           FROM pg_stat_activity
          WHERE usename = 'ledger_perf' AND state = 'active'
          GROUP BY 1`,
      );
      for (const r of rows) counts[r.w] = (counts[r.w] ?? 0) + r.n;
    } finally {
      busy = false;
    }
  }, 50);
  return () => {
    clearInterval(timer);
    const total = Object.values(counts).reduce((a, b) => a + b, 0) || 1;
    return Object.fromEntries(
      Object.entries(counts)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => [k, Math.round((1000 * v) / total) / 10]),
    ) as Record<string, number>;
  };
}

interface ScenarioResult {
  round: number;
  scenario: 'control' | 'hot';
  transfersPerSec: number;
  requests: number;
  failedPct: number;
  p50ms: number;
  p95ms: number;
  p99ms: number;
  dbWaitsPct: Record<string, number>;
}

const tmp = mkdtempSync(path.join(os.tmpdir(), 'ledgerproof-perf-'));
const pgPort = await freePort();
const ep = new EmbeddedPostgres({
  databaseDir: path.join(tmp, 'pgdata'),
  port: pgPort,
  user: 'postgres',
  password: 'postgres',
  persistent: false,
  postgresFlags: ['-c', 'max_connections=200'],
  onLog: () => {},
});
let server: ReturnType<typeof spawn> | undefined;
let adminPool: pg.Pool | undefined;
let appPool: pg.Pool | undefined;

try {
  const k6 = findK6();
  console.log(`k6: ${k6}`);
  await ep.initialise();
  await ep.start();
  await ep.createDatabase('ledgerproof');
  const adminUrl = `postgres://postgres:postgres@localhost:${pgPort}/ledgerproof`;
  const perfUrl = `postgres://ledger_perf:perf@localhost:${pgPort}/ledgerproof`;
  await migrate(adminUrl, () => {});
  adminPool = createPool(adminUrl, { max: 3 });
  await adminPool.query(`CREATE ROLE ledger_perf LOGIN PASSWORD 'perf' IN ROLE ledger_app`);
  appPool = createPool(perfUrl, { max: 10 });

  // Seed: one tenant, one funding account, two wallets per virtual user, plenty of money.
  const { tenantId, apiKey } = await createTenantWithKey(adminPool, 'perf');
  const funding = await createAccount(appPool, tenantId, { reference: 'funding', currency: 'USD', allowNegative: true });
  const wallets: string[] = [];
  for (let i = 0; i < WALLETS; i++) {
    const { account } = await createAccount(appPool, tenantId, { reference: `wallet:${i}`, currency: 'USD', allowNegative: false });
    await createTransfer(appPool, tenantId, randomUUID(), {
      fromAccountId: funding.account.id,
      toAccountId: account.id,
      amount: '1000000000000',
      currency: 'USD',
    });
    wallets.push(account.id);
  }

  const apiPort = await freePort();
  const baseUrl = `http://127.0.0.1:${apiPort}`;
  const seedFile = path.join(tmp, 'seed.json');
  writeFileSync(seedFile, JSON.stringify({ baseUrl, apiKey, fundingId: funding.account.id, wallets }));

  server = spawn(process.execPath, ['dist/server.js'], {
    cwd: apiDir,
    env: { ...process.env, DATABASE_URL: perfUrl, PORT: String(apiPort), HOST: '127.0.0.1', LOG_LEVEL: 'warn', DB_POOL_MAX: String(POOL) },
    stdio: 'inherit',
  });
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`${baseUrl}/health`)).ok) break;
    } catch {
      /* not up yet */
    }
    if (i > 300) throw new Error('API did not start');
    await new Promise((r) => setTimeout(r, 100));
  }

  const settings = Object.fromEntries(
    await Promise.all(
      ['server_version', 'shared_buffers', 'fsync', 'synchronous_commit', 'wal_sync_method', 'max_connections'].map(
        async (name) => [name, (await adminPool!.query(`SHOW ${name}`)).rows[0][name]] as const,
      ),
    ),
  );

  const runScenario = async (scenario: 'control' | 'hot', duration: string) => {
    const summaryFile = path.join(tmp, `${scenario}-${randomUUID()}.json`);
    const stopSampler = startWaitSampler(adminPool!);
    const result = await run(k6, ['run', '--quiet', 'perf/transfers.js'], {
      SEED_FILE: seedFile,
      SCENARIO: scenario,
      VUS: String(VUS),
      DURATION: duration,
      RUN_ID: randomUUID(),
      SUMMARY_FILE: summaryFile,
    });
    const waits = stopSampler();
    if (result.code !== 0 && !existsSync(summaryFile)) throw new Error(`k6 failed:\n${result.out}`);
    const m = JSON.parse(readFileSync(summaryFile, 'utf8')).metrics;
    const passRate: number = m.checks.values.rate;
    return {
      transfersPerSec: Math.round(m.http_reqs.values.rate * passRate),
      requests: m.http_reqs.values.count as number,
      failedPct: Math.round((1 - passRate) * 1000) / 10,
      p50ms: Math.round(m.http_req_duration.values['p(50)'] * 10) / 10,
      p95ms: Math.round(m.http_req_duration.values['p(95)'] * 10) / 10,
      p99ms: Math.round(m.http_req_duration.values['p(99)'] * 10) / 10,
      dbWaitsPct: waits,
    };
  };

  console.log(`warm-up (5s)...`);
  await runScenario('control', '5s');

  const results: ScenarioResult[] = [];
  for (let round = 1; round <= ROUNDS; round++) {
    for (const scenario of ['control', 'hot'] as const) {
      console.log(`round ${round}: ${scenario} (${VUS} VUs, ${DURATION})...`);
      results.push({ round, scenario, ...(await runScenario(scenario, DURATION)) });
    }
  }

  const violations = await findViolations(adminPool, tenantId);

  // What a balance read costs, for the funding account (many transfers) and a wallet.
  const medianReadMs = async (accountId: string) => {
    const times: number[] = [];
    for (let i = 0; i < 21; i++) {
      const t0 = performance.now();
      const res = await fetch(`${baseUrl}/v1/accounts/${accountId}`, { headers: { authorization: `Bearer ${apiKey}` } });
      await res.json();
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    return Math.round(times[10]! * 10) / 10;
  };
  const fundingTransfers = (
    await adminPool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM transfers WHERE from_account_id = $1 OR to_account_id = $1',
      [funding.account.id],
    )
  ).rows[0]!.n;
  const balanceRead = {
    fundingTransfers,
    fundingP50ms: await medianReadMs(funding.account.id),
    walletP50ms: await medianReadMs(wallets[0]!),
  };
  const git = (args: string[]) => spawnSync('git', args, { cwd: repoDir, encoding: 'utf8' }).stdout.trim();
  const report = {
    label,
    date: new Date().toISOString(),
    git: { commit: git(['rev-parse', '--short', 'HEAD']), dirty: git(['status', '--porcelain']).length > 0 },
    machine: {
      cpu: os.cpus()[0]?.model,
      logicalCpus: os.cpus().length,
      memoryGb: Math.round(os.totalmem() / 2 ** 30),
      os: `${os.type()} ${os.release()}`,
      node: process.version,
    },
    postgres: settings,
    params: { vus: VUS, duration: DURATION, rounds: ROUNDS, apiPoolMax: POOL, wallets: WALLETS, k6: path.basename(path.dirname(k6)) },
    results,
    balanceRead,
    invariantViolations: violations.length,
  };
  const outFile = path.join(repoDir, 'docs/perf', `${label}.json`);
  writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`);

  console.log(`\n${label}: ${VUS} VUs x ${DURATION}, API pool ${POOL}, ${report.machine.cpu}`);
  console.log('| round | scenario | transfers/s | p50 ms | p95 ms | p99 ms | failed | top DB waits |');
  console.log('|---|---|---|---|---|---|---|---|');
  for (const r of results) {
    const waits = Object.entries(r.dbWaitsPct).slice(0, 3).map(([k, v]) => `${k} ${v}%`).join(', ');
    console.log(`| ${r.round} | ${r.scenario} | ${r.transfersPerSec} | ${r.p50ms} | ${r.p95ms} | ${r.p99ms} | ${r.failedPct}% | ${waits} |`);
  }
  console.log(`balance read p50: funding account (${balanceRead.fundingTransfers} transfers) ${balanceRead.fundingP50ms} ms, wallet ${balanceRead.walletP50ms} ms`);
  console.log(`invariant violations after load: ${violations.length}`);
  console.log(`raw results: ${path.relative(repoDir, outFile)}`);
} finally {
  server?.kill();
  await appPool?.end();
  await adminPool?.end();
  await ep.stop().catch(() => {});
  rmSync(tmp, { recursive: true, force: true });
}
