import { defineCodec, type CodecAuthoringSpec } from '@modkit/sdk/authoring'
import { contractId } from '@modkit/core'
import { createCodec } from '../../../src/mpq/codec.js'

const runtime = createCodec()
const handler = async (): Promise<never> => { throw new Error('operation dispatch is owned by the opened codec session') }
const operations = [
  { id: 'view.inspect', handlerId: 'inspect', mutatesSource: false, requiredPermissions: ['read-source'], outputKinds: ['json'], handler },
  { id: 'asset.validate', handlerId: 'validate', mutatesSource: false, requiredPermissions: ['read-source'], outputKinds: ['none'], handler },
  { id: 'export.raw', handlerId: 'export-raw', mutatesSource: false, requiredPermissions: ['read-source'], outputKinds: ['bytes'], handler },
  { id: 'container.extract', handlerId: 'extract-entry', mutatesSource: false, requiredPermissions: ['read-source'], outputKinds: ['bytes'], handler },
  { id: 'container.pack', handlerId: 'pack-container', mutatesSource: true, requiredPermissions: ['read-source', 'write-source'], outputKinds: ['edit-plan'], handler },
] as unknown as CodecAuthoringSpec['operations']

export const displayName = 'Blizzard MPQ archive'
export const status = 'supported'
export const limitations = Object.freeze([
  'The portable MK3 reader covers classic MPQ v0-v3 hash/block tables and stored, bounded zlib/raw-deflate, or bounded bzip2 payloads; encrypted, implode, patch, sector-CRC and high-offset changed entries remain explicit gates.',
  'When a valid classic header has truncated or structurally invalid hash/block tables, ordinary open may recover one complete bounded chain of independently validated zlib or bzip2 single-unit payloads under synthetic block IDs. Recovered sessions are read-only.',
  'container.pack returns a revision-pinned outer-source edit plan for native-preserving replacement or deterministic MPQ v0 creation from a complete bounded named payload set.',
  'Only this container codec retains source archive bytes. Composed semantic codecs receive namespace entries, and export.raw remains a separate explicitly declared operation.',
])

export const specExtensions = Object.freeze({
  fidelityEvidence: [{
    formatId: 'mpq', representationId: 'archive-namespace',
    claim: { roundTrip: 'semantic', preservesUnknownData: false, notes: [
      'Every explicitly supplied named payload is stored byte-for-byte in a deterministic MPQ v0 archive.',
      'The frozen proof executes pinned MK2-to-MK3 and MK3-to-MK2 open/list/read projections for nonempty and empty named payload sets while excluding the generated listfile from user-entry equality.',
      'Native layout, compression, encryption, unnamed blocks and signing are outside fresh creation.',
    ] },
    evidenceId: 'mpq-container-pack-create-v1', corpusId: 'm4-packed-oracle:mpq-writer-cross-direction',
    corpusDigest: 'sha256:7350cf9dfdbc6bb01eb2b01a144a43126f22117fc441b0de59d89c6761a61f27',
    conformanceProfile: 'common.archive/container-pack-v1', optionsFingerprint: 'm4-named-payloads-exclude-generated-listfile-v1',
    inputClass: 'nonempty-and-empty-complete-explicit-named-payload-sets', provenAt: '2026-09-05T00:00:00Z',
  }, {
    // What container.pack claims when it replaces entries of an existing archive (a map edit saved).
    formatId: 'mpq', representationId: 'archive-namespace',
    claim: { roundTrip: 'semantic', preservesUnknownData: true, notes: [
      'Native-preserving replacement of named entries in an MPQ v0–v3 archive: every untouched entry, the hash table, HET table, prefix and suffix stay byte-identical; a changed entry is rewritten in its slot, or moves to where the tables began with the tables following it.',
      'Version 3: the changed entries\' BET records, raw-chunk MD5s and the header\'s block-table, BET-table and header MD5s are rewritten; bzip2 entries are written with zlib.',
      'Deterministic rebuild (archiveMode deterministic-rebuild) keeps every named payload outside the replacement set byte-identical in a fresh MPQ v0.',
      'Proof: installed version 3 maps take an object move through edit.world, container.pack and the host commit and reopen with every other entry byte-identical (starcraft2/test/sc2-map-v3-save-corpus.test.ts); cached Battle.net archives check BET and every MD5 against node:crypto (mpq/test/native-preserving-v3-corpus.test.ts); v0 Deliverance and v1 WTE70 Save As (starcraft2/test/sc2-map-world-writer.test.ts, mpq/test/native-preserving-workflow.test.ts).',
      'Opaque attributes and signatures are copied and reported invalidated; Modkit never recomputes a Blizzard signature.',
    ] },
    evidenceId: 'mpq-container-pack-replace-v1',
    corpusId: 'modkit-extensions-blizzard/starcraft2/test/sc2-map-v3-save-corpus.test.ts',
    corpusDigest: 'none:proof-suite',
    conformanceProfile: 'common.archive/container-pack-v1', optionsFingerprint: 'native-preserving-or-deterministic-rebuild-v2',
    inputClass: 'mpq-v0-v3-named-entry-replacement', provenAt: '2026-10-02T00:00:00Z',
  }],
})

export const codec = defineCodec({
  id: 'blizzard/mpq', displayName, format: { formatId: 'mpq', label: displayName }, roles: ['container'], topology: 'single',
  stages: ['authored', 'compiled'], intents: ['probe', 'inspect', 'full', 'export'],
  match: { extensions: ['sc2mod', 'sc2map', 'sc2replay', 'sc2campaign', 'mpq', 's2ma', 's2mv', 'w3m', 'w3x', 'w3n', 'scm', 'scx'], signatures: [
    { from: 'start', offset: 0, bytesHex: '4d50511a' }, { from: 'start', offset: 0, bytesHex: '4d50511b' }, { from: 'start', offset: 0, bytesHex: '484d3357' },
  ] },
  probe: { kind: 'bytes', ranges: [{ from: 'start', length: 4096 }], maxBytes: 4096, run: runtime.probe }, open: runtime.open, operations,
  representations: [{ id: 'archive-namespace', contract: contractId('common.archive/entry-namespace'), major: 1, stage: 'authored', lossy: false }],
  publishesDataSources: [
    { contract: 'common.view/namespace-entry-source', major: 1 }, { contract: 'common.view/tree-data-source', major: 1 },
    { contract: 'common.view/byte-range-source', major: 1 },
  ],
  budgets: { maxInputBytes: 1_073_741_824n, maxDepth: 64, maxNodes: 100_000, maxScalarBytes: 104_857_600, maxDiagnostics: 1_000 },
  implementationTier: { claimed: 1 }, profile: 'explicit', permissions: ['read-source', 'write-source'], targets: [
    { variantId: 'trusted-node', environments: ['node'], entrypoint: './codecs/container-mpq/runtime.js', executionProfile: 'trusted-in-process' },
    { variantId: 'portable', environments: ['browser-worker', 'node-worker'], entrypoint: './codecs/container-mpq/runtime.js', executionProfile: 'worker-brokered' },
  ],
})
