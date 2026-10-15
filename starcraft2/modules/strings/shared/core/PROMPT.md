# @modkitx/strings — handoff prompt

Browser-safe SC2 localized-strings core. Implements Phase A of
`docs/tasks-complete/entity-cards-strings/PLAN-strings-cards-views.md`.

## Status

Done (with tests):
- `constants.ts` — `SC2_LOCALES` (13), `STRING_CATALOGS`, locale/file canonicalizers.
- `markup.ts` — `parseMarkup`/`serializeMarkup` (byte-exact round-trip), `markupCatalogRefs`.
- `resolve.ts` — ref-expression tokenizer + recursive-descent evaluator, `resolveStringValue`,
  `resolveFieldPath`, `validateStringRefs`. Decoupled via the `CatalogResolver` interface.
- `render-html.ts` — `renderMarkupHtml` (colors, `<br>`, `data-ref` spans, icon hook).
- line-model re-exported from `@modkitx/xml` (`parseSc2StringsOrdered`, `setStringValue`, …).

Not yet built (later Phase A/B steps):
- `analysis.ts` — missing/orphaned/identical/referenced analysis (A6).
- `cache.ts` + `translate.ts` — translation cache + Google translate (A7).
- `@modkitx/strings/node` — git diff + staging (A8).

## Rules

- Stay browser-safe (no `node:*`). Node-only helpers go in a `/node` subpath later.
- Follow the specs: `docs/tasks-complete/entity-cards-strings/STRING_REF_GRAMMAR.md`, `STRING_FILE_MODEL.md`.
- The ref-expression evaluator is the high-risk piece — extend its tests when adding
  forms. `$Token$` stays a placeholder (never a number).
- `resolve.ts` depends only on `CatalogResolver`, never on `@modkitx/mods-processing/sc2-mod-core` directly.

## Test

```
cd packages/strings && npx vitest run
```
