/**
 * The edit-isolation gate: write a hostile value into every editable target of a document, one at
 * a time, and prove that nothing else moved.
 *
 * For each target the edited text is reparsed and must offer the same set of edit paths, every other
 * target must still hold its exact original bytes, and the edited one must read back as the value
 * that was written. This is the property `edit.field` promises; running it over the real corpus and
 * the SC2Editor-saved file is what makes the promise evidence rather than intent.
 */
import { decodeXmlEntities, encodeXmlAttribute, encodeXmlText } from '@modkit/codec-kit'
import {
  listWizardEditPaths,
  locateWizardEditTarget,
  parseWizardDocument,
  type WizardDocument,
} from '../codecs/wizard/src/core/index.js'

const HOSTILE = `a"b'c<&>d`

export function editIsolationFailures(text: string, value = HOSTILE): { readonly targets: number; readonly failures: string[] } {
  const document = parseWizardDocument(text)
  const paths = listWizardEditPaths(document)
  const signature = JSON.stringify(paths)
  const slice = (source: string, parsed: WizardDocument, path: readonly string[]) => {
    const target = locateWizardEditTarget(parsed, path)
    return source.slice(target.start, target.end)
  }
  const original = paths.map(path => slice(text, document, path))
  const failures: string[] = []

  paths.forEach((path, index) => {
    const target = locateWizardEditTarget(document, path)
    const encoded = target.encoding.kind === 'attribute' ? encodeXmlAttribute(value, target.encoding.quote) : encodeXmlText(value)
    const edited = text.slice(0, target.start) + encoded + text.slice(target.end)
    const reparsed = parseWizardDocument(edited)
    const label = path.join('/')
    if (JSON.stringify(listWizardEditPaths(reparsed)) !== signature) {
      failures.push(`${label}: the set of editable targets changed`)
      return
    }
    paths.forEach((other, position) => {
      const now = slice(edited, reparsed, other)
      if (position === index) {
        if (decodeXmlEntities(now) !== value) failures.push(`${label}: reads back as ${JSON.stringify(decodeXmlEntities(now))}`)
      } else if (now !== original[position]) {
        failures.push(`${label}: also changed ${other.join('/')}`)
      }
    })
  })
  return { targets: paths.length, failures }
}
