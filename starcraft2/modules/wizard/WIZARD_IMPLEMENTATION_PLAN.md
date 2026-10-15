# StarCraft II Data Wizard implementation plan

This is the implementation plan for `blizzard/sc2-wizard`. It is intentionally
kept next to the module because it is the working specification for the
codec, language provider, and host-facing capabilities.

## Target

Turn the current read-only `sc2-wizard` codec into a specification-conformant,
dependency-aware editor language surface for `.BlizWiz` files:

```text
sources and dependencies
  -> lossless XML AST
  -> document/workspace symbol index
  -> schema-aware analysis and evaluation
  -> codec, language provider, and generic MCP
  -> guarded writer/edit operations
```

The published grammar is based on the in-editor WizardHelp material and the
community transcription at
<https://sc2mapster.wiki.gg/wiki/Data_Wizard_Documentation>.
Runtime behavior that is not documented remains an explicit compatibility or
reverse-engineering item.

## Working rules

- Keep the documented format separate from corpus-only legacy behavior.
- Preserve unknown elements, attributes, comments, ordering, whitespace, and
  source ranges.
- Never turn incomplete catalog schema knowledge into a false hard error.
- Every new grammar rule needs a fixture and a focused test.
- Every new host capability needs a packaged-runtime smoke test.
- Do not expose editing or saving until parse/write round trips are proven on
  real files.
- Record evidence as `documented`, `corpus`, `runtime-confirmed`, or
  `hypothesis`.

## Evidence status (audit 2026-09-15)

- `documented`: the grammar in
  `mods/core.sc2mod/base.sc2data/editordata/wizardhelp/fileformat.rtf` and the
  editor behaviour in `general.rtf` (both read 2026-09-15 through Modkit's
  public route: VFS mount of the install → `openSubject` selects `blizzard/casc`
  → `namespace-entry-source` + `container.extract`; 221 758 and 95 560 bytes;
  not stored in the repository). Facts from `general.rtf`: wizards load from the
  user `EditorWizards` folder, extra folders set in File > Preferences > Wizards,
  and anywhere inside an active map or mod archive/folder or its dependencies;
  files reload on change; Wizard View shows a wizard only if `view` lists the
  object type, it is not hidden, uses one page and does not share fields with
  another view wizard. The text says the embedded-input separator is a
  semicolon but its own example uses a colon (`SubWizardId:InputId`); the
  colon is implemented, which is what the corpus uses.
- `corpus`: nine real `.BlizWiz` files exist locally (see Phase 1). All use the
  canonical `<wizardfile>` root, CRLF line endings, no BOM. Observed legacy
  forms: `<validate>` without `type`, `<entry>` with `<useloaded/>` and no
  `type`, `field id="Name"` on types whose schema has no `Name`, qualified
  `^OwnerWizard:Input^` tokens whose owner wizard lives in another file, input
  ids containing spaces (`Art Fields`), XML entities in evaluated text.
- `runtime-confirmed` (SC2Editor 5.0.16 session 2026-09-15, test wizards and
  results in `artifacts/editor-acceptance-2026-09-15/wizards/`):
  - case-variant `<WizardFile>` and standalone `<wizard>` roots are accepted
    (T5), although the specification says the root "should be wizardfile":
    the compatibility options are real editor behaviour, strict mode stays the
    documented form;
  - `objecttypes load="Abil"` works (T1a). `Ability` is **not** recognized:
    the wizard was still offered, but the editor exported it as
    `<objecttypes/>` (T1b + export). Unknown object types are warnings saying
    the editor drops them on save; an earlier `Ability` alias was reverted;
  - a loaded entry without `entry@type` and without `<id>` loads without any
    error and Finish writes the field (`Editor Suffix = MKTestA`, T4a); an
    untyped `validate` is counted as an error with an empty Status column
    (T4a vs T4b); a `type="CEffectDamage"` entry on a non-damage effect loaded
    without complaint (T4b);
  - SC2Editor's own serialization (Manage Wizards > Export, fixture
    `test/fixtures/editor-saved-export.BlizWiz`, byte-exact, `-text`): UTF-8
    without BOM, `encoding="utf-8"`, CRLF, 4-space indent, no final newline;
    comments dropped; non-canonical roots rewritten into `<wizardfile>`;
    children reordered (input: item, name, default, loadvalue, layout,
    reloadfrom, condition); an empty `<layout/>` always and an empty
    `<objecttypes/>` when none is known; `<count>` inside `<input>`,
    `value=""` and `<default value=""/>` dropped; untyped `validate`, entry
    without type/id and unknown condition inputs kept; imported names get an
    " Import" suffix;
  - the user wizard folder is `Documents\StarCraft II\EditorWizards\`
    (Preferences > Wizards, "Look For Wizards In User Directory");
  - `<count>` inside `<input>` is ignored (T2);
  - the embedded-input separator is the colon; a semicolon name is reported by
    the editor as a Warning "Unknown input ... referenced by condition
    'inline_NNNNN'" and the dialog proceeds (T3) — `unknown-input` on a
    condition is therefore a warning here too;
  - WizardText shows only its value, not its `name`; a WizardText default did
    not refresh after an embedded checkbox changed (T3, not conclusive).
- EditorLogs of the session contain no wizard entries at all (not even for
  the non-canonical roots): wizard problems surface only in the dialog error
  list.
- Wizard View (Ctrl+4) on an ability showed only the loaded id, twice, with no
  instructions (consistent with `general.rtf`). Most likely T1a (`Abil`) and
  T1b (`Ability`) both passed the view filter, i.e. `Ability` is honoured for
  offering and view but still dropped on save — not conclusive.

## Phase 0 — baseline and evidence matrix

- [x] Keep the module under `starcraft2/modules/wizard` after the repository
  restructure.
- [x] Keep the package export and contribution manifest wired to the module.
- [x] Keep wizard-specific typecheck, codec tests, contribution checks and
  module map checks green (re-verified 2026-09-16: 85 tests + 9 corpus tests, tsc, both checks).
- [ ] Re-run the package smoke suite; it was last green before other agents'
  changes and has not been re-verified.
- [ ] Add a grammar matrix covering `wizardfile`, `wizard`, `input`, `item`,
  `condition`, `validate`, `macro`, `entry`, `field`, `token`, evaluation
  tokens, catalog references, and arithmetic.
- [ ] Mark each rule with its evidence level and expected diagnostic severity.

## Phase 1 — corpus and conformance tests

- [x] Add unique real community/mod files from the local SC2 corpus with
  provenance notes: `test/fixtures/corpus.json` + `test/wizard-corpus.test.ts`
  (real tier; sha256 pin, byte round trip, wizard count, per-code diagnostic
  baseline). Files are read in place, not copied, because the licence is not
  established; root override `MODKITX_SC2_WIZARD_CORPUS_ROOT`. Files:
  - `C:/FILES/SC2Files/AllRaces/all-races-scevo-merger/scevo-core.SC2Mod/`
    `Launch Missile.BlizWiz`, `test.BlizWiz`, and
    `Base.SC2Data/Wizards/SCBW/{CreateSCBWUnit, SCBW Ability, SCBW Effects,
    SCBW Requirements, SCBW Upgrades, SetSCBWImportedData}.BlizWiz`
    (ScEvo; see also `references/ScEvoComplete2`);
  - `C:/FILES/SC2Files/AllRaces/factions-backup/UPL2023.SC2Mod/LaunchMissile.BlizWiz`
    (a near-copy of `Launch Missile.BlizWiz`, different hash).
  Packed `.SC2Mod`/`.SC2Map` archives were not searched; read them through the
  mpq codec, not ad-hoc probes.
- [x] Record a per-file diagnostic baseline (in `corpus.json`, editor-compatible
  mode with schema). After the false-positive fixes and the SC2Editor session
  the corpus has no errors; the real typo `RequierementNode` is a
  `unknown-object-type` warning, and so is `Ability`, which the editor drops
  on save. Before the
  fixes, strict with schema:
  89 `unknown-field` (all `field id="Name"`), 18 `missing-attribute`
  (`validate/@type`, `entry/@type` with `useloaded`), 12 `unknown-token`
  (`^EffectCreation:*^`, owner wizard in another file), 4 `missing-text`,
  2 `embedded-wizard-missing`, 2 `unknown-object-type` (one is a real typo,
  `RequierementNode`), 1 `unknown-element`.
- [x] Fill `editorSaved` with files exported by SC2Editor (Manage Wizards >
  Export) — `editor-saved-export.BlizWiz`, 10 wizards, byte-exact (`-text` in
  `.gitattributes`); `format.test.ts` pins it, round-trips it, checks what the
  editor kept and dropped, and its diagnostics.
- [ ] Add positive specification fixtures for every documented element,
  attribute, input type, condition operator, validation type, macro feature,
  entry feature, catalog reference, and arithmetic form.
- [ ] Add negative fixtures for malformed XML, missing required fields,
  duplicate identifiers, unresolved tokens, broken references, and cycles.
- [ ] Add compatibility fixtures for uppercase roots, standalone wizard roots,
  missing validation type, legacy catalog types, and non-standard children.
- [x] Track diagnostic counts by corpus file and diagnostic code (`corpus.json`).
- [ ] Keep standard fixtures strict; use an explicit compatibility mode for
  corpus-only behavior.

## Phase 2 — parser and lossless AST

- [x] Preserve raw nodes and source text for byte-preserving round trips
  (byte-identical on all nine corpus files, asserted by `wizard-corpus.test.ts`).
- [x] Add parser options for strict root matching and compatibility root
  matching (evidence: `hypothesis`).
- [x] Support a compatibility profile for case variants without changing the
  source spelling in the AST (root only; child tags stay case-sensitive).
- [x] Represent the document root kind explicitly: standard `wizardfile` or
  compatibility standalone `wizard`.
- [ ] Continue parsing after malformed or unknown nodes and retain their
  source ranges.
- [ ] Add source ranges to typed children where the language provider needs a
  precise target.

## Phase 3 — documented grammar and semantic analysis

- [x] Parse the principal documented wizard structures.
- [ ] Validate all documented attributes and child placement rules.
- [ ] Validate wizard metadata and `objecttypes create/load/view`. Done:
  `view-hidden` warning (a hidden wizard never shows in Wizard View). Not
  added: "view needs one page" — Blizzard's own prototype sets `view` on a
  two-page wizard, which is valid but simply absent from the view.
- [ ] Validate input controls, layout, defaults, reload behavior, item values,
  and input conditions. Done (2026-09-15, from the text): `color-ignored`
  (color only on WizardText), `reloadfrom-without-loadvalue`, `invalid-value`
  for non-integer or out-of-range `layout@page/@column/@minheight/@minwidth`,
  `instructions@page` and `macro@truncate` (literal, not evaluated). Not
  checkable without types: `simpletext` (string types), `nopreview` (asset
  paths), numeric `minimum/maximum/increment`.
- [ ] Validate named and inline conditions, nested logic, matching, numeric
  operators, visibility, and empty-value tests.
- [ ] Validate `validate` severity and message semantics.
- [ ] Validate entries, parent IDs, loaded-entry behavior, field arrays,
  tokens, conditions, and load inputs. Done: `entry/id` is required
  (`missing-entry-id` in strict; `legacy-missing-entry-id` warning next to
  `useloaded` in editor-compatible, as the corpus omits it); token `id`
  required; `loadinput` resolves. `parentid` is an evaluated catalog entry id
  and `token/@id` a catalog token, so both need catalog data (Phase 4). Open:
  multi-value `index` must match the array depth of the field path (needs the
  schema walker).
- [ ] Add duplicate and undefined symbol checks for wizard, input, macro,
  condition, entry, and token identifiers. Done: wizard, input, macro,
  condition (duplicate and undefined), input references. Entries have no
  local id namespace (their id is an evaluated catalog id); token ids are
  catalog tokens.
- [x] Evaluation cycles (2026-09-15): `evaluation-cycle` error for macros and
  input defaults that can only evaluate through themselves, following the
  evaluator's resolution order (macro before default); qualified tokens are
  excluded. Embedded-wizard cycles and unresolved tokens already existed.
- [x] Evaluator crash fixed: an input default referring to itself
  (`<default value="^A^"/>`) overflowed the stack in `evaluate` and hover. The
  evaluation stack now tracks macros and defaults per wizard (`default-cycle`),
  so the same name in an embedded wizard is no longer a false cycle.
- [x] Duplicate named `condition` ids are an error.
- [x] Specification text obtained through the Modkit CASC route (see Evidence
  status); spec fixture `spec-coverage.BlizWiz` corrected to it (`entry/id`
  next to `useloaded`, `loadvalue` for `reloadfrom`), sha256 re-pinned.
- [x] Remove false hard errors found on the corpus (focused tests in
  `format.test.ts`):
  - `Name`, `EditorPrefix`, `EditorSuffix` are accepted on every type by the
    schema adapter as editor object fields (`corpus`);
  - `^Owner:Input^` where `Owner` is the target of a `Wizard:` input that is
    not in the file → `embedded-token-unresolved` warning (the corpus shows the
    owner segment is the embedded wizard id, not the input id);
  - `entry` with `<useloaded/>` and no `type` → `legacy-missing-entry-type`
    warning in editor-compatible mode, still an error in strict mode;
  - `validate` without `type` stays a compatibility diagnostic (`corpus`).
- [x] Confirmed with SC2Editor (2026-09-15): `Abil` recognized, `Ability`
  dropped on save; loaded entry without `type`/`id` loads and writes on
  Finish; untyped `validate` counts as an error; `<count>` inside `<input>`
  ignored and dropped on save. The corpus baseline has no errors.

## Phase 4 — evaluation and catalog schema

- [x] Evaluate input/macro/index tokens and arithmetic in isolation.
- [x] Refuse catalog references when no catalog is available.
- [ ] Resolve catalog references through the loaded SC2 schema/catalog context.
- [ ] Distinguish known catalog types, incomplete schema coverage, unknown
  types, and legacy types.
- [ ] Validate field paths through the schema field walker rather than a
  hand-written field list.
- [ ] Add evaluation traces showing token expansion, reference resolution, and
  arithmetic results.
- [ ] Keep evaluation deterministic and free of arbitrary code execution.

## Phase 5 — multi-file and dependency context

Ownership (checked against modkit-core 2026-09-15): the **host** assembles the
workspace. `LanguageWorkspaceOptions.documentSource` and
`createContentDependencyLanguageDocumentSource` (`packages/host/src`) walk the
dependency closure over loose, MPQ and CASC mounts, keep load order in virtual
URIs, report completeness, keep dependency documents read-only and refuse
workspace edits when the snapshot is incomplete. The provider must not fetch,
mount or order sources itself; it consumes the bounded snapshot. A former
`WizardWorkspaceIndex` with its own VFS, precedence and invalidation would
duplicate the host and is dropped.

- [x] Resolve `Wizard:<id>` and `wizardid:subtoken` across files for
  navigation and rename (bounded snapshot).
- [x] Diagnostics use the snapshot: `analyzeWizardDocument` takes
  `externalWizards`, so embedded wizards and qualified tokens declared in
  another supplied document resolve; a local id also declared elsewhere is a
  `duplicate-wizard-elsewhere` warning naming the sources.
- [x] Rename refuses a symbol declared in more than one document; definition
  reports `isIncomplete` when the host says the snapshot is.
- [x] Cache parsed documents by text (FIFO, 64 entries) so a request does not
  re-parse the whole snapshot. Invalidation is implicit: changed text is a new
  key.
- [x] Wizard folders reach language sessions (integrator, stage B, answers in
  `reports/INTEGRATOR_ANSWERS_2026-09-15.md`): Blizzard `8181e7e0`
  (`modules/game/battlenet/content-sources/windows-folders.ts`: known folder
  `Personal` for `local:documents` with `~/Documents` fallback, the user
  `EditorWizards` folder and editor extra folders as `local:editor-wizards:N`
  through `languageMounts()`, explicit `wizardDirectories` off Windows) and
  Core `886bf29b` (optional `ContentSources.languageMounts()`, mixed into every
  MCP language session read-only). The installed MCP test resolves
  `^Shared:Nested^` into a wizard that lives only in the wizard folder.
  `WizardExtraDirsEnabled` is runtime-confirmed on two folders: one ASCII
  string, paths separated by `;`, NUL-terminated. External wizards stay
  read-only until a writer contract for external folders exists; snapshots
  are rebuilt per request (no host watch).
- [ ] VS Code / standalone LSP composition of the same folders (integrator,
  stage B next step).
- [ ] Prove resolution on a mounted `.SC2Mod` (needs a Mod content provider in
  the MCP composition).
- [ ] Resolve catalog references against host-provided dependency-merged SC2
  data (evaluation, Phase 4).

## Phase 6 — codec surface

- [x] Keep inspect, validate, raw export, outline, and evaluate read-only
  operations.
- [ ] Add symbol and dependency inspection operations if the host contract
  benefits from them.
- [ ] Expose compatibility mode and dependency completeness in descriptors.
- [x] Make the codec/provider diagnostic difference explicit: the codec keeps
  the 1.5 MB schema out of its runtime, so `inspect` reports
  `catalogChecks: 'not-run'` and the descriptor lists the catalog, entry-type,
  field-path and object-type checks as unsupported, naming the language
  provider as the surface that runs them (`native.test.ts`).
- [ ] Include cross-file completeness in relation graph metadata.
- [x] Keep edit/save absent until the writer passes the round-trip gate:
  `edit.field` declared 2026-09-16 after the host commit/reopen test; the
  manifest now requests `read-source` and `write-source`; `source.save`
  stays with the host.

## Phase 7 — language provider and LSP

- [x] Add `starcraft2/modules/wizard/providers/language/provider.json`.
- [x] Add the provider runtime and `src/language.ts`.
- [x] Offer `common.language/document-analysis@1` for language ID
  `sc2-wizard`, document kind `sc2-wizard-source`, and `.BlizWiz`.
- [x] Reuse parser, analyzer, outline, evaluator, bounded workspace index, and schema
  adapter instead of creating a second grammar implementation.
- [x] Remove the duplicated vocabulary in `language.ts`: completion now reads
  `KNOWN_ATTRIBUTES`, `KNOWN_CHILDREN`, enum sets, `BUILT_IN_INPUT_TYPES` and
  `INDEX_TOKENS` exported from `analyze.ts`.
- [x] Implement diagnostics and document symbols first.
- [x] Implement completion for tags, attributes, enum values, inputs, macros,
  wizard IDs, catalog types, and schema field paths.
- [x] Implement hover for wizard/input/macro/entry/field/token symbols.
- [x] Implement definition and references for local and bounded-snapshot cross-file symbols.
- [x] Add safe rename with refusal on incomplete workspace snapshots.
- [x] Add final-newline formatting and source code actions; defer structural formatting until the
  writer fidelity gate is complete.
- [x] Add provider initialize/release and packaged-runtime smoke coverage.

## Phase 8 — generic MCP integration

- [ ] Verify `modkit.inspect`, `modkit.subject_facts`,
  `modkit.relation_graph`, and `modkit.invoke_readonly` on a real wizard.
- [ ] After Phase 7, verify `modkit.language` diagnostics and symbols. Done
  by the integrator for routing, definition and rename refusal (Core
  `ed108837`, `886bf29b`, `apps/mcp/test/sc2-wizard-language.test.ts`);
  diagnostics and symbols on a real corpus file are still open.
- [ ] Avoid a wizard-specific MCP server unless the generic contracts cannot
  express a required operation.
- [ ] Add an end-to-end MCP test covering inspect, validate, outline,
  read-only evaluation, facts, and graph.

## Phase 9 — writer and editing

- [ ] Audit the existing writer against comments, whitespace, quotes, unknown
  nodes, source order, BOM, encoding, and line endings. Known: CRLF round-trips
  byte-identically on the corpus; a UTF-8 BOM is dropped by the decoder before
  parsing, so `writeWizardDocument` cannot restore it (`export-raw` is
  unaffected because it returns the original bytes). The editor-saved oracle
  also round-trips byte-identically.
- [x] Writer policy (2026-09-16): minimal-diff on the source bytes, never the
  editor's re-serialization. The editor normalizes order, indentation, empty
  `<layout/>`/`<objecttypes/>` and escapes, and drops comments, unknown object
  types and `<count>` in `<input>`; a Modkit edit changes only the edited value.
- [x] Edit-isolation gate (2026-09-16, `test/edit-isolation.ts`):
  `listWizardEditPaths` enumerates every writable target; for each one a
  hostile value (`a"b'c<&>d`) is written with the codec's escaping, the text
  is reparsed, and the set of targets, every other target's bytes and the
  read-back value are checked. Runs on both spec fixtures and the
  SC2Editor-saved file (quick tier) and on all nine corpus files (real tier,
  e.g. 390 targets in `SetSCBWImportedData.BlizWiz`). Mutation check: an
  unescaped write breaks the structure for 26/33, 8/21 and 390/390 targets
  and fails the read-back for the rest.
- [x] Descriptor severity bug found while opening the acceptance wizards through
  the codec: information findings were emitted as `info`, which the SDK
  descriptor schema (`error|warning|information|hint`) rejects, so the host
  refused to open any wizard with only an information finding (e.g. corpus
  `CreateSCBWUnit.BlizWiz`, `<count>` in `<input>`). Fixed to `information`;
  `native.test.ts` opens such a file and fails without the fix.
- [ ] SC2Editor reopen of a Modkit-edited file:
  `artifacts/editor-acceptance-2026-09-15/wizards-edited/` holds
  `MKTest_Questions_Edited.BlizWiz`, produced by four real `edit.field` plans
  (diff: exactly those four values), with a checklist.
- [x] Edit plans: `edit.field` (handler `edit-field`, `mutatesSource`,
  `read-source` + `write-source`, output `edit-plan`) returns an
  `AssetEditPlan` built with `editPlanFromInput`/`replaceBytes` from
  `@modkit/codec-kit`, the same path as the Style codec; the host owns
  propose/prepare/commit, the codec never writes. Fidelity `byte-identical`.
- [x] Small edits: `core/edit.ts` `locateWizardEditTarget` resolves semantic
  paths — input `default`, input `item N value|text`, macro text, named
  condition `value`, `entry N field F value` — to one attribute value or leaf
  text. It refuses a missing wizard/input/macro/field, an ambiguous id, a
  missing attribute, a self-closing or element-containing target and any
  other path; nothing is inserted. Attribute values are escaped for their own
  quote, text with `encodeXmlText`; a UTF-8 BOM is counted back into byte
  offsets.
- [x] Preserve unknown syntax: every byte outside the edited value is kept.
- [x] Host commit and reopen: `test/wizard-native-host.test.ts` opens the
  SC2Editor-saved fixture through `createModkit`, invokes `edit-field`,
  prepares and commits through `createSubjectEditing` +
  `createFileEditingBackend`, asserts the file equals the original with only
  that value replaced, and reopens it. Open: edits that add elements, removing
  or reordering, and the SC2Editor reopen of a Modkit-edited file.

## Phase 10 — binary/runtime research

Low priority. The content format is already established by `fileformat.rtf`
and the corpus; this phase only matters for the `hypothesis` compatibility
roots, and running SC2Editor on a test mod answers that faster than
decompilation (Ghidra output for SC2Editor has truncated function bodies).

- [ ] Search xrefs to `str_BlizWiz` and the recorded static address.
- [ ] Recover the surrounding file-type descriptor and `FiletypeTable` shape.
- [ ] Find suffix checks, XML loading, VFS/dependency lookup, reload, and save
  handlers.
- [ ] Confirm or reject uppercase roots, standalone roots, legacy validation,
  and direct input count behavior.
- [ ] Keep runtime evidence separate from the documented grammar.

## Verification gates

Every phase must pass the narrow wizard tests and wizard-specific typecheck.
Language-provider phases additionally require contribution and packaged-runtime
smoke tests. Writer phases require byte-preserving and semantic round trips.
The final release gate is:

1. strict specification fixtures are clean;
2. real corpus parses without parser failures;
3. compatibility diagnostics are explicit and deterministic;
4. cross-file dependencies resolve through VFS/dependency context;
5. language provider and generic MCP work from the packaged runtime;
6. edit/save operations preserve unsupported syntax and pass reopen checks.

## Current implementation slice

The first implementation slice adds explicit parser compatibility options,
preserves the standard strict behavior, and covers case-variant and standalone
roots with synthetic tests. Those roots are a `hypothesis`: no corpus file uses
them. It does not enable editing or claim that those non-standard forms are
part of Blizzard's formal grammar.

Completed in the first slice:

- [x] `WizardParseOptions` for case-variant roots and standalone wizard roots.
- [x] Explicit `WizardFile.rootKind` metadata.
- [x] Strict versus `editor-compatible` analysis mode.
- [x] Compatibility diagnostics for non-canonical roots and missing
  `validate/@type`.
- [x] Codec detection/opening for `.BlizWiz` compatibility roots.
- [x] 51 focused parser, analyzer, native codec, and language-provider tests.

Completed in the language-provider slice:

- [x] MK3 provider manifest and trusted-node/portable runtime variants.
- [x] `sc2-wizard` diagnostics, tokens, hierarchical symbols, completion, hover,
  definition, references, guarded rename, final-newline formatting, and code actions.
- [x] Bounded cross-file symbol resolution for `Wizard:<id>` and
  `wizardid:subtoken` references, with rename refusal on incomplete snapshots.
- [x] Rename corruption found in the 2026-09-15 audit, fixed the same day:
  XML entities before a token shifted edit offsets (references are now scanned
  from raw source); renaming a wizard or a `Wizard:`-typed input left the owner
  segment of `^Owner:Input^` stale; qualified `condition/@input` and
  `loadinput` names were not indexed; a new name containing `:` is refused.
  Five focused tests in `test/language.test.ts` (56 wizard tests total).
- [x] When a wizard id and a `Wizard:`-typed input share a name, the owner
  segment of `^Owner:Input^` is indexed under both readings and marked
  ambiguous: references find it, rename refuses (`language.test.ts`).
- [x] Module-map registration and generated contribution inventory.
- [x] Packaged runtime selection and release smoke check.
