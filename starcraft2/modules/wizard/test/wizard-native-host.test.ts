/**
 * edit.field through the real host: plan, prepare, commit to disk, reopen.
 *
 * The codec only proposes bytes; this proves the proposal survives the host's commit path and that
 * the file on disk differs from the original in exactly the edited value — the property the writer
 * policy promises against SC2Editor's own re-serializing save.
 */
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createSubjectEditing } from '@modkit/host'
import { createFileEditingBackend, createModkit, openFileArtifactSource } from '@modkit/host/node'

const extension = resolve(import.meta.dirname, '../../..')
const fixture = resolve(import.meta.dirname, 'fixtures/editor-saved-export.BlizWiz')
const budget = { maxInputBytes: 4_000_000n, maxDepth: 64, maxNodes: 100_000, maxScalarBytes: 4_000_000, maxDiagnostics: 1_000 }
const grant = { id: 'sc2-wizard-edit-field', classes: ['read-source', 'write-source'] } as const
const show = (value: unknown) => JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? String(item) : item))

describe('SC2 data wizard edit.field through the native host', () => {
  let scratch = ''
  let path = ''
  let host: Awaited<ReturnType<typeof createModkit>>
  let backend: ReturnType<typeof createFileEditingBackend>
  const sessions: { dispose(): Promise<void> }[] = []

  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), 'sc2-wizard-edit-'))
    path = join(scratch, 'EditorWizards', 'Export.BlizWiz')
    mkdirSync(join(scratch, 'EditorWizards'))
    copyFileSync(fixture, path)
    host = await createModkit({ extensions: [extension], roots: [scratch] })
    backend = createFileEditingBackend({ roots: [scratch] })
  }, 60_000)

  afterAll(async () => {
    for (const session of sessions) await session.dispose()
    await backend?.dispose()
    await host?.close()
    rmSync(scratch, { recursive: true, force: true })
  })

  const open = async () => {
    const opened = await host.services.open({ source: await openFileArtifactSource(path), path, intent: 'full', grant, budget })
    if (opened.state !== 'opened') throw new Error(`wizard did not open: ${show(opened)}`)
    expect(opened.selected.contributionId).toBe('blizzard/sc2-wizard')
    sessions.push(opened.session)
    return opened
  }

  it('commits one value and leaves every other byte of the editor-saved file alone', async () => {
    const original = new Uint8Array(readFileSync(path))
    const opened = await open()
    const invocation = await opened.session.operations().invoke('edit-field', {
      path: ['wizard', 'MKTest_LoadedEntryControl', 'entry', '0', 'field', 'EditorSuffix', 'value'],
      value: 'Edited & ^Suffix^',
    })
    expect(invocation.state, show(invocation)).toBe('ok')
    if (invocation.state !== 'ok') throw new Error('edit.field did not run')

    const editing = createSubjectEditing({
      opened,
      grant,
      backendFor: () => backend,
      evidenceFor: () => ({
        roundTrip: 'byte-identical', preservesUnknownData: true,
        evidenceId: 'sc2-wizard-edit-field-host-fixture',
        corpusId: 'sc2-wizard-editor-saved-export',
        corpusDigest: `sha256:${createHash('sha256').update(original).digest('hex')}`,
        conformanceProfile: 'modkit/codec-contribution-v1',
        writer: {
          providerId: 'blizzard/sc2-wizard',
          providerVersion: '1.0.0',
          artifactDigest: host.services.inventory.extensions[0]?.contributions.find(
            item => item.manifest?.id === 'blizzard/sc2-wizard',
          )?.record?.artifactDigest,
          formatId: 'sc2-wizard',
          representationId: 'source',
        },
        optionsFingerprint: 'edit-field', inputClass: 'editor-saved-wizard',
        provenAt: '2026-09-16T00:00:00Z',
      }) as never,
    })
    const prepared = await editing.coordinator.prepare(editing.planFromOperation(invocation.output), { grant: editing.grantSnapshot })
    expect(prepared.state, show(prepared)).toBe('ready')
    if (prepared.state !== 'ready') throw new Error('edit.field did not prepare')
    expect((await editing.coordinator.commit(prepared.prepared, { grant: editing.grantSnapshot })).state).toBe('committed')

    const text = new TextDecoder().decode(original)
    const before = '<value>^Suffix^</value>\r\n            </field>\r\n        </entry>\r\n    </wizard>\r\n</wizardfile>'
    expect(text.endsWith(before)).toBe(true)
    const expected = text.slice(0, text.length - before.length) + before.replace('<value>^Suffix^</value>', '<value>Edited &amp; ^Suffix^</value>')
    expect(new TextDecoder().decode(readFileSync(path))).toBe(expected)

    const reopened = await open()
    const outline: any = await reopened.session.operations().invoke('outline', { wizardId: 'MKTest_LoadedEntryControl' })
    expect(outline.output.value[0].entries[0].fields[0]).toMatchObject({ id: 'EditorSuffix', value: { expression: 'Edited & ^Suffix^' } })
  }, 60_000)
})
