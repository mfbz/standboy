import * as vscode from "vscode";
import * as path from "node:path";
import { homedir } from "node:os";

const SECTION = "standboy";

export function resolveLibraryRoot(context: vscode.ExtensionContext): string {
  const cfg = vscode.workspace.getConfiguration(SECTION);
  const override = cfg.get<string>("libraryDirectory", "").trim();
  if (override) {
    const expanded = override.startsWith("~")
      ? path.join(homedir(), override.slice(1))
      : override;
    return path.resolve(expanded);
  }
  return context.globalStorageUri.fsPath;
}
