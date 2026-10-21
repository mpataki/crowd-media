import type { Accept } from "./types";

const MIB = 1024 * 1024;
const NOT_MEDIA = "Only photos and videos can be uploaded.";

/**
 * Client-side mirror of the server's init checks, so a guest sees the reason before the
 * bytes go over the air. Returns the reason, or null when the file may be sent. The
 * server stays authoritative.
 */
export function precheck(file: { name: string; type: string; size: number }, accept: Accept): string | null {
  const dot = file.name.lastIndexOf(".");
  const ext = dot > 0 ? file.name.slice(dot + 1).toLowerCase() : "";
  if (!accept.extensions.includes(ext)) return NOT_MEDIA;
  // Some browsers send "" for HEIC/MOV; the server infers the type from the extension.
  if (file.type !== "" && !file.type.startsWith("image/") && !file.type.startsWith("video/")) return NOT_MEDIA;
  if (file.size === 0) return "This file is empty.";
  if (file.size > accept.maxFileMb * MIB) {
    return `Too big — the limit is ${formatMb(accept.maxFileMb)} per file.`;
  }
  return null;
}

function formatMb(mb: number): string {
  return mb >= 1024 && mb % 1024 === 0 ? `${mb / 1024} GB` : `${mb} MB`;
}
