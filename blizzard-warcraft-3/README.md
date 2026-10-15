# blizzard/warcraft-3

Warcraft III format codecs maintained in the standalone Blizzard extension repository. Historical
conversion receipts remain in the archived source workspace and are intentionally excluded from
this runtime package.

| contribution                          | module                                     | status  |
| ------------------------------------- | ------------------------------------------ | ------- |
| `blizzard/war3-mdx`                   | `src/war3-mdx/codec.js`                    | partial |
| `blizzard/war3-mdx-native-encoder`    | `providers/war3-mdx-native-encoder/`       | partial |
| `blizzard/warcraft3-installation`     | `providers/war3-installation/`             | partial |

## Layout

```text
src/lib/war3-model/      vendored MIT war3-model 4.0.1 parser and generator (MDX + MDL)
src/lib/mdx-m3-viewer/   vendored MIT mdx-m3-viewer map-document parsers (w3i, w3e, wpm, doo, …)
src/war3-mdx/detect.ts   format detection
src/war3-mdx/render-model.ts  the Warcraft III adapter: RenderModel, effects, replaceable textures
src/war3-mdx/scene.ts    RenderModel -> MK3 model facets
src/war3-mdx/uvm.ts      those same facets -> UVM, plus UV_game_effects and BlizzardMDX
src/war3-mdx/codec.ts    the MK3 codec surface: detection, budgets, cancellation, facets
src/war3-mdx/native-encoder.ts   UVM -> Warcraft III, with and without a BlizzardMDX residual
src/war3-mdx/encoder-provider.ts common.model/native-encoder for war3-mdx
src/war3-mdx/codec.js    runtime entry; re-exports the build output under dist/
src/game/installation.ts common.game/installation-discovery for Warcraft III
src/game/content-sources.ts  modkit.contentSources: a classic installation's MPQ chain as one tree,
                         and the context of a map or script (the installation's Scripts under it)
src/war3-map/map.ts      a map's documents through the vendored parsers; terrain grids as map layers
src/war3-map/codec.ts    blizzard/war3-map over the blizzard/mpq container: tree, players, layers
src/war3-replay/         blizzard/war3-replay: .w3g players, chat, APM, build order, JSON export
src/jass/, src/wts/      JASS and trigger-string languages (parsers and language providers)
```

This package carries no MK2 tree. The adapter above is authored MK3 code compiled under the
package's strict profile; only the vendored third-party parser keeps a compatibility profile
(`tsconfig.vendored.json`), the way every vendored library in this repository does. The MK2 game
discovery it used to hold — a `.build.info` sniff that, by its own comment, could not tell
Warcraft III from any other Blizzard CASC product — was replaced rather than copied: the MK3
provider reads the active build record and matches the product.

`MDX-PORT-PROVENANCE.json` records every copied file with its source path and digest, and every
edit made to copied code. Licensing is in `licenses/THIRD-PARTY-NOTICES.md`.

## Build

```bash
pnpm --dir blizzard-warcraft-3 run build
```

`tsconfig.mk2-port.json` compiles the copied libraries under a compatibility profile and emits
their declarations; `tsconfig.json` compiles the authored MK3 code against those declarations with
every strict base flag intact. The contribution entrypoint stays `src/war3-mdx/codec.js`, which
re-exports `dist/war3-mdx/codec.js`.

## What it reads

The model projection retains up to four authored UV sets, including layer `CoordId`, through the
common facet, UVM and native writer. Reforged baked AO is selected by shading flag `0x400` and reads
UV1. Unsupported counts are refused rather than flattened. Full visual acceptance is separate.

Resolved data plans ordinary map, map-skin and campaign object changes, optional AbilitySkin and
UnitWeaponsSkin profiles, and map/campaign WTS. String changes resolve `TRIGSTR_n` in their own scope;
missing keys remain authored with a diagnostic. Version 3 has an opaque integer array before one
change list per object (not repeated sets); inspection exposes the entire array and both tables.
The native parser/writer preserves these integers byte-for-byte and refuses a lossy downgrade.
Resolved data admits empty/single-zero headers only; other header semantics are unknown and the
entire document is diagnosed rather than partially applied. Native Editor v3 acceptance is unverified.
Optional `UI/UnitEditorData.txt` supplies native `unitRace`/`moveType` IDs to `DataSchemaField.type` without
changing catalog string values. Labels/additional columns are not members. Whole-file overlays apply;
malformed domains, indexed/repeated/conditional/conflicting metadata or unlisted values do not
become universal enums. Numeric types/units/defaults, localized labels, version/mode filtering and
typed editing remain open.
Other editor domains are not inferred as scalars: their flag/list semantics still need qualification.
Native empty/`_`/`-` strings retain their values through the common enum `unknown` marker, not
additional native choices. This does not promise native validation of a future edit.

Geometry, materials and texture layers, bones and pivots, sequences with their node
translation/rotation/scaling channels, and model bounds, published as `model-scene-source`,
`model-material-source`, `model-resource-refs-source`, `model-skeleton-source` and
`model-animation-source`. Replaceable texture ids resolve to their canonical Warcraft III paths.
Explicit ATCH attachment and PRE1 particle-model paths are reference-only `sidecar` entries in
`model-resource-refs-source`, with their authored spelling (including `.mdl`); opening stays with
the Host resource port. These references do not promise attachment playback or bound resources.
UVM/core cannot bind these non-image dependencies: export reports the common resource-closure
remainder; native paths remain in the residual rather than becoming glTF image entries.
Attachments and collision shapes are published as `model-socket-source` and
`model-collision-source`, particle, ribbon and popcorn emitters as `model-effect-source`, cameras as
`model-camera-source` (position and target in their properties: a camera is not a node) and lights
as `model-light-source`, joined to the node each light is.

## Conversion

`model.export-uvm` emits UVM through the common model projection, with native effects joined to the
existing effect vocabulary. A request may state `metersPerSourceUnit`; without one a Warcraft III
world unit is 0.35 m (owner decision 2026-09-23).

Emitters go to `UV_game_effects` under the `mdx` profile, in the common vocabulary the extension
declares, with each whole-timeline track cut into sequence-local `sequenceAnimation` tracks (the
form StarCraft II publishes). A global-sequence track runs concurrently in each clip on its own
wrapping clock. Ribbon `KRCO` colours cross as `sequenceAnimation.color`, preserving interpolation
and tangents through MDX/MDL/UVM/native reconstruction. Nonzero ribbon gravity remains in the native
residual and is reported as unprojected; its falling motion is not yet qualified. A Warcraft III
emitter names a texture rather than a material, so the projection publishes one material per such
emitter carrying that texture — the extension requires a material index, and an invented one would
be worse than an explicit translation.

A geoset animation's colour (GEOA) tints every pass of its geoset, as the game multiplies it in:
the geoset's primitive carries it as vertex colour and the pass materials use vertex colour. A
fixed colour is stored red first, a track's keys blue first. An animated colour keeps its first key.

`BlizzardMDX` holds only reconstruction facts: encoding, format version, the native node records,
sequence intervals and material/layer metadata. No source bytes.

Hermite and Bezier tracks — nearly every shipped model's — are published as `cubic-spline` and
become glTF CUBICSPLINE: each key carries its derivative per second, a Hermite tangent divided by
the key interval, a Bezier control point as `3·(control − value)` leaving and `3·(value − control)`
arriving. A key without its tangents leaves the channel unstated, and the conversion reports it.

A billboarded node (flag 0x8) turns to the camera as mdx-m3-viewer turns it (`inverse-camera`); an
axis-locked one (0x10, 0x20, 0x40) is an `aim` that keeps that axis of its frame and turns its Y (lock X)
or X (locks Y, Z) to the viewer — exact where its parents and own rotation leave its axes as authored.
CameraAnchored (0x80) keeps its authored rotation; the writer does not write billboard flags back.

Team colour (replaceable 1) is the player's colour itself. Team glow (replaceable 2) in an additive
pass is that colour weighted by the red of `TeamGlow00` (`alpha1`): every `TeamGlowNN` of the game is
that red in its slot's colour, opaque. A team glow in another filter mode draws `TeamGlow00` as it is.

A Reforged HD layer (layer shader 1, or a 1000-format `Shader_HD_*` material, with an ORM map) is
the common PBR material: its ORM map's red is the occlusion (`ao`), green the roughness, blue the
metallic, and its alpha the team colour mask, which mixes the player's colour into the base before
light (`teamColorMaskMix`: hue by √mask, brightness toward the team colour by 0.95·mask², the game's
`hd.bls` as W3ModelViewer documents it). The normal map is BC5; the emissive map is added after
light by the layer's gain, and a static gain of 0 leaves it out. The sixth slot, the environment map,
is never sampled by the game and is not used: HD metal reflects the lighting set's IBL probe. The
layer adds the specular element of Lordaeron Summer's day probe (`Day_IBL.dds#layer=1&mip=3&faces=
0,5,2,3,4,1`: element 1, one prefiltered level, the game's face order) by the reflected ray where the
ORM is metallic, tinted by the base colour (F0 = albedo × metallic). One level stands for every
roughness until a material samples its level by roughness; the irradiance element is not used.

A Reforged geoset skins by its own SKIN record when it has one — four bone indices, then four
weights in 1/255, over the same matrix list as the classic groups — and keeps its authored tangents
(TANG). Its level of detail (0 the full model, 1–3 coarser copies, −1 every level) is published as
`common.view/model-lod-source` and as the materializer's `lods`: each level's geoset nodes are scene
roots grouped per level (MSFT_lod), so a viewer draws LOD 0 and switches, as the game does, instead
of drawing every copy at once.

A texture-id track (KMTF: Reforged's water, fountains, coral, up to 178 textures) flips a layer
through its textures. The common material samples one texture per slot, so the layer becomes one
pass per texture its track names (`…-frame-<id>`), each with that texture in every flipbook slot —
diffuse and normal flip together — and a visibility channel shows each pass only while the track
names its texture; a track on a global sequence repeats its cycle from the sequence's start. Every
texture a pass draws, these and the HD reflection probe, is a resource of the model.

Event objects (EVTS) are clip events (`ModelAnimationClip.events`, `UV_game_animation_events`):
each key of the object's track inside a sequence fires at the object's node, and a track on a global
sequence fires every cycle. The kind (SND sound, SPN spawned model, SPL or FPT splat, UBR uber splat)
and the table row (what follows the name's fourth character) ride in the payload; playing them —
the sound, the spawned model, the splat — is for a player that reads the game's tables.

## Writing

`model.write` re-emits the decoded model as MDX or MDL and verifies the result by reopening it.

The `common.model/native-encoder` provider writes a Warcraft III model back from UVM. With a
`BlizzardMDX` residual it restores the native declarations; without one — a document exported by
another game — it builds the target format from the common structures alone, and says so rather
than pretending to have recovered chunks it never saw.

For source-free PRE2, static one-pass surface materials preserve priority and Unshaded; WC3
particle metadata also preserves ReplaceableId, SortPrimsFarZ and Unfogged. Native integer bounds and
metadata types are checked without coercion. Animated, multi-pass and non-surface programs
are refused instead of being sampled at the first key. Existing common lineEmitter/modelSpace/
xyQuad flags also restore their native bits; head/tail and squirt remain intact. This preserves native storage, not
runtime particle sorting/fog, lighting fidelity or native Editor acceptance.

Vertex skinning round-trips: Warcraft III matrix groups become the portable four-weight skin on
the way out and are rebuilt from it on the way back. Groups larger than four influences were
already capped at four by the decode; that cap is carried, not corrected.

Readback tests check authored geometry and animation after UVM/native conversion. They do not
establish pixel-identical rendering, native Editor acceptance or fidelity for every model.

### Converting from another game

A UVM document with no `BlizzardMDX` residual is built into a Warcraft III model from the common
structures. A Warcraft III geoset has no transform of its own, so the node that places a mesh is
baked into its vertices, and the clips' TRS channels become node tracks laid out end to end on the
one Warcraft III timeline. Values change basis with the same fixed mapping as the geometry:
`(x, y, z) -> (x, -z, y)`. A cubic-spline channel is written as Hermite, each tangent the derivative
times the seconds to the neighbouring key.

One limitation is the format's, not the code's: a Warcraft III bind pose is pivot points, with no
per-bone bind rotation or scale. A source skeleton whose bind pose carries rotation cannot be
stated exactly, and parts bound to such bones sit at their pivot instead. Geometry, materials,
clips and the hierarchy convert; the bind pose is approximated, and re-binding the skin to remove
that approximation is separate work.

## The installation

`src/game/content-sources.ts` is the extension's `modkit.contentSources` module. For a classic
installation — the one the user selected, or else the one discovery finds — it offers the root
`local:warcraft3` with `storageOf` the installation: opening the installation folder opens this
root. It shows `war3.mpq`, `War3Local.mpq`, `War3x.mpq`, `War3xLocal.mpq` and `War3Patch.mpq` as
the one tree the game reads, a later archive's file replacing the same path in an earlier one. The
archives are read through the MPQ library by range and kept open. The patch archive names nothing
(no `(listfile)`): its files appear under the names the archives below give them, and a path none
of them names is still read through the patch's hash table, though it cannot be listed.

A Reforged installation (the `w3` CASC product) gets the same root over its storage, read through
the shared CASC installation reader of `@modkit/blizzard-casc` with its name index in the host's
index cache. Reforged names its files by nested manifests (`war3.w3mod:_hd.w3mod:units/...`);
`src/game/reforged.ts` stacks the overlays the game reads — the HD art over the base, the locale
over each — so the tree shows `units/human/footman/footman.mdx` once, from the overlay the game
reads it from. Options `artSet` (`hd`, default, or `sd`) and `locale` (`enus` unless set) choose
the overlays as the game's settings do; tileset, teen, balance and deprecated overlays are not
merged. A model writes its textures as `.blp`, `.tga` or (HD) `.tif` while Reforged ships `.dds`,
and some moved (`filealiases.json`): the overlay answers such a path with the stored `.dds`, and a
model's context places it under that name, so the DDS codec reads it.

## Maps

`blizzard/war3-map` opens a `.w3m` or `.w3x` over the host's `blizzard/mpq` container: the map is
recognised by `war3map.w3i`, its documents are read with the vendored mdx-m3-viewer parsers, and
`TRIGSTR_n` names come from `war3map.wts`. It publishes a tree (information, players, forces,
terrain, doodads, units, regions, cameras, sounds, imports), a player table and six map layers
through `map.layers`/`map.layer-read`/`map.layer-write`: ground height, cliff level and water level (world
height = (sample − 8192) / 4, a cliff level 128), ground tileset, corner flags and pathing. Corners
and pathing cells are stored south row first; layers read north row first. A layer write replaces
only the written samples of `war3map.w3e` or `war3map.wpm`, and the host packs the entry back
through `blizzard/mpq`.

A protected map (DotA and the like) lists no names: the host finds its documents by exact path
through the MPQ hash table (`lookup`), so it opens as a map all the same.

## Map world

A map opened as `blizzard/war3-map` shows as a world through the common map preview:
`blizzard/war3-map-preview` prepares it as the map (the opened archive) above the game installation,
which the host resolves through the content sources, and `blizzard/war3-map-world` turns the map's
documents and the game's tables into the world snapshot. Terrain: the corners of `war3map.w3e`,
128 units apart from its centre offset, at ground height plus cliff level, in the game world frame
(x east, y north, z up). Materials: each corner's ground tileset, the texture `Terrain.slk` names,
its full-ground tile in every cell; each cell also states its tilesets as layers from the lowest
(Warsmash `getTextureVariations`), the others over it by the atlas tile of the corners they hold,
which the map world draws once its renderer reads layers (ground variation tiles not yet). A
blighted corner shows its tileset's blight texture (`TerrainArt\Blight`, material `tile-blight`) over the others. Objects: the doodads and
destructables of `war3map.doo` and the units and items of `war3mapUnits.doo`, each with the model
its table names after the map's object-editor changes, its variation, angle and scale; the models
load from the installation through `blizzard/war3-mdx`. Cliffs are pieces of the installation's
cliff models named by the levels of a cell's corners (`CliffTypes.slk`), ramps the installation's
ramp wall models over two cells with the slope's middle half a level up (rules adapted from
WarsmashModEngine, AGPL-3.0; see `licenses/`); water is zones of cells with
a water corner at its level (`TerrainArt/Water.slk`). The map's namespace and `container.extract`, which
this route reads its documents through, are the MPQ carrier's, lent to the map by the host. Units, items and start
locations stand on the terrain; the map's players come from its information file, each
slot in its colour (`TeamColorNN`, twelve slots of 1.24), which tints its units' team-colour layer. The world converts
to UVW through the transform of ADR-WORLD-003, proved against mdx-m3-viewer on an installed melee map
(the half level of a ramp entrance is drawn only). Regions (`war3map.w3r`) are rectangles in world units with the
editor's colour. Cameras (`war3map.w3c`) are camera objects at their target and yaw; their distance, angle,
roll and field of view, and lighting, are not published. Pathing cells (`war3map.wpm`) are the world's navigation
summary, sampled up to the request's limit.

`blizzard/war3-map-encoder` (`common.map/native-encoder`, format `war3-map`) writes a world back as a
`.w3x`: terrain corners (height, cliff level, tiles named `tile-XXXX`, at most 16), doodads, units and
start locations, an information file with one player per start. A world in other units is rescaled
to 128 per cell. A `tile-blight` corner is blighted over the default tile. Water, ramps, regions, cameras, sounds, object data and the map script are
not written; each loss is a `blizzard.war3/map-*` diagnostic. The map opens again as `blizzard/war3-map`.

## Object data

`blizzard/war3-resolved-data` (`common.data/resolved-workspace@1`) resolves units, items, abilities,
buffs, upgrades, destructables and doodads from the game's SLK sheets (core
`parseSylk`) and INI profiles (`parseIni('ini-war3')`); a map's own copy of a table replaces the
game's. Fields typed as id lists in the metadata link objects (trains, builds, sells, abilities),
a missing target as a dead link.

Metadata link rules are scoped to their object kind. Conditional `useSpecific`/`notSpecific` and conflicting
row types are not projected as universal links; their values remain authored text. Numeric/enum
types, units/defaults and mixed-target requirements still need their qualified projection.

`blizzard/war3-object-mods` reads the object editor's changes (`.w3u`, `.w3t`, `.w3b`, `.w3d`,
`.w3a`, `.w3h`, `.w3q`, alone or as `war3map.*` in a map): changed standard objects and custom ones
with their base, each change's field, level, data column, type and value, as a tree and a table.
Doodad files of format 1 carry no level or data columns (every one the 1.24 campaign maps ship);
a file whose tables leave bytes over is refused. The resolved data applies a map's changes over the
game's tables: each change lands in the field its metadata id names (`uhpm` → `UnitBalance.HP`,
`Hbz2` at level 2 → `AbilityData.DataB2`, a profile index → one element of its list), and a custom
object inherits its base. Buffs use `AbilityBuffData.slk` and `AbilityBuffMetaData.slk`; `.w3h`
changes their distinct `buff` namespace. Shared ability profiles route sections by declared buff
IDs and typed `.w3h` declarations, independent of document order. IDs declared as both ability and buff are diagnosed:
their shared profile is not guessed. Without a buff declaration a profile remains in its original
ability namespace. Native `Bufftip`/`Buffubertip` declarations identify buffs in Classic deployments
without editor sheets; generic `Art`/`Name` and rawcode prefixes do not. Missing metadata is diagnosed
rather than fabricating field mappings.

## PopcornFX bakes

Reforged's own effects — CORN emitters, a third of its effect models and every HD spell — point at
PopcornFX 2 bakes (`.pkb`, 811 in the HD view). `blizzard/war3-pkb` (`src/war3-pkb`) reads them:
`bake.ts` the container (records of classes with untyped fields, typed by the schema the game's bakes
were measured to use, an unnamed field skipped by the encoding under which its record still parses),
`effect.ts` the effect — its layers with their particle fields, samplers (curves, shapes, event
streams, turbulence), renderers (billboard mode, blend, texture, atlas) and payloads, and the graph of
which layer's events spawn which — and `script.ts` the compiled scripts, decoded into constants and
instructions of a 12-opcode VM. The codec publishes the effect as a tree, a layer table and a JSON
export. Every bake of the installed game reads (811, 19 831 scripts, 325 210 instructions). The
format is measured, not specified; W3ModelViewer's notes (`mdxres/research/popcornfx-*.md`, MIT)
are the reference. The scripts are decoded, not yet run: nothing is simulated or drawn.

## Replays

`blizzard/war3-replay` reads a classic `.w3g` (header version 1, patches 1.07 to 1.26): blocks are
zlib streams cut at a sync flush (`loadInflateSync('zlib-flushed')`), then the game record —
players and slots, the map, chat, leaves and time slots. Actions are decoded from patch 1.15 by
`references/w3g-format/w3g_actions.txt`, corrected where the installed replays disagree (0x11–0x14
one byte longer, 0x6B a game-cache sync). The header states the game's length without its pauses:
the time slots less the paused time match it within a slot or two on every installed replay. A
game abandoned before it began keeps no record and is refused by name; Reforged is refused.

## What it does not do yet

Global-sequence emitter tracks are reported, not converted. The world's ground variation tiles,
GUI triggers (`wtg`/`wct`), a replay timeline and replays on the map are
later stages.

## Corpus

Models are not bundled. Geometry is exercised against a fixture authored through the vendored
writer; the real tier (`war3-installed-corpus.test.ts`, `MODKIT_WARCRAFT3_ROOT` or discovery) opens
the installed archives, a shipped model with its textures and animations, and the installation
tree through the host.
