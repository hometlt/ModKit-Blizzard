/**
 * Dependency TriggerData assembled from a mod context.
 *
 * The case that matters is Liberty over Core: both layers carry a `LibraryList.xml`, and the
 * editor loads both libraries. Resolving one path through the context would keep only Liberty's.
 */
import { describe, expect, it } from 'vitest'
import { readTriggerDeclarations, readTriggerDependencies } from '../services/workspace/mod-libraries.js'

const list = (external: string) =>
  `<?xml version="1.0" encoding="us-ascii"?>\n<TriggerData>\n    <library id="1" external="${external}" sharedExt="1"/>\n</TriggerData>\n`
const library = (id: string) => `<?xml version="1.0"?><TriggerData><Standard Id="${id}"/></TriggerData>`

/** A mod context over a path → text table, reading only what its layer lists. */
function context(layers: Record<string, Record<string, string>>, primary?: string) {
  const encoder = new TextEncoder()
  const ids = Object.keys(layers)
  return {
    layers: ids.map(id => ({ id, role: (id === primary ? 'primary' : 'dependency') as const })),
    async read(layerId: string, path: string, maxBytes: number) {
      const text = layers[layerId]?.[path]
      if (text === undefined) throw new Error(`${path} is not listed by ${layerId}`)
      const bytes = encoder.encode(text)
      if (bytes.byteLength > maxBytes) throw new RangeError(`${path} is too large`)
      return bytes
    },
    async files(layerId: string, page: { limit: number; prefix?: string }) {
      const prefix = (page.prefix ?? '').toLowerCase()
      return {
        items: Object.keys(layers[layerId] ?? {}).filter(file => file.toLowerCase().startsWith(prefix)),
      }
    },
    /** The last layer holding the path wins, as the context does. */
    async locate(path: string) {
      const layerId = [...ids].reverse().find(id => layers[id]?.[path] !== undefined)
      return layerId === undefined ? undefined : { layerId, path }
    },
  }
}

describe('dependency TriggerData from a mod context', () => {
  it('reads every layer’s library list, not just the last one that has it', async () => {
    const dependencies = await readTriggerDependencies(
      context({
        core: {
          'Base.SC2Data/TriggerLibs/LibraryList.xml': list('TriggerLibs/NativeLib'),
          'Base.SC2Data/TriggerLibs/NativeLib.TriggerLib': library('Ntve'),
          'enUS.SC2Data/LocalizedData/TriggerStrings.txt': 'Library/Name/Ntve=Built-In',
        },
        liberty: {
          'Base.SC2Data/TriggerLibs/LibraryList.xml': list('TriggerLibs/LibertyLib'),
          'Base.SC2Data/TriggerLibs/LibertyLib.SC2Lib': library('Lbty'),
        },
      }),
    )
    expect(dependencies.map(dependency => dependency.sourcePath)).toEqual([
      'Base.SC2Data/TriggerLibs/NativeLib.TriggerLib',
      'Base.SC2Data/TriggerLibs/LibertyLib.SC2Lib',
    ])
    expect(dependencies[0]?.triggerStrings).toBe('Library/Name/Ntve=Built-In')
    expect(dependencies[1]?.triggerStrings).toBeUndefined()
  })

  it('leaves the opened package’s own Triggers out: it is the subject, not a dependency', async () => {
    const dependencies = await readTriggerDependencies(
      context(
        {
          shared: { Triggers: library('Shrd') },
          mine: { Triggers: library('Mine') },
        },
        'mine',
      ),
    )
    expect(dependencies.map(dependency => dependency.triggerData)).toEqual([library('Shrd')])
  })

  // EditorTest.SC2Mod holds 17 libraries in one Triggers; its CAI2 uses CCUI and TIBW.
  it('gives the opened mod’s own Triggers back, marked as the same document, when its libraries are asked for', async () => {
    const dependencies = await readTriggerDependencies(
      context({ shared: { Triggers: library('Shrd') }, mine: { Triggers: library('Mine') } }, 'mine'),
      { ownLibraries: true },
    )
    expect(dependencies).toEqual([
      { triggerData: library('Shrd'), sourcePath: 'Triggers' },
      { triggerData: library('Mine'), sourcePath: 'Triggers', sameDocument: true },
    ])
  })

  it('takes an authored mod’s own Triggers and skips a library the layer does not hold', async () => {
    const dependencies = await readTriggerDependencies(
      context({
        mine: {
          Triggers: library('Mine'),
          'Base.SC2Data/TriggerLibs/LibraryList.xml': list('TriggerLibs/Missing'),
        },
        empty: {},
      }),
    )
    expect(dependencies).toEqual([{ triggerData: library('Mine'), sourcePath: 'Triggers' }])
  })
})

describe('Galaxy declarations from a mod context', () => {
  it('returns only transitive includes for Runtime, including names with .galaxy', async () => {
    const declarations = await readTriggerDeclarations(context({
      core: {
        'Base.SC2Data/TriggerLibs/NativeLib.galaxy':
          '// include "TriggerLibs/Missing"\ninclude "TriggerLibs/GameData/Used.galaxy"\nvoid NativeLib ();',
        'Base.SC2Data/TriggerLibs/GameData/Used.galaxy': 'void Used ();',
        'Base.SC2Data/TriggerLibs/GameData/Unused.galaxy': 'void Unused ();',
        'Base.SC2Data/TriggerLibs/natives.galaxy': 'native void NotIncluded ();',
      },
    }), { sources: ['include "TriggerLibs/NativeLib"'], scope: 'include-closure' })
    expect(declarations.map(item => item.fileName)).toEqual([
      'Base.SC2Data/TriggerLibs/NativeLib.galaxy',
      'Base.SC2Data/TriggerLibs/GameData/Used.galaxy',
    ])
    await expect(readTriggerDeclarations(context({ core: {} }),
      { sources: ['include "TriggerLibs/Missing"'], scope: 'include-closure' }))
      .rejects.toThrow('Galaxy include not found: TriggerLibs/Missing')
  })

  it('follows includes transitively and lets the last layer win one path', async () => {
    const declarations = await readTriggerDeclarations(
      context({
        core: {
          'Base.SC2Data/TriggerLibs/NativeLib_h.galaxy': 'native void Ntve ();',
          'Base.SC2Data/TriggerLibs/natives.galaxy': 'native int UnitCount ();',
          'Base.SC2Data/TriggerLibs/AI_h.galaxy': 'include "TriggerLibs/BaseAI"\nvoid ai ();',
          'Base.SC2Data/TriggerLibs/BaseAI.galaxy': 'void baseAi ();',
          'Base.SC2Data/TriggerLibs/GameData/UnitData.galaxy': 'const int c_core = 1;',
        },
        liberty: {
          'Base.SC2Data/LibLbty_h.galaxy': 'void libLbty ();',
          'Base.SC2Data/TriggerLibs/BaseAI.galaxy': 'void baseAiOverridden ();',
        },
      }),
      { sources: ['include "TriggerLibs/AI"\nvoid main ();'] },
    )
    expect(declarations.map(declaration => declaration.fileName)).toEqual([
      'Base.SC2Data/LibLbty_h.galaxy',
      'Base.SC2Data/TriggerLibs/AI_h.galaxy',
      'Base.SC2Data/TriggerLibs/BaseAI.galaxy',
      'Base.SC2Data/TriggerLibs/natives.galaxy',
      'Base.SC2Data/TriggerLibs/NativeLib_h.galaxy',
      'Base.SC2Data/TriggerLibs/GameData/*.galaxy',
    ])
    expect(declarations[2]?.text).toBe('void baseAiOverridden ();')
  })
})
