# StarCraft II codec family

Extension authors adding a complete-snapshot text format should use the small
[authored-text writer API](docs/authored-text-writer.md). Format validation stays in its domain;
the shared provider owns revision guards, transaction planning and byte-preserving commit rules.

## Battle.net VFS (Node / Electron main process)

`@modkit/blizzard-starcraft2/battlenet/sc2arcade` exports the portable `Sc2ArcadeClient`,
`ModDependency` and `Sc2ArcadeOptions` contracts for public dependency metadata and depot downloads.
The client accepts an injected `fetch`; downloaded bytes are opened through the host's ordinary
archive/VFS pipeline. The historical `openDependency()` reader adapter remains only in the MK2
compatibility entrypoint and delegates metadata and downloads to this client.

`@modkit/blizzard-starcraft2/battlenet/vfs/node` exports `BattleNetVfsProvider` and the
`BattleNetVfsApi` transport contract. The provider registers the `battlenet:` scheme with the
ordinary MK3 `VirtualFileSystem`. Its implementation is in
[`modules/game/battlenet/content-sources/vfs-provider.ts`](modules/game/battlenet/content-sources/vfs-provider.ts).

### Login and multiple accounts

[`modules/game/battlenet/accounts/account-provider.ts`](modules/game/battlenet/accounts/account-provider.ts) exports
`BattleNetAccountsProvider` from `@modkit/blizzard-starcraft2/battlenet/accounts/node`.
Register this provider **instead of** the single-profile provider; both use the same scheme.
It delegates interactive login to an injected `BattleNetLoginBackend`, retains one selected SC2
profile per account/region, and routes VFS requests to the correct authenticated session.

```ts
import { VirtualFileSystem } from '@modkit/vfs'
import {
  BattleNetAccountsProvider,
  type BattleNetLoginBackend,
} from '@modkit/blizzard-starcraft2/battlenet/accounts/node'

export async function connectAccount(authentication: BattleNetLoginBackend, cacheDirectory: string) {
  const provider = new BattleNetAccountsProvider({ authentication, cacheDirectory })
  const vfs = new VirtualFileSystem().registerProvider(provider)
  const account = await provider.login({ region: 'na' }) // native backend performs interactive login
  const uri = provider.uri({ accountId: account.accountId, region: 'us' })
  const mount = await vfs.openMount(uri)
  vfs.mount('battle-net/account-1/us', mount)
  return { provider, vfs, account }
}

// Add another account: provider.login({ region: 'na' }) opens a fresh browser session.
// Connect the same account to EU, if advertised by provider.supportedRegions:
// await provider.login({ accountId: account.accountId, region: 'eu' })
// Show the account/region selector: provider.listConnections()
// Open its catalogue: battlenet://eu/mine?account=<accountId>
// Search: battlenet://kr/search?account=<accountId>&name=Example
// Disconnect one region: await provider.logout(account.accountId, 'eu')
// Disconnect the account everywhere: await provider.logout(account.accountId)
// Disconnect all accounts but allow later login: await provider.logoutAll()
// Shut down: await provider.dispose(); await vfs.dispose()
```

`na` aliases `us`; native requests and cache paths use `us`. Each region needs its own authenticated
SC2 profile. Changing only a depot hostname does not sign into another region. The account selector
is optional only when exactly one live account is connected in the requested region. Canonical
mount/source URIs always include the account ID, so identical map IDs and filenames from different
accounts cannot alias. Cache partitions include account, profile, and region. Login to an already
connected explicit account/region reuses that session; log out first to change the selected profile.

The login backend receives a new `browserSessionId` and an abort signal for each interactive login.
It must use isolated cookies, open the official challenge, intercept the callback in the main
process, complete native authentication/profile selection, verify any `expectedAccountId`, and
return the verified account/profile identity and session-bound API. Passwords, tickets and cookies
stay in the backend. The manager also verifies the returned identity/region and closes rejected or
cancelled sessions. `listConnections()` returns display metadata only. A backend expiry signal or
logout invalidates existing mounts and sources for that connection. Other accounts/regions remain
usable. Logout does not erase the disk cache; the host retains ownership of cache eviction.

This is session management and VFS routing, **not a packaged implementation of the native login
backend or a new UI button**. The earlier isolated native prototype was verified with one US
profile. Its integration and real EU/KR authentication still require backend work. The backend's
`supportedRegions` must advertise only implemented regions; unsupported login attempts fail before
opening a browser. Multi-account and regional routing tests use deterministic session adapters.

### Publishing maps/mods and closing sessions

Both providers expose `publish(options)`. The accounts provider requires `accountId` in addition
to `region`. The single-profile provider already owns its selected API/profile. Publication is
an explicit operation; the remote VFS tree remains read-only.

```ts
const published = await provider.publish({
  accountId: account.accountId,
  region: 'na',
  filePath: 'C:\\Maps\\MyMod.SC2Mod', // also accepts saved .SC2Map MPQ archives
  name: 'My mod',
  locale: 'enUS',
  description: 'My mod description',
  target: { mode: 'create' },
  visibility: 'private',
  locked: true,
  operationId: crypto.randomUUID(), // retain for backend reconciliation if interrupted
  onProgress: event => console.log(event.stage),
})

// Update instead of creating: target: {
//   mode: 'update', id: published.publication.id,
//   expectedVersion: published.publication.version,
// }
// Reopen the catalogue to see the new server revision; existing mounts stay revision-pinned.
await provider.logout(account.accountId, 'us')
// await provider.logoutAll() // all accounts; provider stays reusable
// await provider.dispose()  // final shutdown; later login/open/publish is rejected
```

Private visibility, locked publication and `enUS` are defaults. Input is a saved archive; loose
component directories must be exported first. The provider bounds the input size, detects changes
during the read, validates its MPQ structure, and supplies a read-only snapshot plus SHA-256 to the
backend. It never edits the input file. Only one publication can run per profile/region connection;
other account/region connections remain independent. Progress observers cannot make a successful
publication fail. A confirmed receipt must match the operation, region, archive hash, name, type,
visibility and lock settings; updates must match the target ID and advance its expected revision.

The optional `BattleNetVfsApi.publish` method implements the native publishing transport. Its
request/receipt types and orchestration live in `modules/game/battlenet/publishing/publisher.ts` and are exported from
`@modkit/blizzard-starcraft2/battlenet/vfs/node`. An adapter without this method reports
`publish-unavailable` before reading the local input. The adapter must perform PrePublish, reject
a conflicting create name or stale/unowned update target, allocate the revision, generate the
`.s2mh`/`.s2ml` metadata, declare cache objects, upload through the native gateways, and query the
server again before returning `serverRevisionVerified: true`. It must invalidate its own catalogue
cache after success. The provider's text bounds are local resource limits; actual Blizzard name,
locale, metadata, dependency, quota and eligibility checks belong to the native backend.

The adapter owns a durable operation journal: `operationId` plus request fingerprint and allocated
revision. The provider never retries allocation/upload automatically and does not implement a
native idempotency mechanism. A definitive `status: 'rejected'` reply produces
`BattleNetPublishRejectedError`. Transport failure, an unconfirmed/mismatched receipt, or cancellation
after submission produces `BattleNetPublishOutcomeUnknownError` carrying `operationId`: inspect the
backend journal and server before resuming. A confirmed successful receipt wins a late cancellation;
logout cannot roll back a revision already committed by Blizzard. Callback progress is advisory.

`logout(accountId, region?)` invalidates the selected sources, aborts publication, closes the native
session once, and waits for its publication and matching pending-login cleanup. `logoutAll()` closes
all current connections and pending logins while allowing later login. `dispose()` does the same
for final shutdown and shares a single completion promise across repeated calls. Native adapters
must honour abort signals and close their transports; shutdown waits for them. The standalone
single-profile VFS provider's `dispose()` cancels its work/releases mounts; its external session
owner remains responsible for closing the native connection.

The desktop adapter now connects `api.publish` to the native prepared-package uploader for US/EU/KR.
It additionally requires `packagePath` pointing to a hash-bound `.modkit-publish.json` manifest with
compiled header/localization/visual components. An archive alone is insufficient: arbitrary-document
package compilation remains unfinished. Both desktop menus offer review and publication of these
prepared packages. See [content sources](docs/content-sources.md) for the journal, regional checks
and limitations. The new hook has transport/fixture tests, not a new live upload acceptance result;
the optional real archive case verifies local preparation and byte preservation.

Both providers also expose `deletePublication({ region, publication, operationId?, signal? })`;
the accounts provider additionally requires `accountId`. The desktop implementation uses native
`S2Map.Unlink`, verifies the current own linked revision before sending, journals the operation,
and confirms unlinking by rereading the own catalogue. It does not erase cached/depot copies.
Electron and VS Code offer a separate own-publication deletion action with a confirmation step;
removing a public bookmark remains a local-only operation. The wire codec has been checked against
the editor in offline CPU emulation; live deletion acceptance has not been run.

```ts
import { VirtualFileSystem } from '@modkit/vfs'
import {
  createBattleNetVfsProvider,
  type BattleNetVfsApi,
} from '@modkit/blizzard-starcraft2/battlenet/vfs/node'

export async function mountPublishedMods(
  api: BattleNetVfsApi, // adapter bound to the authenticated SC2 profile
  profileKey: string, // non-secret account/profile cache partition
  cacheDirectory: string,
) {
  const vfs = new VirtualFileSystem().registerProvider(createBattleNetVfsProvider({
    api, profileKey, cacheDirectory,
  }))
  const mount = await vfs.openMount('battlenet://us/mine')
  vfs.mount('battle-net', mount)
  return vfs // list('battle-net'), then list/open a returned path; dispose when closed
}
```

| URI | Catalogue |
| --- | --- |
| `battlenet://us/mine` | All publications of the adapter's authenticated SC2 profile |
| `battlenet://us/mine?name=mod` | Case-insensitive substring filter over those publications |
| `battlenet://eu/search?name=Example` | Public name search delegated to `api.searchMods` |
| `battlenet://us/mine/<returned-directory>/Base.SC2Data` | Mount a publication subdirectory |

`us` (also accepted as `na`), `eu`, and `kr` are supported depot region identifiers. The adapter determines which
regions the signed-in profile can access. Publication directories use
`<id>@<concrete-version>--<sanitized-name>.SC2Mod` (or `.SC2Map`). The original title and flags
are available on the returned node's `publication` property. Names are never local cache paths.
Use the path returned by `list` and URL-encode it when constructing a subdirectory URI.

The custom API supplies paginated `listPublished`, optional `searchMods`, `resolveArchive`, and
streaming `downloadArchive`. Map native `version`, `is_mod`, and `header_handle` metadata to
`version`, `isMod`, and `headerHandle`; `version` must be concrete, not the native zero/latest
selector. `resolveArchive` must verify the `.s2mh` header, select its `.s2ma` handle, and return
the archive SHA-256 and kind. Its optional size is the actual depot byte length, **not** the
publication accounting size. The downloader uses the approved depot endpoint for that handle
and honours the abort signal. This module implements VFS and caching; it does not implement
native Battle.net authentication, invent HTTP catalogue endpoints, or register a UI command.
Public search reports an explicit unsupported error when the adapter lacks it; its matching
semantics are the backend's. Publication upload uses the explicit `publish()` operation above.

Listing the catalogue or inspecting publication folder metadata downloads no archives. Listing
inside a publication fetches its archive, verifies SHA-256, commits it atomically to a disk cache,
and indexes it through the existing MPQ v0–v3 reader. Individual files decode when opened. The
cache is partitioned by profile/region and addressed by archive SHA-256; reopened mounts verify
cached bytes before using them. Catalogue/header requests still need the API on reopen. The host
owns cache eviction and logout policy; dispose mounts and create a new session-bound adapter when
switching profiles. Read, stream, entry, archive, and retained-memory limits apply; opened file
sources must be disposed to release their decoded buffers.

The tree is read-only and contains archive entries, including internal MPQ entries. Unnamed blocks
use the MPQ reader's synthetic paths; encrypted entries and other unsupported MPQ features report
the reader's errors. A `Standard Data: ...` depot reference requires installed dependency
resolution and is not exposed as an MPQ. Dependencies are not merged into this archive tree.

Run `pnpm --filter @modkit/blizzard-starcraft2 test:battlenet` to build and test this entry point.
Set `MODKIT_BATTLENET_TEST_ARCHIVE` to an explicit local published `.SC2Mod`/`.SC2Map` copy to
also exercise every file through the provider. These deterministic tests use an API fixture;
they do not log in, publish, or require an installed game.

Product-owned codecs and game services for authored SC2 data, strings, layouts, maps, mods,
replays, banks, triggers, Galaxy and runtime documents. They expose bounded
tree/table/text/namespace views through MK3 contracts. Installation discovery, workspace
composition lives in `integration/linked.js`; game, semantic data, map and launch providers live under their domain modules in this same extension
root. The former `blizzard/starcraft2-game` package is gone; import from `@modkit/blizzard-starcraft2`.

SC2Layout now has a protocol-neutral `common.language/document-analysis@1` provider for completion,
hover, navigation, safe workspace rename, diagnostics, and symbols. Its codec exposes bounded
semantic layout and first tech-tree template previews with resolved templates, properties, anchors,
states, action effects, display geometry, completeness, digest, and pinned provenance. The preview
comparison is semantic rather than pixel-perfect. The schema reference is not bundled because its
repository declares no license; compact original hints remain explicitly pinned to that reference.

SC2 GameData XML uses the same protocol-neutral provider surface. Its generated schema preserves
644 catalog types plus inherited fields, link namespaces, enum/flag members, numeric kinds and
instruction keywords from the pinned legacy schema. Completion, hover, diagnostics, navigation,
safe rename and symbols run through the host; curated field hover text comes from the separate
schema-bound knowledge pack and keeps direct SC2Mapster links distinct from licensing metadata.
Full event/controller/animation/expression execution, resolved localization and assets, structured
property/anchor edit plans, and automatic installed-archive layout loading remain named remainders.

Authored Galaxy, localization, layout, GameData and Trigger XML use one bounded complete-snapshot
writer through `common.edit/writer@1`. The M2 bank port adds native raw-preserving value edits and
signing, with host-owned edit plans, commit and reopen. The unsigned-bank writer has a native
no-op commit/reopen fixture; installed-app bank acceptance remains pending. BankList remains
read-only. Mounted SC2 package codecs read bounded BankList, `.SC2Bank`, and Galaxy documents through
their namespace, publish package/bank facts, and relate exact literal `BankLoad` calls to banks,
sections, and keys without consulting an installation. A separate
export-only provider can copy every enumerated byte of a complete loose namespace into a
revision-pinned workspace directory. Its contract accepts a read-only CASC source mode, but the
current installed proof names only the remote-key refusal; successful commit/reopen proof for this
provider is for a complete loose workspace. No app/command owns that loose-namespace snapshot
planner yet. A remote-only CASC encoding key stops planning before any target write rather than
producing a partial map. The separate MPQ extension can either build a fresh deterministic MPQ v0
from a complete bounded loose `.SC2Map`, `.SC2Mod` or `.SC2Campaign` namespace, or Save As a bounded
existing MPQ v0/v1 while preserving its native layout and untouched bytes. The installed WTE70
acceptance exercises the ordinary host editing path, atomic Save As, semantic SC2Map reopen, exact
changed and unchanged entry checks, and undo without modifying the installation. The preserving
path is deliberately limited to unencrypted fixed-slot replacements whose original stored or zlib
layout can hold the result; changed encrypted, implode, patch, sector-CRC and high-offset data,
in-place writes, signature regeneration and native game signing remain explicit refusals.

The SC2Map codec also exposes the mutating `blizzard/sc2-map.edit-world` operation. A normal host
session can add, update, move or remove placed units, doodads, points and cameras; add, update or
remove regions; change proven HMAP height fields and PATH flags; and rename supported catalog
references in Objects and Preload. The result is a revision-pinned whole-archive edit plan produced
through the current MPQ writer. Fixed-slot Save As preserves the native archive and every untouched
byte; deterministic rebuild is admitted only when every active entry is uniquely named and no
opaque attributes, signature or alias blocks exist. The writer reports source/output SHA-256
digests, per-document digests, fidelity notes, loss notes and the pinned legacy reference revision.
It is covered by deterministic fixture round trips, ordinary host prepare/commit/reopen, and a
writable-copy proof against an installed SC2Map while the installed source digest, size and mtime
remain unchanged. Map bounds/resize, terrain material layers, water, normalized cliffs, lighting,
new/deleted native MPQ entries, unsupported MPQ compression/security layouts and Blizzard signing
remain named refusals.

The same packed-map codec restores the legacy `1a14ba4` user-visible `view.thumbnail` and `view.render`
operations for bounded stored HMAP and PATH documents. Height previews are deterministic 16-bit
grayscale PNGs and pathing previews use the legacy passable/ramp/blocked/unknown colors; both keep
map north at image row zero. The portable PNG writer uses deterministic uncompressed zlib blocks.
Legacy cliff, cell-flags, painted-pathing, texture-mask and object/region overlay layers still need
their native parsers and remain explicit viewer parity work.

The separately resolved `common.runtime/provider@1` contribution exposes exactly
`blizzard.starcraft2.galaxy-pure-bounded-v1`. It executes zero-argument Galaxy functions whose
bodies contain only direct zero-argument calls and exact `int32`/`bool`/`string`/`null` literal
returns. Runtime inputs are logical `ResourceSessionPort` requirements supplied by a trusted
in-process host; the context is rejected before `createSession` for worker, process and remote
profiles. The v2 session provides deterministic bounded step/events/snapshot/restore/state-hash.
Trigger XML remains native authored input with unavailable semantic lowering. Catalog mechanics,
general Galaxy expressions/control flow, replay/save/network semantics, and native signing,
launch and playback remain named Block 19/GA blockers.

This slice adds a capability-refusal variant to the public v1 `RuntimeExecutionResult` union so
unsupported entrypoints, natives, subset constructs, cancellation and disposal are not mislabeled
as numeric budget failures. It does not change any frozen runtime-session v2 member or refusal wire
shape. It is additive at runtime and covered by the SDK public-type compile fixture, but TypeScript
consumers that intentionally exhaust every former union member must add the new reasons; this is a
source-level migration obligation, not claimed as a no-impact type change.

Historical conversion receipts remain in the archived source workspace and are not shipped with
the runtime extension.

## SC2 bank public API (M2)

- `@modkit/blizzard-starcraft2/bank/core`: portable parsing, serialization, editing, validation,
  signatures, BankList and path inference from the pinned MK2 implementation.
- `@modkit/blizzard-starcraft2/bank/node`: the core API plus filesystem IO, discovery and `runBankCli`.
- `@modkit/blizzard-starcraft2/bank/codec`: native `createCodec`, `createCodecWithOptions` and the
  versioned `SC2_BANK_OPERATION_MAP` for all six legacy operations.
- `modkitx-bank`: the preserved CLI, emitted from TypeScript into `dist`.

Native operations are `view.inspect`, `asset.validate`, `export.raw`, `edit.content`,
`source.save-as`, `blizzard/sc2-bank.sign` and `blizzard/sc2-bank.verify`. Signing requires the
bank/author/player identity inferred from the path or provided as `signatureInfo` through
`createCodecWithOptions`. Save-as returns canonical XML as a JSON string; raw export preserves
the original bytes, including a UTF-8 BOM. Mutating operations return edit plans for the host.

From the repository root, build with `pnpm run build` and run the complete copied suite with
`pnpm run test:mk2 -- sc2-bank`. M2 is a scoped technical port; full family surfaces and installed
VS Code acceptance remain M7/M8 work.

## Desktop content sources

The CASC / Battle.net source picker, account and region sessions, public bookmarks, native-runtime
configuration, verification and current limits are documented in [content-sources.md](docs/content-sources.md).

## Cutscenes

`blizzard/sc2-cutscene` reads `.SC2Cutscene` and `.StormCutscene` — the scene graph campaign
cinematics are authored in, and the place most of a campaign's model, sound and conversation
references actually live. It reads all 2233 shipped files and writes every one back byte for byte;
structural editing waits on two attribute meanings the format has not disclosed. The format, the
measurements behind it and what is deliberately left unanswered are in
[sc2-cutscene.md](docs/sc2-cutscene.md).
