import Anthropic from '@anthropic-ai/sdk';
import Fastify, { type FastifyError, type FastifyServerOptions } from 'fastify';
import type pg from 'pg';
import type { AssistantModel } from './assistant/model.js';
import { LedgerError } from './errors.js';
import { v1Routes } from './http/v1.js';

/** Postgres errors that mean "contention, try again", not "your request is wrong". */
const RETRYABLE_PG_CODES = new Set([
  '40001', // serialization_failure
  '40P01', // deadlock_detected
  '55P03', // lock_not_available
  '57014', // query_canceled (statement_timeout)
]);

const errorBody = (code: string, message: string) => ({ error: { code, message } });

export function buildApp(opts: {
  pool: pg.Pool;
  logger?: FastifyServerOptions['logger'];
  /** null or omitted: the assistant endpoint answers 503. */
  assistantModel?: AssistantModel | null;
}) {
  const app = Fastify({
    logger: opts.logger ?? false,
    ajv: {
      customOptions: {
        // Fastify's defaults would turn the JSON number 9007199254740993 into the string
        // "9007199254740992" (coercion) and silently drop misspelled fields (removeAdditional).
        // For a money API both must be rejected instead. Proven by test/api.test.ts.
        coerceTypes: false,
        removeAdditional: false,
      },
    },
  });

  app.setErrorHandler((err: FastifyError, req, reply) => {
    if (err instanceof LedgerError) {
      return reply.status(err.httpStatus).send(errorBody(err.code, err.message));
    }
    if (err.validation) {
      return reply.status(400).send(errorBody('validation_error', err.message));
    }
    // Failures calling the language model. Most specific first.
    if (err instanceof Anthropic.RateLimitError) {
      req.log.warn({ err }, 'model rate limited');
      return reply.status(503).send(errorBody('try_again', 'the assistant is busy; try again shortly'));
    }
    if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
      req.log.error({ err }, 'model credentials rejected');
      return reply.status(503).send(errorBody('assistant_unavailable', 'the assistant is not configured correctly'));
    }
    if (err instanceof Anthropic.APIError) {
      req.log.error({ err }, 'model request failed');
      return reply.status(502).send(errorBody('assistant_upstream_error', 'the assistant could not reach its model'));
    }
    const pgCode = (err as { code?: string }).code;
    if (pgCode === '22003') {
      return reply
        .status(422)
        .send(errorBody('balance_out_of_range', 'this transfer would push a balance past the 64-bit limit'));
    }
    if (pgCode && RETRYABLE_PG_CODES.has(pgCode)) {
      req.log.warn({ err }, 'retryable database error');
      return reply
        .status(503)
        .send(errorBody('try_again', 'temporary contention; retry with the same Idempotency-Key'));
    }
    if (err.statusCode && err.statusCode >= 400 && err.statusCode < 500) {
      return reply.status(err.statusCode).send(errorBody('bad_request', err.message));
    }
    req.log.error({ err }, 'unhandled error');
    return reply.status(500).send(errorBody('internal_error', 'internal error'));
  });

  app.setNotFoundHandler((_req, reply) =>
    reply.status(404).send(errorBody('not_found', 'route not found')),
  );

  app.get('/health', async () => {
    await opts.pool.query('SELECT 1');
    return { status: 'ok' };
  });

  app.register(v1Routes, {
    prefix: '/v1',
    pool: opts.pool,
    assistantModel: opts.assistantModel ?? null,
  });

  return app;
}
