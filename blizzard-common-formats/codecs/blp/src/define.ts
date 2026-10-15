import { defineCodec, type CodecAuthoringSpec } from '@modkit/sdk/authoring'
import { contractId } from '@modkit/core'
import { createCodec } from '../../../src/blp/codec.js'

const runtime = createCodec()
const handler = async (): Promise<never> => { throw new Error('operation dispatch is owned by the opened codec session') }
const operations = [
  { id: 'view.inspect', handlerId: 'inspect', mutatesSource: false, requiredPermissions: ['read-source'], outputKinds: ['json'], handler },
  { id: 'asset.validate', handlerId: 'validate', mutatesSource: false, requiredPermissions: ['read-source'], outputKinds: ['none'], handler },
  { id: 'export.raw', handlerId: 'export-raw', mutatesSource: false, requiredPermissions: ['read-source'], outputKinds: ['bytes'], handler },
] as unknown as CodecAuthoringSpec['operations']

export const displayName = 'Blizzard BLP texture'
export const status = 'partial'
export const limitations = Object.freeze([
  'Validates BLP1 and BLP2 headers and mip ranges and decodes top mips: BLP1 and BLP2 palettised at alpha depths 0, 1, 4 and 8, BLP2 DXT1/DXT3/DXT5 and uncompressed BGRA, and baseline sequential JPEG BLP1 through the shared codec-kit decoder.',
  'JPEG BLP1 reconstructs the shared header plus mip payload and maps B/G/R/alpha planes to RGBA; alpha depth zero produces opaque pixels. Malformed, progressive or dimension-mismatched JPEG streams refuse at decoded read. BLP2 JPEG stays metadata-only. Installed WoW JPEG BLP1 profiles are not yet verified.',
  'Only mip level zero is exposed as decoded pixels; layer, face and slice selection stay at zero.',
  'The codec is read-only; texture writing and mip generation require the pending writer/service contract.',
])

export const codec = defineCodec({
  id: 'blizzard/blp', displayName, format: { formatId: 'blp', label: displayName }, roles: ['media'],
  topology: 'single', stages: ['authored', 'compiled', 'runtime'], intents: ['probe', 'inspect', 'thumbnail', 'full', 'export'],
  match: { extensions: ['blp'], signatures: [{ from: 'start', offset: 0, bytesHex: '424c5031' }, { from: 'start', offset: 0, bytesHex: '424c5032' }] },
  probe: { kind: 'bytes', ranges: [{ from: 'start', length: 4096 }], maxBytes: 4096, run: runtime.probe },
  open: runtime.open, operations,
  representations: [{ id: 'raster-metadata', contract: contractId('common.image/raster-metadata'), major: 1, stage: 'authored', lossy: false }],
  publishesDataSources: [
    { contract: 'common.view/raster-image-source', major: 1 }, { contract: 'common.view/tree-data-source', major: 1 },
    { contract: 'common.view/byte-range-source', major: 1 },
  ],
  budgets: { maxInputBytes: 1_073_741_824n, maxDepth: 64, maxNodes: 100_000, maxScalarBytes: 104_857_600, maxDiagnostics: 1_000 },
  implementationTier: { claimed: 1 }, profile: 'source-reader', targets: [
    { variantId: 'trusted-node', environments: ['node'], entrypoint: './codecs/blp/runtime.js', executionProfile: 'trusted-in-process' },
    { variantId: 'portable', environments: ['browser-worker', 'node-worker'], entrypoint: './codecs/blp/runtime.js', executionProfile: 'worker-brokered' },
  ],
})
