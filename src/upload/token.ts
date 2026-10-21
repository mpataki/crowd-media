// Upload id = signed token carrying everything later calls need, so the Worker keeps no
// per-upload state (no KV, no DO row): the R2 multipart is the only per-upload record.
// Format: base64url(JSON payload) "." base64url(HMAC-SHA256(payload)). Verification is
// crypto.subtle.verify, which compares in constant time.

export type UploadToken = {
  /** Band slug the upload belongs to; a token is only valid on its own band. */
  band: string;
  key: string;
  /** R2 multipart upload id. */
  uploadId: string;
  /** This upload's id in the band's BandCounters in-flight ledger (parts charge it). */
  ledger: string;
  partSize: number;
  parts: number;
  size: number;
};

const enc = new TextEncoder();
const keys = new Map<string, Promise<CryptoKey>>();

function hmacKey(secret: string): Promise<CryptoKey> {
  let k = keys.get(secret);
  if (!k) {
    k = crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
    keys.set(secret, k);
  }
  return k;
}

export async function signToken(t: UploadToken, secret: string): Promise<string> {
  const body = b64url(enc.encode(JSON.stringify(t)));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(body));
  return `${body}.${b64url(new Uint8Array(sig))}`;
}

/** The payload if `token` was signed with `secret`, else null. */
export async function verifyToken(token: string, secret: string): Promise<UploadToken | null> {
  const [body, sig, extra] = token.split(".");
  if (!body || !sig || extra !== undefined) return null;
  const sigBytes = unb64url(sig);
  if (!sigBytes) return null;
  const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret), sigBytes, enc.encode(body));
  if (!ok) return null;
  const json = unb64url(body);
  if (!json) return null;
  try {
    return JSON.parse(new TextDecoder().decode(json)) as UploadToken;
  } catch {
    return null;
  }
}

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unb64url(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return null;
  try {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}
