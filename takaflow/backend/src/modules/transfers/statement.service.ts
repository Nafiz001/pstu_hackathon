/**
 * Account statements, as a stream.
 *
 * A statement is the one endpoint whose response size is bounded by the user's history rather
 * than by a page size, and a user with ten years of transactions has a big one. Building it in
 * memory would mean the largest customer decides the memory footprint of the API — and on a
 * shared process, one such request would degrade everyone else's.
 *
 * So it streams: fetch a page, write it to the socket, discard it, fetch the next. Memory is
 * flat regardless of the size of the statement, and Node's backpressure handling means a slow
 * client throttles the database reads rather than filling a buffer.
 *
 * The upper bound of the window is fixed when the request starts. Rows written while the export
 * is running are newer than that bound, so they fall outside it: the export is a consistent view
 * of a closed interval without holding one long transaction open — which on a busy database is
 * the difference between a statement and an hour of blocked vacuuming.
 */
import { Readable } from 'node:stream';
import { withReadTransaction } from '../../platform/db/transaction.js';
import { formatTaka } from '../../shared/money.js';
import { asPgTimestamp } from '../../shared/timestamp.js';
import { listHistory, type HistoryEntry } from './history.repo.js';

const PAGE_SIZE = 500;

const COLUMNS = [
  'date',
  'reference',
  'type',
  'direction',
  'counterparty',
  'counterparty_phone',
  'amount_bdt',
  'amount_minor',
  'balance_after_bdt',
  'note',
] as const;

/**
 * RFC 4180 escaping.
 *
 * The leading-character check is not decoration: a note beginning with `=`, `+`, `-` or `@` is
 * executed as a formula when the file is opened in a spreadsheet. Prefixing it with a quote
 * neutralises that. A statement is a file people open in Excel, and "note" is attacker-controlled
 * text typed by whoever sent them money.
 */
function csvField(value: string | null): string {
  if (value === null || value === '') return '';

  const dangerous = /^[=+\-@\t\r]/.test(value);
  const escaped = (dangerous ? `'${value}` : value).replace(/"/g, '""');

  return /[",\r\n]/.test(escaped) ? `"${escaped}"` : escaped;
}

function csvRow(entry: HistoryEntry): string {
  const fields = [
    entry.createdAt.toISOString(),
    entry.reference,
    entry.type,
    entry.direction === 'CREDIT' ? 'IN' : 'OUT',
    entry.counterpartyName,
    entry.counterpartyPhone,
    formatTaka(entry.amountMinor),
    entry.amountMinor.toString(),
    formatTaka(entry.balanceAfterMinor),
    entry.note,
  ];
  return `${fields.map((field) => csvField(field === null ? null : String(field))).join(',')}\r\n`;
}

export interface StatementWindow {
  accountId: string;
  from?: Date;
  to?: Date;
}

/**
 * The statement as an async generator of CSV chunks.
 *
 * Each page is read in its own short transaction. Holding one transaction open for the whole
 * export would give a perfectly consistent snapshot at the cost of pinning the oldest xmin in
 * the database for as long as the client takes to download — which blocks vacuum, and on a busy
 * table that is how a reporting query turns into an incident. The fixed upper bound gives the
 * same consistency for a fraction of the cost.
 */
async function* statementChunks(window: StatementWindow): AsyncGenerator<string> {
  // A byte-order mark, so a Bangla name opens correctly in Excel instead of as mojibake.
  yield '﻿';
  yield `${COLUMNS.join(',')}\r\n`;

  const to = window.to ?? new Date();
  let cursor: { createdAt: ReturnType<typeof asPgTimestamp>; id: string } | undefined;

  for (;;) {
    const rows: HistoryEntry[] = await withReadTransaction((tx) =>
      listHistory(tx, {
        accountId: window.accountId,
        from: window.from,
        to,
        limit: PAGE_SIZE,
        cursor,
      }),
    );

    if (rows.length === 0) return;

    let chunk = '';
    for (const entry of rows) chunk += csvRow(entry);
    yield chunk;

    if (rows.length < PAGE_SIZE) return;

    const last = rows[rows.length - 1]!;
    cursor = { createdAt: last.createdAtRaw, id: last.id };
  }
}

export function statementStream(window: StatementWindow): Readable {
  return Readable.from(statementChunks(window), { encoding: 'utf8' });
}

export function statementFilename(window: StatementWindow): string {
  const stamp = (date: Date) => date.toISOString().slice(0, 10);
  const from = window.from ? stamp(window.from) : 'start';
  return `takaflow-statement-${from}-to-${stamp(window.to ?? new Date())}.csv`;
}
