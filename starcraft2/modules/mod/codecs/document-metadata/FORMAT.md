# StarCraft II document metadata formats

The `document-metadata` codec owns the small files that identify an SC2 package and its dependency
chain. These structures are independent contributions even though Map, Mod and Campaign packages
all consume them.

## `.version`

The version sidecar is either empty or a fixed little-endian structure parsed by `core/version-file.ts`.
An empty file means that no explicit version was recorded. Serialization preserves that semantic
absence and rejects malformed non-empty payloads.

## `DocumentHeader`

`DocumentHeader` is a compact binary header parsed by `core/document-header.ts`. It exposes the
document type and format version used for routing. The codec validates bounds before reading fields
and can reproduce a parsed header byte-exactly.

### Reverse-analysis notes

Known fields and offsets are represented by the parser rather than retained as an opaque source
blob. Unknown or unsupported structure is reported as a parse diagnostic.

## `DocumentInfo`

`DocumentInfo` is an XML document parsed by `core/document-info.ts`. It declares package metadata
and dependency references. Canonical serialization may normalize XML formatting while preserving
the represented values and dependency order.

## `ComponentList.SC2Components`

`ComponentList.SC2Components` is the package's manifest of loaded components: one `DataComponent`
per game data, localized text, document info or map part, each with a FourCC `Type` and, for text,
a `Locale`. `core/component-list.ts` recognises the `<Components>` root and reads the entries through
the shared SC2 component-list parser; the codec is read-only for this format.
