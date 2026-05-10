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

const START_COMMAND = `node "${MARKER_SCRIPT_PATH}" start`;
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

const CLAUDE_START_EVENTS = ["UserPromptSubmit", "PreToolUse"] as const;
const CLAUDE_STOP_EVENTS = ["Stop"] as const;
const CLAUDE_ALL_EVENTS = [
  ...CLAUDE_START_EVENTS,
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

async function readJson<T>(p: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(p, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function writeJsonAtomic(p: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2) + "\n");
  await fs.rename(tmp, p);
}

async function installClaudeHooks(): Promise<void> {
  const settings = (await readJson<ClaudeSettings>(CLAUDE_SETTINGS)) ?? {};
  for (const event of CLAUDE_START_EVENTS) {
    ensureClaudeEvent(settings, event, START_COMMAND);
  }
  for (const event of CLAUDE_STOP_EVENTS) {
    ensureClaudeEvent(settings, event, STOP_COMMAND);
  }
  await writeJsonAtomic(CLAUDE_SETTINGS, settings);
}

async function uninstallClaudeHooks(): Promise<void> {
  const settings = await readJson<ClaudeSettings>(CLAUDE_SETTINGS);
  if (!settings?.hooks) return;
  let mutated = false;
  for (const event of CLAUDE_ALL_EVENTS) {
    const list = settings.hooks[event];
    if (!Array.isArray(list)) continue;
    const filtered = list.filter((entry) => !isOurClaudeEntry(entry));
    if (filtered.length === list.length) continue;
    mutated = true;
    if (filtered.length === 0) {
      delete settings.hooks[event];
    } else {
      settings.hooks[event] = filtered;
    }
  }
  if (!mutated) return;
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  await writeJsonAtomic(CLAUDE_SETTINGS, settings);
}

async function isClaudeConnected(): Promise<boolean> {
  const settings = await readJson<ClaudeSettings>(CLAUDE_SETTINGS);
  if (!settings?.hooks) return false;
  for (const event of CLAUDE_ALL_EVENTS) {
    const list = settings.hooks[event];
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
const CURSOR_START_EVENTS = ["beforeSubmitPrompt"] as const;
const CURSOR_STOP_EVENTS = ["afterAgentResponse", "sessionEnd"] as const;
const CURSOR_ALL_EVENTS = [
  ...CURSOR_START_EVENTS,
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
  const cfg = (await readJson<CursorHooksFile>(CURSOR_HOOKS_FILE)) ?? {
    version: 1,
    hooks: {},
  };
  for (const event of CURSOR_START_EVENTS) {
    ensureCursorEvent(cfg, event, START_COMMAND);
  }
  for (const event of CURSOR_STOP_EVENTS) {
    ensureCursorEvent(cfg, event, STOP_COMMAND);
  }
  cfg.version ??= 1;
  await writeJsonAtomic(CURSOR_HOOKS_FILE, cfg);
}

async function uninstallCursorHooks(): Promise<void> {
  const cfg = await readJson<CursorHooksFile>(CURSOR_HOOKS_FILE);
  if (!cfg?.hooks) return;
  let mutated = false;
  for (const event of CURSOR_ALL_EVENTS) {
    const existing = cfg.hooks[event];
    if (!existing) continue;
    if (Array.isArray(existing)) {
      const filtered = existing.filter((c) => !isOurCursorCmd(c));
      if (filtered.length === existing.length) continue;
      mutated = true;
      if (filtered.length === 0) {
        delete cfg.hooks[event];
      } else if (filtered.length === 1) {
        // Collapse back to object form to match what the user originally had.
        cfg.hooks[event] = filtered[0]!;
      } else {
        cfg.hooks[event] = filtered;
      }
    } else if (isOurCursorCmd(existing)) {
      mutated = true;
      delete cfg.hooks[event];
    }
  }
  if (!mutated) return;
  await writeJsonAtomic(CURSOR_HOOKS_FILE, cfg);
}

async function isCursorConnected(): Promise<boolean> {
  const cfg = await readJson<CursorHooksFile>(CURSOR_HOOKS_FILE);
  if (!cfg?.hooks) return false;
  for (const event of CURSOR_ALL_EVENTS) {
    const existing = cfg.hooks[event];
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
