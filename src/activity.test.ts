import { describe, it, expect, beforeEach, vi } from "vitest";
import { ActivityDetector, focusIntentFor } from "./activity";

describe("focusIntentFor (autoShow gate)", () => {
  it("suppresses every focus shift when autoShow is off", () => {
    expect(focusIntentFor("active", false)).toBeNull();
    expect(focusIntentFor("idle", false)).toBeNull();
  });

  it("expands the panel on active, collapses on idle when autoShow is on", () => {
    expect(focusIntentFor("active", true)).toBe("expand");
    expect(focusIntentFor("idle", true)).toBe("collapse");
  });
});

describe("ActivityDetector", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("starts idle", () => {
    const d = new ActivityDetector();
    expect(d.state).toBe("idle");
  });

  it("transitions to active on a burst of multi-character changes", () => {
    const d = new ActivityDetector();
    const events: string[] = [];
    d.onChange((s) => events.push(s));

    for (let i = 0; i < 5; i++) {
      d.observe({ uri: "file:///a.ts", changeSize: 80, timestamp: i * 50 });
    }
    expect(d.state).toBe("active");
    expect(events).toEqual(["active"]);
  });

  it("ignores single-character user typing", () => {
    const d = new ActivityDetector();
    for (let i = 0; i < 20; i++) {
      d.observe({ uri: "file:///a.ts", changeSize: 1, timestamp: i * 50 });
    }
    expect(d.state).toBe("idle");
  });

  it("transitions back to idle after the idle timeout", () => {
    const d = new ActivityDetector({ idleTimeoutMs: 3000 });
    const events: string[] = [];
    d.onChange((s) => events.push(s));

    for (let i = 0; i < 5; i++) {
      d.observe({ uri: "file:///a.ts", changeSize: 80, timestamp: i * 50 });
    }
    expect(d.state).toBe("active");

    vi.advanceTimersByTime(3500);
    expect(d.state).toBe("idle");
    expect(events).toEqual(["active", "idle"]);
  });

  it("does not flap when changes resume within the idle window", () => {
    const d = new ActivityDetector({ idleTimeoutMs: 3000 });
    const events: string[] = [];
    d.onChange((s) => events.push(s));

    for (let i = 0; i < 5; i++) {
      d.observe({ uri: "file:///a.ts", changeSize: 80, timestamp: i * 50 });
    }
    vi.advanceTimersByTime(2000);
    d.observe({ uri: "file:///a.ts", changeSize: 80, timestamp: 2500 });
    vi.advanceTimersByTime(2000);

    expect(d.state).toBe("active");
    expect(events).toEqual(["active"]);
  });

  it("ignores non-file URIs", () => {
    const d = new ActivityDetector();
    for (let i = 0; i < 5; i++) {
      d.observe({
        uri: "output:Standboy",
        changeSize: 200,
        timestamp: i * 50,
      });
    }
    expect(d.state).toBe("idle");
  });

  // OR-logic tests use 0-ms delays to test the merge semantics in
  // isolation. Delay tests live in the separate "transition delays"
  // block below.
  const NO_DELAY = { showDelayMs: 0, hideDelayMs: 0 };

  describe("override signal (sentinel-driven)", () => {
    it("flips to active when override is set", () => {
      const d = new ActivityDetector(NO_DELAY);
      const events: string[] = [];
      d.onChange((s) => events.push(s));
      d.setOverride(true);
      vi.runAllTimers();
      expect(d.state).toBe("active");
      expect(events).toEqual(["active"]);
    });

    it("returns to idle when override is cleared and burst is inactive", () => {
      const d = new ActivityDetector(NO_DELAY);
      const events: string[] = [];
      d.onChange((s) => events.push(s));
      d.setOverride(true);
      vi.runAllTimers();
      d.setOverride(false);
      vi.runAllTimers();
      expect(d.state).toBe("idle");
      expect(events).toEqual(["active", "idle"]);
    });

    it("setting the same override value twice is a no-op (no duplicate events)", () => {
      const d = new ActivityDetector(NO_DELAY);
      const events: string[] = [];
      d.onChange((s) => events.push(s));
      d.setOverride(true);
      d.setOverride(true);
      vi.runAllTimers();
      d.setOverride(false);
      d.setOverride(false);
      vi.runAllTimers();
      expect(events).toEqual(["active", "idle"]);
    });

    it("override + burst OR together — burst expiry doesn't drop us if override is still set", () => {
      const d = new ActivityDetector(NO_DELAY);
      const events: string[] = [];
      d.onChange((s) => events.push(s));

      d.setOverride(true);
      vi.runAllTimers();
      // Burst also fires; same state, no extra event.
      for (let i = 0; i < 5; i++) {
        d.observe({ uri: "file:///a.ts", changeSize: 80, timestamp: i * 50 });
      }
      // Burst's idle timer expires.
      vi.advanceTimersByTime(5000);

      // Still active because override is still true.
      expect(d.state).toBe("active");
      expect(events).toEqual(["active"]);
    });

    it("override clearing while burst is active stays active", () => {
      const d = new ActivityDetector(NO_DELAY);
      const events: string[] = [];
      d.onChange((s) => events.push(s));

      d.setOverride(true);
      vi.runAllTimers();
      for (let i = 0; i < 5; i++) {
        d.observe({ uri: "file:///a.ts", changeSize: 80, timestamp: i * 50 });
      }
      // Override goes away (hook deleted sentinel) but burst is still alive.
      d.setOverride(false);
      // Advance just past the (zero) hide delay; do NOT fire the 3s burst
      // idle timer, which is what we want to confirm is still pinning state.
      vi.advanceTimersByTime(1);
      expect(d.state).toBe("active");
      expect(events).toEqual(["active"]);

      // Now the burst's idle timer expires — *now* we drop to idle.
      vi.advanceTimersByTime(5000);
      expect(d.state).toBe("idle");
      expect(events).toEqual(["active", "idle"]);
    });
  });

  describe("transition delays (anti-flicker)", () => {
    it("show is delayed by showDelayMs", () => {
      const d = new ActivityDetector({ showDelayMs: 5000, hideDelayMs: 5000 });
      const events: string[] = [];
      d.onChange((s) => events.push(s));

      d.setOverride(true);
      // Halfway through delay — still idle, no event yet.
      vi.advanceTimersByTime(2500);
      expect(d.state).toBe("idle");
      expect(events).toEqual([]);

      // Past the delay — now active.
      vi.advanceTimersByTime(2600);
      expect(d.state).toBe("active");
      expect(events).toEqual(["active"]);
    });

    it("hide is delayed by hideDelayMs", () => {
      const d = new ActivityDetector({ showDelayMs: 0, hideDelayMs: 5000 });
      const events: string[] = [];
      d.onChange((s) => events.push(s));

      d.setOverride(true);
      vi.runAllTimers();
      d.setOverride(false);

      // Halfway through hide delay — still active.
      vi.advanceTimersByTime(2500);
      expect(d.state).toBe("active");

      // Past the delay — now idle.
      vi.advanceTimersByTime(2600);
      expect(d.state).toBe("idle");
      expect(events).toEqual(["active", "idle"]);
    });

    it("rapid start→stop within the show window never flips to active", () => {
      const d = new ActivityDetector({ showDelayMs: 5000, hideDelayMs: 5000 });
      const events: string[] = [];
      d.onChange((s) => events.push(s));

      d.setOverride(true);
      vi.advanceTimersByTime(1000); // 1s into 5s show delay
      d.setOverride(false);
      vi.runAllTimers();

      expect(d.state).toBe("idle");
      expect(events).toEqual([]); // never visibly transitioned
    });

    it("ping mid-show resets the show timer (restart-from-zero, not resume)", () => {
      // Sequence: setOverride(true) → 2s → setOverride(false) → 1s →
      // setOverride(true). The original 5s show timer was abandoned;
      // the new one must run a fresh 5s from the third call. Total
      // elapsed when actual=true: 2 + 1 + 5 = 8s. A buggy "resume from
      // 2s elapsed" implementation would fire actual=true at ~6s.
      const d = new ActivityDetector({ showDelayMs: 5000, hideDelayMs: 5000 });
      const events: string[] = [];
      d.onChange((s) => events.push(s));

      d.setOverride(true);
      vi.advanceTimersByTime(2000);
      d.setOverride(false);
      vi.advanceTimersByTime(1000);
      d.setOverride(true);

      // 6s after the original setOverride(true) — should still be idle
      // because the *new* show timer has only 4s of runtime.
      vi.advanceTimersByTime(3500);
      expect(d.state).toBe("idle");
      expect(events).toEqual([]);

      // 8s after original — the fresh show timer has now elapsed.
      vi.advanceTimersByTime(2000);
      expect(d.state).toBe("active");
      expect(events).toEqual(["active"]);
    });

    it("rapid stop→start within the hide window keeps the panel up uninterrupted", () => {
      const d = new ActivityDetector({ showDelayMs: 0, hideDelayMs: 5000 });
      const events: string[] = [];
      d.onChange((s) => events.push(s));

      d.setOverride(true);
      vi.runAllTimers();
      d.setOverride(false);
      vi.advanceTimersByTime(2000); // 2s into 5s hide delay
      d.setOverride(true); // back in business
      vi.advanceTimersByTime(10000); // any future time

      expect(d.state).toBe("active");
      expect(events).toEqual(["active"]); // single transition, no flicker
    });

    it("emits a scheduled-hide event with durationMs when hide is queued", () => {
      const d = new ActivityDetector({ showDelayMs: 0, hideDelayMs: 4321 });
      const schedule: Array<{ durationMs: number } | null> = [];
      d.onSchedule((s) => schedule.push(s));

      d.setOverride(true);
      vi.runAllTimers();
      schedule.length = 0; // ignore activation noise

      d.setOverride(false);
      // Scheduled hide announced immediately.
      expect(schedule).toEqual([{ durationMs: 4321 }]);

      // After the hide actually fires, we get a null to clear the UI.
      vi.runAllTimers();
      expect(schedule).toEqual([{ durationMs: 4321 }, null]);
    });

    it("cancelling a pending hide emits null to clear the countdown", () => {
      const d = new ActivityDetector({ showDelayMs: 0, hideDelayMs: 5000 });
      const schedule: Array<{ durationMs: number } | null> = [];
      d.onSchedule((s) => schedule.push(s));

      d.setOverride(true);
      vi.runAllTimers();
      schedule.length = 0;

      d.setOverride(false);
      vi.advanceTimersByTime(2000);
      d.setOverride(true); // cancel the hide

      expect(schedule).toContainEqual({ durationMs: 5000 });
      expect(schedule[schedule.length - 1]).toBeNull();
    });
  });
});
