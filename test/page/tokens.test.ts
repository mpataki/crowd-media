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
});
