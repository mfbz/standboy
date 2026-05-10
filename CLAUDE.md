# CLAUDE.md

## Project

Standboy is a VSCode/Cursor extension that auto-expands a Game Boy emulator panel while an AI coding agent is generating, and auto-collapses when it stops. The product is the shell + behavior — agent-activity detection, the auto-show/hide UX, brand chrome — wrapped around a third-party emulator (EmulatorJS).

**Read first:** `SPECS.md` (product spec), `design.html` (visual identity), `media/icon.svg` (canonical icon; rendered to `media/icon-{128,512,1024}.png`).

## Tech stack

- TypeScript (strict), VSCode Extension API ≥1.95, esbuild (extension host CJS + webview IIFE).
- React 19 + Tailwind v4 in the webview. `lucide-react` for iconography.
- EmulatorJS as npm deps (`@emulatorjs/emulatorjs` + `core-gambatte` + `core-mgba`). `scripts/vendor-emulatorjs.mjs` copies from `node_modules/@emulatorjs/*` into `vendor/emulatorjs/` before every `compile` / `build` / `watch`. `vendor/` is gitignored but ships in the `.vsix`.
- **No-Intro ROM database** (`scripts/build-rom-db.mjs`) fetches DATs from a pinned commit of `libretro/libretro-database`, parses to compact `sha1 → canonical name` JSON. Output at `data/rom-db/{gb,gbc,gba}.json` is **committed** (not gitignored, unlike `vendor/`) so builds are deterministic and offline. Refresh by bumping the SHA in the script and running `npm run rom-db`; commit the resulting JSON diff alongside the SHA bump.
- Vitest, Prettier, ESLint, GitHub Actions (build / format / test / release).

## Architecture

- Single-package flat repo. Extension host code under `src/` (Node), webview code under `webview/` (browser). Both share `src/messages.ts` as the postMessage type contract.
- Palette via four CSS custom properties (`--sb-c0..c3`). Switching palette updates the four variables — no React re-render of chrome.
- **ROM library (`src/library.ts`).** All persistent user data lives under one root, pointable at iCloud/Dropbox/etc. via `standboy.libraryDirectory`:
  - `<libraryRoot>/library.json` — index. Each entry: `name` (original filename), `canonicalName?` (No-Intro from rom-db), `ext`, `size`, `addedAt`, `lastPlayedAt`. `lastPlayedHash` at top level for auto-resume.
  - `<libraryRoot>/config.json` — user settings (key bindings today; future global prefs). Versioned envelope.
  - `<libraryRoot>/roms/<hash>.<ext>` — ROM file, content-addressed by SHA-256 first 16 hex (rename-resilient).
  - `<libraryRoot>/saves/<hash>.sav` — battery save mirror.
  - `<libraryRoot>/covers/<hash>.png` (or `.miss` marker) — fetched libretro box art.
- **Hash-based ROM identification (`src/database.ts`).** On import, the full SHA-1 of ROM bytes is matched against the bundled No-Intro DBs. Hits give us the canonical filename, used for (a) friendly display title (`friendlyName()` strips region/revision tags) and (b) the cover lookup against libretro-thumbnails. ROMs not in the DB (homebrew, hacks) fall back to the user's filename. `extension.ts` runs a one-time `backfillCanonicalNames()` on activate to retroactively identify pre-database imports.
- **Save persistence.** EmulatorJS auto-persists SRAM to the browser's IndexedDB via IDBFS (`autoPersist: true` in `vendor/emulatorjs/data/src/GameManager.js`) — that's why "Continue" works even if our disk file is empty. Our `<hash>.sav` is a portable mirror, written **event-driven, no polling** — on `visibilitychange→hidden`, `pagehide`/`beforeunload`, EmulatorHost cleanup, and force-flushed before Export Save / Import Save (via `window.__standboyFlushSave`). The extension serializes all webview→host messages through a single promise chain so a save's `writeFile` always completes before the next `ready`'s `loadRom` reads.
- **Cover fetcher (`src/covers.ts`).** Tries the canonical name first, then progressively-stripped variants of the user's filename. Network calls happen in the extension host; webview only loads cached files via `asWebviewUri`. CSP stays locked-down. Concurrency 4, `coverUpdate` messages stream back to the grid as art lands.
- **Auto-show.** Sidebar `WebviewViewProvider` in primary activity bar with `retainContextWhenHidden: true`. Auto-expand on activity = `vscode.commands.executeCommand("standboy.gameView.focus")`; auto-collapse = focus `workbench.view.explorer`. Gated by the `standboy.autoShow` boolean setting (default `true`); when off, the activity dot still pulses but no focus events fire. State is driven by `ActivityDetector` (`src/activity.ts`), which OR's two independent signals:
  - **Override (authoritative).** A sentinel file at `~/.standboy/agent-active`, written/deleted by the user's agent via lifecycle hooks. `src/agent.ts` watches it via `vscode.workspace.createFileSystemWatcher`. Trusted when present, but **both edges are debounced** (`showDelayMs: 5000`, `hideDelayMs: 5000`) so trivial agent turns never strobe the panel and back-to-back turns hold it open without flicker. Detector exposes a separate `onSchedule` callback that fires when a hide is queued (with `durationMs`) so the webview can render a countdown progress bar and the user isn't surprised by the focus shift.
  - **Burst (heuristic fallback).** Edit-burst detector — multi-character changes within a 1.5s window — for users who haven't connected an agent in the Detection menu, or for agents we don't have specific hook support for.
- **Agent-detection setup (`src/hooks.ts`).** Lives entirely in the menu drawer's **Detection** section — there is no command-palette entry (`contributes.commands` is empty). Host exposes `getAgentStatus()` (returns `{ claude: { detected, connected }, cursor: { detected, connected } }`) and `setExclusiveAgent(agent, enabled)`. **Mutually exclusive by design**: connecting one agent disconnects the other so the two never share the sentinel file at `~/.standboy/agent-active` — a stop hook from agent A can't race a start hook from agent B and prematurely hide the panel. Internal helpers `setClaudeHooks` / `setCursorHooks` are exported for tests; production code goes through `setExclusiveAgent`. The webview pulls status on `ready` (and after every toggle) via the `agentStatus` host→webview message, sends `setAgent` webview→host to flip a single agent. Detection logic: Claude Code present if `~/.claude/settings.json` or `~/.claude/projects/` exists; Cursor present if `vscode.env.appName.toLowerCase().includes("cursor")`. When neither is detected, the section renders an empty-state line; Standboy still works as a manual emulator, auto-show just stays off.
  - **Claude Code** → `~/.claude/settings.json`. Events: `UserPromptSubmit` + `PreToolUse` (start), `Stop` (stop). Schema is `{ hooks: { <event>: [{ matcher?, hooks: [{type:"command", command}] }] } }` — we append rather than replace, identifying our entries by `command` containing the absolute marker path.
  - **Cursor** → `~/.cursor/hooks/hooks.json`. Events: `beforeSubmitPrompt` (start), `afterAgentResponse` + `sessionEnd` (stop, the second is a safety-net). Schema is `{ version, hooks: { <event>: { command } | [{ command }] } }` — single object becomes an array if a user hook is already present so both fire.
  - The marker script (`~/.standboy/marker.cjs`) is **embedded as a string constant** in `src/agent.ts` and written out at activation. Doing it that way means uninstalling the extension can't leave hook commands pointing at a vanished `extensionPath/...` script. `extension.ts` calls `ensureMarkerInstalled()` at activation regardless of whether the user has connected an agent, so the FileSystemWatcher's parent dir always exists on first install.
  - Both install and uninstall are **idempotent and no-op-when-nothing-changed** (a `mutated` flag avoids spurious atomic writes).
  - **No automatic cleanup on extension uninstall.** VSCode's `vscode:uninstall` lifecycle is unreliable (microsoft/vscode#155561, #102260 — extension dir is deleted before the hook script runs; both still open as of 2026), and there is no other API that distinguishes uninstall from quit in `deactivate()`. Every comparable extension (Continue.dev, Cline, etc.) takes the same approach.
  - **First-run setup (`maybeRunFirstRunSetup` in `extension.ts`).** On fresh install, gated by `standboy.firstRunCompleted` in globalState. Auto-focuses the panel via `standboy.gameView.focus`, then opens a modal welcome dialog with action buttons for each detected agent. Clicking a button calls `setExclusiveAgent` directly. The dialog's body text includes the cleanup convention ("disconnect there before uninstalling") so the user reads it once at the moment they're configuring the hooks. Existing users (already-connected) skip the dialog entirely. Users with no detected agent get an informational dialog explaining the manual-emulator fallback.

## Code conventions

- **Filenames: kebab-case.** e.g. `webview/components/standby-dot.tsx`, `scripts/vendor-emulatorjs.js`. Exceptions: conventional uppercase docs (`README.md`, `LICENSE`, `CHANGELOG.md`, `CLAUDE.md`, `SPECS.md`) — external tooling expects those names.
- **Prefer single-word filenames in `src/`.** `agent.ts`, not `agent-detection.ts`; `hooks.ts`, not `setup-hooks.ts`; `database.ts`, not `rom-db.ts`. If a single word collides with another module (e.g. `library-root` next to `library`), pick a different single word that captures the file's role (`root.ts`). Multi-word kebab-case is fine in `webview/components/` where compound names communicate the UI element.
- **Identifiers: PascalCase** for React components and classes (`StandbyDot`, `ActivityDetector`); camelCase for functions and variables.
- **Tests co-located** with source: `src/activity.test.ts` lives next to `src/activity.ts`. Vitest picks up `src/**/*.test.ts`. Tests do not ship in the `.vsix` (`.vscodeignore` excludes `src/**`).
- Strict TypeScript. No `any`; prefer `unknown` at boundaries.
- **Comments: single-line `//` only, never `/** _/`or`/_ _/`.** Multi-line context uses consecutive `//`lines. Default is no comment — write one only when the WHY is non-obvious (hidden constraint, subtle invariant, workaround for a specific bug). Don't restate what the code already says. Drop`@param`/`@returns`JSDoc tags entirely — TypeScript types are the documentation. CSS files are the only exception (CSS only supports`/_ \*/`).
- **Never put comments before imports.** Imports come first at the top of the file (after a shebang line if present). Any file-level explanation goes _after_ the import block. The very first non-shebang line is `import` or a top-of-file declaration, never a comment.

## Hard rules

- **Never bundle ROMs.** ROMs are user-supplied via file picker. No README links to ROM sources. (The bundled No-Intro DB only stores `sha1 → canonical filename` mappings — metadata, not ROM bytes.)
- **No Cursor-specific APIs.** Same `.vsix` ships to both VSCode and Cursor.
- **Don't touch game output colors.** The palette system applies only to chrome (panel background, dot, borders, buttons, frame). The emulator renders native fidelity.
- **Avoid Ctrl+ key bindings.** VSCode reserves many globally; they won't reach the webview.
- **Never run `git commit` or `git push`.** Read/staging commands are fine; the user controls commits.

## Brand / visual

- **Icon and brand mark are fixed Kirokaze:** `#332c50` (purple), `#e2f3e4` (cream), `#94e344` (green). Source: `media/icon.svg` (1024×1024, 225px corner radius). Never recolored, never effected (no shadows, glows, gradients).
- **In-product chrome palette is user-configurable** via `standboy.palette` (kirokaze / dmg / pocket / bgb / mist) or `standboy.customPalette` (4 hex codes). The brand mark stays Kirokaze regardless of user palette.
- **Type:** system-default sans-serif stack (`-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`). No pixel fonts anywhere.
- **Voice:** refer to Standboy as "he" where it sounds natural. Sentence case in all UI copy. Required disclaimer in README and marketplace listing: "Standboy is not affiliated with or endorsed by Nintendo. Game Boy is a trademark of Nintendo Co., Ltd."

## Working principles

Minimum code to solve the problem. No abstractions for single-use code. No defensive code for impossible scenarios. Surgical changes — touch only what the task requires. When uncertain, ask before assuming.
