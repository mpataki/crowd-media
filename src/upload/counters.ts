// Per-band byte counters: one SQLite-backed Durable Object per band (idFromName(slug)).
// Single-threaded, so reserve's check-then-insert is atomic across concurrent inits.
//
// counters      day:<YYYY-MM-DD> → committed bytes (Toronto date, 06:00 rollover).
//               Rolling 30 d = the day rows from <day-29> to <day>.
// reservations  bytes held by an upload between init and complete/abort. Both caps
//               count them. Not upload state: the token alone drives the upload; a row
//               is only the cap's hold, and the alarm drops it after 24 h.
//
// The DO is band-agnostic: callers pass limits and days, so it never reads config or
// derives dates itself (tests drive it with any limits and any day).
import { DurableObject } from "cloudflare:workers";

const HOUR_MS = 3_600_000;
export const RESERVATION_TTL_MS = 24 * HOUR_MS;
const ROLLING_DAYS = 30;

export type Limits = { dayBytes: number; rollingBytes: number };
export type ReserveResult = { ok: true } | { ok: false; cap: "day" | "rolling" };
export type Usage = { day: number; rolling: number; reserved: number };

export class BandCounters extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS counters (window TEXT PRIMARY KEY, bytes INTEGER NOT NULL)`);
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS reservations (id TEXT PRIMARY KEY, bytes INTEGER NOT NULL, day TEXT NOT NULL, created_ms INTEGER NOT NULL)`,
    );
  }

  /** Hold `bytes` against `day` unless that would exceed either cap. Idempotent per id. */
  async reserve(id: string, bytes: number, day: string, limits: Limits, nowMs: number = Date.now()): Promise<ReserveResult> {
    if (this.sql.exec(`SELECT 1 FROM reservations WHERE id = ?`, id).toArray().length) return { ok: true };
    const u = this.usage(day);
    if (u.day + bytes > limits.dayBytes) return { ok: false, cap: "day" };
    if (u.rolling + bytes > limits.rollingBytes) return { ok: false, cap: "rolling" };
    this.sql.exec(`INSERT INTO reservations (id, bytes, day, created_ms) VALUES (?, ?, ?, ?)`, id, bytes, day, nowMs);
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + HOUR_MS);
    return { ok: true };
  }

  /**
   * Turn a reservation into counted bytes. `bytes` is what R2 actually stored. Without a
   * reservation (alarm already dropped it) the bytes still count, against `fallbackDay`.
   */
  commit(id: string, bytes: number, fallbackDay: string): void {
    const held = this.sql.exec<{ day: string }>(`SELECT day FROM reservations WHERE id = ?`, id).toArray()[0];
    this.sql.exec(`DELETE FROM reservations WHERE id = ?`, id);
    this.sql.exec(
      `INSERT INTO counters (window, bytes) VALUES (?, ?) ON CONFLICT(window) DO UPDATE SET bytes = bytes + excluded.bytes`,
      `day:${held?.day ?? fallbackDay}`,
      bytes,
    );
  }

  release(id: string): void {
    this.sql.exec(`DELETE FROM reservations WHERE id = ?`, id);
  }

  /** Bytes counted against `day` and its rolling 30 d, reservations included. */
  usage(day: string): Usage {
    const from = `day:${addDays(day, 1 - ROLLING_DAYS)}`;
    const to = `day:${day}`;
    const one = (q: string, ...args: string[]) => Number(this.sql.exec(q, ...args).one().n);
    const committedDay = one(`SELECT COALESCE(SUM(bytes), 0) AS n FROM counters WHERE window = ?`, to);
    const committedRolling = one(`SELECT COALESCE(SUM(bytes), 0) AS n FROM counters WHERE window >= ? AND window <= ?`, from, to);
    const heldDay = one(`SELECT COALESCE(SUM(bytes), 0) AS n FROM reservations WHERE day = ?`, day);
    const heldRolling = one(
      `SELECT COALESCE(SUM(bytes), 0) AS n FROM reservations WHERE day >= ? AND day <= ?`,
      from.slice(4),
      day,
    );
    return { day: committedDay + heldDay, rolling: committedRolling + heldRolling, reserved: heldRolling };
  }

  /** Hourly: drop reservations older than 24 h and day rows past the rolling window. */
  async alarm(): Promise<void> {
    const now = Date.now();
    this.sql.exec(`DELETE FROM reservations WHERE created_ms < ?`, now - RESERVATION_TTL_MS);
    // Keep a day of slack past the window for the Toronto-vs-UTC date edge.
    const oldest = addDays(new Date(now).toISOString().slice(0, 10), -ROLLING_DAYS);
    this.sql.exec(`DELETE FROM counters WHERE window < ?`, `day:${oldest}`);
    const left = this.sql.exec(`SELECT COUNT(*) AS n FROM reservations`).one().n;
    if (Number(left) > 0) await this.ctx.storage.setAlarm(now + HOUR_MS);
  }
}

/** YYYY-MM-DD shifted by `n` calendar days. */
export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
