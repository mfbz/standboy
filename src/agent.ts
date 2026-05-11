import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";

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

// Sentinels older than this on activation are treated as crash debris
// and removed. Threshold is a deliberate trade-off:
//   - Claude Code refreshes the file on every UserPromptSubmit and
//     PreToolUse, so its recorded timestamp stays fresh during real
//     work and we won't false-stale a live run.
//   - Cursor only writes on `beforeSubmitPrompt`, i.e. once per turn.
//     A single Cursor turn that runs longer than this threshold and
//     whose second editor activates mid-flight WILL get its sentinel
//     deleted out from under it. We accept that edge case in exchange
//     for fast recovery from the much more common crash scenario.
export const STALE_THRESHOLD_MS = 5 * 60 * 1000;

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
  await fsp.mkdir(STANDBOY_HOME, { recursive: true });
  await fsp.writeFile(MARKER_SCRIPT_PATH, MARKER_SCRIPT_SOURCE, {
    mode: 0o755,
  });
}

// Remove a sentinel left over from a crash or unclean shutdown. Returns
// true if a stale file was removed. Called once at activation, before
// the watcher starts seeing events, so the seed read can't mistake
// stale debris for a real in-flight agent.
export async function cleanupStaleSentinel(
  now: number = Date.now(),
  sentinelPath: string = SENTINEL_PATH
): Promise<boolean> {
  let stat: fs.Stats;
  try {
    stat = await fsp.stat(sentinelPath);
  } catch {
    return false;
  }

  // Prefer the timestamp the marker script wrote into the file, since
  // mtime can be reset by tooling that touches the file without
  // semantic intent. Fall back to mtime when the contents are
  // malformed (e.g. truncated write from a previous crash).
  let recordedAt = stat.mtimeMs;
  try {
    const raw = (await fsp.readFile(sentinelPath, "utf8")).trim();
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) recordedAt = parsed;
  } catch {
    // keep mtime fallback
  }

  if (now - recordedAt < STALE_THRESHOLD_MS) return false;

  try {
    await fsp.unlink(sentinelPath);
    return true;
  } catch {
    return false;
  }
}

export interface SentinelWatcher {
  dispose(): void;
}

interface WatchOptions {
  // Backup poll interval in ms — catches events fs.watch dropped
  // (macOS in particular drops them under load). Default 2s is a
  // good balance: imperceptible alongside the 5s show/hide delays
  // applied downstream, and cheap (a single fs.stat).
  pollIntervalMs?: number;
  // Override the watched directory + filename. Defaults to
  // ~/.standboy/agent-active; tests point this at a tmpdir.
  dir?: string;
  filename?: string;
}

// Watches ~/.standboy/agent-active and invokes onChange whenever its
// existence flips, exactly once per real transition. Layered for
// reliability:
//   1. Node fs.watch on the parent directory — low-latency, but known
//      to drop events on macOS under load and to silently die if the
//      watched dir is replaced.
//   2. setInterval poll as a backup — guaranteed to catch any state
//      change within pollIntervalMs even if every fs event was lost.
//   3. Internal state tracking — onChange only fires on real
//      transitions, so the polling backup never produces duplicate
//      events when fs.watch already delivered them.
export function watchSentinel(
  onChange: (active: boolean) => void,
  opts: WatchOptions = {}
): SentinelWatcher {
  const pollIntervalMs = opts.pollIntervalMs ?? 2000;
  const dir = opts.dir ?? STANDBOY_HOME;
  const filename = opts.filename ?? "agent-active";
  const filePath = path.join(dir, filename);

  let lastState: boolean | null = null;
  let disposed = false;
  let inFlight = false;
  let dirWatcher: fs.FSWatcher | null = null;

  const check = async (): Promise<void> => {
    if (disposed) return;
    // Coalesce concurrent checks. Multiple fs events can pile up
    // (rename + change for a single writeFileSync, plus a poll tick);
    // only the latest matters. A transition that lands while a check
    // is mid-flight can be dropped here — the next fs event or the
    // polling tick (≤pollIntervalMs) will pick it up, and the 5s
    // downstream debounce hides the gap.
    if (inFlight) return;
    inFlight = true;
    try {
      let exists = false;
      try {
        await fsp.access(filePath);
        exists = true;
      } catch {
        exists = false;
      }
      if (disposed) return;
      if (exists !== lastState) {
        lastState = exists;
        onChange(exists);
      }
    } finally {
      inFlight = false;
    }
  };

  const startDirWatcher = (): void => {
    if (disposed) return;
    try {
      dirWatcher = fs.watch(dir, (_event, changed) => {
        if (disposed) return;
        // changed can be null on some macOS configurations; in that
        // case re-check unconditionally rather than miss the event.
        if (changed && changed !== filename) return;
        void check();
      });
      // If the watched directory is removed/replaced we get an error
      // and the watcher silently goes dead. Tear down + recreate so
      // a temporary disappearance (e.g. user moved ~/.standboy aside)
      // doesn't permanently break detection.
      dirWatcher.on("error", () => {
        try {
          dirWatcher?.close();
        } catch {
          // ignore
        }
        dirWatcher = null;
        if (!disposed) setTimeout(startDirWatcher, 1000);
      });
    } catch {
      // Directory missing or otherwise unwatchable — polling will
      // still detect changes; try again on the next poll tick.
      dirWatcher = null;
    }
  };

  void check();
  startDirWatcher();
  const poll = setInterval(() => {
    if (!dirWatcher) startDirWatcher();
    void check();
  }, pollIntervalMs);

  return {
    dispose(): void {
      disposed = true;
      clearInterval(poll);
      try {
        dirWatcher?.close();
      } catch {
        // ignore
      }
      dirWatcher = null;
    },
  };
}
