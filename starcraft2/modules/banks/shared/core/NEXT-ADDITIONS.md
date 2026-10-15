# @modkitx/bank Possible Next Additions

This file records the next useful additions after the current generic bank package work.

Current package already has:

- `.SC2Bank` parse/serialize
- typed value helpers
- signature calculate/verify
- path inference and recursive discovery
- `SC2BankEditor`
- validation/reporting
- filesystem load/save helpers
- `BankList.xml` parse/serialize/matching
- `modkitx-bank` CLI
- real End of Dreams fixture coverage

## 1. CLI Commands - Done

Implemented in `src/cli.ts` and exposed via the package `bin` entry as `modkitx-bank`.

Available commands:

```sh
modkitx-bank discover "C:/Users/Me/Documents/StarCraft II"
modkitx-bank read "path/to/file.SC2Bank"
modkitx-bank validate "path/to/file.SC2Bank" --require-signature
modkitx-bank verify "path/to/file.SC2Bank"
modkitx-bank sign "path/to/file.SC2Bank"
modkitx-bank set "path/to/file.SC2Bank" Stats Score int 1000 --sign
modkitx-bank list-banklist "path/to/BankList.xml"
```

Implemented notes:

- No large CLI dependency.
- Uses existing APIs:
  - `discoverBankFiles()`
  - `loadBankFile()`
  - `saveBankFile()`
  - `SC2BankEditor`
  - `parseBankList()`
  - `validateBank()`
- Supports `--json` for `read`, `discover`, and `list-banklist`.
- Signature commands infer identity from normal SC2 bank paths or accept `--bank-name`, `--author-id`, and `--player-id`.
- `set` writes in place by default and supports `--out`, `--sign`, and `--no-sign`.

Acceptance tests implemented in `src/cli.spec.ts`:

- Read a temporary bank and print a human summary.
- Set an int value and sign using inferred path signature info.
- Verify a signed bank.
- List `BankList.xml` entries.

## 2. Raw-Preserving Patcher

Current `serializeBank()` writes canonical XML. That is fine for tooling, but real user files may contain unusual whitespace, comments, or formatting.

Add a raw patcher that edits only selected values in original XML text.

Possible API:

```ts
patchBankValueXml(xml, {
  section: 'Stats',
  key: 'Score',
  type: 'int',
  value: '1000',
})

patchBankSignatureXml(xml, 'ABCDEF...')
```

Implementation notes:

- Keep this separate from `serializeBank()`.
- Use a targeted XML token scan rather than full reserialization.
- Safe enough approach:
  1. Locate `<Section ... name="Stats" ...>` start tag.
  2. Find its matching `</Section>` by scanning nested tags. Sections usually do not nest, but scanning is safer.
  3. Inside that range, locate `<Key ... name="Score" ...>`.
  4. Inside the key range, locate the first `<Value .../>` or `<Value ...></Value>`.
  5. Replace only the target attribute value (`int="..."`) or the full `<Value .../>` tag if type changes.
  6. Preserve all surrounding bytes.
- Attribute order can be preserved when type is unchanged.
- If the type changes, replacing the whole `Value` element is acceptable.
- Signature patching:
  - If `<Signature value="..."/>` exists, replace only the `value` attribute.
  - If missing, insert before `</Bank>` using nearby indentation.

Important edge cases:

- XML entities in values: escape `&`, `"`, `<`, `>`.
- Different quote styles: support both `'` and `"`.
- Multiline start tags.
- Existing `<Value>` not self-closing.
- Missing section/key/value should return a structured failure, not silently alter the file.

Possible result type:

```ts
type BankXmlPatchResult =
  | { ok: true, xml: string, changed: boolean }
  | { ok: false, reason: string }
```

Acceptance tests:

- Patch the End of Dreams fixture and assert only the intended value substring changes.
- Patch a single-quoted synthetic XML file.
- Patch a bank with missing signature and ensure signature is inserted.

## 3. Diff API

Add a structured diff for comparing before/after banks.

Possible API:

```ts
diffBanks(before, after): BankDiff
```

Suggested output:

```ts
interface BankDiff {
  sectionsAdded: string[]
  sectionsRemoved: string[]
  keysAdded: Array<{ section: string, key: string }>
  keysRemoved: Array<{ section: string, key: string }>
  valuesChanged: Array<{
    section: string
    key: string
    before?: SC2BankValue
    after?: SC2BankValue
  }>
  signatureChanged: boolean
}
```

Implementation notes:

- Compare by section name and key name.
- Treat duplicate names as validation errors; diff can either:
  - assume validated banks, or
  - include duplicate findings from `validateBank()`.
- For node-style keys, compare serialized normalized node arrays or deep JSON equality.
- Keep ordering changes out of the default diff. Add `includeOrderChanges` only if needed.

Use cases:

- Show what changed after a game session.
- Confirm an editor operation changed only intended keys.
- Generate user-readable reports before save.

Acceptance tests:

- Added/removed section.
- Added/removed key.
- Changed value type and value.
- Signature changed only.

## 4. Map Profile Adapters

Generic bank parsing should not include map-specific hacks. Some maps add custom check keys, encoded strings, or encrypted/compressed blobs. Put those in explicit profile adapters.

Possible structure:

```text
src/profiles/
  end-of-dreams.ts
  index.ts
```

Possible API:

```ts
interface BankProfile {
  id: string
  title: string
  bankNames: string[]
  authorIds?: string[]
  detect(bank, info?): boolean
  read(bank): Record<string, unknown>
  write(bank, values): SC2Bank
  validate?(bank): BankValidationFinding[]
}
```

End of Dreams context from current fixture:

- Bank name: `endofdreamsbank2`
- Known author ID from reference app: `2-S2-1-2355723`
- Sections:
  - `Ranks/Rank` string
  - `Stats/TotalKills` int
  - `Stats/Score` int
  - `Stats/EasyWins` int
  - `Stats/MediumWins` int
  - `Stats/HardWins` int
  - `Stats/HellWins` int
  - `Check/Sum` int
- The reference app computes `Check/Sum` as:

```ts
((EasyWins ^ 1) + (MediumWins ^ 2) + (HardWins ^ 1) + (HellWins ^ 1)) % 99
```

Implementation notes:

- Add profile tests against `src/fixtures/endofdreamsbank2.SC2Bank`.
- Keep profile export optional; do not make core parser depend on profiles.
- Profile write should call editor setters and regenerate profile-specific checks, then caller can sign.

## 5. SC2 Map / Mod BankList Integration - Basic Support Done

Basic support is implemented in `@modkitx/mods-processing/sc2-mod-core`:

- `SC2Mod.bankList?: SC2BankList` exposes the parsed primary `BankList.xml`.
- `BankList.xml` remains in `SC2Mod.opaqueFiles` for roundtrip/export.
- Parse errors do not fail the full mod read; malformed bank lists are skipped.
- Fixture coverage exists in `packages/mod/test/fixtures/BaseMod/BankList.xml`.

Remaining follow-ups:

- Add real map fixture tests using:
  - `testdata/ta-traynor.SC2Map/BankList.xml`
  - `testdata/ta-uedfl.SC2Map/BankList.xml`
- Add a convenience helper:

```ts
matchMapBankListToLocalBanks(mod.bankList, await discoverBankFiles(sc2DocsPath))
```

This can answer: "Which local bank files satisfy this map's preload list?"

## 6. Browser-Safe Entrypoints - Done

Implemented package entrypoints:

- `@modkitx/bank/core`: browser-safe parser, serializer, signatures, editor, validation, `BankList.xml`, and path inference.
- `@modkitx/bank/node`: core plus recursive discovery and filesystem load/save.
- `@modkitx/bank`: backward-compatible Node/full API.
- `@modkitx/bank/cli`: CLI implementation.

Current package exports:

```json
{
  "exports": {
    ".": { "import": "./dist/index.js", "types": "./dist/index.d.ts" },
    "./core": { "import": "./dist/core.js", "types": "./dist/core.d.ts" },
    "./node": { "import": "./dist/node.js", "types": "./dist/node.d.ts" },
    "./cli": { "import": "./dist/cli.js", "types": "./dist/cli.d.ts" }
  }
}
```

Implemented split:

- `path-core.ts`: path inference without Node imports.
- `path.ts`: Node recursive discovery plus re-exported path inference.
- `core.ts`: browser-safe exports only.
- `node.ts`: core plus Node filesystem helpers.

Verification:

- `src/core.spec.ts` checks core behavior and statically guards the core module graph against `node:*` imports.
- `npx vitest run --config vitest.config.ts` passes.
- `npx tsc -p tsconfig.json --noEmit` passes.

## Recommended Order

1. Raw-preserving patcher
2. Diff API
3. End of Dreams profile adapter
4. Real-map BankList fixture tests
5. Root `modkitx` umbrella CLI integration

The raw patcher and diff API give the biggest immediate value for safer real user bank editing.
