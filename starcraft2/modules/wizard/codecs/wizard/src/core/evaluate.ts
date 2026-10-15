/**
 * The little language inside `.BlizWiz`.
 *
 * A wizard file is not declarative XML. The specification marks many elements `(evaluated)`, and
 * their text runs through three stages before the editor uses it: tokens between `^` characters are
 * replaced, then catalog references of the form `ref=TYPE,ENTRYID,FIELDPATH` are looked up, then
 * what is left is evaluated as arithmetic if it happens to be an arithmetic expression. That is why
 * this module exists at all: a codec that only parsed the XML would show a tree of the file and
 * still not be able to say what the wizard produces.
 *
 * Stage two needs loaded catalog data, which a codec reading its own bytes does not have. When no
 * catalog is supplied the evaluator **refuses**: it leaves the reference standing, reports it as
 * unresolved, and never invents a value. A guessed number here would travel straight into a
 * generated catalog entry, and a wrong entry that looks right is worse than a missing answer.
 */
import type { Wizard } from './types.js'

/** What the evaluator needs from loaded catalog data. Supplied by the host, never by this module. */
export interface WizardCatalogProvider {
  /** The value of `FIELDPATH` on `ENTRYID` of catalog `TYPE`, or `undefined` when there is none. */
  fieldValue(type: string, entryId: string, fieldPath: string): string | undefined
  /** The element count for a `FIELDPATH#` reference. */
  fieldCount(type: string, entryId: string, fieldPath: string): number | undefined
}

export interface WizardEvaluationContext {
  readonly wizard: Wizard
  /** Current input values by input id. Embedded inputs use the `SubWizardId:InputId` spelling. */
  readonly inputs?: ReadonlyMap<string, string>
  readonly entryIndex?: number
  readonly valueIndex?: number
  readonly itemIndex?: number
  readonly loadId?: string
  readonly catalog?: WizardCatalogProvider
  /** Every wizard the file declares, so `Wizard:<id>` inputs and `wizardid:token` can be followed. */
  readonly wizards?: ReadonlyMap<string, Wizard>
}

export interface WizardUnresolved {
  readonly kind: 'token' | 'macro-cycle' | 'default-cycle' | 'reference' | 'catalog-missing'
  readonly name: string
}

export interface WizardEvaluation {
  /** The text after every stage that could be applied. */
  readonly text: string
  readonly resolved: boolean
  readonly unresolved: readonly WizardUnresolved[]
  /** Present when stage three produced a number. */
  readonly numeric?: number
}

/** `^^` is the escape for a literal `^`; everything else between carets is a token. */
export function splitTokens(text: string): { readonly literal: string; readonly token?: string }[] {
  const parts: { literal: string; token?: string }[] = []
  let literal = ''
  let index = 0
  while (index < text.length) {
    if (text[index] !== '^') {
      literal += text[index]
      index += 1
      continue
    }
    if (text[index + 1] === '^') {
      literal += '^'
      index += 2
      continue
    }
    const close = text.indexOf('^', index + 1)
    if (close < 0) {
      literal += text.slice(index)
      break
    }
    parts.push({ literal, token: text.slice(index + 1, close) })
    literal = ''
    index = close + 1
  }
  parts.push({ literal })
  return parts
}

/** Every token name a piece of evaluated text mentions, in order, `^^` excluded. */
export function tokensIn(text: string): string[] {
  return splitTokens(text)
    .map(part => part.token)
    .filter((token): token is string => token !== undefined)
}

function wizardFor(name: string, context: WizardEvaluationContext): Wizard | undefined {
  const direct = context.wizards?.get(name)
  if (direct !== undefined) return direct
  const input = context.wizard.inputs.find(item => item.id === name)
  if (input === undefined || !input.type.startsWith('Wizard:')) return undefined
  return context.wizards?.get(input.type.slice('Wizard:'.length))
}

interface EvaluationState {
  readonly unresolved: WizardUnresolved[]
  /*
   * What is being evaluated right now, per wizard: a macro and an input default can each lead back
   * to themselves, directly or through each other, and an embedded wizard may reuse the same names.
   */
  readonly stack: { readonly wizard: Wizard; readonly kind: 'macro' | 'default'; readonly name: string }[]
}

/** Run `evaluate` for one stack frame, or report the cycle it would close and yield ''. */
function guarded(
  frame: EvaluationState['stack'][number],
  state: EvaluationState,
  evaluate: () => string | undefined,
): string | undefined {
  if (state.stack.some(item => item.wizard === frame.wizard && item.kind === frame.kind && item.name === frame.name)) {
    state.unresolved.push({ kind: frame.kind === 'macro' ? 'macro-cycle' : 'default-cycle', name: frame.name })
    return ''
  }
  state.stack.push(frame)
  try {
    return evaluate()
  } finally {
    state.stack.pop()
  }
}

function macroValue(
  name: string,
  context: WizardEvaluationContext,
  state: EvaluationState,
): string | undefined {
  const macro = context.wizard.macros.find(item => item.id === name)
  if (macro === undefined) return undefined
  return guarded({ wizard: context.wizard, kind: 'macro', name }, state, () => {
    let value = run(macro.text, context, state).text
    if (macro.replaceSrc !== undefined) {
      const source = run(macro.replaceSrc, context, state).text
      const destination = run(macro.replaceDst ?? '', context, state).text
      if (source !== '') value = value.split(source).join(destination)
    }
    if (macro.truncate > 0) value = value.slice(0, macro.truncate)
    return value
  })
}

function tokenValue(
  name: string,
  context: WizardEvaluationContext,
  state: EvaluationState,
): string | undefined {
  if (name === 'ENTRYINDEX') return String(context.entryIndex ?? 0)
  if (name === 'VALUEINDEX') return String(context.valueIndex ?? 0)
  if (name === 'ITEMINDEX') return String(context.itemIndex ?? 0)
  if (name === 'LOADID') return context.loadId
  const direct = context.inputs?.get(name)
  if (direct !== undefined) return direct
  const macro = macroValue(name, context, state)
  if (macro !== undefined) return macro
  const input = context.wizard.inputs.find(item => item.id === name)
  if (input !== undefined) {
    const fallback = input.default
    return fallback === undefined
      ? undefined
      : guarded({ wizard: context.wizard, kind: 'default', name }, state, () => run(fallback, context, state).text)
  }
  const colon = name.indexOf(':')
  if (colon <= 0) return undefined
  /*
   * `wizardid:subtoken` and `inputid:subtoken` both evaluate the subtoken inside another wizard.
   * The value the caller already holds wins: a host driving a dialog knows what the embedded
   * control currently shows, and that is more current than the embedded wizard's own default.
   */
  const embedded = wizardFor(name.slice(0, colon), context)
  if (embedded === undefined) return undefined
  const scoped: WizardEvaluationContext = { ...context, wizard: embedded }
  return run(`^${name.slice(colon + 1)}^`, scoped, state).text
}

const REFERENCE = /ref=([A-Za-z0-9_]+),([^,\s)]*),([^\s)]+)/gu

export interface WizardCatalogReference {
  readonly type: string
  readonly entryId: string
  readonly fieldPath: string
  readonly start: number
  readonly end: number
}

/** Parse catalog references with the exact grammar used by evaluation. */
export function catalogReferencesIn(text: string): readonly WizardCatalogReference[] {
  REFERENCE.lastIndex = 0
  return [...text.matchAll(REFERENCE)].map(match => ({
    type: match[1] as string,
    entryId: match[2] as string,
    fieldPath: match[3] as string,
    start: match.index as number,
    end: (match.index as number) + match[0].length,
  }))
}

function applyReferences(
  text: string,
  context: WizardEvaluationContext,
  state: EvaluationState,
): string {
  REFERENCE.lastIndex = 0
  return text.replace(REFERENCE, (match, type: string, entryId: string, path: string) => {
    if (context.catalog === undefined) {
      state.unresolved.push({ kind: 'reference', name: match })
      return match
    }
    const counting = path.endsWith('#')
    const fieldPath = counting ? path.slice(0, -1) : path
    const value = counting
      ? context.catalog.fieldCount(type, entryId, fieldPath)
      : context.catalog.fieldValue(type, entryId, fieldPath)
    if (value === undefined) {
      state.unresolved.push({ kind: 'catalog-missing', name: match })
      return match
    }
    return String(value)
  })
}

const ARITHMETIC = /^[0-9.+\-*/() ]+$/u

interface Reader {
  readonly text: string
  index: number
}

function skipSpaces(reader: Reader): void {
  while (reader.text[reader.index] === ' ') reader.index += 1
}

function parsePrimary(reader: Reader): number | undefined {
  skipSpaces(reader)
  if (reader.text[reader.index] === '-') {
    reader.index += 1
    const value = parsePrimary(reader)
    return value === undefined ? undefined : -value
  }
  if (reader.text[reader.index] === '(') {
    reader.index += 1
    const value = parseSum(reader)
    skipSpaces(reader)
    if (value === undefined || reader.text[reader.index] !== ')') return undefined
    reader.index += 1
    return value
  }
  const match = /^[0-9]*\.?[0-9]+/u.exec(reader.text.slice(reader.index))
  if (match === null) return undefined
  reader.index += match[0].length
  return Number(match[0])
}

function parseProduct(reader: Reader, integer: boolean): number | undefined {
  let left = parsePrimary(reader)
  if (left === undefined) return undefined
  for (;;) {
    skipSpaces(reader)
    const operator = reader.text[reader.index]
    if (operator !== '*' && operator !== '/') return left
    reader.index += 1
    const right = parsePrimary(reader)
    if (right === undefined) return undefined
    if (operator === '*') left *= right
    else {
      if (right === 0) return undefined
      /*
       * The specification says the expression is integer "unless a period is present", which is the
       * C++ rule the editor is written in: an integer division truncates. `((5 - 1) * 2) / 8` is 1,
       * not 1.0, and a wizard that writes that into a field expects the whole number.
       */
      left = integer ? Math.trunc(left / right) : left / right
    }
  }
}

function parseSum(reader: Reader, integer = !reader.text.includes('.')): number | undefined {
  let left = parseProduct(reader, integer)
  if (left === undefined) return undefined
  for (;;) {
    skipSpaces(reader)
    const operator = reader.text[reader.index]
    if (operator !== '+' && operator !== '-') return left
    reader.index += 1
    const right = parseProduct(reader, integer)
    if (right === undefined) return undefined
    left = operator === '+' ? left + right : left - right
  }
}

/**
 * Stage three: evaluate the text as arithmetic, or leave it alone.
 *
 * `undefined` means "this is not an arithmetic expression", which is the normal answer — most
 * evaluated strings are identifiers and prose. Only text made entirely of digits, `.`, `+-*​/`,
 * parentheses and spaces is even considered, exactly as the specification limits it.
 */
export function evaluateArithmetic(text: string): number | undefined {
  const trimmed = text.trim()
  if (trimmed === '' || !ARITHMETIC.test(trimmed)) return undefined
  const reader: Reader = { text: trimmed, index: 0 }
  const value = parseSum(reader)
  skipSpaces(reader)
  if (value === undefined || reader.index !== trimmed.length || !Number.isFinite(value)) {
    return undefined
  }
  return value
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(12)))
}

function run(
  text: string,
  context: WizardEvaluationContext,
  state: EvaluationState,
): { text: string; numeric?: number } {
  let substituted = ''
  for (const part of splitTokens(text)) {
    substituted += part.literal
    if (part.token === undefined) continue
    const value = tokenValue(part.token, context, state)
    if (value === undefined) {
      state.unresolved.push({ kind: 'token', name: part.token })
      substituted += `^${part.token}^`
      continue
    }
    substituted += value
  }
  const referenced = applyReferences(substituted, context, state)
  if (state.unresolved.length > 0) return { text: referenced }
  const numeric = evaluateArithmetic(referenced)
  return numeric === undefined ? { text: referenced } : { text: formatNumber(numeric), numeric }
}

/** Evaluate one `(evaluated)` string through all three stages. */
export function evaluateWizardText(
  text: string,
  context: WizardEvaluationContext,
): WizardEvaluation {
  const state: EvaluationState = { unresolved: [], stack: [] }
  const result = run(text, context, state)
  return {
    text: result.text,
    resolved: state.unresolved.length === 0,
    unresolved: state.unresolved,
    ...(result.numeric === undefined ? {} : { numeric: result.numeric }),
  }
}

/** Evaluate a named macro the way the editor does, replacements and truncation included. */
export function evaluateWizardMacro(
  id: string,
  context: WizardEvaluationContext,
): WizardEvaluation {
  const state: EvaluationState = { unresolved: [], stack: [] }
  const value = macroValue(id, context, state)
  if (value === undefined) {
    return { text: '', resolved: false, unresolved: [{ kind: 'token', name: id }] }
  }
  const numeric = state.unresolved.length === 0 ? evaluateArithmetic(value) : undefined
  return {
    text: numeric === undefined ? value : formatNumber(numeric),
    resolved: state.unresolved.length === 0,
    unresolved: state.unresolved,
    ...(numeric === undefined ? {} : { numeric }),
  }
}
