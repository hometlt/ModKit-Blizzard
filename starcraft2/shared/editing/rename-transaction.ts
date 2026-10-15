/**
 * Narrow SC2 rename-transaction values shared by the Data and Layout reference renames.
 *
 * The sc2-mod rename coordinator composes these per-codec transactions. The shapes are
 * structurally the same as codec-kit's section 5.5 edit plan, so the coordinator keeps working
 * while the domain modules no longer import legacy asset DTOs or the legacy error class.
 */

/** One produced file. */
export interface RenameOutput {
  readonly path: string
  readonly data: Uint8Array
  readonly mediaType?: string
  readonly role?: string
}

/** One whole-source or range replacement, carrying exactly one of `text` or `bytes`. */
export type RenameSourceEdit = {
  readonly sourceId: string
  readonly operation: 'replace'
  readonly range?: { readonly offset: number; readonly length: number }
  readonly label?: string
} & (
  | { readonly text: string; readonly bytes?: undefined }
  | { readonly bytes: Uint8Array; readonly text?: undefined }
)

export interface RenameFinding {
  readonly id: string
  readonly severity: 'error' | 'warning' | 'info'
  /** Historical dotted code, e.g. `sc2-data.edit.entity-rename.no-op`. */
  readonly code: string
  readonly category: 'malformed' | 'partial-support' | 'other'
  readonly message: string
  readonly source: string
  readonly path?: string
  readonly detail?: Readonly<Record<string, unknown>>
}

export interface RenameEditPlan {
  readonly edits: readonly RenameSourceEdit[]
  readonly diagnostics: readonly RenameFinding[]
  /** `false` must surface to the user before a destructive save. */
  readonly preservesUnknownData: boolean
}

export interface RenameEditTransaction<Plan extends RenameEditPlan = RenameEditPlan> {
  readonly plans: readonly Plan[]
  validate(): Promise<void>
  apply(): Promise<void>
  /** The produced files. Throws before `apply()`. */
  outputs(): readonly RenameOutput[]
}

/** Invalid edit/export input or a misuse of a transaction; `code` keeps the historical value. */
export class Sc2EditInputError extends Error {
  override readonly name = 'Sc2EditInputError'
  readonly code = 'CONFIG_INVALID'
  readonly context: Readonly<Record<string, unknown>>
  constructor(message: string, context: Readonly<Record<string, unknown>> = {}) {
    super(message)
    this.context = context
  }
}
