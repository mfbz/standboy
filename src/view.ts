import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import { log } from "./log";
import { readPalette } from "./settings";
import type { WebviewToHost } from "./messages";

function getNonce(): string {
  return randomBytes(16).toString("hex");
}

export type WebviewMessageHandler = (
  msg: WebviewToHost
) => void | Promise<void>;

export class StandboyViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "standboy.gameView";

  private view: vscode.WebviewView | undefined;
  private messageListener: vscode.Disposable | undefined;
  private visibilityListener: vscode.Disposable | undefined;
  private onMessage: WebviewMessageHandler | undefined;
  private onBecomeVisible: (() => void) | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly libraryRoot: vscode.Uri
  ) {}

  setMessageHandler(handler: WebviewMessageHandler | undefined): void {
    this.onMessage = handler;
  }

  // Fires when the view transitions from hidden to visible. Used as a
  // recovery hook for any sentinel-watcher event the OS may have dropped
  // since the panel was last open — event-driven, no polling.
  setOnBecomeVisible(callback: (() => void) | undefined): void {
    this.onBecomeVisible = callback;
  }

  // True only when the Standboy view container is the active item in the
  // sidebar AND the sidebar itself is visible. Drives focus-shift decisions
  // upstream so we don't yank the user into a panel that's already on screen
  // and don't swap a sidebar that's showing some other view. Returns false
  // before the view has been resolved (e.g. first activation with the
  // sidebar closed); callers should treat that case as "not visible".
  isVisible(): boolean {
    return this.view?.visible === true;
  }

  // Returns undefined if the view hasn't been resolved yet — callers fall back to a placeholder.
  asWebviewFileUri(absolutePath: string): string | undefined {
    if (!this.view) return undefined;
    return this.view.webview
      .asWebviewUri(vscode.Uri.file(absolutePath))
      .toString();
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    log("view resolved");
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      // The library root lives outside the extension folder (typically
      // globalStorage, or a user-configured path for iCloud/Dropbox sync),
      // so it has to be added explicitly or `asWebviewUri` URLs from there
      // are blocked by the webview sandbox.
      localResourceRoots: [this.extensionUri, this.libraryRoot],
    };
    view.webview.html = this.getHtml(view.webview);

    const dataUri = view.webview
      .asWebviewUri(
        vscode.Uri.joinPath(this.extensionUri, "vendor", "emulatorjs", "data")
      )
      .toString();
    const loaderUri = view.webview
      .asWebviewUri(
        vscode.Uri.joinPath(
          this.extensionUri,
          "vendor",
          "emulatorjs",
          "data",
          "loader.js"
        )
      )
      .toString();

    this.messageListener?.dispose();
    this.messageListener = view.webview.onDidReceiveMessage(
      async (msg: WebviewToHost) => {
        if (msg?.kind === "ready") {
          this.postMessage({
            kind: "init",
            emulatorDataUrl: dataUri.endsWith("/") ? dataUri : dataUri + "/",
            emulatorLoaderUrl: loaderUri,
          });
          this.postMessage({ kind: "palette", palette: readPalette() });
        }
        await this.onMessage?.(msg);
      }
    );

    this.visibilityListener?.dispose();
    this.visibilityListener = view.onDidChangeVisibility(() => {
      if (view.visible) this.onBecomeVisible?.();
    });
    // onDidChangeVisibility only fires on *transitions*. If the view was
    // already visible at resolve time (user had Standboy as their active
    // sidebar tab when the extension activated, or the view container was
    // re-resolved after a layout change), the callback would otherwise
    // never fire for the initial state. Fire it once explicitly so the
    // recovery hook is honored on first-open.
    if (view.visible) this.onBecomeVisible?.();
  }

  postMessage(message: unknown): void {
    this.view?.webview.postMessage(message);
  }

  // Forces a full iframe recreation by re-assigning the webview's HTML.
  // We used to ask the webview to `location.reload()` itself, but that
  // path leaves the previous webview's service worker controlling the new
  // iframe in Cursor (and sometimes VSCode) — the `Found unexpected
  // service worker controller` warning appears, the SW handoff never
  // completes, and the panel stays blank. Reassigning `webview.html` is
  // the host-driven path: VSCode tears the iframe down and brings up a
  // fresh one with a fresh SW. The existing onDidReceiveMessage listener
  // persists across the reassignment, so the new iframe's `ready` lands
  // on the same handler.
  reload(): void {
    if (!this.view) return;
    this.view.webview.html = this.getHtml(this.view.webview);
  }

  dispose(): void {
    this.messageListener?.dispose();
    this.messageListener = undefined;
    this.visibilityListener?.dispose();
    this.visibilityListener = undefined;
  }

  private getHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "index.js")
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "index.css")
    );
    const nonce = getNonce();
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `img-src ${webview.cspSource} data: blob:`,
      `media-src ${webview.cspSource} blob:`,
      `script-src 'nonce-${nonce}' ${webview.cspSource} 'wasm-unsafe-eval' 'unsafe-eval' blob:`,
      `worker-src ${webview.cspSource} blob:`,
      `connect-src ${webview.cspSource} blob: data:`,
      `font-src ${webview.cspSource}`,
    ].join("; ");

    // Inline styles + keyframes go here so the boot screen is visible
    // even before dist/index.css is fetched and parsed. Avoid relying on
    // CSS classes from stylesheets — the goal is "first frame visible".
    return `<!DOCTYPE html>
<html lang="en" style="height:100%">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    @keyframes sb-boot-pulse {
      0%, 100% { opacity: 0.4; transform: scale(0.85); }
      50%      { opacity: 1;   transform: scale(1.15); }
    }
  </style>
  <link href="${styleUri}" rel="stylesheet">
</head>
<body style="margin:0;height:100%;background:#1e1e1e;color:rgba(255,255,255,0.65);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;">
  <div id="root" style="height:100%">
    <div style="position:fixed;inset:0;display:flex;align-items:center;justify-content:center;gap:10px;font-size:11px;letter-spacing:0.18em;text-transform:uppercase;">
      <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:currentColor;animation:sb-boot-pulse 1.4s ease-in-out infinite;"></span>
      <span>Standboy</span>
    </div>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
