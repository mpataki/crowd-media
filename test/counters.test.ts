import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { addDays, RESERVATION_TTL_MS } from "../src/upload/counters";
import type { BandCounters } from "../src/upload/counters";

/** A counters object no other test touches. */
const fresh = () => env.COUNTERS.get(env.COUNTERS.idFromName(`t-${crypto.randomUUID()}`));
const DAY = "2026-10-10";
const limits = { dayBytes: 100, rollingBytes: 250 };

describe("BandCounters", () => {
  it("reserve holds bytes against both caps; over either → refused with the cap named", async () => {
    const c = fresh();
    expect(await c.reserve("a", 60, DAY, limits)).toEqual({ ok: true });
    expect(await c.reserve("b", 41, DAY, limits)).toEqual({ ok: false, cap: "day" });
    expect(await c.reserve("b", 40, DAY, limits)).toEqual({ ok: true });
    expect(await c.usage(DAY)).toEqual({ day: 100, rolling: 100, reserved: 100 });
    // Next day: day cap is fresh, the rolling window still holds the 100.
    const next = addDays(DAY, 1);
    await c.commit("x", 100, next);
    expect(await c.reserve("c", 51, addDays(DAY, 2), limits)).toEqual({ ok: false, cap: "rolling" });
  });

  it("reserve is idempotent per id", async () => {
    const c = fresh();
    await c.reserve("a", 60, DAY, limits);
    expect(await c.reserve("a", 60, DAY, limits)).toEqual({ ok: true });
    expect((await c.usage(DAY)).reserved).toBe(60);
  });

  it("commit moves the reservation into the day row it was made on, with the actual size", async () => {
    const c = fresh();
    await c.reserve("a", 60, DAY, limits);
    await c.commit("a", 55, addDays(DAY, 1));
    expect(await c.usage(DAY)).toEqual({ day: 55, rolling: 55, reserved: 0 });
    const rows = await runInDurableObject(c, (_i: BandCounters, state) =>
      state.storage.sql.exec("SELECT window, bytes FROM counters").toArray(),
    );
    expect(rows).toEqual([{ window: `day:${DAY}`, bytes: 55 }]);
  });

  it("commit without a reservation (alarm already dropped it) still counts, on the fallback day", async () => {
    const c = fresh();
    await c.commit("gone", 30, DAY);
    expect((await c.usage(DAY)).day).toBe(30);
  });

  it("release drops the hold", async () => {
    const c = fresh();
    await c.reserve("a", 60, DAY, limits);
    await c.release("a");
    expect(await c.usage(DAY)).toEqual({ day: 0, rolling: 0, reserved: 0 });
  });

  it("rolling window is the 30 days ending on the day: day −30 falls out", async () => {
    const c = fresh();
    await c.commit("old", 200, addDays(DAY, -30));
    await c.commit("edge", 7, addDays(DAY, -29));
    expect((await c.usage(DAY)).rolling).toBe(7);
  });

  it("alarm releases reservations older than 24 h, keeps fresh ones, and reschedules", async () => {
    const c = fresh();
    const now = Date.now();
    await c.reserve("stale", 10, DAY, limits, now - RESERVATION_TTL_MS - 1);
    await c.reserve("fresh", 20, DAY, limits, now);
    expect(await runDurableObjectAlarm(c)).toBe(true);
    expect((await c.usage(DAY)).reserved).toBe(20);
    const next = await runInDurableObject(c, (_i: BandCounters, state) => state.storage.getAlarm());
    expect(next).not.toBeNull();
  });

  it("alarm prunes day rows past the rolling window", async () => {
    const c = fresh();
    const today = new Date().toISOString().slice(0, 10);
    await c.reserve("r", 1, today, limits);
    await c.commit("ancient", 5, addDays(today, -40));
    await c.commit("recent", 5, addDays(today, -3));
    await runDurableObjectAlarm(c);
    const windows = await runInDurableObject(c, (_i: BandCounters, state) =>
      state.storage.sql.exec<{ window: string }>("SELECT window FROM counters ORDER BY window").toArray().map((r) => r.window),
    );
    expect(windows).toEqual([`day:${addDays(today, -3)}`]);
  });
});
