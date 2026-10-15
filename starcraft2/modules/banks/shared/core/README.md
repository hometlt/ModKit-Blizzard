# @modkitx/bank

SC2 bank tooling for StarCraft II local save files and map bank preload metadata.

This package handles:

- `.SC2Bank` XML parse and serialize
- typed bank values: `int`, `fixed`, `string`, `flag`, `text`, `point`
- Blizzard bank signature calculate and verify
- local bank path inference for `bankName`, `authorId`, and `playerId`
- recursive bank discovery
- high-level editor API for reading/updating values
- validation/reporting
- `BankList.xml` parse, write, and matching against discovered local banks

It does not automatically decode map-specific encryption, compression, or custom anti-cheat fields. Those need per-map adapters.

## Entry Points

Use the root entrypoint in Node.js for the full API:

```ts
import { loadBankFile, saveBankFile, discoverBankFiles } from '@modkitx/bank'
```

Use the browser-safe core entrypoint when bundling for browsers:

```ts
import { parseBank, serializeBank, SC2BankEditor, validateBank } from '@modkitx/bank/core'
```

`@modkitx/bank/core` does not import `node:*` modules. It includes parsing, serialization, signatures, editor helpers, validation, `BankList.xml`, and path inference. It intentionally excludes recursive discovery and filesystem load/save.

Use the explicit Node entrypoint when you want to be clear about filesystem support:

```ts
import { loadBankFile, saveBankFile, discoverBankFiles } from '@modkitx/bank/node'
```

## CLI

After building the package, the binary is `modkitx-bank`.

```sh
modkitx-bank read path/to/file.SC2Bank
modkitx-bank read path/to/file.SC2Bank --json
modkitx-bank validate path/to/file.SC2Bank --require-signature
modkitx-bank verify path/to/file.SC2Bank
modkitx-bank sign path/to/file.SC2Bank
modkitx-bank set path/to/file.SC2Bank Stats Score int 1000 --sign
modkitx-bank list-banklist path/to/BankList.xml
modkitx-bank list-banklist path/to/BankList.xml --discover "C:/Users/Me/Documents/StarCraft II"
modkitx-bank discover "C:/Users/Me/Documents/StarCraft II"
```

Signature commands infer `bankName`, `authorId`, and `playerId` from standard SC2 bank paths. For non-standard paths, pass all three explicitly:

```sh
modkitx-bank verify file.SC2Bank --bank-name endofdreamsbank2 --author-id 2-S2-1-2355723 --player-id 2-S2-1-98765
```

`set` writes back to the input file by default. Use `--out other.SC2Bank` to write a copy, or `--no-sign` to preserve/omit the current signature behavior.

## Concepts

An SC2 bank is an XML file shaped like:

```xml
<Bank version="1">
  <Section name="Stats">
    <Key name="Score">
      <Value int="75"/>
    </Key>
  </Section>
  <Signature value="..."/>
</Bank>
```

The standard signature is SHA-1 over:

```text
authorId + playerId + bankName + ordered section/key/value tokens
```

So signature verification needs all three identity fields:

- `bankName`: filename without `.SC2Bank`
- `authorId`: map publisher/author ID, usually the folder under `Banks`
- `playerId`: local player account ID, usually the nearest `*-S2-*` folder before `Banks`

Typical Windows path:

```text
C:/Users/<User>/Documents/StarCraft II/Accounts/<account>/<playerId>/Banks/<authorId>/<bankName>.SC2Bank
```

## Basic Parse/Write

```ts
import { parseBank, serializeBank, getBankValue, coerceBankValue } from '@modkitx/bank'

const bank = parseBank(xmlText)
const score = getBankValue(bank, 'Stats', 'Score')

console.log(score) // { type: 'int', value: '75' }
console.log(score ? coerceBankValue(score) : undefined) // 75

const xml = serializeBank(bank)
```

## Signature

```ts
import { calculateBankSignature, verifyBankSignature } from '@modkitx/bank'

const info = {
  bankName: 'endofdreamsbank2',
  authorId: '2-S2-1-2355723',
  playerId: '2-S2-1-98765',
}

const signature = calculateBankSignature(bank, info)
const valid = verifyBankSignature(bank, info)
```

If `playerId` or `authorId` is wrong, the calculated signature will not match.

## Path Inference And Discovery

```ts
import { inferBankSignatureInfo, toSignatureInfo } from '@modkitx/bank/core'
import { discoverBankFiles } from '@modkitx/bank/node'

const inferred = inferBankSignatureInfo(
  'C:/Users/Me/Documents/StarCraft II/Accounts/123/2-S2-1-98765/Banks/2-S2-1-2355723/endofdreamsbank2.SC2Bank',
)

console.log(inferred)
// {
//   bankName: 'endofdreamsbank2',
//   authorId: '2-S2-1-2355723',
//   playerId: '2-S2-1-98765',
//   missing: []
// }

const signatureInfo = toSignatureInfo(inferred)
const files = await discoverBankFiles('C:/Users/Me/Documents/StarCraft II')
```

`toSignatureInfo()` returns `undefined` if either `authorId` or `playerId` could not be inferred.

## High-Level Editor

```ts
import { SC2BankEditor } from '@modkitx/bank'

const editor = SC2BankEditor.parse(xmlText, signatureInfo)

const score = editor.getInt('Stats', 'Score', 0)

editor
  .setInt('Stats', 'Score', 1000)
  .setString('Ranks', 'Rank', 'Hero')
  .setFlag('Flags', 'Unlocked', true)
  .removeKey('Stats', 'OldValue')

editor.sign()
const xml = editor.serialize()
```

If the editor has `signatureInfo`, `serialize()` will sign by default. Pass `{ signature: false }` to keep the current signature untouched.

## Load/Save Helpers

```ts
import { loadBankFile, saveBankFile } from '@modkitx/bank'

const loaded = await loadBankFile(bankPath)

console.log(loaded.inferredInfo)
console.log(loaded.validation.findings)

loaded.editor.setInt('Stats', 'Score', 1000)

await saveBankFile(bankPath, loaded.editor)
```

`loadBankFile()` infers signature info from the path and validates the bank. `saveBankFile()` signs automatically when signature info is available, unless `sign: false` is passed.

## Validation

```ts
import { validateBank } from '@modkitx/bank'

const report = validateBank(bank, { signatureInfo, requireSignature: true })

if (!report.ok) {
  for (const finding of report.findings) {
    console.log(finding.severity, finding.code, finding.path, finding.message)
  }
}
```

Validation detects:

- duplicate sections and keys
- empty names
- invalid `int`, `fixed`, `flag`, and `point` values
- unknown value types
- missing, valid, or invalid signatures
- keys that mix `<Value>` and custom node children

## BankList.xml

`BankList.xml` is map metadata that tells SC2 which bank files to preload.

```ts
import { parseBankList, matchBankListToDiscovered } from '@modkitx/bank'

const list = parseBankList(bankListXml)
const discovered = await discoverBankFiles(sc2DocumentsPath)
const matches = matchBankListToDiscovered(list, discovered)

for (const match of matches) {
  console.log(match.entry.name, match.discovered.length)
}
```

This lets tooling answer: "Which local bank files satisfy this map's preload list?"

## Mod/Map Reader Integration

`@modkitx/mods-processing/sc2-mod-core` now exposes `BankList.xml` from the primary loaded map/mod:

```ts
import { SC2ModReader } from '@modkitx/mods-processing/sc2-mod-core'
import { discoverBankFiles, matchBankListToDiscovered } from '@modkitx/bank'

const mod = await reader.read('file:C:/Maps/MyMap.SC2Map')

if (mod.bankList) {
  const discovered = await discoverBankFiles(sc2DocumentsPath)
  const matches = matchBankListToDiscovered(mod.bankList, discovered)
}
```

`BankList.xml` bytes remain in `mod.opaqueFiles` for roundtrip/export. Malformed `BankList.xml` is skipped during mod load instead of failing the whole read.

## Current Limits

- No generic decryption for custom bank payloads.
- No per-map check-code regeneration except what callers implement externally.
- The serializer writes canonical XML. It preserves the data model, not arbitrary comments or whitespace from every source file.
- Signature verification depends on exact `bankName`, `authorId`, and `playerId`.

## Test Fixture

The package includes a real End of Dreams sample:

```text
src/fixtures/endofdreamsbank2.SC2Bank
```

It is used for parse and serialize regression coverage.
