// Request → band. (1) Host listed by a band → that band; the path is left alone, so a
// branded host never takes a band segment. (2) Host listed by no band (workers.dev,
// localhost, anything unknown) → the first path segment names the band and is
// stripped before routing: /shivs/api/band → shivs, /api/band.
import { config } from "./index";
import type { Band } from "./schema";

/** `via: "path"` means the first segment named the band and has been stripped. */
export type Resolved = { band: Band; strippedPathname: string; via: "host" | "path" };

export function resolveBand(
  hostname: string,
  pathname: string,
  bands: readonly Band[] = config.bands,
): Resolved | null {
  const host = hostname.toLowerCase().replace(/:\d+$/, "");
  const owner = bands.find((b) => b.hosts.includes(host));
  if (owner) return { band: owner, strippedPathname: pathname, via: "host" };

  const m = /^\/([^/]+)(\/.*)?$/.exec(pathname);
  const band = m && bands.find((b) => b.slug === m[1]);
  if (!band) return null;
  return { band, strippedPathname: m[2] ?? "/", via: "path" };
}
