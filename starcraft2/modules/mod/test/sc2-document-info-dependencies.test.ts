import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createModkit } from '@modkit/host/node'
import { sc2TestExtensionRoot } from '../../../test/support/extension-root.js'
import { parseDocumentInfo, documentInfoDependencies } from '../codecs/document-metadata/core/document-info.js'

// The manifest proof must authorize the actual dependency writer, without injected evidence.
it('commits ordered DocumentInfo dependencies on its declared proof and preserves other nodes', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'sc2-info-dependencies-'))
  const path = join(scratch, 'Control.SC2Map', 'DocumentInfo')
  mkdirSync(join(scratch, 'Control.SC2Map'))
  const original = '<DocInfo><ModType><Value>Interface</Value></ModType><Dependencies><Value>file:Mods/Void.SC2Mod</Value></Dependencies><Custom><Value>A &amp; B</Value></Custom></DocInfo>'
  writeFileSync(path, original)
  const host = await createModkit({ extensions: [sc2TestExtensionRoot], roots: [scratch], writableRoots: [scratch] })
  const sessions: { dispose(): Promise<void> }[] = []
  try {
    const opened = await host.open(path)
    expect(opened.snapshot.state).toBe('opened')
    if (!opened.session || !opened.editing) throw Error('DocumentInfo did not open with editing')
    sessions.push(opened.session)
    const dependencies = ['file:Mods/Void.SC2Mod', 'file:Mods/Test.SC2Mod']
    const result = await opened.session.operations().invoke('replace-dependencies', { dependencies })
    if (result.state !== 'ok' || result.output.kind !== 'edit-plan') throw Error('dependency writer did not return a plan')
    const editing = opened.editing
    const prepared = await editing.coordinator.prepare(editing.planFromOperation(result.output), { grant: editing.grantSnapshot })
    expect(prepared.state, JSON.stringify(prepared, (_key, value) => typeof value === 'bigint' ? String(value) : value)).toBe('ready')
    if (prepared.state !== 'ready') throw Error('declared dependency proof did not authorize prepare')
    const committed = await editing.coordinator.commit(prepared.prepared, { grant: editing.grantSnapshot })
    expect(committed.state).toBe('committed')
    const parsed = parseDocumentInfo(readFileSync(path, 'utf8'))
    expect(documentInfoDependencies(parsed)).toEqual(dependencies)
    expect(parsed.root.children.filter(node => node.name !== 'Dependencies')).toEqual(
      parseDocumentInfo(original).root.children.filter(node => node.name !== 'Dependencies'),
    )
    const reopened = await host.open(path)
    if (!reopened.session) throw Error('saved DocumentInfo did not reopen')
    sessions.push(reopened.session)
    expect(await reopened.session.operations().invoke('inspect', {})).toMatchObject({ state: 'ok', output: { kind: 'json', value: { dependencies } } })
    await expect(reopened.session.operations().invoke('replace-dependencies', { dependencies: [1] })).rejects.toThrow('dependencies must contain only strings')
  } finally {
    for (const session of sessions) await session.dispose()
    await host.close()
    rmSync(scratch, { recursive: true, force: true })
  }
})



