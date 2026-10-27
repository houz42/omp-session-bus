# Private release candidate

This repository remains private. No public release, npm publication, license grant, or visibility change is authorized until the owner accepts it.

## What is included

- Same-user, same-machine live session discovery and direct messages.
- Pull-only topic boards with combined filters, pagination, seven-day default expiry and daily publish-triggered cleanup.
- Native IRC presentation and explicit separation of cross-session discovery from native in-session coordination.
- Install/upgrade/uninstall instructions, architecture and security boundaries, contribution guidance and changelog.
- CI on Linux and macOS, Node 22 and 24, with typechecking, tests and formatting. The process tests need no model credentials.

## Host compatibility

| Host        | Integration                                                                                                |
| ----------- | ---------------------------------------------------------------------------------------------------------- |
| omp 18.2.6  | Wraps native `hub`; native operations delegate unchanged.                                                  |
| omp 18.12.6 | Registers a standalone plugin `hub`; native `wait`/IRC stay untouched. Only plugin operations are exposed. |

Intermediate and future host versions are not claimed compatible without verification. On a host without native `hub`, launch with the default toolset rather than `--tools hub`: registration happens during session startup.

## Verification evidence

During preparation, actual omp 18.12.6 executed `hub sessions` and `hub topics` successfully. Its TUI displayed the host's native IRC card. An 18.12.6 sender used `await:true` to receive an unthreaded reply from an independent 18.2.6 receiver. The existing board verification exercised independent publisher/reader sessions, no publish-induced wakeup, persistence after writer exit, filters, topic discovery, and real one-second expiry.

CI status for the exact candidate commit is authoritative for the supported Node/OS matrix. These host checks are manual integration evidence, not claims that CI exercised a live model or every omp version.

## Review dispositions and limits

- Lifecycle installation is shared across overlapping session events; stale generations cannot publish a live endpoint.
- A cancelled in-flight send is reported as potentially delivered. Never retry an ambiguous send automatically.
- Native `hub` metadata unavailable through the extension metadata API is not fabricated.
- A crash can leave ignored temporary board files or stale socket files. No automatic removal of another session's socket or potentially active temporary publication is attempted.
- Topic discovery and daily garbage collection scan board files. The first publish of a UTC day awaits cleanup. This favors deterministic lifecycle cleanup over detached work; very large boards may be slower.
- The trust boundary is the Unix account, not individual agents. Message contents can enter model-provider requests and persisted session transcripts.

## Owner acceptance checklist

- [ ] Review README, installation instructions and command examples.
- [ ] Confirm desired behavior on both tested omp versions.
- [ ] Review security/retention limitations and private installation requirements.
- [ ] Review green CI for the candidate commit.
- [ ] Choose a license before any public distribution; none is implied by this candidate.
- [ ] Explicitly approve any public release or repository visibility change.

Until acceptance, changes stay on the private candidate branch; production `main` and fleet installs are not advanced by this readiness work.
