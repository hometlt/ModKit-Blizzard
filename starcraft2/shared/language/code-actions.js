/** @param {string} text */
function endPosition(text) {
  const lines = text.split('\n')
  const last = lines.at(-1) ?? ''
  return { line: lines.length - 1, character: last.length }
}

/**
 * Source-preserving formatting shared by authored SC2 text formats: only an explicitly requested
 * final-newline state may change, in the document's own line-ending style. This is not a formatter
 * of the markup itself and must not be advertised as one.
 * @param {import('@modkit/sdk/language').LanguageFormattingRequest} request
 * @returns {Promise<import('@modkit/sdk/language').LanguageTextEditList>}
 */
export async function finalNewlineFormatting(request) {
  request.signal?.throwIfAborted()
  const desired = request.options.finalNewline
  const text = request.document.text
  if (desired === undefined || desired === /(?:\r?\n)$/u.test(text)) {
    return { edits: [], isComplete: true }
  }
  const end = endPosition(text)
  if (desired) {
    return {
      edits: [{ range: { start: end, end }, newText: text.includes('\r\n') ? '\r\n' : '\n' }],
      isComplete: true,
    }
  }
  const start = endPosition(text.replace(/(?:\r?\n)+$/u, ''))
  return { edits: [{ range: { start, end }, newText: '' }], isComplete: true }
}

/**
 * Safe source action shared by authored SC2 text formats.
 * @param {import('@modkit/sdk/language').LanguageCodeActionsRequest} request
 * @returns {import('@modkit/sdk/language').LanguageCodeActionList}
 */
export async function finalNewlineCodeActions(request) {
  request.signal?.throwIfAborted()
  const text = request.document.text
  if (/(?:\r?\n)$/u.test(text)) return { actions: [], isIncomplete: false }
  const position = endPosition(text)
  const newline = text.includes('\r\n') ? '\r\n' : '\n'
  return {
    actions: [
      {
        title: 'Add final newline',
        kind: 'source',
        edit: {
          isComplete: true,
          documentChanges: [
            {
              uri: request.document.uri,
              documentVersion: request.document.version,
              edits: [{ range: { start: position, end: position }, newText: newline }],
            },
          ],
        },
      },
    ],
    isIncomplete: false,
  }
}
