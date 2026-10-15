# Public source snapshot

This publication starts a new Git history from the independent source tree. Internal
history and other agents' uncommitted changes were not included. No source branch,
working-tree change or local game installation was removed to prepare it.

The following inputs were deliberately omitted because their public redistribution
provenance is unresolved:

- `models/test/fixtures/m3/corpus/Harbinger.m3`
- `models/test/fixtures/m3/corpus/aiur_cliffrocks_00.m3`
- `models/test/fixtures/m3/corpus/analysisterminal.m3`
- `models/test/fixtures/m3/corpus/portrait.m3`
- `models/test/fixtures/m3/cybros-cover.m3a.b64`
- `models/test/fixtures/m3/model.m3`
- `starcraft2/modules/galaxy/data/galaxy-script-api.v1.json`
- `starcraft2/test/fixtures/replays/Gresvan-LE.SC2Replay`
- `starcraft2/test/fixtures/replays/Lost-on-the-Horizon-FFA.SC2Replay`
- `starcraft2/test/fixtures/replays/Taito-Citadel-LE.SC2Replay`
- `starcraft2/test/fixtures/replays/Tokamak-LE.SC2Replay`
- `starcraft2/test/fixtures/replays/early/Wings-of-Liberty-1.1.0.SC2Replay`

The generated `starcraft2/modules/galaxy/language/native-api.generated.js` is also not
included. These inputs are ignored by Git so a local setup does not accidentally
reintroduce them into a later public commit. Do not add them without provenance review.

## Build and test consequences

The Galaxy generator requires the exact supported JSON catalog (3,341 functions),
then writes its JS adapter. It is not an extractor and there is no empty-catalog mode.
Full build/prepack and Galaxy native-API services require that authorized local input.
Tests expecting omitted model/replay fixtures also require a qualified local corpus.
Those tests are retained, not silently changed into passes or disabled globally.

Focused package builds and independent synthetic checks remain available; see
[DEVELOPMENT.md](DEVELOPMENT.md). Runtime exports, operation IDs and contribution
manifests were preserved. No gameplay or rendering completeness is claimed by this
source publication.

## Publication cleanup

- Original platform bundles carry the owner's MIT grant. Archive runtime bytes remain
  unchanged; package license metadata and notices were updated, and lockfile integrity
  values refreshed.
- Local `file:` dependency paths use forward slashes instead of Windows separators.
- Root license and detailed setup/run documentation were added, preserving copyleft
  and third-party scopes.
- The stale central-license inventory test now includes the two already-present
  upstream license texts. A small `test:public` command runs corpus-independent checks.
- A nonexistent `compat` package-files entry was removed; no implementation was removed.
- Generated output, dependency directories and local benchmark experiments stay ignored.

The source commit identifier is provenance only; that internal Git history is not
published: `16f14d537fed5efb8415fea238f6be71cbd28287`.
