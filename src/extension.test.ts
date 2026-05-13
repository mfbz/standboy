import { describe, it, expect, vi } from "vitest";
import type { AgentStatus } from "./messages";

vi.mock("vscode", () => ({
  window: {
    createOutputChannel: () => ({
      appendLine: () => undefined,
      show: () => undefined,
    }),
  },
}));

import { pickCtaAgents } from "./extension";

function status(
  claude: { detected: boolean; connected: boolean },
  cursor: { detected: boolean; connected: boolean }
): AgentStatus {
  return { claude, cursor };
}

describe("pickCtaAgents", () => {
  it("returns [] when the user has dismissed the CTA, regardless of detection", () => {
    expect(
      pickCtaAgents(
        status(
          { detected: true, connected: false },
          { detected: true, connected: false }
        ),
        true
      )
    ).toEqual([]);
  });

  it("returns [] when either agent is already connected", () => {
    expect(
      pickCtaAgents(
        status(
          { detected: true, connected: true },
          { detected: false, connected: false }
        ),
        false
      )
    ).toEqual([]);
    expect(
      pickCtaAgents(
        status(
          { detected: false, connected: false },
          { detected: true, connected: true }
        ),
        false
      )
    ).toEqual([]);
  });

  it("offers BOTH when both Cursor and Claude Code are detected and unconnected, with Cursor first", () => {
    expect(
      pickCtaAgents(
        status(
          { detected: true, connected: false },
          { detected: true, connected: false }
        ),
        false
      )
    ).toEqual(["cursor", "claude"]);
  });

  it("returns ['claude'] when only Claude Code is detected", () => {
    expect(
      pickCtaAgents(
        status(
          { detected: true, connected: false },
          { detected: false, connected: false }
        ),
        false
      )
    ).toEqual(["claude"]);
  });

  it("returns ['cursor'] when only Cursor is detected", () => {
    expect(
      pickCtaAgents(
        status(
          { detected: false, connected: false },
          { detected: true, connected: false }
        ),
        false
      )
    ).toEqual(["cursor"]);
  });

  it("returns [] when no agent is detected", () => {
    expect(
      pickCtaAgents(
        status(
          { detected: false, connected: false },
          { detected: false, connected: false }
        ),
        false
      )
    ).toEqual([]);
  });

  it("returns [] when the lone connected agent toggles back off but dismissed sticks", () => {
    // Documents the load-bearing UX choice: once you've connected, the CTA
    // never re-pops even if you later disconnect — the dismissed flag was
    // flipped on first connect specifically to prevent that.
    expect(
      pickCtaAgents(
        status(
          { detected: true, connected: false },
          { detected: true, connected: false }
        ),
        true
      )
    ).toEqual([]);
  });
});
