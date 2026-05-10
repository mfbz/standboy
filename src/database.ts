import * as path from "node:path";
import { readFile } from "node:fs/promises";
import type { RomExt } from "./messages";

// JSON files are generated at build time from the No-Intro DATs (see
// scripts/build-rom-db.mjs) and bundled at data/rom-db/<ext>.json.
// First lookup per system loads + caches; rest are constant-time.

const FILE_FOR_EXT: Record<RomExt, string> = {
  gb: "gb.json",
  gbc: "gbc.json",
  gba: "gba.json",
};

const cache: Partial<Record<RomExt, Record<string, string>>> = {};

async function loadDb(
  extensionRoot: string,
  ext: RomExt
): Promise<Record<string, string> | null> {
  const cached = cache[ext];
  if (cached) return cached;
  try {
    const file = path.join(extensionRoot, "data", "rom-db", FILE_FOR_EXT[ext]);
    const raw = await readFile(file, "utf8");
    const parsed = JSON.parse(raw) as Record<string, string>;
    cache[ext] = parsed;
    return parsed;
  } catch {
    // Missing/unreadable DB is non-fatal — callers fall back to user filename.
    return null;
  }
}

// Returns null for ROMs not in the database (homebrew, hacks, unreleased).
export async function lookupCanonicalName(
  extensionRoot: string,
  ext: RomExt,
  sha1: string
): Promise<string | null> {
  const db = await loadDb(extensionRoot, ext);
  if (!db) return null;
  return db[sha1.toLowerCase()] ?? null;
}

export function friendlyName(source: string): string {
  return source
    .replace(/\.[^.]+$/, "")
    .replace(/\s*\([^)]*\)/g, "")
    .trim();
}
