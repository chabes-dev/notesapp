# Notes

A personal, Apple Notes–style notes app. Offline, local-only (notes live in the browser's IndexedDB on this computer), installable from Chrome as its own app.

- Live: https://notesapp.marcelogimeneschabes.workers.dev
- Every push to `main` is built and deployed by Cloudflare Workers Builds.
- The installed app updates itself: a new version installs in the background and the window refreshes at a quiet moment.

## Develop

```
npm install
npm run build     # -> dist/ (one self-contained index.html + service worker, manifest, icons)
```
