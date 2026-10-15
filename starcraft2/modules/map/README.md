# SC2 Map

The Map module owns the binary/XML map formats and their map-level composition.
The same implementations serve standalone document codecs, packed/folder maps,
previews and navigation operations.

- `shared/format/`: pure map readers/writers, document routing and models.
- `shared/image/`: raster, PNG and overview operations. `render.ts` is the Node-only file-output helper.
- `shared/navigation/`: spatial grids, areas, navigation analysis and routes.
- `shared/coordinator.ts`: combines the owned map documents and preserves untouched bytes.
- `codecs/`: MK3 document/package adapters; `providers/`: host-facing previews and services.
- `test/`: MK3 contract and host tests. The original binary/navigation corpus remains under
  `../../test/mk2/` and imports these canonical implementations.

Data, Wizard and mod metadata semantics remain in their respective modules. Embedded `.BlizWiz`
documents delegate to the Wizard module; Map does not define another wizard grammar.

`MK3-MIGRATION.json` records the authorities that moved here from MK2. The invalid historical
`DataWizard` parser was not carried over.

Validation from the Blizzard repository root:

```sh
pnpm exec tsc --noEmit -p starcraft2/tsconfig.sc2-map.json
node node_modules/vitest/vitest.mjs run --config test/vitest.config.mjs starcraft2/modules/map/test
```

Native host tests require freshly built bundles and contribution inventory. Do not rebuild or
rewrite the extension while those tests run: the host deliberately rejects changed artifacts.
