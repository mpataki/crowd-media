import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import bandsYaml from "../bands.yaml?raw";
import { config } from "../src/config";
import { formatPath, validateConfig } from "../src/config/schema";
import badStarts from "./fixtures/bad-starts.yaml?raw";

const load = (text: string) => validateConfig(parse(text, { schema: "core" }));

describe("bands.yaml", () => {
  it("validates, and generated.json is up to date with it", () => {
    const res = load(bandsYaml);
    expect(res.ok).toBe(true);
    if (res.ok) expect(config).toEqual(res.config);
  });

  it("rejects a starts without an offset, naming the YAML path", () => {
    const res = load(badStarts);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    const paths = res.issues.map((i) => formatPath(i.path));
    expect(paths).toEqual(["bands.testband.shows[1].starts"]);
    expect(res.issues[0].message).toMatch(/offset/);
  });

  const band = (hosts: string[]) => ({
    name: "X",
    hosts,
    theme: { accent: "#000000", logo: "/x.svg", blurb: "b" },
    caps: { file_mb: 1, day_gb: 1, month_gb: 1 },
  });
  const issuePaths = (data: unknown) => {
    const res = validateConfig(data);
    return res.ok ? [] : res.issues.map((i) => `${formatPath(i.path)}: ${i.message}`);
  };

  it("rejects a missing required field, naming it", () => {
    const { name: _drop, ...nameless } = band([]);
    expect(issuePaths({ bands: { one: nameless } })).toEqual([
      expect.stringMatching(/^bands\.one\.name: /),
    ]);
  });

  it("rejects a host claimed by two bands", () => {
    const bands = { one: band(["a.example.com"]), two: band(["a.example.com"]) };
    expect(issuePaths({ bands })).toEqual([
      "bands: a host may belong to only one band",
    ]);
  });

  it('reserves the band slug "api"', () => {
    expect(issuePaths({ bands: { api: band([]) } })).toEqual([
      expect.stringMatching(/^bands\.api: .*reserved/),
    ]);
  });

  it("turnstile block is optional (absent → null); present needs a non-empty sitekey", () => {
    const res = validateConfig({ bands: { b: band([]) } });
    expect(res.ok && res.config.turnstile).toBeNull();
    expect(issuePaths({ turnstile: { sitekey: "" }, bands: { b: band([]) } })).toEqual([
      expect.stringMatching(/^turnstile\.sitekey: must not be empty/),
    ]);
    const on = validateConfig({ turnstile: { sitekey: "0x4AAA" }, bands: { b: band([]) } });
    expect(on.ok && on.config.turnstile).toEqual({ sitekey: "0x4AAA" });
  });

  it("defaults ends to starts + 5 h and paused to false", () => {
    const res = validateConfig({
      bands: {
        b: {
          ...band([]),
          shows: [{ id: "s", venue: "V", starts: "2026-10-10T21:00-04:00" }],
        },
      },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const b = res.config.bands[0];
    expect(b.paused).toBe(false);
    expect(Date.parse(b.shows[0].ends)).toBe(Date.parse("2026-10-11T02:00-04:00"));
  });
});
