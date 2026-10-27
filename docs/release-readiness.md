# Private release candidate

This repository remains private. No public release, npm publication, license grant, or visibility change is authorized until the owner separately approves it.

## What is included

- Same-user, same-machine live session discovery and direct messages.
- `session:all` broadcast announcements: one fresh discovery snapshot excluding the sender, optional read-only `preview` and exact absolute `cwd` filter, bounded parallel sends (8), per-recipient receipts with shared message id, `isError` on any failed receipt, no auto-replies/retries, cancellation ambiguous only after dispatch is attempted.
- Pull-only topic boards with combined filters, pagination, seven-day default expiry and daily publish-triggered cleanup; opt-in nonblocking board watches (`watch`/`watches`/`unwatch`) that wake a session on matching posts, local per-session lifetime, no replay.
- Native IRC presentation and explicit separation of cross-session discovery from omp's native in-session coordination tools.
- Install/upgrade/uninstall instructions, architecture and security boundaries, contribution guidance and changelog.
- CI on Linux and macOS, Node 22 and 24, with typechecking, tests and formatting. The process tests need no model credentials.

## Host compatibility

The plugin owns a single `session_bus` tool on both supported hosts; it never wraps, replaces, or delegates to omp's native tools.

| Host        | Integration                                                                                           |
| ----------- | ----------------------------------------------------------------------------------------------------- |
| omp 18.2.6  | Registers `session_bus`; the native `hub` tool keeps working unchanged alongside it.                  |
| omp 18.12.6 | Registers `session_bus`; there is no native `hub` on this host, and native `wait`/IRC stay untouched. |

The tool registers synchronously in the extension factory, before `session_start`, so `--tools session_bus` launch filtering works on both hosts. Intermediate and future host versions are not claimed compatible without verification.

## Verification evidence

Both supported hosts were exercised live with the renamed tool (0.3.0 candidate), and the watch operations were smoke-tested live on both supported hosts for the 0.4.0 candidate:

- Actual omp 18.2.6 and 18.12.6 hosts started with `--tools session_bus` and a model then drove discovery (`sessions`), publish, read, and `topics` successfully end to end.
- The 18.12.6 TUI displayed the host's native IRC card for cross-session operations (renderer reuse is an internal presentation detail, not a public API).
- An 18.12.6 sender used `await:true` to receive an unthreaded reply from an independent 18.2.6 receiver.
- The existing board verification exercised independent publisher/reader sessions, no publish-induced wakeup with no watch active (the pull-only default), persistence after writer exit, filters, topic discovery, and real one-second expiry.
- Watch smoke (both supported omp versions): `watch` registered and returned immediately with the agent ending its turn; a later externally published matching post woke the idle session exactly once with overlapping active filters; `unwatch` stopped deliveries.
- Broadcast was exercised with a three-session live smoke: a preview listed the other sessions without sending, an actual `session:all` send was accepted by every non-sender recipient with per-recipient receipts and a shared message id, and a narrowed `cwd` send reached only the matching tree. (Host checks are manual integration evidence, not claims that CI exercised a live model or every omp version.)
- Watch failure behavior is fail-closed: a watch-manager failure closes all of that session's watches and surfaces a UI error.
- The full local suite passes with strict typechecking and formatting (the watch sections above were verified at 32 tests; broadcast coverage adds to that count — see CI for the exact current number). A live busy-session smoke confirmed an in-flight tool completed normally while a matching post was delivered at the next step boundary; the native subscription IRC card was verified in the TUI.

CI status for the exact candidate commit is authoritative for the supported Node/OS matrix. These host checks are manual integration evidence, not claims that CI exercised a live model or every omp version.

## Review dispositions and limits

- Lifecycle installation is shared across overlapping session events; stale generations cannot publish a live endpoint.
- A cancelled in-flight send is reported as potentially delivered. Never retry an ambiguous send automatically.
- Broadcasts extend the same ambiguity rule per recipient: one attempt each, `attempted:false` marks recipients never reached after a send-phase cancellation, and cancellation before or during discovery aborts with no deliveries at all. A broadcast takes one fresh snapshot — it is not a guarantee about sessions that start later, and one failed receipt marks the whole call `isError: true` so partial delivery is never silent.
- A crash can leave ignored temporary board files or stale socket files. No automatic removal of another session's socket or potentially active temporary publication is attempted.
- Topic discovery and daily garbage collection scan board files. The first publish of a UTC day awaits cleanup. This favors deterministic lifecycle cleanup over detached work; very large boards may be slower.
- The trust boundary is the Unix account, not individual agents. Message contents can enter model-provider requests and persisted session transcripts.
- Malformed, unsafe, or unreadable committed post files stop watches with a visible error rather than silently discarding potentially relevant data. Fix the file and recreate the watch; history remains available through explicit reads. This deliberately matches board-store fail-closed behavior.

## Release policy

- The `hub` → `session_bus` rename is a **breaking change with no compatibility alias**; agents must switch every invocation to `session_bus` and restart omp.
- Opt-in board watches merged to `main` as **0.4.0**. `session:all` broadcast announcements are the current change and merge to `main` as **0.5.0** once CI is green on the candidate commit; until then it is not a release and no test or CI claims for 0.5.0 are made here ahead of that run.
- Keep the repository private: no public release, npm publication, license grant, or visibility change without explicit owner approval. Choose a license before any public distribution; none is implied.
