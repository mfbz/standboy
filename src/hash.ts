import { createHash } from "node:crypto";

export function romHash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 16);
}

// Full SHA-1 — the key No-Intro DATs use to identify a specific dump.
export function romSha1(bytes: Uint8Array): string {
  return createHash("sha1").update(bytes).digest("hex").toLowerCase();
}
