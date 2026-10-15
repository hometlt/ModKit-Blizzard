# StarCraft II bank codec

`sc2-bank` is the portable semantic save codec over `@modkitx/bank`. It parses, inspects,
validates, safely patches, serializes, exports, and signs StarCraft II bank XML.

## Routing

The manifest routes XML documents rooted at `Bank`. The bounded detector also understands the
`.SC2Bank` extension for direct codec and Open With diagnostics, but structural XML evidence is
required for generated automatic routing.

## Runtime and operations

Detection is portable across browser main threads, browser workers, Node, and Node workers. The
current semantic runtime is conservatively Node-only because its transitive `@modkitx/bank`
compatibility import is not yet classified as browser-safe by the repository validator.
`edit.content` uses the raw-preserving bank patcher and rewrites only the targeted value or type
tag. `source.save-as` deliberately serializes and normalizes the parsed XML, while `export.raw`
returns the original XML.

`save.sign` is available when signature metadata can be inferred from the player Banks path or is
provided explicitly. The codec returns output to the host and does not write the filesystem in
place.
