import { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import {
  Bot,
  Download,
  Eye,
  FolderOpen,
  Plus,
  ScrollText,
  Trash2,
  Upload,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { onMessage, send } from "./messaging";
import { StandbyDot } from "./components/standby-dot";
import { EmulatorHost } from "./components/emulator-host";
import { LibraryGrid } from "./components/library-grid";
import type {
  ActivityState,
  Agent,
  AgentStatus,
  KeyBindings,
  LibraryEntry,
  MenuAction,
  Palette,
  Rom,
} from "../src/messages";
import { DEFAULT_BINDINGS } from "../src/messages";

function HamburgerIcon(): ReactElement {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      aria-hidden
    >
      <line x1="4" y1="9" x2="20" y2="9" />
      <line x1="4" y1="15" x2="20" y2="15" />
    </svg>
  );
}

function applyPalette(palette: Palette): void {
  const root = document.documentElement;
  root.style.setProperty("--sb-c0", palette[0]);
  root.style.setProperty("--sb-c1", palette[1]);
  root.style.setProperty("--sb-c2", palette[2]);
  root.style.setProperty("--sb-c3", palette[3]);
}

// Only A, B, Start, Select are user-rebindable. Arrows stay as the D-pad.
// Defaults match EmulatorJS's built-ins exactly so no remapping fires
// until the user picks a different key — hot path stays zero-overhead.
const BINDABLE_ACTIONS = ["a", "b", "start", "select"] as const;
type BindableAction = (typeof BINDABLE_ACTIONS)[number];

// Libretro button indices, same numbers EmulatorJS uses internally
// (emulator.js setUp at line 3082+). Game Boy: 0=B, 2=SELECT, 3=START, 8=A.
// Fed to gameManager.simulateInput directly because synthetic KeyboardEvents
// have keyCode===0, which EmulatorJS's legacy listener can't read.
const BUTTON_INDEX_FOR_ACTION: Record<BindableAction, number> = {
  a: 8,
  b: 0,
  select: 2,
  start: 3,
};

const AGENT_LABELS: Record<Agent, string> = {
  claude: "Claude Code",
  cursor: "Cursor agent",
};

const EMPTY_AGENT_STATUS: AgentStatus = {
  claude: { detected: false, connected: false },
  cursor: { detected: false, connected: false },
};

// Letter keys are case-insensitive — z and Z should both fire A.
function normalizeKey(key: string): string {
  return key.length === 1 ? key.toLowerCase() : key;
}

function displayKey(key: string): string {
  if (key === " ") return "Space";
  if (key === "Enter") return "↵";
  if (key === "Shift") return "⇧";
  if (key === "Control") return "Ctrl";
  if (key === "Alt") return "Alt";
  if (key === "Meta") return "⌘";
  if (key === "Backspace") return "⌫";
  if (key === "Tab") return "⇥";
  if (key === "Escape") return "Esc";
  if (key === "ArrowUp") return "↑";
  if (key === "ArrowDown") return "↓";
  if (key === "ArrowLeft") return "←";
  if (key === "ArrowRight") return "→";
  return key.length === 1 ? key.toUpperCase() : key;
}

const GAME_KEYS = new Set([
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "z",
  "Z",
  "x",
  "X",
  "Enter",
  "Backspace",
  "Shift",
]);

function truncate(name: string): string {
  return name.length > 28 ? name.slice(0, 28) + "…" : name;
}

function HeaderButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactElement;
}): ReactElement {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      style={{
        width: "28px",
        height: "28px",
        borderRadius: "6px",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        color: "rgba(226,243,228,0.65)",
        background: "transparent",
        border: "none",
        cursor: "pointer",
        transition: "all 150ms ease-out",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = "rgba(255,255,255,0.06)";
        e.currentTarget.style.color = "var(--sb-c3)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "transparent";
        e.currentTarget.style.color = "rgba(226,243,228,0.65)";
      }}
    >
      {children}
    </button>
  );
}

interface ActionSpec {
  label: string;
  action: MenuAction;
  enabled: boolean;
  icon: LucideIcon;
}

const SECTION_LABEL_STYLE: React.CSSProperties = {
  fontSize: "9px",
  letterSpacing: "0.22em",
  textTransform: "uppercase",
  opacity: 0.5,
  fontWeight: 600,
  padding: "0 16px 8px",
};

function MenuSpacer(): ReactElement {
  return <div style={{ height: 18 }} />;
}

const KBD_STYLE: React.CSSProperties = {
  background: "rgba(255,255,255,0.07)",
  padding: "3px 7px",
  borderRadius: "4px",
  fontWeight: 600,
  fontFamily: "inherit",
  fontSize: "11px",
  letterSpacing: "0.04em",
  minWidth: "18px",
  textAlign: "center",
  border: "1px solid rgba(255,255,255,0.04)",
  display: "inline-block",
};

const STATUS_PILL_BASE: React.CSSProperties = {
  fontSize: "9px",
  letterSpacing: "0.16em",
  textTransform: "uppercase",
  fontWeight: 700,
  padding: "3px 8px",
  borderRadius: "4px",
};

function ArrowsRow(): ReactElement {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "6px 16px",
      }}
    >
      <div style={{ display: "flex", gap: "4px" }}>
        {["↑", "↓", "←", "→"].map((k) => (
          <kbd key={k} style={KBD_STYLE}>
            {k}
          </kbd>
        ))}
      </div>
      <span style={{ opacity: 0.65, fontSize: "11.5px" }}>Move</span>
    </div>
  );
}

function BindingChip({
  action,
  binding,
  label,
  isListening,
  onStartListen,
}: {
  action: BindableAction;
  binding: string;
  label: string;
  isListening: boolean;
  onStartListen: (a: BindableAction) => void;
}): ReactElement {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "5px" }}>
      <button
        type="button"
        aria-label={`Bind ${label} button (current: ${binding})`}
        onClick={() => onStartListen(action)}
        style={{
          ...KBD_STYLE,
          cursor: "pointer",
          background: isListening ? "var(--sb-c2)" : "rgba(255,255,255,0.07)",
          color: isListening ? "var(--sb-c0)" : "var(--sb-c3)",
          borderColor: isListening ? "var(--sb-c2)" : "rgba(255,255,255,0.04)",
          transition: "all 150ms ease-out",
        }}
      >
        {isListening ? "···" : displayKey(binding)}
      </button>
      <span style={{ fontSize: "11px", opacity: 0.65 }}>{label}</span>
    </div>
  );
}

function ActionKeysRow({
  bindings,
  listening,
  onStartListen,
}: {
  bindings: KeyBindings;
  listening: BindableAction | null;
  onStartListen: (a: BindableAction) => void;
}): ReactElement {
  // Order matches GB hardware: B left, A right; Start and Select on the
  // far right. Action keys are user-rebindable; arrows are not (D-pad is
  // universal across emulators).
  const items: { action: BindableAction; label: string }[] = [
    { action: "b", label: "B" },
    { action: "a", label: "A" },
    { action: "start", label: "Start" },
    { action: "select", label: "Sel" },
  ];
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "6px 16px",
        gap: "6px",
        flexWrap: "wrap",
        rowGap: "8px",
      }}
    >
      {items.map(({ action, label }) => (
        <BindingChip
          key={action}
          action={action}
          binding={bindings[action]}
          label={label}
          isListening={listening === action}
          onStartListen={onStartListen}
        />
      ))}
    </div>
  );
}

function AgentRow({
  agent,
  connected,
  onToggle,
}: {
  agent: Agent;
  connected: boolean;
  onToggle: () => void;
}): ReactElement {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={`${connected ? "Disconnect" : "Connect"} ${AGENT_LABELS[agent]}`}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "12px",
        width: "100%",
        padding: "10px 16px",
        background: "transparent",
        border: "none",
        color: "var(--sb-c3)",
        cursor: "pointer",
        textAlign: "left",
      }}
      onMouseEnter={(e) =>
        (e.currentTarget.style.background = "rgba(255,255,255,0.06)")
      }
      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
    >
      <Bot size={17} strokeWidth={2} />
      <span style={{ flex: 1, fontSize: "12.5px" }}>{AGENT_LABELS[agent]}</span>
      <span
        style={{
          ...STATUS_PILL_BASE,
          background: connected ? "var(--sb-c2)" : "rgba(255,255,255,0.07)",
          color: connected ? "var(--sb-c0)" : "rgba(226,243,228,0.65)",
        }}
      >
        {connected ? "On" : "Off"}
      </span>
    </button>
  );
}

function DetectionSection({
  status,
  onToggleAgent,
}: {
  status: AgentStatus;
  onToggleAgent: (agent: Agent, enabled: boolean) => void;
}): ReactElement {
  const detected: Agent[] = [];
  if (status.claude.detected) detected.push("claude");
  if (status.cursor.detected) detected.push("cursor");

  return (
    <>
      <div style={SECTION_LABEL_STYLE}>Detection</div>
      {detected.length === 0 ? (
        <div
          style={{
            padding: "4px 16px 6px",
            fontSize: "11.5px",
            opacity: 0.6,
            lineHeight: 1.45,
          }}
        >
          No supported agents detected. Install Claude Code or run Standboy
          inside Cursor to enable auto-show.
        </div>
      ) : (
        detected.map((agent) => (
          <AgentRow
            key={agent}
            agent={agent}
            connected={status[agent].connected}
            onToggle={() => onToggleAgent(agent, !status[agent].connected)}
          />
        ))
      )}
    </>
  );
}

function ActionItem({
  spec,
  onClick,
}: {
  spec: ActionSpec;
  onClick: () => void;
}): ReactElement {
  const Icon = spec.icon;
  return (
    <button
      type="button"
      disabled={!spec.enabled}
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "12px",
        width: "100%",
        padding: "10px 16px",
        textAlign: "left",
        fontSize: "12.5px",
        color: "var(--sb-c3)",
        background: "transparent",
        border: "none",
        cursor: spec.enabled ? "pointer" : "not-allowed",
        opacity: spec.enabled ? 1 : 0.4,
      }}
      onMouseEnter={(e) => {
        if (spec.enabled)
          e.currentTarget.style.background = "rgba(255,255,255,0.06)";
      }}
      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
    >
      <Icon size={17} strokeWidth={2} />
      <span style={{ flex: 1 }}>{spec.label}</span>
    </button>
  );
}

function Menu({
  hasRom,
  muted,
  bindings,
  listening,
  agentStatus,
  autoShow,
  onStartListen,
  onToggleMute,
  onToggleAgent,
  onToggleAutoShow,
  onClose,
}: {
  hasRom: boolean;
  muted: boolean;
  bindings: KeyBindings;
  listening: BindableAction | null;
  agentStatus: AgentStatus;
  autoShow: boolean;
  onStartListen: (a: BindableAction) => void;
  onToggleMute: () => void;
  onToggleAgent: (agent: Agent, enabled: boolean) => void;
  onToggleAutoShow: (enabled: boolean) => void;
  onClose: () => void;
}): ReactElement {
  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, [onClose]);

  const libraryActions: ActionSpec[] = [
    { label: "Load ROM…", action: "loadRom", enabled: true, icon: Plus },
    {
      label: "Open library folder",
      action: "openLibraryFolder",
      enabled: true,
      icon: FolderOpen,
    },
    {
      label: "Delete ROM…",
      action: "deleteRom",
      enabled: true,
      icon: Trash2,
    },
  ];
  const saveActions: ActionSpec[] = [
    {
      label: "Export save…",
      action: "exportSave",
      enabled: hasRom,
      icon: Download,
    },
    {
      label: "Import save…",
      action: "importSave",
      enabled: hasRom,
      icon: Upload,
    },
  ];
  const diagnosticsActions: ActionSpec[] = [
    {
      label: "Show logs",
      action: "showLogs",
      enabled: true,
      icon: ScrollText,
    },
  ];

  const renderAction = (spec: ActionSpec): ReactElement => (
    <ActionItem
      key={spec.action}
      spec={spec}
      onClick={() => {
        // Force-capture SRAM before any disk-touching save action.
        // The save message rides ahead of the menu message in the same
        // channel, and the extension's serialized queue guarantees the
        // write completes before the export/import command reads the
        // save file from disk.
        if (spec.action === "exportSave" || spec.action === "importSave") {
          window.__standboyFlushSave?.();
        }
        send({ kind: "menu", action: spec.action });
        onClose();
      }}
    />
  );

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 50 }}>
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          maxHeight: "100%",
          background: "var(--sb-c0)",
          borderRadius: "0 0 22px 22px",
          overflowY: "auto",
          overflowX: "hidden",
          boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
          paddingBottom: "20px",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "12px 10px 18px 16px",
          }}
        >
          <span
            style={{
              fontSize: "11px",
              letterSpacing: "0.2em",
              textTransform: "uppercase",
              fontWeight: 600,
              opacity: 0.95,
              color: "var(--sb-c3)",
            }}
          >
            Menu
          </span>
          <button
            type="button"
            aria-label="Close"
            onClick={(e) => {
              e.stopPropagation();
              onClose();
            }}
            style={{
              width: "28px",
              height: "28px",
              borderRadius: "6px",
              background: "transparent",
              border: "none",
              cursor: "pointer",
              color: "rgba(226,243,228,0.65)",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              transition: "all 150ms ease-out",
              padding: 0,
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = "rgba(255,255,255,0.06)";
              e.currentTarget.style.color = "var(--sb-c3)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "transparent";
              e.currentTarget.style.color = "rgba(226,243,228,0.65)";
            }}
          >
            <X size={16} strokeWidth={2} />
          </button>
        </div>

        <div style={SECTION_LABEL_STYLE}>Audio</div>
        <button
          type="button"
          onClick={onToggleMute}
          style={{
            display: "flex",
            alignItems: "center",
            gap: "12px",
            width: "100%",
            padding: "10px 16px",
            background: "transparent",
            border: "none",
            color: "var(--sb-c3)",
            cursor: "pointer",
            textAlign: "left",
          }}
          onMouseEnter={(e) =>
            (e.currentTarget.style.background = "rgba(255,255,255,0.06)")
          }
          onMouseLeave={(e) =>
            (e.currentTarget.style.background = "transparent")
          }
        >
          {muted ? (
            <VolumeX size={17} strokeWidth={2} />
          ) : (
            <Volume2 size={17} strokeWidth={2} />
          )}
          <span style={{ flex: 1, fontSize: "12.5px" }}>Sound</span>
          <span
            style={{
              ...STATUS_PILL_BASE,
              background: muted ? "rgba(255,255,255,0.07)" : "var(--sb-c2)",
              color: muted ? "rgba(226,243,228,0.65)" : "var(--sb-c0)",
            }}
          >
            {muted ? "Off" : "On"}
          </span>
        </button>

        <MenuSpacer />

        <div style={SECTION_LABEL_STYLE}>Controls</div>
        <ArrowsRow />
        <ActionKeysRow
          bindings={bindings}
          listening={listening}
          onStartListen={onStartListen}
        />

        <MenuSpacer />

        <div style={SECTION_LABEL_STYLE}>Auto-show</div>
        <button
          type="button"
          onClick={() => onToggleAutoShow(!autoShow)}
          aria-label={`Turn auto-show ${autoShow ? "off" : "on"}`}
          style={{
            display: "flex",
            alignItems: "center",
            gap: "12px",
            width: "100%",
            padding: "10px 16px",
            background: "transparent",
            border: "none",
            color: "var(--sb-c3)",
            cursor: "pointer",
            textAlign: "left",
          }}
          onMouseEnter={(e) =>
            (e.currentTarget.style.background = "rgba(255,255,255,0.06)")
          }
          onMouseLeave={(e) =>
            (e.currentTarget.style.background = "transparent")
          }
        >
          <Eye size={17} strokeWidth={2} />
          <span style={{ flex: 1, fontSize: "12.5px" }}>
            Auto-expand during agent activity
          </span>
          <span
            style={{
              ...STATUS_PILL_BASE,
              background: autoShow ? "var(--sb-c2)" : "rgba(255,255,255,0.07)",
              color: autoShow ? "var(--sb-c0)" : "rgba(226,243,228,0.65)",
            }}
          >
            {autoShow ? "On" : "Off"}
          </span>
        </button>

        <MenuSpacer />

        <DetectionSection status={agentStatus} onToggleAgent={onToggleAgent} />

        <MenuSpacer />

        <div style={SECTION_LABEL_STYLE}>Library</div>
        {libraryActions.map(renderAction)}

        <MenuSpacer />

        <div style={SECTION_LABEL_STYLE}>Save data</div>
        {saveActions.map(renderAction)}

        <MenuSpacer />

        <div style={SECTION_LABEL_STYLE}>Diagnostics</div>
        {diagnosticsActions.map(renderAction)}
      </div>
    </div>
  );
}

export function App(): ReactElement {
  const [activity, setActivity] = useState<ActivityState>("idle");
  const [rom, setRom] = useState<Rom | null>(null);
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [loaderUrl, setLoaderUrl] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  // Default unmuted to match what EmulatorJS actually does — its boot
  // sequence resumes audio at its built-in default volume regardless of
  // EJS_volume once the canvas receives a user gesture. Starting muted=true
  // made the menu's Sound pill say "Off" while audio was already playing.
  const [muted, setMuted] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  // closingMs null hides the bar; a number triggers the CSS shrink animation.
  // closingKey bumps every time we start a fresh countdown so React remounts
  // the element and the animation restarts cleanly.
  const [closingMs, setClosingMs] = useState<number | null>(null);
  const [closingKey, setClosingKey] = useState(0);
  const [library, setLibrary] = useState<LibraryEntry[]>([]);
  const [bindings, setBindings] = useState<KeyBindings>(DEFAULT_BINDINGS);
  const [listening, setListening] = useState<BindableAction | null>(null);
  const [agentStatus, setAgentStatus] =
    useState<AgentStatus>(EMPTY_AGENT_STATUS);
  // Default true matches the host-side default — the value gets corrected
  // by the host's `autoShow` message after `ready` lands.
  const [autoShow, setAutoShow] = useState(true);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    send({ kind: "ready" });
    return onMessage((msg) => {
      switch (msg.kind) {
        case "init":
          setDataUrl(msg.emulatorDataUrl);
          setLoaderUrl(msg.emulatorLoaderUrl);
          break;
        case "palette":
          applyPalette(msg.palette);
          break;
        case "activity":
          setActivity(msg.state);
          break;
        case "rom":
          setRom({
            hash: msg.hash,
            romUri: msg.romUri,
            ext: msg.ext,
            name: msg.name,
            displayName: msg.displayName,
            save: msg.save,
          });
          break;
        case "library":
          setLibrary(msg.entries);
          break;
        case "coverUpdate":
          setLibrary((prev) =>
            prev.map((e) =>
              e.hash === msg.hash ? { ...e, coverUri: msg.coverUri } : e
            )
          );
          break;
        case "bindings":
          setBindings(msg.bindings);
          break;
        case "agentStatus":
          setAgentStatus(msg.status);
          break;
        case "autoShow":
          setAutoShow(msg.enabled);
          break;
        case "closingTimer":
          setClosingMs(msg.durationMs);
          if (msg.durationMs !== null) setClosingKey((k) => k + 1);
          break;
        case "reload":
          // Hard reload — the only reliable way to swap the running ROM.
          // EmulatorJS has no teardown, so a soft remount of EmulatorHost
          // would leave the old game running.
          location.reload();
          break;
      }
    });
  }, []);

  useEffect(() => {
    if (!focused) return;
    const handler = (e: KeyboardEvent) => {
      if (GAME_KEYS.has(e.key)) e.preventDefault();
    };
    window.addEventListener("keydown", handler, { capture: true });
    return () =>
      window.removeEventListener("keydown", handler, { capture: true });
  }, [focused]);

  // If the user closes the menu mid-bind, drop them out of listening mode
  // so the next open doesn't immediately capture their keystroke.
  useEffect(() => {
    if (!menuOpen) setListening(null);
  }, [menuOpen]);

  // Capture the next keystroke as the new binding for the action being
  // listened to. Capture phase + stopPropagation so it wins over every
  // other key handler (menu Escape, EmulatorJS canvas, etc.).
  useEffect(() => {
    if (!listening) return;
    const handler = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setListening(null);
        return;
      }
      if (e.key === "Dead" || e.key === "Process") return;
      setBindings((prev) => {
        const next: KeyBindings = { ...prev };
        // If the new key was already bound to another action, swap rather
        // than orphan it — keeps a 1:1 mapping.
        for (const a of BINDABLE_ACTIONS) {
          if (a !== listening && next[a] === e.key) {
            next[a] = prev[listening];
          }
        }
        next[listening] = e.key;
        send({ kind: "saveBindings", bindings: next });
        return next;
      });
      setListening(null);
    };
    window.addEventListener("keydown", handler, { capture: true });
    return () =>
      window.removeEventListener("keydown", handler, { capture: true });
  }, [listening]);

  // Drive A/B/Start/Select directly via gameManager.simulateInput, bypassing
  // EmulatorJS's keyboard layer entirely. Arrow keys still go through
  // EmulatorJS's native handler — they're not in BINDABLE_ACTIONS.
  // Capture-phase + preventDefault prevents EmulatorJS's parent-element
  // listener from also seeing the key, so even a default binding (Z=A) is
  // processed exactly once, by us.
  useEffect(() => {
    if (listening) return;
    const press = (e: KeyboardEvent, value: 0 | 1) => {
      if (e.repeat) return;
      const incoming = normalizeKey(e.key);
      for (const action of BINDABLE_ACTIONS) {
        if (normalizeKey(bindings[action]) === incoming) {
          e.preventDefault();
          e.stopPropagation();
          window.EJS_emulator?.gameManager?.simulateInput?.(
            0,
            BUTTON_INDEX_FOR_ACTION[action],
            value
          );
          break;
        }
      }
    };
    const onDown = (e: KeyboardEvent) => press(e, 1);
    const onUp = (e: KeyboardEvent) => press(e, 0);
    window.addEventListener("keydown", onDown, { capture: true });
    window.addEventListener("keyup", onUp, { capture: true });
    return () => {
      window.removeEventListener("keydown", onDown, { capture: true });
      window.removeEventListener("keyup", onUp, { capture: true });
    };
  }, [bindings, listening]);

  const currentEntry = rom ? library.find((e) => e.hash === rom.hash) : null;

  return (
    <div
      ref={rootRef}
      tabIndex={0}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={{
        // color-mix is supported in every Chromium VSCode ships; 28% black
        // mix reads as a different surface against any palette without
        // going jet black on the cool ones.
        height: "100%",
        display: "flex",
        flexDirection: "column",
        background: "color-mix(in srgb, var(--sb-c0) 72%, black)",
        color: "var(--sb-c3)",
        outline: "none",
      }}
    >
      <div
        style={{
          position: "relative",
          flexShrink: 0,
          background: "var(--sb-c0)",
          backgroundImage:
            "radial-gradient(ellipse at top, rgba(70,135,143,0.08), transparent 60%)",
          borderRadius: "0 0 22px 22px",
          paddingBottom: "18px",
          boxShadow: "0 6px 18px rgba(0,0,0,0.18)",
        }}
      >
        {closingMs !== null && (
          // key={closingKey} forces a remount whenever a new countdown
          // starts so the CSS animation restarts cleanly instead of
          // resuming partway.
          <div
            key={closingKey}
            aria-hidden
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              height: "2px",
              background: "var(--sb-c2)",
              boxShadow: "0 0 4px var(--sb-c2)",
              animation: `sb-countdown-shrink ${closingMs}ms linear forwards`,
            }}
          />
        )}
        <header
          style={{
            display: "flex",
            alignItems: "center",
            gap: "10px",
            padding: "12px 14px 10px",
          }}
        >
          <StandbyDot state={activity} />
          <span
            title={rom?.name}
            style={{
              flex: 1,
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              fontSize: "11px",
              letterSpacing: "0.14em",
              textTransform: "uppercase",
              opacity: 0.9,
            }}
          >
            {rom ? truncate(rom.displayName) : "Standboy"}
          </span>
          <HeaderButton label="Menu" onClick={() => setMenuOpen(true)}>
            <HamburgerIcon />
          </HeaderButton>
        </header>

        <div style={{ padding: "0 14px" }}>
          <EmulatorHost
            rom={rom}
            dataUrl={dataUrl}
            loaderUrl={loaderUrl}
            muted={muted}
          />
        </div>

        {rom && (
          <div style={{ padding: "14px 16px 0" }}>
            <div
              style={{
                fontSize: "14px",
                fontWeight: 600,
                marginBottom: "3px",
                letterSpacing: "-0.01em",
              }}
            >
              {rom.displayName}
            </div>
            <div
              style={{
                fontSize: "10.5px",
                opacity: 0.5,
                display: "flex",
                alignItems: "center",
                gap: "6px",
              }}
            >
              <span>{rom.ext.toUpperCase()}</span>
              {currentEntry && (
                <>
                  <span
                    style={{
                      display: "inline-block",
                      width: "2.5px",
                      height: "2.5px",
                      borderRadius: "50%",
                      background: "currentColor",
                      opacity: 0.6,
                    }}
                  />
                  <span>
                    Last played {currentEntry.lastPlayedAt.slice(0, 10)}
                  </span>
                </>
              )}
            </div>
          </div>
        )}
      </div>

      <LibraryGrid
        entries={library}
        currentHash={rom?.hash ?? null}
        onSwitchRom={(hash) => {
          // Capture the running game's SRAM before the host triggers a
          // reload — otherwise the in-progress session's last few seconds
          // of play vanish from disk (still in IDBFS, but our portable
          // mirror would be stale).
          window.__standboyFlushSave?.();
          send({ kind: "switchRom", hash });
        }}
        onAddRom={() => send({ kind: "menu", action: "loadRom" })}
      />

      {menuOpen && (
        <Menu
          hasRom={!!rom}
          muted={muted}
          bindings={bindings}
          listening={listening}
          agentStatus={agentStatus}
          autoShow={autoShow}
          onStartListen={(a) => setListening(a)}
          onToggleMute={() => setMuted((m) => !m)}
          onToggleAutoShow={(enabled) => {
            setAutoShow(enabled);
            send({ kind: "setAutoShow", enabled });
          }}
          onToggleAgent={(agent, enabled) => {
            // Optimistic update — host echoes the real state via agentStatus
            // after the disk write completes. Mutually exclusive: turning
            // one agent on flips the other off so they never share the
            // sentinel and race each other.
            setAgentStatus((prev) => {
              const next = {
                ...prev,
                [agent]: { ...prev[agent], connected: enabled },
              };
              if (enabled) {
                const other: Agent = agent === "claude" ? "cursor" : "claude";
                next[other] = { ...prev[other], connected: false };
              }
              return next;
            });
            send({ kind: "setAgent", agent, enabled });
          }}
          onClose={() => setMenuOpen(false)}
        />
      )}
    </div>
  );
}
