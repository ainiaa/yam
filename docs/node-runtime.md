# Terminal parser runtime

YAM 0.1.4 ships `yam-terminal.cjs` with the existing xterm/headless 6.0.0 and serialize 0.14.0 implementation. The Rust owner still owns PTYs, lifecycle, state and authenticated external views. Agent CLI configuration and execution environments are unchanged.

## Selection and first startup

1. Reconnect to an existing background owner first. Its runtime and running tasks remain untouched.
2. For a new owner, check absolute Node executables on the existing CLI search path and established system install locations. Require native architecture/platform, Node 22 or newer, the terminal protocol handshake and a real Unicode round trip.
3. If none passes, validate an existing YAM private cache using its install receipt and binary hash, then repeat the capability probe.
4. Otherwise download pinned Node 26.10.0 from `https://nodejs.org`. Verify the checked-in SHA256 before executing anything. Unix archives copy only the expected regular `bin/node` member; Windows downloads the official `node.exe` directly. Download and extraction have size limits.

The window remains responsive during preparation, shows the current step, and offers a retry on failure. No session is created until background initialization succeeds. Offline first use requires an already compatible installed or cached runtime.

## Isolation and updates

Private versions live under the YAM app-data directory, `runtimes/node`. Installation is serialized and staged privately; the complete verified directory is published under a unique name. Recovery installs a new directory rather than overwriting an existing executable. No running Node process is upgraded or stopped. Old private versions are retained so running processes cannot lose their files.

Only the parser receives the selected absolute Node path and script argument. Its Node and dynamic-loader injection variables are removed. YAM does not install Node globally, modify PATH, run a version manager, alter Codex configuration, or add its private Node to agent/child-agent environments.

The smaller App download does not imply zero Node storage: a machine without a compatible Node still needs the private runtime on first use. Installed compatible Node avoids that duplicate download and storage.

## Developer checks

`pnpm build:terminal --script-only` builds the production script without downloading Node. `pnpm build:terminal` retains the isolated SEA test fixture for existing native protocol tests; that fixture is excluded from production bundle resources. The notices report binds the shipped script name and exact bytes. Release builds keep their existing signing, updater and notices gates.

The isolated `terminal-owner-responsiveness.py` fixture hands the caller's installed Node to the owner before replacing HOME/PATH. For a private cached Node, pass its absolute executable as `--terminal-node`. The owner validates version and parser capabilities before fixture tasks start; this diagnostic never downloads Node or expands the workload environment.
