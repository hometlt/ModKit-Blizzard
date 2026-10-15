# StarCraft II Cutscene codec

This module owns the generated contribution and public runtime entrypoint. Parsing, timeline
resolution, curve sampling, relation projection, validation and lossless encoding remain split by
responsibility in `src/`. The measured attach-point and tangent semantics, the pending SC2 Editor
verification for editing, and the runtime-native preview dependencies are documented in the
package cutscene documentation.
