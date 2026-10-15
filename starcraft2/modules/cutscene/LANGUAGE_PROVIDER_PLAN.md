# SC2 Cutscene language provider — implementation plan

## Goal

Provide first-class `common.language/document-analysis@1` support for both
`.SC2Cutscene` and `.StormCutscene`, consumed by the Modkit MCP host
(`modkit.language`) and by the generic `modkit-lsp` adapter. The module ships no
LSP server of its own (owner decision 2026-09-04, confirmed 2026-09-15).

Attach-point and tangent-type meanings are measured from the corpus and pinned in
`test/cutscene-corpus.test.ts`. Curve Editor UI names and any write path still need
SC2 Editor verification; until then the provider exposes measured meanings and
the codec keeps `edit.structure` blocked.

## Delivery checklist

- [x] Add a service-provider contribution with Node and worker-brokered variants.
- [x] Register `sc2-cutscene` and `storm-cutscene` language ids and both file extensions.
- [x] Reuse the lossless cutscene parser, registry, validator, timeline and reference rules.
- [x] Implement analysis, XML tokens, diagnostics and hierarchical document symbols.
- [x] Implement context-aware tag/attribute/value completion.
- [x] Implement hover for tags, attributes, GUIDs, timeline fields and external references.
- [x] Implement local GUID and cross-document cutscene-file definition/references.
- [x] Implement document-scoped GUID rename with version-bound workspace edits.
- [x] Implement conservative formatting and final-newline code actions.
- [x] Implement color detection and color presentations that keep RGB/RGBA arity.
- [x] Position diagnostics from validator locations.
- [x] Establish `startLinkAttachToPoint` semantics from the corpus (1 = start, 2 = end).
- [x] Establish tangent types from control-point geometry (3 linear, 4 flat, 5 smooth, 6 custom, 7 auto).
- [x] Sample curves as cubic Bézier through the stored control points.
- [x] Remove the bespoke stdio LSP (generic `modkit-lsp` covers it).
- [ ] Cutscene case in `modkit-core/apps/lsp/test/installed-smoke.mjs` (integrator, Core).
- [ ] Cutscene case in the generic MCP tests (template: `modkit-core/apps/mcp/test/sc2-bank-language.test.ts`).
- [ ] SC2 Editor verification: Curve Editor mode → type number, anchor start/end, types 0 and 2.
- [ ] Structural edits through the single writer path, after SC2 Editor verification and reopen tests.
- [ ] Dependency-aware catalog/model/sound/conversation resolution from mounted archives.
- [ ] Remove the hand-written `KIND_ATTRIBUTES` and the role table duplicated from `refs.ts`.
- [ ] Corpus through game discovery instead of `references/SC2GameData` (separate task).
- [ ] Add a shared scene preview provider; this is intentionally outside the language service.

## Feature policy

The provider reports unknown tags as information and preserves them. Dangling
GUIDs and duplicate GUIDs remain warnings because both occur in Blizzard's own
corpus. GUIDs are scoped to their document; the only cross-file reference is
`referenceGuid` beside a non-empty `referenceFile`. A rename edits the owner's
declaration, its same-document references and every visible include. With an
incomplete workspace the host accepts only a primary-document edit (as for SC2
Bank keys), so the provider returns that edit — and refuses when a visible
document includes the GUID, because that include would knowingly break.
Formatting only changes a requested final newline; the codec's byte-preserving
whitespace model makes a pretty-printer unsafe until an explicit lossy-formatting
mode exists.

Public-shape changes of 2026-09-15 (`timeline` output, curve channel fields,
validator report) are listed in `README.md`.

## Verification gates

1. `tsc --noEmit -p starcraft2/tsconfig.sc2-cutscene.json`
2. Cutscene codec unit tests and the 2,233-file corpus suite (round trip, R2/R3 counts).
3. Provider feature tests, including malformed input and incomplete-workspace refusals.
4. Installed `modkit-lsp` smoke with a cutscene document (Core).
5. Contribution and module-map validation.
