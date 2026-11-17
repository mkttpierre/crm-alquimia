import { expect, it, vi } from 'vitest';
import type pg from 'pg';
import { runBeforeSend } from './before-send';
import { createLogger } from '../obs/logger';

it.each([true, 'true'])('STOP impede envio automatico com marca %s', async (marca) => {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('as stopped')) return { rows: [{ stopped: false, lead_custom_fields: [{ nao_contatar: marca }] }] };
    return { rows: [] };
  });
  const client = { query, release: vi.fn() };
  const send = vi.fn().mockResolvedValue({ kind: 'queued' });
  const result = await runBeforeSend({ pool: { connect: async () => client } as unknown as pg.Pool, log: createLogger(), tenantId: 'org', leadId: 'contact', channelSessionId: 'session', body: 'teste', optedOutThisTurn: false, crmDailyLimit: null, now: new Date(), send, gates: [{ name: 'stop', evaluate: ctx => ctx.optedOut ? { pass: false, code: 'stopped', reason: 'stop' } : { pass: true } }] });
  expect(result.status).toBe('vetoed');
  expect(send).not.toHaveBeenCalled();
});
