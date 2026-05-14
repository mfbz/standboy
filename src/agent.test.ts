import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  STALE_THRESHOLD_MS,
  cleanupStaleSentinel,
  parseSentinelContent,
  watchSentinel,
} from "./agent";

async function makeTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "standboy-agent-"));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("parseSentinelContent", () => {
  it("parses new prompt-kind format", () => {
    expect(parseSentinelContent("prompt:1234")).toEqual({
      kind: "prompt",
      ts: 1234,
    });
  });

  it("parses new tool-kind format", () => {
    expect(parseSentinelContent("tool:5678")).toEqual({
      kind: "tool",
      ts: 5678,
    });
  });

  it("falls back to legacy when kind is unrecognized", () => {
    expect(parseSentinelContent("other:9999")).toEqual({
      kind: "legacy",
      ts: 9999,
    });
  });

  it("parses legacy bare-timestamp format", () => {
    expect(parseSentinelContent("9999")).toEqual({ kind: "legacy", ts: 9999 });
  });

  it("returns null for malformed content", () => {
    expect(parseSentinelContent("garbage")).toBeNull();
    expect(parseSentinelContent("prompt:")).toBeNull();
    expect(parseSentinelContent("")).toBeNull();
  });
});

describe("cleanupStaleSentinel", () => {
  let tmp: string;
  let file: string;

  beforeEach(async () => {
    tmp = await makeTmpDir();
    file = path.join(tmp, "agent-active");
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("is a no-op when no sentinel exists", async () => {
    expect(await cleanupStaleSentinel(Date.now(), file)).toBe(false);
  });

  it("removes a sentinel whose recorded timestamp is older than the threshold", async () => {
    const start = Date.now();
    await fs.writeFile(file, `tool:${start - STALE_THRESHOLD_MS - 1000}`);
    expect(await cleanupStaleSentinel(start, file)).toBe(true);
    expect(fsSync.existsSync(file)).toBe(false);
  });

  it("preserves a sentinel that is still fresh", async () => {
    const start = Date.now();
    await fs.writeFile(file, `prompt:${start - 1000}`);
    expect(await cleanupStaleSentinel(start, file)).toBe(false);
    expect(fsSync.existsSync(file)).toBe(true);
  });

  it("reads legacy bare-timestamp sentinels", async () => {
    const start = Date.now();
    await fs.writeFile(file, String(start - STALE_THRESHOLD_MS - 1000));
    expect(await cleanupStaleSentinel(start, file)).toBe(true);
    expect(fsSync.existsSync(file)).toBe(false);
  });

  it("falls back to mtime when contents are malformed", async () => {
    await fs.writeFile(file, "not-a-number");
    // Just-written file: mtime is now, so it shouldn't be considered stale.
    expect(await cleanupStaleSentinel(Date.now(), file)).toBe(false);
    expect(fsSync.existsSync(file)).toBe(true);
  });
});

describe("watchSentinel", () => {
  let tmp: string;
  let file: string;

  beforeEach(async () => {
    tmp = await makeTmpDir();
    file = path.join(tmp, "agent-active");
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("emits the initial absent state once after construction", async () => {
    const events: boolean[] = [];
    const w = watchSentinel(
      { onChange: (active) => events.push(active) },
      { dir: tmp }
    );
    // Allow the async initial check to flush.
    await sleep(100);
    expect(events).toEqual([false]);
    w.dispose();
  });

  it("emits initial present state when the sentinel exists at start", async () => {
    await fs.writeFile(file, `prompt:${Date.now()}`);
    const events: boolean[] = [];
    const w = watchSentinel(
      { onChange: (active) => events.push(active) },
      { dir: tmp }
    );
    await sleep(100);
    expect(events).toEqual([true]);
    w.dispose();
  });

  it("fires on create and delete transitions, once each", async () => {
    const events: boolean[] = [];
    const w = watchSentinel(
      { onChange: (active) => events.push(active) },
      { dir: tmp }
    );
    await sleep(100);
    expect(events).toEqual([false]);

    await fs.writeFile(file, `prompt:${Date.now()}`);
    // Wait long enough for fs.watch to deliver the event.
    await sleep(400);
    expect(events).toEqual([false, true]);

    await fs.unlink(file);
    await sleep(400);
    expect(events).toEqual([false, true, false]);

    w.dispose();
  });

  it("does not emit duplicate events for unchanged state", async () => {
    const events: boolean[] = [];
    const w = watchSentinel(
      { onChange: (active) => events.push(active) },
      { dir: tmp }
    );
    await sleep(400);
    expect(events).toEqual([false]);
    w.dispose();
  });

  it("recovers from rewriting the same sentinel file (back-to-back agent turns)", async () => {
    const events: boolean[] = [];
    const w = watchSentinel(
      { onChange: (active) => events.push(active) },
      { dir: tmp }
    );
    await sleep(100);

    await fs.writeFile(file, `prompt:${Date.now()}`);
    await sleep(300);
    // Marker script writes the file again on the next PreToolUse —
    // sentinel still exists, state should NOT flap to false-then-true.
    await fs.writeFile(file, `tool:${Date.now()}`);
    await sleep(300);

    expect(events).toEqual([false, true]);
    w.dispose();
  });

  it("treats a stale sentinel as absent (catches interrupted agent runs)", async () => {
    // Sentinel exists but its timestamp is well past the TTL — happens
    // when the agent's Stop hook didn't fire (user interrupted).
    await fs.writeFile(file, `tool:${Date.now() - 60_000}`);
    const events: boolean[] = [];
    const w = watchSentinel(
      { onChange: (active) => events.push(active) },
      { dir: tmp, ttlMs: 1000 }
    );
    await sleep(150);
    // Even though the file exists, age (60s) > ttl (1s) → reported as absent.
    expect(events).toEqual([false]);
    w.dispose();
  });

  it("flips to absent when a previously-fresh sentinel ages past the TTL", async () => {
    const events: boolean[] = [];
    const w = watchSentinel(
      { onChange: (active) => events.push(active) },
      { dir: tmp, ttlMs: 300 }
    );
    await sleep(100);
    // Write a fresh sentinel — watcher should report active.
    await fs.writeFile(file, `tool:${Date.now()}`);
    await sleep(300);
    expect(events).toEqual([false, true]);

    // Don't write again — let the one-shot stale timer fire when the
    // recorded timestamp ages past the TTL.
    await sleep(400);
    expect(events).toEqual([false, true, false]);

    w.dispose();
  });

  it("fires onPromptPing when a fresh prompt write lands during an active run", async () => {
    const events: boolean[] = [];
    let pings = 0;
    const w = watchSentinel(
      {
        onChange: (active) => events.push(active),
        onPromptPing: () => pings++,
      },
      { dir: tmp }
    );
    await sleep(100);
    // Initial prompt — fires onChange(true), but not promptPing (we
    // were transitioning idle→active, the existing show path handles this).
    await fs.writeFile(file, `prompt:${Date.now()}`);
    await sleep(300);
    expect(events).toEqual([false, true]);
    expect(pings).toBe(0);

    // Tool refresh during active run — no promptPing, no onChange.
    await fs.writeFile(file, `tool:${Date.now()}`);
    await sleep(300);
    expect(events).toEqual([false, true]);
    expect(pings).toBe(0);

    // New user prompt arrives during the same active run — promptPing
    // fires so the extension can re-show a manually-closed panel.
    await fs.writeFile(file, `prompt:${Date.now()}`);
    await sleep(300);
    expect(events).toEqual([false, true]);
    expect(pings).toBe(1);

    w.dispose();
  });

  it("does not fire onPromptPing when transitioning from absent to prompt", async () => {
    // The idle→active edge already drives the show command via onChange;
    // firing promptPing too would be a redundant double-trigger.
    let pings = 0;
    const w = watchSentinel(
      {
        onChange: () => undefined,
        onPromptPing: () => pings++,
      },
      { dir: tmp }
    );
    await sleep(100);
    await fs.writeFile(file, `prompt:${Date.now()}`);
    await sleep(300);
    expect(pings).toBe(0);
    w.dispose();
  });

  it("recheck() picks up a state change that no event delivered", async () => {
    // Simulates a dropped fs.watch event on macOS: write the sentinel
    // without giving the watcher time to observe it via fs events,
    // dispose the watcher's fs subscription, then verify recheck()
    // surfaces the missed transition. (We can't actually force fs.watch
    // to drop, but we can verify recheck() is the recovery path.)
    const events: boolean[] = [];
    const w = watchSentinel(
      { onChange: (active) => events.push(active) },
      { dir: tmp }
    );
    await sleep(100);
    expect(events).toEqual([false]);

    // Pretend the OS dropped the create event — just check that
    // recheck() observes the file we wrote.
    await fs.writeFile(file, `prompt:${Date.now()}`);
    w.recheck();
    await sleep(100);
    expect(events).toEqual([false, true]);

    w.dispose();
  });

  it("stops firing after dispose", async () => {
    const events: boolean[] = [];
    const w = watchSentinel(
      { onChange: (active) => events.push(active) },
      { dir: tmp }
    );
    await sleep(100);
    w.dispose();

    await fs.writeFile(file, `prompt:${Date.now()}`);
    await sleep(300);
    expect(events).toEqual([false]);
  });
});
