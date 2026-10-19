/**
 * API base for the page's own URL. The page is served at `/` on a band's own host and
 * under `/<band>/` on the shared host; the Worker strips that first segment. A first
 * segment containing a dot is a file (`/index.html`), not a band prefix.
 */
export function apiBase(pathname: string): string {
  const first = pathname.split("/").find((s) => s !== "");
  if (first === undefined || first.includes(".")) return "/api";
  return `/${first}/api`;
}
