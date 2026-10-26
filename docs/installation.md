# Installation

omp-session-bus is a private plugin. Installation requires SSH read access to the private GitHub repository, and the install command pins an exact commit so every machine runs identical code.

## Prerequisites

- **omp 18.2.6 or 18.12.6.** These are the two supported hosts, and they behave differently:
  - **18.2.6** (verified): the plugin wraps the builtin `hub` tool; native hub operations keep working. It refuses to replace another extension's wrapper; a host with no hub uses the standalone integration instead.
  - **18.12.6** (tested: RPC sessions/topics, TUI topics + native IRC-card rendering, cross-version DM with an 18.2.6 peer; release acceptance pending): there is no native hub; the plugin registers its own `hub` tool exposing only the cross-session operations (`sessions`, `topics`, and `send`/`wait`/`list` with explicit `session:`/`board:` addresses). A bare `hub list` reports the native registry as unavailable — it does not substitute the cross-session list. **Do not launch omp with `--tools hub` filtering** on this version: the plugin registers `hub` at session start, and that filter excludes it. Default toolset is fine.
  - Versions between 18.2.6 and 18.12.6 are unverified; no claim is made for other/latest omp versions.
- **Node >= 22.18** for development and tests (see [CONTRIBUTING.md](../CONTRIBUTING.md)); the plugin itself runs inside the omp host.
- **Linux or macOS.** Windows is not supported — the transport and board store rely on Unix domain sockets and POSIX permission bits.
- **SSH access to the private repository.** Confirm before installing:

  ```sh
  git ls-remote git@github.com:houz42/omp-session-bus.git HEAD
  ```

  If this hangs or fails, fix your GitHub SSH keys (and any VPN/proxy needed to reach github.com) before continuing — `omp plugin install` uses the same SSH transport.

## Install

For the private readiness candidate (including omp 18.12.6 support), resolve
`refs/heads/release/readiness`, not `main`:

```sh
git ls-remote git@github.com:houz42/omp-session-bus.git refs/heads/release/readiness
```

Copy that full SHA into the quoted install command below. The candidate is not
promoted to `main` until owner acceptance.

```sh
omp plugin install 'git+ssh://git@github.com/houz42/omp-session-bus.git#<commit-sha>'
```

- `<commit-sha>` is the full commit hash to install (e.g. the `main` tip, below). Always pin a commit; a floating branch reference will silently drift.
- The default scope is `user`, which installs into omp's per-user plugin directory — every omp session you start gets the extension.

### Why the commit is pinned — Bun lock caching

omp installs plugins with Bun, which caches git dependencies aggressively: after the first install of a `git+ssh://...` URL, reinstalling the _same URL_ (no `#sha`) can silently keep the cached commit even after `main` moved. Pinning `#<commit-sha>` forces a concrete tree every time. Consequences:

- **New installs** are always exact: the SHA is in the URL.
- **Upgrades** need a fresh SHA (next section) — bumping the pin is what defeats the cache.
- **Uninstall then reinstall** is the fallback if you suspect a stale cache (last section).

## Upgrade

Upgrades are re-pins, not pulls:

1. Resolve the commit you want on `main`:

   ```sh
   git ls-remote git@github.com:houz42/omp-session-bus.git refs/heads/main
   ```

   This prints the current `main` SHA without cloning.

2. Reinstall with the new SHA:

   ```sh
   omp plugin install 'git+ssh://git@github.com/houz42/omp-session-bus.git#<new-commit-sha>'
   ```

3. Restart omp. Sessions only load the extension at startup.

## Development setup

To work on the plugin from a checkout:

```sh
git clone git@github.com:houz42/omp-session-bus.git
cd omp-session-bus
bun install            # installs dev dependencies (@types/node, typescript)
```

Then link the checkout into omp instead of installing the published tree:

```sh
omp plugin link /abs/path/to/omp-session-bus
```

`plugin link` uses your working copy directly; edits apply on the next session start (restart omp after linking or after structural edits). See [CONTRIBUTING.md](../CONTRIBUTING.md) for the test suite.

## Configuration

There is no config file and no omp plugin settings. Two process environment variables select shared storage locations. The socket path is resolved on session startup; the board path is resolved per operation. Sessions must use matching paths to share data.

| Variable                | Default                                                                              | Controls                                                                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `OMP_SESSION_BUS_DIR`   | `$XDG_RUNTIME_DIR/omp-session-bus`, else `/tmp/omp-session-bus-<uid>`                | Directory holding one Unix socket per live session (the live-session registry). Should be tmpfs or otherwise per-boot storage. |
| `OMP_SESSION_BOARD_DIR` | `$XDG_STATE_HOME/omp-session-bus/board`, else `~/.local/state/omp-session-bus/board` | Directory holding persistent board posts (one JSON file per post).                                                             |

Notes:

- The socket directory is created with mode `0700` and sockets with `0600`; the board directory likewise `0700` and post files `0600`. The plugin **refuses to operate** on a directory that is a symlink, owned by another UID, or readable by group/other — fix ownership/permissions or point the variable at a different path.
- Sessions started with different values of these variables cannot see each other. Set them consistently (e.g. in your shell profile) if you need one shared registry across terminal environments.
- Restart omp after changing either variable.

## Uninstall

```sh
omp plugin uninstall omp-session-bus
```

Then restart omp. Uninstall does not delete the storage directories; remove them manually if you want a full cleanup:

- The socket directory (default `/tmp/omp-session-bus-<uid>` or `$XDG_RUNTIME_DIR/omp-session-bus`) — stale socket files from crashed sessions can linger there; see [architecture](architecture.md#lifecycle-and-crash-behavior).
- The board directory (default `~/.local/state/omp-session-bus/board`) — contains unexpired board posts.

## Restart required

The extension registers the `hub` tool wrapper and the `/sessions` command only when an omp session starts. After install, upgrade, link, uninstall, or configuration changes, **restart omp** for changes to take effect.

On omp 18.12.6, also make sure you do **not** launch with `--tools hub` filtering — the plugin's `hub` is registered at session start, and that launch filter excludes it. The default toolset works unchanged.
