import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

vi.mock("vscode", () => {
  const env = { appName: "Visual Studio Code" };
  return {
    env,
    window: {
      createOutputChannel: () => ({
        appendLine: () => undefined,
        show: () => undefined,
      }),
    },
  };
});

// os.homedir() reads HOME on Unix and USERPROFILE on Windows; set both
// so the test sandbox works on every CI runner. Back up + restore after
// each test so we don't pollute later vitest workers.
const HOME_BACKUP = process.env.HOME;
const USERPROFILE_BACKUP = process.env.USERPROFILE;

describe("hooks per-agent API", () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), "standboy-hooks-"));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    (vscode.env as { appName: string }).appName = "Visual Studio Code";
    // Path constants in hooks.ts and agent.ts are computed at import time
    // from os.homedir(), so reset the module cache between tests.
    vi.resetModules();
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
    if (HOME_BACKUP === undefined) delete process.env.HOME;
    else process.env.HOME = HOME_BACKUP;
    if (USERPROFILE_BACKUP === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = USERPROFILE_BACKUP;
  });

  it("setClaudeHooks(true) creates ~/.claude/settings.json with our hooks", async () => {
    await mkdir(path.join(home, ".claude", "projects"), { recursive: true });

    const { setClaudeHooks } = await import("./hooks");
    await setClaudeHooks(true);

    const parsed = JSON.parse(
      await readFile(path.join(home, ".claude", "settings.json"), "utf8")
    );
    expect(parsed.hooks.UserPromptSubmit).toHaveLength(1);
    const promptCmd = parsed.hooks.UserPromptSubmit[0].hooks[0].command;
    expect(promptCmd).toContain("marker.cjs");
    expect(promptCmd).toContain("prompt");
    expect(parsed.hooks.PreToolUse).toHaveLength(1);
    expect(parsed.hooks.PreToolUse[0].hooks[0].command).toContain("tool");
    expect(parsed.hooks.Stop).toHaveLength(1);
    expect(parsed.hooks.Stop[0].hooks[0].command).toContain("stop");
  });

  it("setClaudeHooks(true) migrates legacy `start` commands to prompt/tool split", async () => {
    await mkdir(path.join(home, ".claude", "projects"), { recursive: true });
    const markerPath = path.join(home, ".standboy", "marker.cjs");
    // Mimic a hook config written by an older Standboy build — single
    // `start` command on both UserPromptSubmit and PreToolUse.
    const legacy = {
      hooks: {
        UserPromptSubmit: [
          {
            hooks: [{ type: "command", command: `node "${markerPath}" start` }],
          },
        ],
        PreToolUse: [
          {
            hooks: [{ type: "command", command: `node "${markerPath}" start` }],
          },
        ],
        Stop: [
          {
            hooks: [{ type: "command", command: `node "${markerPath}" stop` }],
          },
        ],
      },
    };
    await writeFile(
      path.join(home, ".claude", "settings.json"),
      JSON.stringify(legacy, null, 2)
    );

    const { setClaudeHooks } = await import("./hooks");
    await setClaudeHooks(true);

    const parsed = JSON.parse(
      await readFile(path.join(home, ".claude", "settings.json"), "utf8")
    );
    expect(parsed.hooks.UserPromptSubmit).toHaveLength(1);
    expect(parsed.hooks.UserPromptSubmit[0].hooks[0].command).toContain(
      "prompt"
    );
    expect(parsed.hooks.PreToolUse).toHaveLength(1);
    expect(parsed.hooks.PreToolUse[0].hooks[0].command).toContain("tool");
    expect(parsed.hooks.PreToolUse[0].hooks[0].command).not.toContain("start");
  });

  it("merges into an existing settings.json without losing user config", async () => {
    await mkdir(path.join(home, ".claude", "projects"), { recursive: true });
    const userSettings = {
      model: "claude-sonnet-4-7",
      autoApprove: ["Read", "Bash(echo:*)"],
      // Nested objects must round-trip too — naive Object.assign style
      // merges that overwrite top-level keys would silently lose this.
      permissions: {
        allow: ["Bash(git:*)", "Edit"],
        deny: ["Bash(rm:*)"],
      },
      hooks: {
        PreToolUse: [
          {
            matcher: "Write",
            hooks: [{ type: "command", command: "prettier --write $FILE" }],
          },
        ],
      },
    };
    await writeFile(
      path.join(home, ".claude", "settings.json"),
      JSON.stringify(userSettings, null, 2)
    );

    const { setClaudeHooks } = await import("./hooks");
    await setClaudeHooks(true);

    const parsed = JSON.parse(
      await readFile(path.join(home, ".claude", "settings.json"), "utf8")
    );
    expect(parsed.model).toBe("claude-sonnet-4-7");
    expect(parsed.autoApprove).toEqual(["Read", "Bash(echo:*)"]);
    expect(parsed.permissions).toEqual({
      allow: ["Bash(git:*)", "Edit"],
      deny: ["Bash(rm:*)"],
    });
    expect(parsed.hooks.PreToolUse).toHaveLength(2);
    expect(parsed.hooks.PreToolUse[0].hooks[0].command).toBe(
      "prettier --write $FILE"
    );
    expect(parsed.hooks.PreToolUse[1].hooks[0].command).toContain("marker.cjs");
  });

  it("setClaudeHooks is idempotent — re-running doesn't duplicate hooks", async () => {
    await mkdir(path.join(home, ".claude", "projects"), { recursive: true });

    const { setClaudeHooks } = await import("./hooks");
    await setClaudeHooks(true);
    await setClaudeHooks(true);
    await setClaudeHooks(true);

    const parsed = JSON.parse(
      await readFile(path.join(home, ".claude", "settings.json"), "utf8")
    );
    expect(parsed.hooks.PreToolUse).toHaveLength(1);
    expect(parsed.hooks.UserPromptSubmit).toHaveLength(1);
    expect(parsed.hooks.Stop).toHaveLength(1);
  });

  it("setClaudeHooks(true) re-runs skip the disk write when nothing changed", async () => {
    // Auto-migration on activate calls setClaudeHooks(true) on every reload
    // when claude is connected. Without the no-op short-circuit, the
    // settings.json mtime would churn on every VSCode reload.
    await mkdir(path.join(home, ".claude", "projects"), { recursive: true });

    const { setClaudeHooks } = await import("./hooks");
    await setClaudeHooks(true);
    const settingsPath = path.join(home, ".claude", "settings.json");
    const mtimeBefore = (await import("node:fs/promises")).stat(settingsPath);
    const before = (await mtimeBefore).mtimeMs;

    // Wait a bit so any new write would be visible in mtime.
    await new Promise((r) => setTimeout(r, 20));
    await setClaudeHooks(true);
    const after = (await (await import("node:fs/promises")).stat(settingsPath))
      .mtimeMs;
    expect(after).toBe(before);
  });

  it("setClaudeHooks(true) refuses to overwrite a corrupt settings.json", async () => {
    await mkdir(path.join(home, ".claude", "projects"), { recursive: true });
    const settingsPath = path.join(home, ".claude", "settings.json");
    // Half-written file (e.g. user mid-edit, partial save, merge conflict).
    await writeFile(settingsPath, '{"model": "claude-sonnet-4-7"');

    const { setClaudeHooks } = await import("./hooks");
    await expect(setClaudeHooks(true)).rejects.toThrow(/isn't valid JSON/);

    // Original file is untouched — no data lost.
    const raw = await readFile(settingsPath, "utf8");
    expect(raw).toBe('{"model": "claude-sonnet-4-7"');
  });

  it("setClaudeHooks(false) strips only our entries, leaves the user's intact", async () => {
    await mkdir(path.join(home, ".claude", "projects"), { recursive: true });
    const userSettings = {
      model: "claude-sonnet-4-7",
      hooks: {
        PreToolUse: [
          {
            hooks: [{ type: "command", command: "prettier --write $FILE" }],
          },
        ],
      },
    };
    await writeFile(
      path.join(home, ".claude", "settings.json"),
      JSON.stringify(userSettings, null, 2)
    );

    const { setClaudeHooks } = await import("./hooks");
    await setClaudeHooks(true);
    await setClaudeHooks(false);

    const parsed = JSON.parse(
      await readFile(path.join(home, ".claude", "settings.json"), "utf8")
    );
    expect(parsed.model).toBe("claude-sonnet-4-7");
    expect(parsed.hooks.PreToolUse).toHaveLength(1);
    expect(parsed.hooks.PreToolUse[0].hooks[0].command).toBe(
      "prettier --write $FILE"
    );
    expect(parsed.hooks.UserPromptSubmit).toBeUndefined();
    expect(parsed.hooks.Stop).toBeUndefined();
  });

  it("setCursorHooks(true) writes ~/.cursor/hooks/hooks.json", async () => {
    await mkdir(path.join(home, ".cursor", "hooks"), { recursive: true });

    const { setCursorHooks } = await import("./hooks");
    await setCursorHooks(true);

    const parsed = JSON.parse(
      await readFile(path.join(home, ".cursor", "hooks", "hooks.json"), "utf8")
    );
    expect(parsed.version).toBe(1);
    expect(parsed.hooks.beforeSubmitPrompt.command).toContain("marker.cjs");
    expect(parsed.hooks.beforeSubmitPrompt.command).toContain("prompt");
    expect(parsed.hooks.afterAgentResponse.command).toContain("stop");
    expect(parsed.hooks.sessionEnd.command).toContain("stop");
  });

  it("setCursorHooks preserves an existing user hook by upgrading to an array", async () => {
    await mkdir(path.join(home, ".cursor", "hooks"), { recursive: true });
    await writeFile(
      path.join(home, ".cursor", "hooks", "hooks.json"),
      JSON.stringify({
        version: 1,
        hooks: {
          beforeSubmitPrompt: { command: "echo 'user hook ran'" },
        },
      })
    );

    const { setCursorHooks } = await import("./hooks");
    await setCursorHooks(true);

    const parsed = JSON.parse(
      await readFile(path.join(home, ".cursor", "hooks", "hooks.json"), "utf8")
    );
    expect(Array.isArray(parsed.hooks.beforeSubmitPrompt)).toBe(true);
    expect(parsed.hooks.beforeSubmitPrompt).toHaveLength(2);
    expect(parsed.hooks.beforeSubmitPrompt[0].command).toBe(
      "echo 'user hook ran'"
    );
    expect(parsed.hooks.beforeSubmitPrompt[1].command).toContain("marker.cjs");
  });

  it("getAgentStatus reports detected + connected accurately", async () => {
    (vscode.env as { appName: string }).appName = "Cursor";
    await mkdir(path.join(home, ".claude", "projects"), { recursive: true });

    const { getAgentStatus, setClaudeHooks, setCursorHooks } =
      await import("./hooks");

    let status = await getAgentStatus();
    expect(status.claude.detected).toBe(true);
    expect(status.claude.connected).toBe(false);
    expect(status.cursor.detected).toBe(true);
    expect(status.cursor.connected).toBe(false);

    await setClaudeHooks(true);
    status = await getAgentStatus();
    expect(status.claude.connected).toBe(true);
    expect(status.cursor.connected).toBe(false);

    await setCursorHooks(true);
    status = await getAgentStatus();
    expect(status.claude.connected).toBe(true);
    expect(status.cursor.connected).toBe(true);

    await setClaudeHooks(false);
    status = await getAgentStatus();
    expect(status.claude.connected).toBe(false);
    expect(status.cursor.connected).toBe(true);
  });

  it("getAgentStatus on a clean system reports neither detected", async () => {
    const { getAgentStatus } = await import("./hooks");
    const status = await getAgentStatus();
    expect(status.claude.detected).toBe(false);
    expect(status.cursor.detected).toBe(false);
    expect(status.claude.connected).toBe(false);
    expect(status.cursor.connected).toBe(false);
  });

  it("setExclusiveAgent disconnects the other agent when connecting one", async () => {
    (vscode.env as { appName: string }).appName = "Cursor";
    await mkdir(path.join(home, ".claude", "projects"), { recursive: true });
    await mkdir(path.join(home, ".cursor", "hooks"), { recursive: true });

    const { setClaudeHooks, setExclusiveAgent, getAgentStatus } =
      await import("./hooks");

    await setClaudeHooks(true);
    let status = await getAgentStatus();
    expect(status.claude.connected).toBe(true);
    expect(status.cursor.connected).toBe(false);

    await setExclusiveAgent("cursor", true);
    status = await getAgentStatus();
    expect(status.claude.connected).toBe(false);
    expect(status.cursor.connected).toBe(true);

    await setExclusiveAgent("claude", true);
    status = await getAgentStatus();
    expect(status.claude.connected).toBe(true);
    expect(status.cursor.connected).toBe(false);

    await setExclusiveAgent("claude", false);
    status = await getAgentStatus();
    expect(status.claude.connected).toBe(false);
    expect(status.cursor.connected).toBe(false);
  });
});
