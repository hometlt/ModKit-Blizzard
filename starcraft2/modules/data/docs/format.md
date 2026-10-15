# StarCraft II GameData codec

`sc2-data` is the semantic data codec over the schema-backed catalog, GameData language, and
ordered mod-content APIs. It opens one catalog or an ordered dependency chain, then exposes
catalog queries, inheritance resolution, references, and diagnostics.

## Routing

Generated routing requires the `.xml` extension, a `GameData` path, the `Catalog` XML root, and
an enclosing `sc2-mod`, `sc2-map`, or `sc2-campaign` artifact. The bounded detector remains the
structural authority and verifies schema-known catalog classes instead of claiming arbitrary XML.

## Runtime and operations

The current detector and runtime are conservatively Node-only because their catalog and language
analysis import graph reaches unresolved `vscode-languageserver-protocol` submodules. Available
operations inspect and search the catalog, resolve inheritance, find references, and validate the
loaded files.

Results are only as complete as the ordered `GameContentResolver` chain supplied by the host.
Override-layer comparison, raw-preserving edits, export, and entity-card assembly remain
unavailable, so support is partial.
