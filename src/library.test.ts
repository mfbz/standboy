import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Library transitively imports `./log` → `vscode`. Mock the namespace
// so the test runner doesn't need a real VSCode environment.
vi.mock("vscode", () => ({
  window: {
    createOutputChannel: () => ({
      appendLine: () => undefined,
      show: () => undefined,
    }),
  },
}));

import { Library } from "./library";

describe("Library", () => {
  let root: string;
  let lib: Library;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "standboy-test-"));
    lib = new Library(root);
    await lib.ensureDirs();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("addRom writes the ROM, indexes it, and returns the hash", async () => {
    const bytes = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05]);
    const hash = await lib.addRom(bytes, "gba", "test.gba");

    expect(hash).toMatch(/^[0-9a-f]{16}$/);

    const file = await readFile(join(root, "roms", `${hash}.gba`));
    expect(Array.from(file)).toEqual(Array.from(bytes));

    const indexed = await lib.readLibrary();
    expect(indexed.lastPlayedHash).toBe(hash);
    expect(indexed.roms[hash]?.name).toBe("test.gba");
    expect(indexed.roms[hash]?.size).toBe(bytes.length);
  });

  it("addRom is idempotent on hash collision and preserves addedAt", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const hash1 = await lib.addRom(bytes, "gb", "a.gb");
    const lib1 = await lib.readLibrary();
    const addedAt1 = lib1.roms[hash1]?.addedAt;

    await new Promise((r) => setTimeout(r, 5));
    const hash2 = await lib.addRom(bytes, "gb", "a-renamed.gb");
    const lib2 = await lib.readLibrary();

    expect(hash2).toBe(hash1);
    expect(lib2.roms[hash2]?.addedAt).toBe(addedAt1);
    expect((lib2.roms[hash2]?.lastPlayedAt ?? "") >= (addedAt1 ?? "")).toBe(
      true
    );
    expect(lib2.roms[hash2]?.name).toBe("a-renamed.gb");
  });

  it("loadRom returns ROM bytes plus save bytes when both exist", async () => {
    const rom = new Uint8Array([10, 20, 30]);
    const save = new Uint8Array([99, 100, 101]);
    const hash = await lib.addRom(rom, "gbc", "b.gbc");
    await lib.writeSave(hash, save);

    const loaded = await lib.loadRom(hash);
    expect(loaded).not.toBeNull();
    expect(Array.from(loaded!.bytes)).toEqual(Array.from(rom));
    expect(Array.from(loaded!.save!)).toEqual(Array.from(save));
    expect(loaded!.ext).toBe("gbc");
    expect(loaded!.name).toBe("b.gbc");
  });

  it("loadRom returns null for an unknown hash", async () => {
    expect(await lib.loadRom("0000000000000000")).toBeNull();
  });

  it("deleteRom removes the ROM file, save file, and index entry", async () => {
    const hash = await lib.addRom(new Uint8Array([7]), "gba", "c.gba");
    await lib.writeSave(hash, new Uint8Array([8, 9]));

    await lib.deleteRom(hash);

    const after = await lib.readLibrary();
    expect(after.roms[hash]).toBeUndefined();
    expect(after.lastPlayedHash).toBeUndefined();
    expect(await lib.readSave(hash)).toBeNull();
    expect(await lib.loadRom(hash)).toBeNull();
  });

  it("listRoms is sorted by lastPlayedAt descending", async () => {
    const a = await lib.addRom(new Uint8Array([1]), "gb", "old.gb");
    await new Promise((r) => setTimeout(r, 10));
    const b = await lib.addRom(new Uint8Array([2]), "gb", "newer.gb");

    const list = await lib.listRoms();
    expect(list.map((r) => r.hash)).toEqual([b, a]);
  });

  it("readLibrary recovers from a corrupt library.json", async () => {
    await writeFile(join(root, "library.json"), "this is not json");
    const result = await lib.readLibrary();
    expect(result).toEqual({ version: 1, roms: {} });
  });

  it("concurrent addRom calls do not lose entries (mutex)", async () => {
    // Without serialization, the second read-modify-write would clobber
    // the first. With the mutex, both entries should be in library.json.
    const bytesA = new Uint8Array([1, 2, 3]);
    const bytesB = new Uint8Array([4, 5, 6]);

    const [hashA, hashB] = await Promise.all([
      lib.addRom(bytesA, "gb", "a.gb"),
      lib.addRom(bytesB, "gb", "b.gb"),
    ]);

    const indexed = await lib.readLibrary();
    expect(indexed.roms[hashA]).toBeDefined();
    expect(indexed.roms[hashB]).toBeDefined();
    expect(Object.keys(indexed.roms)).toHaveLength(2);
  });

  it("writeSave is atomic — no .tmp leftovers on success", async () => {
    const hash = await lib.addRom(new Uint8Array([1]), "gba", "d.gba");
    await lib.writeSave(hash, new Uint8Array([42, 43, 44]));

    const savesDir = join(root, "saves");
    const entries = await readdir(savesDir);
    expect(entries).toContain(`${hash}.sav`);
    expect(entries.some((e) => e.endsWith(".tmp"))).toBe(false);
  });

  describe("save round-trip", () => {
    it("loadRom returns the bytes that writeSave persisted", async () => {
      const romBytes = new Uint8Array([0xff, 0xfe, 0xfd, 0xfc]);
      const hash = await lib.addRom(romBytes, "gb", "round-trip.gb");
      const saveBytes = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05, 0x06]);
      await lib.writeSave(hash, saveBytes);

      const loaded = await lib.loadRom(hash);
      expect(loaded).not.toBeNull();
      expect(loaded!.save).toBeDefined();
      expect(Array.from(loaded!.save!)).toEqual(Array.from(saveBytes));
    });

    it("loadRom returns undefined save when no save was ever written", async () => {
      const hash = await lib.addRom(
        new Uint8Array([1, 2, 3]),
        "gb",
        "fresh.gb"
      );
      const loaded = await lib.loadRom(hash);
      expect(loaded).not.toBeNull();
      expect(loaded!.save).toBeUndefined();
    });

    it("writeSave overwrites a previous save, no stale bytes leak", async () => {
      const hash = await lib.addRom(
        new Uint8Array([1]),
        "gba",
        "overwrite.gba"
      );
      await lib.writeSave(hash, new Uint8Array([0xaa, 0xaa, 0xaa, 0xaa]));
      await lib.writeSave(hash, new Uint8Array([0x55, 0x55]));

      const loaded = await lib.loadRom(hash);
      expect(Array.from(loaded!.save!)).toEqual([0x55, 0x55]);
    });

    it("readSave returns null cleanly when the file doesn't exist", async () => {
      const hash = await lib.addRom(new Uint8Array([1]), "gb", "no-save.gb");
      const save = await lib.readSave(hash);
      expect(save).toBeNull();
    });

    it("deleteRom wipes the .sav alongside the ROM and the index entry", async () => {
      const hash = await lib.addRom(
        new Uint8Array([1, 2, 3]),
        "gb",
        "delete-me.gb"
      );
      await lib.writeSave(hash, new Uint8Array([1, 2, 3]));
      await lib.deleteRom(hash);

      const indexed = await lib.readLibrary();
      expect(indexed.roms[hash]).toBeUndefined();
      const save = await lib.readSave(hash);
      expect(save).toBeNull();
    });
  });
});
