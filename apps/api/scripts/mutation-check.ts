// Proves the correctness tests can fail. Each mutation deliberately breaks one guarantee in
// the source, runs the test that claims to protect it, and expects that test to FAIL. A
// mutation that leaves its test green means the test proves nothing.
//
// Usage: pnpm --filter @ledgerproof/api mutation-check
// Source files are restored after each mutation, including on Ctrl+C.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

interface Mutation {
  breaks: string;
  file: string;
  find: string;
  replace: string;
  testFile: string;
  testName?: string;
}

const mutations: Mutation[] = [
  {
    breaks: 'Read balances without a row lock (drop FOR UPDATE)',
    file: 'src/ledger/transfers.ts',
    find: '        ORDER BY id\n          FOR UPDATE`',
    replace: '        ORDER BY id`',
    testFile: 'test/concurrency.test.ts',
    testName: 'never overdraws',
  },
  {
    breaks: 'Lock accounts in request order instead of id order',
    file: 'src/ledger/transfers.ts',
    find: '        ORDER BY id\n',
    replace: '        ORDER BY array_position($1::uuid[], id)\n',
    testFile: 'test/concurrency.test.ts',
    testName: 'does not deadlock',
  },
  {
    breaks: 'No advisory lock on the idempotency key',
    file: 'src/ledger/transfers.ts',
    find: "await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [",
    replace: 'void ([',
    testFile: 'test/idempotency.test.ts',
    testName: 'concurrent duplicates',
  },
  {
    breaks: 'Commit the transfer row before updating balances (two transactions)',
    file: 'src/ledger/transfers.ts',
    find: 'await faults?.afterInsert?.(db);',
    replace:
      "await db.query('COMMIT'); await db.query('BEGIN'); " +
      "await db.query(\"SELECT set_config('app.tenant_id', $1, true)\", [tenantId]); " +
      'await faults?.afterInsert?.(db);',
    testFile: 'test/idempotency.test.ts',
    testName: 'crash halfway',
  },
  {
    breaks: 'Row-level security off for accounts',
    file: 'migrations/0001_init.sql',
    find: 'alter table accounts  enable row level security;',
    replace: '',
    testFile: 'test/tenant-isolation.test.ts',
  },
  {
    breaks: "Fastify's default validator (type coercion on)",
    file: 'src/app.ts',
    find: 'coerceTypes: false,',
    replace: 'coerceTypes: true,',
    testFile: 'test/api.test.ts',
    testName: 'JSON number',
  },
  {
    breaks: 'Skip the app balance check (the CHECK constraint still stops the overdraft, as a 500)',
    file: 'src/ledger/transfers.ts',
    find: 'if (!from.allow_negative && BigInt(from.balance) < amount) {',
    replace: 'if (false) {',
    testFile: 'test/concurrency.test.ts',
    testName: 'never overdraws',
  },
];

const vitestCli = path.join(
  path.dirname(createRequire(import.meta.url).resolve('vitest/package.json')),
  'vitest.mjs',
);

let restore: (() => void) | undefined;
process.on('SIGINT', () => {
  restore?.();
  process.exit(130);
});

const results: { breaks: string; caught: boolean; evidence: string }[] = [];

for (const m of mutations) {
  const original = readFileSync(m.file, 'utf8');
  if (!original.includes(m.find)) {
    results.push({ breaks: m.breaks, caught: false, evidence: `mutation no longer applies to ${m.file}` });
    continue;
  }
  restore = () => writeFileSync(m.file, original);
  try {
    writeFileSync(m.file, original.replace(m.find, m.replace));
    const args = [vitestCli, 'run', m.testFile, ...(m.testName ? ['-t', m.testName] : [])];
    const run = spawnSync(process.execPath, args, {
      encoding: 'utf8',
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
    });
    // eslint-disable-next-line no-control-regex
    const output = `${run.stdout}\n${run.stderr}`.replace(/\x1b\[[0-9;]*m/g, '');
    const summary = output.match(/Tests\s+.*$/m)?.[0]?.trim() ?? 'no summary';
    const firstError =
      output.match(/^\s*(AssertionError|Error|TypeError): .*$/m)?.[0]?.trim() ??
      output.match(/^\s*(Expected|expected).*$/m)?.[0]?.trim() ??
      '';
    results.push({ breaks: m.breaks, caught: run.status !== 0, evidence: `${summary}  ${firstError}`.trim() });
  } finally {
    restore();
    restore = undefined;
  }
  const last = results[results.length - 1]!;
  console.log(`${last.caught ? 'CAUGHT ' : 'MISSED '} ${m.breaks}\n         ${last.evidence}`);
}

const missed = results.filter((r) => !r.caught);
console.log(`\n${results.length - missed.length}/${results.length} mutations caught by the tests`);
process.exit(missed.length === 0 ? 0 : 1);
