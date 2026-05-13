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

import { pickCtaAgent } from "./extension";

function status(
  claude: { detected: boolean; connected: boolean },
  cursor: { detected: boolean; connected: boolean }
): AgentStatus {
  return { claude, cursor };
}

describe("pickCtaAgent", () => {
  it("returns null when the user has dismissed the CTA, regardless of detection", () => {
    expect(
      pickCtaAgent(
        status(
          { detected: true, connected: false },
          { detected: true, connected: false }
        ),
        true
      )
    ).toBeNull();
  });

  it("returns null when either agent is already connected", () => {
    expect(
      pickCtaAgent(
        status(
          { detected: true, connected: true },
          { detected: false, connected: false }
        ),
        false
      )
    ).toBeNull();
    expect(
      pickCtaAgent(
        status(
          { detected: false, connected: false },
          { detected: true, connected: true }
        ),
        false
      )
    ).toBeNull();
  });

  it("prefers Cursor when both Cursor and Claude Code are detected", () => {
    expect(
      pickCtaAgent(
        status(
          { detected: true, connected: false },
          { detected: true, connected: false }
        ),
        false
      )
    ).toBe("cursor");
  });

  it("returns 'claude' when only Claude Code is detected", () => {
    expect(
      pickCtaAgent(
        status(
          { detected: true, connected: false },
          { detected: false, connected: false }
        ),
        false
      )
    ).toBe("claude");
  });

  it("returns 'cursor' when only Cursor is detected", () => {
    expect(
      pickCtaAgent(
        status(
          { detected: false, connected: false },
          { detected: true, connected: false }
        ),
        false
      )
    ).toBe("cursor");
  });

  it("returns null when no agent is detected", () => {
    expect(
      pickCtaAgent(
        status(
          { detected: false, connected: false },
          { detected: false, connected: false }
        ),
        false
      )
    ).toBeNull();
  });
});
