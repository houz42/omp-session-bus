# Installation

omp-session-bus installs from GitHub over HTTPS, and the install command pins an exact commit so every machine runs identical code.

## Prerequisites

- **omp 18.2.6 or 18.12.6.** The plugin registers the same `session_bus` tool on both (verified on each), so `--tools session_bus` launch filtering works on either. On 18.2.6 omp's native `hub` tool keeps working unchanged alongside it; on 18.12.6 there is no native hub. Versions between 18.2.6 and 18.12.6 are unverified; no claim is made for other/latest omp versions.
- **Node >= 22.18** for development and tests (see [CONTRIBUTING.md](../CONTRIBUTING.md)); the plugin itself runs inside the omp host.
- **Linux or macOS.** Windows is not supported — the transport and board store rely on Unix domain sockets and POSIX permission bits.

## Install

```sh
omp plugin install 'https://github.com/houz42/omp-session-bus.git'
```

- The default scope is `user`, which installs into omp's per-user plugin directory — every omp session you start gets the extension.

### Why upgrades pin a commit — Bun lock caching

omp installs plugins with Bun, which caches git dependencies aggressively: reinstalling the _same URL_ can silently keep the cached commit even after `main` moved. Pinning `#<commit-sha>` forces a concrete tree. Consequences:

- **First install** needs nothing special — the bare URL above resolves `main` once.
- **Upgrades** need a fresh SHA (next section) — bumping the pin is what defeats the cache.
- **Uninstall then reinstall** is the fallback if you suspect a stale cache (last section).

## Upgrade

Upgrades are re-pins, not pulls:

1. Resolve the commit you want on `main`:

   ```sh
   git ls-remote https://github.com/houz42/omp-session-bus.git refs/heads/main
   ```

   This prints the current `main` SHA without cloning.

2. Reinstall with the new SHA:

   ```sh
   omp plugin install 'https://github.com/houz42/omp-session-bus.git#<new-commit-sha>'
   ```

3. Restart omp. Sessions only load the extension at startup.

## Development setup

To work on the plugin from a checkout:

```sh
git clone https://github.com/houz42/omp-session-bus.git
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
- Keep custom socket directory paths short: the full path including the UUID filename must fit 103 UTF-8 bytes on macOS or 107 on Linux. macOS defaults to `/tmp` rather than its long per-user temporary directory. Oversized paths fail explicitly; choose a shorter private `OMP_SESSION_BUS_DIR`.

## Uninstall

```sh
omp plugin uninstall omp-session-bus
```

Then restart omp. Uninstall does not delete the storage directories; remove them manually if you want a full cleanup:

- The socket directory (default `/tmp/omp-session-bus-<uid>` or `$XDG_RUNTIME_DIR/omp-session-bus`) — stale socket files from crashed sessions can linger there; see [architecture](architecture.md#lifecycle-and-crash-behavior).
- The board directory (default `~/.local/state/omp-session-bus/board`) — contains unexpired board posts.

## Restart required

The extension registers the `session_bus` tool in the extension factory at omp startup, and the `/sessions` command and socket transport when a session starts. After install, upgrade, link, uninstall, or configuration changes, **restart omp** for changes to take effect.

Because the tool registers before any session starts, launching omp with `--tools session_bus` works on both supported versions.
