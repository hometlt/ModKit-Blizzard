# @modkitx/strings

Browser-safe core for SC2 localized strings: markup parsing, catalog-backed
resolution of `<d ref>` expressions, HTML rendering, and locale/string-file
constants. The ordered string-file line-model lives in `@modkitx/xml` and is
re-exported here.

See the design and specs:
- `docs/tasks-complete/entity-cards-strings/PLAN-strings-cards-views.md`
- `docs/tasks-complete/entity-cards-strings/STRING_REF_GRAMMAR.md`
- `docs/tasks-complete/entity-cards-strings/STRING_FILE_MODEL.md`

## What it does

| API | Purpose |
| --- | --- |
| `parseMarkup` / `serializeMarkup` | Parse a string value into ordered markup segments; round-trips byte-exact. |
| `markupCatalogRefs` | Extract every catalog reference embedded in a value (for relations/rename). |
| `resolveStringValue(value, resolver)` | Resolve `<d ref>` arithmetic and `<d stringref>` against catalog data. |
| `validateStringRefs` | Report broken `<d ref>`/`stringref` references against a catalog. |
| `renderMarkupHtml(segments, opts)` | Render resolved segments to styled HTML (colors, `<br>`, `data-ref` spans, icons). |
| `parseSc2StringsOrdered` … | Lossless line-model for `.txt` files (duplicate keys, BOM, EOLs preserved). |
| `SC2_LOCALES`, `STRING_CATALOGS` | The 13 locales and the canonical string-file names. |

## Resolver contract

`resolveStringValue` takes a minimal `CatalogResolver` so this package stays
decoupled from `@modkitx/mods-processing/sc2-mod-core`:

```ts
interface CatalogResolver {
  getResolved(ns: string, id: string): Record<string, unknown> | undefined
  getString?(key: string): string | undefined
}
```

The VS Code extension / `@modkitx/wiki` adapt a loaded `SC2Mod` to this interface.

## Markup forms handled

`<d ref="EXPR"/>` (arithmetic over `Ns,Entity,Field` tuples), `<d stringref="…"/>`,
`<d time="EXPR"/>`, `<n/>` (newline), `<c val="RRGGBBAA">…</c>` (color),
`<s val="Style">…</s>` (font style), and `$Token:args$` dynamic placeholders.
