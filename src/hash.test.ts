import { describe, it, expect } from "vitest";
import { romHash } from "./hash";

describe("romHash", () => {
  it("returns a 16-char hex string", () => {
    const h = romHash(new Uint8Array([1, 2, 3, 4, 5]));
    expect(h).toMatch(/^[0-9a-f]{16}$/);
  });

  it("is deterministic for identical input", () => {
    const a = new Uint8Array([0x42, 0x99, 0xff]);
    const b = new Uint8Array([0x42, 0x99, 0xff]);
    expect(romHash(a)).toBe(romHash(b));
  });

  it("differs for different input", () => {
    const a = new Uint8Array([1, 2, 3]);
    const b = new Uint8Array([1, 2, 4]);
    expect(romHash(a)).not.toBe(romHash(b));
  });
});
