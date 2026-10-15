# AI Prompt — @modkitx/galaxy

## Goal
Two roles in one package:
1. Typed Galaxy AST surface over sc2-galaxy-lang + EngineAst lowering (Galaxy source → EngineAst).
2. T2G pipeline — convert Triggers XML (via @modkitx/triggers' TriggerLibraryJson) into Galaxy script.
   Relocated from the now-deleted @modkitx/make-galaxy package; behavior is unchanged.

## Key files
- `src/source.ts`, `src/reader.ts` — Galaxy parsing/analysis via sc2-galaxy-lang
- `src/to-engine.ts` — Galaxy source AST → EngineAst lowering
- `src/trigger-to-galaxy.ts` — T2G entry: `convertTriggerLibraryToGalaxyFull`
- `src/ttg-actions.ts` — action converters, `convertAction`, `parseSimpleRawStatement` (fast regex path)
- `src/ttg-convert.ts` — expression/param converters
- `src/ttg-core.ts` — naming, context, `classifyScriptCodeAction`
- `src/ttg-params.ts` — param expression builders
- `src/ast-factory.ts` — Galaxy AST node constructors used by the T2G emitter
- `src/galaxy-check.ts`, `src/cli.ts` — standalone Galaxy script linting / CLI entry
- `src/t2g-galaxy-diff.spec.ts` — diff against real .galaxy outputs (primary T2G regression test)

## Engineering rules
- AST node types must match sc2-galaxy-lang exactly; do not add custom node variants
- **No hardcode**: `classifyScriptCodeAction` must match from loaded `FunctionDef.scriptCode`, never from display name
- **No NativeLib guessing**: all function IDs/names from loaded mod data
- OOM prevention: `parseSimpleRawStatement` handles common customscript patterns without invoking `new Parser()`; use it for fast paths
- All libraries pre-loaded into `allLibraries` before conversion loop (cross-library function resolution)
- Payload sentinel constants (`UNKNOWN_SUBFUNC_SENTINEL` etc.) live in `@modkitx/triggers/src/payload-sentinels.ts`,
  not here — they're needed by both T2G (this package) and G2T (@modkitx/triggers), and putting them in triggers
  avoids a galaxy⇄triggers dependency cycle. Re-exported from this package's index.ts for compatibility.
- Payload encoding (`__MKX_FCJSON__`) must be preserved for round-trip fidelity with G2T in @modkitx/triggers
- **Sandbox testing gotcha**: if you ever see `UNKNOWN_SUBFUNC_SENTINEL`/`UNKNOWN_SUBFUNC_TYPE_SENTINEL` resolve to
  `undefined` inside `buildEncodedUnknownFunctionCallExpr` (`ttg-convert.ts`) during a test run, check whether your
  test harness is loading `payload-sentinels.ts` through two different specifiers at once (e.g. a relative import
  from within @modkitx/triggers plus a `@modkitx/triggers` path alias both pointing at the same file). Vite/Vitest
  can instantiate that as two separate module records, and the `@modkitx/galaxy` re-export ends up reading the
  *other* instance's (uninitialized-at-that-point) binding. This is a module-resolution artifact, not a bug in this
  code — confirmed in this repo's case via a load-counter in payload-sentinels.ts (loaded twice, two different IDs).
  Real `pnpm test`/`pnpm -r typecheck` runs don't hit this since every package resolves `@modkitx/*` through a
  single node_modules symlink.

## Related packages
`@modkitx/triggers` (TriggerLibraryJson source + G2T reverse pipeline + payload sentinels), `@modkitx/engine` (EngineAst), `sc2-galaxy-lang`
