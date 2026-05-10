#!/usr/bin/env node
import { writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import * as path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const OUT_DIR = path.join(ROOT, "data", "rom-db");

// Pinned commit SHA — bump deliberately. A PR bumps the constant +
// the JSON files together, making upstream changes auditable.
const LIBRETRO_DB_SHA = "8ae09ff74c9883a9170ffde1d69b4151f99d944f";

const SOURCES = {
  gb: "Nintendo - Game Boy",
  gbc: "Nintendo - Game Boy Color",
  gba: "Nintendo - Game Boy Advance",
};

// libretro-database splits its DATs into several folders; the No-Intro
// authoritative ones (which are what we need for hash-based identification)
// live under `metadat/no-intro/`, not the top-level `dat/`.
const BASE_URL = `https://raw.githubusercontent.com/libretro/libretro-database/${LIBRETRO_DB_SHA}/metadat/no-intro/`;

// Splits on top-level `game (` openings; peels each block until the
// matching `)` on its own line at column 0. Nested `rom ( ... )` lives
// on a single line so it doesn't confuse the boundary.
function parseDat(text) {
  const out = {};
  const blocks = text.split(/\ngame \(/);
  // First chunk is the file header — skip it.
  for (const block of blocks.slice(1)) {
    const endIdx = block.search(/^\)/m);
    if (endIdx === -1) continue;
    const body = block.slice(0, endIdx);
    const nameMatch = body.match(/^\s*name "([^"]+)"/m);
    const sha1Match = body.match(/sha1 ([0-9a-fA-F]{40})/);
    if (nameMatch && sha1Match) {
      out[sha1Match[1].toLowerCase()] = nameMatch[1];
    }
  }
  return out;
}

await mkdir(OUT_DIR, { recursive: true });

console.log(
  `[rom-db] pinned to libretro-database@${LIBRETRO_DB_SHA.slice(0, 8)}`
);

let totalEntries = 0;
let totalBytes = 0;

for (const [ext, system] of Object.entries(SOURCES)) {
  const url = BASE_URL + encodeURIComponent(system) + ".dat";
  process.stdout.write(`[rom-db] ${ext}: fetching… `);
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`\n[rom-db] HTTP ${res.status} ${res.statusText} for ${url}`);
    process.exit(1);
  }
  const text = await res.text();
  const parsed = parseDat(text);
  const count = Object.keys(parsed).length;
  if (count === 0) {
    console.error(
      `\n[rom-db] parsed 0 entries from ${ext} — DAT format may have changed`
    );
    process.exit(1);
  }
  const json = JSON.stringify(parsed) + "\n";
  await writeFile(path.join(OUT_DIR, `${ext}.json`), json);
  console.log(
    `${count} entries (${(text.length / 1024).toFixed(0)}KB DAT → ${(json.length / 1024).toFixed(0)}KB JSON)`
  );
  totalEntries += count;
  totalBytes += json.length;
}

console.log(
  `[rom-db] total: ${totalEntries} entries, ${(totalBytes / 1024).toFixed(0)}KB JSON at ${path.relative(ROOT, OUT_DIR)}/`
);
