/**
 * Authentication and the funded-registration flow.
 *
 * The interesting part is registration. The signup bonus is NOT a balance column initialised to
 * 100,000 — it is a real double-entry mint from the treasury, executed in the same transaction
 * that creates the user and the account. Two consequences follow, and both are the point:
 *
 *   1. Registration is all-or-nothing. There is no window in which a user exists without an
 *      account, or an account exists without its funding entry. "Create the user now, fund them
 *      in a moment" is exactly the pattern that produces unexplainable balances in production.
 *
 *   2. Every poisha in the system traceably came from somewhere. SUM(balance_minor) across all
 *      accounts stays 0 forever, because the treasury holds the negative image of every mint.
 *      That is what makes reconciliation invariant #1 a real check rather than a tautology.
 */
import { randomUUID } from 'node:crypto';
import { config, pickTreasuryStripe } from '../../config/index.js';
import { withTransaction } from '../../platform/db/transaction.js';
import { trackWrite } from '../../platform/db/read-router.js';
import type { Tx } from '../../platform/db/transaction.js';
import { generateRefreshToken, hashSecret, hashToken, verifySecret } from '../../platform/auth/crypto.js';
import { issueAccessToken } from '../../platform/auth/jwt.js';
import { errors, PG_ERRORS, pgErrorCode } from '../../platform/errors/index.js';
import { enqueueEvent } from '../../platform/outbox/index.js';
import { logger } from '../../platform/logging/index.js';
import { money } from '../../shared/money.js';
import { postDoubleEntry } from '../transfers/ledger.service.js';
import * as repo from './auth.repo.js';
import type { LoginInput, RegisterInput } from './auth.schemas.js';

export interface RequestContext {
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
}

export interface AuthResult {
  user: { id: string; phone: string; name: string };
  account: { id: string; balance: ReturnType<typeof money> };
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

async function issueSession(
  tx: Tx,
  user: { id: string; phone: string },
  familyId: string,
  context: RequestContext,
): Promise<{ accessToken: string; refreshToken: string; expiresIn: number; tokenId: string }> {
  const { token: refreshToken, hash } = generateRefreshToken();
  const { token: accessToken, expiresIn } = issueAccessToken(user);

  const { id: tokenId } = await repo.insertRefreshToken(tx, {
    userId: user.id,
    familyId,
    tokenHash: hash,
    expiresAt: new Date(Date.now() + config.REFRESH_TOKEN_TTL_SECONDS * 1000),
    userAgent: context.userAgent,
    ip: context.ip,
  });

  return { accessToken, refreshToken, expiresIn, tokenId };
}

export async function register(
  input: RegisterInput,
  context: RequestContext,
): Promise<AuthResult> {
  // Argon2id is intentionally expensive (~19 MiB, ~50 ms). Doing it before BEGIN keeps that cost
  // off a pooled connection and out of any lock window.
  const [passwordHash, pinHash] = await Promise.all([
    hashSecret(input.password),
    hashSecret(input.pin),
  ]);

  try {
    return await withTransaction(async (tx) => {
      const user = await repo.insertUser(tx, {
        phone: input.phone,
        name: input.name,
        passwordHash,
        pinHash,
      });

      const account = await repo.insertUserAccount(tx, user.id);

      // The signup bonus, as a real movement out of the treasury.
      const mint = await postDoubleEntry(tx, {
        fromAccountId: pickTreasuryStripe(),
        toAccountId: account.id,
        amountMinor: BigInt(config.SIGNUP_BONUS_MINOR),
        type: 'MINT',
        note: 'Welcome bonus',
      });

      await enqueueEvent(tx, {
        eventType: 'USER_REGISTERED',
        aggregateType: 'user',
        aggregateId: user.id,
        payload: {
          userId: user.id,
          phone: user.phone,
          name: user.name,
          accountId: account.id,
          bonusMinor: config.SIGNUP_BONUS_MINOR.toString(),
          transferReference: mint.reference,
        },
      });

      await trackWrite(tx, user.id);

      await repo.insertAuditLog(tx, {
        actorUserId: user.id,
        action: 'USER_REGISTERED',
        entityType: 'user',
        entityId: user.id,
        metadata: { accountId: account.id, mintReference: mint.reference },
        ip: context.ip,
        userAgent: context.userAgent,
        requestId: context.requestId,
      });

      const session = await issueSession(tx, user, randomUUID(), context);

      return {
        user: { id: user.id, phone: user.phone, name: user.name },
        account: { id: account.id, balance: money(mint.receiverBalanceAfter) },
        accessToken: session.accessToken,
        refreshToken: session.refreshToken,
        expiresIn: session.expiresIn,
      };
    });
  } catch (error) {
    if (pgErrorCode(error) === PG_ERRORS.UNIQUE_VIOLATION) {
      throw errors.duplicate('An account with this phone number already exists');
    }
    throw error;
  }
}

export async function login(input: LoginInput, context: RequestContext): Promise<AuthResult> {
  const user = await repo.findUserByPhone(input.phone);

  // Verify against a decoy hash when the user does not exist, so that response time does not
  // reveal which phone numbers are registered.
  const passwordOk = user
    ? await verifySecret(user.passwordHash, input.password)
    : await verifySecret(DECOY_HASH, input.password);

  if (!user || !passwordOk) throw errors.invalidCredentials();
  if (user.status !== 'ACTIVE') throw errors.forbidden('This account is suspended');

  const account = await repo.findAccountByUserId(user.id);
  if (!account) throw errors.notFound('Account');

  return withTransaction(async (tx) => {
    const session = await issueSession(tx, user, randomUUID(), context);
    await repo.insertAuditLog(tx, {
      actorUserId: user.id,
      action: 'USER_LOGIN',
      entityType: 'user',
      entityId: user.id,
      ip: context.ip,
      userAgent: context.userAgent,
      requestId: context.requestId,
    });

    return {
      user: { id: user.id, phone: user.phone, name: user.name },
      account: { id: account.id, balance: money(account.balanceMinor) },
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      expiresIn: session.expiresIn,
    };
  });
}

/**
 * Refresh rotation with reuse detection.
 *
 * Each refresh token is single-use. Presenting one that has already been rotated means two
 * parties hold the same token — i.e. it leaked — so the entire family is revoked and the holder
 * must log in again. This turns silent token theft into a visible, contained event.
 */
export async function refresh(
  refreshTokenPlain: string,
  context: RequestContext,
): Promise<Omit<AuthResult, 'account'>> {
  const tokenHash = hashToken(refreshTokenPlain);

  type RefreshOutcome =
    | { kind: 'rotated'; result: Omit<AuthResult, 'account'> }
    | { kind: 'reuse-detected' }
    | { kind: 'already-revoked' };

  /**
   * Note the shape: reuse detection *writes* (it revokes the family and records an audit entry)
   * and must therefore commit. Throwing from inside the transaction would roll back the very
   * revocation the detection exists to perform — the attacker's stolen token would survive.
   * So the outcome is returned, the transaction commits, and the rejection is thrown after.
   */
  const outcome = await withTransaction<RefreshOutcome>(async (tx) => {
    const existing = await repo.findRefreshTokenByHash(tx, tokenHash);
    if (!existing) throw errors.unauthenticated('Invalid refresh token');

    // Two different situations wear the same "revoked" flag, and conflating them would make the
    // audit trail useless:
    //   replacedBy !== null -> this token was rotated away and someone is presenting it again.
    //                          Two parties hold it: treat as theft, kill the family.
    //   replacedBy === null -> it was revoked by logout or by an earlier family revocation.
    //                          Expected, not an incident. Reject and move on.
    if (existing.revokedAt !== null && existing.replacedBy === null) {
      return { kind: 'already-revoked' };
    }

    if (existing.revokedAt !== null) {
      const revoked = await repo.revokeFamily(tx, existing.familyId);
      logger.warn(
        { userId: existing.userId, familyId: existing.familyId, revoked },
        'refresh token reuse detected — session family revoked',
      );
      await repo.insertAuditLog(tx, {
        actorUserId: existing.userId,
        action: 'REFRESH_TOKEN_REUSE_DETECTED',
        entityType: 'session',
        entityId: existing.familyId,
        metadata: { revokedSessions: revoked },
        ip: context.ip,
        userAgent: context.userAgent,
        requestId: context.requestId,
      });
      return { kind: 'reuse-detected' };
    }

    if (existing.expiresAt.getTime() <= Date.now()) {
      throw errors.unauthenticated('Refresh token expired');
    }

    const user = await repo.findUserById(existing.userId, tx);
    if (!user || user.status !== 'ACTIVE') throw errors.unauthenticated('Session is no longer valid');

    const session = await issueSession(tx, user, existing.familyId, context);
    await repo.markRefreshTokenReplaced(tx, existing.id, session.tokenId);

    return {
      kind: 'rotated',
      result: {
        user: { id: user.id, phone: user.phone, name: user.name },
        accessToken: session.accessToken,
        refreshToken: session.refreshToken,
        expiresIn: session.expiresIn,
      },
    };
  });

  if (outcome.kind === 'reuse-detected') {
    throw errors.unauthenticated('Refresh token has already been used');
  }
  if (outcome.kind === 'already-revoked') {
    throw errors.unauthenticated('This session has been revoked');
  }
  return outcome.result;
}

export async function logout(refreshTokenPlain: string): Promise<void> {
  const tokenHash = hashToken(refreshTokenPlain);
  await withTransaction(async (tx) => {
    await repo.revokeToken(tx, tokenHash);
  });
}

/**
 * A real Argon2id hash of a value nobody knows, used to spend the same CPU time on a login
 * attempt for a phone number that does not exist.
 */
const DECOY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHRzb21lc2FsdA$Qw3sHwGYyGCFVPz9Zq7uJ7dJ3v0e9nJ1t2xQK5xW8Yk';
