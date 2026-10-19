import { bandInfo } from "./api/band";
import { resolveBand } from "./config/resolve";

const notFound = () => new Response("Not found\n", { status: 404, headers: { "content-type": "text/plain" } });

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    // Band-less, any host: deploy smoke checks hit this on workers.dev.
    if (request.method === "GET" && url.pathname === "/api/health") {
      return Response.json({ ok: true });
    }
    // /api/* reaches us via run_worker_first; /<band>/api/* only because no asset
    // matches it (assets has no not_found_handling). Setting an SPA/404 fallback would
    // swallow those paths: add "/*/api/*" to run_worker_first first. Non-API paths are
    // static and not the Worker's to gate.
    if (!url.pathname.includes("/api/")) return env.ASSETS.fetch(request);

    const resolved = resolveBand(url.hostname, url.pathname);
    // No band, or a band segment where none is accepted (branded host, nested path).
    if (!resolved || !resolved.strippedPathname.startsWith("/api/")) return notFound();
    const { band, strippedPathname: path } = resolved;

    if (request.method === "GET" && path === "/api/band") {
      return Response.json(bandInfo(band, Date.now()));
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
