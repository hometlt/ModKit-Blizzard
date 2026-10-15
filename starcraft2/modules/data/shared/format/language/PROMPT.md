# AI Prompt — sc2-data GameData language core

## Goal

Maintain the pure, editor-agnostic language-analysis core for SC2 GameData XML
(`*Data.xml` catalog files): offset-aware scanning, completion, validation, hover,
definition, and reference resolution. Consumed by the GameData LSP server
(`extensions/blizzard/starcraft-2/codecs/sc2-data/src/language/` — see
`docs/tasks-complete/gamedata-lsp/PLAN_gamedata_lsp.md`)
and by the `vscode-modkit` extension's in-process fallback path (active while
`modkit.gamedata.useLsp` is off).

## Key files

- `xml-scan.ts` — lenient, position-aware XML scanner (`scanXml`, `elementPathAt`, `attrAt`); never throws on mid-edit input
- `entity.ts` — catalog-entity location under the `<Catalog>` wrapper
- `completion.ts` — `computeCompletions`: classes / fields / attributes / enum-flags / link ids / assets / tokens
- `diagnostics.ts` — `collectIssues`: unknown field/attribute, bad enum value, unresolved reference, default cascade, namespace-per-file, EditorCategories
- `hover.ts` — `computeHover` / `computeEntityLenses` over an injected `HoverCatalog`
- `definition.ts` — `definitionRequestAt` / `locateEntityOffset`
- `references.ts` — `referenceTargetAt` / `findReferences` / `collectAllRefs`
- `usages.ts` — usages in non-catalog files (Triggers XML semantic, Galaxy/Layout textual)
- `docs.ts` — field type labels, docs URLs, XSD prose ingestion
- `index.ts` — public re-exports (all consumer imports go through here)

## Engineering rules

- **No `vscode` import, ever.** No `vscode-languageserver` either — this package is
  editor-agnostic; adapters live in `vscode-modkit` (and later the LSP server).
- Positions are character offsets into the source text. Mapping to editor
  Ranges/Positions is the consumer's job.
- Everything schema-driven through `@modkitx/data-processing/sc2-catalog` introspection (`getClassFields`,
  `classifyField`, `lookupField`, `validateFieldValue`, …). Never hardcode field names;
  never import `@modkitx/data-processing/sc2-schema` directly in `src/` (test fixtures may).
- Catalog *contents* (which entities exist) are injected via narrow callback interfaces
  (`CatalogHas`, `LinkIds`, `HoverCatalog`, `EditorCats`, `EntityTokens`) — this package
  never loads mods itself.
- All inputs may be mid-edit / malformed — degrade, don't throw.
- All core exports flow through `index.ts` and the extension's `./sc2-data/language-core` subpath.

## Related packages

- `@modkitx/data-processing/sc2-catalog` — schema introspection + entity resolution driving everything here
- `@modkitx/editor` — `ApplicableCategory` for EditorCategories completion/validation
- `@modkitx/triggers` — Triggers XML parsing for `triggerUsages`
- `vscode-modkit` — maps these cores onto VS Code providers (in-process fallback path)
- `@modkitx/lsp` — the GameData+GameStrings server (`src/gamedata/`) consuming these cores
- `@modkitx/mods-processing/sc2-workspace` — loads the mods whose catalogs back the injected callbacks
