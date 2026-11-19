import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { revokeApiKey } from '../src/admin.js';
import { balanceOf, createAccount, fund, newTenant, startTestEnv, type TestEnv } from './helpers.js';

describe('API contract', () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await startTestEnv();
  });
  afterAll(async () => {
    await env.close();
  });

  describe('authentication', () => {
    it.each([
      ['no header', undefined],
      ['a malformed header', 'Token abc'],
      ['an unknown key', 'Bearer lp_not-a-real-key'],
    ])('rejects %s with 401', async (_label, authorization) => {
      const res = await env.app.inject({
        method: 'GET',
        url: `/v1/accounts/${randomUUID()}`,
        headers: authorization ? { authorization } : {},
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('unauthorized');
    });

    it('rejects a revoked key', async () => {
      const { api, apiKeyId } = await newTenant(env);
      expect((await api.createAccount({ reference: 'a', currency: 'USD' })).statusCode).toBe(201);
      await revokeApiKey(env.adminPool, apiKeyId);
      expect((await api.createAccount({ reference: 'b', currency: 'USD' })).statusCode).toBe(401);
    });
  });

  describe('accounts', () => {
    it('creating the same reference twice returns the same account; different settings conflict', async () => {
      const { api } = await newTenant(env);
      const first = await api.createAccount({ reference: 'wallet:1', currency: 'USD' });
      const again = await api.createAccount({ reference: 'wallet:1', currency: 'USD' });
      const clash = await api.createAccount({ reference: 'wallet:1', currency: 'EUR' });

      expect(first.statusCode).toBe(201);
      expect(again.statusCode).toBe(200);
      expect(again.json().id).toBe(first.json().id);
      expect(clash.statusCode).toBe(409);
      expect(first.json().balance).toBe('0');
    });
  });

  describe('money is exact', () => {
    // Would fail if any layer turned the amount into a JS number: 2^53 + 1 is not representable
    // as a double and would come back as ...992.
    it('moves 9007199254740993 (2^53 + 1) minor units without losing a unit', async () => {
      const { api } = await newTenant(env);
      const world = await createAccount(api, 'world', { allowNegative: true });
      const wallet = await createAccount(api, 'wallet');

      const res = await api.transfer({
        from_account_id: world.id,
        to_account_id: wallet.id,
        amount: '9007199254740993',
        currency: 'USD',
      });

      expect(res.statusCode).toBe(201);
      expect(res.json().amount).toBe('9007199254740993');
      expect(await balanceOf(api, wallet.id)).toBe('9007199254740993');
      expect(await balanceOf(api, world.id)).toBe('-9007199254740993');
    });

    // Would fail with Fastify's default validator settings (coerceTypes), which accept the
    // number and turn it into the string "9007199254740992": one unit silently lost.
    it('rejects an amount sent as a JSON number', async () => {
      const { apiKey, api } = await newTenant(env);
      const world = await createAccount(api, 'world', { allowNegative: true });
      const wallet = await createAccount(api, 'wallet');

      const res = await env.app.inject({
        method: 'POST',
        url: '/v1/transfers',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'idempotency-key': randomUUID(),
          'content-type': 'application/json',
        },
        payload: `{"from_account_id":"${world.id}","to_account_id":"${wallet.id}","amount":9007199254740993,"currency":"USD"}`,
      });

      expect(res.statusCode).toBe(400);
      expect(await balanceOf(api, wallet.id)).toBe('0');
    });

    it.each([
      ['a decimal', '10.5'],
      ['zero', '0'],
      ['a negative', '-5'],
      ['leading zeros', '007'],
      ['text', 'ten'],
      ['more than the 64-bit limit', '9223372036854775808'],
    ])('rejects %s amount with 400', async (_label, amount) => {
      const { api } = await newTenant(env);
      const world = await createAccount(api, 'world', { allowNegative: true });
      const wallet = await createAccount(api, 'wallet');
      const res = await api.transfer({
        from_account_id: world.id,
        to_account_id: wallet.id,
        amount,
        currency: 'USD',
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 422 instead of overflowing a balance past the 64-bit limit', async () => {
      const { api } = await newTenant(env);
      const world = await createAccount(api, 'world', { allowNegative: true });
      const wallet = await createAccount(api, 'wallet');
      await fund(api, world.id, wallet.id, '9223372036854775807');

      const res = await api.transfer({
        from_account_id: world.id,
        to_account_id: wallet.id,
        amount: '1',
        currency: 'USD',
      });

      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe('balance_out_of_range');
      expect(await balanceOf(api, wallet.id)).toBe('9223372036854775807');
    });
  });

  describe('transfer validation', () => {
    async function setup() {
      const tenant = await newTenant(env);
      const world = await createAccount(tenant.api, 'world', { allowNegative: true });
      const usd = await createAccount(tenant.api, 'wallet:usd');
      const eur = await createAccount(tenant.api, 'wallet:eur', { currency: 'EUR' });
      return { ...tenant, world, usd, eur };
    }

    // Fastify's default (removeAdditional) would silently drop the misspelled field.
    it('rejects unknown fields instead of ignoring them', async () => {
      const { api, world, usd } = await setup();
      const res = await api.transfer({
        from_account_id: world.id,
        to_account_id: usd.id,
        amount: '1',
        currency: 'USD',
        ammount: '1000',
      } as never);
      expect(res.statusCode).toBe(400);
    });

    it('requires an Idempotency-Key header', async () => {
      const { apiKey, world, usd } = await setup();
      const res = await env.app.inject({
        method: 'POST',
        url: '/v1/transfers',
        headers: { authorization: `Bearer ${apiKey}` },
        payload: { from_account_id: world.id, to_account_id: usd.id, amount: '1', currency: 'USD' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects a transfer to the same account', async () => {
      const { api, usd } = await setup();
      const res = await api.transfer({
        from_account_id: usd.id,
        to_account_id: usd.id,
        amount: '1',
        currency: 'USD',
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('same_account');
    });

    it('rejects a currency mismatch with 422', async () => {
      const { api, world, eur } = await setup();
      const res = await api.transfer({
        from_account_id: world.id,
        to_account_id: eur.id,
        amount: '1',
        currency: 'USD',
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe('currency_mismatch');
    });
  });

  describe('history', () => {
    it('lists an account’s transfers newest first, with cursor pagination', async () => {
      const { api } = await newTenant(env);
      const world = await createAccount(api, 'world', { allowNegative: true });
      const wallet = await createAccount(api, 'wallet');
      for (const amount of ['1', '2', '3']) await fund(api, world.id, wallet.id, amount);

      const page1 = await api.get(`/v1/accounts/${wallet.id}/transfers?limit=2`);
      expect(page1.statusCode).toBe(200);
      expect(page1.json().data.map((t: { amount: string }) => t.amount)).toEqual(['3', '2']);
      const cursor = page1.json().next_cursor;
      expect(cursor).toEqual(expect.any(String));

      const page2 = await api.get(`/v1/accounts/${wallet.id}/transfers?limit=2&cursor=${cursor}`);
      expect(page2.json().data.map((t: { amount: string }) => t.amount)).toEqual(['1']);
      expect(page2.json().next_cursor).toBeNull();

      const one = await api.get(`/v1/transfers/${page2.json().data[0].id}`);
      expect(one.statusCode).toBe(200);
      expect(one.json().amount).toBe('1');
    });
  });

  it('answers /health and returns JSON 404s for unknown routes', async () => {
    expect((await env.app.inject({ method: 'GET', url: '/health' })).json()).toEqual({ status: 'ok' });
    const missing = await env.app.inject({ method: 'GET', url: '/nope' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('not_found');
  });
});
