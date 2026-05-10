import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { friendlyName, lookupCanonicalName } from "./database";

describe("friendlyName", () => {
  it("strips a single trailing parenthetical region tag", () => {
    expect(friendlyName("Pokemon - Yellow Version (USA, Europe)")).toBe(
      "Pokemon - Yellow Version"
    );
  });

  it("strips multiple parenthetical tags including SGB / revision", () => {
    expect(
      friendlyName(
        "Pokemon - Yellow Version - Special Pikachu Edition (USA, Europe) (SGB Enhanced)"
      )
    ).toBe("Pokemon - Yellow Version - Special Pikachu Edition");
  });

  it("strips parens anywhere, not just at the end", () => {
    expect(friendlyName("Tetris (World) (Rev 1)")).toBe("Tetris");
  });

  it("strips a file extension when one is present (filename fallback path)", () => {
    expect(friendlyName("metroid.gba")).toBe("metroid");
  });

  it("strips both extension and parens for full filename input", () => {
    expect(friendlyName("Kirby's Dream Land (USA, Europe).gb")).toBe(
      "Kirby's Dream Land"
    );
  });

  it("returns the input untouched when there's nothing to strip", () => {
    expect(friendlyName("ZELDA")).toBe("ZELDA");
  });

  it("trims whitespace left over from stripping", () => {
    expect(friendlyName("Game Title  (Rev 1)  ")).toBe("Game Title");
  });
});

describe("lookupCanonicalName", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "standboy-rom-db-"));
    await mkdir(path.join(tmp, "data", "rom-db"), { recursive: true });
    const fixture: Record<string, string> = {
      // Real-shaped entries from the bundled GB DAT.
      "952d154dd2c6189ef4b786ae37bd7887c8ca9037":
        "10-Pin Bowling (USA) (Proto)",
      deadbeefdeadbeefdeadbeefdeadbeefdeadbeef: "Test Game (World)",
    };
    await writeFile(
      path.join(tmp, "data", "rom-db", "gb.json"),
      JSON.stringify(fixture)
    );
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("resolves a known SHA-1 to its canonical name", async () => {
    const name = await lookupCanonicalName(
      tmp,
      "gb",
      "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
    );
    expect(name).toBe("Test Game (World)");
  });

  it("matches case-insensitively (SHA-1 inputs may be uppercase)", async () => {
    const name = await lookupCanonicalName(
      tmp,
      "gb",
      "DEADBEEFDEADBEEFDEADBEEFDEADBEEFDEADBEEF"
    );
    expect(name).toBe("Test Game (World)");
  });

  it("returns null for an unknown SHA-1 (homebrew, hacks, unreleased)", async () => {
    const name = await lookupCanonicalName(
      tmp,
      "gb",
      "0000000000000000000000000000000000000000"
    );
    expect(name).toBeNull();
  });

  it("returns null when the system DB file is absent (graceful fallback)", async () => {
    const name = await lookupCanonicalName(
      tmp,
      "gba",
      "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
    );
    expect(name).toBeNull();
  });
});
