import { describe, expect, it } from "vitest";
import { apiBase } from "../../src/page/base";
import { planParts } from "../../src/page/plan";
import { precheck } from "../../src/page/precheck";
import { BACKOFF_BASE_MS, MAX_RETRIES, retryDelay } from "../../src/page/retry";
import { consentText, onAccent, showLabel, summaryText } from "../../src/page/text";

const MIB = 1024 * 1024;

describe("apiBase", () => {
  it.each([
    ["/", "/api"],
    ["", "/api"],
    ["/index.html", "/api"],
    ["/shivs/", "/shivs/api"],
    ["/shivs", "/shivs/api"],
    ["/shivs/index.html", "/shivs/api"],
  ])("%s → %s", (path, base) => {
    expect(apiBase(path)).toBe(base);
  });
});

describe("planParts", () => {
  it("70 MiB at 32 MiB parts → 32, 32, 6 with 1-based numbers", () => {
    const plan = planParts(70 * MIB, 32 * MIB);
    expect(plan.map((p) => p.n)).toEqual([1, 2, 3]);
    expect(plan.map((p) => p.end - p.start)).toEqual([32 * MIB, 32 * MIB, 6 * MIB]);
    expect(plan.at(-1)?.end).toBe(70 * MIB);
  });

  it("exact multiple has no empty trailing part", () => {
    const plan = planParts(64 * MIB, 32 * MIB);
    expect(plan).toHaveLength(2);
    expect(plan[1]).toEqual({ n: 2, start: 32 * MIB, end: 64 * MIB });
  });

  it("file smaller than a part is one part", () => {
    expect(planParts(1000, 32 * MIB)).toEqual([{ n: 1, start: 0, end: 1000 }]);
  });

  it("parts are contiguous", () => {
    const plan = planParts(10 * MIB + 7, MIB);
    plan.slice(1).forEach((p, i) => expect(p.start).toBe(plan[i].end));
  });

  it("rejects a non-positive part size or size", () => {
    expect(() => planParts(10, 0)).toThrow(/partSize/);
    expect(() => planParts(0, 10)).toThrow(/size/);
  });
});

describe("retryDelay", () => {
  it("backs off 500 ms, 1 s, 2 s then gives up", () => {
    expect([1, 2, 3, 4].map((f) => retryDelay(f, 500))).toEqual([500, 1000, 2000, null]);
    expect(MAX_RETRIES).toBe(3);
    expect(BACKOFF_BASE_MS).toBe(500);
  });

  it.each([0, 408, 429, 500, 502, 503])("retries status %i", (s) => {
    expect(retryDelay(1, s)).toBe(500);
  });

  it.each([400, 401, 403, 404, 413, 415])("does not retry status %i", (s) => {
    expect(retryDelay(1, s)).toBeNull();
  });
});

describe("precheck", () => {
  const caps = { fileMb: 2048 };
  it("accepts photos and videos within the cap", () => {
    expect(precheck({ type: "image/jpeg", size: MIB }, caps)).toBeNull();
    expect(precheck({ type: "video/mp4", size: 2048 * MIB }, caps)).toBeNull();
  });
  it("rejects other types, including an unknown empty type", () => {
    expect(precheck({ type: "application/pdf", size: 10 }, caps)).toBe("Only photos and videos can be uploaded.");
    expect(precheck({ type: "", size: 10 }, caps)).toBe("Only photos and videos can be uploaded.");
  });
  it("rejects over-cap files with the cap in the reason", () => {
    expect(precheck({ type: "video/mp4", size: 2048 * MIB + 1 }, caps)).toBe("Too big — the limit is 2 GB per file.");
    expect(precheck({ type: "video/mp4", size: 600 * MIB }, { fileMb: 500 })).toBe("Too big — the limit is 500 MB per file.");
  });
  it("rejects empty files", () => {
    expect(precheck({ type: "image/png", size: 0 }, caps)).toBe("This file is empty.");
  });
});

describe("text", () => {
  it("consent wording is verbatim", () => {
    expect(consentText("Fool Hearts")).toBe(
      "By uploading you agree Fool Hearts may post this on our socials. We never publish your name without asking.",
    );
  });
  it("summary counts files", () => {
    expect(summaryText(2, 0, "X")).toBe("Thanks! 2 files sent to X.");
    expect(summaryText(1, 1, "X")).toBe("Thanks! 1 file sent to X. 1 failed — tap to retry.");
  });
  it("show label uses the show's own calendar date", () => {
    expect(showLabel({ id: "a", venue: "The Dakota Tavern", starts: "2026-10-10T21:00-04:00" })).toBe(
      "The Dakota Tavern, Sat Oct 10",
    );
  });
  it("text on accent keeps 4.5:1", () => {
    expect(onAccent("#c8102e")).toBe("#fff");
    expect(onAccent("#0b5cad")).toBe("#fff");
    expect(onAccent("#ffd700")).toBe("#000");
  });
});
