# Architecture

omp-session-bus is a single omp extension with three cooperating parts:

- [`transport.ts`](../transport.ts) — live-session registry and direct message delivery over Unix domain sockets.
- [`board-store.ts`](../board-store.ts) — persistent, pull-only board posts as immutable JSON files.
- `index.ts` — plugin wiring: registers the plugin's own `session_bus` tool in the extension factory (before any session starts) and wires session lifecycle, dispatch, and the `/sessions` command. See [Plugin wiring](#plugin-wiring).

`board.ts` implements the board operations on top of `board-store.ts` and owns their help text.

## Transport: socket-per-session

Each live omp session owns exactly one Unix socket file `<uuid>.sock` inside a private directory. **The socket file is the registry entry and the message endpoint** — there is no broker, no metadata file, and no polling.

Default directory resolution (`SessionTransport.start`):

1. `OMP_SESSION_BUS_DIR` env override
2. `$XDG_RUNTIME_DIR/omp-session-bus`
3. `/tmp/omp-session-bus-<uid>` (or `/tmp/omp-session-bus` when the UID is unresolvable)

The directory is created `0700`; sockets are `0600`. Before any use, `ensureSafeDirectory` refuses a directory that is a symlink, not owned by the current UID, or group/other-readable. Before dialing out, `assertSafeSocket` applies the same checks to the target socket. These checks are the entire trust boundary — see [SECURITY.md](../SECURITY.md).

### Protocol

Every operation opens a fresh connection, writes exactly one NDJSON request line, half-closes, and reads exactly one NDJSON reply line:

```
request  {"type":"info"}
         {"type":"send","message":{...Envelope}}
reply    {"type":"info","ok":true,"info":{...PeerInfo}}
         {"type":"ack","ok":true,"id":"<message id>"}
         {"type":"error","ok":false,"code":"...","message":"..."}
```

- A send resolves only after the receiving session's `receive` callback settled without error. There is no message log, no automatic reply, and no retry: **an unacknowledged send is ambiguous by design**.
- Per-request budget is 5 seconds on both sides; requests are capped at ~100 KiB (`MAX_FRAME_BYTES`, derived from the 16 KiB body cap plus escaping headroom).
- Inbound concurrency is capped at 32 connections; excess connections receive an `overloaded` error.
- Envelope validation is strict: only known fields (`id`, `from`, `to`, `body`, `replyTo`, `ts`) survive parsing; unknown fields are dropped.

### Discovery

`list()` reads the directory, probes each `*.sock` concurrently (max 8), and returns every socket that answers an `info` probe with a valid `PeerInfo` whose claimed id matches its socket name. Unreachable, unsafe, or garbage peers are skipped — never unlinked. The result is self plus peers, sorted by address.

### Lifecycle and crash behavior

- On `session_start` / `session_switch` / `session_branch`, the plugin stops any prior transport (generation counter guards races) and starts a fresh one; `session_shutdown` closes it.
- `close()` is idempotent: it settles connections, closes the server, and unlinks **only its own** socket file.
- A crashed session leaves a stale socket file behind. Peers never remove it; it disappears on reboot (the default directory is tmpfs or `/tmp`), or you can delete it manually. Discovery always skips it because nothing answers the probe — a stale socket degrades to an invisible no-op, never a misdirected message.
- If the transport cannot start (e.g. unsafe directory), the session runs normally but direct session operations fail with `Session bus unavailable: <reason>`; the board uses a separate storage path and keeps working. The failure is surfaced once as a UI error notification, and omp's native tools are unaffected.

## Board store: one immutable file per post

Posts live in a user-private board directory resolved as:

1. `OMP_SESSION_BOARD_DIR` env override
2. `$XDG_STATE_HOME/omp-session-bus/board`
3. `~/.local/state/omp-session-bus/board`

There is **no manifest, index, or lock** — the directory listing is the catalog.

## Plugin wiring

`index.ts` registers the plugin's own `session_bus` tool synchronously in the extension factory, before any session starts — this is what makes `--tools session_bus` launch filtering work on every supported host. The socket transport and TUI renderers are initialized later, at session start. There is a single code path on every host:

1. **Tool registration.** The tool exposes exactly `sessions`, `send`, `wait`, `list`, and `topics`, with a description embedding the operation guides. It never wraps, replaces, or delegates to omp's native `hub`/`wait` tools; any operation outside the cross-session surface is rejected (`Use sessions/topics, send to session:/board:, wait from session:, or list from board:. Native tools are separate.`).
2. **Approval boundary.** `approval()` classifies `send` to a `board:` address as `write`; every other operation is `read`.
3. **Dispatch.** On execute: `op:sessions` → transport list; board addresses (`board:*` in `to`/`from`, or `op:topics`) → `executeBoard`; `send` to `session:` → direct send; `wait` from `session:` → cross-session wait; anything else is rejected.
4. **Message injection.** Incoming envelopes are delivered as agent-attributed asides through omp's native IRC message cards (idle sessions wake). Pending `wait`/`await` waiters matching the sender resolve first.
5. **`/sessions` command.** Registry listing and manual send, surfaced both as a UI notification and an agent-visible message.
6. **Renderer reuse.** In TUI mode, `host-renderer.ts` reuses the host's native hub/wait tool renderers (`toolRenderers.hub`, falling back to `toolRenderers.wait`) so cross-session calls render like native IRC cards. This is an internal presentation detail, not a public API; the renderer loads lazily at session start and RPC/JSON modes work without it.

Session identity: the transport address `session:<uuid>` is per-process and changes on restart; `PeerInfo.sessionId` carries the saved (persistent) omp session id for correlation across restarts.
