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
  canonicalUrl: string;
  theme: { accent: string; logo: string; blurb: string };
  caps: { fileMb: number; dayGb: number; monthGb: number };
  paused: boolean;
  show: Show | null;
  reason: "capture" | "recent" | "none";
  recent: Show[];
  turnstile: { sitekey: string };
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
