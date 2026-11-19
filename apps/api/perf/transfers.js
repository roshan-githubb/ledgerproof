// k6 load script, driven by scripts/perf.ts. Not meant to be run by hand.
// Each virtual user owns two wallets, so the scenarios differ in exactly one thing:
//   SCENARIO=control  each VU moves money back and forth between its own two wallets.
//                     No two concurrent transfers share a row.
//   SCENARIO=hot      each VU tops up its own wallet from the one funding account.
//                     The funding account is the only shared row.
import http from 'k6/http';
import { check } from 'k6';
import exec from 'k6/execution';

const seed = JSON.parse(open(__ENV.SEED_FILE));
const scenario = __ENV.SCENARIO;

export const options = {
  scenarios: {
    load: {
      executor: 'constant-vus',
      vus: Number(__ENV.VUS),
      duration: __ENV.DURATION,
    },
  },
  summaryTrendStats: ['avg', 'p(50)', 'p(95)', 'p(99)', 'max'],
};

export default function () {
  const vu = exec.vu.idInTest - 1; // 0-based
  const mine = [seed.wallets[2 * vu], seed.wallets[2 * vu + 1]];
  let from;
  let to;
  if (scenario === 'hot') {
    from = seed.fundingId;
    to = mine[0];
  } else {
    const flip = exec.vu.iterationInScenario % 2;
    from = mine[flip];
    to = mine[1 - flip];
  }

  const res = http.post(
    `${seed.baseUrl}/v1/transfers`,
    JSON.stringify({ from_account_id: from, to_account_id: to, amount: '1', currency: 'USD' }),
    {
      headers: {
        authorization: `Bearer ${seed.apiKey}`,
        'content-type': 'application/json',
        'idempotency-key': `${__ENV.RUN_ID}-${exec.vu.idInTest}-${exec.vu.iterationInScenario}`,
      },
    },
  );
  check(res, { created: (r) => r.status === 201 });
}

export function handleSummary(data) {
  return { [__ENV.SUMMARY_FILE]: JSON.stringify(data) };
}
