import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { addDays, INFLIGHT_IDLE_MS } from "../src/upload/counters";
import type { BandCounters } from "../src/upload/counters";

/** A counters object no other test touches. */
const fresh = () => env.COUNTERS.get(env.COUNTERS.idFromName(`t-${crypto.randomUUID()}`));
type Stub = ReturnType<typeof fresh>;
const DAY = "2026-10-10";
const limits = { dayBytes: 100, rollingBytes: 250 };
const id = () => crypto.randomUUID();

/** Committed bytes on `day`: one finished upload. */
async function seed(c: Stub, bytes: number, day: string) {
  const u = id();
  await c.charge(u, bytes, day);
  await c.finish(u);
}

const windows = (c: Stub) =>
  runInDurableObject(c, (_i: BandCounters, state) =>
    state.storage.sql.exec<{ window: string; bytes: number }>("SELECT window, bytes FROM counters ORDER BY window").toArray(),
  );

describe("BandCounters", () => {
  it("headroom refuses past either cap, naming it, and holds nothing", async () => {
    const c = fresh();
    expect(await c.headroom(DAY, limits, 100)).toEqual({ ok: true });
    expect(await c.headroom(DAY, limits, 100)).toEqual({ ok: true });
    expect(await c.usage(DAY)).toEqual({ day: 0, rolling: 0, inflight: 0 });
    await seed(c, 60, DAY);
    expect(await c.headroom(DAY, limits, 41)).toEqual({ ok: false, cap: "day" });
    expect(await c.headroom(DAY, limits, 40)).toEqual({ ok: true });
    // Next days: the day cap is fresh, the rolling window still holds the bytes.
    await seed(c, 100, addDays(DAY, 1));
    expect(await c.headroom(addDays(DAY, 2), limits, 91)).toEqual({ ok: false, cap: "rolling" });
  });

  it("in-flight charges count against both caps", async () => {
    const c = fresh();
    await c.charge(id(), 70, DAY);
    expect(await c.usage(DAY)).toEqual({ day: 70, rolling: 70, inflight: 70 });
    expect(await c.headroom(DAY, limits, 31)).toEqual({ ok: false, cap: "day" });
  });

  it("finish commits an upload's charges on the days its parts arrived", async () => {
    const c = fresh();
    const u = id();
    await c.charge(u, 30, DAY);
    await c.charge(u, 30, DAY);
    await c.charge(u, 5, addDays(DAY, 1));
    await c.finish(u);
    await c.finish(u); // a retried complete changes nothing
    expect(await c.usage(addDays(DAY, 1))).toEqual({ day: 5, rolling: 65, inflight: 0 });
    expect(await windows(c)).toEqual([
      { window: `day:${DAY}`, bytes: 60 },
      { window: `day:${addDays(DAY, 1)}`, bytes: 5 },
    ]);
  });

  it("refund drops only that upload's charges", async () => {
    const c = fresh();
    const [a, b] = [id(), id()];
    await c.charge(a, 60, DAY);
    await c.charge(b, 10, DAY);
    await c.refund(a);
    expect(await c.usage(DAY)).toEqual({ day: 10, rolling: 10, inflight: 10 });
  });

  it("rolling window is the 30 days ending on the day: day −30 falls out", async () => {
    const c = fresh();
    await seed(c, 200, addDays(DAY, -30));
    await seed(c, 7, addDays(DAY, -29));
    expect((await c.usage(DAY)).rolling).toBe(7);
  });

  it("alarm commits uploads idle 2 h (bytes stay counted), keeps active ones, reschedules", async () => {
    const c = fresh();
    const now = Date.now();
    const [idle, active] = [id(), id()];
    await c.charge(idle, 10, DAY, now - INFLIGHT_IDLE_MS - 1);
    await c.charge(active, 20, DAY, now - INFLIGHT_IDLE_MS - 1);
    await c.charge(active, 1, DAY, now); // a recent part keeps the whole upload active
    expect(await runDurableObjectAlarm(c)).toBe(true);
    expect(await c.usage(DAY)).toEqual({ day: 31, rolling: 31, inflight: 21 });
    // Expired means committed: a late abort refunds nothing.
    await c.refund(idle);
    expect((await c.usage(DAY)).day).toBe(31);
    const next = await runInDurableObject(c, (_i: BandCounters, state) => state.storage.getAlarm());
    expect(next).not.toBeNull();
  });

  it("alarm prunes day rows past the rolling window", async () => {
    const c = fresh();
    const today = new Date().toISOString().slice(0, 10);
    await c.charge(id(), 1, today);
    await seed(c, 5, addDays(today, -40));
    await seed(c, 5, addDays(today, -3));
    await runDurableObjectAlarm(c);
    expect((await windows(c)).map((r) => r.window)).toEqual([`day:${addDays(today, -3)}`]);
  });
});
