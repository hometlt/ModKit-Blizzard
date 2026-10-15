# StarCraft II TriggerData module

This module owns the `sc2-triggers` codec, TriggerData document model, workspace loader, editing
services and the bidirectional Galaxy conversion service.

Public integration points are deliberately small:

- `@modkit/blizzard-starcraft2/triggers/document` — TriggerData model and readers;
- `@modkit/blizzard-starcraft2/triggers/conversion` — Galaxy ↔ TriggerData conversion;
- `@modkit/blizzard-starcraft2/triggers/detection` — source detection;
- `@modkit/blizzard-starcraft2/triggers/editing/*` — bounded edit services.

The `services/galaxy-conversion/internal` files are implementation details. Consumers use the
conversion service instead of importing `g2t-*` or `ttg-*` modules. Galaxy parsing comes from the
sibling Galaxy module; neither module owns a second AST.

Repository-owned fixtures run in the default module suite. Tests against files from a local SC2
installation use `test/vitest.native-corpus.config.mjs` explicitly because that corpus is mutable.

## Conversion sessions

Use `createTriggerGalaxyConversionService()` when converting several documents from the same
package or workspace. The service keeps a content-addressed cache of parsed dependency TriggerData;
the primary document is always parsed independently. The default cache retains at most 16 dependency
documents and 64 MiB of their source text. Both limits are deterministic and configurable:

```js
const conversion = createTriggerGalaxyConversionService({
  cache: {
    maxDependencyCacheEntries: 32,
    maxDependencyCacheSourceBytes: 128 * 1024 * 1024,
  },
})

await conversion.galaxyToTriggers(input)
conversion.cacheStats()
conversion.clearCache()
```

Set `maxDependencyCacheEntries` to `0` to disable retention. A session cache trades bounded retained
memory for speed; call `clearCache()` after a package finishes if the service itself remains alive.
Single-shot callers may continue to use `convertGalaxyToTriggers()` and `convertTriggersToGalaxy()`.

## Language and MCP surface

The language provider supplies diagnostics, completion, hover, definition, references,
prepare-rename/rename, document/workspace symbols and raw-preserving final-newline formatting.
Catalog completion and rename use the shared bounded SC2 workspace link index; rename is refused
when the workspace snapshot is incomplete or ambiguous.

MCP uses the generic Modkit host tools. `modkit.language` exposes the language features,
`modkit.invoke_readonly` invokes conversion/validation plus the paged
`blizzard/sc2-triggers.tree-page` and `blizzard/sc2-triggers.element-get` operations, and
`modkit.propose_edit` previews revision-pinned plans without writing them. Alongside gamelink
rename, the codec exposes `parameter-update`, `element-insert`, `element-move` and
`element-delete`; callers address elements by library/type/id and inserted XML must be one valid
`Element`. These structural operations preserve surrounding source bytes. Reference and `Root`
metadata repair remains an explicit higher-level operation because its policy depends on the
element type and workspace.
