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

// Sentinels with a recorded timestamp older than this are treated as
// stale and ignored — both at activation (crash debris from a previous
// session) and during runtime (no refresh = agent interrupted or
// otherwise stopped without firing its stop hook). The threshold is a
// deliberate trade-off:
//   - Claude Code refreshes the file on every UserPromptSubmit and
//     PreToolUse, so its recorded timestamp stays fresh during real
//     work and we won't false-stale a live run.
//   - Cursor only writes on `beforeSubmitPrompt`, i.e. once per turn.
//     A single Cursor turn that runs longer than this threshold WILL
//     get its sentinel ignored. We accept that edge case in exchange
//     for catching the much more common "Stop hook didn't fire on
//     user interrupt" scenario where the sentinel would otherwise
//     stay pinned until the next extension activation.
export const STALE_THRESHOLD_MS = 5 * 60 * 1000;

// Embedded as a string so we don't ship a separate file and so removing
// the extension can't leave the user's hook configs pointing at a vanished
// path-to-extension. Hooks invoke this as `node ~/.standboy/marker.cjs <action>`.
//
// Actions:
//   prompt — user just submitted a prompt (UserPromptSubmit /
//            beforeSubmitPrompt). Writes "prompt:<ts>".
//   tool   — agent is using a tool (PreToolUse / PostToolUse). Writes
//            "tool:<ts>" — refreshes the heartbeat but does NOT trigger
//            re-show, so the user can keep the panel closed mid-run.
//   stop   — agent finished or session ended. Deletes the sentinel.
//   start  — legacy alias for `tool`, kept so existing hook configs
//            written by older builds keep working until they're
//            re-installed.
export const MARKER_SCRIPT_SOURCE = `#!/usr/bin/env node
// Standboy agent-activity marker. Touched by Cursor / Claude Code hooks.
// Safe to delete; Standboy recreates it on the next activation.
const fs = require("fs");
const os = require("os");
const path = require("path");

const SENTINEL = path.join(os.homedir(), ".standboy", "agent-active");
const action = process.argv[2];

try {
  if (action === "prompt") {
    fs.mkdirSync(path.dirname(SENTINEL), { recursive: true });
    fs.writeFileSync(SENTINEL, "prompt:" + Date.now());
  } else if (action === "tool" || action === "start") {
    fs.mkdirSync(path.dirname(SENTINEL), { recursive: true });
    fs.writeFileSync(SENTINEL, "tool:" + Date.now());
  } else if (action === "stop") {
    try { fs.unlinkSync(SENTINEL); } catch (_) {}
  }
} catch (_) {
  // best-effort — never fail the hook chain over our own bookkeeping.
}
`;

export interface SentinelContent {
  kind: "prompt" | "tool" | "legacy";
  ts: number;
}

// Accepts both the new "<kind>:<ts>" format and the legacy bare-timestamp
// format written by older marker scripts. Returns null for malformed
// content so callers can fall back to mtime.
export function parseSentinelContent(raw: string): SentinelContent | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const colonIdx = trimmed.indexOf(":");
  if (colonIdx > 0) {
    const kindRaw = trimmed.slice(0, colonIdx);
    const tsStr = trimmed.slice(colonIdx + 1);
    const ts = Number(tsStr);
    if (!Number.isFinite(ts) || ts <= 0) return null;
    const kind: SentinelContent["kind"] =
      kindRaw === "prompt" ? "prompt" : kindRaw === "tool" ? "tool" : "legacy";
    return { kind, ts };
  }
  const ts = Number(trimmed);
  if (!Number.isFinite(ts) || ts <= 0) return null;
  return { kind: "legacy", ts };
}

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
    const raw = await fsp.readFile(sentinelPath, "utf8");
    const parsed = parseSentinelContent(raw);
    if (parsed) recordedAt = parsed.ts;
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
  // Trigger an immediate re-read of the sentinel and re-emit any state
  // change. Used as a recovery hook against the one real failure mode of
  // an event-only watcher: fs.watch on macOS can drop events under load.
  // The extension calls this when the user opens the panel themselves
  // (event-driven, not periodic) so any missed transition gets picked up
  // the moment the user interacts with us again.
  recheck(): void;
}

export interface SentinelEvents {
  // Fires when the watcher's view of the sentinel transitions between
  // "effectively active" (file present + timestamp fresh) and
  // "effectively absent" (file missing OR timestamp stale).
  onChange: (active: boolean) => void;
  // Fires when a fresh prompt-kind write lands WHILE the watcher was
  // already in the active state — i.e., the user submitted a new prompt
  // during a sustained agent run. Lets the extension re-show a manually
  // closed panel. Tool-kind refreshes deliberately do NOT fire this, so
  // mid-run tool activity doesn't fight the user's manual close.
  onPromptPing?: () => void;
}

interface WatchOptions {
  // Sentinels whose recorded timestamp is older than this are treated
  // as if the file didn't exist. The fallback for "Stop hook didn't
  // fire on user interrupt" — without it the override stays pinned
  // active until the next extension activation. Defaults to
  // STALE_THRESHOLD_MS.
  ttlMs?: number;
  // Override the watched directory + filename. Defaults to
  // ~/.standboy/agent-active; tests point this at a tmpdir.
  dir?: string;
  filename?: string;
}

// Watches ~/.standboy/agent-active and reports its effective active
// state. "Effective" means: present AND its recorded timestamp is fresh
// (within ttlMs). A sentinel whose timestamp has gone stale is treated
// as absent — that's how user interrupts (which don't fire Stop) and
// crashes get reconciled at runtime instead of pinning the panel open
// until the next activation.
//
// Strictly event-driven, zero busy work:
//   1. Node fs.watch on the parent directory — kernel notifies us when
//      the sentinel is created, modified, or deleted. Costs nothing
//      while idle (OS event subscription, not a thread).
//   2. A single setTimeout armed when the sentinel is fresh, fires
//      once after ttlMs of silence, then triggers a stale check. Each
//      fresh write resets it. No timer is pending when the sentinel
//      is absent. This replaces what a periodic poll would do for
//      timestamp-aging detection.
//   3. Internal state tracking — onChange only fires on real
//      transitions, so any duplicate fs event is harmless.
//
// fs.watch is known to drop events on macOS under heavy I/O load. For
// the sentinel use case (touched a handful of times per agent turn)
// this is rare in practice. Two recovery paths cover it without adding
// any periodic work:
//   (a) Most sentinel writes are refreshes during a sustained run, so
//       a dropped CREATE is usually followed by several CHANGE events
//       within seconds; the next delivered event re-syncs state.
//   (b) The extension calls `recheck()` whenever the user opens the
//       Standboy panel themselves (view.onDidChangeVisibility → true),
//       picking up anything fs.watch never delivered. Event-driven on
//       user action, not periodic.
export function watchSentinel(
  events: SentinelEvents,
  opts: WatchOptions = {}
): SentinelWatcher {
  const ttlMs = opts.ttlMs ?? STALE_THRESHOLD_MS;
  const dir = opts.dir ?? STANDBOY_HOME;
  const filename = opts.filename ?? "agent-active";
  const filePath = path.join(dir, filename);

  let lastState: boolean | null = null;
  // Last seen raw content. Used to detect a fresh prompt-kind write
  // (content changed AND new kind is "prompt") so we can ping the
  // extension to re-show a manually-closed panel.
  let lastContent: string | null = null;
  let disposed = false;
  let inFlight = false;
  let dirWatcher: fs.FSWatcher | null = null;
  let staleTimer: ReturnType<typeof setTimeout> | null = null;

  const cancelStaleTimer = (): void => {
    if (staleTimer) {
      clearTimeout(staleTimer);
      staleTimer = null;
    }
  };

  const armStaleTimer = (recordedAt: number): void => {
    cancelStaleTimer();
    const remaining = Math.max(0, ttlMs - (Date.now() - recordedAt));
    staleTimer = setTimeout(() => {
      staleTimer = null;
      void check();
    }, remaining);
  };

  const check = async (): Promise<void> => {
    if (disposed) return;
    // Coalesce concurrent checks. Multiple fs events can pile up
    // (rename + change for a single writeFileSync); only the latest
    // matters. A transition that lands while a check is mid-flight
    // can be dropped here — the next fs event or the stale-timer
    // re-arm will pick it up, and the 5s downstream debounce hides
    // any gap.
    if (inFlight) return;
    inFlight = true;
    try {
      let raw: string | null = null;
      try {
        raw = await fsp.readFile(filePath, "utf8");
      } catch {
        // File missing or unreadable — both treated as absent.
      }

      let active = false;
      let parsed: SentinelContent | null = null;
      let recordedAt = 0;
      if (raw !== null) {
        parsed = parseSentinelContent(raw);
        // Malformed content falls through to recordedAt=0 → active=false.
        // The marker always writes well-formed content; the only way to
        // reach this branch with parsed=null is mid-write corruption or
        // hand-edited debris, both of which we should ignore.
        recordedAt = parsed?.ts ?? 0;
        active = Date.now() - recordedAt < ttlMs;
      }

      if (disposed) return;

      const wasActive = lastState === true;
      if (lastState !== active) {
        lastState = active;
        events.onChange(active);
      }

      // Sustained active + fresh prompt-kind write = user submitted a
      // new prompt during an existing run. Fire promptPing so the
      // extension can re-show if the user manually closed the panel.
      // Skipped when we just transitioned false→true (the onChange
      // branch above already drives the show command).
      if (
        active &&
        wasActive &&
        parsed?.kind === "prompt" &&
        raw !== lastContent
      ) {
        events.onPromptPing?.();
      }

      lastContent = raw;

      // Arm/cancel the staleness timer based on the new state. While
      // active, one timer is pending; while idle, nothing is scheduled.
      if (active) armStaleTimer(recordedAt);
      else cancelStaleTimer();
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
      // Directory missing or otherwise unwatchable — fs.watch can't
      // attach yet. Retry shortly; ensureMarkerInstalled() runs at
      // activate, so this should resolve on its own within a second.
      dirWatcher = null;
      if (!disposed) setTimeout(startDirWatcher, 1000);
    }
  };

  void check();
  startDirWatcher();

  return {
    dispose(): void {
      disposed = true;
      cancelStaleTimer();
      try {
        dirWatcher?.close();
      } catch {
        // ignore
      }
      dirWatcher = null;
    },
    recheck(): void {
      void check();
    },
  };
}
