import { describe, expect, it } from "vitest";
import { tokenSource } from "../../src/page/tokens";

describe("tokenSource", () => {
  it("null sitekey (Turnstile off) yields no token and loads nothing", async () => {
    let loads = 0;
    const tokens = tokenSource(null, "el", async () => {
      loads++;
      throw new Error("must not load");
    });
    expect(await tokens()).toBeUndefined();
    expect(loads).toBe(0);
  });

  it("a challenge timeout rejects the pending token (the row fails, not stuck at 0 %); the next call resets and retries", async () => {
    let opts: Record<string, unknown> = {};
    const calls: string[] = [];
    const api = {
      render: (_el: string, o: Record<string, unknown>) => ((opts = o), calls.push("render"), "w1"),
      execute: () => void calls.push("execute"),
      reset: () => void calls.push("reset"),
    };
    const tokens = tokenSource("sitekey", "el", async () => api);

    // Let the source get past `await load()` and execute.
    const settle = async (n: number) => {
      while (calls.filter((c) => c === "execute").length < n) await Promise.resolve();
    };
    const first = tokens();
    await settle(1);
    (opts["timeout-callback"] as () => void)();
    await expect(first).rejects.toThrow("Bot check timed out — tap to retry.");

    const second = tokens();
    await settle(2);
    (opts.callback as (t: string) => void)("tok");
    await expect(second).resolves.toBe("tok");
    expect(calls).toEqual(["render", "execute", "reset", "execute"]);
  });
});
