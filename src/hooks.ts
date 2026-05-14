import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as vscode from "vscode";
import { MARKER_SCRIPT_PATH, ensureMarkerInstalled } from "./agent";
import type { Agent, AgentStatus } from "./messages";

const CLAUDE_DIR = path.join(os.homedir(), ".claude");
const CLAUDE_SETTINGS = path.join(CLAUDE_DIR, "settings.json");
const CURSOR_HOOKS_FILE = path.join(
  os.homedir(),
  ".cursor",
  "hooks",
  "hooks.json"
);

// Distinct commands per event-kind so the marker can record what kind
// of activity refreshed the sentinel: prompt vs tool. The watcher uses
// the kind to decide whether a fresh write should re-show a manually
// closed panel (prompt = yes, tool = no). The legacy `start` action
// (used by older builds) is still accepted by the marker and is treated
// as `tool` — back-compat for users on hook configs we wrote before
// this split.
const PROMPT_COMMAND = `node "${MARKER_SCRIPT_PATH}" prompt`;
const TOOL_COMMAND = `node "${MARKER_SCRIPT_PATH}" tool`;
const STOP_COMMAND = `node "${MARKER_SCRIPT_PATH}" stop`;

function isCursor(): boolean {
  return vscode.env.appName.toLowerCase().includes("cursor");
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function detectClaudeCode(): Promise<boolean> {
  // Probe Claude Code-specific subpaths, not bare ~/.claude/ — that one's
  // also created by various unrelated tools (older Claude desktop builds,
  // some shell integrations) and would false-positive.
  return (
    (await pathExists(CLAUDE_SETTINGS)) ||
    (await pathExists(path.join(CLAUDE_DIR, "projects")))
  );
}

interface ClaudeCmdHook {
  type: "command";
  command: string;
}
interface ClaudeHookEntry {
  matcher?: string;
  hooks?: ClaudeCmdHook[];
}
interface ClaudeSettings {
  hooks?: Record<string, ClaudeHookEntry[]>;
  [key: string]: unknown;
}

const CLAUDE_PROMPT_EVENTS = ["UserPromptSubmit"] as const;
const CLAUDE_TOOL_EVENTS = ["PreToolUse"] as const;
const CLAUDE_STOP_EVENTS = ["Stop"] as const;
const CLAUDE_ALL_EVENTS = [
  ...CLAUDE_PROMPT_EVENTS,
  ...CLAUDE_TOOL_EVENTS,
  ...CLAUDE_STOP_EVENTS,
] as const;

function isOurClaudeEntry(entry: ClaudeHookEntry): boolean {
  return Boolean(
    entry.hooks?.some(
      (h) =>
        typeof h.command === "string" && h.command.includes(MARKER_SCRIPT_PATH)
    )
  );
}

function ensureClaudeEvent(
  settings: ClaudeSettings,
  event: string,
  command: string
): boolean {
  settings.hooks ??= {};
  settings.hooks[event] ??= [];
  const list = settings.hooks[event]!;
  if (list.some(isOurClaudeEntry)) return false;
  list.push({ hooks: [{ type: "command", command }] });
  return true;
}

// Result is `null` if the file is missing, the special `"corrupt"` token
// if it exists but doesn't parse. Callers MUST distinguish — install paths
// must refuse to overwrite a corrupt config (could be a mid-edit save, a
// merge conflict, etc.); silently overwriting would lose user data on
// every activate now that we auto-reinstall on connected agents.
const CORRUPT = Symbol("corrupt-json");
async function readJson<T>(p: string): Promise<T | null | typeof CORRUPT> {
  let raw: string;
  try {
    raw = await fs.readFile(p, "utf8");
  } catch {
    return null;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    return CORRUPT;
  }
}

async function writeJsonAtomic(p: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2) + "\n");
  await fs.rename(tmp, p);
}

async function installClaudeHooks(): Promise<void> {
  const result = await readJson<ClaudeSettings>(CLAUDE_SETTINGS);
  if (result === CORRUPT) {
    throw new Error(
      "~/.claude/settings.json exists but isn't valid JSON — refusing to overwrite. Fix the file or delete it, then reconnect."
    );
  }
  const settings = result ?? {};
  // Roundtrip JSON before any mutation so we can short-circuit the write
  // when nothing semantically changed. Activate-time auto-migration calls
  // this on every reload for already-connected agents; without the
  // short-circuit we'd churn the user's settings.json mtime needlessly.
  const before = JSON.stringify(settings);
  // Wipe any existing ours-entries first so users upgrading from older
  // builds (which used a single `start` command for both prompt and
  // tool events) get migrated to the new prompt/tool split on reinstall.
  if (settings.hooks) {
    for (const event of CLAUDE_ALL_EVENTS) {
      const list = settings.hooks[event];
      if (!Array.isArray(list)) continue;
      const filtered = list.filter((entry) => !isOurClaudeEntry(entry));
      if (filtered.length === 0) delete settings.hooks[event];
      else settings.hooks[event] = filtered;
    }
  }
  for (const event of CLAUDE_PROMPT_EVENTS) {
    ensureClaudeEvent(settings, event, PROMPT_COMMAND);
  }
  for (const event of CLAUDE_TOOL_EVENTS) {
    ensureClaudeEvent(settings, event, TOOL_COMMAND);
  }
  for (const event of CLAUDE_STOP_EVENTS) {
    ensureClaudeEvent(settings, event, STOP_COMMAND);
  }
  if (JSON.stringify(settings) === before) return;
  await writeJsonAtomic(CLAUDE_SETTINGS, settings);
}

async function uninstallClaudeHooks(): Promise<void> {
  const result = await readJson<ClaudeSettings>(CLAUDE_SETTINGS);
  if (result === CORRUPT) {
    throw new Error(
      "~/.claude/settings.json exists but isn't valid JSON — can't safely modify. Fix the file or delete it, then retry."
    );
  }
  if (!result?.hooks) return;
  const settings = result;
  const hooks = settings.hooks;
  if (!hooks) return;
  let mutated = false;
  for (const event of CLAUDE_ALL_EVENTS) {
    const list = hooks[event];
    if (!Array.isArray(list)) continue;
    const filtered = list.filter((entry) => !isOurClaudeEntry(entry));
    if (filtered.length === list.length) continue;
    mutated = true;
    if (filtered.length === 0) {
      delete hooks[event];
    } else {
      hooks[event] = filtered;
    }
  }
  if (!mutated) return;
  if (Object.keys(hooks).length === 0) delete settings.hooks;
  await writeJsonAtomic(CLAUDE_SETTINGS, settings);
}

async function isClaudeConnected(): Promise<boolean> {
  const result = await readJson<ClaudeSettings>(CLAUDE_SETTINGS);
  // Treat a corrupt file as not-connected — the install path will refuse
  // to overwrite it, so there's nothing to "connect" to until the user
  // resolves the corruption.
  if (result === CORRUPT || !result?.hooks) return false;
  for (const event of CLAUDE_ALL_EVENTS) {
    const list = result.hooks[event];
    if (Array.isArray(list) && list.some(isOurClaudeEntry)) return true;
  }
  return false;
}

interface CursorHookCmd {
  command: string;
}
interface CursorHooksFile {
  version?: number;
  hooks?: Record<string, CursorHookCmd | CursorHookCmd[]>;
}

// Cursor hook event semantics (verified against cursor.com/docs/hooks):
//   beforeSubmitPrompt — user just submitted a prompt; agent is about to start.
//   afterAgentResponse — agent finished generating its response.
//   sessionEnd         — full conversation ended (safety net).
//
// sessionStart is NOT a useful start signal — fires when the user merely
// opens the Composer pane, before they've typed a prompt. Pinning the
// panel open at that moment would be too eager.
const CURSOR_PROMPT_EVENTS = ["beforeSubmitPrompt"] as const;
const CURSOR_STOP_EVENTS = ["afterAgentResponse", "sessionEnd"] as const;
const CURSOR_ALL_EVENTS = [
  ...CURSOR_PROMPT_EVENTS,
  ...CURSOR_STOP_EVENTS,
] as const;

function isOurCursorCmd(cmd: CursorHookCmd): boolean {
  return cmd.command.includes(MARKER_SCRIPT_PATH);
}

function ensureCursorEvent(
  cfg: CursorHooksFile,
  event: string,
  command: string
): void {
  cfg.hooks ??= {};
  const existing = cfg.hooks[event];
  if (!existing) {
    cfg.hooks[event] = { command };
    return;
  }
  if (Array.isArray(existing)) {
    if (existing.some(isOurCursorCmd)) return;
    existing.push({ command });
    return;
  }
  // Single object — if it's already ours, no-op; otherwise expand to an
  // array so the user's existing hook keeps firing alongside ours.
  if (isOurCursorCmd(existing)) return;
  cfg.hooks[event] = [existing, { command }];
}

async function installCursorHooks(): Promise<void> {
  const result = await readJson<CursorHooksFile>(CURSOR_HOOKS_FILE);
  if (result === CORRUPT) {
    throw new Error(
      "~/.cursor/hooks/hooks.json exists but isn't valid JSON — refusing to overwrite. Fix the file or delete it, then reconnect."
    );
  }
  const cfg: CursorHooksFile = result ?? { version: 1, hooks: {} };
  const before = JSON.stringify(cfg);
  // Wipe any existing ours-entries first so users upgrading from older
  // builds get migrated to the new prompt-command on reinstall.
  if (cfg.hooks) {
    for (const event of CURSOR_ALL_EVENTS) {
      const existing = cfg.hooks[event];
      if (!existing) continue;
      if (Array.isArray(existing)) {
        const filtered = existing.filter((c) => !isOurCursorCmd(c));
        if (filtered.length === 0) delete cfg.hooks[event];
        else if (filtered.length === 1) cfg.hooks[event] = filtered[0]!;
        else cfg.hooks[event] = filtered;
      } else if (isOurCursorCmd(existing)) {
        delete cfg.hooks[event];
      }
    }
  }
  for (const event of CURSOR_PROMPT_EVENTS) {
    ensureCursorEvent(cfg, event, PROMPT_COMMAND);
  }
  for (const event of CURSOR_STOP_EVENTS) {
    ensureCursorEvent(cfg, event, STOP_COMMAND);
  }
  cfg.version ??= 1;
  if (JSON.stringify(cfg) === before) return;
  await writeJsonAtomic(CURSOR_HOOKS_FILE, cfg);
}

async function uninstallCursorHooks(): Promise<void> {
  const result = await readJson<CursorHooksFile>(CURSOR_HOOKS_FILE);
  if (result === CORRUPT) {
    throw new Error(
      "~/.cursor/hooks/hooks.json exists but isn't valid JSON — can't safely modify. Fix the file or delete it, then retry."
    );
  }
  if (!result?.hooks) return;
  const cfg = result;
  // Local non-null re-binding so the loop body doesn't need to assert
  // on every access; the early-return above proves it's defined.
  const hooks = cfg.hooks;
  if (!hooks) return;
  let mutated = false;
  for (const event of CURSOR_ALL_EVENTS) {
    const existing = hooks[event];
    if (!existing) continue;
    if (Array.isArray(existing)) {
      const filtered = existing.filter((c) => !isOurCursorCmd(c));
      if (filtered.length === existing.length) continue;
      mutated = true;
      if (filtered.length === 0) {
        delete hooks[event];
      } else if (filtered.length === 1) {
        // Collapse back to object form to match what the user originally had.
        hooks[event] = filtered[0]!;
      } else {
        hooks[event] = filtered;
      }
    } else if (isOurCursorCmd(existing)) {
      mutated = true;
      delete hooks[event];
    }
  }
  if (!mutated) return;
  await writeJsonAtomic(CURSOR_HOOKS_FILE, cfg);
}

async function isCursorConnected(): Promise<boolean> {
  const result = await readJson<CursorHooksFile>(CURSOR_HOOKS_FILE);
  if (result === CORRUPT || !result?.hooks) return false;
  for (const event of CURSOR_ALL_EVENTS) {
    const existing = result.hooks[event];
    if (!existing) continue;
    if (
      Array.isArray(existing)
        ? existing.some(isOurCursorCmd)
        : isOurCursorCmd(existing)
    ) {
      return true;
    }
  }
  return false;
}

export async function getAgentStatus(): Promise<AgentStatus> {
  const [claudeDetected, claudeConnected, cursorConnected] = await Promise.all([
    detectClaudeCode(),
    isClaudeConnected(),
    isCursorConnected(),
  ]);
  return {
    claude: { detected: claudeDetected, connected: claudeConnected },
    cursor: { detected: isCursor(), connected: cursorConnected },
  };
}

export async function setClaudeHooks(enabled: boolean): Promise<void> {
  if (enabled) {
    await ensureMarkerInstalled();
    await installClaudeHooks();
  } else {
    await uninstallClaudeHooks();
  }
}

export async function setCursorHooks(enabled: boolean): Promise<void> {
  if (enabled) {
    await ensureMarkerInstalled();
    await installCursorHooks();
  } else {
    await uninstallCursorHooks();
  }
}

// Mutually exclusive — connecting one agent disconnects the other so they
// never share the sentinel file. We disconnect the other side first so a
// mid-flight stop from the previous connection can't race with the new
// one's start.
export async function setExclusiveAgent(
  agent: Agent,
  enabled: boolean
): Promise<void> {
  if (!enabled) {
    if (agent === "claude") await setClaudeHooks(false);
    else await setCursorHooks(false);
    return;
  }
  if (agent === "claude") {
    await setCursorHooks(false);
    await setClaudeHooks(true);
  } else {
    await setClaudeHooks(false);
    await setCursorHooks(true);
  }
}
