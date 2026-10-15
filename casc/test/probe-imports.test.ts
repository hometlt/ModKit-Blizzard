import { expect, it, vi } from 'vitest'

const reader = vi.hoisted(() => {
  const open = vi.fn()
  return { open, module: vi.fn(() => ({ CascReader: { open } })) }
})
vi.mock('../src/casc/reader.js', reader.module)

it('creates and detects the CASC codec without loading root parsers or storage', async () => {
  const { createCodec, detectCascMarkers } = await import('../src/casc/codec.js')
  expect(createCodec()).toBeDefined()
  expect((await detectCascMarkers([])).confidence).toBe(0)
  expect((await detectCascMarkers([
    { path: '.build.info', kind: 'file' },
    { path: 'SC2Data/config', kind: 'directory' },
    { path: 'SC2Data/data', kind: 'directory' },
    { path: 'SC2Data/indices', kind: 'directory' },
  ])).confidence).toBeGreaterThan(0)
  expect(reader.module).not.toHaveBeenCalled()
})

it('loads the reader on inspection and releases the namespace if opening fails', async () => {
  const { createCodec } = await import('../src/casc/codec.js')
  const release = vi.fn()
  const failed = new Error('installation unavailable')
  reader.open.mockRejectedValueOnce(failed)
  const codec = createCodec()
  const input = {
    originKind: 'namespace' as const,
    root: { id: 'fixture:casc', uri: 'memory://casc' },
    openNamespace: async () => ({ value: {}, release }),
  }
  await expect(codec.open(input, 'inspect', {})).rejects.toBe(failed)
  expect(reader.module).toHaveBeenCalledTimes(1)
  expect(reader.open).toHaveBeenCalledTimes(1)
  expect(release).toHaveBeenCalledTimes(1)
})
