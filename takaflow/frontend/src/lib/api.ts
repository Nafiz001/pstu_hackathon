/**
 * The API client.
 *
 * Three things live here that the rest of the app never has to think about again:
 *
 * 1. **Idempotency keys.** Every mutating call carries one, minted per user intent — not per
 *    HTTP attempt. A retry (deliberate, or the automatic one below) reuses the key, so the
 *    server recognises it as the same intent and replays the original result instead of moving
 *    money a second time. This is the client half of the contract the backend enforces.
 *
 * 2. **One transparent retry, and only where it is safe.** A request that never reached the
 *    server (network error) or hit a 503 is retried once with the SAME key. Anything else is
 *    surfaced: a 409 or a 422 is an answer, not a failure to try again.
 *
 * 3. **Token refresh, deduplicated.** A 401 triggers a single refresh that every waiting request
 *    shares. Without the shared promise, five concurrent 401s would spend five refresh tokens and
 *    four of them would be rejected as reuse — which the backend treats as theft and responds to
 *    by revoking the whole family.
 */

export interface Money {
  minor: string;
  formatted: string;
  currency: string;
}

export interface ApiErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown>; requestId?: string };
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown>;
  readonly requestId: string | null;

  constructor(status: number, body: ApiErrorBody | null, fallback: string) {
    super(body?.error?.message ?? fallback);
    this.name = 'ApiError';
    this.status = status;
    this.code = body?.error?.code ?? 'NETWORK_ERROR';
    this.details = body?.error?.details ?? {};
    this.requestId = body?.error?.requestId ?? null;
  }
}

const BASE = '/api/v1';

let accessToken: string | null = null;
let refreshToken: string | null = localStorage.getItem('takaflow.refresh');
let onSessionLost: (() => void) | null = null;

export function setSession(session: { accessToken: string; refreshToken: string } | null): void {
  accessToken = session?.accessToken ?? null;
  refreshToken = session?.refreshToken ?? null;

  // Only the refresh token is persisted. The access token lives in memory and dies with the tab,
  // so a stolen localStorage dump is worth one refresh token that the server can revoke.
  if (session) localStorage.setItem('takaflow.refresh', session.refreshToken);
  else localStorage.removeItem('takaflow.refresh');
}

export function onSessionExpired(handler: () => void): void {
  onSessionLost = handler;
}

export function hasStoredSession(): boolean {
  return refreshToken !== null;
}

/** A key per user intent. Two clicks of the same button are two intents; a retry is not. */
export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

let refreshInFlight: Promise<boolean> | null = null;

async function refreshSession(): Promise<boolean> {
  if (!refreshToken) return false;

  // Every caller that arrives while a refresh is running waits on the same promise. Spending the
  // refresh token twice would look exactly like token theft to the server.
  refreshInFlight ??= (async () => {
    try {
      const response = await fetch(`${BASE}/auth/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });
      if (!response.ok) return false;

      const body = (await response.json()) as { accessToken: string; refreshToken: string };
      setSession(body);
      return true;
    } catch {
      return false;
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Supply to make a retry idempotent; generated automatically for POST/DELETE when omitted. */
  idempotencyKey?: string;
  /** Extra headers — used by the engineering panel for the operator token. */
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

async function parse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const mutating = method !== 'GET';
  const idempotencyKey = mutating ? (options.idempotencyKey ?? newIdempotencyKey()) : undefined;

  const attempt = async (allowRefresh: boolean): Promise<T> => {
    const headers: Record<string, string> = { ...options.headers };
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    if (accessToken) headers.authorization = `Bearer ${accessToken}`;
    if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;

    const response = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
    });

    if (response.status === 401 && allowRefresh && refreshToken) {
      if (await refreshSession()) return attempt(false);
      setSession(null);
      onSessionLost?.();
    }

    if (response.status === 204) return undefined as T;

    const body = await parse(response);
    if (!response.ok) {
      throw new ApiError(response.status, body as ApiErrorBody | null, response.statusText);
    }
    return body as T;
  };

  try {
    return await attempt(true);
  } catch (error) {
    // The two cases where trying again is safe AND useful: the request never landed, or the
    // server said it was temporarily unable. The key makes the second attempt harmless.
    const retryable =
      !(error instanceof ApiError) || (error.status === 503 && idempotencyKey !== undefined);
    if (!retryable) throw error;

    await new Promise((resolve) => setTimeout(resolve, 250));
    return attempt(true);
  }
}

/**
 * Download the CSV statement.
 *
 * Not a plain `<a href>`: the endpoint is authenticated, and a link cannot carry a bearer token.
 * The response is streamed by the server, collected here, and handed to the browser as a file.
 */
export async function downloadStatement(range?: { from?: string; to?: string }): Promise<void> {
  const params = new URLSearchParams();
  if (range?.from) params.set('from', range.from);
  if (range?.to) params.set('to', range.to);

  const response = await fetch(`${BASE}/transfers/statement.csv?${params.toString()}`, {
    headers: accessToken ? { authorization: `Bearer ${accessToken}` } : {},
  });
  if (!response.ok) {
    throw new ApiError(response.status, (await parse(response)) as ApiErrorBody | null, 'Download failed');
  }

  const disposition = response.headers.get('content-disposition') ?? '';
  const named = /filename="([^"]+)"/.exec(disposition);
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);

  const link = document.createElement('a');
  link.href = url;
  link.download = named?.[1] ?? 'takaflow-statement.csv';
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// Typed endpoints
// ---------------------------------------------------------------------------

export interface AuthResult {
  user: { id: string; phone: string; name: string };
  account: { id: string; balance: Money };
  accessToken: string;
  refreshToken: string;
}

export interface AccountView {
  id: string;
  status: 'ACTIVE' | 'FROZEN' | 'CLOSED';
  balance: Money;
  spentLast24h: Money;
  servedFromCache: boolean;
}

export interface HistoryItem {
  id: string;
  reference: string;
  direction: 'IN' | 'OUT';
  type: string;
  status: string;
  amount: Money;
  balanceAfter: Money;
  note: string | null;
  counterparty: { name: string; phone: string | null };
  createdAt: string;
}

export interface MoneyRequestItem {
  id: string;
  status: 'PENDING' | 'ACCEPTED' | 'DECLINED' | 'CANCELLED' | 'EXPIRED';
  amount: Money;
  note: string | null;
  role: 'incoming' | 'outgoing';
  counterparty: { name: string; phone: string };
  expiresAt: string;
  createdAt: string;
  settledReference: string | null;
  declineReason: string | null;
}

export interface ScheduleItem {
  id: string;
  status: 'ACTIVE' | 'PAUSED' | 'COMPLETED' | 'CANCELLED';
  intervalKind: 'ONCE' | 'DAILY' | 'WEEKLY' | 'MONTHLY';
  amount: Money;
  note: string | null;
  payee: { name: string; phone: string };
  nextRunAt: string | null;
  remainingRuns: number | null;
  lastRunAt: string | null;
  createdAt: string;
}

export interface SplitLeg {
  requestId: string;
  payer: { name: string; phone: string };
  amount: Money;
  status: MoneyRequestItem['status'];
  settledReference: string | null;
}

export interface SplitDetail {
  id: string;
  description: string;
  total: Money;
  yourShare: Money;
  requested: Money;
  collected: Money;
  outstanding: Money;
  participantCount: number;
  createdAt: string;
  legs: SplitLeg[];
}

export interface SplitSummary {
  id: string;
  description: string;
  total: Money;
  collected: Money;
  outstanding: Money;
  settledCount: number;
  legCount: number;
  createdAt: string;
}

export interface NotificationItem {
  id: string;
  type: string;
  payload: { title?: string; body?: string; reference?: string | null };
  read: boolean;
  createdAt: string;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export const endpoints = {
  register: (input: { phone: string; name: string; password: string; pin: string }) =>
    api<AuthResult>('/auth/register', { method: 'POST', body: input }),

  login: (input: { phone: string; password: string }) =>
    api<AuthResult>('/auth/login', { method: 'POST', body: input }),

  logout: (token: string) => api<void>('/auth/logout', { method: 'POST', body: { refreshToken: token } }),

  /** Who am I: survives a page reload using only the stored refresh token. */
  identity: () => api<{ user: { id: string; phone: string; name: string } }>('/me'),

  me: () => api<{ account: AccountView }>('/accounts/me'),

  /** Emergency freeze. Freezing needs nothing; unfreezing needs the PIN. */
  setFreeze: (frozen: boolean, pin?: string) =>
    api<{ account: AccountView & { frozen: boolean } }>('/accounts/me/freeze', {
      method: 'PATCH',
      body: { frozen, ...(pin ? { pin } : {}) },
    }),

  findUser: (phone: string) =>
    api<{ user: { id: string; name: string; phone: string; isSelf: boolean } }>(
      `/users/search?q=${encodeURIComponent(phone)}`,
    ),

  send: (
    input: { toPhone: string; amountMinor: string; pin: string; note?: string },
    idempotencyKey: string,
  ) =>
    api<{
      transfer: { reference: string; amount: Money; createdAt: string };
      balance: Money;
      /** Set when the amount tripped the anomaly threshold. The payment still happened. */
      securityAlert?: boolean;
    }>('/transfers', { method: 'POST', body: input, idempotencyKey }),

  history: (query: string) => api<Page<HistoryItem> & { servedBy: string }>(`/transfers${query}`),

  receipt: (reference: string) => api<{ transfer: HistoryItem }>(`/transfers/${reference}`),

  reverse: (reference: string, pin: string, idempotencyKey: string) =>
    api<{ reversal: { reference: string; amount: Money }; balance: Money }>(
      `/transfers/${reference}/reverse`,
      { method: 'POST', body: { pin }, idempotencyKey },
    ),

  requests: (role: 'incoming' | 'outgoing', status?: string) =>
    api<Page<MoneyRequestItem>>(
      `/requests?role=${role}${status ? `&status=${status}` : ''}`,
    ),

  createRequest: (
    input: { fromPhone: string; amountMinor: string; note?: string },
    idempotencyKey: string,
  ) => api<{ request: MoneyRequestItem }>('/requests', { method: 'POST', body: input, idempotencyKey }),

  acceptRequest: (id: string, pin: string, idempotencyKey: string) =>
    api<{ request: MoneyRequestItem; balance: Money }>(`/requests/${id}/accept`, {
      method: 'POST',
      body: { pin },
      idempotencyKey,
    }),

  declineRequest: (id: string, reason?: string) =>
    api<{ request: MoneyRequestItem }>(`/requests/${id}/decline`, {
      method: 'POST',
      body: { reason },
    }),

  cancelRequest: (id: string) =>
    api<{ request: MoneyRequestItem }>(`/requests/${id}/cancel`, { method: 'POST', body: {} }),

  schedules: () => api<Page<ScheduleItem>>('/schedules'),

  createSchedule: (
    input: {
      toPhone: string;
      amountMinor: string;
      intervalKind: string;
      startAt: string;
      totalRuns?: number;
      note?: string;
      pin: string;
    },
    idempotencyKey: string,
  ) => api<{ schedule: ScheduleItem }>('/schedules', { method: 'POST', body: input, idempotencyKey }),

  scheduleDetail: (id: string) =>
    api<{
      schedule: ScheduleItem;
      occurrences: Array<{
        dueAt: string;
        status: string;
        attempts: number;
        failureReason: string | null;
        transferReference: string | null;
      }>;
    }>(`/schedules/${id}`),

  pauseSchedule: (id: string) => api<{ schedule: ScheduleItem }>(`/schedules/${id}/pause`, { method: 'POST', body: {} }),
  resumeSchedule: (id: string) => api<{ schedule: ScheduleItem }>(`/schedules/${id}/resume`, { method: 'POST', body: {} }),
  cancelSchedule: (id: string) => api<{ schedule: ScheduleItem }>(`/schedules/${id}`, { method: 'DELETE' }),

  splits: () => api<{ items: SplitSummary[] }>('/splits'),
  splitDetail: (id: string) => api<{ split: SplitDetail }>(`/splits/${id}`),
  createSplit: (
    input: {
      totalAmountMinor: string;
      description: string;
      participants: Array<{ phone: string; weight?: number }>;
      includeSelf: boolean;
    },
    idempotencyKey: string,
  ) => api<{ split: SplitDetail }>('/splits', { method: 'POST', body: input, idempotencyKey }),

  notifications: () => api<{ items: NotificationItem[] }>('/notifications'),
  markNotificationRead: (id: string) =>
    api<{ notification: NotificationItem }>(`/notifications/${id}/read`, { method: 'POST', body: {} }),

  reconciliation: () =>
    api<{
      status: 'PASS' | 'FAIL';
      checks: Array<{ name: string; status: string; detail?: string }>;
      totals?: Record<string, string>;
    }>('/admin/reconciliation'),

  outbox: () =>
    api<{
      byStatus: Array<{ status: string; count: number; oldest: string | null }>;
      failed: Array<{ id: string; event_type: string; attempts: number; last_error: string | null }>;
    }>('/admin/outbox'),

  health: () => fetch('/healthz').then((response) => response.json()),
};
