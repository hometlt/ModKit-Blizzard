# SC2 host acceptance during concurrent development

The host pins the complete extension artifact when it builds inventory. Any later source,
test, manifest or bundle change in that directory correctly makes activation fail with
`x3.host/artifact-digest-mismatch`. Regenerating contributions does not freeze that directory.

Create a bounded snapshot from the Blizzard repository root:

```sh
node scripts/stage-sc2-test-extension.mjs
```

The command copies only `starcraft2/` into a fresh `artifacts/sc2-acceptance/run-*/starcraft2/`
directory, excluding `node_modules`, `.git` and `artifacts`. It checks that source paths, sizes
and modification times stayed unchanged during copying. A source mutation fails the command;
rerun it instead of using the incomplete copy. Its sibling `snapshot.json` records every file
hash and the complete artifact digest. Dependencies use a junction to the existing SC2
`node_modules`; installing dependencies during acceptance is unsupported.

Set the printed snapshot path for host tests, for example in PowerShell:

```powershell
$env:MODKIT_SC2_TEST_EXTENSION_ROOT = 'C:/path/to/artifacts/sc2-acceptance/run-ID/starcraft2'
pnpm exec vitest run --config test/vitest.config.mjs starcraft2/modules/map/test/sc2-height-map-native-host.test.ts starcraft2/modules/map/test/sc2-loose-map-native-host.test.ts --maxWorkers=1 --minWorkers=1
```

The test-only override changes the extension root passed to the host. Codec selection, artifact
verification, permissions, editing and worker execution continue through their usual paths.
Tests default to the source checkout when the variable is unset. VSIX acceptance can use the
same frozen extension root. Keep result receipts beside `snapshot.json`, outside the extension
directory; do not modify or rebuild the snapshot after inventory is loaded.
