/** Runtime source reads use the selected ModContext's identity and bounded byte port. */
import { expect, test, vi } from 'vitest'
import { readSc2RuntimeGalaxySource } from '../services/subject-composition.ts'

type SourceRequest = Parameters<typeof readSc2RuntimeGalaxySource>[0]
type Context = SourceRequest['context']
type Location = Awaited<ReturnType<Context['locate']>>
const text = 'void InitMap() {}'

/** Only the two consumed ModContext ports are replaced; package selection belongs to the loader. */
function sourceContext(
  bytes = new TextEncoder().encode(text),
  location: Location = { layerId: 'selected-map', path: 'MapScript.galaxy' },
) {
  const locate = vi.fn<Context['locate']>(async () => location)
  const read = vi.fn<Context['read']>(async () => bytes)
  return { context: { locate, read } as unknown as Context, locate, read }
}

test('a primary map reads its relative script without a nested-root requirement', async () => {
  const { context, locate, read } = sourceContext()
  const source = await readSc2RuntimeGalaxySource({
    context, path: 'MapScript.galaxy', functionName: 'InitMap',
  })
  expect(locate.mock.calls).toEqual([['MapScript.galaxy']])
  expect(read.mock.calls).toEqual([['selected-map', 'MapScript.galaxy', 1_048_577]])
  expect(source).toEqual({ text, fileName: 'MapScript.galaxy',
    functionName: 'InitMap', layerId: 'selected-map' })
})

test('explicitly omitted root uses the source spelling and layer returned by the context', async () => {
  const nativePath = 'TriggerLibs/NativeLib.galaxy'
  const { context, locate, read } = sourceContext(undefined,
    { layerId: 'core-dependency', path: nativePath })
  const source = await readSc2RuntimeGalaxySource({ context, nestedRoot: undefined,
    path: 'triggerlibs/nativelib.galaxy', functionName: 'InitMap' })
  expect(locate.mock.calls).toEqual([['triggerlibs/nativelib.galaxy']])
  expect(read.mock.calls).toEqual([['core-dependency', nativePath, 1_048_577]])
  expect(source.fileName).toBe(nativePath)
  expect(source.layerId).toBe('core-dependency')
})

test('an explicitly nested campaign map retains its prefix and resolved dependency layer', async () => {
  const root = 'Base.SC2Maps/Maps/Campaign/Selected.SC2Map'
  const nativePath = `${root}/MapScript.galaxy`
  const { context, locate, read } = sourceContext(undefined,
    { layerId: 'story-dependency', path: nativePath })
  const source = await readSc2RuntimeGalaxySource({ context,
    nestedRoot: { path: `${root}/`, parentLayerId: 'story-dependency' },
    path: 'MapScript.galaxy', functionName: 'InitMap' })
  expect(locate.mock.calls).toEqual([[nativePath]])
  expect(read.mock.calls).toEqual([['story-dependency', nativePath, 1_048_577]])
  expect(source.layerId).toBe('story-dependency')
  expect(source.fileName).toBe(nativePath)
})

test('an invalid explicit root is refused instead of falling back to the primary package', async () => {
  const { context, locate, read } = sourceContext()
  for (const nestedRoot of [null, {}, { path: '' }, { path: 1 }]) {
    await expect(readSc2RuntimeGalaxySource({ context, nestedRoot,
      path: 'MapScript.galaxy', functionName: 'InitMap' } as SourceRequest))
      .rejects.toThrow(TypeError)
  }
  expect(locate).not.toHaveBeenCalled()
  expect(read).not.toHaveBeenCalled()
})

test('invalid script paths and missing function names still refuse before context access', async () => {
  const { context, locate, read } = sourceContext()
  for (const path of ['', '/MapScript.galaxy', '../MapScript.galaxy',
    'folder/../MapScript.galaxy', 'folder\\MapScript.galaxy']) {
    await expect(readSc2RuntimeGalaxySource({ context, path, functionName: 'InitMap' }))
      .rejects.toThrow(TypeError)
  }
  await expect(readSc2RuntimeGalaxySource({ context,
    path: 'MapScript.galaxy', functionName: '' })).rejects.toThrow(TypeError)
  expect(locate).not.toHaveBeenCalled()
  expect(read).not.toHaveBeenCalled()
})

test('a missing primary script remains a typed refusal without another package lookup', async () => {
  const { context, locate, read } = sourceContext()
  locate.mockResolvedValue(undefined)
  await expect(readSc2RuntimeGalaxySource({ context,
    path: 'MapScript.galaxy', functionName: 'InitMap' }))
    .rejects.toMatchObject({ code: 'sc2-runtime/galaxy-source-missing' })
  expect(locate.mock.calls).toEqual([['MapScript.galaxy']])
  expect(read).not.toHaveBeenCalled()
})

test('a read failure retains its typed refusal and source diagnostic', async () => {
  const { context, read } = sourceContext()
  read.mockRejectedValue(new Error('selected source is unreadable'))
  await expect(readSc2RuntimeGalaxySource({ context,
    path: 'MapScript.galaxy', functionName: 'InitMap' })).rejects.toMatchObject({
      code: 'sc2-runtime/galaxy-source-unreadable',
      diagnostics: [{ message: 'selected source is unreadable' }],
    })
})

test('the byte limit admits exactly one MiB and refuses the extra-byte witness', async () => {
  const { context, read } = sourceContext(new Uint8Array(1_048_576).fill(97))
  const request = { context, path: 'MapScript.galaxy', functionName: 'InitMap' }
  expect((await readSc2RuntimeGalaxySource(request)).text.length).toBe(1_048_576)
  read.mockResolvedValue(new Uint8Array(1_048_577).fill(97))
  await expect(readSc2RuntimeGalaxySource(request))
    .rejects.toMatchObject({ code: 'sc2-runtime/galaxy-source-budget' })
  expect(read.mock.calls.every(call => call[2] === 1_048_577)).toBe(true)
})

test('UTF-8 BOM decoding is retained and malformed UTF-8 never becomes recovered source', async () => {
  const { context, read } = sourceContext(new TextEncoder().encode(`\uFEFF${text}`))
  const request = { context, path: 'MapScript.galaxy', functionName: 'InitMap' }
  expect((await readSc2RuntimeGalaxySource(request)).text).toBe(text)
  read.mockResolvedValue(Uint8Array.of(0xc3, 0x28))
  await expect(readSc2RuntimeGalaxySource(request))
    .rejects.toMatchObject({ code: 'sc2-runtime/galaxy-source-encoding' })
})
