# StarCraft II Cutscene module

This module owns the lossless `.SC2Cutscene`, `.StormCutscene` and legacy `.SC2Scene` codec and the shared
`common.language/document-analysis@1` provider for the cinematic XML dialects.

The language provider supplies XML tokens, diagnostics, hierarchical symbols, completion, hover,
local and cross-file definition/references, GUID rename, colours, and final-newline
formatting/code actions. It consumes the codec's lossless model, validator, registry, timeline and
reference rules, so editor results and codec inspection use one parser.

Hosts reach it through the generic Modkit adapters: MCP through `modkit.language`, editors through
`modkit-lsp`. The module ships no LSP or MCP server of its own.

GUIDs are scoped to their document; the only cross-file reference is `referenceGuid` beside a
non-empty `referenceFile`. With a complete workspace a rename edits the declaration, its local
references and every include. With an incomplete one it edits the primary document only, and is
refused when a visible document includes the GUID. Formatting changes only the requested
final-newline state, because arbitrary indentation would break byte-preserving round trips.

Attach points and tangent types are measured from the corpus; see `docs/sc2-cutscene.md`.
`edit.structure` stays `dependency-required` until edited files are verified in SC2 Editor.

## Changes to the public shape (2026-09-15)

Visible to MCP clients of the `timeline` operation and to TypeScript consumers; no consumer in
this repository was affected.

- `timeline` output: the `convention` field is removed; `approximateClips` now counts only anchors
  with an unmeasured attach point or cycles (0 across the shipped corpus).
- `resolveTimeline(document)` takes no convention argument; `AttachPointConvention` and
  `attachPointEvidence` are removed.
- `CutsceneCurveChannel`: `tangentIn`, `weightIn`, `tangentOut`, `weightOut` are renamed to
  `controlInTime`, `controlInValue`, `controlOutTime`, `controlOutValue` — they are Bézier control
  points, not tangent/weight pairs. New: `tangentModeOf`, `sampleChannel`.
- Validator report entries gain source offsets (`start`, `starts`, `unknownTagStarts`,
  `externalCutsceneStarts`) and findings gain an optional `location`; `REFERENCE_ATTRIBUTES` now
  includes `objectGUID`.

## Native evaluation foundation (2026-10-13)

`blizzard/sc2-cutscene.scene-at { timeMs }` returns a revision-bound, partial native state:
resolved intervals, sampled properties, camera selection and addressed limitations. Compilation
is lazy per codec session and reuses the existing timeline/curve owners. No playback events,
resource I/O, rendering, audio or writes occur during random access. The input schema is generated
from `codecs/cutscene/src/codec.ts` into `codec.json` via `src/define.ts`.

`evaluate.ts` owns compilation/state; `playback.ts` owns bounded, clock-free bookmark/pause/end
traversal. It is not yet connected to the shared transport. Native timing/control semantics remain
provisional; locked-to-end uses stored durations, retimed/invalid curves are diagnosed, model cameras
require model resources/poses, and attachments/fade/light/audio are authored requests only.
Structural editing remains dependency-required. No new UV format or SDK source is registered.

The main implementation order is in
[`PLAN_SC2_CUTSCENES_2026-10-13.md`](../../../../docs/MK3/PLAN_SC2_CUTSCENES_2026-10-13.md),
with the delivered slice in
[`CUTSCENE_IMPLEMENTATION_FOUNDATION_2026-10-13.md`](../../../../docs/MK3/CUTSCENE_IMPLEMENTATION_FOUNDATION_2026-10-13.md).
`LANGUAGE_PROVIDER_PLAN.md` covers the language provider only.


## World preview foundation (2026-10-13)

The existing `common.view/world-scene-source` now exposes a partial SC2 adapter. Host catalog
resolves CModel links; shared catalog-model rules select paths/variations; Host ModelResources
and worldSceneModel publish UVM geometry, animations and textures. Optional `frame(timeMs)`
samples transforms and TargetCamera without resource I/O or transport mutation. MCP
`modkit.world_scene` render accepts `timeMs` and `camera: source | orbit` and uses the common
CPU renderer. Supply the selected campaign's baseMods and the standard Models/Images codecs.
Model cameras, attachments, blend layers, native lighting/effects/audio and playback UI remain
unsupported. The authored lens axis is preserved (`verticalFOV=1`, otherwise horizontal),
with viewport conversion in the common scene renderer. Rotation and final visual parity still
require native Editor verification; no guessed model-facing yaw is applied.

Legacy `.SC2Scene` / `ActorState` uses the same codec; its current partial scope is described below.

## Legacy SC2Scene playback

ActorState/ActorNode/AnimLayerNode/AnimBlock are a second dialect of the same reader and writer.
The adapter uses authored model paths and exact FileNode M3A paths through Host resources. M3 owns
hash admission and typed native animId binding against the base rig; common UVM materializer and
animation compositor attach bone TRS. The camera actor Cam_Export uses the sampled model camera,
including bone rotation/roll and the authored lens axis. No second parser, player clock or renderer.

Current scope: bone TRS, one projected camera and sparse full-weight priority layers. FaceFX playback, native scene
lighting, blending, RTT/video materials and non-TRS M3A channels remain explicitly partial.
Side-only channels have no invented target; the derived UVM retains a binding report. Native bytes
are unchanged. Direct editing remains gated on native Editor verification, deferred by the user.

## Conversation FaceFX bindings

`blizzard/sc2-cutscene.facial-at({timeMs})` publishes active conversation clips, enclosing actors,
`CModel.FacialController`/explicit `fxaOverride`, and every resolved `Sound.AssetArray` variation.
It uses the same compiled timeline and catalog port as the world adapter, with no filename guesses.
The result retains authored facial group/animation, asset offset/pitch/weight and native clip offsets.
`elapsedSeconds` is the provisional line clock; it is not an assertion of native offset/pitch parity.
Locale-sensitive `FacialFile` paths remain authored paths for the selected resource context.
The operation does not play sound, evaluate FaceFX graph links or apply facial bone poses.
FXA/FXE reading and curve sampling remain at `oc3/facefx`; common scene owns pose rendering.

Reference research for M3A interpolation, composite alpha, native tint/light and GPU RTT is
recorded in [render reference research](RENDER_REFERENCE_RESEARCH_2026-10-14.md).
It distinguishes verified source behavior from native parity hypotheses and pending renderer work.

The current fidelity work order is in [cutscene fidelity plan](FIDELITY_PLAN_2026-10-14.md):
WhiteoutFlakes is the primary implementation reference; native SC2 validates animation, placement,
camera, RTT and material/light behavior. Targeted binary analysis is an optional evidence path.
