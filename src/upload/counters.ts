// Per-band byte counters: one SQLite-backed Durable Object per band (idFromName(slug)).
// Single-threaded, so every check and charge is atomic across concurrent requests.
//
// counters  day:<YYYY-MM-DD> → committed bytes (Toronto date, 06:00 rollover).
//           Rolling 30 d = the day rows from <day-29> to <day>.
// inflight  bytes an unfinished upload has already sent to R2, charged per part PUT
//           (the part length is exact). Both caps count them. Init reserves nothing,
//           so abandoned or squatting inits hold no cap; only bytes that arrived do.
//
// The DO is band-agnostic: callers pass limits and days, so it never reads config or
// derives dates itself (tests drive it with any limits and any day).
import { DurableObject } from "cloudflare:workers";

const HOUR_MS = 3_600_000;
/** An upload idle this long since its last charged part stops being in flight. */
export const INFLIGHT_IDLE_MS = 2 * HOUR_MS;
const ROLLING_DAYS = 30;

export type Limits = { dayBytes: number; rollingBytes: number };
export type HeadroomResult = { ok: true } | { ok: false; cap: "day" | "rolling" };
export type Usage = { day: number; rolling: number; inflight: number };

export class BandCounters extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS counters (window TEXT PRIMARY KEY, bytes INTEGER NOT NULL)`);
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS inflight (id TEXT NOT NULL, day TEXT NOT NULL, bytes INTEGER NOT NULL, last_ms INTEGER NOT NULL, PRIMARY KEY (id, day))`,
    );
  }

  /** Would `size` more bytes on `day` fit under both caps? Read-only: holds nothing. */
  headroom(day: string, limits: Limits, size: number): HeadroomResult {
    const u = this.usage(day);
    if (u.day + size > limits.dayBytes) return { ok: false, cap: "day" };
    if (u.rolling + size > limits.rollingBytes) return { ok: false, cap: "rolling" };
    return { ok: true };
  }

  /** Count `bytes` of upload `id` that just landed in R2, against `day`. */
  async charge(id: string, bytes: number, day: string, nowMs: number = Date.now()): Promise<void> {
    this.sql.exec(
      `INSERT INTO inflight (id, day, bytes, last_ms) VALUES (?, ?, ?, ?)
       ON CONFLICT(id, day) DO UPDATE SET bytes = bytes + excluded.bytes`,
      id,
      day,
      bytes,
      nowMs,
    );
    // Idle is per upload, not per day row: a part after 06:00 keeps the earlier row alive.
    this.sql.exec(`UPDATE inflight SET last_ms = ? WHERE id = ?`, nowMs, id);
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + HOUR_MS);
  }

  /** Upload `id` completed: its charged bytes become committed, on the days they arrived. */
  finish(id: string): void {
    this.fold(`id = ?`, id);
  }

  /** Upload `id` was aborted: R2 discards its parts, so its charges are dropped. */
  refund(id: string): void {
    this.sql.exec(`DELETE FROM inflight WHERE id = ?`, id);
  }

  /** Bytes counted against `day` and its rolling 30 d, in-flight bytes included. */
  usage(day: string): Usage {
    const from = addDays(day, 1 - ROLLING_DAYS);
    const one = (q: string, ...args: string[]) => Number(this.sql.exec(q, ...args).one().n);
    const committedDay = one(`SELECT COALESCE(SUM(bytes), 0) AS n FROM counters WHERE window = ?`, `day:${day}`);
    const committedRolling = one(
      `SELECT COALESCE(SUM(bytes), 0) AS n FROM counters WHERE window >= ? AND window <= ?`,
      `day:${from}`,
      `day:${day}`,
    );
    const flyingDay = one(`SELECT COALESCE(SUM(bytes), 0) AS n FROM inflight WHERE day = ?`, day);
    const flyingRolling = one(`SELECT COALESCE(SUM(bytes), 0) AS n FROM inflight WHERE day >= ? AND day <= ?`, from, day);
    return { day: committedDay + flyingDay, rolling: committedRolling + flyingRolling, inflight: flyingRolling };
  }

  /** Hourly while uploads are in flight: expire idle ones, prune day rows past the window. */
  async alarm(): Promise<void> {
    const now = Date.now();
    // An idle upload's bytes are folded into the committed counters, not dropped: they
    // really are in R2 (as uploaded parts) until the bucket's lifecycle rule aborts the
    // multipart, and the guest may still complete it. Over-counting is the safe side.
    this.fold(`id IN (SELECT id FROM inflight GROUP BY id HAVING MAX(last_ms) < ?)`, now - INFLIGHT_IDLE_MS);
    // Keep a day of slack past the window for the Toronto-vs-UTC date edge.
    const oldest = addDays(new Date(now).toISOString().slice(0, 10), -ROLLING_DAYS);
    this.sql.exec(`DELETE FROM counters WHERE window < ?`, `day:${oldest}`);
    const left = this.sql.exec(`SELECT COUNT(*) AS n FROM inflight`).one().n;
    if (Number(left) > 0) await this.ctx.storage.setAlarm(now + HOUR_MS);
  }

  /** Move the in-flight rows matching `where` into the committed day counters. */
  private fold(where: string, arg: string | number): void {
    this.sql.exec(
      `INSERT INTO counters (window, bytes) SELECT 'day:' || day, SUM(bytes) FROM inflight WHERE ${where} GROUP BY day
       ON CONFLICT(window) DO UPDATE SET bytes = bytes + excluded.bytes`,
      arg,
    );
    this.sql.exec(`DELETE FROM inflight WHERE ${where}`, arg);
  }
}

/** YYYY-MM-DD shifted by `n` calendar days. */
export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
