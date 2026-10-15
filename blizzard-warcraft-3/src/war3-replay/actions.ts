/**
 * Player actions inside a replay's command blocks, per the public description in
 * `references/w3g-format/w3g_actions.txt` (1.01, blue and nagger): action sizes of patch 1.15 and
 * later, the standardized APM, and the commands that name a unit, building, research or item by
 * its four-character id — which is a player's build order.
 *
 * An action id the description does not list (later patches added some) ends the decoding of that
 * command block: its remaining bytes are counted as undecoded, never guessed.
 */

/**
 * Action sizes including the id byte. The description's headlines for 0x11–0x14 count the ability
 * flags as the one byte they were before 1.13; its field lists (and the replays) have a word, so
 * each is one byte longer here than its headline.
 */
const FIXED: ReadonlyMap<number, number> = new Map([
  [0x01, 1], [0x02, 1], [0x03, 2], [0x04, 1], [0x05, 1], [0x07, 5],
  [0x10, 15], [0x11, 23], [0x12, 31], [0x13, 39], [0x14, 44],
  [0x18, 3], [0x19, 13], [0x1a, 1], [0x1b, 10], [0x1c, 10], [0x1d, 9], [0x1e, 6],
  [0x20, 1], [0x21, 9], [0x22, 1], [0x23, 1], [0x24, 1], [0x25, 1], [0x26, 1],
  [0x27, 6], [0x28, 6], [0x29, 1], [0x2a, 1], [0x2b, 1], [0x2c, 1], [0x2d, 6], [0x2e, 5],
  [0x2f, 1], [0x30, 1], [0x31, 1], [0x32, 1],
  [0x50, 6], [0x51, 10], [0x61, 1], [0x62, 13], [0x66, 1], [0x67, 1], [0x68, 13],
  [0x69, 17], [0x6a, 17], [0x75, 2],
])
/** Counted in the standardized APM (the description's `[APM+]`); 0x16 has its own rule below. */
const COUNTED = new Set([0x10, 0x11, 0x12, 0x13, 0x14, 0x17, 0x18, 0x1c, 0x1d, 0x1e, 0x61, 0x66, 0x67])
const KINDS: ReadonlyMap<number, string> = new Map([
  [0x01, 'pause'], [0x02, 'resume'], [0x06, 'save'],
  [0x10, 'ability'], [0x11, 'ability'], [0x12, 'ability'], [0x13, 'item'], [0x14, 'ability'],
  [0x16, 'selection'], [0x17, 'hotkey-assign'], [0x18, 'hotkey-select'], [0x19, 'subgroup'],
  [0x1c, 'ground-item'], [0x1d, 'cancel-revival'], [0x1e, 'dequeue'],
  [0x50, 'alliance'], [0x51, 'resources'], [0x60, 'trigger-chat'], [0x61, 'escape'],
  [0x62, 'trigger'], [0x6b, 'game-cache'], [0x66, 'skill-menu'], [0x67, 'build-menu'], [0x68, 'ping'],
])
/** Build orders are bounded: a long game issues thousands of such commands. */
const MAXIMUM_ORDERS = 400

export interface W3gOrder {
  readonly timeMs: number
  /** The four-character id of what was built, trained, researched, bought or learned. */
  readonly id: string
}

export interface W3gActionTally {
  /** Actions the standardized APM counts. */
  counted: number
  readonly kinds: Record<string, number>
  readonly orders: W3gOrder[]
  /** Command blocks whose actions could not all be decoded, and their undecoded bytes. */
  undecodedBlocks: number
  undecodedBytes: number
  /** The action ids decoding stopped at (`0x6b`…), and how often. */
  readonly unknownActions: Record<string, number>
}

export function emptyTally(): W3gActionTally {
  return { counted: 0, kinds: {}, orders: [], undecodedBlocks: 0, undecodedBytes: 0, unknownActions: {} }
}

/** Whether this version's action sizes are the ones listed (1.15 onwards). */
export const decodesActions = (version: number): boolean => version >= 15

/** A string-encoded id is four printable characters stored last-first; a numeric one ends 0D 00. */
function stringId(bytes: Uint8Array, at: number): string | undefined {
  const id = [bytes[at + 3]!, bytes[at + 2]!, bytes[at + 1]!, bytes[at]!]
  if (!id.every(value => value >= 0x20 && value < 0x7f)) return undefined
  return String.fromCharCode(...id)
}

/**
 * Decode one command block into `tally`. `pause` is told when the game was paused or resumed, so
 * the caller can take paused time out of the played time.
 */
export function tallyActions(
  block: Uint8Array,
  timeMs: number,
  tally: W3gActionTally,
  pause: (paused: boolean) => void,
): void {
  const view = new DataView(block.buffer, block.byteOffset, block.byteLength)
  let at = 0
  let deselected = false
  while (at < block.byteLength) {
    const id = block[at]!
    let size = FIXED.get(id)
    if (id === 0x16 || id === 0x17) size = at + 4 <= block.byteLength ? 4 + view.getUint16(at + 2, true) * 8 : undefined
    else if (id === 0x06 || id === 0x60) {
      const start = at + (id === 0x06 ? 1 : 9)
      const end = block.indexOf(0, start)
      size = end === -1 ? undefined : end + 1 - at
    } else if (id === 0x6b) {
      // A map's game-cache sync, which the description predates: three strings and a value.
      let end = at
      for (let field = 0; field < 3 && end !== -1; field += 1) end = block.indexOf(0, end + 1)
      size = end === -1 ? undefined : end + 1 + 4 - at
    }
    if (size === undefined || at + size > block.byteLength) {
      tally.undecodedBlocks += 1
      tally.undecodedBytes += block.byteLength - at
      const key = `0x${id.toString(16).padStart(2, '0')}`
      tally.unknownActions[key] = (tally.unknownActions[key] ?? 0) + 1
      return
    }
    const kind = KINDS.get(id) ?? 'other'
    tally.kinds[kind] = (tally.kinds[kind] ?? 0) + 1
    if (id === 0x01) pause(true)
    else if (id === 0x02) pause(false)
    // A select right after a deselect in the same block is the game's own pairing: one action.
    if (id === 0x16) {
      const deselect = block[at + 1] === 0x02
      if (deselect || !deselected) tally.counted += 1
      deselected = deselect
    } else {
      deselected = false
      if (COUNTED.has(id)) tally.counted += 1
    }
    if (id >= 0x10 && id <= 0x14 && tally.orders.length < MAXIMUM_ORDERS) {
      const order = stringId(block, at + 3)
      if (order !== undefined) tally.orders.push({ timeMs, id: order })
    }
    at += size
  }
}
