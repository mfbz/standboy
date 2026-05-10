import * as vscode from "vscode";
import { readFile } from "node:fs/promises";
import { logError } from "./log";
import { Library, type RomExt } from "./library";
import { romSha1 } from "./hash";
import { lookupCanonicalName } from "./database";

const EXT_MAP: Record<string, RomExt> = {
  gb: "gb",
  gbc: "gbc",
  gba: "gba",
};

export async function pickAndImportRom(
  library: Library,
  extensionRoot: string
): Promise<string | null> {
  const picked = await vscode.window.showOpenDialog({
    canSelectMany: false,
    openLabel: "Load ROM",
    filters: { "Game Boy ROMs": ["gb", "gbc", "gba"] },
  });
  if (!picked || picked.length === 0) return null;
  const uri = picked[0]!;
  const ext = uri.path.split(".").pop()?.toLowerCase() ?? "";
  const platform = EXT_MAP[ext];
  if (!platform) {
    void vscode.window.showErrorMessage(
      `Standboy: unsupported file extension ".${ext}"`
    );
    return null;
  }
  try {
    const buf = (await readFile(uri.fsPath)) as Uint8Array<ArrayBuffer>;
    const name = uri.path.split("/").pop() ?? "rom";
    const sha1 = romSha1(buf);
    const canonical = await lookupCanonicalName(extensionRoot, platform, sha1);
    // null records "we looked, no match" → sets canonicalChecked so backfill skips.
    return await library.addRom(buf, platform, name, canonical);
  } catch (err) {
    logError("rom import failed", err);
    void vscode.window.showErrorMessage("Standboy: failed to read ROM file.");
    return null;
  }
}
