# Galaxy ↔ Triggers conversion audit

Scope: `starcraft2/modules/triggers/services/galaxy-conversion`. This audit
checks the external claims against the active production service, not the
historical `references/modkitmk2` checkout.

## Repair outcome

**The five converter finding groups below are now repaired.** No repairs were
made to unrelated repository failures or frozen installed-corpus expectations.

- Validation reuses the language core's keyword-type singletons,
  assignability/comparability/condition/operator predicates, literal types,
  and shared binary-result typing. The core checker itself uses the shared
  result helper too. Invalid comparisons/arithmetic, unary return typing,
  missing compound-assignment cases, null-to-int, int/byte conversions, and
  numeric conditions are covered. This remains bounded declaration-driven
  validation, not a full dependency linker or SC2 execution engine.
- The semantic comparator includes typedef declarations and requires both
  sources to be free of parse errors before it can return `exact`.
- Alias resolution uses iterative postorder traversal, memoizes type objects,
  and visits shared normalized syntax once. The public 12,800-alias case
  passes. Counters now include actual resolver normalization work: wrapped
  chains of 200 and 400 visit 999 and 1,999 syntax nodes, rather than the old
  repeated 40,600 and 161,200 visits. The returned type DAG still represents
  the complete nested type; independent consumers must not naively expand
  shared tails and assume that expansion is linear.
- Reconstruction progress callbacks run in an isolated ID allocator. The
  outer allocator is restored in `finally`, including nested resets,
  synchronous internal conversion, and callback exceptions. Legacy
  multi-library session allocation outside callbacks is retained.

Repair verification:

- `pnpm exec tsc -p starcraft2/tsconfig.sc2-triggers.json`: passed.
- `pnpm exec tsc -p starcraft2/tsconfig.sc2-galaxy.json`: passed.
- `pnpm exec tsc --noEmit -p starcraft2/tsconfig.trigger-conversion.json`: passed.
- Owner-tier Trigger/Galaxy run: **471 passed in 20 files** (before the last
  four reverse-direction assertions were added as separate test cases).
- Latest complete conversion run: **404 passed in 7 files**, including
  **59 audit regression cases** in `audit-verification.test.ts`.
- `node scripts/verify-galaxy-conversion-audit.mjs`: **25 passed, 0 failed**.
  It now also checks reverse source/output failure status. Equivalent
  regressions are in the normal suite, not only in this standalone script.
- The normal suite checks 18 binary operators against the core across
  numeric/string/bool/fixed operands, every compound-assignment family,
  positive int/byte/condition cases, wrapped chain sizes 100–1,600,
  cycles, public concurrency/re-entry, and internal re-entry/exception paths.
- Illustrative post-repair wrapper timings for 100/200/400/800/1600 aliases:
  approximately 1.4/4.4/4.3/12/35 ms on this host. Deterministic work bounds,
  not timing thresholds, are enforced by tests.
- `git diff --check`: passed, with line-ending warnings only.

The previous repository-wide and real-corpus failures remain historical
verification evidence below. No new repository-wide clean-pass claim is made;
SC2 Editor runtime execution is still unverified.

## Independent verification follow-up (before these repairs)

**At the review stage, not everything was fixed.** The specific include/order, logical-binary,
loop-control, missing-return, and diagnostic-cap regressions pass. Broader
verification found remaining defects. This section supersedes the initial
blanket FIXED / EXPECTED BEHAVIOR conclusions below where noted.

Run the reproducible review probes after building the converter:

```powershell
pnpm exec tsc -p starcraft2/tsconfig.sc2-triggers.json
node scripts/verify-galaxy-conversion-audit.mjs
```

Before these repairs, the independent script reported **13 passed, 12 failed**
and exited 1. It asserted the desired behavior instead of accepting the
incorrect results. No production repairs were made during that review phase.

### Findings identified by that review (now repaired above)

1. **P1 — Core-invalid operators receive production validation `passed` and
   fidelity `complete`.** A supported top-level CustomScript containing
   `bool f(){return 1 == "a";}`, `bool f(){return true + false;}`,
   `bool f(){return !1;}`, or `void f(){int x=1;x%= "s";}` produces no error.
   The existing language-core TypeChecker reports errors for each. Supplying
   the declaration of `libNtve_InitVariables` removes unrelated unresolved
   symbols and demonstrates the false PASS without dependency ambiguity.
   `validation.ts:112-127` checks only some assignment operators, skips
   comparison/arithmetic compatibility, and gives `!` a boolean result without
   validating its operand. `int f(){return null;}` is also accepted with
   `incomplete`, zero errors, and `complete` fidelity, though core rejects it.
   The validator should use the shared language checker/rules, not grow another
   divergent hand-written type system.

2. **P2 — Core-valid source is rejected by production validation.**
   `byte f(){return 1;}` and
   `int f(){if(1){return 1;}else{return 2;}}` have no core errors, but forward
   conversion reports validation `failed` and fidelity `partial`.
   `validation.ts:64` omits core's int/byte conversions; condition checks at
   line 170 use boolean assignment instead of core's condition predicate.
   These mismatches predate the recent patch; the patch did not resolve them.
   Language-core agreement is demonstrated, not a claim about SC2 runtime
   execution, which still requires the Editor.

3. **P2 — The helper can still falsely claim exact verification.**
   `typedef int T; T x;` versus `typedef string T; T x;` returns `exact: true`:
   `galaxy-comparison.ts:424-425` excludes typedef declarations and does not
   resolve their meaning before comparison. Valid
   `int f(){return 1;}` versus the same source followed by `@` also returns
   `exact: true` despite two parse errors. This is a helper defect; the public
   reverse path uses its own canonical-text/syntax checks. The ordered include
   and initialized-global cases fixed earlier do pass.

4. **P2 — Alias scalability is only partially fixed.** Plain alias lookups are
   linear through 6,400 in the manual run, but 12,800 aliases cause a
   `RangeError: Maximum call stack size exceeded`, including through
   `convertGalaxyToTriggers`. The recursive call at
   `galaxy-type-resolution.ts:34` has no depth guard or iterative traversal.
   Wrapped chains (`typedef A1[1] A0; ...`) retain quadratic structural work
   in the visit at lines 46-49. For 200 and 400 aliases, the same structural
   traversal visits 40,600 and 161,200 nodes (3.97× on doubling), while the new
   counters report only 998 and 1,998 type resolutions. The regression's
   counters therefore miss the remaining hotspot. An initial timing run for
   100/200/400/800/1600 wrappers measured about 23/82/171/626/2082 ms; timings
   are illustrative and host-dependent, structural counts are deterministic.

5. **P2 — Internal synchronous re-entry changes an outer conversion's IDs.**
   Twelve concurrent public calls and a public call started from `onProgress`
   both produce byte-identical TriggerData. However, an `onProgress` callback
   at reconstruction/body stage that resets the allocator and invokes the
   synchronous internal converter changes the outer TriggerData. The global
   allocator is not protected across callbacks (`service.js:1078-1090`).
   Thus the prior blanket EXPECTED BEHAVIOR classification was too strong:
   tested public concurrency is safe; exposed internal re-entry is not.
   This is reproducible in Node and does not require Editor scheduling.

### Follow-up test record

- Converter emission/typecheck passed.
- All owner-tier Trigger/Galaxy suites: **416 passed in 19 files**.
- Independent correctness probes: **13 passed, 12 failed**, grouped above.
- Unused, self, and wrapper alias cycles, conflicting aliases, and wide
  shared-tail references pass their independent regression checks.
- The late-error production probe has zero dropped/unsupported items and zero
  displayed errors, but validation `failed`, `errors: 1`, omitted diagnostics
  2, and fidelity `partial`. This isolates and confirms the aggregation fix.
- Twelve concurrent public conversions and public progress-callback re-entry
  passed determinism checks; internal synchronous re-entry failed.
- `git diff --check` passed (line-ending warnings only).
- `pnpm test:owner` now completes the build, but stops at
  `contributions:check`: `blizzard/starcraft2-image-operations` source manifest
  `starcraft2/modules/textures/providers/image-operations/provider.json` has
  no module-map target. The earlier navigation compilation blocker is no
  longer present in the current workspace. These unrelated changes were not
  edited or reverted by this review.
- Real TriggerData corpus: **1 passed, 2 failed**. The frozen external mod
  fixture no longer matches its pinned expectations (7,328,096 versus
  7,436,388 bytes, and 29,049 versus 29,039 elements). This is fixture drift,
  not evidence that the converter patch caused these differences. NativeLib
  lowering/byte-identical no-op passed. The pinned expectations were not
  changed to hide the discrepancy.
- The language core also accepts the original test's native-call global
  initializers with no parse/type errors. Editor runtime validity remains
  unverified.
- `pnpm run test:extensions:owner` finished: **1,965 passed, 13 failed,
  9 skipped**; files: 240 passed, 13 failed, 1 skipped. Two suites also have
  collection/setup failures. This is not a repository-wide clean pass.
  Reported failures include missing `@modkit/ui/world`, schema resource-plan
  count expectations, model particle/effect projections, runtime/data
  artifact-resolution failures, path casing, and host/CLI timeouts.
  `sc2-scenario-workflows.test.ts:92` still expects a read-only TriggerData
  descriptor and obsolete unsupported-feature strings; the current adapter
  is writable and publishes different constraints. It failed before reaching
  its conversion assertions. This is a stale integration expectation, not a
  reproduced Galaxy conversion failure.
  Several failures report that artifacts changed after inventory. Concurrent
  workspace commits occurred during the review (current HEAD observed as
  `4680a6ca`), so the wider run is not a pristine snapshot or an attribution
  baseline for the converter patch. No unrelated repairs or expectation
  changes were made.

## Initial findings (qualified by the follow-up above)

| Claim | Result | Production impact and action |
| --- | --- | --- |
| Global initializer order can compare equal after a swap | **HELPER-ONLY ISSUE — FIXED** | `compareGalaxyPrograms` matched globals by name and did not retain their ordered initializer sequence. The production reverse path uses printed canonical Galaxy text, so it already reports this mutation. The helper now compares initialized global declarations in source order. The parser accepts the construct; execution validity in the SC2 Editor remains **NEEDS SC2 EDITOR VERIFICATION**. |
| Different/added/removed/reordered includes can compare exact | **HELPER-ONLY ISSUE — FIXED** | The helper ignored include nodes. Production canonical text comparison distinguishes them. The helper now compares ordered include paths, and has cases for same/different/added/removed/reordered includes. |
| Conversion validation accepts malformed control-flow/type cases | **CONFIRMED BUG — FIXED** | `validateGalaxyPair` accepted non-bool `&&`/`||`, `break`/`continue` outside loops, and a non-void function with no guaranteed return. It now checks these small core-language invariants; it deliberately does not duplicate the full language checker. `true < false` remains **EXPECTED BEHAVIOR**, consistent with the language core's comparable-bool rule. Return type mismatch was already rejected. |
| `complete` can ignore verification failure | **CONFIRMED BUG — FIXED** | Fidelity completeness was derived from the UI-truncated diagnostics array. It now uses full diagnostics plus source/output validation counters. The public field remains a fidelity/conversion result, rather than silently redefining it as a generic compiler pass. |
| An error after 1,000 diagnostics disappears | **CONFIRMED BUG — FIXED** | Validation counts errors before display truncation, but service aggregation inspected the truncated slice. Synthetic production input with 1,001 unresolved-call warnings plus a later bad return produced `sourceGalaxyValidation.status: failed`, `errors: 1`, and no displayed error. The service now aggregates full status before truncation. |
| Long typedef chain is O(N²) | **PERFORMANCE ISSUE — FIXED** | Each alias resolution rebuilt a visiting set and rewalked the tail. Resolution now memoizes `visiting`/`resolved` aliases and preserves cycle/conflict diagnostics and wrapper handling. The operation-count regression covers chains of 100, 200, 400, 800, and 1,600 aliases with linear bounds. |
| Other proposed hotspots | **NOT REPRODUCED** | Static graph review found the large `galaxy-to-trigger` body and known recursive/template paths, but no measurement in this audit established a new nonlinear regression. No speculative optimization was made. |
| Global mutable ID allocation | **EXPECTED BEHAVIOR** | The public service resets the allocator immediately before its synchronous reconstruction span; no `await` occurs inside that span. No production-operation overlap was reproduced. Direct internal re-entry and real browser/Node host scheduling remain **NEEDS SC2 EDITOR VERIFICATION**. |

## Verifier mutations

`semantic-conversion.test.ts` now requires the helper verifier to reject
literal/preset, function argument, call order, removed argument, return value,
include, meaningful initializer, operator, short-circuit, removed/duplicate
statement, and declaration-scope mutations. A changed library identity is not
claimed as verified here because it requires a real multi-library editor
document rather than a source-only AST comparison.

## Verification record

- Before fix: the new include regression failed (`exact: true` for `One` vs
  `Two`), demonstrating the helper defect.
- After fix: `pnpm exec tsc -p starcraft2/tsconfig.sc2-triggers.json` passed.
- After fix: targeted conversion suites passed: **200 tests in 2 files**.
- Full available owner command was started: `pnpm test:owner`. It stopped in
  the unrelated SC2 map lane before converter tests with
  `modules/sc2-map/src/navigation/analyze.ts(1391): TS2739`, missing
  `MapNavigation.chokes` and `MapNavigation.blockers`. This audit did not
  modify that file. `pnpm test:real` was not run because it requires an
  installed SC2 corpus/editor.

The pre-existing user edit `starcraft2/test/amphion-product-route.test.ts` was
left untouched.
