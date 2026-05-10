import * as path from "node:path";
import { mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import { DEFAULT_BINDINGS, LEGACY_DEFAULT_BINDINGS } from "./messages";
import type { KeyBindings } from "./messages";

function bindingsEqual(a: KeyBindings, b: KeyBindings): boolean {
  return (
    a.a === b.a && a.b === b.b && a.start === b.start && a.select === b.select
  );
}

// Versioned envelope so we can evolve the format without breaking older installs.
export interface ConfigFile {
  version: 1;
  bindings: KeyBindings;
}

const DEFAULT_CONFIG: ConfigFile = {
  version: 1,
  bindings: DEFAULT_BINDINGS,
};

// Atomic write: tmp + rename so a partial write never truncates the target.
async function writeAtomic(target: string, contents: string): Promise<void> {
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    await writeFile(tmp, contents);
    await rename(tmp, target);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

export class Config {
  constructor(private readonly libraryRoot: string) {}

  private get configPath(): string {
    return path.join(this.libraryRoot, "config.json");
  }

  async read(): Promise<ConfigFile> {
    try {
      const raw = await readFile(this.configPath, "utf8");
      const parsed = JSON.parse(raw) as Partial<ConfigFile>;
      const stored: KeyBindings = {
        ...DEFAULT_BINDINGS,
        ...(parsed.bindings ?? {}),
      };
      // Migrate users who never rebound away from the legacy X=A, Z=B defaults.
      if (bindingsEqual(stored, LEGACY_DEFAULT_BINDINGS)) {
        return DEFAULT_CONFIG;
      }
      return { version: 1, bindings: stored };
    } catch {
      return DEFAULT_CONFIG;
    }
  }

  async writeBindings(bindings: KeyBindings): Promise<void> {
    await mkdir(this.libraryRoot, { recursive: true });
    const next: ConfigFile = { version: 1, bindings };
    await writeAtomic(this.configPath, JSON.stringify(next, null, 2) + "\n");
  }
}
