import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createCodec } from '../../../dist/modules/triggers/codecs/triggers/src/codec.js'
import { parseTriggerXmlSync } from '../../../dist/modules/triggers/shared/trigger-document/sax-reader.js'
import { scanTriggerSource } from '../../../dist/modules/triggers/shared/trigger-document/source-index.js'

// Owner decision 2026-09-25: the tib-data mod, and maps that depend on it, are not a test corpus.
const mapPath = fileURLToPath(new URL('../../../../../artifacts/test-mods-vovan/originals/Ice Baneling Escape Arctic Adventures.SC2Map/Triggers', import.meta.url))
const modPath = 'C:/Apps/StarCraft II/Mods/all-races-pvp-2/AllRaces2-Extension.SC2Mod/Triggers'
const nativePath = 'C:/FILES/SC2Files/Mods/Builtin/mods/core.sc2mod/base.sc2data/triggerlibs/nativelib.triggerlib'
const expected = Object.freeze({
  [mapPath]: Object.freeze({
    bytes: 2_957_528,
    sha256: 'd674d43a0c2f71015f54e674057f07546c749b8359ebc7d94063001e8d449ee0',
    elements: 13_233,
    references: 29_357,
  }),
  [modPath]: Object.freeze({
    bytes: 489_175,
    sha256: '6d9729bb1d8d284abb93b59efdcc65d9b330688ae4fe2e54d316565582c8466b',
    elements: 1_862,
    references: 4_314,
  }),
  [nativePath]: Object.freeze({
    bytes: 7_743_650,
    sha256: 'cbb2302825dce57ff9bb8efd44f9b0ed5cb056eee00265e5b711b0824d872396',
    elements: 31_613,
    references: 57_423,
  }),
})
const budget = {
  maxInputBytes: 32n * 1024n * 1024n,
  maxDepth: 64,
  maxNodes: 100_000,
  maxScalarBytes: 32 * 1024 * 1024,
  maxDiagnostics: 1_000,
}

function input(bytes: Uint8Array, uri: string) {
  const digest = createHash('sha256').update(bytes).digest('hex')
  const revision = `content-hash.sha256:${digest}`
  const ref = { id: uri, uri }
  const source = {
    kind: 'bytes' as const,
    ref,
    revision,
    size: BigInt(bytes.length),
    async read(offset: bigint, length: number) {
      return bytes.slice(Number(offset), Number(offset) + length)
    },
    async *stream() {
      yield bytes
    },
  }
  return {
    originKind: 'single' as const,
    bindings: [{
      sourceKind: 'candidate' as const,
      bindingId: 'content',
      role: 'content',
      ownership: 'owned' as const,
      source: ref,
      revision,
    }],
    primaryBindingId: 'content',
    revisions: {
      topology: 'single' as const,
      revision,
      bindings: [{ bindingId: 'content', revision }],
      compositionFingerprint: digest,
    },
    bindingsFor: () => [],
    async openBinding() {
      return { value: source, release: async () => {} }
    },
  }
}

describe('SC2 TriggerData frozen real and synthetic M5 corpus', () => {
  const corpus = new Map([
    [mapPath, readFileSync(mapPath)],
    [modPath, readFileSync(modPath)],
    [nativePath, readFileSync(nativePath)],
  ])

  it('executes the exact frozen bytes and source-index counts for every real bucket', () => {
    for (const [path, bytes] of corpus) {
      const frozen = expected[path]!
      expect(bytes.length, path).toBe(frozen.bytes)
      expect(createHash('sha256').update(bytes).digest('hex'), path).toBe(frozen.sha256)
      const index = scanTriggerSource(bytes.toString('utf8'), { sourcePath: path })
      expect(index.elements.length, path).toBe(frozen.elements)
      expect(index.references.length, path).toBe(frozen.references)
    }
    expect([...parseTriggerXmlSync(corpus.get(nativePath)!.toString('utf8')).keys()]).toEqual(['Ntve'])
    expect([...parseTriggerXmlSync(corpus.get(modPath)!.toString('utf8')).keys()]).toEqual(['ARMP'])
  })

  it('opens the implicit map library and an explicit mod library through the compiled adapter', async () => {
    for (const [path, expectedLibraries] of [[mapPath, 1], [modPath, 1]] as const) {
      const bytes = corpus.get(path)!
      const session = await createCodec().open(input(bytes, path) as never, 'full', budget)
      try {
        const inspected = await session.operations().invoke('inspect', {})
        expect(inspected).toMatchObject({
          state: 'ok',
          output: { kind: 'json', value: { elements: expected[path]!.elements } },
        })
        if (inspected.state === 'ok' && inspected.output.kind === 'json') {
          expect((inspected.output.value as any).libraries).toHaveLength(expectedLibraries)
        }
        const lease = await session.dataSource('common.view/byte-range-source', 1)
        try {
          expect(await lease.value.read(0n, 64)).toEqual(new Uint8Array(bytes.subarray(0, 64)))
        } finally {
          await lease.release()
        }
      } finally {
        await session.dispose()
      }
    }
  })

  it('runs real NativeLib lowering and an exact byte no-op beside a synthetic document', async () => {
    const mapBytes = corpus.get(mapPath)!
    const nativeText = corpus.get(nativePath)!.toString('utf8')
    const session = await createCodec().open(input(mapBytes, mapPath) as never, 'full', budget)
    try {
      const engine = await session.operations().invoke('to-engine', {
        dependencyLibraries: [{ triggerData: nativeText }],
        includeRawFallbacks: true,
      })
      expect(engine).toMatchObject({
        state: 'ok',
        output: { kind: 'json', value: { program: { kind: 'EngineProgram', modules: [
          expect.objectContaining({ id: 'Map' }),
        ] } } },
      })
      const noOp = await session.operations().invoke('rename-gamelinks', {
        renames: [{ catalog: 'Unit', oldId: '__absent__', newId: '__still_absent__' }],
      })
      expect(noOp.state).toBe('ok')
      if (noOp.state === 'ok' && noOp.output.kind === 'edit-plan') {
        const payload = noOp.output.plan.edits[0]?.payload
        expect(payload?.kind).toBe('inline')
        if (payload?.kind === 'inline') expect(payload.bytes).toEqual(new Uint8Array(mapBytes))
      }
    } finally {
      await session.dispose()
    }

    const synthetic = new TextEncoder().encode(
      '<TriggerData><Standard Id="Synthetic"/><Element Type="Variable" Id="V"><Identifier>Value</Identifier><VariableType><Type Value="int"/></VariableType></Element></TriggerData>',
    )
    const syntheticSession = await createCodec().open(
      input(synthetic, 'memory://Synthetic.SC2Mod/Triggers') as never,
      'full',
      budget,
    )
    try {
      expect(await syntheticSession.operations().invoke('symbols', {})).toMatchObject({
        state: 'ok',
        output: { kind: 'json', value: [expect.objectContaining({ id: 'V', name: 'Value' })] },
      })
    } finally {
      await syntheticSession.dispose()
    }
  })
})
