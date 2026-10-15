/**
 * Scenario triggers (TRIG) and mission briefings (MBRF): 2400 bytes a trigger — 16 conditions of
 * 20 bytes, 64 actions of 32 bytes, 4 bytes of execution flags and 28 bytes naming the player groups
 * that run it. A slot whose type is 0 is empty; bit 1 of a slot's flags disables it.
 *
 * Condition: location u32, player group u32, amount u32, unit u16, comparison u8, type u8,
 * resource/score/switch u8, flags u8, 2 bytes unused.
 * Action: location u32, string u32, sound string u32, time (ms) u32, player group u32, second group /
 * number u32, unit / score / resource / switch u16, type u8, modifier u8, flags u8, 3 bytes unused.
 */

export interface TriggerCondition {
  readonly type: number
  readonly location: number
  readonly group: number
  readonly amount: number
  readonly unit: number
  readonly comparison: number
  readonly resource: number
  readonly disabled: boolean
}

export interface TriggerAction {
  readonly type: number
  readonly location: number
  readonly string: number
  readonly sound: number
  readonly time: number
  readonly group: number
  readonly number: number
  readonly unit: number
  readonly modifier: number
  readonly disabled: boolean
}

export interface Trigger {
  readonly index: number
  readonly conditions: readonly TriggerCondition[]
  readonly actions: readonly TriggerAction[]
  /** Player groups (indices of GROUPS) the trigger runs for. */
  readonly players: readonly number[]
}

export const TRIGGER_BYTES = 2400
const CONDITIONS = 16
const CONDITION_BYTES = 20
const ACTIONS = 64
const ACTION_BYTES = 32
const PLAYERS_AT = CONDITIONS * CONDITION_BYTES + ACTIONS * ACTION_BYTES + 4
const DISABLED = 0x02

export const CONDITION_NAMES: readonly string[] = Object.freeze([
  'No Condition', 'Countdown Timer', 'Command', 'Bring', 'Accumulate', 'Kill', 'Command the Most', 'Commands the Most At',
  'Most Kills', 'Highest Score', 'Most Resources', 'Switch', 'Elapsed Time', 'Mission Briefing', 'Opponents', 'Deaths',
  'Command the Least', 'Command the Least At', 'Least Kills', 'Lowest Score', 'Least Resources', 'Score', 'Always', 'Never',
])

export const ACTION_NAMES: readonly string[] = Object.freeze([
  'No Action', 'Victory', 'Defeat', 'Preserve Trigger', 'Wait', 'Pause Game', 'Unpause Game', 'Transmission', 'Play WAV',
  'Display Text Message', 'Center View', 'Create Unit with Properties', 'Set Mission Objectives', 'Set Switch',
  'Set Countdown Timer', 'Run AI Script', 'Run AI Script At Location', 'Leader Board (Control)',
  'Leader Board (Control At Location)', 'Leader Board (Resources)', 'Leader Board (Kills)', 'Leader Board (Points)',
  'Kill Unit', 'Kill Unit At Location', 'Remove Unit', 'Remove Unit At Location', 'Set Resources', 'Set Score',
  'Minimap Ping', 'Talking Portrait', 'Mute Unit Speech', 'Unmute Unit Speech', 'Leaderboard Computer Players',
  'Leaderboard Goal (Control)', 'Leaderboard Goal (Control At Location)', 'Leaderboard Goal (Resources)',
  'Leaderboard Goal (Kills)', 'Leaderboard Goal (Points)', 'Move Location', 'Move Unit', 'Leaderboard (Greed)',
  'Set Next Scenario', 'Set Doodad State', 'Set Invincibility', 'Create Unit', 'Set Deaths', 'Order', 'Comment',
  'Give Units to Player', 'Modify Unit Hit Points', 'Modify Unit Energy', 'Modify Unit Shield Points',
  'Modify Unit Resource Amount', 'Modify Unit Hangar Count', 'Pause Timer', 'Unpause Timer', 'Draw',
  'Set Alliance Status', 'Disable Debug Mode', 'Enable Debug Mode',
])

/** The player groups a condition, an action or a trigger's execution names. */
export const GROUPS: readonly string[] = Object.freeze([
  ...Array.from({ length: 12 }, (_, index) => `Player ${String(index + 1)}`),
  'None', 'Current Player', 'Foes', 'Allies', 'Neutral Players', 'All Players',
  'Force 1', 'Force 2', 'Force 3', 'Force 4',
  'Unused 1', 'Unused 2', 'Unused 3', 'Unused 4', 'Non Allied Victory Players',
])

export const COMPARISONS: Readonly<Record<number, string>> = Object.freeze({ 0: 'at least', 1: 'at most', 2: 'set', 3: 'cleared', 10: 'exactly' })

export function readTriggers(section: Uint8Array | undefined): Trigger[] {
  if (section === undefined) return []
  const data = new DataView(section.buffer, section.byteOffset, section.byteLength)
  const triggers: Trigger[] = []
  for (let index = 0; (index + 1) * TRIGGER_BYTES <= section.byteLength; index += 1) {
    const base = index * TRIGGER_BYTES
    const conditions: TriggerCondition[] = []
    for (let slot = 0; slot < CONDITIONS; slot += 1) {
      const at = base + slot * CONDITION_BYTES
      const type = data.getUint8(at + 15)
      if (type === 0) continue
      conditions.push({
        type,
        location: data.getUint32(at, true),
        group: data.getUint32(at + 4, true),
        amount: data.getUint32(at + 8, true),
        unit: data.getUint16(at + 12, true),
        comparison: data.getUint8(at + 14),
        resource: data.getUint8(at + 16),
        disabled: (data.getUint8(at + 17) & DISABLED) !== 0,
      })
    }
    const actions: TriggerAction[] = []
    for (let slot = 0; slot < ACTIONS; slot += 1) {
      const at = base + CONDITIONS * CONDITION_BYTES + slot * ACTION_BYTES
      const type = data.getUint8(at + 26)
      if (type === 0) continue
      actions.push({
        type,
        location: data.getUint32(at, true),
        string: data.getUint32(at + 4, true),
        sound: data.getUint32(at + 8, true),
        time: data.getUint32(at + 12, true),
        group: data.getUint32(at + 16, true),
        number: data.getUint32(at + 20, true),
        unit: data.getUint16(at + 24, true),
        modifier: data.getUint8(at + 27),
        disabled: (data.getUint8(at + 28) & DISABLED) !== 0,
      })
    }
    const players: number[] = []
    for (let group = 0; group < 27; group += 1) if (data.getUint8(base + PLAYERS_AT + group) !== 0) players.push(group)
    triggers.push({ index, conditions, actions, players })
  }
  return triggers
}
