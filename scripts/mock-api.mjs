#!/usr/bin/env node
// Dev-only mock of the Worker for the upload page: serves public/ and the /api/band +
// /api/uploads* contracts in memory (bytes are counted, not stored). Never shipped.
//
//   node scripts/mock-api.mjs [--port 8788] [--part-mb 32]
//
// Failure modes come from the PAGE's query string (read off each API call's Referer),
// so the scenario is in the URL you open:
//   ?fail=part2          part 2 of every upload fails once with 500, then succeeds
//   ?status=429[&on=2]   the Nth init after page load (default 2nd) gets that status
//   ?show=none           no current show (recent list kept, picker says "Pick a show")
//   ?paused=1            band paused
// Prefix paths work too: /shivs/ serves the page and /shivs/api/* the API.
// GET /__mock/log → JSON of every init body and upload event since start (for verifiers).
import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { ACCEPTED_EXTENSIONS } from "../src/upload/validate.ts";

const { values: args } = parseArgs({
  options: { port: { type: "string", default: "8788" }, "part-mb": { type: "string", default: "32" } },
});
const HOST = "127.0.0.1";
const PORT = Number(args.port);
const PART_SIZE = Number(args["part-mb"]) * 1024 * 1024;
const ROOT = join(import.meta.dirname, "..", "public");
const CAPS = { fileMb: 2048, dayGb: 20, monthGb: 100 };
const REASONS = {
  403: "Bot check failed — reload the page and try again.",
  413: "That file is over the 2 GB limit.",
  415: "Only photos and videos can be uploaded.",
  429: "Too many uploads from this connection — wait a minute and retry.",
  503: "Uploads are paused right now.",
};
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" };

const uploads = new Map(); // id → { size, partSize, parts, got: Map<n, etag>, failed: Set<n> }
const log = [];
let initsSinceLoad = 0;

const day = (offset) => new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10);
const shows = () => [
  { id: `${day(1)}-the-dakota`, venue: "The Dakota Tavern", starts: `${day(1)}T21:00-04:00` },
  { id: `${day(4)}-the-horseshoe`, venue: "The Horseshoe", starts: `${day(4)}T21:30-04:00` },
  { id: `${day(9)}-lees-palace`, venue: "Lee's Palace", starts: `${day(9)}T20:00-04:00` },
];

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(body === undefined ? undefined : JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

function modes(req) {
  try {
    return new URL(req.headers.referer ?? "").searchParams;
  } catch {
    return new URLSearchParams();
  }
}

async function api(req, res, path, q) {
  const m = req.method;
  if (m === "GET" && path === "/band") {
    initsSinceLoad = 0;
    const recent = shows();
    const none = q.get("show") === "none";
    return json(res, 200, {
      band: { slug: "mockband", name: "Mock Band" },
      canonicalUrl: `http://${HOST}:${PORT}/`,
      theme: { accent: "#c8102e", logo: "", blurb: "Shot something tonight? Send it our way." },
      caps: CAPS,
      accept: { extensions: ACCEPTED_EXTENSIONS, maxFileMb: CAPS.fileMb },
      paused: q.get("paused") === "1",
      show: none ? null : recent[0],
      reason: none ? "none" : "capture",
      recent,
      turnstile: null,
    });
  }
  if (m === "POST" && path === "/uploads") {
    const body = JSON.parse((await readBody(req)).toString() || "{}");
    initsSinceLoad++;
    log.push({ event: "init", n: initsSinceLoad, body });
    const forced = Number(q.get("status"));
    if (forced && initsSinceLoad === Number(q.get("on") ?? 2)) {
      return json(res, forced, { reason: REASONS[forced] ?? `Mock ${forced}.` });
    }
    if (body.type && !/^(image|video)\//.test(body.type)) return json(res, 415, { reason: REASONS[415] });
    if (body.size > CAPS.fileMb * 1024 * 1024) return json(res, 413, { reason: REASONS[413] });
    const id = randomUUID();
    const parts = Math.ceil(body.size / PART_SIZE);
    uploads.set(id, { size: body.size, partSize: PART_SIZE, parts, got: new Map(), failed: new Set() });
    return json(res, 200, { id, key: `mockband/${body.showId ?? "auto"}/${id.slice(0, 8)}`, partSize: PART_SIZE, parts });
  }
  const part = /^\/uploads\/([^/]+)\/parts\/(\d+)$/.exec(path);
  if (m === "PUT" && part) {
    const u = uploads.get(decodeURIComponent(part[1]));
    const n = Number(part[2]);
    const bytes = (await readBody(req)).length;
    if (!u) return json(res, 401, { reason: "Unknown upload." });
    if (q.get("fail") === `part${n}` && !u.failed.has(n)) {
      u.failed.add(n);
      log.push({ event: "part-fail", id: part[1], n });
      return json(res, 500, { reason: "Mock part failure." });
    }
    const expected = n < u.parts ? u.partSize : u.size - u.partSize * (u.parts - 1);
    if (n < 1 || n > u.parts || bytes !== expected) {
      return json(res, 400, { reason: `Part ${n} is ${bytes} bytes, expected ${expected}.` });
    }
    const etag = `etag-${n}-${randomUUID().slice(0, 8)}`;
    u.got.set(n, etag);
    log.push({ event: "part", id: part[1], n, bytes });
    return json(res, 200, { etag });
  }
  const done = /^\/uploads\/([^/]+)\/complete$/.exec(path);
  if (m === "POST" && done) {
    const id = decodeURIComponent(done[1]);
    const u = uploads.get(id);
    const { parts } = JSON.parse((await readBody(req)).toString());
    const ok = u && parts.length === u.parts && parts.every((p) => u.got.get(p.n) === p.etag);
    if (!ok) return json(res, 400, { reason: "Parts don't match the upload." });
    log.push({ event: "complete", id, size: u.size });
    return json(res, 200, { key: `mockband/${id.slice(0, 8)}` });
  }
  const del = /^\/uploads\/([^/]+)$/.exec(path);
  if (m === "DELETE" && del) {
    uploads.delete(decodeURIComponent(del[1]));
    log.push({ event: "delete", id: del[1] });
    return json(res, 204);
  }
  return json(res, 404, { reason: `Mock has no ${m} ${path}.` });
}

function serveStatic(res, path) {
  const rel = normalize(path).replace(/^(\.\.[/\\])+/, "");
  let file = join(ROOT, rel);
  try {
    if (statSync(file).isDirectory()) file = join(file, "index.html");
    statSync(file);
  } catch {
    // Unknown path (e.g. /shivs/): the page itself, as the Worker would serve it.
    file = join(ROOT, "index.html");
  }
  res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream" });
  createReadStream(file).pipe(res);
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://mock");
  try {
    if (url.pathname === "/__mock/log") return json(res, 200, log);
    const m = /^(?:\/[^/.]+)?\/api(\/.*)$/.exec(url.pathname);
    if (m) return await api(req, res, m[1], modes(req));
    return serveStatic(res, url.pathname);
  } catch (err) {
    json(res, 500, { reason: `Mock error: ${err.message}` });
  }
})
  .on("error", (err) => {
    console.error(`mock-api: can't listen on ${HOST}:${PORT}: ${err.message} (pick another with --port)`);
    process.exit(1);
  })
  .listen(PORT, HOST, () => {
    const url = `http://${HOST}:${PORT}`;
    console.log(`mock upload page → ${url}/  (band prefix: ${url}/shivs/)`);
    console.log(`scenarios: ?fail=part2  ?status=429  ?show=none  ?paused=1   log: ${url}/__mock/log`);
  });
