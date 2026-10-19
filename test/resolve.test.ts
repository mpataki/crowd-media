import { describe, expect, it } from "vitest";
import { resolveBand } from "../src/config/resolve";

describe("resolveBand", () => {
  it("branded host → its band, path untouched", () => {
    expect(resolveBand("share.foolhearts.com", "/api/band")).toMatchObject({
      band: { slug: "foolhearts" },
      strippedPathname: "/api/band",
      via: "host",
    });
    expect(resolveBand("SHARE.foolhearts.com", "/")?.band.slug).toBe("foolhearts");
  });

  it("unclaimed host + band segment → that band, segment stripped", () => {
    for (const host of ["crowd-media.matpataki.workers.dev", "localhost:8787", "localhost"]) {
      expect(resolveBand(host, "/shivs/api/band")).toMatchObject({
        band: { slug: "shivs" },
        strippedPathname: "/api/band",
        via: "path",
      });
    }
    expect(resolveBand("localhost", "/foolhearts")?.strippedPathname).toBe("/");
    expect(resolveBand("localhost", "/foolhearts/")?.strippedPathname).toBe("/");
  });

  it("branded host does not accept a band segment", () => {
    // Resolves to the host's band with the path intact; the router then 404s it.
    expect(resolveBand("share.foolhearts.com", "/shivs/api/band")).toMatchObject({
      band: { slug: "foolhearts" },
      strippedPathname: "/shivs/api/band",
    });
  });

  it("unclaimed host with no or unknown segment → null", () => {
    expect(resolveBand("unknown.example.com", "/api/band")).toBeNull();
    expect(resolveBand("unknown.example.com", "/")).toBeNull();
    expect(resolveBand("localhost", "/nobody/api/band")).toBeNull();
    expect(resolveBand("localhost", "/shivsx/api/band")).toBeNull();
  });
});
