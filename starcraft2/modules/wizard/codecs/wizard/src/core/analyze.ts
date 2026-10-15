/**
 * What is wrong with a wizard file, said precisely.
 *
 * The rules are the specification's, and the severities follow one principle: a rule Blizzard
 * states is an error, a rule that depends on something outside this file is a warning, and an
 * element or attribute nobody here recognises is information rather than a defect. That last one is
 * deliberate. `.BlizWiz` is an editor format Blizzard can extend in a patch, and a checker that
 * calls tomorrow's attribute a mistake teaches its reader to stop reading it.
 *
 * Catalog knowledge — which catalogs exist, which entry types they hold, which fields those types
 * have — arrives as an optional `WizardSchema`. Without one, the checks that need it are simply not
 * run rather than being answered by guesswork; the codec says so through `dependency-required`.
 */
import { evaluateWizardText, tokensIn, type WizardCatalogProvider } from './evaluate.js'
import { nodeText, WIZARD_ROOT_TAG } from './parse.js'
import type {
  Wizard,
  WizardCompatibilityMode,
  WizardCondition,
  WizardDiagnostic,
  WizardDocument,
  WizardNode,
  WizardSourcePosition,
} from './types.js'

/** Catalog structure, as much of it as a check needs. Supplied by the host; see `../schema.ts`. */
export interface WizardSchema {
  /** Is `name` a catalog — `Unit`, `Actor`, `Model`? */
  hasCatalog(name: string): boolean
  /** Is `typeId` an entry type — `CActorUnit`? */
  hasType(typeId: string): boolean
  /** The catalog an entry type belongs to. */
  catalogForType(typeId: string): string | undefined
  /** Does `path`, underscore-delimited as the format writes it, exist on `typeId`? */
  hasFieldPath(typeId: string, path: string): boolean
}

export interface WizardAnalysisOptions {
  readonly schema?: WizardSchema
  readonly catalog?: WizardCatalogProvider
  readonly maxDiagnostics?: number
  /** Strict follows the published grammar; editor-compatible reports observed legacy forms softly. */
  readonly compatibilityMode?: WizardCompatibilityMode
  /**
   * Wizards declared by other documents the host supplied, in the host's order. They resolve
   * embedded wizards and qualified tokens; a local wizard always wins, and a local id declared
   * elsewhere as well is reported, because which one the editor loads is decided outside this file.
   */
  readonly externalWizards?: readonly WizardExternal[]
}

export interface WizardExternal {
  /** Where the wizard was declared — a document URI, used only in messages. */
  readonly source: string
  readonly wizard: Wizard
}

export interface WizardAnalysis {
  readonly diagnostics: readonly WizardDiagnostic[]
  /** Wizards declared here, by id — what an embedded reference in this file can reach. */
  readonly wizards: ReadonlyMap<string, Wizard>
}

export const MATCH_VALUES = new Set(['equal', 'begin', 'end', 'contain'])
export const OPERATOR_VALUES = new Set(['equal', 'greater', 'greaterequal', 'less', 'lessequal'])
export const LOGIC_VALUES = new Set(['and', 'or', 'not'])
export const VALIDATE_VALUES = new Set(['error', 'confirm', 'warning'])
const FLAG_VALUES = new Set(['0', '1'])
export const BUILT_IN_INPUT_TYPES = new Set([
  'WizardCheckbox',
  'WizardMenu',
  'WizardRadio',
  'WizardText',
])
export const INDEX_TOKENS = new Set(['ENTRYINDEX', 'VALUEINDEX', 'ITEMINDEX', 'LOADID'])

export const KNOWN_ATTRIBUTES: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['wizardfile', new Set<string>()],
  ['wizard', new Set(['id'])],
  ['objecttypes', new Set(['create', 'load', 'view'])],
  ['instructions', new Set(['page'])],
  [
    'condition',
    new Set(['id', 'input', 'value', 'match', 'operator', 'nocase', 'empty', 'visible', 'logic']),
  ],
  ['input', new Set(['id', 'type'])],
  ['item', new Set(['value', 'text', 'count'])],
  ['color', new Set(['value'])],
  ['default', new Set(['value'])],
  ['minimum', new Set(['value'])],
  ['maximum', new Set(['value'])],
  ['increment', new Set(['value'])],
  ['layout', new Set(['page', 'column', 'minheight', 'minwidth'])],
  ['validate', new Set(['type'])],
  ['macro', new Set(['id', 'replaceSrc', 'replaceDst', 'truncate'])],
  ['entry', new Set(['catalog', 'type'])],
  ['field', new Set(['id'])],
  ['token', new Set(['id'])],
])

/** Elements the specification allows inside each element. */
export const KNOWN_CHILDREN: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['wizardfile', new Set(['wizard'])],
  [
    'wizard',
    new Set([
      'name',
      'description',
      'category',
      'hidden',
      'objecttypes',
      'instructions',
      'condition',
      'input',
      'validate',
      'macro',
      'entry',
    ]),
  ],
  [
    'input',
    new Set([
      'name',
      'tooltip',
      'item',
      'sorted',
      'simpletext',
      'color',
      'default',
      'minimum',
      'maximum',
      'increment',
      'loadvalue',
      'reloadfrom',
      'nosave',
      'nopreview',
      'layout',
      'condition',
    ]),
  ],
  ['validate', new Set(['condition', 'text'])],
  ['condition', new Set(['condition'])],
  [
    'entry',
    new Set([
      'id',
      'useloaded',
      'allowmodify',
      'parentid',
      'count',
      'condition',
      'field',
      'token',
    ]),
  ],
  ['field', new Set(['value', 'stringid', 'count', 'index', 'loadinput', 'cache', 'condition'])],
  ['token', new Set(['value', 'loadinput', 'condition'])],
])

function lineIndex(text: string): number[] {
  const starts = [0]
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\n') starts.push(index + 1)
  }
  return starts
}

function positionAt(starts: readonly number[], offset: number): WizardSourcePosition {
  let low = 0
  let high = starts.length - 1
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if ((starts[middle] as number) <= offset) low = middle
    else high = middle - 1
  }
  return { offset, line: low, character: offset - (starts[low] as number) }
}

/** The evaluated strings a wizard holds, each with the source span its text occupies. */
export interface WizardEvaluatedString {
  readonly text: string
  readonly start: number
  readonly end: number
  readonly what: string
}

function attributeString(node: WizardNode, name: string, what: string): WizardEvaluatedString[] {
  const attribute = node.attributes.find(item => item.name === name)
  if (attribute === undefined) return []
  return [
    { text: attribute.value, start: attribute.valueStart, end: attribute.valueEnd, what },
  ]
}

function textString(node: WizardNode | undefined, what: string): WizardEvaluatedString[] {
  if (node === undefined || node.selfClosing || node.children.length > 0) return []
  return [
    {
      text: nodeText(node),
      start: node.openEnd,
      end: node.end - node.closeRaw.length,
      what,
    },
  ]
}

function childTextString(node: WizardNode, tag: string, what: string): WizardEvaluatedString[] {
  return textString(
    node.children.find(child => child.tag === tag),
    what,
  )
}

function conditionsOf(condition: WizardCondition): WizardCondition[] {
  return [condition, ...condition.children.flatMap(conditionsOf)]
}

export function wizardEvaluatedStrings(wizard: Wizard): readonly WizardEvaluatedString[] {
  const strings: WizardEvaluatedString[] = []
  const everyCondition = [
    ...wizard.conditions,
    ...wizard.inputs.flatMap(input => input.conditions),
    ...wizard.validates.flatMap(validate => validate.conditions),
    ...wizard.entries.flatMap(entry => [
      ...entry.conditions,
      ...entry.fields.flatMap(field => field.conditions),
      ...entry.tokens.flatMap(token => token.conditions),
    ]),
  ].flatMap(conditionsOf)
  for (const condition of everyCondition) {
    strings.push(...attributeString(condition.node, 'value', 'condition value'))
  }
  for (const input of wizard.inputs) {
    for (const item of input.items) {
      strings.push(...attributeString(item.node, 'value', 'item value'))
      strings.push(...attributeString(item.node, 'text', 'item text'))
      strings.push(...attributeString(item.node, 'count', 'item count'))
    }
    for (const tag of ['default', 'minimum', 'maximum', 'increment']) {
      const child = input.node.children.find(item => item.tag === tag)
      if (child !== undefined) strings.push(...attributeString(child, 'value', `${tag} value`))
    }
    strings.push(...childTextString(input.node, 'loadvalue', 'loadvalue'))
  }
  for (const validate of wizard.validates) {
    strings.push(...childTextString(validate.node, 'text', 'validation text'))
  }
  for (const macro of wizard.macros) {
    strings.push(...textString(macro.node, `macro ${macro.id}`))
    strings.push(...attributeString(macro.node, 'replaceSrc', 'replaceSrc'))
    strings.push(...attributeString(macro.node, 'replaceDst', 'replaceDst'))
  }
  for (const entry of wizard.entries) {
    strings.push(...attributeString(entry.node, 'type', 'entry type'))
    for (const tag of ['id', 'parentid', 'count']) {
      strings.push(...childTextString(entry.node, tag, `entry ${tag}`))
    }
    for (const field of entry.fields) {
      for (const tag of ['value', 'stringid', 'count', 'index']) {
        strings.push(...childTextString(field.node, tag, `field ${field.id} ${tag}`))
      }
    }
    for (const token of entry.tokens) {
      strings.push(...childTextString(token.node, 'value', `token ${token.id} value`))
    }
  }
  return strings
}

/**
 * Every `<input>` id reachable from a wizard, including the ones its embedded wizards contribute
 * under the `SubWizard:Input` spelling the specification defines for cross-wizard references.
 */
function inputNames(wizard: Wizard, wizards: ReadonlyMap<string, Wizard>): Set<string> {
  const names = new Set(wizard.inputs.map(input => input.id))
  for (const input of wizard.inputs) {
    if (!input.type.startsWith('Wizard:')) continue
    const embedded = wizards.get(input.type.slice('Wizard:'.length))
    if (embedded === undefined) continue
    for (const nested of embedded.inputs) {
      names.add(`${input.id}:${nested.id}`)
      names.add(`${embedded.id}:${nested.id}`)
    }
  }
  return names
}

/** Every node of `ids` that lies on a cycle of `next`; edges to unknown nodes are ignored. */
function cycleMembers(ids: Iterable<string>, next: (id: string) => Iterable<string>): Set<string> {
  const known = new Set(ids)
  const inCycle = new Set<string>()
  const state = new Map<string, 'open' | 'done'>()
  const walk = (id: string, stack: string[]): void => {
    if (state.get(id) === 'done') return
    if (state.get(id) === 'open') {
      for (const member of stack.slice(stack.indexOf(id))) inCycle.add(member)
      return
    }
    state.set(id, 'open')
    for (const target of next(id)) if (known.has(target)) walk(target, [...stack, id])
    state.set(id, 'done')
  }
  for (const id of known) walk(id, [])
  return inCycle
}

function embeddedCycles(wizards: ReadonlyMap<string, Wizard>): Set<string> {
  return cycleMembers(wizards.keys(), id =>
    (wizards.get(id)?.inputs ?? [])
      .filter(input => input.type.startsWith('Wizard:'))
      .map(input => input.type.slice('Wizard:'.length)),
  )
}

/**
 * Macros and input defaults that can only evaluate by evaluating themselves. Tokens resolve the
 * way the evaluator resolves them — a macro before an input's default — so the graph is the one
 * evaluation would actually walk. Qualified `^Owner:Token^` names are left out: they evaluate in
 * another wizard's scope.
 */
function evaluationCycles(wizard: Wizard): Set<string> {
  const macros = new Map(wizard.macros.filter(macro => macro.id !== '').map(macro => [macro.id, macro]))
  const defaults = new Map(
    wizard.inputs
      .filter(input => input.id !== '' && input.default !== undefined)
      .map(input => [input.id, input.default as string]),
  )
  const nodeFor = (token: string): string | undefined =>
    macros.has(token) ? `macro:${token}` : defaults.has(token) ? `default:${token}` : undefined
  const textsOf = (node: string): string[] => {
    const name = node.slice(node.indexOf(':') + 1)
    if (node.startsWith('default:')) return [defaults.get(name) ?? '']
    const macro = macros.get(name)
    return macro === undefined ? [] : [macro.text, macro.replaceSrc ?? '', macro.replaceDst ?? '']
  }
  return cycleMembers(
    [...[...macros.keys()].map(id => `macro:${id}`), ...[...defaults.keys()].map(id => `default:${id}`)],
    node => textsOf(node).flatMap(text => tokensIn(text)).map(nodeFor).filter((item): item is string => item !== undefined),
  )
}

/** Check a wizard file against the specification, and against catalog data when it is available. */
export function analyzeWizardDocument(
  document: WizardDocument,
  options: WizardAnalysisOptions = {},
): WizardAnalysis {
  const starts = lineIndex(document.text)
  const limit = options.maxDiagnostics ?? 1000
  const compatibilityMode = options.compatibilityMode ?? 'strict'
  const diagnostics: WizardDiagnostic[] = []
  let wizardId: string | undefined

  const report = (
    code: string,
    severity: WizardDiagnostic['severity'],
    message: string,
    start: number,
    end: number,
  ): void => {
    if (diagnostics.length >= limit) return
    diagnostics.push({
      code: `sc2-wizard-${code}`,
      severity,
      message,
      start: positionAt(starts, start),
      end: positionAt(starts, Math.max(start, end)),
      ...(wizardId === undefined ? {} : { wizardId }),
    })
  }

  const reportElement = (
    code: string,
    severity: WizardDiagnostic['severity'],
    message: string,
    node: WizardNode,
  ): void => report(code, severity, message, node.start, node.openEnd)

  const reportAttribute = (
    code: string,
    severity: WizardDiagnostic['severity'],
    message: string,
    node: WizardNode,
    name: string,
  ): void => {
    const attribute = node.attributes.find(item => item.name === name)
    if (attribute === undefined) reportElement(code, severity, message, node)
    else report(code, severity, message, attribute.valueStart, attribute.valueEnd)
  }

  const requireAttribute = (node: WizardNode, name: string): string | undefined => {
    const attribute = node.attributes.find(item => item.name === name)
    if (attribute === undefined || attribute.value === '') {
      reportElement(
        'missing-attribute',
        'error',
        `<${node.tag}> requires a ${name} attribute`,
        node,
      )
      return undefined
    }
    return attribute.value
  }

  const checkVocabulary = (node: WizardNode): void => {
    const known = KNOWN_ATTRIBUTES.get(node.tag)
    if (known !== undefined) {
      for (const attribute of node.attributes) {
        if (known.has(attribute.name)) continue
        const cased = [...known].find(
          name => name.toLowerCase() === attribute.name.toLowerCase(),
        )
        report(
          'unknown-attribute',
          'info',
          cased === undefined
            ? `<${node.tag}> has no documented ${attribute.name} attribute; it is preserved but the editor may ignore it`
            : `<${node.tag}> spells this attribute ${cased}; the editor matches case`,
          attribute.nameStart,
          attribute.nameStart + attribute.name.length,
        )
      }
    }
    const children = KNOWN_CHILDREN.get(node.tag)
    for (const child of node.children) {
      if (children !== undefined && !children.has(child.tag)) {
        const cased = [...children].find(name => name.toLowerCase() === child.tag.toLowerCase())
        reportElement(
          'unknown-element',
          'info',
          cased === undefined
            ? `<${child.tag}> is not documented inside <${node.tag}>; it is preserved but the editor may ignore it`
            : `<${node.tag}> spells this child <${cased}>; the editor matches case`,
          child,
        )
      }
      checkVocabulary(child)
    }
  }

  /** A literal (not evaluated) integer attribute that must be at least `minimum`. */
  const checkNumber = (node: WizardNode, name: string, minimum: number): void => {
    const attribute = node.attributes.find(item => item.name === name)
    if (attribute === undefined) return
    const value = Number(attribute.value)
    if (attribute.value.trim() !== '' && Number.isInteger(value) && value >= minimum) return
    reportAttribute(
      'invalid-value',
      'error',
      `${name}="${attribute.value}" must be an integer of at least ${minimum}`,
      node,
      name,
    )
  }

  const checkEnum = (
    node: WizardNode,
    name: string,
    allowed: ReadonlySet<string>,
  ): void => {
    const attribute = node.attributes.find(item => item.name === name)
    if (attribute === undefined) return
    if (allowed.has(attribute.value)) return
    reportAttribute(
      'invalid-value',
      'error',
      `${name}="${attribute.value}" is not one of ${[...allowed].join(', ')}`,
      node,
      name,
    )
  }

  const root = document.file.root
  if (root === undefined) {
    report(
      'root-missing',
      'error',
      'a wizard file must have a <wizardfile> root element',
      0,
      Math.min(document.text.length, 64),
    )
    return { diagnostics, wizards: new Map() }
  }
  if (document.file.rootKind === 'standalone-wizard') {
    report(
      'compatibility-root',
      compatibilityMode === 'strict' ? 'error' : 'warning',
      'a standalone <wizard> root is a compatibility form; the documented root is <wizardfile>',
      root.start,
      root.openEnd,
    )
  } else if (root.tag !== WIZARD_ROOT_TAG) {
    report(
      'noncanonical-root',
      compatibilityMode === 'strict' ? 'error' : 'warning',
      `<${root.tag}> is a compatibility spelling; the documented root is <${WIZARD_ROOT_TAG}>`,
      root.start,
      root.openEnd,
    )
  }
  checkVocabulary(root)

  const wizards = new Map<string, Wizard>()
  for (const wizard of document.file.wizards) {
    if (wizard.id === '') continue
    if (wizards.has(wizard.id)) {
      wizardId = wizard.id
      reportAttribute(
        'duplicate-id',
        'error',
        `a wizard with id ${wizard.id} is already declared in this file`,
        wizard.node,
        'id',
      )
    } else wizards.set(wizard.id, wizard)
  }
  const visible = new Map(wizards)
  const elsewhere = new Map<string, string[]>()
  for (const external of options.externalWizards ?? []) {
    const id = external.wizard.id
    if (id === '') continue
    elsewhere.set(id, [...(elsewhere.get(id) ?? []), external.source])
    if (!visible.has(id)) visible.set(id, external.wizard)
  }
  const cycles = embeddedCycles(visible)

  for (const wizard of document.file.wizards) {
    wizardId = wizard.id === '' ? undefined : wizard.id
    requireAttribute(wizard.node, 'id')
    if (wizard.name === undefined) {
      reportElement('missing-name', 'error', 'a wizard requires a <name> element', wizard.node)
    }
    const sources = wizards.get(wizard.id) === wizard ? elsewhere.get(wizard.id) : undefined
    if (sources !== undefined) {
      reportAttribute(
        'duplicate-wizard-elsewhere',
        'warning',
        `a wizard with id ${wizard.id} is also declared in ${sources.join(', ')}; which one the editor uses depends on load order`,
        wizard.node,
        'id',
      )
    }
    if (cycles.has(wizard.id)) {
      reportElement(
        'embedded-cycle',
        'error',
        `wizard ${wizard.id} embeds itself through a chain of Wizard: inputs`,
        wizard.node,
      )
    }

    const inputs = new Set<string>()
    for (const input of wizard.inputs) {
      requireAttribute(input.node, 'id')
      const type = requireAttribute(input.node, 'type')
      if (input.id !== '' && inputs.has(input.id)) {
        reportAttribute(
          'duplicate-id',
          'error',
          `input ${input.id} is declared twice in this wizard`,
          input.node,
          'id',
        )
      }
      inputs.add(input.id)
      if (type !== undefined && type.startsWith('Wizard:')) {
        const target = type.slice('Wizard:'.length)
        if (!visible.has(target)) {
          reportAttribute(
            'embedded-wizard-missing',
            'warning',
            `no wizard ${target} in this file or the supplied workspace; an embedded wizard may come from another file, but the editor must be able to load it`,
            input.node,
            'type',
          )
        }
      } else if (
        type !== undefined &&
        type.startsWith('Wizard') &&
        !BUILT_IN_INPUT_TYPES.has(type)
      ) {
        /*
         * Only the `Wizard`-prefixed namespace is checked. Everything else is "any type recognized
         * by the game catalog system" — `int32`, `CStringLink`, `CModelPath` — and the generated
         * schema does not carry all of those: `CModelPath` is the specification's own example and
         * is absent from it. A rule that reported Blizzard's example as wrong would be a finding
         * about this checker, so there is no rule.
         */
        reportAttribute(
          'unknown-input-type',
          'error',
          `${type} is not a wizard control type; the controls are ${[...BUILT_IN_INPUT_TYPES].join(', ')} and Wizard:<wizardid>`,
          input.node,
          'type',
        )
      }
      if (input.items.length > 0 && type !== 'WizardMenu' && type !== 'WizardRadio') {
        reportElement(
          'items-ignored',
          'warning',
          `<item> elements only populate WizardMenu and WizardRadio; this input is ${type ?? 'untyped'}`,
          input.node,
        )
      }
      const color = input.node.children.find(child => child.tag === 'color')
      if (color !== undefined && type !== 'WizardText') {
        reportElement(
          'color-ignored',
          'warning',
          `<color> is only supported by WizardText; this input is ${type ?? 'untyped'}`,
          color,
        )
      }
      const reloadfrom = input.node.children.find(child => child.tag === 'reloadfrom')
      if (reloadfrom !== undefined && input.loadvalue === undefined) {
        reportElement(
          'reloadfrom-without-loadvalue',
          'warning',
          'reloadfrom reloads the value from <loadvalue>, and this input has none',
          reloadfrom,
        )
      }
      const layout = input.node.children.find(child => child.tag === 'layout')
      if (layout !== undefined) {
        checkNumber(layout, 'page', 1)
        checkNumber(layout, 'column', 1)
        checkNumber(layout, 'minheight', 0)
        checkNumber(layout, 'minwidth', 0)
      }
    }
    for (const instructions of wizard.instructions) checkNumber(instructions.node, 'page', 1)

    const macros = new Set<string>()
    for (const macro of wizard.macros) {
      requireAttribute(macro.node, 'id')
      checkNumber(macro.node, 'truncate', 0)
      if (macro.id !== '' && macros.has(macro.id)) {
        reportAttribute(
          'duplicate-id',
          'error',
          `macro ${macro.id} is declared twice in this wizard`,
          macro.node,
          'id',
        )
      }
      macros.add(macro.id)
    }

    const named = new Set<string>()
    for (const condition of wizard.conditions) {
      if (condition.id === undefined) {
        reportElement(
          'unnamed-condition',
          'warning',
          'a condition at wizard level defines a named condition and needs an id',
          condition.node,
        )
      } else if (named.has(condition.id)) {
        reportAttribute(
          'duplicate-id',
          'error',
          `condition ${condition.id} is declared twice in this wizard`,
          condition.node,
          'id',
        )
      } else named.add(condition.id)
    }

    const cyclic = evaluationCycles(wizard)
    for (const macro of wizard.macros) {
      if (!cyclic.has(`macro:${macro.id}`)) continue
      reportAttribute(
        'evaluation-cycle',
        'error',
        `macro ${macro.id} cannot be evaluated: it refers back to itself through its tokens`,
        macro.node,
        'id',
      )
    }
    for (const input of wizard.inputs) {
      if (!cyclic.has(`default:${input.id}`)) continue
      reportElement(
        'evaluation-cycle',
        'error',
        `the default of input ${input.id} cannot be evaluated: it refers back to itself through its tokens`,
        input.node.children.find(child => child.tag === 'default') ?? input.node,
      )
    }

    const reachable = inputNames(wizard, visible)
    const checkCondition = (condition: WizardCondition, topLevel: boolean): void => {
      checkEnum(condition.node, 'match', MATCH_VALUES)
      checkEnum(condition.node, 'operator', OPERATOR_VALUES)
      checkEnum(condition.node, 'logic', LOGIC_VALUES)
      checkEnum(condition.node, 'nocase', FLAG_VALUES)
      checkEnum(condition.node, 'empty', FLAG_VALUES)
      checkEnum(condition.node, 'visible', FLAG_VALUES)
      if (!topLevel && condition.id !== undefined && !named.has(condition.id)) {
        reportAttribute(
          'unknown-condition',
          'error',
          `no condition named ${condition.id} is declared in this wizard`,
          condition.node,
          'id',
        )
      }
      /*
       * A warning because that is what the editor does: SC2Editor 5.0.16 lists "Unknown input
       * 'Sub;Flag' referenced by condition 'inline_00002'" as a Warning and the dialog proceeds
       * (runtime-confirmed 2026-09-15, artifacts/editor-acceptance-2026-09-15/wizards, T3).
       */
      if (condition.input !== undefined && !reachable.has(condition.input)) {
        reportAttribute(
          'unknown-input',
          'warning',
          `no input named ${condition.input} in this wizard`,
          condition.node,
          'input',
        )
      }
      for (const child of condition.children) checkCondition(child, false)
    }
    for (const condition of wizard.conditions) checkCondition(condition, true)
    for (const input of wizard.inputs) {
      for (const condition of input.conditions) checkCondition(condition, false)
      for (const name of input.reloadfrom) {
        if (reachable.has(name)) continue
        reportElement(
          'unknown-input',
          'error',
          `reloadfrom names ${name}, which is not an input of this wizard`,
          input.node.children.find(child => child.tag === 'reloadfrom') ?? input.node,
        )
      }
    }
    for (const validate of wizard.validates) {
      checkEnum(validate.node, 'type', VALIDATE_VALUES)
      const validateType = validate.node.attributes.find(item => item.name === 'type')
      if (validateType === undefined || validateType.value === '') {
        if (compatibilityMode === 'editor-compatible') {
          reportElement(
            'legacy-missing-validate-type',
            'warning',
            'this validation omits the documented type attribute; the editor counts its failure as an error',
            validate.node,
          )
        } else {
          requireAttribute(validate.node, 'type')
        }
      }
      if (validate.text === undefined) {
        reportElement(
          'missing-text',
          'warning',
          'a validation with no <text> gives the user no reason for the failure',
          validate.node,
        )
      }
      for (const condition of validate.conditions) checkCondition(condition, false)
    }

    for (const entry of wizard.entries) {
      const catalog = requireAttribute(entry.node, 'catalog')
      const typeAttribute = entry.node.attributes.find(item => item.name === 'type')
      /*
       * A loaded entry already has a type, and the corpus omits it there (`SCBW Effects.BlizWiz`,
       * `SCBW Requirements.BlizWiz`). Whether the editor accepts that is not documented, so strict
       * mode keeps the specification's requirement.
       */
      const legacyLoadedType =
        compatibilityMode === 'editor-compatible' &&
        entry.useloaded &&
        (typeAttribute === undefined || typeAttribute.value === '')
      if (legacyLoadedType) {
        reportElement(
          'legacy-missing-entry-type',
          'warning',
          'this loaded entry omits the documented type attribute; editor-compatible mode takes it from the loaded entry',
          entry.node,
        )
      }
      const type = legacyLoadedType ? undefined : requireAttribute(entry.node, 'type')
      /*
       * `id` is required by the specification even next to `<useloaded/>`, which uses the loaded
       * entry's identifier "regardless of the id element" — and the corpus omits it there.
       */
      if (entry.id === undefined) {
        if (entry.useloaded && compatibilityMode === 'editor-compatible') {
          reportElement(
            'legacy-missing-entry-id',
            'warning',
            'this loaded entry omits the required <id>; editor-compatible mode takes the loaded entry’s identifier',
            entry.node,
          )
        } else {
          reportElement('missing-entry-id', 'error', 'an entry requires an <id> element', entry.node)
        }
      }
      for (const condition of entry.conditions) checkCondition(condition, false)
      if (options.schema !== undefined) {
        if (catalog !== undefined && !options.schema.hasCatalog(catalog)) {
          reportAttribute(
            'unknown-catalog',
            'error',
            `${catalog} is not a StarCraft II catalog`,
            entry.node,
            'catalog',
          )
        }
        /*
         * The type is `(evaluated)`, so a wizard may compute it. Only a literal is checked: a
         * computed one is unknown until the dialog runs, and reporting it as wrong would be a
         * finding about this checker rather than about the file.
         */
        if (type !== undefined && !type.includes('^') && !options.schema.hasType(type)) {
          reportAttribute(
            'unknown-entry-type',
            'error',
            `${type} is not a catalog entry type`,
            entry.node,
            'type',
          )
        } else if (type !== undefined && catalog !== undefined && !type.includes('^')) {
          const owner = options.schema.catalogForType(type)
          if (owner !== undefined && owner !== catalog) {
            reportAttribute(
              'catalog-type-mismatch',
              'error',
              `${type} belongs to the ${owner} catalog, not ${catalog}`,
              entry.node,
              'type',
            )
          }
        }
      }
      for (const field of entry.fields) {
        const id = requireAttribute(field.node, 'id')
        for (const condition of field.conditions) checkCondition(condition, false)
        if (field.loadinput !== undefined && !reachable.has(field.loadinput)) {
          reportElement(
            'unknown-input',
            'error',
            `loadinput names ${field.loadinput}, which is not an input of this wizard`,
            field.node.children.find(child => child.tag === 'loadinput') ?? field.node,
          )
        }
        if (
          options.schema !== undefined &&
          id !== undefined &&
          type !== undefined &&
          !type.includes('^') &&
          options.schema.hasType(type) &&
          !options.schema.hasFieldPath(type, id)
        ) {
          reportAttribute(
            'unknown-field',
            'error',
            `${type} has no field ${id}`,
            field.node,
            'id',
          )
        }
      }
      for (const token of entry.tokens) {
        requireAttribute(token.node, 'id')
        for (const condition of token.conditions) checkCondition(condition, false)
        if (token.loadinput !== undefined && !reachable.has(token.loadinput)) {
          reportElement(
            'unknown-input',
            'error',
            `loadinput names ${token.loadinput}, which is not an input of this wizard`,
            token.node.children.find(child => child.tag === 'loadinput') ?? token.node,
          )
        }
      }
    }

    if (wizard.hidden && (wizard.objecttypes?.view.length ?? 0) > 0) {
      reportAttribute(
        'view-hidden',
        'warning',
        'a hidden wizard is never shown in Wizard View, so its view object types have no effect',
        (wizard.objecttypes as NonNullable<typeof wizard.objecttypes>).node,
        'view',
      )
    }

    if (wizard.objecttypes !== undefined && options.schema !== undefined) {
      for (const usage of ['create', 'load', 'view'] as const) {
        for (const name of wizard.objecttypes[usage]) {
          if (options.schema.hasCatalog(name)) continue
          /*
           * A warning, as the editor raises nothing: SC2Editor 5.0.16 loads the wizard and silently
           * drops the unknown name when it saves it — `load="Ability"` exported as `<objecttypes/>`
           * while `Abil` survived (runtime-confirmed 2026-09-15, fixtures/editor-saved-export.BlizWiz).
           */
          reportAttribute(
            'unknown-object-type',
            'warning',
            `${name} is not a StarCraft II object type; the editor drops it when it saves the wizard`,
            wizard.objecttypes.node,
            usage,
          )
        }
      }
    }

    /*
     * Token names are checked against what the wizard declares rather than by evaluating: an
     * evaluation without input values is unresolved everywhere and would say nothing useful, while
     * a name that matches no index token, macro, input or embedded reference is wrong whatever the
     * values turn out to be.
     */
    for (const string of wizardEvaluatedStrings(wizard)) {
      const raw = document.text.slice(string.start, string.end)
      for (const token of tokensIn(string.text)) {
        if (INDEX_TOKENS.has(token) || macros.has(token) || reachable.has(token)) continue
        const colon = token.indexOf(':')
        const found = raw.indexOf(`^${token}^`)
        const start = found < 0 ? string.start : string.start + found
        if (colon > 0) {
          const owner = token.slice(0, colon)
          if (visible.has(owner) || inputs.has(owner)) continue
          /*
           * The owner is a wizard this one embeds, declared in another file. That is a missing
           * dependency, already reported as `embedded-wizard-missing`, not a wrong name.
           */
          if (wizard.inputs.some(input => input.type === `Wizard:${owner}`)) {
            report(
              'embedded-token-unresolved',
              'warning',
              `^${token}^ names an input of embedded wizard ${owner}, which is not in this file`,
              start,
              found < 0 ? string.end : start + token.length + 2,
            )
            continue
          }
        }
        report(
          'unknown-token',
          'error',
          `^${token}^ in the ${string.what} names no macro, input or index token of this wizard`,
          start,
          found < 0 ? string.end : start + token.length + 2,
        )
      }
      if (options.catalog === undefined) continue
      const evaluation = evaluateWizardText(string.text, {
        wizard,
        wizards: visible,
        catalog: options.catalog,
      })
      for (const unresolved of evaluation.unresolved) {
        if (unresolved.kind !== 'catalog-missing') continue
        report(
          'unresolved-reference',
          'warning',
          `${unresolved.name} in the ${string.what} does not resolve against the loaded catalog`,
          string.start,
          string.end,
        )
      }
    }
  }

  wizardId = undefined
  return { diagnostics, wizards }
}
