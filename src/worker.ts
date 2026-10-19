import { bandInfo } from "./api/band";
import { uploads } from "./api/uploads";
import { resolveBand } from "./config/resolve";

const notFound = () => new Response("Not found\n", { status: 404, headers: { "content-type": "text/plain" } });

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    // Band-less, any host: deploy smoke checks hit this on workers.dev.
    if (request.method === "GET" && url.pathname === "/api/health") {
      return Response.json({ ok: true });
    }

    const resolved = resolveBand(url.hostname, url.pathname);
    const path = resolved?.strippedPathname;

    if (!url.pathname.includes("/api/")) {
      // /<band> or /<band>/ on an unclaimed host is that band's page: the root asset.
      if (resolved?.via === "path" && path === "/") {
        return env.ASSETS.fetch(new Request(new URL("/", url), request));
      }
      // No default band: an unclaimed host's root is not a page.
      if (!resolved && url.pathname === "/") return notFound();
      // Everything else is static (absolute asset URLs), served as-is on any host.
      return env.ASSETS.fetch(request);
    }

    // No band, or a band segment where none is accepted (branded host, nested path).
    if (!resolved || !path?.startsWith("/api/")) return notFound();
    const { band } = resolved;

    if (request.method === "GET" && path === "/api/band") {
      return Response.json(bandInfo(band, Date.now()));
    }
    if (path === "/api/uploads" || path.startsWith("/api/uploads/")) return uploads(request, env, band, path);
    return Response.json({ error: "not_found" }, { status: 404 });
  },
} satisfies ExportedHandler<Env>;

export { BandCounters } from "./upload/counters";
