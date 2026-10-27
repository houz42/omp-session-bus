# Changelog

Notable behavior changes in omp-session-bus. Dates are not tracked here; versions map to the repository history.

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
