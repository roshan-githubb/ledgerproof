import type Anthropic from '@anthropic-ai/sdk';
import type pg from 'pg';
import { withTenantTx, type Db } from '../db/tx.js';
import { LedgerError } from '../errors.js';
import { findAccount, searchAccounts, type Account } from '../ledger/accounts.js';
import type { FactSheet } from './facts.js';
import { formatAmount, formatTimestamp } from './format.js';

/**
 * Every database read the assistant makes goes through here: tenant-scoped by row-level
 * security like the rest of the API, and READ ONLY, so no tool, bug or prompt can change money.
 */
export function assistantDb<T>(pool: pg.Pool, tenantId: string, fn: (db: Db) => Promise<T>) {
  return withTenantTx(pool, tenantId, fn, { readOnly: true });
}

export interface ToolContext {
  pool: pg.Pool;
  /** From the API key, never from the model. */
  tenantId: string;
  /** Set in customer-facing mode: tools may only touch this account. */
  scopeAccountId: string | null;
  facts: FactSheet;
}

export interface ToolOutcome {
  content: string;
  isError: boolean;
}

const accountId = {
  type: 'string',
  format: 'uuid',
  description: 'The account_id from a find_accounts result. Never ask the user for it.',
} as const;

/** strict: true guarantees schema-valid arguments; limits are checked in code (strict schemas can't express them). */
export const ASSISTANT_TOOLS: Anthropic.Beta.Messages.BetaTool[] = [
  {
    name: 'find_accounts',
    description:
      'Find accounts by their reference and get each one\'s account_id and balance. Call this first whenever the user names or describes an account ("Sita\'s wallet", "the funding account") and you do not already have its account_id. Omit query to list the accounts you can see (up to 20).',
    strict: true,
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: {
          type: 'string',
          description: 'Text to look for in account references, for example "sita" or "funding".',
        },
      },
      required: [],
    },
  },
  {
    name: 'get_balance',
    description: 'Get the current balance of one account. Call this when the user asks how much an account has.',
    strict: true,
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: { account_id: accountId },
      required: ['account_id'],
    },
  },
  {
    name: 'list_transfers',
    description:
      'List the most recent transfers into and out of one account, newest first: amount, direction, the other account, description and time. Call this when the user asks what happened to an account\'s money or about specific payments.',
    strict: true,
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        account_id: accountId,
        limit: { type: 'integer', description: 'How many transfers, 1 to 20. Default 10.' },
      },
      required: ['account_id'],
    },
  },
  {
    name: 'summarize_transfers',
    description:
      'Count and total an account\'s transfers over a date range: number of transfers, total in, total out and net change. Call this for any question about totals or sums ("how much did she spend this month?"). Never add amounts up yourself.',
    strict: true,
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        account_id: accountId,
        from: { type: 'string', format: 'date', description: 'First day included, YYYY-MM-DD (UTC). Omit for no start limit.' },
        to: { type: 'string', format: 'date', description: 'Last day included, YYYY-MM-DD (UTC). Omit for no end limit.' },
      },
      required: ['account_id'],
    },
  },
];

class ToolInputError extends Error {}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function asObject(input: unknown): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new ToolInputError('input must be an object');
  }
  return input as Record<string, unknown>;
}

function requireAccountId(input: Record<string, unknown>): string {
  const id = input.account_id;
  if (typeof id !== 'string' || !UUID.test(id)) throw new ToolInputError('account_id must be a uuid from find_accounts');
  return id.toLowerCase();
}

function optionalDate(input: Record<string, unknown>, key: string): string | null {
  const value = input[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !DATE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new ToolInputError(`${key} must be a date like 2026-11-26`);
  }
  return value;
}

function assertInScope(ctx: ToolContext, id: string) {
  if (ctx.scopeAccountId !== null && id !== ctx.scopeAccountId) {
    throw new ToolInputError('this conversation can only see one account, and that is not it');
  }
}

/** An account as the model sees it: values it may mention arrive as facts. */
function accountView(account: Account, facts: FactSheet) {
  return {
    account_id: account.id,
    reference: facts.add('account reference', account.reference),
    balance: facts.add(`balance of ${account.reference}`, formatAmount(account.balance, account.currency)),
    kind: account.allow_negative
      ? 'funding or system account (goes negative as money enters the ledger)'
      : 'regular account (can never go negative)',
  };
}

async function findAccountsTool(input: Record<string, unknown>, ctx: ToolContext) {
  const query = input.query;
  if (query !== undefined && (typeof query !== 'string' || query.length > 100)) {
    throw new ToolInputError('query must be text of at most 100 characters');
  }
  const accounts = await assistantDb(ctx.pool, ctx.tenantId, (db) =>
    ctx.scopeAccountId !== null
      ? findAccount(db, ctx.scopeAccountId).then((a) => [a])
      : searchAccounts(db, typeof query === 'string' ? query : '', 20),
  );
  return { accounts: accounts.map((a) => accountView(a, ctx.facts)) };
}

async function getBalanceTool(input: Record<string, unknown>, ctx: ToolContext) {
  const id = requireAccountId(input);
  assertInScope(ctx, id);
  const account = await assistantDb(ctx.pool, ctx.tenantId, (db) => findAccount(db, id));
  return accountView(account, ctx.facts);
}

async function listTransfersTool(input: Record<string, unknown>, ctx: ToolContext) {
  const id = requireAccountId(input);
  assertInScope(ctx, id);
  const limit = input.limit ?? 10;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 20) {
    throw new ToolInputError('limit must be a whole number from 1 to 20');
  }
  const { account, rows } = await assistantDb(ctx.pool, ctx.tenantId, async (db) => {
    const account = await findAccount(db, id);
    const { rows } = await db.query<{
      amount: string;
      currency: string;
      description: string | null;
      created_at: Date;
      from_account_id: string;
      from_reference: string;
      to_reference: string;
    }>(
      `SELECT t.amount::text, t.currency, t.description, t.created_at, t.from_account_id,
              fa.reference AS from_reference, ta.reference AS to_reference
         FROM transfers t
         JOIN accounts fa ON fa.id = t.from_account_id
         JOIN accounts ta ON ta.id = t.to_account_id
        WHERE t.from_account_id = $1 OR t.to_account_id = $1
        ORDER BY t.seq DESC
        LIMIT $2`,
      [id, limit],
    );
    return { account, rows };
  });
  return {
    account: ctx.facts.add('account reference', account.reference),
    transfers: rows.map((t) => {
      const out = t.from_account_id === id;
      return {
        direction: out ? 'out' : 'in',
        amount: ctx.facts.add(`transfer ${out ? 'out of' : 'into'} ${account.reference}`, formatAmount(t.amount, t.currency)),
        other_account: ctx.facts.add('account reference', out ? t.to_reference : t.from_reference),
        time: ctx.facts.add('transfer time', formatTimestamp(t.created_at)),
        // Ledger data, not instructions. It can contain digits, so it is a fact too.
        description: t.description === null ? null : ctx.facts.add('transfer description', t.description),
      };
    }),
  };
}

async function summarizeTransfersTool(input: Record<string, unknown>, ctx: ToolContext) {
  const id = requireAccountId(input);
  assertInScope(ctx, id);
  const from = optionalDate(input, 'from');
  const to = optionalDate(input, 'to');
  const { account, totals } = await assistantDb(ctx.pool, ctx.tenantId, async (db) => {
    const account = await findAccount(db, id);
    const { rows } = await db.query<{ n: string; total_in: string; total_out: string }>(
      `SELECT count(*)::text AS n,
              coalesce(sum(amount) FILTER (WHERE to_account_id = $1), 0)::text AS total_in,
              coalesce(sum(amount) FILTER (WHERE from_account_id = $1), 0)::text AS total_out
         FROM transfers
        WHERE (from_account_id = $1 OR to_account_id = $1)
          AND ($2::date IS NULL OR created_at >= ($2::date)::timestamp AT TIME ZONE 'UTC')
          AND ($3::date IS NULL OR created_at < ($3::date + 1)::timestamp AT TIME ZONE 'UTC')`,
      [id, from, to],
    );
    return { account, totals: rows[0]! };
  });
  const net = (BigInt(totals.total_in) - BigInt(totals.total_out)).toString();
  const ref = account.reference;
  return {
    account: ctx.facts.add('account reference', ref),
    period: {
      from: from === null ? 'no start limit' : ctx.facts.add('period start', from),
      to: to === null ? 'no end limit' : ctx.facts.add('period end', to),
    },
    transfer_count: ctx.facts.add(`number of transfers for ${ref}`, totals.n),
    total_in: ctx.facts.add(`total into ${ref}`, formatAmount(totals.total_in, account.currency)),
    total_out: ctx.facts.add(`total out of ${ref}`, formatAmount(totals.total_out, account.currency)),
    net_change: ctx.facts.add(`net change of ${ref}`, formatAmount(net, account.currency)),
  };
}

const TOOLS: Record<string, (input: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>> = {
  find_accounts: findAccountsTool,
  get_balance: getBalanceTool,
  list_transfers: listTransfersTool,
  summarize_transfers: summarizeTransfersTool,
};

/** Runs one tool call. Bad input or a missing account becomes an error result the model can read, not a crash. */
export async function runTool(name: string, input: unknown, ctx: ToolContext): Promise<ToolOutcome> {
  const tool = TOOLS[name];
  if (!tool) return { content: JSON.stringify({ error: `unknown tool ${name}` }), isError: true };
  try {
    return { content: JSON.stringify(await tool(asObject(input), ctx)), isError: false };
  } catch (err) {
    if (err instanceof ToolInputError) return { content: JSON.stringify({ error: err.message }), isError: true };
    if (err instanceof LedgerError && err.code === 'not_found') {
      return { content: JSON.stringify({ error: 'account not found' }), isError: true };
    }
    throw err;
  }
}
