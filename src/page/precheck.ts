const MIB = 1024 * 1024;

/**
 * Client-side mirror of the server's init checks, so a guest sees the reason before the
 * bytes go over the air. Returns the reason, or null when the file may be sent. The
 * server stays authoritative.
 */
export function precheck(
  file: { type: string; size: number },
  caps: { fileMb: number },
): string | null {
  if (!file.type.startsWith("image/") && !file.type.startsWith("video/")) {
    return "Only photos and videos can be uploaded.";
  }
  if (file.size === 0) return "This file is empty.";
  if (file.size > caps.fileMb * MIB) {
    return `Too big — the limit is ${formatMb(caps.fileMb)} per file.`;
  }
  return null;
}

function formatMb(mb: number): string {
  return mb >= 1024 && mb % 1024 === 0 ? `${mb / 1024} GB` : `${mb} MB`;
}
