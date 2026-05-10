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
