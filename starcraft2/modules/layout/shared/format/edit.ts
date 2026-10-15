import {
  Sc2EditInputError,
  type RenameEditPlan,
  type RenameEditTransaction,
  type RenameFinding,
  type RenameOutput,
  type RenameSourceEdit,
} from '../../../../shared/editing/rename-transaction.js'
import type { Sc2LayoutDocument } from './document.js'
import { SC2_LAYOUT_CODEC_ID } from './identity.js'
import { renameSc2LayoutReferenceBytes } from './reference-rename.js'
import type { Sc2LayoutRenameOptions } from './rename.js'

export const SC2_LAYOUT_REFERENCE_RENAME_NO_OP_DIAGNOSTIC_ID =
  'sc2-layout.edit.reference-rename.no-op'

export interface Sc2LayoutReferenceRenameEditPlan extends RenameEditPlan {
  readonly summary: {
    readonly referencesPatched: number
  }
}

export type Sc2LayoutReferenceRenameEditTransaction =
  RenameEditTransaction<Sc2LayoutReferenceRenameEditPlan>

function fail(message: string, context: Record<string, unknown> = {}): never {
  throw new Sc2EditInputError(message, {
    codecId: SC2_LAYOUT_CODEC_ID,
    operation: 'edit.content',
    ...context,
  })
}

function prepare(
  document: Sc2LayoutDocument,
  options: Sc2LayoutRenameOptions,
): {
  readonly plan: Sc2LayoutReferenceRenameEditPlan
  readonly outputs: readonly RenameOutput[]
} {
  const renamed = renameSc2LayoutReferenceBytes(document, options)
  const diagnostics: RenameFinding[] = []
  const edits: RenameSourceEdit[] = []
  const outputs: RenameOutput[] = []

  if (renamed.referencesPatched === 0) {
    diagnostics.push({
      id: SC2_LAYOUT_REFERENCE_RENAME_NO_OP_DIAGNOSTIC_ID,
      severity: 'info',
      category: 'other',
      code: 'sc2-layout.edit.reference-rename.no-op',
      message: 'No SC2Layout reference value matches the requested catalog rename.',
      source: SC2_LAYOUT_CODEC_ID,
      path: document.source.path,
    })
  } else {
    const bytes = renamed.bytes
    edits.push({
      sourceId: document.source.id,
      operation: 'replace',
      range: { offset: 0, length: document.bytes.byteLength },
      bytes,
      label: `Rename catalog references in ${document.source.path}`,
    })
    outputs.push({
      path: document.source.path,
      data: bytes,
      mediaType: 'application/xml',
      role: 'sc2-layout',
    })
  }

  const plan: Sc2LayoutReferenceRenameEditPlan = {
    edits,
    diagnostics,
    // The transform replaces only recognized val="..." contents and preserves every other byte,
    // including an optional UTF-8 BOM.
    preservesUnknownData: true,
    summary: { referencesPatched: renamed.referencesPatched },
  }
  return { plan, outputs }
}

export function createSc2LayoutReferenceRenameEditPlan(
  document: Sc2LayoutDocument,
  options: Sc2LayoutRenameOptions,
): Sc2LayoutReferenceRenameEditPlan {
  return prepare(document, options).plan
}

export function createSc2LayoutReferenceRenameEditTransaction(
  document: Sc2LayoutDocument,
  options: Sc2LayoutRenameOptions,
): Sc2LayoutReferenceRenameEditTransaction {
  const prepared = prepare(document, options)
  let applied: readonly RenameOutput[] | undefined

  return {
    plans: [prepared.plan],

    async validate(): Promise<void> {
      // The plan holds at most one whole-source replace with a bytes payload, so the generic
      // plan validator (payload, path, overlapping ranges) has nothing to reject.
      const diagnostics = prepared.plan.diagnostics
      const errors = diagnostics.filter(diagnostic => diagnostic.severity === 'error')
      if (errors.length > 0) {
        fail(
          `SC2Layout reference rename is invalid: ${errors
            .map(diagnostic => diagnostic.message)
            .join('; ')}`,
          { diagnosticIds: errors.map(diagnostic => diagnostic.id) },
        )
      }
    },

    async apply(): Promise<void> {
      await this.validate()
      applied = prepared.outputs
    },

    outputs(): readonly RenameOutput[] {
      if (applied === undefined) {
        fail('Call apply() before requesting the SC2Layout reference-rename outputs.')
      }
      return applied
    },
  }
}
