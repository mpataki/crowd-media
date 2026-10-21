// Wire shapes of the Worker API the page consumes. The Worker is the source of truth;
// these mirror the contracts in the band-config-yaml and upload-pipeline tasks.

export interface Show {
  id: string;
  venue: string;
  /** ISO-8601 with offset, e.g. 2026-10-10T21:00-04:00 */
  starts: string;
}

export interface BandInfo {
  band: { slug: string; name: string };
  /** null when the band has no hosts entry (served only under a prefix). */
  canonicalUrl: string | null;
  theme: { accent: string; logo: string; blurb: string };
  caps: { fileMb: number; dayGb: number; monthGb: number };
  accept: Accept;
  paused: boolean;
  show: Show | null;
  reason: "capture" | "recent" | "none";
  recent: Show[];
  /** null when bands.yaml has no turnstile block: no widget, no token. */
  turnstile: { sitekey: string } | null;
}

/** What init accepts: lowercase extensions without the dot, and the per-file cap. */
export interface Accept {
  extensions: readonly string[];
  maxFileMb: number;
}

export interface InitResponse {
  id: string;
  key: string;
  partSize: number;
  parts: number;
}

/** What the uploader needs from a File; a real File satisfies it. */
export interface UploadSource {
  readonly name: string;
  readonly size: number;
  readonly type: string;
  readonly lastModified: number;
  slice(start: number, end: number): Blob;
}

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
