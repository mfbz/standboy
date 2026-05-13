import * as vscode from "vscode";
import { writeFile, readFile, access } from "node:fs/promises";
import { log, logError, showLogs } from "./log";
import { StandboyViewProvider } from "./view";
import {
  onAutoShowChange,
  onPaletteChange,
  readAutoShow,
  writeAutoShow,
} from "./settings";
import { ActivityDetector, focusIntentFor } from "./activity";
import { pickAndImportRom } from "./rom";
import { Library } from "./library";
import { resolveLibraryRoot } from "./root";
import { ensureCoverFile } from "./covers";
import { Config } from "./config";
import { friendlyName, lookupCanonicalName } from "./database";
import { romSha1 } from "./hash";
import {
  cleanupStaleSentinel,
  ensureMarkerInstalled,
  watchSentinel,
} from "./agent";
import { getAgentStatus, setExclusiveAgent } from "./hooks";
import type { Agent, LibraryEntry, MenuAction, Rom } from "./messages";

const COVER_FETCH_CONCURRENCY = 4;

const FIRST_RUN_KEY = "standboy.firstRunCompleted";

// Active onboarding shown once per machine on fresh install. Auto-opens
// the panel, then a modal dialog offering to connect detected agents.
// VSCode has no reliable uninstall lifecycle (microsoft/vscode#155561,
// #102260), so we surface the cleanup convention upfront here rather
// than via a passive tip after the user has already configured.
async function maybeRunFirstRunSetup(
  context: vscode.ExtensionContext,
  postAgentStatus: () => Promise<void>
): Promise<void> {
  if (context.globalState.get<boolean>(FIRST_RUN_KEY)) return;
  await context.globalState.update(FIRST_RUN_KEY, true);

  const status = await getAgentStatus();

  // Existing user upgrading? They already have hooks installed — don't
  // hijack their workflow with an onboarding dialog.
  if (status.claude.connected || status.cursor.connected) return;

  // Reveal the panel so the user sees what they just installed alongside
  // the welcome dialog.
  void vscode.commands.executeCommand("standboy.gameView.focus");

  if (!status.claude.detected && !status.cursor.detected) {
    void vscode.window.showInformationMessage("Welcome to Standboy!", {
      modal: true,
      detail:
        "No AI agent detected on this system. Standboy still works as a manual Game Boy emulator. Install Claude Code or run Standboy inside Cursor to enable auto-show during AI activity.",
    });
    return;
  }

  const buttons: string[] = [];
  if (status.claude.detected) buttons.push("Connect Claude Code");
  if (status.cursor.detected) buttons.push("Connect Cursor");

  const choice = await vscode.window.showInformationMessage(
    "Welcome to Standboy!",
    {
      modal: true,
      detail:
        "Connect your AI agent to auto-show the panel during activity. You can change this anytime in the panel's Detection menu — and should disconnect there before uninstalling Standboy.",
    },
    ...buttons
  );

  let agent: Agent | null = null;
  if (choice === "Connect Claude Code") agent = "claude";
  else if (choice === "Connect Cursor") agent = "cursor";
  if (!agent) return;

  try {
    await setExclusiveAgent(agent, true);
    await postAgentStatus();
    log("first-run: connected", agent);
  } catch (err) {
    logError("first-run: connect failed", agent, err);
    void vscode.window.showErrorMessage(
      `Standboy: couldn't connect ${agent}. You can try again from the Detection menu.`
    );
  }
}

export async function activate(
  context: vscode.ExtensionContext
): Promise<void> {
  log("activate");

  let library = new Library(resolveLibraryRoot(context));
  await library.ensureDirs();
  let config = new Config(library.rootPath);

  // The view provider needs the library root in its `localResourceRoots`
  // so the webview can load cached covers. Changing `standboy.libraryDirectory`
  // at runtime won't move existing webview's resource roots — we surface
  // a "reload window" prompt instead of trying to live-recreate the view.
  const provider = new StandboyViewProvider(
    context.extensionUri,
    vscode.Uri.file(library.rootPath)
  );
  const detector = new ActivityDetector();

  // Eagerly create ~/.standboy/ + the marker script at activation, then
  // sweep any stale sentinel from a previous crash so the watcher's first
  // read can't mistake it for a real in-flight agent run.
  try {
    await ensureMarkerInstalled();
    const removed = await cleanupStaleSentinel();
    if (removed) log("agent: removed stale sentinel from previous session");
  } catch (err) {
    logError("agent: activation prep failed", err);
  }

  // While ~/.standboy/agent-active exists, the override flag pins activity
  // state to "active" and bypasses the burst heuristic — official lifecycle
  // signal beats edit-pattern guessing every time.
  const sentinelWatcher = watchSentinel((active) => {
    log("agent: sentinel", active ? "present" : "absent");
    detector.setOverride(active);
  });

  let currentRomHash: string | null = null;

  const extensionRoot = context.extensionUri.fsPath;

  async function buildLibrary(): Promise<LibraryEntry[]> {
    const items = await library.listRoms();
    return Promise.all(
      items.map(async (r) => {
        const hasCover = await library.hasCachedCover(r.hash);
        const coverUri = hasCover
          ? (provider.asWebviewFileUri(library.coverFile(r.hash)) ?? null)
          : null;
        return {
          hash: r.hash,
          name: r.name,
          displayName: friendlyName(r.canonicalName ?? r.name),
          ext: r.ext,
          size: r.size,
          lastPlayedAt: r.lastPlayedAt,
          coverUri,
        };
      })
    );
  }

  // Idempotent — runs every activate, only does work for still-unidentified
  // entries. All resolved canonicals committed in a single library.json
  // write at the end so the mutation queue isn't pinned for the duration.
  async function backfillCanonicalNames(): Promise<void> {
    const items = await library.listRoms();
    // Skip ROMs we've already looked up — including those that came back
    // as a miss. Without this filter, every homebrew/hack would be
    // re-read + re-hashed on every activate forever.
    const todo = items.filter((r) => !r.canonicalChecked);
    if (todo.length === 0) return;

    const updates: Array<{ hash: string; canonicalName: string | null }> = [];
    const concurrency = COVER_FETCH_CONCURRENCY;
    for (let i = 0; i < todo.length; i += concurrency) {
      const chunk = todo.slice(i, i + concurrency);
      await Promise.all(
        chunk.map(async (r) => {
          try {
            const rom = await library.loadRom(r.hash);
            if (!rom) return;
            const sha1 = romSha1(rom.bytes);
            const canonical = await lookupCanonicalName(
              extensionRoot,
              r.ext,
              sha1
            );
            // Always push — canonical may be null for an unmatched ROM,
            // and we still want to mark it canonicalChecked so the next
            // backfill skips it.
            updates.push({ hash: r.hash, canonicalName: canonical });
          } catch (err) {
            logError("database: backfill hash failed", r.name, err);
          }
        })
      );
    }
    await library.setCanonicalNames(updates);
  }

  async function postLibrary(): Promise<void> {
    const entries = await buildLibrary();
    provider.postMessage({ kind: "library", entries });
  }

  async function postAgentStatus(): Promise<void> {
    try {
      const status = await getAgentStatus();
      provider.postMessage({ kind: "agentStatus", status });
    } catch (err) {
      logError("hooks: status read failed", err);
    }
  }

  // Sends a coverUpdate message as each cover resolves so the grid fades art in progressively.
  async function ensureCoversInBackground(): Promise<void> {
    const items = await library.listRoms();
    const todo: typeof items = [];
    for (const r of items) {
      if (await library.hasCachedCover(r.hash)) continue;
      if (await library.hasCoverMiss(r.hash)) continue;
      todo.push(r);
    }
    for (let i = 0; i < todo.length; i += COVER_FETCH_CONCURRENCY) {
      const chunk = todo.slice(i, i + COVER_FETCH_CONCURRENCY);
      await Promise.all(
        chunk.map(async (r) => {
          try {
            const result = await ensureCoverFile(
              r.name,
              r.ext,
              library.coverFile(r.hash),
              library.coverMissFile(r.hash),
              r.canonicalName
            );
            const coverUri =
              result === "fetched"
                ? (provider.asWebviewFileUri(library.coverFile(r.hash)) ?? null)
                : null;
            provider.postMessage({
              kind: "coverUpdate",
              hash: r.hash,
              coverUri,
            });
          } catch (err) {
            logError("covers: fetch failed", r.name, err);
          }
        })
      );
    }
  }

  async function loadAndPostRom(hash: string): Promise<boolean> {
    const lib = await library.readLibrary();
    const entry = lib.roms[hash];
    if (!entry) return false;
    const romPath = library.romFilePath(hash, entry.ext);
    // Library index can outlive the file on disk (user wiped the folder,
    // iCloud sync conflict, etc.). Fail silently rather than hand the
    // webview a URI that would 404 on fetch.
    try {
      await access(romPath);
    } catch {
      return false;
    }
    const romUri = provider.asWebviewFileUri(romPath);
    if (!romUri) return false;
    const save = await library.readSave(hash);
    await library.touch(hash);
    currentRomHash = hash;
    const message: { kind: "rom" } & Rom = {
      kind: "rom",
      hash,
      romUri,
      ext: entry.ext,
      name: entry.name,
      displayName: friendlyName(entry.canonicalName ?? entry.name),
      save: save ? Array.from(save) : undefined,
    };
    provider.postMessage(message);
    // Touching changed lastPlayedAt order — refresh the grid.
    await postLibrary();
    return true;
  }

  async function loadRomAction(): Promise<void> {
    const hash = await pickAndImportRom(library, extensionRoot);
    if (hash) {
      await loadAndPostRom(hash);
      // Newly-imported ROM may not be in the libretro index — kick off
      // the fetcher so any matchable cover lands within seconds.
      void ensureCoversInBackground();
    }
  }

  async function openLibraryFolderAction(): Promise<void> {
    await library.ensureDirs();
    await vscode.env.openExternal(vscode.Uri.file(library.rootPath));
  }

  async function exportSaveAction(): Promise<void> {
    if (!currentRomHash) {
      void vscode.window.showWarningMessage(
        "Standboy: no ROM is currently loaded."
      );
      return;
    }
    const bytes = await library.readSave(currentRomHash);
    if (!bytes || bytes.length === 0) {
      void vscode.window.showWarningMessage(
        "Standboy: no save data exists for the current ROM yet."
      );
      return;
    }
    const target = await vscode.window.showSaveDialog({
      filters: { "Save files": ["sav"] },
      saveLabel: "Export Save",
      defaultUri: vscode.Uri.file(`standboy-${currentRomHash}.sav`),
    });
    if (!target) return;
    await writeFile(target.fsPath, bytes);
    void vscode.window.showInformationMessage(
      `Standboy: save exported to ${target.fsPath}`
    );
  }

  async function importSaveAction(): Promise<void> {
    if (!currentRomHash) {
      void vscode.window.showWarningMessage(
        "Standboy: load a ROM first, then import a save for it."
      );
      return;
    }
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: false,
      filters: { "Save files": ["sav"] },
      openLabel: "Import Save",
    });
    if (!picked || picked.length === 0) return;
    try {
      const bytes = await readFile(picked[0]!.fsPath);
      await library.writeSave(currentRomHash, bytes);
      await loadAndPostRom(currentRomHash);
      void vscode.window.showInformationMessage(
        "Standboy: save imported. The game has been reloaded."
      );
    } catch (err) {
      logError("import save failed", err);
      void vscode.window.showErrorMessage(
        "Standboy: failed to import save file."
      );
    }
  }

  async function deleteRomAction(): Promise<void> {
    const items = (await library.listRoms()).map((r) => ({
      label: r.name,
      description: `${(r.size / 1024 / 1024).toFixed(1)} MB · ${r.ext.toUpperCase()}`,
      hash: r.hash,
    }));
    if (items.length === 0) {
      void vscode.window.showInformationMessage(
        "Standboy: your library is already empty."
      );
      return;
    }
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: "Pick a ROM to delete from your library",
    });
    if (!picked) return;
    const confirm = await vscode.window.showWarningMessage(
      `Delete "${picked.label}" and its save file? This cannot be undone.`,
      { modal: true },
      "Delete"
    );
    if (confirm !== "Delete") return;
    await library.deleteRom(picked.hash);
    if (currentRomHash === picked.hash) currentRomHash = null;
    await postLibrary();
  }

  const menuHandlers: Record<MenuAction, () => Promise<void> | void> = {
    loadRom: loadRomAction,
    openLibraryFolder: openLibraryFolderAction,
    exportSave: exportSaveAction,
    importSave: importSaveAction,
    deleteRom: deleteRomAction,
    showLogs: () => showLogs(),
  };

  // Serialize all webview-message handling. VSCode's onDidReceiveMessage
  // dispatches concurrently; before this queue, a `save` message and the
  // next mount's `ready` could overlap, with `ready` calling library.loadRom
  // before the in-flight library.writeSave had finished — re-injecting
  // stale save bytes into the emulator.
  let messageQueue: Promise<unknown> = Promise.resolve();
  const handle = async (msg: import("./messages").WebviewToHost) => {
    if (msg.kind === "ready") {
      // Auto-resume the most recently played ROM whenever the webview
      // (re-)mounts. Reading library state on every ready makes us robust
      // to view re-resolution (drag to a different sidebar, etc.).
      await postLibrary();
      // Send persisted bindings before any keystrokes can hit the remap
      // effect — the user's customizations are live from the first frame.
      const cfg = await config.read();
      provider.postMessage({ kind: "bindings", bindings: cfg.bindings });
      provider.postMessage({ kind: "autoShow", enabled: readAutoShow() });
      void postAgentStatus();
      const lib = await library.readLibrary();
      if (lib.lastPlayedHash) await loadAndPostRom(lib.lastPlayedHash);
      // Backfill No-Intro canonical names for ROMs imported before the
      // database existed (or that the previous DB snapshot didn't know),
      // then re-post the library + kick off the cover fetcher.
      void (async () => {
        try {
          await backfillCanonicalNames();
          await postLibrary();
          await ensureCoversInBackground();
        } catch (err) {
          logError("database: backfill failed", err);
        }
      })();
    }
    if (msg.kind === "save") {
      try {
        await library.writeSave(msg.hash, new Uint8Array(msg.bytes));
      } catch (err) {
        logError("library: writeSave failed", err);
      }
    }
    if (msg.kind === "menu") {
      await menuHandlers[msg.action]?.();
    }
    if (msg.kind === "switchRom") {
      // Same hash? Already playing — nothing to do, and triggering a
      // reload would needlessly destroy unsaved IDBFS state.
      if (msg.hash === currentRomHash) return;
      // Persist the user's intent so the post-reload `ready` handler
      // picks the new ROM via `lastPlayedHash`. We don't post a `rom`
      // message: the iframe would set React state to the new ROM but
      // EmulatorJS would keep running the old one (no clean teardown),
      // and the next save flush would write the old game's SRAM under
      // the new hash — corrupting the new game's save file.
      await library.touch(msg.hash);
      provider.postMessage({ kind: "reload" });
    }
    if (msg.kind === "saveBindings") {
      try {
        await config.writeBindings(msg.bindings);
      } catch (err) {
        logError("config: writeBindings failed", err);
      }
    }
    if (msg.kind === "setAgent") {
      try {
        await setExclusiveAgent(msg.agent, msg.enabled);
      } catch (err) {
        logError("hooks: setAgent failed", msg.agent, err);
        void vscode.window.showErrorMessage(
          `Standboy: failed to ${msg.enabled ? "connect" : "disconnect"} ${msg.agent}. Check the logs.`
        );
      }
      await postAgentStatus();
    }
    if (msg.kind === "setAutoShow") {
      try {
        await writeAutoShow(msg.enabled);
      } catch (err) {
        logError("settings: setAutoShow failed", err);
      }
      // onAutoShowChange echoes the persisted value back to the webview,
      // so we don't post here — avoids a stale-state race if the write fails.
    }
  };

  provider.setMessageHandler((msg) => {
    const next = messageQueue.then(() => handle(msg));
    // Swallow rejections in the queue chain so a single failed handler
    // doesn't poison every subsequent message; each call still gets its
    // own promise back through `next`.
    messageQueue = next.catch(() => undefined);
    return next;
  });

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      StandboyViewProvider.viewType,
      provider,
      { webviewOptions: { retainContextWhenHidden: true } }
    ),
    onPaletteChange((palette) =>
      provider.postMessage({ kind: "palette", palette })
    ),
    onAutoShowChange((enabled) =>
      provider.postMessage({ kind: "autoShow", enabled })
    ),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("standboy.libraryDirectory")) {
        library = new Library(resolveLibraryRoot(context));
        config = new Config(library.rootPath);
        void library.ensureDirs();
        log("library: directory changed to", library.rootPath);
        void vscode.window
          .showInformationMessage(
            "Standboy: library directory changed. Reload the window to apply.",
            "Reload"
          )
          .then((choice) => {
            if (choice === "Reload") {
              void vscode.commands.executeCommand(
                "workbench.action.reloadWindow"
              );
            }
          });
      }
    }),
    vscode.workspace.onDidChangeTextDocument((e) => {
      const total = e.contentChanges.reduce((sum, c) => sum + c.text.length, 0);
      if (total === 0) return;
      detector.observe({
        uri: e.document.uri.toString(),
        changeSize: total,
        timestamp: Date.now(),
      });
    }),
    { dispose: () => detector.dispose() },
    { dispose: () => provider.dispose() },
    { dispose: () => sentinelWatcher.dispose() }
  );

  detector.onChange((state) => {
    log("activity", state);
    provider.postMessage({ kind: "activity", state });
    // Read freshly each time so the user can flip the setting without
    // reloading the window — onAutoShowChange will also re-render the
    // webview pill, but the gating decision is always made against disk.
    const intent = focusIntentFor(state, readAutoShow());
    if (intent === "expand") {
      // Skip the focus shift when Standboy is already on screen — the
      // user might be mid-keystroke in the editor and the focus command
      // would yank them into the webview every back-to-back agent turn.
      if (!provider.isVisible()) {
        void vscode.commands.executeCommand("standboy.gameView.focus");
      }
    } else if (intent === "collapse") {
      // Swap back to Explorer, but only when Standboy is actually the
      // visible view. The visibility gate is what makes this safe: if
      // the sidebar is closed or showing something else (user moved on
      // mid-run), `.visible` is false and we don't run the command —
      // so we never pop open a sidebar the user had closed, and never
      // stomp on a view they intentionally switched to.
      if (provider.isVisible()) {
        void vscode.commands.executeCommand("workbench.view.explorer");
      }
    }
  });

  // Forward scheduled-hide events to the webview so it can render the
  // countdown progress bar. Only fires when auto-show is on AND the
  // panel is actually visible — otherwise the announcement is noise.
  detector.onSchedule((pending) => {
    if (!readAutoShow()) return;
    provider.postMessage({
      kind: "closingTimer",
      durationMs: pending?.durationMs ?? null,
    });
  });

  void maybeRunFirstRunSetup(context, postAgentStatus);
}

export function deactivate(): void {
  log("deactivate");
}
