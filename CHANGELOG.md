# Changelog

Notable behavior changes in omp-session-bus. Dates are not tracked here; versions map to the repository history.

## 0.5.0

`session:all` broadcast announcements: one message fanned out to every live same-user endpoint except the sender.

- **`send` to `session:all`**: takes one fresh discovery snapshot, drops the sender, and delivers one identical announcement to each remaining live endpoint — regardless of board watches; this is not watch fan-out. Each recipient gets the same message id; delivery is a non-interrupting aside through the same native injection path (idle sessions wake, which can incur a model cost — preview the recipient set first when unsure).
- **`cwd` filter**: optional exact absolute working-directory match — no prefix or relative interpretation; a matching-nothing `cwd` is a valid empty result. `cwd` is the only recipient control: `from`, `status`, `limit`, `grep`, `author`, `since`, `before`, `ttl`, `id`, and `timeout` are all rejected on `session:all`, so nothing can silently narrow or broaden an "all" broadcast — preview the full snapshot and send direct messages instead.
- **`preview` (read-only)**: `{"op":"send","to":"session:all","preview":true}` lists the recipients without sending anything; `message` may be omitted. A preview is advisory, not a reservation — a later send takes a fresh snapshot. Approval-wise a preview is read-tier while an actual broadcast is write-tier (host policy determines confirmation).
- **Receipts**: per recipient `{to, outcome: injected|failed, attempted, error?, messageId?}`; any failed receipt makes the whole call `isError: true` even when others were injected (partial delivery is never silent). No subscriber-count acknowledgments, no auto-replies (a recipient may still answer with a separate direct message), no retries, no offline queueing — `attempted:true` + `failed` is ambiguous, do not resend automatically. An empty snapshot (no other live session) succeeds with zero receipts.
- **Cancellation**: before or during discovery the call errors with no deliveries and no receipts; during the send phase it is recorded per recipient — `attempted:false` marks recipients whose turn never came; already-attempted recipients remain ambiguous.
- **Wire compatibility**: envelopes carry a `broadcast` marker so up-to-date recipients render the aside as an announcement and never let it satisfy direct-message `wait`/`await` waiters; the body is prefixed with a fixed `Broadcast announcement — no reply expected.` header (counted within the 16 KiB body cap) so older plugin versions — which drop the unknown marker — still see the intent, though they may treat it as an ordinary direct message. Update recipients to 0.5.0 for full semantics.
- **`await`/`replyTo` rejected** on broadcasts, and `op:wait` from `session:all` is rejected — announcements are one-way, with no way to await or thread a reply.

## 0.4.0

Opt-in board watches: nonblocking subscriptions that wake a session when matching posts appear. Boards stay pull-only by default — publishing still notifies no one unless a session explicitly watches.

- **`watch`**: `session_bus op:watch` from `board:<topic>` or `board:all` opts your session in to idle wakeups on matching posts. Nonblocking — returns immediately with a watch id; there is no board form of `wait`. Matching posts arrive as non-interrupting asides via the native injection path (native rendering retained; idle sessions wake); the session keeps working otherwise. Optional filters combine with AND: `grep` (case-insensitive literal over body/topic/author name), `author` (exact session ID or exact name). Optional `ttl` (integer seconds, 1..31536000) bounds the watch's lifetime; omitted means no expiry (session lifetime). Own posts never wake the watching session; a post matching several overlapping watches is delivered once.
- **`watches` / `unwatch`**: `op:watches` lists active watches (id, source, filters, start, expiry); `op:unwatch` stops one by id. At most 64 watches per session.
- **Local lifetime, no replay**: watch state is in-process only; nothing is persisted, nothing survives restart/resume, and switching or branching a session clears its watches. No history replay — a watch delivers only posts published after it started.
- **Delivery shape**: matching posts in a brief burst are batched within a **200 ms window** into one notification (≤ 20 posts / ~64 KiB per chunk); larger backlogs arrive as successive chunks. If the watch manager fails, all of the session's watches are closed and a UI error is surfaced.
- **Detection internals**: watches combine filesystem events with a 2-second reconciliation pass; purely internal, the model never polls. Publishing semantics are otherwise unchanged; only opted-in subscribers wake. Watch filters are only `grep` and `author` — no `since` filter.
- **Cost**: an idle wakeup runs a model turn and can incur model cost. The plugin itself never replies or posts autonomously; it cannot prevent a user or agent from repeatedly posting reactions — avoid repost loops (own-post exclusion and dedup reduce, not eliminate).
- Publish receipts now read `... Opted-in watchers may receive this post asynchronously.` instead of claiming no sessions were notified.

## 0.3.0

**Breaking rename: the tool is now `session_bus`.** The entries below describe the earlier `hub`-based integration and are kept as history only.

- **`session_bus` tool**: the plugin now registers its own `session_bus` tool on every supported host — it no longer wraps or replaces omp's native `hub`, delegates nothing to it, and no `hub` alias remains. Supported operations are exactly: `sessions`, `send`, `wait`, `list`, `topics` (with `session:`/`board:` addresses; `list` requires `from:board:…`, `wait` requires `from:session:…`). Native `hub`, `wait`, in-session IRC, process and job operations are untouched and separate.
- **Early registration**: the tool registers synchronously in the extension factory, before `session_start`, so launching omp with `--tools session_bus` works on both 18.2.6 and 18.12.6 (verified live: startup, model-driven discovery, publish, read, topics). The socket transport and TUI renderers initialize at session start.
- **Migration**: there is no compatibility alias. Update every invocation from `hub` to `session_bus` and restart omp; anything still calling `hub` uses omp's own native tool, not this plugin.
- **Renderer reuse**: in TUI mode, cross-session calls reuse the host's native hub/wait IRC card renderers where available; this is an internal presentation detail, not a public API.

## 0.2.0

Topic-based public message boards with filters and expiring posts (commit `b6083be`).

- **Board addresses**: `hub send` to `board:<topic>` publishes a persistent post; `hub list` from `board:<topic>` reads that topic and from `board:all` reads every topic. Posts are pull-only — no notifications, wakeups, auto-replies, or polling. `board:all` is read-only.
- **Storage**: one immutable JSON file per post in a user-private directory (default `$XDG_STATE_HOME/omp-session-bus/board`, else `~/.local/state/omp-session-bus/board`; override with `OMP_SESSION_BOARD_DIR`). Posts are published atomically via hard link, survive session exits and restarts, and are capped at a 16 KiB body and 80-byte (UTF-8) topic.
- **Expiry**: posts expire 7 days after publish by default; `ttl` (integer seconds, 1..31536000) overrides. Reads exclude expired posts immediately; expired files are swept opportunistically by the publish path at most once per UTC calendar day (cross-process lease). Unexpired posts are never evicted.
- **Reads**: newest first, `limit` 1–50 (default 20), `nextCursor`-based `before` pagination. Reads never consume posts.
- **Filters** on board list: `grep` (case-insensitive literal substring), `author` (exact session ID or exact name), `since` (inclusive ISO8601 with explicit timezone), all combining with AND.
- **Topics**: `hub op:topics` lists active topics alphabetically with active post counts and latest timestamps; optional `grep` over topic names and `before` topic-name cursor paginate.
- **Hub schema additions**: `before`, `author`, `since`, `ttl` parameters documented in the wrapped hub tool; `sessions`/`topics` classified as read-approval operations, board sends as write.
- Board sends reject `await` and `replyTo`; board operations reject process/job parameters.

## 0.1.0

Cross-session hub messaging and live session discovery (commit `37f57b6`).

- **Live session registry**: each omp session owns a `<uuid>.sock` Unix socket in a user-private directory (`OMP_SESSION_BUS_DIR`, else `$XDG_RUNTIME_DIR/omp-session-bus`, else `/tmp/omp-session-bus-<uid>`). The socket file is both the registry entry and the message endpoint; no broker, no polling.
- **Discovery**: `hub op:sessions` probes every socket and lists live same-user sessions (address, state, name, cwd, pid, saved session id). Bare `hub list` keeps its native in-session IRC behavior; native hub operations are unchanged and delegated to the builtin hub.
- **Direct messages**: `hub send` to a `session:<uuid>` address delivers one message to a live peer; it arrives as a non-interrupting aside and idle sessions wake. Acceptance means the peer accepted it — not that its model responded. No auto-replies, retries, offline queue, or revival of exited sessions.
- **`await: true`** on a send waits up to 120 seconds for the next message from that peer (not necessarily an answer); **`hub wait`** with `from:session:<uuid>` waits for the next message from that peer, default 30 s, `timeout` 1–300 s.
- **`replyTo`** optionally quotes an incoming message id.
- **Unacknowledged sends are ambiguous by design**: timeout, peer-close, and endpoint-close failures all report ambiguity and instruct not to resend automatically.
- **`/sessions`** TUI command: list the registry or `send <session:address> <message>`.
- **Trust boundary**: same Unix UID, enforced by a `0700` directory and `0600` sockets with fail-closed safety checks (symlink, foreign-owner, and group/other-permission refusals). No remote transport.
