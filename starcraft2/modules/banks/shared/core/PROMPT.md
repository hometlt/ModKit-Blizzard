# AI Prompt For @modkitx/bank

You are working on `packages/bank` in the modkitx monorepo.

## Goal

Maintain and extend SC2 bank support:

- `.SC2Bank` XML read/write
- standard Blizzard bank signature calculation/verification
- local bank discovery and path inference
- high-level editing API
- validation/reporting
- `BankList.xml` parsing and matching

## Important Files

- `src/bank.ts`: core parser, serializer, signature, typed value helpers
- `src/editor.ts`: `SC2BankEditor` mutable convenience wrapper
- `src/path.ts`: path inference and recursive discovery
- `src/io.ts`: filesystem load/save helpers
- `src/validate.ts`: non-throwing validation/reporting
- `src/bank-list.ts`: `BankList.xml` parse/write/matching helpers
- `src/core.ts`: browser-safe public entrypoint; must not import `node:*`
- `src/node.ts`: Node/full public entrypoint
- `src/path-core.ts`: browser-safe path inference helpers
- `src/cli.ts`: `modkitx-bank` command implementation
- `src/cli.spec.ts`: CLI behavior tests
- `src/types.ts`: shared public types
- `src/fixtures/endofdreamsbank2.SC2Bank`: real fixture
- `README.md`: package documentation
- `../mod/src/mod.ts` and `../mod/src/reader.ts`: `SC2Mod.bankList` integration for primary map/mod `BankList.xml`

## Signature Rules

Standard signatures use SHA-1 over:

```text
authorId + playerId + bankName + ordered section/key/value tokens
```

For each scalar key:

```text
key.name + "Value" + value.type + value.value
```

For `text` values, include the type but not the payload.

For node-style custom children:

```text
key.name + node.name + node.type + node.value
```

Again, omit node value when node type is `text`.

Return uppercase hex.

Do not guess missing `authorId` or `playerId`; report them as missing.

## Path Inference

Expected local SC2 shape:

```text
.../Accounts/.../<playerId>/Banks/<authorId>/<bankName>.SC2Bank
```

Use the file basename without `.SC2Bank` as `bankName`.
Use the first `*-S2-*` segment under `Banks` as `authorId`.
Use the nearest `*-S2-*` segment before `Banks` as `playerId`.

## Engineering Rules

- Keep parsing model close to on-disk XML.
- Preserve unknown/custom value types and node children.
- Validation should return findings, not throw, for bad bank content.
- Do not add map-specific hacks to core helpers.
- Per-map anti-cheat/check-code logic belongs in explicit map-profile adapters, not generic bank parsing.
- `@modkitx/mods-processing/sc2-mod-core` may expose generic `BankList.xml` metadata, but should keep the raw file in `opaqueFiles`.
- Keep `@modkitx/bank/core` browser-safe. Do not import `io.ts`, `path.ts`, `cli.ts`, or `node:*` modules from the core entrypoint graph.
- Put filesystem features behind `@modkitx/bank/node` or the backward-compatible root export.
- Keep tests focused and include real fixtures when available.

## Verification

Run from `packages/bank`:

```sh
npx vitest run --config vitest.config.ts
npx tsc -p tsconfig.json --noEmit
```

Expected current coverage includes parser, serializer, BankList, editor, path inference, IO helpers, validation, and the End of Dreams fixture.
CLI coverage includes read, set/sign, verify, and BankList listing.
Core entrypoint coverage includes behavior checks and a static guard against `node:*` imports in the core module graph.
