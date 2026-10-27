# Changelog

Notable behavior changes in omp-session-bus. Dates are not tracked here; versions map to the repository history.

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

## Unreleased

Release-acceptance work in progress (documentation, CI, tests). Under active testing on this branch, not yet released:

- Compatibility with omp 18.12.6 hosts, which removed the native `hub` tool the plugin wraps on 18.2.6. On such hosts the plugin registers its own standalone `hub` tool exposing only the cross-session operations (`sessions`, `topics`, and `send`/`wait`/`list` with explicit `session:`/`board:` addresses). Bare `hub list` reports the native registry as unavailable rather than substituting a cross-session listing; native wait/IRC remain untouched. Tested on 18.12.6: RPC `sessions`/`topics`, TUI `topics` with native wait IRC-card rendering, and cross-version DM (18.12.6 sender with `await:true` answered by an 18.2.6 receiver). Launching with `--tools hub` filtering is unsupported on 18.12.6 (it excludes the session-start-registered tool) — use the default toolset. Full release acceptance (CI run, merged evidence) is pending; do not treat 18.12.6 support as released until it appears here under a released version.
