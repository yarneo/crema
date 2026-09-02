# Crema for Decent.app (port in progress)

This directory is the port of Crema from a Tcl **de1app** skin to a **Decent.app /
Decaid** skin. The Tcl skin still lives in [`../skin/Crema`](../skin/Crema) and
still works; nothing here replaces it yet.

## Why port

Decent shipped [Decaid](https://github.com/decentespresso/decaid), a
cross-platform gateway (Android, iOS, macOS, Windows, Linux) that talks to the
DE1 over BLE/USB and exposes a full REST + WebSocket API. Skins are ordinary
static web apps. Every new skin of 2026 was built there.

Practical wins for us:

- **iOS, macOS and Windows for free.** The current skin is Android-tablet only.
- **A real dev loop.** Vite with hot reload, tests in Node, a browser instead of
  `undroidwish`. No more Bluetooth-permission hangs to run a test.
- **Beans, grinders and profiles are platform-level** (`/api/v1/beans`,
  `/api/v1/grinders`, `/api/v1/profiles`), so we stop maintaining our own.

## Platform shape

```
browser (this skin)  ──HTTP/WS──▶  Decaid :8080  ──BLE/Serial──▶  DE1 + scale
```

- REST and WebSocket on port `8080`; interactive API docs on `4001` while Decaid runs.
- Installed skins are served from `localhost:3000` under `web-ui/<manifest id>/`,
  so all asset paths must be **relative** (`base: './'` in `vite.config.ts`).
- Skins install from a GitHub release by `owner/repo`, or from a local folder
  during development.
- A skin may call external APIs directly from the browser, which is how Crema
  keeps bring-your-own-provider and the Mac-server mode.

Key endpoints for us: `/api/v1/workflow` (the recipe we apply),
`/api/v1/profiles` (profile authorship), `/api/v1/shots` (history),
`/api/v1/store/{namespace}/{key}` (our settings), and
`/ws/v1/machine/snapshot` (live shot telemetry).

## Layout

| Path | What lives there |
|---|---|
| `src/domain/` | Pure model: the recipe, the diff, the convergence trail |
| `src/advice/` | Crema's brain: attempt log, prompt building, provider clients |
| `src/test/` | Node tests, no browser or machine required |

## Development

```bash
npm install
npm test          # unit tests (Node's runner, native TS)
npm run build     # typecheck + production bundle into dist/
npm run dev       # Vite on 127.0.0.1:5173
npm run release:zip
```

`npm test` and `npm run build` need neither a machine nor a gateway, which is
the point: the parts that make Crema *Crema* are pure functions and are tested
as such.

## Status

Landing brain-first, because that is the part with real logic and the part
provable without hardware.

- [x] Recipe model and the advice diff, including held fields ([#9](https://github.com/yarneo/crema/issues/9))
- [x] Convergence trail ([#11](https://github.com/yarneo/crema/issues/11))
- [x] Attempt log, so the advisor knows what already failed ([#8](https://github.com/yarneo/crema/issues/8))
- [x] Structured advice schema with evidence windows, tolerant parsing ([#10](https://github.com/yarneo/crema/issues/10))
- [x] Profile authorship parsing, and the grind rules ported from Tcl
- [ ] Gateway client (REST + WebSocket)
- [ ] Provider clients: Anthropic, OpenAI, OpenAI-compatible, Mac server
- [ ] Views, and apply/undo against `/api/v1/workflow` ([#7](https://github.com/yarneo/crema/issues/7))

Design rationale for the port and the UI direction is in the design brief; the
ranked backlog is [issues #7–#16](https://github.com/yarneo/crema/issues).
