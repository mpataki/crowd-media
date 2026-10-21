// POST /api/uploads body → a checked init request, or the status + reason the page shows
// verbatim. Pure: band caps come in, nothing is read from env or the clock.
import type { Band, Show } from "../config";

export const MiB = 1024 * 1024;
export const GiB = 1024 * MiB;

/** Extension → media family. Anything else is refused before R2 is touched. */
const EXT_FAMILY: Record<string, "image" | "video"> = {
  jpg: "image", jpeg: "image", png: "image", heic: "image", heif: "image", webp: "image",
  mp4: "video", mov: "video", m4v: "video", webm: "video", "3gp": "video",
};
/** Stored when the browser sent no type (some report "" for HEIC/MOV). */
const EXT_TYPE: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", heic: "image/heic", heif: "image/heif",
  webp: "image/webp", mp4: "video/mp4", mov: "video/quicktime", m4v: "video/x-m4v",
  webm: "video/webm", "3gp": "video/3gpp",
};
const NAME_MAX = 255;
/** ECMAScript's Date range: beyond it `new Date(t)` is Invalid and date helpers throw. */
const DATE_MAX_MS = 8.64e15;

/** The allow-list the page prechecks with (GET /api/band `accept.extensions`). */
export const ACCEPTED_EXTENSIONS: readonly string[] = Object.keys(EXT_FAMILY);

export type InitRequest = {
  name: string;
  size: number;
  /** Content-Type stored on the object. */
  contentType: string;
  ext: string;
  /** Capture time (the file's lastModified), or null when the browser sent none. */
  lastModified: number | null;
  credit: string | undefined;
  /** Guest override; already checked against the band's shows. */
  show: Show | undefined;
};

export type Invalid = { ok: false; status: 400 | 413 | 415; reason: string };
export type Checked = { ok: true; value: InitRequest } | Invalid;

const bad = (status: Invalid["status"], reason: string): Invalid => ({ ok: false, status, reason });

export function checkInit(body: unknown, band: Band): Checked {
  if (typeof body !== "object" || body === null) return bad(400, "Upload details are missing.");
  const b = body as Record<string, unknown>;

  if (typeof b.name !== "string" || !b.name.trim() || b.name.length > NAME_MAX) {
    return bad(400, "The file needs a name.");
  }
  if (typeof b.size !== "number" || !Number.isSafeInteger(b.size) || b.size <= 0) {
    return bad(400, "The file is empty.");
  }
  const type = typeof b.type === "string" ? b.type.trim().toLowerCase() : "";
  const dot = b.name.lastIndexOf(".");
  const ext = dot > 0 ? b.name.slice(dot + 1).toLowerCase() : "";
  const family = EXT_FAMILY[ext];
  if (!family) return bad(415, "Only photos and videos can be uploaded.");
  if (type && !type.startsWith(`${family}/`)) {
    return bad(415, "Only photos and videos can be uploaded.");
  }
  if (b.size > band.caps.fileMb * MiB) {
    return bad(413, `Files over ${band.caps.fileMb} MB can't be uploaded.`);
  }

  let lastModified: number | null = null;
  if (b.lastModified !== undefined && b.lastModified !== null) {
    const t = b.lastModified;
    if (typeof t !== "number" || !Number.isFinite(t) || Math.abs(t) > DATE_MAX_MS) {
      return bad(400, "The file's date is unreadable.");
    }
    lastModified = t;
  }

  let credit: string | undefined;
  if (b.credit !== undefined && b.credit !== null) {
    if (typeof b.credit !== "string") return bad(400, "The credit must be text.");
    credit = b.credit;
  }

  let show: Show | undefined;
  if (b.showId !== undefined && b.showId !== null) {
    show = band.shows.find((s) => s.id === b.showId);
    if (!show) return bad(400, "That show isn't on the list; pick another.");
  }
  // b.turnstileToken was already verified by the handler (src/upload/turnstile.ts).

  return {
    ok: true,
    value: { name: b.name, size: b.size, contentType: type || EXT_TYPE[ext], ext, lastModified, credit, show },
  };
}
