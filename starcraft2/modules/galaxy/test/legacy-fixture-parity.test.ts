import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  galaxyCompletion,
  galaxyDefinition,
  galaxyHover,
  galaxyReferences,
  galaxyRename,
  galaxySignatureHelp,
} from '../language/semantic-provider.js'

const fixture = async (...parts: string[]) =>
  readFile(resolve(import.meta.dirname, 'fixtures', 'legacy', ...parts), 'utf8')

const document = (uri: string, text: string) => ({ uri, languageId: 'galaxy', version: 1, text })

function positionAt(text: string, needle: string, delta = 0) {
  const offset = text.indexOf(needle) + delta
  const prefix = text.slice(0, offset)
  const lines = prefix.split('\n')
  return { line: lines.length - 1, character: lines.at(-1)?.length ?? 0 }
}

describe('pinned plaxtony/legacy semantic fixtures', () => {
  it('preserves hover and nested signature semantics on the old fixtures', async () => {
    const hoverText = await fixture('hover', 'hover.galaxy')
    const hoverDocument = document('file:///fixtures/hover.galaxy', hoverText)
    const hover = await galaxyHover({
      document: hoverDocument,
      workspaceDocuments: [hoverDocument],
      workspaceIncomplete: false,
      maxResults: 64,
      maxDocuments: 1,
      position: positionAt(hoverText, 'print_num(c_test)', 2),
    })
    expect(hover?.markdown).toContain('void print_num(int a)')
    const parameterHover = await galaxyHover({
      document: hoverDocument,
      workspaceDocuments: [hoverDocument],
      workspaceIncomplete: false,
      maxResults: 64,
      maxDocuments: 1,
      position: positionAt(hoverText, 'a = 2', 1),
    })
    expect(parameterHover?.markdown).toContain('int a')

    const signatureText = await fixture('signature', 'signature.galaxy')
    const signatureDocument = document('file:///fixtures/signature.galaxy', signatureText)
    const signature = await galaxySignatureHelp({
      document: signatureDocument,
      workspaceDocuments: [signatureDocument],
      workspaceIncomplete: false,
      maxResults: 64,
      maxDocuments: 1,
      position: positionAt(signatureText, 'randomize());', 'randomize('.length),
    })
    expect(signature?.signatures[0]?.label).toBe('int randomize()')
  })

  it('preserves cross-file definition and reference behavior on the old fixtures', async () => {
    const headerText = await fixture('definition', 'header.galaxy')
    const refsText = await fixture('definition', 'refs.galaxy')
    const header = document('file:///fixtures/header.galaxy', headerText)
    const refs = document('file:///fixtures/refs.galaxy', refsText)
    const request = {
      document: refs,
      workspaceDocuments: [refs, header],
      workspaceIncomplete: false,
      maxResults: 64,
      maxDocuments: 2,
      position: positionAt(refsText, 'aglob =', 2),
    }
    const definition = await galaxyDefinition(request)
    expect(definition.locations[0]?.uri).toBe(header.uri)
    expect(definition.locations[0]?.range.start).toEqual(positionAt(headerText, 'aglob'))

    const references = await galaxyReferences({ ...request, includeDeclaration: true })
    expect(references.locations.map(location => location.uri)).toEqual([header.uri, refs.uri])

    const localRequest = {
      ...request,
      position: positionAt(refsText, 'local = null', 2),
    }
    const localDefinition = await galaxyDefinition(localRequest)
    expect(localDefinition.locations[0]?.range.start).toEqual(positionAt(refsText, 'local;'))
    const localReferences = await galaxyReferences({
      ...localRequest,
      includeDeclaration: true,
    })
    expect(localReferences.locations).toHaveLength(2)
    const localRename = await galaxyRename({
      ...localRequest,
      newName: 'selectedUnit',
      maxEdits: 8,
    })
    expect(localRename?.documentChanges[0]?.edits).toHaveLength(2)

    const completions = await galaxyCompletion(localRequest)
    expect(completions.items).toEqual(
      expect.arrayContaining([expect.objectContaining({ label: 'local', kind: 'variable' })]),
    )
  })
})
