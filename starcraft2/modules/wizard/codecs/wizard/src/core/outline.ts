/**
 * What a wizard will do, stated without running it.
 *
 * This is the answer a person opening a `.BlizWiz` actually wants: which catalog entries appear,
 * which fields they set, which values the user has to supply first. The file says all of it, but
 * spread across four kinds of element and a small expression language, which is why reading the XML
 * tree is not the same as knowing.
 *
 * Values are reported in both forms. `expression` is what the file says, always; `value` appears
 * only when the evaluator could finish the job with the inputs and catalog it was given. Nothing
 * here fills a gap with a plausible number — an outline that quietly invented one would be a
 * description of a wizard that does not exist.
 */
import { evaluateWizardText, type WizardEvaluationContext } from './evaluate.js'
import type { Wizard, WizardDocument } from './types.js'

export interface WizardOutlineValue {
  readonly expression: string
  readonly value?: string
  readonly unresolved?: readonly string[]
}

export interface WizardOutlineField {
  readonly id: string
  readonly value?: WizardOutlineValue
  readonly stringid?: WizardOutlineValue
  readonly index?: WizardOutlineValue
  readonly count?: WizardOutlineValue
  readonly loadinput?: string
  readonly cached: boolean
  readonly conditional: boolean
}

export interface WizardOutlineEntry {
  readonly catalog: string
  readonly type: string
  readonly id?: WizardOutlineValue
  readonly parentid?: WizardOutlineValue
  readonly count?: WizardOutlineValue
  readonly useloaded: boolean
  readonly allowmodify: boolean
  readonly conditional: boolean
  readonly fields: readonly WizardOutlineField[]
  readonly tokens: readonly { readonly id: string; readonly value?: WizardOutlineValue }[]
}

export interface WizardOutlineInput {
  readonly id: string
  readonly type: string
  readonly label: string
  readonly page: number
  readonly column: number
  readonly conditional: boolean
  readonly saves: boolean
  readonly embedded?: string
}

export interface WizardOutline {
  readonly id: string
  readonly name: string
  readonly category?: string
  readonly hidden: boolean
  readonly pages: number
  readonly objectTypes: {
    readonly create: readonly string[]
    readonly load: readonly string[]
    readonly view: readonly string[]
  }
  readonly inputs: readonly WizardOutlineInput[]
  readonly macros: readonly string[]
  readonly validations: readonly { readonly type: string; readonly text?: string }[]
  readonly entries: readonly WizardOutlineEntry[]
  /** `Catalog.Type.FieldPath` for every field the wizard writes, deduplicated and sorted. */
  readonly touchedFields: readonly string[]
}

export interface WizardOutlineOptions {
  readonly inputs?: ReadonlyMap<string, string>
  readonly catalog?: WizardEvaluationContext['catalog']
  readonly wizards?: ReadonlyMap<string, Wizard>
}

function valueOf(
  expression: string | undefined,
  wizard: Wizard,
  options: WizardOutlineOptions,
): WizardOutlineValue | undefined {
  if (expression === undefined) return undefined
  const context: WizardEvaluationContext = {
    wizard,
    ...(options.inputs === undefined ? {} : { inputs: options.inputs }),
    ...(options.catalog === undefined ? {} : { catalog: options.catalog }),
    ...(options.wizards === undefined ? {} : { wizards: options.wizards }),
  }
  const evaluation = evaluateWizardText(expression, context)
  if (evaluation.resolved) return { expression, value: evaluation.text }
  return {
    expression,
    unresolved: evaluation.unresolved.map(item => item.name),
  }
}

/** Describe one wizard. */
export function outlineWizard(wizard: Wizard, options: WizardOutlineOptions = {}): WizardOutline {
  const evaluate = (expression: string | undefined) => valueOf(expression, wizard, options)
  const entries = wizard.entries.map(entry => ({
    catalog: entry.catalog,
    type: entry.type,
    ...(evaluate(entry.id) === undefined ? {} : { id: evaluate(entry.id) as WizardOutlineValue }),
    ...(evaluate(entry.parentid) === undefined
      ? {}
      : { parentid: evaluate(entry.parentid) as WizardOutlineValue }),
    ...(evaluate(entry.count) === undefined
      ? {}
      : { count: evaluate(entry.count) as WizardOutlineValue }),
    useloaded: entry.useloaded,
    allowmodify: entry.allowmodify,
    conditional: entry.conditions.length > 0,
    fields: entry.fields.map(field => ({
      id: field.id,
      ...(evaluate(field.value) === undefined
        ? {}
        : { value: evaluate(field.value) as WizardOutlineValue }),
      ...(evaluate(field.stringid) === undefined
        ? {}
        : { stringid: evaluate(field.stringid) as WizardOutlineValue }),
      ...(evaluate(field.index) === undefined
        ? {}
        : { index: evaluate(field.index) as WizardOutlineValue }),
      ...(evaluate(field.count) === undefined
        ? {}
        : { count: evaluate(field.count) as WizardOutlineValue }),
      ...(field.loadinput === undefined ? {} : { loadinput: field.loadinput }),
      cached: field.cache,
      conditional: field.conditions.length > 0,
    })),
    tokens: entry.tokens.map(token => ({
      id: token.id,
      ...(evaluate(token.value) === undefined
        ? {}
        : { value: evaluate(token.value) as WizardOutlineValue }),
    })),
  }))

  return {
    id: wizard.id,
    name: wizard.name ?? wizard.id,
    ...(wizard.category === undefined ? {} : { category: wizard.category }),
    hidden: wizard.hidden,
    pages: Math.max(
      1,
      ...wizard.inputs.map(input => input.layout.page),
      ...wizard.instructions.map(item => item.page),
    ),
    objectTypes: {
      create: wizard.objecttypes?.create ?? [],
      load: wizard.objecttypes?.load ?? [],
      view: wizard.objecttypes?.view ?? [],
    },
    inputs: wizard.inputs.map(input => ({
      id: input.id,
      type: input.type,
      label: input.name ?? input.id,
      page: input.layout.page,
      column: input.layout.column,
      conditional: input.conditions.length > 0,
      /*
       * `nosave` inputs steer other inputs and never reach data. Saying so is the difference
       * between "this wizard asks for eight values" and "this wizard writes six of them".
       */
      saves: !input.nosave && input.type !== 'WizardText',
      ...(input.type.startsWith('Wizard:')
        ? { embedded: input.type.slice('Wizard:'.length) }
        : {}),
    })),
    macros: wizard.macros.map(macro => macro.id),
    validations: wizard.validates.map(validate => ({
      type: validate.type,
      ...(validate.text === undefined ? {} : { text: validate.text }),
    })),
    entries,
    touchedFields: [
      ...new Set(
        entries.flatMap(entry =>
          entry.fields.map(field => `${entry.catalog}.${entry.type}.${field.id}`),
        ),
      ),
    ].sort(),
  }
}

/** Describe every wizard in a file. */
export function outlineWizardDocument(
  document: WizardDocument,
  options: WizardOutlineOptions = {},
): WizardOutline[] {
  const wizards =
    options.wizards ??
    new Map(document.file.wizards.filter(item => item.id !== '').map(item => [item.id, item]))
  return document.file.wizards.map(wizard => outlineWizard(wizard, { ...options, wizards }))
}
