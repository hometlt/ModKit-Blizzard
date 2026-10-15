// Hand-ported inspection boundary for Galaxy programs intended for the SC2 runtime provider.
// Actual execution, simulation, snapshot and replay assistance require the future X3 runtime
// contribution contract; this codec only exposes the executable surface without pretending to run it.

import { createInspectionCodec, createTreeDataSource } from '@modkit/codec-kit'
import {
  plausibleGalaxy,
  scanGalaxy,
} from '../../../../shared/language/galaxy-analysis.js'
import {
  createTableDataSource,
  decodeStructuredText,
  lineCount,
} from '../../../../shared/inspection/structured-text.js'

const ID = 'blizzard/sc2-runtime'
const ascii = new TextDecoder('ascii', { fatal: false })

function runtimeEntrypoint(text) {
  const source = text.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\/\/.*$/gmu, '')
  return /\bvoid\s+main\s*\([^;{}]*\)\s*\{/u.test(source)
}

function nativeUsage(text, declaredFunctions) {
  const declared = new Set(declaredFunctions)
  const ignored = new Set(['if', 'for', 'while', 'switch', 'return'])
  const counts = new Map()
  const source = text.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\/\/.*$/gmu, '')
  for (const match of source.matchAll(/\b([A-Za-z_]\w*)\s*\(/gu)) {
    const name = match[1]
    if (declared.has(name) || ignored.has(name)) continue
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  return Object.freeze([...counts].sort(([left], [right]) => left.localeCompare(right)))
}

const definition = Object.freeze({
  id: ID,
  format: Object.freeze({
    id: 'sc2-runtime',
    label: 'StarCraft II Runtime Program',
    mediaType: 'text/x-galaxy',
  }),
  async detect(prefix, uri) {
    const text = ascii.decode(prefix)
    if (!plausibleGalaxy(text) || !runtimeEntrypoint(text)) {
      return { confidence: 0, kind: 'structure', note: 'runtime-main-entrypoint-missing' }
    }
    return {
      confidence: /\.galaxy$/iu.test(uri) ? 0.999 : 0.94,
      kind: 'structure',
      note: 'runtime-main-entrypoint',
    }
  },
  async inspect(bytes, context) {
    const text = decodeStructuredText(bytes, context.budget, 'SC2 runtime Galaxy')
    if (!runtimeEntrypoint(text))
      throw new TypeError('SC2 runtime program has no void main() entrypoint')
    const script = scanGalaxy(text, context.budget)
    const usage = nativeUsage(
      text,
      script.functions.map(value => value.name),
    )
    return {
      summary: {
        format: 'sc2-runtime',
        lines: lineCount(text),
        functions: script.functions.length,
        entrypoints: script.functions.map(value => value.name),
        includes: script.includes,
        nativeCalls: usage.length,
        nativeInvocations: usage.reduce((sum, [, count]) => sum + count, 0),
      },
      metadata: [
        {
          id: 'sc2-runtime-program',
          label: 'Runtime program',
          entries: [
            { key: 'entrypoints', value: script.functions.map(value => value.name) },
            { key: 'includes', value: script.includes },
            { key: 'nativeCalls', value: usage.length },
          ],
        },
      ],
      traits: [
        { id: 'content.text', parameters: { language: 'galaxy', lines: lineCount(text) } },
        { id: 'structure.hierarchy', parameters: { functions: script.functions.length } },
        { id: 'code.source', parameters: { language: 'galaxy', entrypoint: 'main' } },
      ],
      text: true,
      dataSources: {
        'common.view/table-data-source': createTableDataSource(
          ['Native', 'Invocations'],
          usage.map(([name, invocations]) => [name, invocations]),
        ),
        'common.view/tree-data-source': createTreeDataSource({
          kind: 'runtime-program',
          label: 'SC2 runtime program',
          preview: `${script.functions.length} function(s), ${usage.length} native(s)`,
          children: [
            ...script.functions.map(value => ({
              kind: value.name === 'main' ? 'entrypoint' : 'function',
              label: value.name,
              preview: `${value.parameters} parameter(s)`,
            })),
            ...usage.map(([name, invocations]) => ({
              kind: 'native',
              label: name,
              preview: `${invocations} invocation(s)`,
            })),
          ],
        }),
      },
      unsupportedFeatures: [
        'runtime-execution',
        'runtime-snapshot-and-restore',
        'catalog-backed-simulation',
        'replay-assistance',
        'trigger-xml-lowering',
        'host-native-bridging',
      ],
    }
  },
})

export const abiVersion = 1
export const createCodec = context => createInspectionCodec(definition, context)
