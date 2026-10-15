#!/usr/bin/env node
/* eslint-disable no-console -- CLI output is the command's public interface. */
/**
 * CLI: Конвертация Trigger XML → Galaxy script
 *
 * Usage:
 *   npx tsx packages/script-bridge/src/cli.ts <mod-path> [output-dir]
 *
 * Example:
 *   npx tsx packages/script-bridge/src/cli.ts testdata/vs-test.SC2Mod output/vs-test
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { resolve, join } from 'path'
import { readTriggerLibraries } from '@modkit/blizzard-starcraft2/triggers/document/index.js'
import { Printer } from '@modkit/blizzard-starcraft2/galaxy/language-core'
import { convertTriggerLibraryToGalaxyFull } from './internal/trigger-to-galaxy.js'

async function main() {
  const modPath = process.argv[2]
  const outputDir = process.argv[3] || 'output'

  if (!modPath) {
    console.error('Usage: npx tsx packages/script-bridge/src/cli.ts <mod-path> [output-dir]')
    process.exit(1)
  }

  const modRoot = resolve(modPath)
  const triggersPath = findTriggersFile(modRoot)
  if (!triggersPath) {
    console.error(`No Triggers file found in ${modRoot}`)
    process.exit(1)
  }

  const modStringsPath = findTriggerStrings(modRoot)

  const nativeLibPath = resolve(
    'assets/sc2-data-triggers/mods/core.sc2mod/base.sc2data/TriggerLibs/NativeLib.TriggerLib',
  )
  const nativeStringsPath = resolve(
    'assets/sc2-data-triggers/mods/core.sc2mod/enus.sc2data/LocalizedData/TriggerStrings.txt',
  )

  if (!existsSync(nativeLibPath)) {
    console.error(`NativeLib not found: ${nativeLibPath}`)
    process.exit(1)
  }

  const modXml = readFileSync(triggersPath, 'utf8')
  const nativeXml = readFileSync(nativeLibPath, 'utf8')

  // Extract library IDs from the mod XML before parsing (needed to key TriggerStrings correctly)
  const modLibIds = extractLibraryIds(modXml)

  const stringsMap = new Map<string, string>()
  if (existsSync(nativeStringsPath)) {
    stringsMap.set('Ntve', readFileSync(nativeStringsPath, 'utf8'))
  }
  if (modStringsPath) {
    const modStrings = readFileSync(modStringsPath, 'utf8')
    for (const id of modLibIds) {
      stringsMap.set(id, modStrings)
    }
  }

  console.log(`Mod: ${modRoot}`)
  console.log(`Triggers: ${triggersPath}`)
  console.log(`Libraries found in XML: ${modLibIds.join(', ')}`)

  const results = await readTriggerLibraries([nativeXml, modXml], stringsMap)
  const ntveLib = results.get('Ntve')!.library

  const outDir = resolve(outputDir)
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })

  const printer = new Printer()

  // Build allLibraries map for cross-library resolution
  const allLibraries = new Map<string, any>()
  for (const [id, res] of results) allLibraries.set(id, res.library)

  for (const [libId, analysis] of results) {
    if (libId === 'Ntve') continue

    const lib = analysis.library
    console.log(`\nConverting lib${libId} (${lib.name ?? libId})...`)

    const { script, header } = convertTriggerLibraryToGalaxyFull(lib, ntveLib, allLibraries)

    const scriptPath = join(outDir, `Lib${libId}.galaxy`)
    const headerPath = join(outDir, `Lib${libId}_h.galaxy`)
    writeFileSync(scriptPath, script, 'utf8')
    writeFileSync(headerPath, header, 'utf8')

    const lines = script.split('\n').length
    console.log(`  Written: Lib${libId}.galaxy (${lines} lines)`)
    console.log(`  Written: Lib${libId}_h.galaxy`)
  }
}

function extractLibraryIds(xmlContent: string): string[] {
  const ids: string[] = []
  for (const m of xmlContent.matchAll(/<Library\s+Id="([^"]+)"/g)) {
    ids.push(m[1])
  }
  return ids
}

function findTriggersFile(dir: string): string | undefined {
  for (const p of [
    join(dir, 'Triggers'),
    join(dir, 'Base.SC2Data', 'Triggers'),
    join(dir, 'base.sc2data', 'Triggers'),
  ]) {
    if (existsSync(p)) return p
  }
}

function findTriggerStrings(dir: string): string | undefined {
  for (const p of [
    join(dir, 'TriggerStrings.txt'),
    join(dir, 'enUS.SC2Data', 'LocalizedData', 'TriggerStrings.txt'),
    join(dir, 'enus.sc2data', 'LocalizedData', 'TriggerStrings.txt'),
    join(dir, 'LocalizedData', 'TriggerStrings.txt'),
  ]) {
    if (existsSync(p)) return p
  }
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
