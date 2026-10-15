# StarCraft II reference ledger

These projects are pinned research or differential references. They are not runtime dependencies,
their source is not bundled by this repository, and a matching license does not make undocumented
game behaviour part of the Modkit contract.

| Reference                                                               | Pinned revision                            | License | Product use                                                                                                                                                                                                     |
| ----------------------------------------------------------------------- | ------------------------------------------ | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Blizzard/s2client-proto](https://github.com/Blizzard/s2client-proto)   | `7212ae512d15aa93a708e025d3ab9af4a9c4138f` | MIT     | Optional official runtime-oracle candidate for map identity, loaded mods and the public SC2 API; it does not replace dependency-merged static data. A read-only checkout exists at `references/s2client-proto`. |
| [chansey97/sc2-mined-data](https://github.com/chansey97/sc2-mined-data) | `147f41c74f6e39689736cd8cde16cde9330fcf7e` | MIT     | Historical SC2 `2.0.6.25180` schema-differential corpus for inheritance, enums, flags, limits and catalog links; it is not current schema authority.                                                            |
| [athre0z/gsvm-research](https://github.com/athre0z/gsvm-research)       | `2e3f3930b0fc6baf2982ef56b287d59f06d001cd` | MIT     | Archived, incomplete bytecode/disassembly research. It is not a Galaxy VM, compiler or Trigger XML reconstruction path; any future offline interpreter work begins after the Product GA pause.                  |

The active SC2 schema remains generated from the user-selected installed game through Modkit's
host-owned, dependency-merged pipeline. The active Trigger/Galaxy conversion remains a documented,
bounded semantic conversion and never claims to reconstruct editor-only metadata from bytecode.
| [FernandoS27/WhiteoutLib](https://github.com/FernandoS27/WhiteoutLib)   | local checkout, © 2026 Fernando Sahmkow        | BSD-3   | Format specifications used as the written authority for Blizzard model formats — `models/README.md` cites its M3 spec, and its MDX/MDL specs cover the Warcraft III codec. Its prebuilt Node WASM at `references/WhiteoutLib/build-wasm-node/wasm-dist` is usable as a differential oracle; no WhiteoutLib source or binary ships in this repository. |
