# s2protocol generation inputs

`source-data` contains pinned, JSON-compatible TypeScript tables imported from the historical
Replay codec. They are immutable inputs for `scripts/generate-s2protocol-tables.mjs` and are kept
outside `modules` so package builds do not ship a second copy of the runtime tables.

The generated browser-safe JavaScript belongs to `modules/s2protocol/protocols/data`. Upstream
commit information, normalization rules, and generated hashes are recorded in
`modules/s2protocol/PROVENANCE.json`.
