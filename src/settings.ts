import * as vscode from "vscode";
import { resolvePalette } from "./palette";
import type { Palette } from "./messages";

const SECTION = "standboy";

export function readPalette(): Palette {
  const cfg = vscode.workspace.getConfiguration(SECTION);
  return resolvePalette(
    cfg.get<string>("palette"),
    cfg.get<unknown>("customPalette")
  );
}

export function onPaletteChange(
  cb: (palette: Palette) => void
): vscode.Disposable {
  return vscode.workspace.onDidChangeConfiguration((e) => {
    if (
      e.affectsConfiguration(`${SECTION}.palette`) ||
      e.affectsConfiguration(`${SECTION}.customPalette`)
    ) {
      cb(readPalette());
    }
  });
}

export function readAutoShow(): boolean {
  return vscode.workspace
    .getConfiguration(SECTION)
    .get<boolean>("autoShow", true);
}

// Write to whichever scope currently owns the value, falling back to
// Global. If a user has `.vscode/settings.json` with the setting pinned,
// writing to Global would be a silent no-op (workspace wins on read)
// and the menu pill would flip back via onAutoShowChange — feels broken.
export function writeAutoShow(enabled: boolean): Thenable<void> {
  const cfg = vscode.workspace.getConfiguration(SECTION);
  const inspected = cfg.inspect<boolean>("autoShow");
  const target =
    inspected?.workspaceFolderValue !== undefined
      ? vscode.ConfigurationTarget.WorkspaceFolder
      : inspected?.workspaceValue !== undefined
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
  return cfg.update("autoShow", enabled, target);
}

export function onAutoShowChange(
  cb: (enabled: boolean) => void
): vscode.Disposable {
  return vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration(`${SECTION}.autoShow`)) {
      cb(readAutoShow());
    }
  });
}
