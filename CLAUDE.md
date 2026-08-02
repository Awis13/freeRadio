# freeRadio — working notes

Node dashboard for the STUDIO 23 streaming stack: an Express API plus a
WebSocket state feed, driving liquidsoap (audio), ffmpeg (video) and icecast
through files and HTTP.

Everything here is a pointer. When a note disagrees with the code, the code is
right — say so rather than working around it.

## Standing rules

- **English only.** No Cyrillic anywhere in the repo — code, comments, commit
  messages, test names. It is checked.
- **Never run `npm install` inside `dashboard/`.** Dependencies resolve from the
  repo root; a `dashboard/node_modules` breaks module resolution in the suite and
  shadows the image's strict install (see `dashboard/.dockerignore`). Root
  installs are fine.
- **Full suite from the root before pushing**, not just the files you touched.
  `npm test`, and `npx vitest run --coverage` when coverage could move.
- **Membership pins are deliberate lists.** `PUBLIC_PATHS`, `CONFIG_FILES`, the
  dashboard dependency set. Adding an entry is meant to require editing a test —
  that is the feature, not friction.

## Layout

`dashboard/server.js` composes the app: middleware, then the auth gate, then the
routers, then one error handler. `dashboard/lib/` holds one module per concern,
each exporting a `create*Router()` where it owns HTTP. `dashboard/routes/` holds
the rest of the routers.

`dashboard/public/` is the browser side: `app.js` is a thin substrate — DOM refs,
a few shared flags, boot order — and every domain lives in its own dual-target
UMD module beside it (`window.FR*` in the browser, `module.exports` under
vitest, no top-level `import`/`export`). `index.html` lists them in load order;
the test harness parses that list rather than keeping its own copy. Modules take
their collaborators through an `init(deps)` call, merged with
`FRUtils.mergeDeps`, which warns on an unknown or undefined key instead of
failing silently.

Cross-cutting pieces worth knowing before changing anything:

- **`lib/paths.js`** — every filesystem location, derived from env. `MUSIC_DIR`
  and friends are mount points *shared between containers*; changing one for the
  dashboard alone desynchronises the handoff. `PROCESSED_DIR` and `ANALYSIS_MAP`
  are derived, not separately configurable.
- **`lib/authGate.js`** — three postures: `token` when `DASHBOARD_TOKEN` is set,
  `open` only when `AUTH_DISABLED` is exactly `'true'`, and `closed` otherwise.
  Closed denies everything; a missing token is not an invitation. Token wins over
  `AUTH_DISABLED`, and `PUBLIC_PATHS` bypasses regardless.
- **`lib/jsonStore.js`** — every JSON store reads and writes through it. Writes
  are atomic (temp sibling, then rename). A corrupt or shape-mismatched file is
  quarantined to `<file>.corrupt-<ts>` and defaults are returned, so one bad file
  cannot take the process down. `lib/syncWatcher.js` restores quarantined files
  from S3 and marks them `.restored`.
- **`lib/httpErrors.js`** — `upstreamError` for 502s (name the upstream; the
  cause goes to the log), and the app-level handler that turns multer and
  body-parser rejections into 400s while letting genuine bugs stay 500s.

## Tests

`tests/dashboard/`, vitest. On vitest's default pool each test file gets its own
isolated environment, so files do not leak into each other; accumulation *within*
a file is the hazard to watch.

Most UI tests are **characterization pins**: they lock behaviour as it is,
including behaviour nobody likes. A pin going red means you changed something —
decide whether that was intended, and if it was, update the pin in the same
commit with a comment saying why. Do not "fix" a pin to make a build green.

- `appBoot.js` boots a jsdom window from the real `index.html` and returns
  `{win, doc, warnings, close}`. Call `close()`; `closeAllWindows()` covers a file.
- `helpers/serverAgent.js` + supertest is the default for **new** router suites —
  it exercises the middleware the router actually runs behind. The older
  `mockRes`/`getRouteHandler` style calls handlers directly and is blind to
  composition; keep it for branch-level pinning on routers already covered
  end-to-end.
- Coverage thresholds in `vitest.config.js` are **floors**, not targets. Totals
  wobble by under a percent between runs on an unchanged tree; do not read that
  as a regression.

**Realm traps.** jsdom runs page code in its own realm, so `setTimeout`,
`Date` and `console.warn` inside a page module are *not* the node globals a test
spies on. Override `win.setTimeout` (not the global), and read page warnings from
the `warnings` array `bootWindow` collects. A `play().then()` continuation can
also outlive `close()` — drain with `flush()` first, or the file ends with an
unhandled error while still reporting green.

## Docker

Images are pinned deliberately (a version tag where one matches, a digest where
none does) with the resolution date and method in a comment beside each. The
streamer encodes in **software** by default; QuickSync is opt-in via
`docker compose -f docker-compose.yml -f docker-compose.hwaccel.yml`, because it
needs a device mount and a host group that not every machine has.
