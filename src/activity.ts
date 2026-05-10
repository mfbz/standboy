import type { ActivityState } from "./messages";

export interface ActivityEvent {
  uri: string;
  changeSize: number;
  timestamp: number;
}

export interface DetectorOptions {
  minChangeSize?: number;
  burstCount?: number;
  burstWindowMs?: number;
  idleTimeoutMs?: number;
  // ms to wait between sentinel touch and panel actually showing — quick
  // agent turns under this threshold never trigger a focus event.
  showDelayMs?: number;
  // ms to keep the panel up after the sentinel disappears — bridges the
  // gap between back-to-back agent turns within one conversation.
  hideDelayMs?: number;
}

const DEFAULTS: Required<DetectorOptions> = {
  minChangeSize: 5,
  burstCount: 3,
  burstWindowMs: 1500,
  idleTimeoutMs: 3000,
  // 5s on each edge: long enough that a "let me check" turn never opens
  // the panel, short enough that real work is reflected within a
  // breathing room. Tuned for actual play, not snappy reactivity.
  showDelayMs: 5000,
  hideDelayMs: 5000,
};

type Listener = (state: ActivityState) => void;

// Pure function so it can be unit-tested without the vscode namespace.
// When autoShow is false, all focus shifts are suppressed (the activity
// dot in the header still pulses on state changes — see app.tsx — so
// the user can see "agent is working" without being pulled into the panel).
export type FocusIntent = "expand" | "collapse" | null;
export function focusIntentFor(
  state: ActivityState,
  autoShow: boolean
): FocusIntent {
  if (!autoShow) return null;
  return state === "active" ? "expand" : "collapse";
}

export interface PendingHide {
  durationMs: number;
}

type ScheduleListener = (pending: PendingHide | null) => void;

// Activity is an OR over two independent signals:
//   - burst: edit-burst heuristic fed by observe() from the document-change
//     handler. Self-resets after idleTimeoutMs. Fallback when no hooks installed.
//   - override: sentinel-file boolean set by setOverride() from the agent-hooks
//     integration. Authoritative when present, but each edge is debounced
//     (showDelayMs / hideDelayMs) so trivial agent turns don't strobe the panel.
// Either signal active → state is "active". Both inactive → "idle".
export class ActivityDetector {
  private opts: Required<DetectorOptions>;
  private buffer: number[] = [];
  private current: ActivityState = "idle";
  private burstActive = false;

  // Override has both a target (latest sentinel state) and an actual
  // (debounced state we feed into recompute). A rapid start→stop within
  // the show delay window cancels the show with no visible event.
  private overrideTarget = false;
  private overrideActual = false;
  private overrideTransitionTimer: ReturnType<typeof setTimeout> | null = null;

  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private listeners: Set<Listener> = new Set();
  private scheduleListeners: Set<ScheduleListener> = new Set();

  constructor(options: DetectorOptions = {}) {
    this.opts = { ...DEFAULTS, ...options };
  }

  get state(): ActivityState {
    return this.current;
  }

  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // Fires with { durationMs } when a hide is scheduled, with null when
  // cancelled (sentinel reappeared) or completes. Drives the UI countdown.
  onSchedule(listener: ScheduleListener): () => void {
    this.scheduleListeners.add(listener);
    return () => this.scheduleListeners.delete(listener);
  }

  observe(event: ActivityEvent): void {
    if (!event.uri.startsWith("file:")) return;
    if (event.changeSize < this.opts.minChangeSize) return;

    const cutoff = event.timestamp - this.opts.burstWindowMs;
    this.buffer = this.buffer.filter((t) => t >= cutoff);
    this.buffer.push(event.timestamp);

    if (this.buffer.length >= this.opts.burstCount) {
      this.burstActive = true;
      this.armIdleTimer();
      this.recompute();
    } else if (this.burstActive) {
      this.armIdleTimer();
    }
  }

  // Both edges debounced: a 5-second start→stop cycle within the window
  // never visibly shows the panel; back-to-back stop→start cycles within
  // the window keep the panel up uninterrupted.
  setOverride(active: boolean): void {
    if (this.overrideTarget === active) return;
    this.overrideTarget = active;

    if (this.overrideTransitionTimer) {
      clearTimeout(this.overrideTransitionTimer);
      this.overrideTransitionTimer = null;
    }

    if (this.overrideActual === active) {
      // Cancelled a pending transition mid-flight and target now agrees
      // with what's already on screen. Only "cancelled a pending hide"
      // needs a UI side-effect: clear the countdown bar.
      if (active) this.emitSchedule(null);
      return;
    }

    const delay = active ? this.opts.showDelayMs : this.opts.hideDelayMs;

    // Shows don't get a countdown — no need for a "panel will appear in 5s" announcement.
    if (!active) {
      this.emitSchedule({ durationMs: delay });
    }

    this.overrideTransitionTimer = setTimeout(() => {
      this.overrideTransitionTimer = null;
      this.overrideActual = active;
      if (!active) this.emitSchedule(null);
      this.recompute();
    }, delay);
  }

  dispose(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.overrideTransitionTimer)
      clearTimeout(this.overrideTransitionTimer);
    this.idleTimer = null;
    this.overrideTransitionTimer = null;
    this.listeners.clear();
    this.scheduleListeners.clear();
  }

  private armIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      this.buffer = [];
      this.burstActive = false;
      this.recompute();
    }, this.opts.idleTimeoutMs);
  }

  private recompute(): void {
    const next: ActivityState =
      this.burstActive || this.overrideActual ? "active" : "idle";
    if (this.current === next) return;
    this.current = next;
    for (const l of this.listeners) l(next);
  }

  private emitSchedule(pending: PendingHide | null): void {
    for (const l of this.scheduleListeners) l(pending);
  }
}
