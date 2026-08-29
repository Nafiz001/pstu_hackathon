/**
 * Account reads: balance, and looking up who you are about to pay.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query } from '../../platform/db/pool.js';
import { contextOf, currentUser, requireAuth } from '../../platform/http/context.js';
import { errors } from '../../platform/errors/index.js';
import { readBalance, writeBalance } from '../../platform/cache/balance.cache.js';
import { money, toMinor } from '../../shared/money.js';
import { phoneSchema } from '../auth/auth.schemas.js';
import * as authRepo from '../auth/auth.repo.js';
import { setOwnFreeze } from './account.service.js';

const searchSchema = z.object({ q: phoneSchema });

export async function accountRoutes(app: FastifyInstance): Promise<void> {
  app.get('/accounts/me', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = currentUser(request);
    const account = await authRepo.findAccountByUserId(id);
    if (!account) throw errors.notFound('Account');

    /**
     * Read-through cache.
     *
     * The row has already been read above (it also carries the account's status and id), so the
     * cache is consulted for its *version* rather than to avoid the query: if Redis holds a
     * newer version than this connection just saw — possible when reading a replica, or a
     * snapshot taken microseconds before another transaction committed — the cached balance is
     * the more recent truth. Otherwise the database value wins and is published back.
     *
     * Either way the answer comes from a value the ledger produced. Redis can only ever make
     * this fresher, never authoritative.
     */
    const cached = await readBalance(account.id);
    const useCache = cached !== null && cached.version > account.version;
    const balanceMinor = useCache ? cached.balanceMinor : account.balanceMinor;

    if (!useCache) {
      await writeBalance(account.id, {
        balanceMinor: account.balanceMinor,
        version: account.version,
      });
    }

    // Rolling 24h outbound total, for the daily-limit indicator in the UI.
    const { rows } = await query<{ spent: string | null }>(
      `SELECT COALESCE(SUM(amount_minor), 0)::bigint AS spent
         FROM transfers
        WHERE from_account_id = $1
          AND type IN ('P2P', 'REQUEST_SETTLEMENT', 'SCHEDULED')
          AND created_at >= now() - interval '24 hours'`,
      [account.id],
    );

    return reply.send({
      account: {
        id: account.id,
        status: account.status,
        balance: money(balanceMinor),
        spentLast24h: money(toMinor(rows[0]?.spent ?? '0')),
        servedFromCache: useCache,
      },
    });
  });

  /**
   * The emergency freeze toggle.
   *
   * PATCH, because it changes one field of an existing resource. Freezing needs nothing but the
   * session; unfreezing needs the PIN — see account.service.ts for why they are asymmetric.
   */
  app.patch('/accounts/me/freeze', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = currentUser(request);
    const { frozen, pin } = z
      .object({ frozen: z.boolean(), pin: z.string().regex(/^\d{4}$/).optional() })
      .parse(request.body);

    const account = await setOwnFreeze(id, frozen, pin, contextOf(request));
    return reply.send({ account });
  });

  /**
   * Exact-phone lookup only. A prefix or name search here would be a user-enumeration endpoint:
   * anyone could harvest the platform's user list. Paying someone requires knowing their number.
   */
  app.get('/users/search', { preHandler: requireAuth }, async (request, reply) => {
    const { q } = searchSchema.parse(request.query);
    const me = currentUser(request);

    const user = await authRepo.findUserByPhone(q);
    if (!user || user.status !== 'ACTIVE') throw errors.notFound('User');

    return reply.send({
      user: { id: user.id, phone: user.phone, name: user.name, isSelf: user.id === me.id },
    });
  });
}
