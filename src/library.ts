import * as path from "node:path";
import {
  mkdir,
  readFile,
  writeFile,
  rename,
  rm,
  access,
  constants,
} from "node:fs/promises";
import { romHash } from "./hash";
import { logError } from "./log";

export type RomExt = "gb" | "gbc" | "gba";

export interface RomEntry {
  // Original filename the user picked, with extension.
  name: string;
  // No-Intro canonical name from the SHA-1 lookup. Undefined for homebrew,
  // ROM hacks, or anything not in the bundled database — the rest of the
  // system falls back to `name` for display and cover lookup in that case.
  canonicalName?: string;
  // True once we've run the SHA-1 lookup for this ROM, regardless of whether
  // it matched. Without this flag the activate-time backfill would re-hash
  // every still-unidentified ROM forever (homebrew, hacks, betas) on every
  // panel mount. Pre-flag entries are undefined → get one final lookup, then stick.
  canonicalChecked?: boolean;
  ext: RomExt;
  size: number;
  addedAt: string;
  lastPlayedAt: string;
}

export interface LibraryFile {
  version: 1;
  roms: Record<string, RomEntry>;
  lastPlayedHash?: string;
}

export interface LoadedRom {
  hash: string;
  // Read entirely into memory. Today only the backfill SHA-1 lookup uses
  // this; the playback path goes through romFilePath() + a webview-resource
  // URI so the host never holds the bytes.
  bytes: Uint8Array<ArrayBuffer>;
  ext: RomExt;
  name: string;
  save?: Uint8Array<ArrayBuffer>;
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

// Crash-safe: write to a sibling temp file then rename over the target.
// Same-filesystem rename is atomic on POSIX and on NTFS via MoveFileEx.
// PID suffix defends against two extension hosts (two VSCode windows)
// writing to the same path at the same instant.
async function writeAtomic(
  target: string,
  bytes: Uint8Array | string
): Promise<void> {
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    await writeFile(tmp, bytes);
    await rename(tmp, target);
  } catch (err) {
    try {
      await rm(tmp, { force: true });
    } catch {
      // best-effort
    }
    throw err;
  }
}

export class Library {
  // Serializes every read-modify-write on library.json. Operations run
  // one-at-a-time; a thrown error in one does not deadlock the queue.
  private mutationQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly root: string) {}

  get rootPath(): string {
    return this.root;
  }

  private get romsDir(): string {
    return path.join(this.root, "roms");
  }
  private get savesDir(): string {
    return path.join(this.root, "saves");
  }
  // Sibling <hash>.miss zero-byte marker is written when a fetch returned
  // nothing, so we don't retry every panel mount.
  get coversDir(): string {
    return path.join(this.root, "covers");
  }
  private get libraryFile(): string {
    return path.join(this.root, "library.json");
  }

  romFilePath(hash: string, ext: RomExt): string {
    return path.join(this.romsDir, `${hash}.${ext}`);
  }
  private saveFile(hash: string): string {
    return path.join(this.savesDir, `${hash}.sav`);
  }

  coverFile(hash: string): string {
    return path.join(this.coversDir, `${hash}.png`);
  }
  coverMissFile(hash: string): string {
    return path.join(this.coversDir, `${hash}.miss`);
  }
  async hasCachedCover(hash: string): Promise<boolean> {
    return exists(this.coverFile(hash));
  }
  async hasCoverMiss(hash: string): Promise<boolean> {
    return exists(this.coverMissFile(hash));
  }

  private async serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.mutationQueue.then(fn, fn);
    // Swallow result/error in the chain so a thrown op does not poison
    // every subsequent op. Each caller still receives its own result/error.
    this.mutationQueue = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  async ensureDirs(): Promise<void> {
    await mkdir(this.romsDir, { recursive: true });
    await mkdir(this.savesDir, { recursive: true });
    await mkdir(this.coversDir, { recursive: true });
  }

  async readLibrary(): Promise<LibraryFile> {
    try {
      const raw = await readFile(this.libraryFile, "utf8");
      const parsed = JSON.parse(raw);
      return {
        version: 1,
        roms: parsed.roms ?? {},
        lastPlayedHash: parsed.lastPlayedHash,
      };
    } catch {
      return { version: 1, roms: {} };
    }
  }

  private async writeLibrary(lib: LibraryFile): Promise<void> {
    await this.ensureDirs();
    await writeAtomic(this.libraryFile, JSON.stringify(lib, null, 2) + "\n");
  }

  // canonicalName: pass null to record "we looked, no match" (sets
  // canonicalChecked so backfill skips). Pass undefined only when caller
  // deliberately hasn't done the lookup. Never overwrites a stored
  // canonical with null/undefined — if a re-import doesn't match, the
  // old one (which presumably did) stays.
  async addRom(
    bytes: Uint8Array<ArrayBuffer>,
    ext: RomExt,
    name: string,
    canonicalName?: string | null
  ): Promise<string> {
    return this.serialize(async () => {
      await this.ensureDirs();
      const hash = romHash(bytes);
      const dest = this.romFilePath(hash, ext);
      if (!(await exists(dest))) {
        await writeAtomic(dest, bytes);
      }

      const lib = await this.readLibrary();
      const now = new Date().toISOString();
      const prev = lib.roms[hash];
      const checkedNow = canonicalName !== undefined;
      lib.roms[hash] = {
        name,
        canonicalName: canonicalName ?? prev?.canonicalName,
        canonicalChecked: checkedNow || prev?.canonicalChecked,
        ext,
        size: bytes.length,
        addedAt: prev?.addedAt ?? now,
        lastPlayedAt: now,
      };
      lib.lastPlayedHash = hash;
      await this.writeLibrary(lib);
      return hash;
    });
  }

  // Single library.json write for many entries — naive per-entry writes
  // would re-serialize the whole index N times and saturate the mutation queue.
  // canonicalName null = "we looked, no match" (still marks checked).
  async setCanonicalNames(
    updates: ReadonlyArray<{ hash: string; canonicalName: string | null }>
  ): Promise<void> {
    if (updates.length === 0) return;
    return this.serialize(async () => {
      const lib = await this.readLibrary();
      let changed = false;
      for (const { hash, canonicalName } of updates) {
        const entry = lib.roms[hash];
        if (!entry) continue;
        if (canonicalName !== null && entry.canonicalName !== canonicalName) {
          entry.canonicalName = canonicalName;
          changed = true;
        }
        if (!entry.canonicalChecked) {
          entry.canonicalChecked = true;
          changed = true;
        }
      }
      if (changed) await this.writeLibrary(lib);
    });
  }

  async touch(hash: string): Promise<void> {
    return this.serialize(async () => {
      const lib = await this.readLibrary();
      const entry = lib.roms[hash];
      if (!entry) return;
      entry.lastPlayedAt = new Date().toISOString();
      lib.lastPlayedHash = hash;
      await this.writeLibrary(lib);
    });
  }

  async loadRom(hash: string): Promise<LoadedRom | null> {
    const lib = await this.readLibrary();
    const entry = lib.roms[hash];
    if (!entry) return null;
    try {
      const bytes = (await readFile(
        this.romFilePath(hash, entry.ext)
      )) as Uint8Array<ArrayBuffer>;
      const save = await this.readSave(hash);
      return {
        hash,
        bytes,
        ext: entry.ext,
        name: entry.name,
        save: save ?? undefined,
      };
    } catch (err) {
      logError("library: loadRom failed", err);
      return null;
    }
  }

  async readSave(hash: string): Promise<Uint8Array<ArrayBuffer> | null> {
    try {
      return (await readFile(this.saveFile(hash))) as Uint8Array<ArrayBuffer>;
    } catch {
      return null;
    }
  }

  async writeSave(hash: string, bytes: Uint8Array): Promise<void> {
    await this.ensureDirs();
    await writeAtomic(this.saveFile(hash), bytes);
  }

  async deleteSave(hash: string): Promise<void> {
    await rm(this.saveFile(hash), { force: true });
  }

  async deleteRom(hash: string): Promise<void> {
    return this.serialize(async () => {
      const lib = await this.readLibrary();
      const entry = lib.roms[hash];
      if (!entry) return;
      await rm(this.romFilePath(hash, entry.ext), { force: true });
      await this.deleteSave(hash);
      await rm(this.coverFile(hash), { force: true });
      await rm(this.coverMissFile(hash), { force: true });
      delete lib.roms[hash];
      if (lib.lastPlayedHash === hash) lib.lastPlayedHash = undefined;
      await this.writeLibrary(lib);
    });
  }

  // Sorted by addedAt ascending — the library is a stable "shelf." Sorting
  // by lastPlayedAt would reflow the whole grid every time the user switches
  // ROMs, killing muscle memory; the currently-playing ROM is already
  // marked with the green ring in the UI. New imports land at the end of
  // the grid, next to the + Add tile, which keeps existing positions fixed.
  async listRoms(): Promise<Array<{ hash: string } & RomEntry>> {
    const lib = await this.readLibrary();
    return Object.entries(lib.roms)
      .map(([hash, entry]) => ({ hash, ...entry }))
      .sort((a, b) => a.addedAt.localeCompare(b.addedAt));
  }
}
