/**
 * The `.BlizWiz` document model, in two layers.
 *
 * The lower layer (`WizardNode`) is the file as written: every element, every attribute, the
 * whitespace between them, the quote characters, the comments, the closing tags. It exists because
 * the writer regenerates the document from it alone, so a byte-identical round trip is evidence
 * that nothing was dropped rather than a claim about it. MK2's parser modelled four elements that
 * the format does not have and called the result lossless; the lower layer is the answer to that.
 *
 * The upper layer (`WizardFile` and below) is the format as Blizzard documents it — the elements of
 * `wizardhelp/fileformat.rtf`, typed. Everything it does not recognise is still reachable, because
 * every typed record points back at the node it was read from. That is deliberate: the format is an
 * editor format that Blizzard can extend in a patch, and a reader that silently drops an element it
 * has not seen before is the failure mode this whole module exists to avoid.
 */

/** One attribute, with enough of its source spelling to write it back unchanged. */
export interface WizardAttribute {
  /** Whitespace between the previous token and this attribute's name. */
  readonly lead: string
  readonly name: string
  /** Characters between the name and the opening quote — normally `=`, occasionally padded. */
  readonly separator: string
  readonly quote: string
  /** The value exactly as written, entities and all. */
  readonly raw: string
  /** The value the document means: entities decoded. */
  readonly value: string
  readonly nameStart: number
  readonly valueStart: number
  readonly valueEnd: number
}

/** One element, with the surrounding text that belongs to it. */
export interface WizardNode {
  readonly tag: string
  readonly attributes: readonly WizardAttribute[]
  readonly children: readonly WizardNode[]
  /**
   * Text between the end of the previous sibling (or the parent's `>`, or the start of the file)
   * and this element's `<`. Indentation, blank lines and XML comments all live here.
   */
  readonly gapBefore: string
  /** Whitespace between the last attribute and the tag's own `>` or `/>`. */
  readonly openTrailing: string
  readonly selfClosing: boolean
  /** Raw text after the last child and before the closing tag — the whole body when childless. */
  readonly innerTail: string
  /** The closing tag exactly as written, or `''` for a self-closed element. */
  readonly closeRaw: string
  readonly start: number
  readonly openEnd: number
  readonly end: number
}

export interface WizardCondition {
  readonly node: WizardNode
  /** At wizard level this declares a name; deeper it references one. */
  readonly id?: string
  readonly input?: string
  readonly value?: string
  readonly match?: string
  readonly operator?: string
  readonly nocase?: string
  readonly empty?: string
  readonly visible?: string
  readonly logic: string
  readonly children: readonly WizardCondition[]
}

export interface WizardInputItem {
  readonly node: WizardNode
  readonly value?: string
  readonly text?: string
  readonly count?: string
}

export interface WizardLayout {
  readonly page: number
  readonly column: number
  readonly minheight?: string
  readonly minwidth?: string
}

export interface WizardInput {
  readonly node: WizardNode
  readonly id: string
  readonly type: string
  readonly name?: string
  readonly tooltip?: string
  readonly items: readonly WizardInputItem[]
  readonly sorted: boolean
  readonly simpletext: boolean
  readonly color?: string
  readonly default?: string
  readonly minimum?: string
  readonly maximum?: string
  readonly increment?: string
  readonly loadvalue?: string
  readonly reloadfrom: readonly string[]
  readonly nosave: boolean
  readonly nopreview: boolean
  readonly layout: WizardLayout
  readonly conditions: readonly WizardCondition[]
  /** Child elements the format does not document, kept so nothing is lost. */
  readonly unknown: readonly WizardNode[]
}

export interface WizardValidate {
  readonly node: WizardNode
  readonly type: string
  readonly conditions: readonly WizardCondition[]
  readonly text?: string
}

export interface WizardMacro {
  readonly node: WizardNode
  readonly id: string
  readonly text: string
  readonly replaceSrc?: string
  readonly replaceDst?: string
  readonly truncate: number
}

export interface WizardEntryField {
  readonly node: WizardNode
  readonly id: string
  readonly value?: string
  readonly stringid?: string
  readonly count?: string
  readonly index?: string
  readonly loadinput?: string
  readonly cache: boolean
  readonly conditions: readonly WizardCondition[]
  readonly unknown: readonly WizardNode[]
}

export interface WizardEntryToken {
  readonly node: WizardNode
  readonly id: string
  readonly value?: string
  readonly loadinput?: string
  readonly conditions: readonly WizardCondition[]
}

export interface WizardEntry {
  readonly node: WizardNode
  readonly catalog: string
  readonly type: string
  readonly id?: string
  readonly useloaded: boolean
  readonly allowmodify: boolean
  readonly parentid?: string
  readonly count?: string
  readonly conditions: readonly WizardCondition[]
  readonly fields: readonly WizardEntryField[]
  readonly tokens: readonly WizardEntryToken[]
  readonly unknown: readonly WizardNode[]
}

export interface WizardObjectTypes {
  readonly node: WizardNode
  readonly create: readonly string[]
  readonly load: readonly string[]
  readonly view: readonly string[]
}

export interface WizardInstructions {
  readonly node: WizardNode
  readonly page: number
  /** Text with the common indentation removed, as the editor does when it parses the file. */
  readonly text: string
}

export interface Wizard {
  readonly node: WizardNode
  readonly id: string
  readonly name?: string
  readonly description?: string
  readonly category?: string
  readonly hidden: boolean
  readonly objecttypes?: WizardObjectTypes
  readonly instructions: readonly WizardInstructions[]
  readonly conditions: readonly WizardCondition[]
  readonly inputs: readonly WizardInput[]
  readonly validates: readonly WizardValidate[]
  readonly macros: readonly WizardMacro[]
  readonly entries: readonly WizardEntry[]
  readonly unknown: readonly WizardNode[]
}

export interface WizardFile {
  /** The document root, when a recognized root exists. */
  readonly root?: WizardNode
  /** How the root was recognized. */
  readonly rootKind?: 'wizardfile' | 'standalone-wizard'
  readonly wizards: readonly Wizard[]
  /** Children of `wizardfile` that are not `wizard`, or extra top-level nodes in compatibility mode. */
  readonly unknown: readonly WizardNode[]
}

export interface WizardParseOptions {
  /** Accept `<WizardFile>` and other case variants in addition to the documented spelling. */
  readonly caseInsensitiveRoot?: boolean
  /** Accept a top-level `<wizard>` as a corpus compatibility form. */
  readonly allowStandaloneWizard?: boolean
}

export type WizardCompatibilityMode = 'strict' | 'editor-compatible'

export interface WizardDocument {
  readonly text: string
  readonly roots: readonly WizardNode[]
  /** Text after the last top-level element — a trailing newline, usually. */
  readonly epilogue: string
  readonly file: WizardFile
}

export interface WizardSourcePosition {
  readonly offset: number
  readonly line: number
  readonly character: number
}

export interface WizardDiagnostic {
  readonly code: string
  readonly severity: 'error' | 'warning' | 'info'
  readonly message: string
  readonly start: WizardSourcePosition
  readonly end: WizardSourcePosition
  /** The wizard the finding belongs to, when it belongs to one. */
  readonly wizardId?: string
}
