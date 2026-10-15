# SC2Cutscene

`blizzard/sc2-cutscene` reads `.SC2Cutscene` and `.StormCutscene`: the scene graph a campaign's
cinematics are authored in. Source is [`modules/cutscene/codecs/cutscene/src/`](../modules/cutscene/codecs/cutscene/src/); the contribution
is [`contributions/codec-sc2-cutscene.json`](../contributions/codec-sc2-cutscene.json).

The format has no published documentation. Everything asserted here was measured on the shipped
corpus — 336 SC2 and 1897 Heroes of the Storm files, 123.7 MB — by
[`modules/cutscene/scripts/census.mts`](../modules/cutscene/scripts/census.mts), which recomputes every
number below and runs the round trip:

```bash
node --import tsx starcraft2/modules/cutscene/scripts/census.mts references/SC2GameData
```

The analysis this implements is `reports/SPEC_PLAN_sc2cutscene_2026-09-08.md`.

## What works

| | |
|---|---|
| Read | every one of the 2233 shipped files, 0 parse failures |
| Write | byte-identical on all 2233 |
| Validate | dangling references, repeated identifiers, unknown tags, misplaced elements |
| Timeline | anchors resolved to absolute times, cycles detected |
| Dependencies | models, `.m3a` sidecars, sounds, conversations, facial animations, catalogs, other cutscenes |

## What does not, and why

The two attribute meanings editing depends on are measured from the 2233-file corpus
(`cutscene-corpus.test.ts` pins the counts); editing itself still waits on SC2 Editor verification.

**`startLinkAttachToPoint`** is 1 in 53 227 of the SC2 files' clips and 2 in 731. The editor stores
the resolved time beside each anchor, so the files answer it: 1 is the target's start, 2 its end,
and the distance is added. Of 4 774 anchors to targets with a duration, 4 767 confirm this and
none contradicts it. `resolveTimeline` applies it; any other value resolves like 1 and marks the
clip `approximate`.

**`curveInType` / `curveOutType`** take 0, 2, 3, 4, 5, 6 and 7 — never 1. `curveInValue` and
`curveOutValue` are the `time,value` of cubic Bézier control points, so sampling needs no type
(`sampleChannel`). The type records how the editor built the control point, and the geometry
separates them: 3 linear, 4 flat, 5 smooth (Catmull-Rom), 7 auto (smooth, flat at extrema),
6 custom (`tangentModeOf`). 0 and 2 show no consistent geometry and stay unnamed. Which Curve
Editor button (Smooth, Auto, Linear, Slow, Step, Custom) writes which number is not yet confirmed.

They are not only on curve keys, which the specification did not record: 58 `CCutsceneNodePathMarker`
nodes carry the two attributes directly — a path marker is a key on a spatial curve — and **all
three occurrences of type `2` in the whole corpus are among them**. A reader that looked only at
`CCutsceneElementPropertyCurve` would report six tangent types where the format has seven, and R2
would be asked the wrong question. `pathTangentsOf` collects them, and the two attributes are
collected independently because they are not on the same markers: 58 carry `curveInType` and 47
carry `curveOutType`.

The remaining check needs the game's Cutscene Editor: set each Curve Editor mode in turn, save,
diff the XML; anchor a clip to a target's start and then its end, save, reopen. Until an edited file
reopens identically, `edit.structure` is `dependency-required` and says so.

**Time unit** is reported as `milliseconds-probable`. `Zerg01`'s master sound is 199 800 units,
which is 199.8 s for an opening cinematic — good circumstantial evidence, not a measurement.
Comparing sound durations against the audio in CASC closes it.

**Preview** needs the 27 cutscene natives in the runtime and a scene renderer. Neither is here.

## Decisions worth knowing

**Identifiers are strings.** 15 486 of 719 417 identifiers in shipped files exceed `uint64_max`, and
every one of them exceeds `2^53`. `Number` collapses distinct identifiers onto the same double and
`BigInt64Array` overflows; both corrupt the reference graph while looking healthy. They are opaque
decimal strings, never normalised or reissued.

**Identifiers are not unique.** 33 are used twice, across 5 files. The index maps a guid to *how
many* elements carry it; nothing here assumes one.

**Dangling references are normal.** 3406 of 130 575 identifier references resolve to nothing inside
their own document — mostly `startLinkGuid`. They are warnings with a count, never a refusal to
open. The whole official corpus produces **zero** error-level findings, which is the design target:
a checker that calls Blizzard's own content broken teaches people to ignore it.

`referenceGuid` is the exception that needed a rule: on an element that also carries
`referenceFile` it names an element in *that* file, so it is not checked locally. In the corpus
every `referenceGuid` is of that cross-file kind.

**Unknown tags are preserved, not dropped.** Versions 1.2 and 1.3 both ship today and 1.4 will
arrive. An unrecognised tag is kept, written back unchanged, reported as information, and still
placed correctly in the tree — the format names every track `CCutsceneNode*` and every clip
`CCutsceneElement*` without exception, so the prefix is enough.

**Curve keys are typed arrays.** 209 804 keys in the corpus — 142 276 in the SC2 files alone, about
28 % of everything they contain — and tens of thousands in one large scene.
`curveChannelsOf` returns six `Float64Array`s and two `Uint8Array`s per channel rather than an
object per key.

**Whitespace is data.** The writer reproduces what it read rather than imposing conventions,
because the conventions are not universal: 162 files end with a newline, 18 misindent something, 2
use tabs, 15 put a space before `/>`, 4 carry a BOM, 10 declare `us-ascii`, 2 double-space two
attributes. Only elements this codec constructs are indented from the document's detected layout.

**One codec, two games.** 42 of 47 tags are common to SC2 and Heroes of the Storm; five are SC2-only
(`RTTChannel` node and element, `EnvironmentLight`, `MasterSound`, `SoundGroup`) and one is
Storm-only (`CCutsceneElementModelMaterial`). [`registry.ts`](../modules/cutscene/codecs/cutscene/src/registry.ts)
records the origin per tag, and the corpus test checks the record against both corpora. If Heroes
ever ships as its own extension, that table is the seam to split on.

**References are a relation graph, not `model-resource-refs-source`.** That contract's `role` is
`texture | sidecar`; a `soundLink` is neither, and naming it one would put a wrong fact into the
graph in exchange for reusing a contract.

## Tests

- [`modules/cutscene/test/cutscene.test.ts`](../modules/cutscene/test/cutscene.test.ts) — quick tier, no corpus needed.
- [`modules/cutscene/test/cutscene-corpus.test.ts`](../modules/cutscene/test/cutscene-corpus.test.ts) — real tier; needs an
  extracted GameData tree at `references/SC2GameData`, or `MODKITX_SC2_GAMEDATA_ROOT`. Skips when
  absent rather than failing.
