# World of Warcraft

World of Warcraft for Modkit.

- `providers/wow-installation` — installation discovery (`common.game/installation-discovery`):
  an active `.build.info` record of a `wow*` product, candidates from the host's probes and folder
  search. One folder holds every installed product (retail, classic, classic era, PTR, beta).
- `src/game/content-sources.ts` — each product's storage as one tree (`local:wow`,
  `local:wow_classic`…) over the shared CASC installation reader; files by listfile path, every
  file also as `filedataid/<id>`.
- `contributions/codec-wow-m2.json` → `src/m2/` — M2 models (`blizzard/wow-m2`): chunked and flat
  files of versions 264–274, the first skin profile and the `.anim` files of external sequences
  read as `filedataid/<id>`, shared SKEL/SKPD chains, separate AFM2/AFSB/AFSA domains,
  scene, materials, texture references, skeleton, sockets, clips, and
  `model.export-uvm` through `@modkit/uv`. Adapted from WhiteoutLib/WhiteoutFlakes (`NOTICE.md`).
- BFID companions of M2 and its SKEL chain are read once through the same resource port. The
  profile-1 BONE reader retains BIDA indices and BOMT matrices in the native inspection tree,
  checks skeleton indices and finite values, and reports unread or invalid files separately.
  FacePose application to animation/UVM remains an explicit unsupported feature.
- `src/game/community-data.ts` — the wowdev listfile and TACT keys, fetched into the host's index
  cache directory and refreshed weekly.

`src/db2/` contains an unregistered WDC5/DBD reader prototype: bounded native metadata and typed
rows, immediate/common/pallet/array storage, copy rows, sparse strings and relationships.
Definition text is supplied externally; no WoWDBDefs dataset is bundled. This does not yet expose
resolved creature or character appearance through product operations.

`src/appearance/creature.ts` resolves explicit display/model foreign keys and creature texture
slots 11/12/13 from typed rows of the same build/product/locale. Provenance and unresolved native
geoset/particle/NPC-composite references are retained. It is a source-only resolver; scale fields
remain separate until their client composition is qualified.
The existing M2 scene builder accepts its explicit native slot map and uses it consistently in
material layers, shader texture paths and logical UVM resource closure. Selection is not yet a
public product operation; no display, character preset or texture is guessed automatically.

One unlit/no-fog, single-texture RGB/alpha profile publishes animated colour, alpha, weight,
wrapping and translation-only UV transforms through the existing material program. Independent
clocks survive UVM readback; CPU colour maths are tested at three times. This is not full native
shader, GPU/depth or multi-layer qualification. Other profiles retain explicit limitations.

Remaining: CASC decryption, exact Host companion lookup/vendor delivery, game-chosen textures and
character appearance, exact native quaternion interpolation, remaining material profiles and UV matrices,
portable UVM texture closure, WMO and ADT. Native UV tracks and attachment enable tracks are read,
but their unsupported projection is reported. Owner: GAME-WOW / MODKIT-WOW (`../../AGENTS.md` §1).
