import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  STALE_THRESHOLD_MS,
  cleanupStaleSentinel,
  watchSentinel,
} from "./agent";

async function makeTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "standboy-agent-"));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

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
    await fs.writeFile(file, String(start - STALE_THRESHOLD_MS - 1000));
    expect(await cleanupStaleSentinel(start, file)).toBe(true);
    expect(fsSync.existsSync(file)).toBe(false);
  });

  it("preserves a sentinel that is still fresh", async () => {
    const start = Date.now();
    await fs.writeFile(file, String(start - 1000));
    expect(await cleanupStaleSentinel(start, file)).toBe(false);
    expect(fsSync.existsSync(file)).toBe(true);
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
    const w = watchSentinel((active) => events.push(active), {
      dir: tmp,
      pollIntervalMs: 200,
    });
    // Allow the async initial check to flush.
    await sleep(50);
    expect(events).toEqual([false]);
    w.dispose();
  });

  it("emits initial present state when the sentinel exists at start", async () => {
    await fs.writeFile(file, String(Date.now()));
    const events: boolean[] = [];
    const w = watchSentinel((active) => events.push(active), {
      dir: tmp,
      pollIntervalMs: 200,
    });
    await sleep(50);
    expect(events).toEqual([true]);
    w.dispose();
  });

  it("fires on create and delete transitions, once each", async () => {
    const events: boolean[] = [];
    const w = watchSentinel((active) => events.push(active), {
      dir: tmp,
      pollIntervalMs: 100,
    });
    await sleep(50);
    expect(events).toEqual([false]);

    await fs.writeFile(file, String(Date.now()));
    // Wait long enough for fs.watch or the poll to pick it up.
    await sleep(400);
    expect(events).toEqual([false, true]);

    await fs.unlink(file);
    await sleep(400);
    expect(events).toEqual([false, true, false]);

    w.dispose();
  });

  it("does not emit duplicate events for unchanged state", async () => {
    const events: boolean[] = [];
    const w = watchSentinel((active) => events.push(active), {
      dir: tmp,
      // Aggressive polling — without state-change tracking we'd see
      // multiple `false` events here.
      pollIntervalMs: 50,
    });
    await sleep(400);
    expect(events).toEqual([false]);
    w.dispose();
  });

  it("recovers from rewriting the same sentinel file (back-to-back agent turns)", async () => {
    const events: boolean[] = [];
    const w = watchSentinel((active) => events.push(active), {
      dir: tmp,
      pollIntervalMs: 100,
    });
    await sleep(50);

    await fs.writeFile(file, String(Date.now()));
    await sleep(300);
    // Marker script writes the file again on the next PreToolUse —
    // sentinel still exists, state should NOT flap to false-then-true.
    await fs.writeFile(file, String(Date.now()));
    await sleep(300);

    expect(events).toEqual([false, true]);
    w.dispose();
  });

  it("stops firing after dispose", async () => {
    const events: boolean[] = [];
    const w = watchSentinel((active) => events.push(active), {
      dir: tmp,
      pollIntervalMs: 100,
    });
    await sleep(50);
    w.dispose();

    await fs.writeFile(file, String(Date.now()));
    await sleep(300);
    expect(events).toEqual([false]);
  });
});
