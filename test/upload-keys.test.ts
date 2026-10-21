import { describe, expect, it } from "vitest";
import { captureStamp, creditSlug, objectKey } from "../src/upload/keys";
import { signToken, verifyToken } from "../src/upload/token";
import type { UploadToken } from "../src/upload/token";

describe("creditSlug", () => {
  it.each([
    ["@Fool.Hearts!", "ig-fool-hearts"],
    [undefined, "anon"],
    ["", "anon"],
    ["   ", "anon"],
    ["@", "anon"],
    ["!!!", "anon"],
    ["Jen  Costa", "jen-costa"],
    ["José Ñuñez", "jose-nunez"],
    ["a__b", "a-b"],
    ["x".repeat(60), "x".repeat(40)],
    ["abc-".repeat(11), `${"abc-".repeat(9)}abc`], // a cut that lands on a dash drops it
  ])("%j → %s", (raw, want) => {
    const got = creditSlug(raw);
    expect(got).toBe(want);
    expect(got).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(got.length).toBeLessThanOrEqual(40);
  });
});

describe("captureStamp", () => {
  it("Toronto wall clock, EDT and EST", () => {
    expect(captureStamp(Date.parse("2026-10-10T22:15:07-04:00"))).toBe("20261010T221507");
    expect(captureStamp(Date.parse("2026-12-31T23:59:59-05:00"))).toBe("20261231T235959");
    expect(captureStamp(Date.parse("2026-10-11T00:30:00-04:00"))).toBe("20261011T003000");
  });
  it("no capture time → unknown", () => {
    expect(captureStamp(null)).toBe("unknown");
    expect(captureStamp(Number.NaN)).toBe("unknown");
  });
});

it("objectKey splits back into its fields on __", () => {
  const key = objectKey("foolhearts/2026-10-10-the-dakota", Date.parse("2026-10-10T22:15:00-04:00"), "ig-fool-hearts", "mp4");
  const [prefixShow, file] = [key.slice(0, key.lastIndexOf("/")), key.slice(key.lastIndexOf("/") + 1)];
  expect(prefixShow).toBe("foolhearts/2026-10-10-the-dakota");
  const [capture, credit, rest] = file.split("__");
  expect(capture).toBe("20261010T221500");
  expect(credit).toBe("ig-fool-hearts");
  expect(rest).toMatch(/^[0-9a-f]{8}\.mp4$/);
});

describe("upload token", () => {
  const secret = `k-${crypto.randomUUID()}`;
  const t: UploadToken = { band: "foolhearts", key: "foolhearts/x/y.mp4", uploadId: "u1", ledger: "r1", partSize: 33554432, parts: 3, size: 73400320, exp: 1_800_000_000_000 };

  it("round-trips with the same secret, URL-safe", async () => {
    const tok = await signToken(t, secret);
    expect(tok).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(await verifyToken(tok, secret)).toEqual(t);
  });

  it("rejects another secret, a flipped payload, a truncated signature, junk", async () => {
    const tok = await signToken(t, secret);
    const [body, sig] = tok.split(".");
    const other = await signToken({ ...t, size: 1 }, secret);
    expect(await verifyToken(tok, `${secret}x`)).toBeNull();
    expect(await verifyToken(`${other.split(".")[0]}.${sig}`, secret)).toBeNull();
    expect(await verifyToken(`${body}.${sig.slice(0, 10)}`, secret)).toBeNull();
    for (const junk of ["", ".", "a.b.c", `${body}.`, "!!.??"]) expect(await verifyToken(junk, secret)).toBeNull();
  });
});
