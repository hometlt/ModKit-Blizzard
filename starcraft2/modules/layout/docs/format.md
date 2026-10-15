# StarCraft II layout codec

`sc2-layout` is the semantic layout codec over the SC2Layout parser. It retains source XML and
exposes structural parsing, inspection, diagnostic HTML rendering, HTML export, and raw export.

## Routing

Generated routing requires the canonical `.SC2Layout` extension and the `Desc` XML root. The
bounded detector remains responsible for recognizing SC2Layout declarations and rejecting
unrelated XML.

## Runtime and operations

The current detector and runtime are conservatively Node-only because the layout parser import
graph reaches Node code. The available renderer produces structural diagnostic HTML, not a
resolved in-game visual result. Raw export preserves the original XML.

Dependency-workspace resolution, schema validation, language features, visual rendering, edit
planning, and source saving remain dependency-required or disabled, so support is partial.
