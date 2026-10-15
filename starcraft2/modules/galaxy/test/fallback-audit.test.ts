import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import type { ArtifactByteSource } from '@modkit/sdk'
import {
  auditEngineFallbacks,
  auditGalaxyFallbacks,
  auditResolverFallbackCorpus,
  auditResolverFallbacks,
  auditTriggerFallbacks,
  compareScriptFallbackAudits,
  formatScriptFallbackAudit,
  type ScriptAuditContentPort,
  type ScriptFallbackDetectors,
} from '../services/auditing/fallback-audit.js'

/**
 * Stand-in probes. The subject here is the corpus walk — bounds, dependency diagnostics, and the
 * fact that routing happens *after* detection — not either codec's structural sniffer. Those live
 * with the codecs in the StarCraft II extension, which this package must not name.
 */
const DETECTORS: ScriptFallbackDetectors = {
  galaxy(_bytes, context) {
    const path = context.uri
    return {
      codecId: 'galaxy',
      confidence: path.endsWith('.galaxy') ? 0.9 : 0,
      evidence: [],
      requiredRanges: [],
    }
  },
  sc2Triggers(_bytes, context) {
    const path = context.uri
    return {
      codecId: 'sc2-triggers',
      confidence: path.endsWith('.galaxy') ? 0 : 0.9,
      evidence: [],
      requiredRanges: [],
    }
  },
}

function byteSource(text: string, uri: string): ArtifactByteSource {
  const bytes = new TextEncoder().encode(text)
  return {
    kind: 'bytes',
    ref: { id: uri, uri } as never,
    revision: 'content-hash.sha256:fallback-audit-fixture' as never,
    size: BigInt(bytes.byteLength),
    async read(offset, length, signal) {
      signal?.throwIfAborted()
      return bytes.slice(Number(offset), Number(offset) + length)
    },
    async *stream() { yield bytes },
  }
}

describe('script fallback audit', () => {
  it('sorts raw findings and preserves source evidence deterministically', () => {
    const report = auditEngineFallbacks('galaxy', 'Lib.galaxy', {
      kind: 'EngineProgram',
      modules: [
        {
          kind: 'EngineModule',
          id: 'Lib',
          functions: [
            {
              kind: 'EngineFunction',
              name: 'Run',
              body: [
                {
                  kind: 'EngineRawStatement',
                  language: 'galaxy',
                  code: 'unsupported();',
                  source: { format: 'galaxy', fileName: 'Lib.galaxy', elementId: '7' },
                },
              ],
            },
          ],
        },
      ],
    })

    expect(report.summary).toEqual({
      'unsupported-lowering': 1,
      'source-preserving-custom-script': 0,
    })
    expect(report.findings[0]).toMatchObject({
      functionName: 'Run',
      libraryId: 'Lib',
      evidence: { elementId: '7', fileName: 'Lib.galaxy' },
    })
    expect(formatScriptFallbackAudit(report)).toContain('Unsupported lowering: 1')
  })

  it('keeps malformed or empty source input distinct from lowering fallbacks', () => {
    expect(auditGalaxyFallbacks('void Run() {}').diagnostics).toEqual([])
    expect(auditTriggerFallbacks('<TriggerData><Library').diagnostics).toEqual([
      expect.objectContaining({ code: 'script-fallback-audit.library-missing' }),
    ])
  })

  it('reports comments as ignored non-executable evidence, not lowering fallbacks', () => {
    const uncommentedGalaxy = `
      void Run() {
        string value = "https://example.invalid/*not-comment*/";
      }
    `
    const galaxy = auditGalaxyFallbacks(`
      // A URL-looking string is executable data: "https://example.invalid/*not-comment*/".
      void Run() {
        string value = "https://example.invalid/*not-comment*/";
        /* A real block comment. */
      }
    `)
    const triggers = auditTriggerFallbacks(`
      <TriggerData>
        <!-- XML metadata comment. -->
        <Library Id="Test">
          <Element Id="Note" Type="Comment" />
        </Library>
      </TriggerData>
    `)

    expect(galaxy.nonExecutable).toEqual({ comments: 2 })
    expect(triggers.nonExecutable).toEqual({ comments: 2 })
    expect(galaxy.findings).toEqual(auditGalaxyFallbacks(uncommentedGalaxy).findings)
    expect(triggers.findings).toEqual([])
    expect(formatScriptFallbackAudit(galaxy)).toContain('Ignored comment/non-executable entries: 2')
  })

  it('decodes and groups source-preserving payload sentinel evidence', () => {
    const encoded = btoa(
      JSON.stringify({
        functionDef: { library: 'Ntve', id: 'ABC123', name: 'IfThenMultiple' },
      }),
    )
    const report = auditGalaxyFallbacks(
      `void Run() { Unknown("__MKX_SF__", 1, "Actions", "__MKX_FCJSON__:${encoded}"); }`,
    )

    expect(report.payloadSentinels).toEqual({
      transportTails: 1,
      jsonPayloads: 1,
      decodedJsonPayloads: 1,
      malformedJsonPayloads: 0,
      rootFunctionDefs: [
        {
          library: 'Ntve',
          id: 'ABC123',
          name: 'IfThenMultiple',
          count: 1,
        },
      ],
    })
  })

  it('retains focused fallback evidence for the two known foreach compatibility cases', () => {
    const report = auditEngineFallbacks('sc2-triggers', 'Triggers', {
      kind: 'EngineModule',
      id: 'Ntve',
      functions: ['ForEachValueInCatalogFieldArray', 'ForEachUnitInGroup2'].map(name => ({
        kind: 'EngineFunction',
        name,
        body: [
          {
            kind: 'EngineRawStatement',
            language: 'triggers',
            code: `${name} fallback`,
          },
        ],
      })),
    })

    expect(report.findings.map(finding => finding.functionName)).toEqual([
      'ForEachUnitInGroup2',
      'ForEachValueInCatalogFieldArray',
    ])
  })

  it('treats only new raw evidence as a baseline regression', () => {
    const baseline = auditEngineFallbacks('galaxy', 'Lib.galaxy', { kind: 'EngineProgram' })
    const candidate = auditEngineFallbacks('galaxy', 'Lib.galaxy', {
      kind: 'EngineRawExpression',
      language: 'galaxy',
      code: 'unlowered',
    })

    expect(compareScriptFallbackAudits(baseline, candidate)).toMatchObject({
      added: [expect.objectContaining({ code: 'unlowered' })],
      removed: [],
      regressions: [expect.objectContaining({ code: 'unlowered' })],
    })
  })

  it('keeps the checked-in public taxonomy baseline deterministic', async () => {
    const [program, baseline] = await Promise.all(
      ['fallback-taxonomy.engine.json', 'fallback-taxonomy.baseline.json'].map(async fileName =>
        JSON.parse(
          await readFile(new URL(`fixtures/${fileName}`, import.meta.url), {
            encoding: 'utf8',
          }),
        ),
      ),
    )
    const candidate = auditEngineFallbacks(
      'sc2-triggers',
      'synthetic/Triggers',
      program,
      undefined,
      { comments: 1 },
    )

    expect(candidate).toEqual(baseline)
    expect(compareScriptFallbackAudits(baseline, candidate).regressions).toEqual([])
  })

  it('reads explicitly addressed paths through the resolver in load order', async () => {
    const source = byteSource('void Run() {}', 'memory://base/Lib.galaxy')
    const resolver: ScriptAuditContentPort = {
      gameId: 'starcraft-2',
      async *resolveAll(request) {
        if (request.path === 'Lib.galaxy') yield { mountRole: 'base', path: 'Lib.galaxy', source }
      },
      async *list() {},
      async dependencies() {
        return []
      },
    }

    await expect(
      auditResolverFallbacks({ resolver, galaxyPaths: ['Lib.galaxy'] }),
    ).resolves.toEqual({
      reports: [expect.objectContaining({ codec: 'galaxy', source: 'Lib.galaxy' })],
      diagnostics: [],
    })
  })

  it('discovers a bounded mixed corpus and routes only after structural detection', async () => {
    const galaxySource = byteSource('void Run() {}', 'memory://base/Lib.galaxy')
    const triggerSource = byteSource(
      '<TriggerData><Library Id="Test"><Element Id="Run" Type="FunctionDef"><Identifier>Run</Identifier></Element></Library></TriggerData>',
      'memory://base/Triggers',
    )
    const resolver: ScriptAuditContentPort = {
      gameId: 'starcraft-2',
      async *resolveAll(request) {
        if (request.path === 'Lib.galaxy') {
          yield { mountRole: 'base', path: 'Lib.galaxy', source: galaxySource }
        }
        if (request.path === 'Triggers') {
          yield { mountRole: 'base', path: 'Triggers', source: triggerSource }
        }
      },
      async *list() {
        yield {
          name: 'Lib.galaxy',
          path: 'Lib.galaxy',
          kind: 'file',
          mountId: 'base',
        }
        yield {
          name: 'Triggers',
          path: 'Triggers',
          kind: 'file',
          mountId: 'base',
        }
      },
      async dependencies() {
        return [
          { id: 'Missing.SC2Mod', kind: 'mod', required: true, state: 'missing' },
          { id: 'Duplicate.SC2Mod', kind: 'mod', required: true, state: 'ambiguous' },
          { id: 'Cycle.SC2Mod', kind: 'mod', required: true, state: 'circular' },
        ]
      },
    }

    await expect(
      auditResolverFallbackCorpus({ resolver, detectors: DETECTORS }),
    ).resolves.toMatchObject({
      reports: [{ codec: 'galaxy' }, { codec: 'sc2-triggers' }],
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: 'script-fallback-audit.compiled-galaxy-dependency' }),
        expect.objectContaining({ code: 'script-fallback-audit.dependency-ambiguous' }),
        expect.objectContaining({ code: 'script-fallback-audit.dependency-circular' }),
        expect.objectContaining({ code: 'script-fallback-audit.dependency-missing' }),
      ]),
    })
    await expect(
      auditResolverFallbackCorpus({ resolver, detectors: DETECTORS, maxSources: 1 }),
    ).resolves.toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: 'script-fallback-audit.corpus-limit-reached' }),
      ]),
    })
  })
})
