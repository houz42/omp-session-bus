# Contributing

Contributions happen from a git worktree of this private repository; keep the repo private, no release/publication workflow, and no public visibility changes.

## Development setup

```sh
git clone git@github.com:houz42/omp-session-bus.git
cd omp-session-bus
bun install            # dev dependencies (@types/node, typescript)
omp plugin link "$(pwd)"   # run your checkout inside omp
```

Restart omp after linking. `omp plugin link` points omp at your working copy, so every session start loads your current edits (restart again after structural changes).

- **omp 18.2.6 or 18.12.6** to exercise the plugin in a live host. The hub topology differs per version (native-hub wrapper on 18.2.6; standalone cross-session-only `hub` on 18.12.6) — see [installation](docs/installation.md). Intermediate versions are unverified; 18.12.6 support is tested on the acceptance branch but not yet released.

- **Bun** for dependency install.
- **Node >= 22.18** to run the tests (they use `node --experimental-strip-types` to execute TypeScript directly; no build step).

## Layout

| File               | Role                                                                              |
| ------------------ | --------------------------------------------------------------------------------- |
| `index.ts`         | Plugin wiring: hub tool wrapper, dispatch, `/sessions` command, session lifecycle |
| `transport.ts`     | Same-user socket transport: registry, discovery, direct message delivery          |
| `board.ts`         | Board operations (`send`/`list`/`topics`) over the store, plus help text          |
| `board-store.ts`   | Persistent post store: atomic publish, filtered reads, topic listing, TTL/GC      |
| `host-renderer.ts` | Host-only adapter reusing native hub or wait/IRC renderers (TUI mode)             |
| `*.test.ts`        | Test suites for each module                                                       |

## Tests

Run the full suite with Node's built-in runner:

```sh
npm test
# equivalent: node --experimental-strip-types --test *.test.ts
```

- The suites are plain Node test files (`node:test` + `node:assert`) — no framework install needed, no network, no omp host required. Transport tests stand up real socket directories in temp space; board tests use real directories, so they exercise the actual filesystem semantics.
- Typecheck with `npm run typecheck` (`tsc --noEmit`).
- Behavior changes should include focused regression coverage for plausible failures: delivery/cancellation, filtering/pagination/expiry, native delegation and filesystem isolation. Do not pin incidental wording or source text. Keep tests deterministic and isolated.

## CI

CI runs the test suite and typecheck. Two hard rules:

- **No model credentials in CI.** The tests must never require (or accept) API keys, model endpoints, or omp session secrets. Everything runs against local sockets and temp directories.
- **CI status is not claimed on your behalf.** "CI is green" assertions belong to the maintainer after a full run; don't put pipeline-status claims in docs or PR descriptions.

The project is mid-acceptance: release-acceptance validation is in progress; 18.12.6 compatibility is tested but unreleased. Prefer documenting verified behavior only — see the docs conventions below.

## Docs conventions

- Source-grounded only: every documented default, flag, error message, and limit must come from the actual code. When behavior changes, update the docs in the same change.
- No personal directory paths, personal identities, or internal org names in any file.
- No unsupported claims: don't promise the latest omp works, and don't assert CI is green unless verified for that exact change.
- Internal links must be valid relative links within the repo.

## Commit and version conventions

- Keep commits focused; one behavior per commit.
- `package.json` version bumps follow the [changelog](CHANGELOG.md). Update `CHANGELOG.md` in the same change that alters behavior.

## Reporting issues

Use GitHub issues in this repository (accessible to collaborators). For security reports, follow [SECURITY.md](SECURITY.md) — do not open a normal issue with exploit details.
