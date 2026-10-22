# Nix integration history and deployment notes

## Follow-up deployment

Daniel subsequently authorized pushing/activating the source configuration, then selected the existing pinned Nix Pueue 4.0.4 package and a dedicated user daemon. Nix commit `25d3dba` added `common/daniel/pi/pueue.nix`, `PUEUE.md`, and declarative tests; it was pushed at Daniel's request and activated by him. Live smoke tests verified adapter connectivity, literal-argument execution with exit 0 and exact logs, and a separate intentional exit 7 with callback delivery. No review or remote-mutating job was run. The backend has no automatic restart, uses `X-SwitchMethod=keep-old`, and retains state/logs.

The current adapter removes the extra submission popup by default; `PI_PUEUE_CONFIRM_SUBMIT=1` opts back in. This launch variable is not a task argument or Pi setting and is not forwarded to backend jobs. Explicit cancellation still requires confirmation. Notices render neutrally and compactly without changing model-facing safety caveats or session routing. Apply the updated extension source pin and reload Pi; no daemon restart is needed. Existing daemon callback code remains compatible.

The sections below record the **initial** source integration and options considered before that follow-up approval.

Owning configuration: `/etc/nixos/common/daniel/pi.nix`. Local Nix commit `51a544c6f274ca552b706ddce8f86e71a7abd289` replaces the original `dunv/pi-worktree-panel` pin with the verified public package below. The Nix repository was **not pushed or activated**. The old checkout and currently active extension symlink remain intact; no live Pi settings were changed.

## Publication gate

Daniel created and confirmed `git@github.com:dunv/pi-repo.git` during implementation. Read-only GitHub API inspection confirmed `full_name=dunv/pi-repo`, `private=false`, `visibility=public`; the remote was initially empty. This clears the source-publication gate. No npm publication, old-repository alteration, or Nix push is planned.

## Verified source pin

```nix
pi-repo = pkgs.fetchFromGitHub {
  owner = "dunv";
  repo = "pi-repo";
  rev = "007cf00fc8e34353812eb39d203c5a53e702d776";
  hash = "sha256-/SbV8pcMrHIvQAvZbCKA1JlkNbQS0gVGbufwqaELfbw=";
};
```

This implementation revision is published on `main`; its GitHub Check workflow succeeded ([run 39762090476](https://github.com/dunv/pi-repo/actions/runs/39762090476)). Later documentation-only commits need not change the implementation pin.

`pi.nix` now declares `home.file.".pi/agent/extensions/pi-repo".source = pi-repo;` instead of the old independent panel declaration. A reusable source-parameterized fragment is [`../nix/extensions.nix`](../nix/extensions.nix). No `runCommand` rewriting is necessary: wrapper entry points already have meaningful parent names. One linked root directory discovers exactly two manifest entries. Do not also link children or add a Pi package settings entry. Audit separately configured old package entries for later user-authorized removal; never mutate settings implicitly.

Verification performed without activation:

- `npm ci --ignore-scripts --no-audit --no-fund` and `npm run check`: TypeScript plus **50 passing tests**, including all 34 migrated regressions and actual Pi 1.3.0 root-package autodiscovery.
- `npm pack --dry-run --ignore-scripts`: source/docs/license only, no node_modules, test payload, generated build, or bundled Rust binaries.
- `nixfmt --check`, `nix-instantiate --parse`, and Git whitespace checks passed for changed Nix code.
- Evaluated the actual `daniel-thinkpad` Home Manager extension source: new declaration exists, old declaration absent in the *evaluated future configuration*.
- Built **only the source fetch derivation**, verifying the exact hash at `/nix/store/0lmvvbydgz07vqaywbilk9l74r67v3qq-source`. Loaded its two entry points with the actual Pi 1.3.0 loader: no errors/warnings and exactly the expected four tools. No npm dependency install was needed inside the fetched source.

No full system/home activation build, service operation or live-daemon experiment was performed. The existing live extension stays installed until separately authorized activation/reload/replacement. Backend packaging, daemon lifecycle, approved credential resolution and eventual disposable-daemon acceptance testing still need decisions. No placeholder pin/config was committed.

## Backend packaging decision — options, not a selection

Read-only inspection on 2026-10-22 of the actual `/etc/nixos/flake.lock` inputs found:

- Stable nixpkgs `cd4ea8d57de16f4810bc5f14207bac45fbf19f67`: **Pueue 4.0.4**.
- Unstable nixpkgs `02c087f3fe673c9e317f206a627cb6b910336dbe`: **Pueue 4.0.4**.
- Both package expressions use source `v4.0.4`, source hash `sha256-6/Q0+ME1wwHZI5MwMULzS+2iWK2R3JiTM5I+spSjd30=`, Cargo dependency hash `sha256-l2i57DU8NVg7DtQqOkS/DDBJpfn7NSkgI5Wik+sKhfM=`. Nix builds Rust via `rustPlatform.buildRustPackage`; Rust is not an extension runtime dependency. A binary substitute may avoid local compilation, but availability/build cost has not been measured.
- Home Manager `24f8f8e786f87d6a818e1746cb2389bf922afdab` has `services.pueue.{enable,package,settings}`. It generates YAML and a user `pueued` unit (`Restart=on-failure`, default-target wanted). **Enabling this is a real daemon-lifecycle choice**, not incidental extension packaging. In particular restart/shutdown semantics need review before use with admitted jobs. No module was enabled.

Options to discuss:

1. Use the existing pinned Nix `pueue` package for both CLI and daemon, with an explicitly approved dedicated user daemon/config. Decide whether the Home Manager module's restart behavior is acceptable or whether its lifecycle needs an explicit approved configuration. This is still Pueue, not a second supervisor backend.
2. Pin an independently audited Pueue source derivation/overlay if future nixpkgs upgrades drift beyond supported 4.0.4. This adds maintenance/build responsibility; it is unnecessary solely to obtain 4.0.4 from the current inputs.
3. Use an already operator-managed matching Pueue 4.0.4 CLI/daemon, with explicit absolute launch paths and no installation by the extension. Upgrade/lifecycle responsibility stays external. No release-binary download/installer is implemented.

Whichever option is selected, explicitly configure the same local socket/runtime/data paths for client and daemon; dedicated alias-free POSIX shell configuration; no secret environment persistence; user-private retained logs/state; namespace UUID; approved execution-time credential resolver; and optional static numeric-only callback with `callback_log_lines=0`. Prepare the hint directory with mode 0700 as an authorized deployment step, not from the extension factory. Set the documented `PI_PUEUE_*` launch variables without changing Pi settings.

Before enabling real workloads, a separately authorized disposable-daemon acceptance test should verify actual CLI/schema/admission/signal/callback behavior on the selected package, without paid review or remote mutation. No daemon install/start/restart/maintenance, system activation, or real review experiment was performed here. Backend atomic identity/action, restore uncertainty and evidence-retention limits are documented in the adapter README; do not fill them with homemade supervision.
