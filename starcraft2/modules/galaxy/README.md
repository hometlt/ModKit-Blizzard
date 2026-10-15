# StarCraft II Galaxy module

Producer for `common.language/document-analysis@1`. It advertises Galaxy source routes through a
normal service-provider contribution and returns protocol-neutral semantic tokens, parser/binder/
type-checker diagnostics, document/workspace symbols, completion, hover, signature help,
definition, references, deterministic whole-document formatting and conservative
prepare-rename/rename edits.

Every semantic request carries exact full-document versions, explicit result/document limits and
an abort signal. Cross-file resolution uses a bounded workspace index and refuses ambiguous or
partial rename instead of guessing. The bundled `modkit-galaxy-script-api@1.0.0` catalog contains
3,341 deduplicated Core.SC2Mod native and script functions. Its source files, byte sizes and
SHA-256 digests are recorded in `data/galaxy-script-api.v1.json`; the complete catalog itself is
pinned by SHA-256 `b8375af39fb0ddd598682370721b8706e74777cd25118ec9c3581d214cd87d1e`.
`scripts/generate-native-api.mjs` deterministically produces the ignored
`language/native-api.generated.js` cache used by completion, hover and signature help. The root
`build` and `prepack` scripts create it automatically; `pnpm galaxy-native-api:check` validates the
tracked catalog and, when a generated cache exists, verifies that it is current. The open-source extraction approach remains
linked to `sc2-arcade-watcher/sc2-galaxy-toolkit@44ba5892` as an independent reference.

For StarCraft II workspaces the provider explicitly opts into bounded snapshots containing Galaxy,
TriggerData, SC2Layout and SC2 Data documents. Catalog navigation is limited to publisher-proven
literal positions such as the `UnitCreate` gamelink argument; dynamic strings and duplicate catalog
declarations are reported as partial instead of being guessed.

The compiler and provider contain no VS Code dependency. The same bounded formatting DTO is
consumed by the host and an LSP adapter. Trigger conversion lives in the sibling
`modules/triggers/services/galaxy-conversion` service and uses this module's Galaxy AST.

`modkitx-galaxy-lsp --stdio` packages the protocol-neutral provider as a standalone LSP. Its bounded
filesystem adapter indexes `.galaxy` files from the declared root/workspace folders, overlays open
incremental documents, and refreshes saved or watched files. A snapshot above the provider's file
or byte limits is marked incomplete, so workspace rename is refused instead of silently editing a
partial set. The standard `modkit.language` MCP tool activates the same provider; no Galaxy-specific
MCP server or duplicate parser is required.
