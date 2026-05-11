export type Palette = readonly [string, string, string, string];

export type ActivityState = "idle" | "active";

// Persisted to `<libraryRoot>/config.json`.
export interface KeyBindings {
  a: string;
  b: string;
  start: string;
  select: string;
}

// Z is the easiest reach on QWERTY (bottom-left, index resting), so it
// gets A — the button you press constantly. X picks up B.
export const DEFAULT_BINDINGS: KeyBindings = {
  a: "z",
  b: "x",
  start: "Enter",
  select: "Shift",
};

// Pre-2026-05-09 defaults — Config.read() migrates unmodified configs
// from this shape to DEFAULT_BINDINGS. Users with custom bindings keep them.
export const LEGACY_DEFAULT_BINDINGS: KeyBindings = {
  a: "x",
  b: "z",
  start: "Enter",
  select: "Shift",
};

export type RomExt = "gb" | "gbc" | "gba";

export interface LibraryEntry {
  hash: string;
  name: string;
  displayName: string;
  ext: RomExt;
  size: number;
  lastPlayedAt: string;
  // null → host tried to fetch a cover and failed; UI shows letter fallback.
  coverUri: string | null;
}

// `bytes` is `number[]` because Uint8Array doesn't round-trip cleanly
// across VSCode's postMessage JSON layer — it becomes `{0:b0, 1:b1, ...}`
// and downstream `Blob` falls back to `String()` → "[object Object]".
// Sender: Array.from(uint8). Receiver: new Uint8Array(numbers).
export interface Rom {
  hash: string;
  bytes: number[];
  ext: "gb" | "gbc" | "gba";
  name: string;
  displayName: string;
  save?: number[];
}

export type Agent = "claude" | "cursor";

export interface AgentInfo {
  // detected = the agent's runtime is present on the system; connected =
  // our hooks are currently installed in its config. UI uses both: a
  // toggle row only shows for detected agents, and the pill reflects connected.
  detected: boolean;
  connected: boolean;
}

export interface AgentStatus {
  claude: AgentInfo;
  cursor: AgentInfo;
}

export type HostToWebview =
  | { kind: "init"; emulatorDataUrl: string; emulatorLoaderUrl: string }
  | { kind: "palette"; palette: Palette }
  | { kind: "activity"; state: ActivityState }
  | ({ kind: "rom" } & Rom)
  | { kind: "library"; entries: LibraryEntry[] }
  | { kind: "coverUpdate"; hash: string; coverUri: string | null }
  | { kind: "bindings"; bindings: KeyBindings }
  | { kind: "agentStatus"; status: AgentStatus }
  | { kind: "autoShow"; enabled: boolean }
  // Hard reload — the only reliable way to swap the running ROM, since
  // EmulatorJS has no clean teardown.
  | { kind: "reload" }
  // Auto-hide announcement: `durationMs` → render countdown bar; `null` → clear it.
  | { kind: "closingTimer"; durationMs: number | null };

export type MenuAction =
  | "loadRom"
  | "openLibraryFolder"
  | "exportSave"
  | "importSave"
  | "deleteRom"
  | "showLogs";

export type WebviewToHost =
  | { kind: "ready" }
  | { kind: "save"; hash: string; bytes: number[] }
  | { kind: "menu"; action: MenuAction }
  | { kind: "switchRom"; hash: string }
  | { kind: "saveBindings"; bindings: KeyBindings }
  | { kind: "setAgent"; agent: Agent; enabled: boolean }
  | { kind: "setAutoShow"; enabled: boolean };
