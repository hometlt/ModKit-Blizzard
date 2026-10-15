# AI Prompt — @modkitx/triggers

## Goal
Two roles in one package:
1. Parse Triggers XML into a typed TriggerLibraryJson model + EngineAst lowering (trigger XML → EngineAst).
2. G2T pipeline — convert Galaxy script back into a TriggerLibraryJson (reverse of @modkitx/galaxy's T2G).
   Relocated from the now-deleted @modkitx/make-triggers package; behavior is unchanged.

## Key files
- `src/reader.ts`, `src/sax-reader.ts` — XML → TriggerLibraryJson (the model must faithfully represent the
  XML structure — do not normalize or simplify during parse)
- `src/types.ts` — all trigger model interfaces
- `src/to-engine.ts` — TriggerLibraryJson → EngineAst lowering (name-based CF dispatch, no hardcoded IDs)
- `src/payload-sentinels.ts` — `__MKX_SF__` / `__MKX_FCJSON__` sentinel constants; shared by T2G
  (@modkitx/galaxy) and G2T (this package) — lives here specifically to avoid a galaxy⇄triggers cycle
- `src/galaxy-to-trigger.ts` — G2T entry: `convertGalaxyToTriggerLibrary`
- `src/g2t-trigger-body.ts` — trigger/function body converters
- `src/g2t-actions.ts` — statement pattern recognizers
- `src/g2t-call.ts` — call expression → FunctionCall
- `src/g2t-payload.ts` — `__MKX_FCJSON__` payload decoder, `rehydrateFunctionCallPayload`
- `src/g2t-core.ts` — reverse-conversion context, `idFromKey` (deterministic IDs)
- `src/g2t-params.ts` — param expression converters
- `src/structure-validate.ts` — editor-invariant structural checks
- `src/roundtrip-diff.spec.ts` — roundtrip structural checks (no duplicate IDs, trigger counts);
  imports `convertTriggerLibraryToGalaxyFull` from `@modkitx/galaxy` (devDependency, test-only —
  no production file in this package imports @modkitx/galaxy)
- `src/native-check.spec.ts` — validates NativeLib parses without errors
- `src/trigger-strings.spec.ts` — validates TriggerStrings.txt parsing

## Engineering rules
- NativeLib.TriggerLib in `assets/sc2-data-triggers/mods/core.sc2mod/...` is the ground truth for all native function definitions
- `FunctionDef.scriptCode` must be preserved exactly as-is — G2T's `classifyScriptCodeAction`-equivalent logic dispatches on it
- **No hardcode**: all function routing from loaded FunctionDef data, never from hardcoded element IDs
- Deterministic IDs via `idFromKey` — remap table was removed; do not reintroduce it
- `crossLibFuncDefs` must be wired through context for cross-library function name resolution
- `rehydrateFunctionCallPayload` falls back to `lib${library}_gf_${sanitized}` key
- `crossLibFuncDefs` wiring is complete and verified working: threaded through `g2t-core.ts` → `g2t-call.ts`
  (actual lookup at `ctx.crossLibFuncDefs.get(calleeName)`) → `g2t-trigger-body.ts` → `galaxy-to-trigger.ts`,
  and `roundtrip-diff.spec.ts`'s Pass 2 passes it in (confirmed present back to at least commit `f970f8b`,
  i.e. before the make-triggers→triggers relocation). An older revision of this note claimed it was "still
  missing — add before release"; that was stale documentation, not a real gap — verified by running
  `roundtrip-diff.spec.ts` against `syn2lib.SC2Mod`, `vs-test.SC2Mod`, `customsciptcode.SC2Mod`,
  `vs-ar-ai.SC2Mod` (all pass). If you see this exact claim resurface elsewhere, check the actual code
  before trusting it.

## Related packages
`@modkitx/galaxy` (T2G forward pipeline + EngineAst Galaxy-source lowering), `@modkitx/engine` (EngineAst), `sc2-galaxy-lang`, `@modkitx/ops` (rename-triggers)
