# Architecture

omp-session-bus is a single omp extension whose parts cooperate:

- [`transport.ts`](../transport.ts) — live-session registry and direct message delivery over Unix domain sockets.
- [`board-store.ts`](../board-store.ts) — persistent, pull-only board posts as immutable JSON files.
- `index.ts` — plugin wiring: registers the plugin's own `session_bus` tool in the extension factory (before any session starts) and wires session lifecycle, dispatch, and the `/sessions` command. See [Plugin wiring](#plugin-wiring).

`board.ts` implements the board operations on top of `board-store.ts` and owns their help text. `board-watch.ts` implements the opt-in board watches (see [Board watches](#board-watches)): in-process subscriptions that deliver matching new posts to their own session as asides. Watch state lives only in the session process — nothing about watches is persisted to the board directory. `broadcast.ts` implements the `session:all` announcement fan-out (see [Broadcast](#broadcast)).

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
- Per-request budget is 5 seconds on both sides; frames are capped at 124 KiB (`MAX_FRAME_BYTES`), allowing JSON escaping of the 16 KiB body and 4 KiB sender title plus envelope metadata.
- Inbound concurrency is capped at 32 connections; excess connections receive an `overloaded` error.
- Envelope validation is strict: only known fields (`id`, `from`, `senderTitle`, `to`, `body`, `replyTo`, `broadcast`, `ts`) survive parsing; unknown fields are dropped. `senderTitle` is optional for older peers and captured from the sender's current session name before each send. It is a display label, never an authenticated identity or routing key.

### Discovery

`list()` reads the directory, probes each `*.sock` concurrently (max 8), and returns every socket that answers an `info` probe with a valid `PeerInfo` whose claimed id matches its socket name. Unreachable, unsafe, or garbage peers are skipped — never unlinked. The result is self plus peers, sorted by address.

### Broadcast

`broadcast.ts` implements the `session:all` fan-out on top of the transport:

- **Snapshot-then-send.** Each call takes one fresh `list()` discovery snapshot, drops the sender, and optionally narrows by an exact absolute `cwd` string comparison. Only those recipients are dialed — sessions that start later are never included, and there is no queue, replay, or future-arrival delivery. An empty snapshot is a valid broadcast with zero receipts.
- **Bounded fan-out.** Recipients are dialed by at most 8 concurrent workers sharing a work queue; each recipient gets exactly one attempt, and the shared failure semantics of a single send apply per recipient. Cancellation before or during discovery aborts with an error and no receipts; during the send phase it is recorded per recipient (`attempted:false` for turns that never came).
- **Receipts.** The result carries the snapshot (`recipients`), one `messageId` shared by every recipient, and one receipt per recipient (`to`, `outcome` `injected`/`failed`, `attempted`, `error?`, `messageId?`). One failed receipt marks the whole call `isError: true`. The announcement body is prefixed with a fixed `Broadcast announcement — no reply expected.` header (counted against the 16 KiB body cap) so older recipients that lack the wire marker still see the intent in plain text.
- **Wire marker.** The transport carries `broadcast:true` on the envelope. New recipients render the aside as a broadcast announcement and exclude it from direct-message waiter resolution; older plugin versions drop the unknown field (strict parsing) and treat the message as an ordinary direct message aside — the header text is the compatibility fallback.

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

1. **Tool registration.** The tool exposes exactly `sessions`, `send`, `wait`, `list`, `topics`, `watch`, `watches`, and `unwatch`, with a description embedding the operation guides. It never wraps, replaces, or delegates to omp's native `hub`/`wait` tools; any operation outside the cross-session surface is rejected with an error that lists the supported operations and notes that native tools are separate.
2. **Approval boundary.** `approval()` classifies `send` to a `board:` address as `write`, and `send` to `session:all` as `write` unless it is a `preview` (read); every other operation is `read`. The host's approval policy determines what confirmation each tier requires.
3. **Dispatch.** On execute: `op:sessions` → transport list; board addresses (`board:*` in `to`/`from`, or `op:topics`) → `executeBoard`; `op:watch`/`op:watches`/`op:unwatch` → board watch manager; `send` to `session:all` → `broadcast()`; `send` to `session:` → direct send; `wait` from `session:` → cross-session wait; anything else is rejected.
4. **Message injection.** Incoming envelopes are delivered as agent-attributed asides through omp's native IRC message cards (idle sessions wake). Pending `wait`/`await` waiters matching the sender resolve first — broadcast-marked envelopes are excluded, so a broadcast never satisfies a direct-message waiter. Board watch notifications use the same injection path and the same native rendering.
5. **`/sessions` command.** Registry listing and manual send, surfaced both as a UI notification and an agent-visible message.
6. **Renderer reuse.** In TUI mode, `host-renderer.ts` reuses the host's native hub/wait tool renderers (`toolRenderers.hub`, falling back to `toolRenderers.wait`) so cross-session calls render like native IRC cards. This is an internal presentation detail, not a public API; the renderer loads lazily at session start and RPC/JSON modes work without it.

Sender display labels contain a terminal-safe title followed by the full sender address.
The native renderer clips overflowing headers to the available width; titles are bounded
to 40 grapheme clusters for display. No clipped value is written back into the transport
envelope or tool-result routing fields. Incoming custom-message details retain the complete
reply address as `senderAddress`, while `from` is the native card's display label.

Session identity: the transport address `session:<uuid>` is per-process and changes on restart; `PeerInfo.sessionId` carries the saved (persistent) omp session id for correlation across restarts.

## Board watches

`board-watch.ts` implements opt-in, nonblocking subscriptions to board activity. Nothing is subscribed by default; publishing semantics are unchanged — a publish writes the same immutable post file and only opted-in watcher sessions are additionally woken.

- **In-process only.** Each watch lives in the session that created it. Watch state is never written to disk, never shared between sessions, and dies with the process: restart, resume, switch, or branch clears all watches, with no replay of posts that appeared while the watch was gone. A new watch starts empty and delivers only posts published after it was created.
- **Matching.** A watch matches posts from `board:<topic>` or `board:all`, filtered (AND) by an optional case-insensitive literal `grep` over body/topic/author name, an optional `author` exact session-ID-or-name, ignoring posts authored by the watching session itself. Overlapping watches deliver a matching post once.
- **Detection.** Watches combine filesystem events on the board directory with a 2-second reconciliation pass that catches missed/coalesced events while a watch is active. Both stop when no watches remain. The model never polls. The initial committed-file snapshot is the new-post boundary; older files are excluded without relying on timestamps or lexical ID ordering.
- **Delivery.** Matching posts are injected through the same native aside path as direct session messages (native rendering retained; idle sessions wake). Brief bursts are batched within a 200 ms window into one notification chunk (≤ 20 posts / ~64 KiB); larger backlogs arrive as successive chunks. If the watch manager fails, all of the session's watches are closed and a UI error is surfaced.
- **Lifetime.** A watch runs for the session's lifetime unless `ttl` (seconds, 1..31536000) expires it first; expiry is silent. At most 64 watches per session. `op:watches` lists them; `op:unwatch` stops one by id.
- **Cost.** A wakeup feeds a matching post into the session's context like any agent input; an idle wakeup runs a model turn, which can incur model cost. The manager never replies or posts autonomously; it cannot prevent users or agents from repeatedly posting reactions — own-post exclusion and dedup reduce such repost loops but do not eliminate them.
