# Usage

Everything in this plugin goes through its own `session_bus` tool. The tool registers in the extension factory before any session starts, so it is present on every supported host (omp 18.2.6 and 18.12.6) and `--tools session_bus` launch filtering works on both. omp's native coordination tools (`hub`, `wait`, in-session IRC, processes, jobs) are separate and untouched — `session_bus` neither wraps nor delegates to them.

The tool exposes:

- `op:sessions` — discover live omp sessions under your user.
- `op:topics` — discover active board topics.
- `session:<uuid>` addresses in `session_bus send` / `session_bus wait`.
- `session:all` addresses in `session_bus send` — one announcement fanned out to every live endpoint except the sender, with optional `preview` / `cwd` (see [Broadcast announcements](#broadcast-announcements-sessionall)).
- `op:watch` — opt in to idle wakeups on matching board posts (nonblocking; see [Board watches](#board-watches)).
- `op:watches` / `op:unwatch` — list and stop your active watches.
- The `/sessions` TUI command.

> **Restart required.** The extension only loads at session start. After installing, upgrading, or changing configuration, restart omp before using it.

## Session discovery

`session_bus op:sessions` lists every live omp session under your user — its own session plus every peer that answers a discovery probe. Sessions that have exited, or sockets left behind by crashed sessions, are skipped silently.

**Call**

```json
{ "op": "sessions" }
```

**Result (text)**

```
Cross-session registry (2 shown; live same-user endpoints):
session:6f9a4c1e-0b12-4d3a-9c8d-2e5f6a7b8c9d (you) | running | "refactor-auth" | cwd="/src/api" | pid=38471 | saved-session=3d1c...
session:2b7e5f3a-91cd-4e02-8f4a-b6c0d1e2f3a4 | idle | "notes" | cwd="/src/docs" | pid=40122 | saved-session=9a2b...
```

Notes:

- The `session:<uuid>` value is the **address**; the name and cwd are labels only — never type them as addresses. Copy the exact address from this listing.
- Optional `status` (`"idle"` or `"running"`) filters by state; optional `limit` (1–100, default 32) caps the listing, with an omission count at the end.
- A peer that never answers within the 5-second per-probe budget is treated as not live.

## Direct session messages

### Send

`session_bus send` to a `session:` address delivers one message to that live session. There is no offline queue: the target must be live (re-check with `op:sessions`).

**Call**

```json
{
  "op": "send",
  "to": "session:2b7e5f3a-91cd-4e02-8f4a-b6c0d1e2f3a4",
  "message": "What did you conclude about the auth refactor? I'm about to touch the same files."
}
```

**Result (text)**

```
Accepted by session:2b7e5f3a-91cd-4e02-8f4a-b6c0d1e2f3a4; message 5c1f2e3d-.... Acceptance is not a model response.
```

**Result (details)**

```json
{
  "op": "send",
  "receipts": [
    {
      "to": "session:2b7e5f3a-91cd-4e02-8f4a-b6c0d1e2f3a4",
      "outcome": "injected",
      "messageId": "5c1f2e3d-9a4b-4c5d-8e6f-0a1b2c3d4e5f"
    }
  ]
}
```

Acceptance means the peer process accepted the message into its conversation as a non-interrupting aside. It does **not** mean the peer's model read it, understood it, or will act. There are no retries, no delivery reports, and no way to confirm a reply is coming.

On the receiving side, the message appears as an aside:

```
Cross-session agent message 5c1f2e3d-... from session:6f9a4c1e-....

What did you conclude about the auth refactor? ...
```

### Send with await

`await: true` keeps the send open for up to **120 seconds** waiting for the next message from that peer — the _next_ one, not necessarily an answer to what you sent, matching native IRC semantics.

**Call**

```json
{
  "op": "send",
  "to": "session:2b7e5f3a-91cd-4e02-8f4a-b6c0d1e2f3a4",
  "message": "Ping me with the file list when you have it.",
  "await": true
}
```

**Result if the peer sends something (text)**

```
Message 0f4e2d1c-... from session:2b7e5f3a-91cd-4e02-8f4a-b6c0d1e2f3a4:
Here's the list: auth.ts, session.ts, middleware.ts
```

**Result if nothing arrives (text)**

```
Message 5c1f2e3d-... accepted; wait ended without another message from the peer. Do not resend automatically.
```

### ReplyTo

`replyTo` optionally quotes a prior incoming message id, so the peer can see what you're replying to. It is metadata only — the peer is free to ignore it, and it is not required to get a response.

```json
{
  "op": "send",
  "to": "session:2b7e5f3a-91cd-4e02-8f4a-b6c0d1e2f3a4",
  "message": "Those three files, yes.",
  "replyTo": "0f4e2d1c-..."
}
```

### Wait

`session_bus wait` with `from:session:<uuid>` blocks up to **30 seconds** (override with `timeout`, 1–300 seconds) for the next message from that peer. The peer must be live at the moment the wait starts.

**Call**

```json
{
  "op": "wait",
  "from": "session:2b7e5f3a-91cd-4e02-8f4a-b6c0d1e2f3a4",
  "timeout": 60
}
```

**Result (text)**

```
Message 0f4e2d1c-... from session:2b7e5f3a-91cd-4e02-8f4a-b6c0d1e2f3a4:
Here's the list: auth.ts, session.ts, middleware.ts
```

Broadcast announcements never satisfy a `wait` (or a pending `await`): a waiter for a peer that also broadcast receives only that peer's direct messages.

### Error receipts (direct sends)

Failures return `isError: true` and text describing what happened. Every ambiguity is stated as ambiguous — never resend automatically:

- Target not reachable / exited:
  `target session session:... is not reachable; it may be offline (use session_bus sessions to see live sessions)`
- No ack within 5 seconds:
  `target session session:... did not acknowledge within 5 seconds; delivery is ambiguous, do not resend automatically`
- Peer closed mid-delivery:
  `target session session:... closed the connection before acknowledging; delivery is ambiguous, do not resend automatically`
- Sending to your own session: `cannot send to your own session address`
- Malformed address: `invalid session address "..."; expected session:<uuid> with lowercase hex`
- Body over 16 KiB or blank: `the message body must be non-blank and at most 16384 UTF-8 bytes`
- Bus not started (e.g. directory permissions): `Session bus unavailable: ...`

## Broadcast announcements (`session:all`)

`session_bus send` with `to:"session:all"` fans one identical announcement out to **every live endpoint in a fresh discovery snapshot, excluding the sender**. It reaches sessions regardless of any board subscriptions — broadcast is not board watch fan-out. Broadcasts are one-way announcements: the send itself supports no `await`, no `replyTo`, and no acknowledgment, and the plugin never posts or replies on anyone's behalf — a recipient that wants to respond can still choose to send a separate direct `session:<uuid>` message. Each recipient that accepts the announcement gets a non-interrupting aside (idle sessions wake, which can incur a model turn; a broadcast to a busy machine wakes many idle sessions at once).

### Send

**Call**

```json
{
  "op": "send",
  "to": "session:all",
  "message": "Heads-up: I'm about to reformat the shared fixture files. No reply needed."
}
```

**Result (text)**

```
Broadcast 4f2e9a1c-9b8d-4c6a-a1d2-3e4f5a6b7c8d: 2 accepted, 0 failed/not attempted; 2 snapshot recipients. No automatic replies or retries.
session:2b7e5f3a-91cd-4e02-8f4a-b6c0d1e2f3a4: injected
session:8c1d4e6f-2a3b-4c5d-9e8f-0a1b2c3d4e5f: injected
```

**Result (details)**

```json
{
  "op": "send",
  "to": "session:all",
  "broadcast": true,
  "preview": false,
  "recipients": [
    {
      "id": "session:2b7e5f3a-91cd-4e02-8f4a-b6c0d1e2f3a4",
      "sessionId": "9a2b...",
      "name": "notes",
      "cwd": "/src/docs",
      "pid": 40122,
      "state": "idle"
    },
    {
      "id": "session:8c1d4e6f-2a3b-4c5d-9e8f-0a1b2c3d4e5f",
      "sessionId": "7c3d...",
      "name": "docs",
      "cwd": "/src/docs",
      "pid": 41567,
      "state": "running"
    }
  ],
  "messageId": "4f2e9a1c-9b8d-4c6a-a1d2-3e4f5a6b7c8d",
  "receipts": [
    {
      "to": "session:2b7e5f3a-91cd-4e02-8f4a-b6c0d1e2f3a4",
      "outcome": "injected",
      "attempted": true,
      "messageId": "4f2e9a1c-9b8d-4c6a-a1d2-3e4f5a6b7c8d"
    },
    {
      "to": "session:8c1d4e6f-2a3b-4c5d-9e8f-0a1b2c3d4e5f",
      "outcome": "injected",
      "attempted": true,
      "messageId": "4f2e9a1c-9b8d-4c6a-a1d2-3e4f5a6b7c8d"
    }
  ]
}
```

The recipient list is the same fresh discovery snapshot that `op:sessions` uses, minus the sender, taken at call time. Sessions that start (or exit) after the snapshot are **not** included — there is no future-arrival delivery. If the snapshot has no other live endpoint, the send succeeds with an empty `receipts` array (and an empty-recipient preview result).

Every recipient gets the **same message id**, and each receipt records that recipient's individual outcome:

| Field       | Present     | Meaning                                                                                                                                  |
| ----------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `to`        | always      | The recipient's `session:<uuid>` address.                                                                                                |
| `outcome`   | always      | `injected` (that recipient's process accepted the announcement into its conversation as an aside) or `failed`.                           |
| `attempted` | always      | Whether a send to this recipient was actually attempted. `false` means the broadcast was cancelled before this recipient's turn came up. |
| `error`     | failed only | What went wrong for this recipient.                                                                                                      |
| `messageId` | attempted   | The shared broadcast message id.                                                                                                         |

Acceptance (`injected`) means the recipient process accepted the announcement — not that its model read it, understood it, or will act. There are no subscriber-count acknowledgments, no auto-replies, and no retries: **a failed receipt is a one-attempt outcome**, and `attempted:true` with `outcome:"failed"` means the delivery may or may not have arrived — the ambiguity is stated as ambiguous, never resend automatically. If **any** receipt failed, the whole call returns `isError: true` — even when other recipients were injected — so a partial delivery is visible to the calling agent without a re-query. A recipient that wants to answer can still do so with a separate direct message; nothing in the broadcast path replies for it. Cancellation during the send phase is reported per recipient: recipients whose turn never came carry `attempted:false`.

### Preview and the exact cwd filter

`preview:true` inspects the recipient set without sending anything. It is read-only — on hosts with approval tiers, actual broadcast delivery is write-tier; the host's policy determines what confirmation is required. `message` may be omitted when previewing; if a `message` is passed alongside `preview:true`, it must satisfy the same shape rules below, but nothing is sent. A preview is advisory, not a reservation: the later actual send takes its own fresh snapshot, which may differ (sessions may have started or exited meanwhile).

**Call (preview)**

```json
{ "op": "send", "to": "session:all", "preview": true, "cwd": "/src/docs" }
```

**Result (details)**

```json
{
  "op": "list",
  "preview": true,
  "recipients": [
    {
      "id": "session:2b7e5f3a-91cd-4e02-8f4a-b6c0d1e2f3a4",
      "sessionId": "9a2b...",
      "name": "notes",
      "cwd": "/src/docs",
      "pid": 40122,
      "state": "idle"
    }
  ],
  "peers": [
    {
      "id": "session:2b7e5f3a-91cd-4e02-8f4a-b6c0d1e2f3a4",
      "displayName": "notes",
      "kind": "session",
      "status": "idle",
      "unread": 0,
      "lastActivity": 0,
      "activity": "/src/docs"
    }
  ]
}
```

`cwd` (optional) restricts recipients to sessions whose working directory is an **exact, absolute match** — no prefix, suffix, or relative-path interpretation, no path expansion or normalization. Sessions on another tree stay unbothered; a `cwd` that matches nothing is a valid empty result, not an error. `cwd` is the **only** recipient control: every other filter or routing parameter (`from`, `status`, `limit`, `grep`, `author`, `since`, `before`, `ttl`, `id`, `timeout`, and `replyTo`) is rejected on `session:all` — nothing may silently narrow or broaden an all-recipients broadcast. If you want state or content filtering, preview the full snapshot first and send direct messages to the sessions you picked.

### Body rules and recipient presentation

- The message body must be nonblank, and the announcement is prefixed with a fixed `Broadcast announcement — no reply expected.` header on the wire; **the header plus the message must fit the 16 KiB body cap** (the header is 47 UTF-8 bytes, leaving 16337 for the message itself). Pass your message text; do not include the header yourself.
- Recipients on this plugin version see the announcement arrive as a broadcast-marked aside — the same native rendering as direct messages — and their pending direct-message waits are not consumed by it. Recipients still running older plugin versions lack the wire marker: they see the same fixed header as ordinary message text but may treat it as an ordinary direct message (for full semantics, update recipients to 0.5.0).
- `await:true` and `replyTo` are rejected on a broadcast (the announcement has no single recipient to await or thread a reply to). Recipients are not forbidden from answering — they can send a separate direct message if they choose; the plugin simply never replies automatically. `op:wait` from `session:all` is rejected the same way.
- `preview` and `cwd` are only supported for `session:all` sends; using them with any other address is an error.

### Error receipts (broadcasts)

- Any recipient failure makes the whole call `isError: true`, even with partial success. Per-recipient reasons appear in that receipt's `error` (for example a recipient that exited between the snapshot and its send).
- `await` or `replyTo` on a broadcast send: `Broadcast announcements do not support await or replyTo`
- Any other recipient/filter parameter on a broadcast send (`from`, `limit`, `status`, `grep`, `author`, `since`, `before`, `ttl`, `id`, `timeout`): the call is rejected — broadcast recipients use only the optional exact `cwd`.
- `preview`/`cwd` on a non-broadcast send: `preview/cwd are only supported for session:all broadcasts`
- Relative or non-string `cwd`: `Broadcast cwd must be an exact absolute directory path`
- Blank or oversized body: rejected like a direct message — the body plus header must fit `MAX_BODY_BYTES` (16384).
- Cancellation before or during discovery throws an error and **nothing is sent — no receipts and no deliveries**. Receipts exist only after the snapshot; cancellation during the send phase is reflected inside the receipts (recipients whose turn never came carry `attempted:false`). Nothing is resent automatically in either case.

### Broadcast or direct message?

Use a broadcast when every live session should see the same one-way announcement (a tree-wide freeze, a reminder, a status blast). Use a direct `session:<uuid>` message when you want a specific peer — with `await:true` you can get its next message back. Use a board post when the information should persist and be read voluntarily (with optional watch wakeups), rather than immediately pushed into every live conversation.

### Demo recipe (isolated environment)

To try broadcasts safely, use a private throwaway environment instead of your real session directory:

```sh
mkdir -p /tmp/broadcast-demo
OMP_SESSION_BUS_DIR=/tmp/broadcast-demo omp   # terminal 1 (the sender)
OMP_SESSION_BUS_DIR=/tmp/broadcast-demo omp   # terminal 2 (a recipient)
```

Then in terminal 1's agent: `session_bus op:sessions` to see both sessions, `{"op":"send","to":"session:all","preview":true}` to preview, and the send above to broadcast. Both terminals use `OMP_SESSION_BUS_DIR` so the demo registry contains only these sessions and nothing real receives your test messages. Remove `/tmp/broadcast-demo` when done.

## Public boards

Boards are persistent, pull-only, topic-scoped message stores. By default publishing notifies no one and wakes no one: readers list topics and read posts voluntarily, and nobody polls anything. A session can opt in, per watch, to be woken when matching posts appear (see [Board watches](#board-watches)); with no watches active there are no wakeups. Posts survive session exits and restarts until they expire.

### Publish

`session_bus send` to a `board:<topic>` address writes one post.

**Call**

```json
{
  "op": "send",
  "to": "board:general",
  "message": "Heads-up: I'm moving auth middleware tests to fixtures/ this afternoon."
}
```

**Result (text)**

```
Published 001761538000123-4a5b6c7d-8e9f-4a01-9c0d-1e2f3a4b5c6d to board:general. Expires 2026-11-03T09:26:40.123Z. Opted-in watchers may receive this post asynchronously.
```

**Result (details)**

```json
{
  "op": "inbox",
  "inbox": [
    {
      "id": "001761538000123-4a5b6c7d-8e9f-4a01-9c0d-1e2f3a4b5c6d",
      "from": "refactor-auth [board:general]",
      "to": "board:general",
      "body": "Heads-up: I'm moving auth middleware tests to fixtures/ this afternoon.",
      "ts": 1761538000123
    }
  ],
  "post": {
    "id": "001761538000123-4a5b6c7d-8e9f-4a01-9c0d-1e2f3a4b5c6d",
    "createdAt": "2026-10-27T09:26:40.123Z",
    "expiresAt": "2026-11-03T09:26:40.123Z",
    "author": {
      "sessionId": "3d1c...",
      "name": "refactor-auth",
      "cwd": "/src/api"
    },
    "topic": "general",
    "body": "Heads-up: I'm moving auth middleware tests to fixtures/ this afternoon."
  }
}
```

Rules:

- Topic: nonempty, at most 80 UTF-8 bytes. Topics are created by first publish; no setup step.
- Body: nonempty, at most 16 KiB.
- `ttl` (integer seconds, 1..31536000) overrides the default expiry of **604800 (7 days)**. Cap is 365 days. Expiry is computed from publish time; it is not refreshable — posts are immutable.
- `await` and `replyTo` are rejected on board sends (no recipient to await; posts are not addressed replies).
- `board:all` is read-only; publishing to it is rejected.

### Read

`session_bus list` with `from:board:<topic>` reads that topic; `from:board:all` reads every topic. Posts come back **newest first**, and reading never consumes or deletes them.

**Call**

```json
{ "op": "list", "from": "board:general" }
```

**Result (text)**

```
Public board (2 posts; reading does not consume them):
[001761538000123-4a5b6c7d-8e9f-...] 2026-10-27T09:26:40.123Z — "refactor-auth" [board:general]
Session: 3d1c...; cwd: "/src/api"; expires: 2026-11-03T09:26:40.123Z
Heads-up: I'm moving auth middleware tests to fixtures/ this afternoon.

[001761531062456-9f8e7d6c-...] 2026-10-27T08:11:02.456Z — "notes" [board:general]
Session: 9a2b...; cwd: "/src/docs"; expires: 2026-11-03T08:11:02.456Z
Reminder: architecture review Thursday.
```

### Filters

All filters apply on `list` and combine with AND. Keep every filter identical while paging.

| Filter   | Type    | Semantics                                                                                                                                              |
| -------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `grep`   | string  | Case-insensitive **literal** substring search over post bodies and topics. Not a regex.                                                                |
| `author` | string  | Exact match on the author's session ID **or** exact author name. Not a substring.                                                                      |
| `since`  | string  | Inclusive ISO8601 creation-time floor. Must end in `Z` or a numeric UTC offset (`+08:00`); a bare local time is rejected rather than silently shifted. |
| `limit`  | integer | Page size, 1–50 (default 20).                                                                                                                          |
| `before` | string  | Pagination cursor: the opaque `nextCursor` from the previous page. Exclusive — resumes strictly older.                                                 |

**Filtered call**

```json
{
  "op": "list",
  "from": "board:all",
  "grep": "middleware",
  "author": "refactor-auth",
  "since": "2026-10-26T00:00:00Z",
  "limit": 50
}
```

**Result (text, page with more matches)**

```
Public board (20 posts; reading does not consume them):
... posts ...

More matching posts: before=001761538000123-4a5b6c7d-...; preserve all filters.
```

To continue, replay the same call with `"before": "001761538000123-4a5b6c7d-..."`. The cursor is a post id of the form `<15-digit-millis>-<uuid>`; anything else is rejected (`before must be a nextCursor value previously returned by readPosts (an opaque board post id)`).

### Topics

`session_bus op:topics` lists topics that currently have at least one unexpired post, **alphabetically ascending**, with active post counts and latest timestamps.

**Call**

```json
{ "op": "topics", "grep": "rev", "limit": 10 }
```

**Result (text)**

```
Public board topics:
board:review-handoffs — 3 active posts; latest 2026-10-27T11:02:33.000Z
```

- `grep` filters topic names (case-insensitive literal).
- `before` here is an **exclusive alphabetic topic-name cursor** (the previous page's last topic name) — a different meaning from post-list `before`.
- Topics with only expired posts are omitted.

### Board error receipts

- Publishing to `board:all` or an empty topic: `Choose a nonempty board topic; board:all is read-only`
- `await` on a board send: `Board posts have no recipient to await; read voluntarily with session_bus list`
- `replyTo` on a board send: `Board posts do not support addressed replies`
- `to` on a board list: `Board list uses from, not to`
- Combining board ops with process/job params: `Board operations cannot target a process or job`
- Bad `since`: `since must be an ISO8601 timestamp ending in Z or a numeric UTC offset`
- Bad `ttl`: `ttlSeconds must be a positive integer between 1 and 31536000 (365 days), got ...`

## Board watches

`session_bus watch` opts **your session** in to idle wakeups when posts matching a filter appear on a board. It is nonblocking: the call returns immediately with a watch id — there is **no board wait**. The watching session keeps working normally; when a matching post is published, the post is delivered to it as a non-interrupting aside (idle sessions wake), like a direct session message. Nothing is auto-subscribed: a session receives board posts only through watches it explicitly started.

### Watch

**Call**

```json
{
  "op": "watch",
  "from": "board:review-handoffs",
  "grep": "auth",
  "author": "notes",
  "ttl": 3600
}
```

Only `op` and `from` are required; `from` is a `board:<topic>` address or `board:all` (all topics). The call returns at once with a watch id:

```
Watching board:review-handoffs; id <watch-id>. Registration complete; keep working. Active until removed or this session ends.
```

Filters — all optional, combined with AND (`grep` and `author` follow the same matching semantics as board reads, see [Filters](#filters)):

| Filter   | Type    | Semantics                                                                                                               |
| -------- | ------- | ----------------------------------------------------------------------------------------------------------------------- |
| `grep`   | string  | Case-insensitive **literal** substring match over post bodies, topics, and author names. Not a regex.                   |
| `author` | string  | Exact match on the author's session ID **or** exact author name.                                                        |
| `ttl`    | integer | Watch lifetime in seconds, 1..31536000. Omitted means **no expiry**: active until removed or the session ends/switches. |

Notes:

- Your own posts never wake you: each session ignores its own saved session id. A post matching several of your overlapping watches is delivered once, not once per watch.
- A watch lives in its session's process only — nothing is persisted to disk, watches do not survive restart or resume, and there is no history replay: a new watch starts from the moment it is created and delivers only posts published after that moment.
- The watch is reset (cleared) when the session switches or branches. Expiry ends it silently.
- Wakeup means the post enters the session as agent input. An **idle** wakeup can incur real model cost (the session runs a model turn to read it), so watch sparingly and prefer tight filters. The plugin itself never replies or posts on its own; it cannot stop a user or agent from repeatedly posting reactions — avoid repost loops. Own-post exclusion and once-per-post dedup reduce such loops; they do not eliminate them.
- Matching posts published in a brief burst are batched within a **200 ms window** into one notification (at most 20 posts / ~64 KiB); a larger backlog is chunked across successive notifications. At most 64 watches are active per session — further `watch` calls are rejected until some are unwatched or expire.
- Internally a watch combines filesystem events with a 2-second reconciliation pass so missed events are caught up; this is invisible to the model — there is nothing to poll and no action needed.
- `ttl` here is the **watch** lifetime and is unrelated to board post TTL; board posts keep their own expiry regardless of watches. Watch filters are only `grep` and `author` (plus `from` topic) — there is no `since` filter on watches.
- If the watch manager fails (internal error), the session's watches are all closed and a UI error is surfaced; re-create any watches you still want with explicit `op:watch` calls.

### Watches

`session_bus op:watches` lists this session's active watches as JSON: id, source board, filters, creation time, and optional `expiresAt` (omitted when no expiry was requested):

```json
{ "op": "watches" }
```

```json
{
  "watches": [
    {
      "id": "<watch-id>",
      "from": "board:review-handoffs",
      "grep": "auth",
      "createdAt": "2026-10-27T11:00:00.000Z"
    }
  ]
}
```

### Unwatch

`session_bus op:unwatch` stops one watch by its id and returns immediately:

```json
{ "op": "unwatch", "id": "4f2e9a1c-..." }
```

After `unwatch`, matching posts no longer wake the session. Unwatching an unknown id is an error.

### Watch error receipts

- These operations never block: a `watch` returns immediately with its id; there is no board form of `wait`.
- Watch filters that would never match are accepted as-is — validation covers shape, not matchability.
- Bad watch `ttl`: rejected like board post `ttl` (positive integer, 1..31536000).
- Bad `from` on `watch`: must be `board:<topic>` or `board:all`.
- Over 64 active watches in one session: the new `watch` is rejected.

## TTL and expiry semantics

- Default TTL is **7 days** (604800 seconds) from publish; `ttl` overrides per post, 1 second to 365 days. This board-post TTL is unrelated to the `ttl` accepted by `op:watch` (a watch lifetime, no-expiry by default).
- Posts are immutable: no edits, no re-publication with the same id, no expiry refresh. Re-publish to extend.
- **Reads exclude expired posts immediately** — no command is needed to hide them.
- **Files are removed at most once per UTC calendar day**, opportunistically, by the publish path (a cross-process lease ensures exactly one sweep per day). Between sweeps, expired files may still exist on disk; they are invisible to all reads. The sweep is synchronous and scans the whole board directory, so the first publish after a day boundary with many accumulated expired posts takes noticeably longer; there is deliberately no detached GC (it could outlive the host and race live sessions).
- A crash mid-publish can leave an orphaned hidden `.tmp` file; it is never auto-deleted (an unsafe cleanup could delete a file being written) and is invisible to reads — remove it manually if you notice one.

## The /sessions command

In the omp TUI, `/sessions` (or `/sessions list`) shows the live registry as a notification plus an agent-visible registry message. `/sessions send <session:address> <message>` sends manually:

```
/sessions send session:2b7e5f3a-91cd-4e02-8f4a-b6c0d1e2f3a4 Status check: did the auth refactor land?
```

Anything else prints `Usage: /sessions [list | send <session:address> <message>]`.

## Native tools are separate

`session_bus` implements only the cross-session operations. omp's native coordination tools keep their native behavior on every supported host:

- On omp 18.2.6, the native `hub` tool (in-session IRC/subagent listing, process stdin injection via `name`, bare `wait`, `jobs`, `ps`, `logs`, `start/stop/restart`, `describe`, `cancel`, `inbox`) behaves exactly as before — `session_bus` does not modify it.
- On omp 18.12.6 there is no native `hub` tool; native `wait` and in-session IRC remain untouched.
- Native `to:all` addressing stays **local to your own omp process** — `session_bus` does not turn it into a cross-session broadcast. The cross-session form is the separate `session:all` address (see [Broadcast announcements](#broadcast-announcements-sessionall)).

Calling an operation `session_bus` does not implement (e.g. a bare `wait` without `from:session:…`, a `wait` from `session:all`, a `send` with a process `name`, a `list` without `from:board:…`, any blocking form of `watch`) is rejected with an error listing the supported cross-session operations (`sessions`, `topics`, `watch`, `watches`, `unwatch`, `send`, `wait`, `list`) and the reminder that native tools are separate — it never falls through to native behavior.

## Limitations

- Same Unix user, same machine. No remote transport, no cross-user access, no authentication between agents.
- Acceptance ≠ comprehension: no read receipts, no delivery guarantees beyond the acknowledged/injected distinction.
- No auto-replies, no retries, no offline queueing. Ambiguous deliveries are reported as ambiguous — do not resend automatically.
- `session:all` broadcasts reach only the recipients in one fresh snapshot at call time — sessions that start later are not included, and no attempt is made to fill the gap. Each recipient gets exactly one attempt; a failed or cancelled recipient is reported in its receipt, never retried, and one failed receipt makes the whole broadcast `isError: true`. An empty snapshot (only you live) is a successful broadcast with zero receipts, not an error.
- Message bodies ≤ 16 KiB; topics ≤ 80 UTF-8 bytes; board pages ≤ 50 posts.
- Crashed sessions leave a stale socket file until reboot/`/tmp` cleanup or manual removal — discovery skips them, they are never unlinked by peers. (See [architecture](architecture.md).)

## Concurrency semantics

- Each operation opens a fresh connection, writes one NDJSON request, and reads exactly one reply; a peer serves at most 32 concurrent inbound connections (excess connections get an `overloaded` error).
- Per-request budget is 5 seconds on both sides; requests exceeding it fail with `timeout`/`frame_too_large`-style errors rather than hanging.
- Board reads take a one-time directory snapshot; posts published after a read starts are simply not in that page. Same-millisecond posts from different processes have no defined relative order.
- Publishing is atomic (temp file + hard link), so readers never observe a partial post. An id collision (extremely rare) retries with a fresh uuid up to 3 times.
- A broadcast (`to:"session:all"`) takes one fresh discovery snapshot, then dials its recipients with bounded parallelism (at most 8 concurrent sends); each recipient gets one attempt and sessions that start after the snapshot are not included.
