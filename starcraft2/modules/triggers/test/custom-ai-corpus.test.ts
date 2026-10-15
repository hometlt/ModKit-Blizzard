import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createContentSources } from '../../../dist/modules/game/battlenet/content-sources/local-content-sources.js'
import { readAIData, writeAIData, writeEditorLayout } from '../../../dist/modules/map/shared/format/formats/ai-data.js'
import { generateCustomAiMapScriptSection, generateCustomAiScript } from '../../../dist/modules/triggers/services/galaxy-conversion/internal/custom-ai-script.js'
import { recoverCustomAi } from '../../../dist/modules/triggers/services/galaxy-conversion/internal/custom-ai-recovery.js'

// Installed folder maps whose Custom AI the editor generated: the generator must write their ai<Id>.galaxy
// and the MapScript section byte for byte, and the recovery must read the document back from them.
const install = process.env.MODKITX_SC2_ROOT ?? 'C:/Apps/StarCraft II'
const enabled = process.env.MODKIT_TEST_INSTALLED_CORPUS !== '0' && existsSync(join(install, '.build.info'))

function folderMaps(directory: string, depth = 0): string[] {
  if (depth > 3 || !existsSync(directory)) return []
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (!entry.isDirectory()) return []
    const path = join(directory, entry.name)
    if (/\.sc2map$/iu.test(entry.name)) {
      const files = readdirSync(path)
      return files.includes('CustomAI') && files.some(file => /^ai[0-9A-F]{8}\.galaxy$/iu.test(file)) ? [path] : []
    }
    return folderMaps(path, depth + 1)
  })
}

const decode = (bytes: Uint8Array) => new TextDecoder('utf-8', { fatal: true }).decode(bytes)
// Color and RepeatShow are in no script; a TriggerRunAtEnd without a trigger leaves no Galaxy either.
const withoutEditorOnly = (xml: string) => xml.replace(/ Color="[^"]*"/gu, '').replace(/\r\n\s*<RepeatShow [^>]*\/>/gu, '')
  .replace(/(<Time Type="\w+") TriggerRunAtEnd="1">/gu, '$1>')

describe.skipIf(!enabled)('Custom AI of installed maps', () => {
  it('generates the editor\'s Galaxy from each CustomAI document and reads the document back', async () => {
    const maps = folderMaps(join(install, 'Maps'))
    expect(maps.length).toBeGreaterThan(0)
    const sources = await createContentSources({ installationDirectory: install })
    let checked = 0
    try {
      for (const map of maps) {
        const context = await sources.openModContext({ schemaVersion: 1, target: map })
        try {
          const layer = context.layers.at(-1)!
          const listed = (await context.files(layer.id, { limit: 10_000 })).items.map((item: any) => typeof item === 'string' ? item : item.path)
          const read = async (file: string) => decode(await context.read(layer.id, file, 64 * 1024 * 1024))
          const document = readAIData(await read('CustomAI'))
          const objectStrings = listed.includes('enUS.SC2Data/LocalizedData/ObjectStrings.txt') ? await read('enUS.SC2Data/LocalizedData/ObjectStrings.txt') : ''
          const script = await read('MapScript.galaxy')
          const files = await Promise.all(listed.filter((file: string) => /^ai[0-9A-F]{8}\.galaxy$/iu.test(file))
            .map(async (file: string) => ({ fileName: file, text: await read(file) })))
          // Trigger names come from the scripts themselves, in the order the generator asks for them.
          for (const definition of document.definitions) {
            const expected = files.find(file => file.fileName.toLowerCase() === `ai${definition.id}.galaxy`.toLowerCase())
            if (expected === undefined) continue
            const calls = [...expected.text.matchAll(/TriggerFind\("([^"]+)"\)/gu)].map(match => match[1])
            let next = 0
            const aiName = objectStrings.split(/\r?\n/u).map(line => line.replace(/^\W*(?=AI\/)/u, ''))
              .find(line => line.startsWith(`AI/Name/${definition.id}=`))?.slice(`AI/Name/${definition.id}=`.length) ?? ''
            expect(generateCustomAiScript(definition, { aiName: () => aiName, triggerFunction: () => calls[next++] }), `${map} ai${definition.id}`)
              .toBe(expected.text)
          }
          const players = [...script.slice(script.indexOf('void cai_startall'), script.indexOf('void cai_runall')).matchAll(/AICampaignStart\((\d+)\);/gu)].map(match => Number(match[1]))
          expect(script.includes(generateCustomAiMapScriptSection(document, { campaignPlayers: players })), map).toBe(true)
          // Every trigger reference of the source document, by the function the script calls for it; the
          // editor writes no call for a trigger the map does not have.
          const functionOf = new Map<string, string | undefined>()
          for (const definition of document.definitions) {
            const expected = files.find(file => file.fileName.toLowerCase() === `ai${definition.id}.galaxy`.toLowerCase())!
            const calls = [...expected.text.matchAll(/TriggerFind\("([^"]+)"\)/gu)].map(match => match[1]!)
            let next = 0
            generateCustomAiScript(definition, { aiName: () => '', triggerFunction: id => { functionOf.set(id, calls[next]); return calls[next++] } })
          }
          // What no script shows: a trigger the map lacks, a time with neither durations nor trigger, more
          // repeated waves than there are.
          for (const definition of document.definitions) {
            const waves = definition.steps.filter(step => step.type === 'Wave').length
            if ((definition.repeatWaves ?? 0) > waves) definition.repeatWaves = waves
            for (const step of definition.steps) {
              if (step.configTrigger !== undefined && functionOf.get(step.configTrigger) === undefined) delete step.configTrigger
              for (const time of step.times) if (time.trigger !== undefined && functionOf.get(time.trigger) === undefined) delete time.trigger
              step.times = step.times.filter(time => time.durations.length > 0 || time.trigger !== undefined)
              // The script lists points by type, so only the order within a type is kept.
              const order = ['Create', 'Gather', 'Waypoint', 'TargetPoint']
              step.points = [...step.points].sort((left, right) => order.indexOf(left.type) - order.indexOf(right.type))
            }
          }

          const recovered = recoverCustomAi(script, files)
          expect(recovered.state, map).toBe('recovered')
          if (recovered.state !== 'recovered') continue
          const byName = new Map([...recovered.value.triggerFunctions].map(([placeholder, name]) => [placeholder, name]))
          const names = (xml: string, lookup: (id: string) => string | undefined) => xml.replace(/(Trigger="|ConfigTrigger Value=")([^"]+)"/gu, (_, key, id) => `${key}${lookup(id)}"`)
          expect(withoutEditorOnly(names(writeAIData(recovered.value.document), id => byName.get(id)!)), map)
            .toBe(withoutEditorOnly(names(writeEditorLayout(document), id => functionOf.get(id))))
          checked++
        } finally {
          await context.dispose()
        }
      }
    } finally {
      await sources.dispose()
    }
    expect(checked).toBe(maps.length)
  }, 600_000)
})
