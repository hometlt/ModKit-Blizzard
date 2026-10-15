# MK3 completion evidence

Scanned 648 production files in registered extension modules/ and shared/.
Remaining direct legacy dependencies: 25 exact file/specifier/kind records, 25 occurrences.
This baseline prevents growth; it does not prove zero legacy, transitive dependency closure, package cleanliness, or functional acceptance.
Scope excludes test/tests/__tests__, scripts, dist, artifacts, node_modules, and *.test/spec/config sources. It does not resolve tsconfig aliases or package exports.

Computed imports requiring an exact source-hash review: 1.

- blizzard-common-formats/modules/s2protocol/index.js: `./protocols/data/protocol${resolution.selectedBuild}.js`

## Legacy imports

| File | Kind | Specifier | Count |
| --- | --- | --- | ---: |
| starcraft2/modules/banks/codecs/bank/src/artifact-codec.ts | import | @modkit/codec-kit/legacy/assets | 1 |
| starcraft2/modules/banks/codecs/bank/src/artifact-codec.ts | import | @modkit/codec-kit/legacy/core | 1 |
| starcraft2/modules/banks/codecs/bank/src/artifact-codec.ts | import | @modkit/codec-kit/legacy/semantic | 1 |
| starcraft2/modules/banks/codecs/bank/src/describe.ts | import | @modkit/codec-kit/legacy/assets | 1 |
| starcraft2/modules/banks/codecs/bank/src/describe.ts | import | @modkit/codec-kit/legacy/semantic | 1 |
| starcraft2/modules/banks/codecs/bank/src/detect.ts | import-type | @modkit/codec-kit/legacy/assets | 1 |
| starcraft2/modules/banks/codecs/bank/src/detect.ts | import | @modkit/codec-kit/legacy/assets | 1 |
| starcraft2/modules/banks/codecs/bank/src/document.ts | import-type | @modkit/codec-kit/legacy/assets | 1 |
| starcraft2/modules/data/shared/catalog-engine/index.ts | export-type | @modkit/codec-kit/legacy/assets | 1 |
| starcraft2/modules/data/shared/catalog-engine/registry.ts | export | @modkit/codec-kit/legacy/semantic/data | 1 |
| starcraft2/modules/data/shared/format/codec.ts | import | @modkit/codec-kit/legacy/assets | 1 |
| starcraft2/modules/data/shared/format/codec.ts | import | @modkit/codec-kit/legacy/core | 1 |
| starcraft2/modules/data/shared/format/describe.ts | import-type | @modkit/codec-kit/legacy/assets | 1 |
| starcraft2/modules/data/shared/format/describe.ts | import | @modkit/codec-kit/legacy/assets | 1 |
| starcraft2/modules/data/shared/format/entity-subject.ts | import | @modkit/codec-kit/legacy/assets | 1 |
| starcraft2/modules/data/shared/format/relation-provider.ts | import-type | @modkit/codec-kit/legacy/entity-cards | 1 |
| starcraft2/modules/layout/shared/format/codec.ts | import | @modkit/codec-kit/legacy/assets | 1 |
| starcraft2/modules/layout/shared/format/codec.ts | import | @modkit/codec-kit/legacy/core | 1 |
| starcraft2/modules/layout/shared/format/describe.ts | import | @modkit/codec-kit/legacy/assets | 1 |
| starcraft2/modules/layout/shared/layout-engine/index.ts | export-type | @modkit/codec-kit/legacy/assets | 1 |
| starcraft2/modules/layout/shared/layout-engine/index.ts | export | @modkit/codec-kit/legacy/semantic/layouts | 1 |
| starcraft2/modules/layout/shared/layout-engine/sc2-layout-core/index.ts | export | @modkit/codec-kit/legacy/sc2-support | 1 |
| starcraft2/modules/layout/shared/layout-engine/sc2-layout-core/index/store.ts | import | @modkit/codec-kit/legacy/sc2-support | 1 |
| starcraft2/modules/map/codecs/package/src/codec.ts | import | @modkit/codec-kit/legacy/assets | 1 |
| starcraft2/modules/mod/codecs/mod/src/codec.ts | import | @modkit/codec-kit/legacy/assets | 1 |

## Registered codec/provider capability status

{"partial":48,"supported":19,"unspecified":12}

Status and limitations below are author declarations, not independent acceptance results.

### blizzard/blp — partial

Source: blizzard-common-formats/codecs/blp/codec.json

- The dependency-free MK3 profile validates BLP1 and BLP2 headers and mip ranges and decodes the top mip of every layout that does not need a JPEG decoder: BLP1 and BLP2 palettised at alpha depths 0, 1, 4 and 8, BLP2 block-compressed as DXT1, DXT3 and DXT5, and BLP2 uncompressed BGRA.
- JPEG-compressed BLP1 and BLP2 payloads stay metadata-only: no JPEG decoder exists in this platform, so the codec offers no decoded access rather than returning invented pixels.
- Only mip level zero is exposed as decoded pixels; layer, face and slice selection stay at zero.
- The codec is read-only; texture writing and mip generation require the pending writer/service contract.

### blizzard/diablo3-app — partial

Source: blizzard-diablo/contributions/codec-diablo3-app.json

- Decodes APP v260 submeshes, positions, normals, tangents, primary UVs, indices, skin weights, bounds, material names and the authored bone hierarchy with its bind and parent-local transforms.
- Animation (.ani), animation set (.ans) and actor (.acr) records are decoded by the same module; animation bytes reach a model through the host companion route, and model.companions publishes the sidecar patterns this appearance implies.
- Physics meshes, invisible materials, equipment tiers and exact duplicate submeshes are marked in mesh metadata rather than dropped.
- Material shaders and texture resolution, rendering and model writing remain unsupported.
- An index outside its submesh vertex range is refused; this profile does not silently drop corrupt geometry.

### blizzard/diablo3-installation — partial

Source: blizzard-diablo/providers/diablo3-installation/provider.json

- Discovery is bounded to configured paths, the MODKIT_DIABLO3_ROOT environment root, Windows uninstall-registry entries and verified platform defaults; it never scans a drive.
- An installation is confirmed by the active record in .build.info naming the Diablo III CASC product. The payload directory is reported as evidence but not required.
- Diablo II is not discovered here: it has no MK3 game subject, and the MK2 copy this replaces carried no product identity to port.
- Launching, provisioning and content mounting are outside this provider.

### blizzard/diablo3-tex — partial

Source: blizzard-diablo/contributions/codec-diablo3-tex.json

- The dependency-free MK3 profile validates Diablo III TEX v47 mip and face ranges and decodes A8R8G8B8, A4R4G4B4, L8, A8, and component-planar BC1, BC2, BC3, and BC5 payloads.
- The .tex extension is shared with unrelated formats, so hosts must retain the Diablo III magic/version evidence when routing candidates.
- Atlas frame cropping, texture writing, and mip generation remain unsupported.

### blizzard/galaxy — partial

Source: starcraft2/modules/galaxy/codecs/galaxy/codec.json

- The native adapter executes the exact-pin Galaxy scanner, parser, binder, full type checker, language service and EngineProgram AST lowering.
- The separate Galaxy language provider retains native API, hover, signature, definition, workspace-link and mixed-document services.
- edit.structure returns a revision-pinned edit plan; applying it remains host-owned.
- export.convert prints the parsed Galaxy AST and remains lossy for comments and source formatting; blizzard/galaxy.to-engine produces EngineProgram data only. Compilation and execution remain owned by the separately permissioned sc2-runtime codec.
- blizzard/galaxy.to-triggers converts the current document to a Trigger library using supplied dependency libraries. It returns XML and a conversion report; unsupported syntax or unresolved references produce diagnostics. SC2 Editor compatibility is not yet verified.

### blizzard/galaxy-language — unspecified

Source: starcraft2/modules/galaxy/providers/language/provider.json

- No explicit limitations declared; owner review required.

### blizzard/mpq-fresh-writer — unspecified

Source: mpq/contributions/writer-fresh-mpq.json

- No explicit limitations declared; owner review required.

### blizzard/sc2-attributes — partial

Source: starcraft2/modules/map/codecs/documents/attributes/codec.json

- Attributes is preserved as schema-less XML because no authoritative Blizzard schema is available.
- Whole-document replacement validates the Attributes root and preserves caller-provided XML bytes; lobby workflow behavior is not claimed.

### blizzard/sc2-authored-text-writers — unspecified

Source: starcraft2/shared/editing/providers/authored-text/provider.json

- No explicit limitations declared; owner review required.

### blizzard/sc2-bank-language — unspecified

Source: starcraft2/modules/banks/providers/language/provider.json

- No explicit limitations declared; owner review required.

### blizzard/sc2-campaign — partial

Source: starcraft2/modules/campaign/codecs/campaign/codec.json

- Opens MPQ-backed campaigns through the host-owned container alias and uses the same bounded namespace semantics as the loose-directory variant.
- Publishes a schemaVersion 1 inventory of nested mission maps, campaign/shared SC2Mod layers, and native CCampaign metadata through tree, table, facts, relations and blizzard/sc2-campaign.inspect-missions.
- CampaignData launch maps, bank lists, progress achievements and campaign prerequisites are projected when authored. Installed campaign dependencies are resolved from DocumentInfo plus the engine-defined Core/Liberty/Swarm/Void and Story package graph. CampaignData.xml is edited as a nested blizzard/sc2-campaign-data subject so every write remains bound to the file revision. Mission order implemented by scenario logic and creation of a missing CampaignData.xml namespace entry remain workspace concerns.

### blizzard/sc2-campaign-data — partial

Source: starcraft2/modules/campaign/codecs/data/codec.json

- Edits an existing CampaignData.xml as its own revision-bound subject and preserves XML outside the selected CCampaign declaration.
- Scenario-defined mission order and creation of a missing CampaignData.xml remain workspace concerns.

### blizzard/sc2-campaign-directory — partial

Source: starcraft2/modules/campaign/codecs/directory/codec.json

- Opens an explicitly mounted loose SC2Campaign directory, publishes its complete bounded namespace, package/bank facts, BankList/Bank/Galaxy relations, and a schemaVersion 1 inventory of nested mission maps, campaign/shared SC2Mod layers, and native CCampaign metadata.
- Contained map selection is owned by the StarCraft II workspace and map providers. Installed campaign dependencies are resolved from DocumentInfo plus the engine-defined Core/Liberty/Swarm/Void and Story package graph.
- CampaignData launch maps, bank lists, progress achievements and campaign prerequisites are projected when authored. CampaignData.xml is edited as a nested blizzard/sc2-campaign-data subject so every write remains bound to the file revision. Scenario-defined mission order remains explicitly unresolved; creation of a missing CampaignData.xml namespace entry, campaign playback, native signing and launch are not advertised.

### blizzard/sc2-cell-attribute — partial

Source: starcraft2/modules/map/codecs/documents/cell-attribute/codec.json

- CellAttribute has no self-describing dimensions; standalone inspection stays raw until the caller supplies MapInfo width and height.
- Pnp paint is not claimed as fully composed effective navigation.

### blizzard/sc2-cell-flags — partial

Source: starcraft2/modules/map/codecs/documents/cell-flags/codec.json

- Native grid values are exposed through the shared bounded numeric-grid API.
- Header fields, trailing bytes and every unedited cell are preserved by the native writer.

### blizzard/sc2-cliff-level — partial

Source: starcraft2/modules/map/codecs/documents/cliff-level/codec.json

- Native grid values are exposed through the shared bounded numeric-grid API.
- Header fields, trailing bytes and every unedited cell are preserved by the native writer.

### blizzard/sc2-custom-ai — partial

Source: starcraft2/modules/map/codecs/documents/custom-ai/codec.json

- The undocumented AIData schema is exposed as lossless opaque XML.
- Schema-aware AI editing and runtime execution are not claimed.

### blizzard/sc2-cutscene — partial

Source: starcraft2/modules/cutscene/codecs/cutscene/codec.json

- Reading and byte-identical rewriting are complete for the shipped SC2 and Heroes of the Storm corpus.
- Structural editing stays dependency-required until edited files are verified in SC2 Editor through the single writer path.
- Resolved times mark anchors with an unmeasured attach point as approximate and the time unit as probable milliseconds.
- External names are published as relations; workspace mounts own reference resolution.
- Scene preview requires cutscene runtime natives and the shared scene renderer.

### blizzard/sc2-cutscene-language — unspecified

Source: starcraft2/modules/cutscene/providers/language/provider.json

- No explicit limitations declared; owner review required.

### blizzard/sc2-data — partial

Source: starcraft2/modules/data/codecs/sc2data/codec.json

- The native adapter executes the pinned MK2 Catalog parser, metadata, query, inheritance, reference, validation, entity-rename and export implementations.
- Entity rename canonically rebuilds affected GameData XML, so formatting and comments in edited files are not preserved.
- Override-layer comparison remains explicitly disabled by the pinned codec descriptor; Node provisioning is published separately through common.runtime/operation-provider@1.

### blizzard/sc2-data-language — unspecified

Source: starcraft2/modules/data/providers/language/provider.json

- No explicit limitations declared; owner review required.

### blizzard/sc2-document-metadata — partial

Source: starcraft2/modules/mod/codecs/document-metadata/codec.json

- Portable structural inspection distinguishes H2CS DocumentHeader, cdes .version sidecars, DocInfo XML and Components XML (ComponentList.SC2Components, read-only) without relying on the filename; an empty .version sidecar requires an enclosing SC2Map, SC2Mod, or SC2Campaign path.
- DocumentInfo serialization normalizes XML formatting and entity spelling.
- DocumentHeader checksums are preserved as opaque fields but cannot be recomputed after semantic edits.
- source.save remains disabled; edit.content returns a revision-pinned edit plan for host persistence.

### blizzard/sc2-fluff-doodad — partial

Source: starcraft2/modules/map/codecs/documents/fluff-doodad/codec.json

- Reads native decoration records and exposes a validated set-doodad edit.
- Header padding, trailing bytes and untouched records are preserved.

### blizzard/sc2-hard-tile — partial

Source: starcraft2/modules/map/codecs/documents/hard-tile/codec.json

- The reverse-engineered block layout is exposed for inspection but remains partial.
- Semantic writes are disabled; raw export is byte-exact.

### blizzard/sc2-height-map — partial

Source: starcraft2/modules/map/codecs/documents/height-map/codec.json

- World-space height requires t3Terrain.xml quantization and geometry context supplied by the map coordinator.
- The edit operation replaces one native grid cell and preserves header padding, trailing bytes and all other cells.

### blizzard/sc2-layout — partial

Source: starcraft2/modules/layout/codecs/layout/codec.json

- The native adapter executes the pinned MK2 layout parser, structural renderer, descriptor, raw export, reference rename, schema checker, selector, workspace resolver, state application, expression evaluation, layout solver, display-list builder and HTML renderer.
- The protocol-neutral language contribution retains completion, hover, definition, references, safe rename, symbols and diagnostics; the pinned stateful S2LServer remains an LSP compatibility adapter rather than a second host.
- Cross-codec rename coordination, automatic installed-archive workspace loading, resolved localization and asset bytes, rasterized game rendering, and installed-editor acceptance remain assigned to M7/M8.

### blizzard/sc2-layout-language — unspecified

Source: starcraft2/modules/layout/providers/language/provider.json

- No explicit limitations declared; owner review required.

### blizzard/sc2-map — partial

Source: starcraft2/modules/map/codecs/package/codec.json

- Opens MPQ-backed maps through the host-owned blizzard/mpq container alias and uses the same bounded namespace parser for loose maps.
- The native adapter parses every pinned modeled entry family, preserves every unknown entry, composes DocumentHeader, DocumentInfo and version metadata, and renders height, cliff, pathing, cell-flags, painted-pathing, texture, overlay, vertex-color, cliff-vertices, cliff-cells, overview and navigation PNG layers.
- The richer M4 edit-world transaction remains the write surface; the host delegates native-preserving or deterministic MPQ commit to blizzard/mpq.
- Cross-codec coordinated rename, a 3D map scene, signing, native launch execution and installed-editor acceptance remain outside this milestone.

### blizzard/sc2-map-directory — partial

Source: starcraft2/modules/map/codecs/package-directory/codec.json

- Opens an explicitly mounted loose SC2Map directory and uses the same map document, world projection, preview and revision-pinned edit operations as the packed map codec.
- Dependency references are reported by the codec; installation-backed dependency resolution is owned by the StarCraft II workspace provider.
- Nested edit plans target the authored loose files; Blizzard signing and native launch remain outside this contribution.

### blizzard/sc2-map-info — partial

Source: starcraft2/modules/map/codecs/documents/map-info/codec.json

- The fixed header, dimensions, heuristic strings and validated playable boundary are exposed.
- MapInfo, MapInfo_LS and MapInfo_NoLS use the same verified versioned binary container; the suffix changes document role, not the binary schema. The version-dependent body remains byte-preserved and structurally read-only.

### blizzard/sc2-map-objects — partial

Source: starcraft2/modules/map/codecs/documents/objects/codec.json

- Known objects and catalog references are modeled; unsupported child elements may be normalized by structural edits.
- Reference edits are revision-pinned to the exact opened Objects document.

### blizzard/sc2-map-regions — partial

Source: starcraft2/modules/map/codecs/documents/regions/codec.json

- Circle, rectangle, diamond and unknown shape payloads supported by the existing parser are exposed.
- Structured edits normalize XML formatting and may omit unmodeled elements.

### blizzard/sc2-mod — partial

Source: starcraft2/modules/mod/codecs/mod/codec.json

- Opens MPQ-backed mods through host-owned MPQ container composition; the semantic codec does not import or duplicate MPQ logic.
- Dependency graph order is resolved through common.mod/workspace-composition@1; dependency content hydration remains available through the Node workspace facade.
- edit.structure fails closed until shared container composition can atomically create a new locale entry alongside ComponentList replacement.

### blizzard/sc2-mod-directory — partial

Source: starcraft2/modules/mod/codecs/directory/codec.json

- Opens an explicitly mounted loose SC2Mod directory through the native namespace adapter.
- Dependency graph order is resolved through common.mod/workspace-composition@1; dependency content hydration remains available through the Node workspace facade.
- edit.structure fails closed until shared container composition can atomically create a new locale entry alongside ComponentList replacement.

### blizzard/sc2-painted-creep — partial

Source: starcraft2/modules/map/codecs/documents/painted-creep/codec.json

- Supports the verified fixed 512 by 512 two-channel storage layout; shorter or unknown layouts remain raw and read-only.
- Channel bytes can be inspected and patched losslessly, but creep lookup-table semantics remain unclaimed until CASC corpus evidence is available.

### blizzard/sc2-painted-pathing — partial

Source: starcraft2/modules/map/codecs/documents/painted-pathing/codec.json

- Supports the verified fixed 512 by 512 two-channel layout; shorter or unknown layouts remain raw and read-only.
- Cell edits replace one byte and preserve bounds, the other channel, other cells and trailing bytes.

### blizzard/sc2-preload — partial

Source: starcraft2/modules/map/codecs/documents/preload/codec.json

- Known preload entries, attributes, catalog references and asset paths are modeled.
- Structured edits normalize comments, whitespace and line endings.

### blizzard/sc2-preload-asset-db — partial

Source: starcraft2/modules/map/codecs/documents/preload-asset-db/codec.json

- Sections, entries, fields and resolved asset paths are modeled.
- Structured edits preserve known data but normalize comments, blank lines and line endings.

### blizzard/sc2-publication-header — partial

Source: starcraft2/modules/game/battlenet/codecs/publication-header/codec.json

- Read-only: the header is shown with the names the game gives its fields, and is not edited here. A revision is compiled by the publishing pipeline instead.
- Fields the schema does not name are shown by tag number.

### blizzard/sc2-replay — partial

Source: starcraft2/modules/replay/codecs/replay/codec.json

- Opens MPQ-backed replays through the host-owned container alias and reads the known replay.* streams as bounded namespace entries.
- The MPQ carrier exposes its bounded user-data preamble through the generic namespace contract. Replay inspection decodes the header, attributes, tracker and load-info streams and selects the exact bundled protocol automatically for init/game/message streams.
- blizzard/sc2-replay.decode-stream accepts an explicit build override and only permits nearest-lower fallback when requested. Tracker events publish a standard seekable transport (with a timeline of participants, unit and army-value series and born/died/upgrade markers), a synchronized sampled world scene and high-level replay analysis. Unit positions are interpolated tracker samples, not a game simulation. content.resolve-dependencies exposes exact cache handles from decoded initData for host-owned mounting. Analysis can resolve a supplied dependency-set request through common.data/resolved-workspace@1. Command intents remain numeric unless the caller supplies the matching stable IDs and resolved Abil catalog request for exact semantics. Editing and writing remain unavailable.

### blizzard/sc2-runtime — partial

Source: starcraft2/modules/runtime/codecs/runtime/codec.json

- The codec recognizes Galaxy runtime programs with a void main() entrypoint and publishes declarations, includes, and statically observed native-call counts.
- This inspection codec does not execute. The separate blizzard.starcraft2.galaxy-pure-bounded-v1 provider covers only pure zero-argument Galaxy functions plus deterministic v2 state; catalog simulation, replay assistance, Trigger XML lowering, general Galaxy semantics, and host-native bridging remain unavailable.

### blizzard/sc2-runtime-provider — partial

Source: starcraft2/modules/runtime/providers/runtime/provider.json

- The modkit.sc2/galaxy-pure-bounded-v1 profile executes only zero-argument Galaxy functions composed from direct calls and literal returns.
- External/native calls are reported as native-unavailable; Trigger XML is retained as native authored input but semantic lowering is unavailable.
- The separate modkit.sc2/playable-subset-v1 profile covers only catalog-backed Unit spawn/move/stop, fixed 16 Hz stepping and SimUnitArrived events; combat, economy, abilities, terrain, general Galaxy, replay/network behavior and native launch/signing/playback remain unavailable.

### blizzard/sc2-strings — partial

Source: starcraft2/modules/strings/codecs/strings/codec.json

- The native adapter uses codec-kit's canonical lossless ordered line model: BOM, comments, blank lines, per-line terminators, duplicate order, and untouched source bytes survive edits.
- Fallback and comparison accept a caller-supplied locale layer or a sibling locale of the same mod bound by the host (enclosing-container / current-mount); catalog reference resolution needs an injected catalog, and translation needs a configured common.language/translation provider.
- edit.content returns a revision-pinned complete-source edit plan; the shared SC2 writer performs permissioned host persistence.

### blizzard/sc2-strings-language — unspecified

Source: starcraft2/modules/strings/providers/language/provider.json

- No explicit limitations declared; owner review required.

### blizzard/sc2-style — partial

Source: starcraft2/modules/style/codecs/style/codec.json

- Attribute writes replace exactly the bytes of one value, so comments, ordering and formatting survive; there is no whole-document serializer.
- References are resolved against the documents in the request workspace snapshot; a name declared further up the dependency chain is reported as inherited rather than broken.
- The element and attribute table is evidence from installed style sheets, not a published schema, so an unrecognized attribute is a warning.
- source.save remains disabled; edit.field returns a revision-pinned edit plan for host persistence.

### blizzard/sc2-style-language — unspecified

Source: starcraft2/modules/style/providers/language/provider.json

- No explicit limitations declared; owner review required.

### blizzard/sc2-sync-height-map — partial

Source: starcraft2/modules/map/codecs/documents/sync-height-map/codec.json

- Signed synchronized heights and masks are exposed as a bounded numeric grid.
- World-height comparison requires t3Terrain.xml and t3HeightMap context.

### blizzard/sc2-terrain-xml — partial

Source: starcraft2/modules/map/codecs/documents/terrain-xml/codec.json

- Height geometry, texture and cliff declarations, authored cliff cells and ramps are exposed.
- Editing currently covers height quantization attributes while preserving all other XML bytes.

### blizzard/sc2-texture-info — partial

Source: starcraft2/modules/map/codecs/documents/texture-info/codec.json

- Texture names and per-cell uint32 texture indices are exposed through the shared bounded numeric-grid API.
- The native writer preserves the complete modeled file; relation to t3Terrain texture indices is resolved by the map coordinator.

### blizzard/sc2-texture-masks — partial

Source: starcraft2/modules/map/codecs/documents/texture-masks/codec.json

- Packed four-bit weights are exposed per layer through bounded inspection and native edits.
- Texture names are resolved from t3Terrain.xml by the map coordinator; this document stores weights only.

### blizzard/sc2-triggers — partial

Source: starcraft2/modules/triggers/codecs/triggers/codec.json

- The native M5 adapter executes the exact-pin TriggerData SAX reader, position-preserving source index, structure validator, G2T/T2G conversion, gamelink rename, and EngineProgram lowering.
- Callers supply dependency TriggerData and TriggerStrings explicitly; installed-game discovery remains host-owned and is proven separately against the installed NativeLib corpus.
- edit.content returns a revision-pinned whole-source edit plan. The registered authored-text writer owns commit and preserves byte identity for no-op edits.
- EngineProgram output is data only. Runtime execution remains owned by the separately permissioned sc2-runtime codec. Structural edits preserve complete Element source slices but do not automatically repair Root ordering metadata or references owned by other elements.

### blizzard/sc2-triggers-language — unspecified

Source: starcraft2/modules/triggers/providers/language/provider.json

- No explicit limitations declared; owner review required.

### blizzard/sc2-vertex-color — partial

Source: starcraft2/modules/map/codecs/documents/vertex-color/codec.json

- Reads VTCL paint-stroke bounds and authored color bytes.
- Color edits replace one byte and preserve unknown headers, padding, trailing data and all other strokes.

### blizzard/sc2-water — partial

Source: starcraft2/modules/map/codecs/documents/water/codec.json

- Native water zones and CWater template references are exposed.
- Zone edits preserve untouched records and unknown bytes; changing a template id replaces its fixed 40-byte field.

### blizzard/sc2-wizard — partial

Source: starcraft2/modules/wizard/codecs/wizard/codec.json

- The format follows Blizzard’s shipped FileFormat specification; the game ships no wizard documents, so fixtures are spec-derived plus a nine-file author-written corpus read in place.
- Catalog ref evaluation requires loaded SC2 data and fails closed when that dependency is absent.
- Catalog, entry-type and field-path checks require a host-provided schema.
- Unknown elements and attributes are preserved and reported as information.
- edit.field returns a revision-pinned edit plan that replaces exactly one existing value (input default, item value or text, macro text, named condition value, entry field value); it never adds, removes or reorders elements, and source.save remains owned by the host.

### blizzard/sc2-wizard-language — unspecified

Source: starcraft2/modules/wizard/providers/language/provider.json

- No explicit limitations declared; owner review required.

### blizzard/sc2-workspace-copy-writer — unspecified

Source: starcraft2/shared/editing/providers/workspace-copy/provider.json

- No explicit limitations declared; owner review required.

### blizzard/war3-mdx — partial

Source: blizzard-warcraft-3/contributions/codec-war3-mdx.json

- Decodes MDX and MDL geometry, materials and texture layers, bones and pivots, sequences with their node translation/rotation/scaling channels, and the model's own bounds, through the ported MK2 implementation over the vendored war3-model parser.
- Particle emitters 1 and 2, ribbon emitters, popcorn emitters, attachments, collision shapes, cameras and lights are decoded into the model's effect surface but are not yet published as their own facets.
- Hermite and Bezier animation tracks publish their keys without an interpolation, because a generic sampler cannot honour them; linear and step tracks state theirs.
- Replaceable texture ids (team colour, team glow, tileset trees) resolve to their canonical Warcraft III paths; opening any texture stays the host resource route's job.
- Geometry is exercised against a fixture authored through the vendored writer; a corpus of shipped Warcraft III models needs an installed game and is not bundled here.
- model.export-uvm emits UVM without UV_source_blob: geometry, materials, skeleton bindings, animation clips and the logical texture closure use common glTF/UVM structures, emitters go to UV_game_effects with the mdx profile, and BlizzardMDX keeps only native reconstruction facts. The request states metersPerSourceUnit; Warcraft III units have no declared metre length and one is never invented here.
- model.write re-emits the decoded model as MDX or MDL and verifies the result by reopening it. The separate common.model/native-encoder provider writes a Warcraft III model back from UVM.
- Vertex skinning exports through the portable four-weight skin. Warcraft III matrix groups larger than four influences were already capped at four by the decode, and that cap is carried rather than corrected here.
- Attachments and collision shapes are published as model facets: the attachment name is carried verbatim because scripts reference it, and no socket orientation is claimed because Warcraft III declares neither a forward nor an up axis for one.
- Particle and ribbon emitters are published as model effects, with their parameters in Warcraft III's own words; emitter simulation is not performed.

### blizzard/war3-mdx-native-encoder — partial

Source: blizzard-warcraft-3/providers/war3-mdx-native-encoder/provider.json

- Accepts UVM bytes and returns one Warcraft III model. It has no dependency on the StarCraft II extension or any other game.
- The document must carry the BlizzardMDX residual this repository's exporter writes: the native declarations are read from it rather than reconstructed from names. A foreign UVM document is refused instead of being filled in with invented chunks.
- Geometry, skin and the scene come from the common UVM structures; the residual supplies everything else, including the animation tracks glTF TRS cannot state.

### blizzard/warcraft3-installation — partial

Source: blizzard-warcraft-3/providers/war3-installation/provider.json

- Discovery is bounded to configured paths, the MODKIT_WARCRAFT3_ROOT environment root, Windows uninstall-registry entries and verified platform defaults; it never scans a drive.
- An installation is confirmed by the active record in .build.info naming the Warcraft III CASC product. The payload directory is reported as evidence but not required, because its name has moved between builds.
- Launching, provisioning and content mounting are outside this provider.

