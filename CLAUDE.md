# Notes app — guide for Claude

Marcelo's personal notes app (Apple Notes–like, Spark-style minimal writing). Single-page app, no backend.

## How it ships
- Push to `main` → Cloudflare Workers Builds runs `npm run build`, then `npx wrangler deploy` (Worker `notesapp`, static assets from `dist/`).
- The installed app picks the new version up on its own (service worker + auto-refresh when the user pauses typing). Never ask Marcelo to download/upload files.

## Layout
- `src/app.js` — everything: IndexedDB storage, TipTap editor, panes (side by side), sidebar, sync between windows, auto-update.
- `src/styles.css` — look (warm paper, Fraunces/IBM Plex, sage accent). Light backgrounds only; no grey that looks dirty.
- `src/sw.js` — offline service worker. Shell is cached under `./` and every cached response is stored as a non-redirected copy (Cloudflare redirects /index.html → /; a saved redirect makes Chrome show ERR_FAILED).
- Keyboard shortcuts mirror Apple Notes (support.apple.com/guide/notes/apd46c25187e/mac). Editor ones live in `appleBindings()` and run through `editorProps.handleKeyDown` so they beat TipTap's defaults (e.g. TipTap's ⇧⌘7 = numbered; Apple's = bulleted). App-level ones are in the capture-phase `keydown` listener. ⌘/ shows the cheat sheet — keep it in sync.
- Floating rewrite window (⌥⌘N): `openSandbox()` — Document Picture-in-Picture (always on top), falls back to a popup. Copies the selection (or current paragraph); Replace / Insert below / Start over. Target range is remapped through every transaction of the source editor.
- `build.mjs` — esbuild bundle, inlines JS/CSS/latin fonts into `dist/index.html`, stamps the SW version.

## Rules
- Notes are local-only data. Never change the IndexedDB name (`notes-app`) or note shape in a breaking way without a migration — it would wipe his notes.
- Indentation is a block attribute (`indent`), never a mark, so formatting can't reset it.
- Discuss changes with Marcelo before implementing them.
- Test in headless Chromium before pushing (typing, indent+bold, panes, reload persistence, offline reopen).
