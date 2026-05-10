import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs/promises";
import * as vscode from "vscode";

// Hooks installed by setClaudeHooks/setCursorHooks touch ~/.standboy/agent-active
// when the agent starts and delete it when the agent stops. We watch
// the file and treat its existence as authoritative activity state.
//
// Living under ~/.standboy/ (not extension globalStorage) means one
// canonical path across editors — VSCode + Cursor running side-by-side
// don't end up with two competing sentinels.

export const STANDBOY_HOME = path.join(os.homedir(), ".standboy");
export const SENTINEL_PATH = path.join(STANDBOY_HOME, "agent-active");
export const MARKER_SCRIPT_PATH = path.join(STANDBOY_HOME, "marker.cjs");

// Embedded as a string so we don't ship a separate file and so removing
// the extension can't leave the user's hook configs pointing at a vanished
// path-to-extension. Hooks invoke this as `node ~/.standboy/marker.cjs start|stop`.
export const MARKER_SCRIPT_SOURCE = `#!/usr/bin/env node
// Standboy agent-activity marker. Touched by Cursor / Claude Code hooks.
// Safe to delete; Standboy recreates it on the next activation.
const fs = require("fs");
const os = require("os");
const path = require("path");

const SENTINEL = path.join(os.homedir(), ".standboy", "agent-active");
const action = process.argv[2];

try {
  if (action === "start") {
    fs.mkdirSync(path.dirname(SENTINEL), { recursive: true });
    fs.writeFileSync(SENTINEL, String(Date.now()));
  } else if (action === "stop") {
    try { fs.unlinkSync(SENTINEL); } catch (_) {}
  }
} catch (_) {
  // best-effort — never fail the hook chain over our own bookkeeping.
}
`;

export async function ensureMarkerInstalled(): Promise<void> {
  await fs.mkdir(STANDBOY_HOME, { recursive: true });
  await fs.writeFile(MARKER_SCRIPT_PATH, MARKER_SCRIPT_SOURCE, { mode: 0o755 });
}

export function watchSentinel(
  onChange: (active: boolean) => void
): vscode.Disposable {
  // Seed with current state so the caller doesn't have to.
  void fs
    .access(SENTINEL_PATH)
    .then(() => onChange(true))
    .catch(() => onChange(false));

  const pattern = new vscode.RelativePattern(
    vscode.Uri.file(STANDBOY_HOME),
    "agent-active"
  );
  const watcher = vscode.workspace.createFileSystemWatcher(pattern);
  watcher.onDidCreate(() => onChange(true));
  watcher.onDidChange(() => onChange(true));
  watcher.onDidDelete(() => onChange(false));
  return watcher;
}
