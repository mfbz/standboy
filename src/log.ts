import * as vscode from "vscode";

let channel: vscode.OutputChannel | null = null;

function getChannel(): vscode.OutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel("Standboy");
  }
  return channel;
}

function format(args: unknown[]): string {
  return args
    .map((a) => {
      if (a instanceof Error) return `${a.message}\n${a.stack ?? ""}`;
      return typeof a === "string" ? a : JSON.stringify(a);
    })
    .join(" ");
}

export function log(...args: unknown[]): void {
  getChannel().appendLine(`[standboy] ${format(args)}`);
}

export function logError(...args: unknown[]): void {
  getChannel().appendLine(`[standboy] ERROR ${format(args)}`);
}

export function showLogs(): void {
  getChannel().show(true);
}
