import { errorCode, operationId } from '@modkit/core'
import { createInspectionCodec, editPlanFromInput, replaceBytes } from '@modkit/codec-kit'
import type {
  InspectionContext,
  InspectionOperationState,
  InspectionResult,
} from '@modkit/codec-kit'
import type {
  AssetDiagnostic,
  Codec,
  ContributionContext,
  JsonValue,
  OperationDecl,
  OperationOutput,
} from '@modkit/sdk'
import { serializeBank } from '../../../shared/core/core.js'
import type { SC2BankSignatureInfo, SerializeBankOptions } from '../../../shared/core/core.js'
import {
  detectSc2BankHeader,
  editSc2BankValue,
  openSc2Bank,
  sc2BankMetadata,
  sc2BankSignatureState,
  signSc2Bank,
  type Sc2BankEdit,
  type Sc2BankModel,
} from './domain.js'
import { SC2_BANK_CODEC_ID } from './identity.js'
import { definition as matureInspection } from '../../../shared/inspection.js'

const ID = 'blizzard/sc2-bank'
const encoder = new TextEncoder()

/** Versioned, explicit legacy → native operation mapping (save.sign is domain-owned). */
export const SC2_BANK_OPERATION_MAP = Object.freeze({
  'view.inspect': { id: 'view.inspect', handlerId: 'inspect' },
  'asset.validate': { id: 'asset.validate', handlerId: 'validate' },
  'export.raw': { id: 'export.raw', handlerId: 'export-raw' },
  'edit.content': { id: 'edit.content', handlerId: 'patch-value' },
  'source.save-as': { id: 'source.save-as', handlerId: 'save-as' },
  'save.sign': { id: 'blizzard/sc2-bank.sign', handlerId: 'sign' },
})
export const SC2_BANK_OPERATION_MAP_VERSION = 1

export const operations: readonly OperationDecl[] = Object.freeze([
  ...Object.entries(SC2_BANK_OPERATION_MAP).map(([legacyId, mapping]): OperationDecl => {
    const mutatesSource = legacyId === 'edit.content' || legacyId === 'save.sign'
    return {
      id: operationId(mapping.id, { contributionId: ID }),
      handlerId: mapping.handlerId,
      mutatesSource,
      requiredPermissions: mutatesSource ? ['read-source', 'write-source'] : ['read-source'],
      outputKinds: [mutatesSource ? 'edit-plan' : legacyId === 'export.raw' ? 'bytes' : 'json'],
    }
  }),
  {
    id: operationId('blizzard/sc2-bank.verify', { contributionId: ID }),
    handlerId: 'verify',
    mutatesSource: false,
    requiredPermissions: ['read-source'],
    outputKinds: ['json'],
  },
  /*
   * `edit.field` is what the tree, the table and the metadata panel invoke when a reader edits one
   * published value. It is a translation, not a second writer: it resolves the surface's
   * `FieldWriteRequest` to a section and key and hands it to the raw-preserving MK2 patcher behind
   * `edit.content`, so one code path rewrites bank XML and the byte-level fidelity guarantee is
   * the same one `edit.content` already carries.
   */
  {
    id: operationId('edit.field', { contributionId: ID }),
    handlerId: 'edit-field',
    mutatesSource: true,
    requiredPermissions: ['read-source', 'write-source'],
    outputKinds: ['edit-plan'],
  },
])

export interface Sc2BankCodecOptions {
  readonly signatureInfo?: SC2BankSignatureInfo
  /** Declared game context; only raises detection confidence. */
  readonly context?: { readonly gameId?: string }
}

function json(value: unknown): OperationOutput {
  return { kind: 'json', value: JSON.parse(JSON.stringify(value)) as JsonValue }
}

const NOT_SIGNABLE_REASON =
  'Author/player IDs could not be inferred from the source path (expected ' +
  '.../Banks/<authorId>/<bankName>.SC2Bank under a .../<playerId>/Banks/ ancestor) and no ' +
  'declared signatureInfo was available.'

function nativeStates(model: Sc2BankModel): readonly InspectionOperationState[] {
  return Object.values(SC2_BANK_OPERATION_MAP).map(mapping => {
    const id = operationId(mapping.id, { contributionId: ID })
    if (mapping.handlerId === 'sign' && model.signatureInfo === undefined) {
      return { id, state: 'disabled', reason: NOT_SIGNABLE_REASON }
    }
    return { id, state: 'available' }
  })
}

/** The validation report in the shape `asset.validate` has always returned (info findings dropped). */
function validationFindings(model: Sc2BankModel) {
  return model.validation.findings.map((finding, index) => ({
    id: `sc2-bank.validate.${finding.code}.${index}`,
    severity: finding.severity,
    code: `sc2-bank.${finding.code}`,
    message: finding.message,
    source: SC2_BANK_CODEC_ID,
    path: finding.path,
  }))
}

const SIGNATURE_FINDINGS = new Set(['missing-signature', 'missing-signature-info', 'invalid-signature', 'valid-signature'])

function nativeDiagnostics(model: Sc2BankModel): AssetDiagnostic[] {
  return model.validation.findings.map((finding, index) => ({
    id: `sc2-bank.validate.${finding.code}.${index}`,
    code: errorCode(`blizzard/sc2-bank-${finding.code}`),
    severity: finding.severity === 'info' ? 'information' : finding.severity,
    message: finding.message,
    category: SIGNATURE_FINDINGS.has(finding.code) ? 'security' : 'structure',
    source: { contributionId: ID },
    data: { path: finding.path },
  }))
}

/**
 * `edit.field` is exactly as available as the patch it delegates to.
 *
 * Advertising it independently would let a surface offer an editable control on a bank the legacy
 * codec has already refused to patch — the reader would type a value and only then learn it cannot
 * be saved. Mirroring `edit.content`'s state, and its reason, keeps the refusal where the reader
 * can see it before spending the work.
 */
function fieldEditState(states: readonly InspectionOperationState[]): InspectionOperationState {
  const content = states.find(
    state => String(state.id) === String(operationId('edit.content', { contributionId: ID })),
  )
  const id = operationId('edit.field', { contributionId: ID })
  if (content === undefined || content.state === 'available') return { id, state: 'available' }
  return {
    id,
    state: content.state,
    reason: 'reason' in content ? content.reason : 'Bank patching is unavailable',
  }
}

async function project(model: Sc2BankModel, context: InspectionContext): Promise<InspectionResult> {
  const bytes =
    context.byteSource === undefined
      ? encoder.encode(model.xml)
      : await context.byteSource.read(0n, Number(await context.byteSource.size()), context.signal)
  const projected = await matureInspection.inspect(bytes, context, model.bank)
  const handlers: Record<string, (input: JsonValue) => Promise<OperationOutput>> = {}
  const patchPlan = (edit: Pick<Sc2BankEdit, 'xml' | 'changed'> & Partial<Sc2BankEdit>): OperationOutput => {
    const encoded = encoder.encode(edit.xml)
    // The canonical document decoder removes a UTF-8 BOM. Preserve those original source bytes
    // at the native edit boundary so all untouched raw bytes retain their original spelling.
    const hasBom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
    const output = hasBom ? new Uint8Array(encoded.length + 3) : encoded
    if (hasBom) {
      output.set([0xef, 0xbb, 0xbf])
      output.set(encoded, 3)
    }
    const diagnostics: AssetDiagnostic[] =
      edit.warning === undefined
        ? []
        : [
            {
              id: 'sc2-bank.edit.signature-will-be-invalid',
              code: errorCode('blizzard/sc2-bank-signature-will-be-invalid'),
              severity: 'warning',
              message: edit.warning,
              category: 'security',
              source: { contributionId: ID },
            },
          ]
    return {
      kind: 'edit-plan',
      plan: editPlanFromInput(context.input, {
        planId: `${ID}:${context.input.revisions.revision}:${edit.changed ? 'changed' : 'unchanged'}`,
        edits: [replaceBytes(0, bytes.length, output, 'SC2 bank raw-preserving patch')],
        fidelity: { roundTrip: 'byte-identical', preservesUnknownData: true },
        diagnostics,
      }),
    }
  }
  handlers['inspect'] = async () => json(sc2BankMetadata(model))
  handlers['validate'] = async () =>
    json(validationFindings(model).filter(finding => finding.severity !== 'info'))
  handlers['export-raw'] = async () => ({ kind: 'bytes', value: bytes.slice() })
  handlers['patch-value'] = async input =>
    patchPlan(editSc2BankValue(model, input as unknown as {
      readonly section: string
      readonly key: string
      readonly type: string
      readonly value: string
    }))
  handlers['save-as'] = async input =>
    json(serializeBank(model.bank, (input ?? {}) as SerializeBankOptions))
  handlers['sign'] = async () => patchPlan(signSc2Bank(model))
  /**
   * Resolve a surface's field write to the (section, key) pair the MK2 patcher works in.
   *
   * Two shapes arrive, because two surfaces publish these values and each knows a different
   * coordinate. The tree publishes the semantic path — section name, then key name — which is
   * stable across edits. The table has only a row and a column, so the row is resolved against the
   * very row order this codec published for that table; the codec built the table, so it is the
   * one component that can index it without guessing.
   *
   * The declared type is never taken from the request. A surface edits a value, not a schema, and
   * accepting a type here would let a stray input silently rewrite `<Value int=…>` as something
   * else. The type comes from the parsed document.
   */
  const flatKeys = model.bank.sections.flatMap(section =>
    section.keys.map(key => ({ section: section.name, key: key.name, value: key.value })),
  )
  const resolveTarget = (
    request: Readonly<Record<string, JsonValue>>,
  ): { readonly section: string; readonly key: string; readonly type: string } => {
    const path = Array.isArray(request['path']) ? request['path'].map(String) : []
    /*
     * The metadata panel edits a descriptor entry, which has a key and no path: the key is the
     * `Section/Key` pair this codec published for that group. Splitting on the first separator
     * keeps key names containing one intact, which SC2 maps do use.
     */
    if (request['groupId'] === 'values') {
      const key = String(request['key'] ?? '')
      const separator = key.indexOf('/')
      const section = separator < 0 ? '' : key.slice(0, separator)
      const name = separator < 0 ? key : key.slice(separator + 1)
      const entry = flatKeys.find(item => item.section === section && item.key === name)
      if (entry === undefined) throw new TypeError(`no bank key "${key}"`)
      return { section, key: name, type: entry.value?.type ?? 'string' }
    }
    if (request['groupId'] === 'table') {
      const row = Number(path[0])
      const entry = Number.isSafeInteger(row) ? flatKeys[row] : undefined
      if (entry === undefined) throw new TypeError(`no bank key at table row ${String(path[0])}`)
      return { section: entry.section, key: entry.key, type: entry.value?.type ?? 'string' }
    }
    const [section, key] = path
    if (section === undefined || key === undefined) {
      throw new TypeError('a bank field write needs a semantic path of section and key')
    }
    const entry = flatKeys.find(item => item.section === section && item.key === key)
    if (entry === undefined) throw new TypeError(`no bank key "${section}/${key}"`)
    return { section, key, type: entry.value?.type ?? 'string' }
  }

  handlers['edit-field'] = async input => {
    const request =
      input !== null && typeof input === 'object' && !Array.isArray(input)
        ? (input as Readonly<Record<string, JsonValue>>)
        : {}
    const target = resolveTarget(request)
    const value = request['value']
    const text = typeof value === 'boolean' ? (value ? '1' : '0') : String(value ?? '')
    return patchPlan(editSc2BankValue(model, { ...target, value: text }))
  }

  handlers['verify'] = async input => {
    const record = input !== null && typeof input === 'object' && !Array.isArray(input) ? input : {}
    const info = 'signatureInfo' in record ? record['signatureInfo'] : undefined
    const fields = info as Readonly<Record<string, JsonValue>> | undefined
    if (
      info !== undefined &&
      (info === null ||
        typeof info !== 'object' ||
        Array.isArray(info) ||
        typeof fields?.['bankName'] !== 'string' ||
        typeof fields?.['authorId'] !== 'string' ||
        typeof fields?.['playerId'] !== 'string')
    ) {
      throw new TypeError('signatureInfo requires bankName, authorId and playerId strings')
    }
    const state = sc2BankSignatureState(model, info as SC2BankSignatureInfo | undefined)
    return json(state === 'valid')
  }
  const states = nativeStates(model)
  return {
    ...projected,
    operationStates: [...states, fieldEditState(states)],
    metadata: [
      ...projected.metadata,
      ...sc2BankMetadata(model).map(group => ({
        id: `legacy-${group.id}`,
        label: group.label,
        entries: group.entries.map(entry => ({ key: entry.id, value: entry.value })),
      })),
    ],
    diagnostics: [...nativeDiagnostics(model), ...(projected.diagnostics ?? [])],
    handlers,
  }
}

async function openModel(
  bytes: Uint8Array,
  context: InspectionContext,
  signatureInfo?: SC2BankSignatureInfo,
): Promise<Sc2BankModel> {
  context.signal?.throwIfAborted()
  return openSc2Bank(new TextDecoder('utf-8').decode(bytes), context.primary.source.uri, signatureInfo)
}

function detection(prefix: Uint8Array, uri: string, gameId?: string) {
  const detected = detectSc2BankHeader(prefix, uri, gameId)
  return {
    confidence: detected.confidence,
    kind: 'structure' as const,
    note: JSON.stringify({ evidence: detected.evidence, requiredRanges: detected.requiredRanges }),
  }
}

export const abiVersion = 1
export function createCodecWithOptions(options: Sc2BankCodecOptions = {}): Codec {
  return createInspectionCodec({
    id: ID,
    format: { id: 'sc2-bank', label: 'StarCraft II bank', mediaType: 'application/xml' },
    operations,
    async detect(prefix, uri) {
      return detection(prefix, uri, options.context?.gameId)
    },
    async inspect(bytes, context) {
      return project(await openModel(bytes, context, options.signatureInfo), context)
    },
  })
}
export const createCodec = (_context?: ContributionContext): Codec => createCodecWithOptions()

/** Compatibility inspection entrypoint for existing MK3 facts consumers. */
export const definition = {
  id: ID,
  async detect(bytes: Uint8Array, uri: string) {
    return { ...detection(bytes, uri), note: 'canonical-sc2-bank' }
  },
  async inspect(bytes: Uint8Array, context: InspectionContext): Promise<InspectionResult> {
    return project(await openModel(bytes, context), context)
  },
}
