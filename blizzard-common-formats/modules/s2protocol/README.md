# s2protocol

Browser-safe StarCraft II replay stream decoding shared by Blizzard extensions. The module decodes
self-describing details/tracker streams and build-specific init/game/message streams. Protocol
tables load on demand. Exact build selection is the default; callers must explicitly request
`fallback: 'nearest-lower'` and surface the returned diagnostic when exact data is unavailable.

All decode entry points accept `signal`, `maxDepth`, `maxNodes`, `maxScalarBytes`, and `maxEvents`.
The module performs no filesystem, process, credential, or network access.

The generated protocol tables originate from Blizzard's open-source `s2protocol` project. See
`PROVENANCE.json` and regenerate/verify them with `scripts/generate-s2protocol-tables.mjs`.
Pinned generator inputs live under `blizzard-common-formats/tools/s2protocol/source-data`; they are
repository tooling inputs and are not shipped as part of the runtime module.
