import type { HostToWebview, WebviewToHost } from "../src/messages";

declare const acquireVsCodeApi: () => {
  postMessage: (msg: WebviewToHost) => void;
};

const vscodeApi = acquireVsCodeApi();

export function send(msg: WebviewToHost): void {
  vscodeApi.postMessage(msg);
}

export function onMessage(handler: (msg: HostToWebview) => void): () => void {
  const listener = (event: MessageEvent<HostToWebview>) => handler(event.data);
  window.addEventListener("message", listener);
  return () => window.removeEventListener("message", listener);
}
