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
import type {
  Agent,
  AgentStatus,
  LibraryEntry,
  MenuAction,
  Rom,
} from "./messages";

const COVER_FETCH_CONCURRENCY = 4;

const FIRST_RUN_KEY = "standboy.firstRunCompleted";
const CONNECT_CTA_DISMISSED_KEY = "standboy.connectCtaDismissed";
const CLEANUP_TIP_SHOWN_KEY = "standboy.cleanupTipShown";

// On fresh install just reveal the panel — the in-panel ConnectCta picks
// up from here. We used to fire a modal welcome dialog with action buttons,
// but that asked users to commit to writing hook config into ~/.claude or
// ~/.cursor before they'd even seen what Standboy is, and the cleanup tip
// landed before they had any concept of "connected."
async function maybeRevealPanelOnFirstRun(
  context: vscode.ExtensionContext
): Promise<void> {
  if (context.globalState.get<boolean>(FIRST_RUN_KEY)) return;
  await context.globalState.update(FIRST_RUN_KEY, true);
  void vscode.commands.executeCommand("standboy.gameView.focus");
}

// Computes which agents to offer in the in-panel CTA. Returns one button
// per detected-and-not-connected agent so the user picks which one to wire
// up (running in Cursor *with* Claude Code installed is a real combo and
// the choice is theirs to make). Returns an empty array when the CTA
// should not show — either no agent is detected, one is already connected
// (the feature is already configured), or the user dismissed the prompt.
// Cursor comes first when both detected since `cursor.detected` only goes
// true when the host process literally is Cursor — the user is presumably
// using it as their primary agent.
// Exported for testing.
export function pickCtaAgents(
  status: AgentStatus,
  dismissed: boolean
): Agent[] {
  if (dismissed) return [];
  if (status.claude.connected || status.cursor.connected) return [];
  const agents: Agent[] = [];
  if (status.cursor.detected) agents.push("cursor");
  if (status.claude.detected) agents.push("claude");
  return agents;
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
      const dismissed = context.globalState.get<boolean>(
        CONNECT_CTA_DISMISSED_KEY,
        false
      );
      const agents = pickCtaAgents(status, dismissed);
      // Single line in Show logs makes "why isn't the CTA showing?" trivial
      // to debug: status + dismissed + computed agents all on one row.
      log(
        "agentStatus",
        JSON.stringify(status),
        "ctaDismissed",
        dismissed,
        "ctaAgents",
        JSON.stringify(agents)
      );
      provider.postMessage({ kind: "connectCta", agents });
    } catch (err) {
      logError("hooks: status read failed", err);
    }
  }

  // Fires the one-shot "disconnect before uninstalling" tip on the first
  // successful connect from any flow (CTA button or Detection menu). We
  // wait for actual connect — surfacing this before the user has any
  // concept of "connected" makes the message rot in their working memory.
  async function maybeShowCleanupTip(): Promise<void> {
    if (context.globalState.get<boolean>(CLEANUP_TIP_SHOWN_KEY)) return;
    await context.globalState.update(CLEANUP_TIP_SHOWN_KEY, true);
    provider.postMessage({ kind: "cleanupTip" });
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
      // Upgrade-cohort backfill: users who connected via the old install-time
      // modal are already `connected=true` but predate the cleanupTipShown
      // flag, so they'd never see the tip otherwise. Fire it once on first
      // ready of the new version; `maybeShowCleanupTip` is one-shot, so
      // returning users won't get it repeatedly.
      void (async () => {
        const status = await getAgentStatus();
        if (status.claude.connected || status.cursor.connected) {
          await maybeShowCleanupTip();
        }
      })();
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
      const lib = await library.readLibrary();
      const next = lib.roms[msg.hash];
      if (!next) return;
      // If a game is currently running, confirm before reloading. The
      // webview already flushed the running session's save before posting
      // switchRom (see app.tsx onSwitchRom), so cancelling here is
      // non-destructive — the user just keeps playing the current ROM.
      if (currentRomHash && currentRomHash !== msg.hash) {
        const current = lib.roms[currentRomHash];
        const nextName = friendlyName(next.canonicalName ?? next.name);
        const currentName = current
          ? friendlyName(current.canonicalName ?? current.name)
          : "the current game";
        const choice = await vscode.window.showWarningMessage(
          `Switch to ${nextName}?`,
          {
            modal: true,
            detail: `${currentName} will stop. Your progress is saved.`,
          },
          "Switch"
        );
        if (choice !== "Switch") return;
      }
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
      let ok = false;
      try {
        await setExclusiveAgent(msg.agent, msg.enabled);
        ok = true;
      } catch (err) {
        logError("hooks: setAgent failed", msg.agent, err);
        void vscode.window.showErrorMessage(
          `Standboy: failed to ${msg.enabled ? "connect" : "disconnect"} ${msg.agent}. Check the logs.`
        );
      }
      // Ordering is load-bearing here, do not reshuffle:
      //   1. Persist `connectCtaDismissed=true` so `postAgentStatus` below
      //      recomputes the CTA target as an empty array. Without this the
      //      webview could see `connectCta` with non-empty agents re-asserted
      //      right after it optimistically hid the CTA.
      //   2. `postAgentStatus` flushes both the new status AND the recomputed
      //      `connectCta:{agents:[]}` to the webview.
      //   3. ONLY THEN post `cleanupTip`, so the toast (which preempts the
      //      CTA in the render slot) lands after the CTA has cleared. If we
      //      posted the tip first, the webview would render the toast while
      //      the CTA was still its current state — but then the empty
      //      `connectCta` would arrive in the same render cycle and there'd
      //      be a one-frame flicker. Keeping the order matches the FIFO
      //      postMessage delivery contract.
      // First-connect also retires the CTA permanently — the user has
      // discovered the feature, so a later disconnect shouldn't re-prompt.
      if (ok && msg.enabled) {
        await context.globalState.update(CONNECT_CTA_DISMISSED_KEY, true);
      }
      await postAgentStatus();
      if (ok && msg.enabled) await maybeShowCleanupTip();
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
    if (msg.kind === "dismissConnectCta") {
      // We deliberately do NOT fire the cleanup tip here. The tip warns the
      // user to disconnect before uninstalling — meaningless if they never
      // connected in the first place. If they later connect via the menu,
      // the setAgent handler above takes care of it.
      await context.globalState.update(CONNECT_CTA_DISMISSED_KEY, true);
      // Re-post so the CTA hides immediately. postAgentStatus computes the
      // CTA target from (status + dismissed flag), so the next call will
      // correctly send `agent: null`.
      await postAgentStatus();
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

  void maybeRevealPanelOnFirstRun(context);
}

export function deactivate(): void {
  log("deactivate");
}
