# Pending Nix integration (no activation performed)

Owning configuration: `/etc/nixos/common/daniel/pi.nix`. It remains unchanged and valid, retaining the original `dunv/pi-worktree-panel` pin `7a84ea8e795ffc5fb5dd6073a1495e768aae0df0` / `sha256-0Ox9QmH4jyPgdlsG9c3+4Vf2tPIOHWLkhWkLxPebdAw=`. No current extension symlink was removed and no live Pi settings were changed.

## Publication gate

Daniel created and confirmed `git@github.com:dunv/pi-repo.git` during implementation. Read-only GitHub API inspection confirmed `full_name=dunv/pi-repo`, `private=false`, `visibility=public`; the remote was initially empty. This clears the source-publication gate. No npm publication, old-repository alteration, or Nix push is planned.

After successful root checks, the concrete integration sequence is:

1. Publish the approved source commit, obtain its immutable GitHub source revision and independently computed Nix source hash. For private visibility, decide an approved authenticated fetch mechanism first; never embed credentials in Nix expressions, argv, store paths, or session output. `fetchFromGitHub` is straightforward only for a publicly fetchable source.
2. Replace the `pi-worktree-panel` let binding in `pi.nix` with `pi-repo = pkgs.fetchFromGitHub { owner = <confirmed>; repo = <confirmed>; rev = <published full commit>; hash = <verified source hash>; };` **using actual confirmed values**, not these prose placeholders. No `runCommand` rewriting is necessary: wrapper entry points already have meaningful parent names.
3. Replace only `home.file.".pi/agent/extensions/pi-worktree-panel".source` with `home.file.".pi/agent/extensions/pi-repo".source = pi-repo;`. A reusable valid source-parameterized fragment is [`../nix/extensions.nix`](../nix/extensions.nix). One linked root directory discovers exactly the two manifest entries, tested against Pi 1.3.0. Do not also link children or add a Pi package settings entry. Audit any separately configured old package entry for later user-authorized removal; do not mutate settings implicitly.
4. Evaluate/build the owning Nix configuration and inspect the resulting extension tree **without activation**. Verify its manifest/peer imports and no node_modules/build artifacts. The existing extension stays live until the user separately authorizes activation/reload and replacement.

No broken placeholder pin/config is committed in `/etc/nixos`.

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
