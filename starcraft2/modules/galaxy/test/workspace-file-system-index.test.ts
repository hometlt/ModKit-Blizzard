import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { GalaxyFileSystemIndex } from '../language/workspace/file-system-index.js'

const cleanup: string[] = []
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('Galaxy standalone filesystem index', () => {
  it('indexes deterministically and reports documents omitted by its bounds', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'modkit-galaxy-index-'))
    cleanup.push(directory)
    await writeFile(join(directory, 'b.galaxy'), 'int B = 2;\n')
    await writeFile(join(directory, 'a.galaxy'), 'int A = 1;\n')
    await writeFile(join(directory, 'ignored.txt'), 'int Ignored = 0;\n')
    const index = new GalaxyFileSystemIndex({ maximumFiles: 1 })

    await index.setRoots([pathToFileURL(directory).href])

    expect([...index.documents.keys()].map(uri => uri.slice(uri.lastIndexOf('/') + 1))).toEqual([
      'a.galaxy',
    ])
    expect(index.lazyFileCount).toBe(1)
  })

  it('refreshes changed and deleted workspace files without retaining stale text', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'modkit-galaxy-index-'))
    cleanup.push(directory)
    const path = join(directory, 'main.galaxy')
    const uri = pathToFileURL(path).href
    await writeFile(path, 'int Value = 1;\n')
    const index = new GalaxyFileSystemIndex()
    await index.setRoots([pathToFileURL(directory).href])

    await writeFile(path, 'int Value = 2;\n')
    await index.refresh(uri)
    expect(index.getDocument(uri)?.text).toContain('= 2')

    await unlink(path)
    await index.refresh(uri)
    expect(index.getDocument(uri)).toBeUndefined()
    expect(index.lazyFileCount).toBe(0)
  })

  it('keeps the spelling of a root opened through a junction and merges roots of one directory', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'modkit-galaxy-index-'))
    cleanup.push(parent)
    const directory = join(parent, 'real')
    const linked = join(parent, 'linked')
    await mkdir(directory)
    await symlink(directory, linked, 'junction')
    const uri = pathToFileURL(join(linked, 'main.galaxy')).href
    await writeFile(join(directory, 'main.galaxy'), 'int Value = 1;\n')
    const index = new GalaxyFileSystemIndex()
    await index.setRoots([pathToFileURL(linked).href, pathToFileURL(directory).href])

    const keys = [...index.documents.keys()]
    expect(keys).toHaveLength(1)
    expect(keys[0]).toMatch(/\/linked\/main\.galaxy$/u)
    await writeFile(join(directory, 'main.galaxy'), 'int Value = 2;\n')
    await index.refresh(uri)
    expect(index.getDocument(uri)?.text).toContain('= 2')
  })
})
