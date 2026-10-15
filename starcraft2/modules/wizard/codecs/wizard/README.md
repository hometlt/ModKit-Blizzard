# StarCraft II Data Wizard codec

This module owns the generated contribution and public runtime entrypoint. The parser, analyzer,
evaluator, outline and native writer live in this module's `src/` directory. Catalog references require
a host-provided SC2 schema, and structural editing is still outside the declared operation surface.
