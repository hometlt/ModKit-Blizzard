// Exports the StarCraft II command card icons the StarMine Minecraft mod draws (contract: docs/SC2_EXPORT.md
// of hometlt/minecraft) from an installed StarCraft II:
//   pnpm --dir starcraft2 exec tsx ../scripts/export-starmine-icons.mjs --starmine <StarMine checkout>
//     [--out <assets dir, default <StarMine>/sc2-assets>] [--sc2 <SC2 root>] [--size 64]
// The buttons are the ones the mod's table names (src/main/java/dev/starmine/race/Sc2Buttons.java: the
// string literals after `->` or inside `{…}` arrays). Which file each button shows is decided by
// starcraft2/modules/mod/shared/export/command-icons.ts from the resolved Data of VoidMulti, read through
// the SC2 mod loader (ContentSources.openModContext). DDS → PNG goes through Modkit's image codec (the
// core CLI `subject.convert --target png` with extensions/images; MODKIT_CORE, default ../modkit-core),
// then the host's ffmpeg (FFMPEG or PATH) scales it to --size pixels. Writes
// <out>/assets/starmine/textures/gui/sc2/command/<button lower case>.png and
// <out>/assets/starmine/sc2-command-icons.json (replacing earlier icons), then prints what has no icon.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { commandIconName, commandIconsJson, planCommandIcons, readCommandIcon } from '../starcraft2/modules/mod/shared/export/command-icons.ts'
import { Sc2DesktopContentSources } from '../starcraft2/modules/game/battlenet/content-sources/local-content-sources.ts'

const option = name => {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}
const starmine = option('--starmine')
if (!starmine) throw new Error('usage: export-starmine-icons.mjs --starmine <StarMine checkout> [--out <dir>] [--size 64]')
const out = resolve(option('--out') ?? join(starmine, 'sc2-assets'))
const sc2 = option('--sc2') ?? process.env.MODKITX_SC2_ROOT ?? 'F:/GAMES/Blizzard/StarCraft II'
const size = Number(option('--size') ?? 64)
const ffmpeg = process.env.FFMPEG ?? 'ffmpeg'
const core = resolve(process.env.MODKIT_CORE ?? join(import.meta.dirname, '../../modkit-core'))

// The buttons the mod names, read the way the table's comment says.
const table = readFileSync(join(starmine, 'src/main/java/dev/starmine/race/Sc2Buttons.java'), 'utf8')
const buttons = [...new Set([...table.matchAll(/(?:->|[{,])\s*"([A-Za-z][A-Za-z0-9]*)"/gu)].map(match => match[1]))]

const scratch = mkdtempSync(join(process.env.MODKIT_TEMP ?? 'C:/MKTEMP', 'starmine-icons-'))
const sources = new Sc2DesktopContentSources({ installationDirectory: sc2,
  documentsDirectory: scratch, battleNetCacheDirectory: scratch, sc2MapsCacheDirectory: scratch })
const context = await sources.openModContext({ schemaVersion: 1, target: { sourceId: 'local:casc', path: 'Mods/VoidMulti.SC2Mod' } })
try {
  console.log(`${buttons.length} buttons`)
  const plan = await planCommandIcons(context, buttons)
  const root = join(out, 'assets/starmine')
  const folder = join(root, 'textures/gui/sc2/command')
  rmSync(folder, { recursive: true, force: true })
  mkdirSync(folder, { recursive: true })
  const failed = []
  for (const icon of plan.icons) {
    const dds = join(scratch, `${commandIconName(icon.button)}.dds`), png = join(scratch, `${commandIconName(icon.button)}.png`)
    try {
      writeFileSync(dds, await readCommandIcon(context, icon))
      execFileSync('node', [join(core, 'apps/cli/dist/main.js'), 'run', 'subject.convert', dds, '--ext', join(core, 'extensions/images'),
        '--target', 'png', '--out', png, '--format', 'text'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      execFileSync(ffmpeg, ['-v', 'error', '-y', '-i', png, '-vf', `scale=${size}:${size}:flags=lanczos,format=rgba`, join(folder, `${commandIconName(icon.button)}.png`)])
    } catch (error) {
      failed.push(icon.button)
      console.warn(`warning: ${icon.button} (${icon.icon}): ${String(error?.message ?? error).slice(0, 300)}`)
    }
  }
  const written = { icons: plan.icons.filter(icon => !failed.includes(icon.button)) }
  writeFileSync(join(root, 'sc2-command-icons.json'), JSON.stringify(commandIconsJson(written), null, '\t') + '\n')
  console.log(`${written.icons.length} icons; ${plan.missing.length + failed.length} buttons without one:`)
  for (const { button, reason } of plan.missing) console.log(`  ${button}: ${reason}`)
  for (const button of failed) console.log(`  ${button}: conversion failed`)
} finally {
  await context.dispose?.()
  rmSync(scratch, { recursive: true, force: true })
}
process.exit(0)
