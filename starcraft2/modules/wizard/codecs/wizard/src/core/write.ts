/**
 * Writing a `.BlizWiz` file back out.
 *
 * The writer reads only the model. It never looks at the source text, and that restraint is the
 * point: `writeWizardDocument(parseWizardDocument(text)) === text` is then a statement about the
 * model's completeness rather than a statement about slicing. Anything the parser failed to record
 * — an attribute, a comment, the choice of quote character, the blank line before an element —
 * comes back missing, and the round-trip test fails.
 *
 * That is the check MK2's wizard parser claimed to pass and could not: it modelled `DataWizard`,
 * `Step` and `Field`, none of which are elements of this format, so on a real file it produced an
 * empty result and its writer would have written an empty file over it.
 */
import type { WizardDocument, WizardNode } from './types.js'

export function writeWizardNode(node: WizardNode): string {
  const attributes = node.attributes
    .map(item => `${item.lead}${item.name}${item.separator}${item.quote}${item.raw}${item.quote}`)
    .join('')
  const open = `${node.gapBefore}<${node.tag}${attributes}${node.openTrailing}`
  if (node.selfClosing) return `${open}/>`
  const children = node.children.map(child => writeWizardNode(child)).join('')
  return `${open}>${children}${node.innerTail}${node.closeRaw}`
}

export function writeWizardDocument(document: WizardDocument): string {
  return `${document.roots.map(node => writeWizardNode(node)).join('')}${document.epilogue}`
}
