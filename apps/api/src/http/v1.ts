import type { FastifyPluginAsync } from 'fastify';
import type pg from 'pg';
import { answerQuestion } from '../assistant/answer.js';
import type { AssistantModel } from '../assistant/model.js';
import { authenticateApiKey } from '../auth.js';
import { LedgerError } from '../errors.js';
import { createAccount, getAccount } from '../ledger/accounts.js';
import { createTransfer, getTransfer, listAccountTransfers } from '../ledger/transfers.js';
import { AMOUNT_PATTERN } from '../money.js';

declare module 'fastify' {
  interface FastifyRequest {
    tenantId: string;
  }
}

const uuid = { type: 'string', format: 'uuid' } as const;
const currency = { type: 'string', pattern: '^[A-Z]{3}$' } as const;
const idParams = {
  type: 'object',
  required: ['id'],
  additionalProperties: false,
  properties: { id: uuid },
} as const;

interface CreateAccountBody {
  reference: string;
  currency: string;
  allow_negative?: boolean;
}

interface CreateTransferBody {
  from_account_id: string;
  to_account_id: string;
  amount: string;
  currency: string;
  description?: string | null;
  metadata?: Record<string, string>;
}

export const v1Routes: FastifyPluginAsync<{
  pool: pg.Pool;
  assistantModel: AssistantModel | null;
}> = async (app, { pool, assistantModel }) => {
  app.decorateRequest('tenantId', '');

  // Runs before body validation, so an unauthenticated caller learns nothing about the API.
  app.addHook('onRequest', async (req) => {
    const match = req.headers.authorization?.match(/^Bearer (\S+)$/);
    const tenantId = match ? await authenticateApiKey(pool, match[1]!) : null;
    if (!tenantId) throw new LedgerError('unauthorized', 401, 'missing or invalid API key');
    req.tenantId = tenantId;
  });

  app.post<{ Body: CreateAccountBody }>(
    '/accounts',
    {
      schema: {
        body: {
          type: 'object',
          required: ['reference', 'currency'],
          additionalProperties: false,
          properties: {
            reference: { type: 'string', minLength: 1, maxLength: 200 },
            currency,
            allow_negative: { type: 'boolean' },
          },
        },
      },
    },
    async (req, reply) => {
      const { account, created } = await createAccount(pool, req.tenantId, {
        reference: req.body.reference,
        currency: req.body.currency,
        allowNegative: req.body.allow_negative ?? false,
      });
      return reply.status(created ? 201 : 200).send(account);
    },
  );

  app.get<{ Params: { id: string } }>(
    '/accounts/:id',
    { schema: { params: idParams } },
    async (req) => getAccount(pool, req.tenantId, req.params.id),
  );

  app.get<{ Params: { id: string }; Querystring: { limit?: string; cursor?: string } }>(
    '/accounts/:id/transfers',
    {
      schema: {
        params: idParams,
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            // Strings because type coercion is off (see app.ts); parsed below.
            limit: { type: 'string', pattern: '^(?:[1-9][0-9]?|100)$' },
            cursor: { type: 'string', pattern: '^[1-9][0-9]{0,18}$' },
          },
        },
      },
    },
    async (req) =>
      listAccountTransfers(pool, req.tenantId, req.params.id, {
        limit: Number(req.query.limit ?? 50),
        cursor: req.query.cursor ?? null,
      }),
  );

  app.post<{ Headers: { 'idempotency-key': string }; Body: CreateTransferBody }>(
    '/transfers',
    {
      schema: {
        headers: {
          type: 'object',
          required: ['idempotency-key'],
          properties: {
            'idempotency-key': {
              type: 'string',
              minLength: 1,
              maxLength: 255,
              pattern: '^[\\x21-\\x7E]+$',
            },
          },
        },
        body: {
          type: 'object',
          required: ['from_account_id', 'to_account_id', 'amount', 'currency'],
          additionalProperties: false,
          properties: {
            from_account_id: uuid,
            to_account_id: uuid,
            amount: { type: 'string', pattern: AMOUNT_PATTERN },
            currency,
            description: { type: ['string', 'null'], maxLength: 500 },
            metadata: {
              type: 'object',
              maxProperties: 20,
              propertyNames: { minLength: 1, maxLength: 40 },
              additionalProperties: { type: 'string', maxLength: 500 },
            },
          },
        },
      },
    },
    async (req, reply) => {
      const { transfer, replayed } = await createTransfer(
        pool,
        req.tenantId,
        req.headers['idempotency-key'],
        {
          fromAccountId: req.body.from_account_id,
          toAccountId: req.body.to_account_id,
          amount: req.body.amount,
          currency: req.body.currency,
          description: req.body.description ?? null,
          metadata: req.body.metadata ?? {},
        },
      );
      if (replayed) reply.header('Idempotent-Replayed', 'true');
      return reply.status(replayed ? 200 : 201).send(transfer);
    },
  );

  app.get<{ Params: { id: string } }>(
    '/transfers/:id',
    { schema: { params: idParams } },
    async (req) => getTransfer(pool, req.tenantId, req.params.id),
  );

  app.post<{ Body: { question: string; account_id?: string } }>(
    '/assistant/answers',
    {
      schema: {
        body: {
          type: 'object',
          required: ['question'],
          additionalProperties: false,
          properties: {
            question: { type: 'string', minLength: 1, maxLength: 1000 },
            account_id: uuid,
          },
        },
      },
    },
    async (req) => {
      if (!assistantModel) {
        throw new LedgerError('assistant_unavailable', 503, 'the assistant is not configured on this server');
      }
      return answerQuestion(
        { pool, model: assistantModel },
        { tenantId: req.tenantId, question: req.body.question, accountId: req.body.account_id ?? null },
      );
    },
  );
};
