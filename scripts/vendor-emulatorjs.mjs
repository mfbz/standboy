import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "node_modules", "@emulatorjs");
const DEST = path.join(ROOT, "vendor", "emulatorjs");
const CORES_DEST = path.join(DEST, "data", "cores");

const MARKER = path.join(DEST, "data", "loader.js");

if (fs.existsSync(MARKER)) {
  console.log("[standboy] vendor up-to-date, skipping");
  process.exit(0);
}
if (!fs.existsSync(SRC)) {
  throw new Error(
    `Missing ${SRC}. Run \`npm install\` first to fetch @emulatorjs/* packages.`
  );
}

fs.rmSync(DEST, { recursive: true, force: true });
fs.mkdirSync(CORES_DEST, { recursive: true });

fs.cpSync(path.join(SRC, "emulatorjs", "data"), path.join(DEST, "data"), {
  recursive: true,
});

// GPL-3.0 §4 requires preserving the upstream license alongside the work
// when conveying. Ship it next to the vendored data so the .vsix carries it.
const upstreamLicense = path.join(SRC, "emulatorjs", "LICENSE");
if (fs.existsSync(upstreamLicense)) {
  fs.cpSync(upstreamLicense, path.join(DEST, "LICENSE"));
}

for (const pkg of ["core-gambatte", "core-mgba"]) {
  const dir = path.join(SRC, pkg);
  for (const file of fs.readdirSync(dir)) {
    if (file.endsWith(".data")) {
      fs.cpSync(path.join(dir, file), path.join(CORES_DEST, file));
    }
  }
}

// Patch known EmulatorJS bug: gotGameData writes uncompressed ROMs (raw
// .gb/.gbc/.gba — what we always send) to a relative path, but startGame
// later passes an absolute /${fileName} to RetroArch's callMain. The
// mismatch makes RetroArch fall back to its main menu. Fix: prefix the
// writeFile path with / so the file lands at the absolute root.
const emulatorJsPath = path.join(DEST, "data", "src", "emulator.js");
const before =
  'if (fileName === "!!notCompressedData") {\n' +
  "                        this.gameManager.FS.writeFile(altName, fileData);";
const after =
  'if (fileName === "!!notCompressedData") {\n' +
  '                        this.gameManager.FS.writeFile("/" + altName, fileData);';
const source = fs.readFileSync(emulatorJsPath, "utf8");
if (!source.includes(before)) {
  throw new Error(
    "Could not apply the absolute-path patch to emulator.js — the upstream " +
      "code may have changed. Update the patch in scripts/vendor-emulatorjs.mjs."
  );
}
fs.writeFileSync(emulatorJsPath, source.replace(before, after));

console.log("[standboy] EmulatorJS vendored + patched at", DEST);
