import { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import { send } from "../messaging";
import type { Rom } from "../../src/messages";

interface Props {
  rom: Rom | null;
  dataUrl: string | null;
  loaderUrl: string | null;
  muted: boolean;
}

const CORE_FOR_EXT: Record<Rom["ext"], string> = {
  gb: "gb",
  gbc: "gb",
  gba: "gba",
};

const ASPECT_FOR_EXT: Record<Rom["ext"], string> = {
  gb: "10 / 9",
  gbc: "10 / 9",
  gba: "3 / 2",
};

interface EJSEmscriptenFS {
  analyzePath: (path: string) => { exists: boolean };
  mkdir: (path: string) => void;
  unlink: (path: string) => void;
  writeFile: (path: string, data: Uint8Array) => void;
}

interface EJSGameManager {
  getSaveFile?: () => Uint8Array | null | undefined;
  getSaveFilePath?: () => string;
  loadSaveFiles?: () => void;
  FS?: EJSEmscriptenFS;
  // Browsers suspend the AudioContext until a user gesture — setVolume
  // alone won't make sound, we have to resume() here.
  audioContext?: { state: string; resume: () => Promise<void> };
  // Direct (player, libretroButtonIndex, value) push that bypasses
  // EmulatorJS's keyboard layer. value: 1 pressed / 0 released.
  simulateInput?: (player: number, index: number, value: number) => void;
}

interface EJSEmulator {
  gameManager?: EJSGameManager;
  setVolume?: (volume: number) => void;
}

declare global {
  interface Window {
    // Imperative hook app.tsx uses to synchronously capture SRAM before
    // Export Save / Import Save. Stays wired across rom prop changes.
    __standboyFlushSave?: () => void;
    EJS_player?: string;
    EJS_gameUrl?: string;
    EJS_gameName?: string;
    EJS_core?: string;
    EJS_pathtodata?: string;
    EJS_volume?: number;
    EJS_startOnLoaded?: boolean;
    EJS_threads?: boolean;
    EJS_DEBUG_XX?: boolean;
    EJS_onGameStart?: () => void;
    EJS_emulator?: EJSEmulator;
  }
}

function getSaveBytes(): Uint8Array | null {
  try {
    const get = window.EJS_emulator?.gameManager?.getSaveFile;
    if (typeof get === "function") {
      const bytes = get();
      return bytes && bytes.length > 0 ? bytes : null;
    }
  } catch {
    // EmulatorJS may not be ready yet — fail quietly.
  }
  return null;
}

// Mirrors EmulatorJS's "load savfile" button handler (emulator.js:1968)
// — there is no loadSaveFile(bytes) method despite the symmetric name
// suggested by getSaveFile(). Write to the Emscripten FS at the save
// path, then call loadSaveFiles() (no args) to make the running
// emulator pick them up.
function loadSaveBytes(bytes: Uint8Array): void {
  try {
    const gm = window.EJS_emulator?.gameManager;
    if (!gm?.FS || !gm.getSaveFilePath || !gm.loadSaveFiles) return;
    const path = gm.getSaveFilePath();
    if (!path) return;

    const parts = path.split("/");
    let cp = "";
    for (let i = 0; i < parts.length - 1; i++) {
      if (parts[i] === "") continue;
      cp += "/" + parts[i]!;
      if (!gm.FS.analyzePath(cp).exists) gm.FS.mkdir(cp);
    }
    if (gm.FS.analyzePath(path).exists) gm.FS.unlink(path);
    gm.FS.writeFile(path, bytes);
    gm.loadSaveFiles();
  } catch {
    // EmulatorJS API drift or FS not ready — silently no-op rather than
    // spamming console; missed save-load is annoying but recoverable.
  }
}

function bytesEqual(a: Uint8Array, b: Uint8Array | null): boolean {
  if (!b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function EmulatorHost({
  rom,
  dataUrl,
  loaderUrl,
  muted,
}: Props): ReactElement {
  const containerRef = useRef<HTMLDivElement>(null);
  const blobUrlRef = useRef<string | null>(null);
  // EmulatorJS source files declare top-level `class EmulatorJS`, etc.
  // Loader.js appends them as <script> tags; re-running loader.js would
  // re-declare those globals → `Identifier 'X' has already been declared`.
  // EmulatorJS has no clean public teardown, so we initialise once per
  // webview lifetime. Switching ROMs requires a full webview reload
  // (close + reopen the panel, or reload VSCode).
  const initedRef = useRef(false);
  // The boot effect populates these refs; the lifecycle effect below
  // delegates through them. Decoupling lets the lifecycle listeners
  // survive `rom` prop changes — without these, React's cleanup of the
  // boot effect on a ROM swap would tear down save listeners and never
  // reinstall them (the body short-circuits via `initedRef`).
  const flushSaveRef = useRef<(() => void) | null>(null);
  const bootCleanupRef = useRef<(() => void) | null>(null);
  // VSCode's first activation of a sidebar webview can fire React's
  // useEffect before the layout pass has given the container real
  // dimensions. Booting EmulatorJS against a 0×0 canvas makes RetroArch
  // fail with "Could not get screen dimensions" and "Failed to load
  // content" — the user then has to click another view and back to
  // force a relayout. We wait for the container to have non-zero size
  // before initialising so the first click works on the first try.
  const [containerReady, setContainerReady] = useState(false);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    if (el.clientWidth > 0 && el.clientHeight > 0) {
      setContainerReady(true);
      return;
    }
    const observer = new ResizeObserver(() => {
      if (el.clientWidth > 0 && el.clientHeight > 0) {
        setContainerReady(true);
        observer.disconnect();
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Mount-only. Wires save-flush listeners + __standboyFlushSave global,
  // delegating through flushSaveRef so the boot effect can populate the
  // actual flush function asynchronously. Split out from boot because
  // React tears down boot effects on rom change — those listeners need
  // to survive ROM swaps or save persistence silently breaks.
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === "hidden") flushSaveRef.current?.();
    };
    const onUnload = () => flushSaveRef.current?.();
    document.addEventListener("visibilitychange", onVis);
    // Both `pagehide` and `beforeunload` exist for unload semantics, and
    // browsers/embedded webviews differ on which fires reliably. Listen
    // to both — flushSave is idempotent (dedupes via `lastSentBytes`).
    window.addEventListener("pagehide", onUnload);
    window.addEventListener("beforeunload", onUnload);
    window.__standboyFlushSave = () => flushSaveRef.current?.();
    return () => {
      // Final flush + boot teardown run here so they fire only on real
      // unmount, never on a ROM-prop change.
      flushSaveRef.current?.();
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("pagehide", onUnload);
      window.removeEventListener("beforeunload", onUnload);
      window.__standboyFlushSave = undefined;
      bootCleanupRef.current?.();
    };
  }, []);

  // Runs once when (rom, dataUrl, loaderUrl, containerReady) are all
  // available. Subsequent dep changes hit initedRef and no-op; no
  // cleanup returned, so React doesn't tear down on rom changes. Boot
  // teardown lives in bootCleanupRef, invoked by the lifecycle effect
  // above on real unmount only.
  useEffect(() => {
    if (!rom || !dataUrl || !loaderUrl || !containerRef.current) return;
    if (!containerReady) return;
    if (initedRef.current) return;
    initedRef.current = true;

    // Real-unmount cancel flag. If the lifecycle effect's cleanup fires
    // before the async fetch resolves, the IIFE bails before allocating
    // a blob URL or appending the loader script — otherwise an unmount
    // mid-fetch would leak both.
    let cancelled = false;
    let script: HTMLScriptElement | null = null;
    bootCleanupRef.current = () => {
      cancelled = true;
      script?.remove();
      window.EJS_onGameStart = undefined;
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }
    };

    void (async () => {
      // ROM bytes come in through a webview-resource URI rather than the
      // postMessage payload — a 32MB GBA ROM serialised inline crashed the
      // extension host. Fetch into a Blob, then hand EJS a blob: URL the
      // same way as before.
      let blobUrl: string;
      try {
        const response = await fetch(rom.romUri);
        if (!response.ok) {
          throw new Error(`ROM fetch failed: HTTP ${response.status}`);
        }
        const blob = await response.blob();
        if (cancelled) return;
        blobUrl = URL.createObjectURL(blob);
        blobUrlRef.current = blobUrl;
      } catch (err) {
        console.error("Standboy: ROM fetch failed", err);
        return;
      }

      if (cancelled || !containerRef.current) return;

      const game = document.createElement("div");
      game.id = "game";
      containerRef.current.replaceChildren(game);

      const saveToInject = rom.save ? new Uint8Array(rom.save) : undefined;
      window.EJS_player = "#game";
      window.EJS_gameUrl = blobUrl;
      // EmulatorJS uses gameName to derive the in-FS path for the ROM and
      // the libretro core's save-file path. RetroArch's content loader
      // chokes on special characters (parens, commas, spaces) in those
      // paths and falls back to its main menu instead of starting the
      // game. Use a simple, predictable name; the original filename is
      // still shown in our UI via `rom.name`.
      window.EJS_gameName = `rom.${rom.ext}`;
      window.EJS_core = CORE_FOR_EXT[rom.ext];
      window.EJS_pathtodata = dataUrl;
      window.EJS_volume = muted ? 0 : 0.5;
      window.EJS_startOnLoaded = true;
      // VSCode webviews don't set COOP/COEP headers, so SharedArrayBuffer
      // isn't available. Force EmulatorJS onto the non-threaded core to
      // avoid hanging during decompression while it tries to use SAB.
      window.EJS_threads = false;
      window.EJS_onGameStart = () => {
        if (saveToInject) loadSaveBytes(saveToInject);
        // EJS has copied the ROM into its Emscripten FS by now — release
        // the Blob so the browser can reclaim the ROM-sized buffer that's
        // been parked in the webview heap since fetch. bootCleanupRef's
        // revoke is now a no-op (guarded by the null check).
        if (blobUrlRef.current) {
          URL.revokeObjectURL(blobUrlRef.current);
          blobUrlRef.current = null;
        }
      };

      script = document.createElement("script");
      script.src = loaderUrl;
      script.async = true;
      document.body.appendChild(script);

      // Seed `lastSentBytes` with the save we just loaded so the very first
      // flush doesn't redundantly post the same bytes back to disk.
      let lastSentBytes: Uint8Array | null = saveToInject
        ? new Uint8Array(saveToInject)
        : null;

      const flushSave = () => {
        const bytes = getSaveBytes();
        if (!bytes) return;
        if (bytesEqual(bytes, lastSentBytes)) return;
        // Snapshot detached from EJS's internal buffer for the next compare.
        const copy = new Uint8Array(bytes);
        lastSentBytes = copy;
        // Serialise to number[] for the postMessage bridge — VSCode JSON-
        // encodes between webview and extension host, and Uint8Array
        // doesn't survive that round-trip cleanly.
        send({ kind: "save", hash: rom.hash, bytes: Array.from(copy) });
      };

      // Event-driven save sync — no polling. SRAM lives in EmulatorJS's
      // IDBFS-backed FS (auto-persisted to IndexedDB) at all times, so the
      // game state is never lost between sessions even without a single
      // disk write on our side. We mirror SRAM into `<libraryRoot>/saves/
      // <hash>.sav` only at moments when staleness would actually matter:
      //  - panel becomes hidden (visibilitychange → "hidden")
      //  - page is unloading (pagehide / beforeunload)
      //  - user clicks Export / Import (manual flush via the global hook)
      //  - real component unmount (lifecycle effect's cleanup)
      // The listeners themselves live in the lifecycle effect above and
      // delegate through `flushSaveRef`, so they survive `rom` prop changes.
      flushSaveRef.current = flushSave;
    })();

    // Note: `muted` is intentionally NOT in the deps array. It's read at
    // boot to seed EJS_volume; live mute changes are handled by the
    // separate effect below calling EJS_emulator.setVolume() at runtime.
    // No cleanup is returned — see bootCleanupRef + the lifecycle effect.
  }, [rom, dataUrl, loaderUrl, containerReady]);

  // Live mute toggle. Two things have to happen for audio to actually play:
  // (1) volume needs to be non-zero, and (2) the AudioContext has to be
  // running. Chrome holds it in `suspended` until a real user gesture, so
  // setVolume alone produced silence on the first click — we have to
  // explicitly `.resume()`. The click on the menu's mute toggle counts
  // as the gesture, so this resolves on the same click.
  useEffect(() => {
    const emulator = window.EJS_emulator;
    if (!emulator) return;
    emulator.setVolume?.(muted ? 0 : 0.5);
    if (!muted) {
      const ctx = emulator.gameManager?.audioContext;
      if (ctx && ctx.state === "suspended") void ctx.resume();
    }
  }, [muted]);

  // The screen sits flat on the console body with a recessed inner shadow
  // for depth. No colored bezel — that reads as a sticker, not hardware.
  // Aspect ratio matches the platform so we never get black side-bars.
  return (
    <div
      ref={containerRef}
      className="overflow-hidden"
      style={{
        background: "#000",
        borderRadius: "10px",
        aspectRatio: rom ? ASPECT_FOR_EXT[rom.ext] : "10 / 9",
        boxShadow:
          "inset 0 2px 4px rgba(0,0,0,0.6), 0 0 0 1px rgba(0,0,0,0.4), 0 1px 0 rgba(255,255,255,0.04)",
      }}
    >
      {!rom && (
        <div
          className="flex h-full items-center justify-center text-[10px] tracking-[0.2em] uppercase"
          style={{ color: "rgba(255,255,255,0.35)" }}
        >
          no cartridge
        </div>
      )}
    </div>
  );
}
