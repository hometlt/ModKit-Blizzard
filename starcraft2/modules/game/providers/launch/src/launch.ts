/**
 * StarCraft II launch: the SC2Switcher plan for a map (or a mod tested on a map) and the reading of
 * what the game writes to GameLogs afterwards. Pure — the host spawns the process, watches the
 * folder and asks `interpretSc2Log` about each new file.
 *
 * Arguments, defaults and the GameLogs formats are the MK2 launcher's (sc2-map/src/launch).
 */
import { win32 } from 'node:path'
import type {
  GameLaunchLogDiagnostic,
  GameLaunchLogReport,
  GameLaunchLogRequest,
  GameLaunchOptionSchema,
  GameLaunchPlan,
  GameLaunchPlanRequest,
} from '@modkit/sdk/games'

const GAME_ID = 'blizzard/starcraft-2'
const PLAN_ID = 'blizzard/starcraft2-native-map-defaults-v1'

/** The options a launch configuration may set, with MK2's defaults. */
export interface Sc2LaunchOptions {
  /** The map to run: the map to test a mod on, or another map than the one being launched. */
  readonly map?: string
  /** Open the in-game trigger debugger. */
  readonly triggerDebug?: boolean
  /** `-preload 1`; default on. */
  readonly preload?: boolean
  /** `-NoUserCheats`; default on. */
  readonly noUserCheats?: boolean
  /** `-reloadcheck`. */
  readonly reloadCheck?: boolean
  /** `-meleeMod`; default `Void`. */
  readonly meleeMod?: string
  /** `-difficulty`; default 2. */
  readonly difficulty?: number
  /** `-speed`; default 2. */
  readonly speed?: number
  /** `-testmod`: a mod to load over the map. A mod launch sets it to the mod itself. */
  readonly testMod?: string
  /** `-testconfig`: an absolute path. */
  readonly testConfig?: string
}

/**
 * The options a launch configuration may set — MK2's `launch.json` attributes with their defaults
 * and ranges. The launch-plan offer declares exactly this table (`launchOptions` in provider.json,
 * kept equal by test) for editors to offer and check; the planner checks requests against it too.
 */
export const SC2_LAUNCH_OPTIONS = {
  map: { type: 'string', path: true, description: 'The map to run: the map to test a mod on, or another map than the one being launched (-run).' },
  triggerDebug: { type: 'boolean', default: false, description: 'Open the in-game trigger debugger window on launch (-TrigDebug).' },
  preload: { type: 'boolean', default: true, description: 'Preload map assets before launching (-preload 1).' },
  noUserCheats: { type: 'boolean', default: true, description: 'Disable in-game cheat commands (-NoUserCheats).' },
  reloadCheck: { type: 'boolean', default: false, description: 'Enable reload checking (-reloadcheck).' },
  meleeMod: { type: 'string', default: 'Void', description: 'The mod melee games use, for example Void for Legacy of the Void (-meleeMod).' },
  difficulty: { type: 'integer', default: 2, minimum: 0, maximum: 3, description: 'AI difficulty: 0 Very Easy, 1 Easy, 2 Medium, 3 Hard (-difficulty).' },
  speed: { type: 'integer', default: 2, minimum: 0, maximum: 4, description: 'Game speed: 0 Slower, 1 Slow, 2 Normal, 3 Fast, 4 Faster (-speed).' },
  testMod: { type: 'string', path: true, description: 'A mod to load over the map (-testmod); launching a mod sets it to the mod itself.' },
  testConfig: { type: 'string', path: true, description: 'A .SC2TestConfig file (-testconfig).' },
} as const satisfies Readonly<Record<keyof Sc2LaunchOptions, GameLaunchOptionSchema>>

const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0

/** The launch configuration's options, refusing any the game does not know, of the wrong type or out of range. */
export function sc2LaunchOptions(value: GameLaunchPlanRequest['options']): Sc2LaunchOptions {
  const options: Record<string, unknown> = {}
  for (const [key, option] of Object.entries(value ?? {})) {
    const schema: GameLaunchOptionSchema | undefined = SC2_LAUNCH_OPTIONS[key as keyof Sc2LaunchOptions]
    if (schema === undefined) throw new TypeError(`StarCraft II launch has no option "${key}"`)
    if (option === null || option === '') continue
    const kind = schema.type === 'integer' ? 'number' : schema.type
    if (typeof option !== kind || (kind === 'number' && !Number.isFinite(option))) {
      throw new TypeError(`StarCraft II launch option "${key}" must be a ${kind}`)
    }
    if (schema.type === 'integer' && (!Number.isInteger(option) ||
      (schema.minimum !== undefined && (option as number) < schema.minimum) ||
      (schema.maximum !== undefined && (option as number) > schema.maximum))) {
      throw new TypeError(`StarCraft II launch option "${key}" must be an integer from ${schema.minimum} to ${schema.maximum}`)
    }
    const stored = kind === 'string' ? (option as string).trim() : option
    if (schema.path === true && !win32.isAbsolute(stored as string)) {
      throw new TypeError(`StarCraft II launch option "${key}" must be an absolute path`)
    }
    options[key] = stored
  }
  return options as Sc2LaunchOptions
}

/** SC2Switcher arguments for running `map` with these options (MK2 `buildLaunchArgs`). */
export function sc2LaunchArguments(map: string, options: Sc2LaunchOptions): string[] {
  const args = ['-run', map]
  if (options.preload ?? true) args.push('-preload', '1')
  if (options.noUserCheats ?? true) args.push('-NoUserCheats')
  args.push('-meleeMod', options.meleeMod ?? 'Void')
  args.push('-difficulty', String(options.difficulty ?? 2))
  args.push('-speed', String(options.speed ?? 2))
  args.push('-displaymode', options.triggerDebug === true ? '0' : '1')
  if (options.triggerDebug === true) args.push('-TrigDebug')
  if (options.reloadCheck === true) args.push('-reloadcheck')
  if (nonEmpty(options.testMod)) args.push('-testmod', options.testMod)
  if (nonEmpty(options.testConfig)) args.push('-testconfig', options.testConfig)
  return args
}

/** The plan for a map, or for a mod tested on the map its options name. */
export async function createStarcraft2LaunchPlan(request: GameLaunchPlanRequest): Promise<GameLaunchPlan> {
  request.signal?.throwIfAborted()
  if (request.gameId !== GAME_ID || request.installation?.gameId !== GAME_ID) {
    throw new TypeError(`StarCraft II launch planning cannot handle ${String(request.gameId)}`)
  }
  if (!nonEmpty(request.installation.normalizedPath) || !nonEmpty(request.resource?.path)) {
    throw new TypeError('StarCraft II launch planning requires an installation root and a resource path')
  }
  const kind = request.resource.kind
  if (kind !== 'map' && kind !== 'mod') {
    throw new TypeError(`StarCraft II launch planning cannot handle ${String(kind)}`)
  }
  const path = request.resource.path.trim()
  const options = sc2LaunchOptions(request.options)
  let args: string[]
  if (kind === 'mod') {
    if (!nonEmpty(options.map)) {
      throw new TypeError('testing a StarCraft II mod needs the map to run it on (launch option "map")')
    }
    args = sc2LaunchArguments(options.map, { ...options, testMod: path })
  } else {
    // A map launch runs the map itself; another `map` option would hide the resource.
    if (options.map !== undefined && options.map !== path) {
      throw new TypeError('a StarCraft II map launch runs the launched map; "map" is for testing a mod')
    }
    args = sc2LaunchArguments(path, options)
  }
  return Object.freeze({
    schemaVersion: 1,
    planId: PLAN_ID,
    gameId: GAME_ID,
    installationRoot: request.installation.normalizedPath,
    resource: Object.freeze({ kind, path }),
    executableRelativePath: 'Support64/SC2Switcher_x64.exe',
    workingDirectoryRelativePath: '.',
    arguments: Object.freeze(args),
    resourceArgumentIndex: args.lastIndexOf(path),
    mode: 'detached',
    stdio: 'ignore',
    runningProcessNames: Object.freeze(['SC2_x64.exe', 'SC2.exe']),
    logs: Object.freeze({
      base: 'user-documents',
      relativePath: 'StarCraft II/GameLogs',
      patterns: Object.freeze(['*ScriptError.txt', '*Alerts.txt']),
    }),
  })
}

/**
 * Compile errors of a ScriptError.txt, placed in the package's own files:
 * `Script compile error: scripts/foo.galaxy (42), message` with an optional `Script code:` line.
 */
export function parseSc2ScriptErrors(content: string, packagePath: string): GameLaunchLogDiagnostic[] {
  const pattern = /^Script compile error:\s+(.+?)\s+\((\d+)\),\s+(.+?)(?:\r?\n[ \t]+Script code:[ \t]*(.+))?$/gmu
  const results: GameLaunchLogDiagnostic[] = []
  for (const match of content.matchAll(pattern)) {
    const [, file, line, message, code] = match
    if (file === undefined || line === undefined || message === undefined) continue
    results.push(
      Object.freeze({
        severity: 'error' as const,
        code: 'blizzard/sc2-script-compile-error',
        message: code?.trim() ? `${message.trim()} — ${code.trim()}` : message.trim(),
        path: win32.isAbsolute(file) ? file : win32.join(packagePath, file),
        line: Math.max(0, Number.parseInt(line, 10) - 1),
      }),
    )
  }
  return results
}

/** `Script load failed:` lines of a ScriptError.txt. */
export function parseSc2ScriptLoadFailures(content: string): string[] {
  return content.match(/^Script load failed:.+$/gmu) ?? []
}

/** User alerts of an Alerts.txt, after its last `====` separator. */
export function parseSc2Alerts(content: string): string[] {
  const separator = content.lastIndexOf('====')
  const body = separator >= 0 ? content.slice(separator) : content
  const messages: string[] = []
  for (const match of body.matchAll(/^USER\s+\d+\s+[\d.]+\s+[\d.]+\s+(.+)$/gmu)) {
    const message = match[1]?.trim()
    if (message && !message.startsWith('=')) messages.push(message)
  }
  return messages
}

/** What one GameLogs file says about the run; a ScriptError.txt is the verdict. */
export async function interpretSc2Log(request: GameLaunchLogRequest): Promise<GameLaunchLogReport> {
  request.signal?.throwIfAborted()
  if (/ScriptError\.txt$/iu.test(request.fileName)) {
    const errors = parseSc2ScriptErrors(request.text, request.resource.path)
    const failures = parseSc2ScriptLoadFailures(request.text).map(line =>
      Object.freeze({ severity: 'error' as const, code: 'blizzard/sc2-script-load-failed', message: line }),
    )
    const diagnostics =
      errors.length + failures.length > 0
        ? [...errors, ...failures]
        : [
            Object.freeze({
              severity: 'error' as const,
              code: 'blizzard/sc2-script-error',
              message: `StarCraft II reported a script error; see ${request.fileName} in GameLogs`,
            }),
          ]
    return Object.freeze({ diagnostics: Object.freeze(diagnostics), final: true })
  }
  if (/Alerts\.txt$/iu.test(request.fileName)) {
    return Object.freeze({
      diagnostics: Object.freeze(
        // A warning, as MK2 showed it: an application drops information-level findings (6.16).
        parseSc2Alerts(request.text).map(message =>
          Object.freeze({ severity: 'warning' as const, code: 'blizzard/sc2-alert', message }),
        ),
      ),
      final: false,
    })
  }
  return Object.freeze({ diagnostics: Object.freeze([]), final: false })
}
