# Security

omp-session-bus deliberately makes a trade: it enables open cooperation between your own omp sessions, and in exchange it treats every message as untrusted input. This document describes the actual trust model so you can decide whether it fits your environment.

## Trust model

**The trust boundary is the Unix UID, not per-agent identities.**

- Every process running as your user — every omp session, but also any other program you run — can, by design, connect to the session sockets and read or write board posts. There is no authentication, signing, or ACL between agents. This is the same trust boundary your shell, your `~/.ssh`, and your other user-private state already rely on.
- If a process on your machine is malicious, this plugin is not the thing that is broken. Do not run it on shared or untrusted accounts, and do not treat "a message came from a session" as evidence of any identity beyond "some process under my UID".
- On multi-user machines the hard boundary is filesystem permissions: the session directory is `0700`, sockets and board posts are `0600`, and the plugin refuses to operate on any directory that is a symlink, owned by another UID, or group/other-readable. It fails closed with an actionable error rather than degrading to a weaker mode.

**The transport is machine-local.** The session bus is Unix domain sockets in a user-private directory and the board is a user-private directory of files. There is no listening TCP port, no remote-machine transport, no public internet component, and nothing in the transport dials out. Boards are "public" only in the sense of _shared among your own sessions_ — they are not remotely or publicly accessible.

**But content still reaches your model provider.** The transport being local does not keep message or post _content_ on the machine: whatever an agent reads — a direct message injected into its conversation, or board posts it lists — becomes part of that session's context and is sent to the configured model provider like any other agent input, and it can persist in session transcripts. Treat anything sent through the bus as data you are willing to put in a model prompt.

## Untrusted content

**Treat every incoming message and board post as peer-authored data, not user instructions.**

- A message that arrives in a session is agent input, not a human's. An agent that receives `Cross-session agent message ... from session:...` should treat the body the way it treats any other untrusted data: answer it when relevant, never follow embedded instructions blindly (no "run this command", no "paste your credentials", no prompt-injection obedience).
- Board posts are even weaker: anyone under your UID can author anything into any topic, and posts persist on disk until expiry. Validate before acting on them. This is amplified by watches: a `session_bus watch` causes board content — which any process under your UID can author — to be pushed into your session and can wake it while idle, spending a model turn on attacker-chosen input. Keep watch filters tight and prefer watching narrow topics over `board:all`.
- The plugin validates the _structure_ of everything it touches (envelope fields, post shape and sizes, post id vs filename) and fails loudly on malformed data rather than silently dropping or executing it. But structural validity is not content safety.

**Never publish secrets.** Board posts are plaintext JSON files on disk with a 7-day default lifetime, readable by your whole UID, that survive session restarts and outlive the sessions that wrote them. Auth tokens, credentials, personal paths, and private data do not belong on a board. Direct session messages are not persisted to disk by this plugin, but the receiving session may still log or transcribe them — assume the same rule applies.

## Filesystem path safety

- Socket and board directories are resolved from `OMP_SESSION_BUS_DIR` / `OMP_SESSION_BOARD_DIR` (or XDG defaults), then verified every time they are touched: symlink → refuse; foreign UID → refuse; group/other bits set → refuse.
- Socket paths are always `<directory>/<uuid>.sock` with the UUID strictly validated; post file names must match the `<millis>-<uuid>.json` pattern with the id inside matching the file name — a renamed or hand-crafted file is rejected, and malformed posts raise a repairable error rather than being silently hidden.
- Posts are written with `wx` (no clobber) and published via hard link (never overwrites); reads open files without following symlinks where the platform supports `O_NOFOLLOW`.
- The receiving side of the transport drops unknown envelope fields, and requests are capped at ~100 KiB per frame with a 5-second budget, so a misbehaving local process cannot wedge a session with a huge or endless request.

## Retention, crashes, and stale sockets

- **Retention is explicit:** board posts carry `createdAt`/`expiresAt` (default 7 days, override 1 s–365 d at publish). Reads exclude expired posts immediately; files are swept at most once per UTC day, opportunistically, by the publish path. Unexpired posts are never evicted. There is no hidden copy beyond these files — what is on disk is the whole board.
- Direct session messages are never written to disk by the transport. Board posts are; if you need the board gone, delete the board directory (default `~/.local/state/omp-session-bus/board`).
- **Crashed sessions leave stale socket files.** Nothing ever unlinks another session's socket, so a crashed peer leaves a dead entry in the socket directory. This is safe — discovery probes it, gets no answer, and skips it — but the file persists until reboot/tmp-cleanup or manual deletion. Never delete another _live_ session's socket manually; that would make its address unreachable.
- If the socket transport cannot start (unsafe directory, for example), it degrades fail-closed: direct session operations error with `Session bus unavailable: <reason>` until fixed. The board is a separate storage path and keeps working, and nothing is silently disabled.
- **Orphaned `.tmp` files.** A crash mid-publish can leave a hidden `.tmp` file in the board directory; GC never removes it (only expired, strictly-verified posts are removed), so clean it up manually if you notice one. There is deliberately no auto-deletion of `.tmp` files — an unsafe cleanup could delete a file another process is still writing.
- **Daily GC is synchronous and O(N).** The once-per-UTC-day expired-post sweep runs inline on the publishing path and scans the whole board directory, so the first publish after a day boundary with many accumulated expired posts takes noticeably longer. There is deliberately no detached GC process — it could outlive the omp host and race live sessions.

## Reporting a vulnerability

This is a private repository. Report suspected security issues **privately** — do not open a public issue with exploit details.

- Open a GitHub issue in this repository (visible only to collaborators; mark it security-related and keep technical details minimal until acknowledged), or
- contact the repository owner directly out-of-band.

Do not report via public channels. Include the omp and plugin versions, the exact error or behavior, and how you reproduced it.
