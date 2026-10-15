import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, test } from 'vitest'

const execute = promisify(execFile)
const workspace = resolve(import.meta.dirname, '../../..')

test('real CLI exports M3 to source-free UVM, writes canonical native M3 and renders through shared scene', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'modkit-m3-cli-scene-'))
  const cli = join(workspace, 'modkit-core/apps/cli/dist/main.js')
  const native = await readFile(
    join(workspace, 'modkit-extensions-blizzard/models/test/fixtures/m3/model.m3'),
  )
  const source = join(directory, 'model.m3')
  try {
    await writeFile(source, native)
    const run = async (
      command: string,
      file: string,
      operation: string,
      input: unknown,
      output: string,
    ) => {
      const request = join(directory, 'request.json')
      await writeFile(request, JSON.stringify(input))
      const result = await execute(
        process.execPath,
        [
          cli,
          'run',
          command,
          file,
          '--ext',
          join(workspace, 'modkit-extensions-blizzard/models'),
          '--ext',
          join(workspace, 'modkit-core/extensions/models'),
          '--operation',
          operation,
          '--input',
          request,
          '--out',
          output,
          '--trust',
          '--format',
          'protocol-json',
        ],
        { timeout: 60_000, maxBuffer: 2 << 20 },
      ).catch((error: unknown) => {
        if (error !== null && typeof error === 'object' && 'stdout' in error && typeof error.stdout === 'string')
          throw new Error(`CLI ${operation} failed: ${error.stdout}`, { cause: error })
        throw error
      })
      const receipt: unknown = JSON.parse(result.stdout)
      expect(receipt).toMatchObject({
        result: { state: 'ok', data: { via: operation, wroteTo: output } },
      })
      return readFile(output)
    }
    const uvmPath = join(directory, 'model.uvm.glb')
    const uvm = await run(
      'subject.convert',
      source,
      'model.export-uvm',
      { schemaVersion: 1, metersPerSourceUnit: 1 },
      uvmPath,
    )
    expect(uvm.subarray(0, 4).toString()).toBe('glTF')
    // An explicit wrong operation cannot fall back to export.raw or execute model.write as preview.
    for (const [command, operation] of [
      ['subject.convert', 'missing.export'],
      ['subject.preview', 'model.write'],
    ]) {
      let refused = false
      try {
        await execute(
          process.execPath,
          [
            cli,
            'run',
            command ?? '',
            source,
            '--ext',
            join(workspace, 'modkit-extensions-blizzard/models'),
            '--operation',
            operation ?? '',
            '--trust',
            '--format',
            'protocol-json',
          ],
          { timeout: 60_000 },
        )
      } catch (error) {
        if (
          error === null ||
          typeof error !== 'object' ||
          !('stdout' in error) ||
          typeof error.stdout !== 'string'
        )
          throw error
        const receipt: unknown = JSON.parse(error.stdout)
        expect(receipt).toMatchObject({ result: { state: 'unavailable' } })
        refused = true
      }
      expect(refused).toBe(true)
    }
    const copyPath = join(directory, 'copy.m3')
    const written = await run(
      'subject.convert',
      source,
      'model.write',
      { schemaVersion: 1, uvmBytesHex: uvm.toString('hex') },
      copyPath,
    )
    expect(written.subarray(0, 4).toString()).toBe('43DM')
    const input = {
      schemaVersion: 1,
      viewport: { width: 32, height: 32 },
      camera: { viewProjection: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] },
    }
    const m3Png = await run(
      'subject.preview',
      source,
      'model.render',
      { ...input, metersPerSourceUnit: 1 },
      join(directory, 'm3.png'),
    )
    const copyPng = await run(
      'subject.preview',
      copyPath,
      'model.render',
      { ...input, metersPerSourceUnit: 1 },
      join(directory, 'copy.png'),
    )
    const uvmPng = await run(
      'subject.preview',
      uvmPath,
      'model.render',
      input,
      join(directory, 'uvm.png'),
    )
    expect(m3Png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    expect(copyPng).toEqual(m3Png)
    expect(uvmPng).toEqual(m3Png)
    expect(await readFile(source)).toEqual(native)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 180_000)
