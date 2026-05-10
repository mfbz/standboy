import { writeFile, access, constants } from "node:fs/promises";
import type { RomExt } from "./messages";

// Source: libretro-thumbnails. Free, no auth, indexed by no-intro filename.
// Network access happens here in the extension host — webview only loads
// cached files via asWebviewUri, so the strict CSP stays untouched.

const SYSTEM_FOR_EXT: Record<RomExt, string> = {
  gb: "Nintendo - Game Boy",
  gbc: "Nintendo - Game Boy Color",
  gba: "Nintendo - Game Boy Advance",
};

const BASE_URL = "https://thumbnails.libretro.com";

// canonicalName from the SHA-1 lookup goes first when available — that's
// the exact filename libretro indexes by, almost always a one-shot hit.
// Filename variants are the fallback for ROMs not in our bundled DB.
function nameVariants(romName: string, canonicalName?: string): string[] {
  const variants = new Set<string>();
  if (canonicalName) variants.add(canonicalName.trim());
  const base = romName.replace(/\.[^.]+$/, "").trim();
  variants.add(base);
  variants.add(base.replace(/\s*\(Rev \d+\)\s*/gi, "").trim());
  variants.add(base.replace(/\s*\(v\d+(?:\.\d+)*\)\s*/gi, "").trim());
  variants.add(base.replace(/\s*\([^)]*\)\s*/g, "").trim());
  return [...variants].filter((v) => v.length > 0);
}

// notFound = upstream 404 (safe to cache as a permanent miss).
// transient = rate limit / 5xx / network blip — caller leaves the slot open.
type FetchResult =
  | { kind: "ok"; bytes: Uint8Array }
  | { kind: "notFound" }
  | { kind: "transient" };

const FETCH_TIMEOUT_MS = 12_000;
// Real covers are well under 500KB; anything larger is hostile or misconfigured.
const MAX_COVER_BYTES = 5 * 1024 * 1024;

const PNG_MAGIC = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
function looksLikePng(bytes: Uint8Array): boolean {
  if (bytes.length < PNG_MAGIC.length) return false;
  for (let i = 0; i < PNG_MAGIC.length; i++) {
    if (bytes[i] !== PNG_MAGIC[i]) return false;
  }
  return true;
}

async function tryFetch(
  system: string,
  candidate: string
): Promise<FetchResult> {
  const url = `${BASE_URL}/${encodeURIComponent(system)}/Named_Boxarts/${encodeURIComponent(candidate)}.png`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (res.status === 404) return { kind: "notFound" };
    if (!res.ok) return { kind: "transient" };
    const declaredSize = Number(res.headers.get("content-length"));
    if (declaredSize > MAX_COVER_BYTES) return { kind: "transient" };
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > MAX_COVER_BYTES) return { kind: "transient" };
    if (!looksLikePng(bytes)) return { kind: "transient" };
    return { kind: "ok", bytes };
  } catch {
    return { kind: "transient" };
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchCover(
  romName: string,
  ext: RomExt,
  canonicalName?: string
): Promise<FetchResult> {
  const system = SYSTEM_FOR_EXT[ext];
  let anyTransient = false;
  for (const candidate of nameVariants(romName, canonicalName)) {
    const result = await tryFetch(system, candidate);
    if (result.kind === "ok") return result;
    if (result.kind === "transient") anyTransient = true;
  }
  return anyTransient ? { kind: "transient" } : { kind: "notFound" };
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

// Idempotent on either coverPath or missPath already existing. Writes a
// .miss marker only on a confirmed 404; transient failures leave both
// files absent so the next session retries.
export async function ensureCoverFile(
  romName: string,
  ext: RomExt,
  coverPath: string,
  missPath: string,
  canonicalName?: string
): Promise<"cached" | "missing" | "fetched" | "unmatched" | "transient"> {
  if (await exists(coverPath)) return "cached";
  if (await exists(missPath)) return "missing";
  const result = await fetchCover(romName, ext, canonicalName);
  if (result.kind === "ok") {
    await writeFile(coverPath, result.bytes);
    return "fetched";
  }
  if (result.kind === "notFound") {
    await writeFile(missPath, "");
    return "unmatched";
  }
  return "transient";
}
