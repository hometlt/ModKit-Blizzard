/** A saved prefix yields to neighbouring requests without exposing a partial or changed Data model. */
import { describe, expect, it } from 'vitest'
import { serialize } from 'node:v8'
import { openStarcraft2DataSession } from '../../../data/services/catalog/data-session.js'
import { storeCatalogDocument } from '../../../data/services/catalog/catalog-analysis.js'
import { encodeDataCacheRecord, decodeDataCacheRecord } from '../../shared/workspace/data-cache-record.js'
import type { ChainPrefixRecord } from '../../shared/workspace/chain-data.js'

/** Enough distinct small documents to exercise bounded turns without wall-time assertions. */
const recordOf = async (count = 48): Promise<ChainPrefixRecord> => {
  const catalogs = Array.from({ length: count }, (_, at) => ({ rootId: `root:${at}`,
    path: `Mods/Test${at}.SC2Mod/Base.SC2Data/GameData/UnitData.xml`, revision: String(at),
    text: `<Catalog><CUnit id="Unit${at}"><LifeMax value="45.00"/><FlagArray index="Turnable" value="1"/></CUnit></Catalog>` }))
  const session = openStarcraft2DataSession(catalogs, { workspaceId: 'cache-turns' })
  await session.prepare()
  return { catalogs, editorCategories: [], bytes: catalogs.reduce((sum, doc) => sum + Buffer.byteLength(doc.text), 0), parses: [...session.parsedDocuments()] }
}

/** Tests retain emitted bytes for damage/round-trip checks; production streams them into writeFile. */
const encodedBytes = async (key: string, record: ChainPrefixRecord): Promise<Buffer> => {
  const frames: Buffer[] = []
  for await (const frame of encodeDataCacheRecord(key, record)) frames.push(frame)
  return Buffer.concat(frames)
}

/** Observe real event-loop admission rather than accepting a resolved promise as a yield. */
const admitsNeighbour = async <T>(run: () => Promise<T>): Promise<T> => {
  let finished = false
  let neighbourBeforeFinish = false
  const neighbour = new Promise<void>(resolve => setImmediate(() => { neighbourBeforeFinish = !finished; resolve() }))
  const pending = run().then(result => { finished = true; return result })
  await neighbour
  expect(neighbourBeforeFinish).toBe(true)
  return pending
}

describe('bounded-turn Data cache records', () => {
  it.each(['encode', 'decode'])('admits neighbours during %s and round trips complete native facts', async phase => {
    const record = await recordOf()
    // Warm module imports before observing whether CPU work itself yields.
    await decodeDataCacheRecord(await encodedBytes('warm', await recordOf(0)), 'warm')
    const bytes = phase === 'encode'
      ? await admitsNeighbour(() => encodedBytes('key', record))
      : await encodedBytes('key', record)
    const decoded = phase === 'decode'
      ? await admitsNeighbour(() => decodeDataCacheRecord(bytes, 'key'))
      : await decodeDataCacheRecord(bytes, 'key')
    expect(decoded).toEqual(record)
    const parsed = decoded.parses[0]![1].parsed
    expect(storeCatalogDocument(parsed).patches[0]!.input.element).toBe(parsed.elements[0]!.children![0])
    expect(parsed.patches[0]!.fieldLexemes).toEqual({ LifeMax: '45.00' })
  })

  it.each(['old-envelope', 'wrong-key', 'short-header', 'invalid-length', 'truncated-frame', 'trailing-data'])(
    'refuses %s instead of returning partial parses', async damage => {
      const bytes = await encodedBytes('key', await recordOf(2))
      let damaged = Buffer.from(bytes)
      if (damage === 'old-envelope') damaged = serialize({ key: 'key', parseFormat: 1, record: {} })
      if (damage === 'short-header') damaged = damaged.subarray(0, 10)
      if (damage === 'invalid-length') damaged.writeUInt32LE(0xffffffff, 8)
      if (damage === 'truncated-frame') damaged = damaged.subarray(0, damaged.length - 1)
      if (damage === 'trailing-data') damaged = Buffer.concat([damaged, Buffer.from([1])])
      await expect(decodeDataCacheRecord(damaged, damage === 'wrong-key' ? 'other' : 'key')).rejects.toThrow()
    },
  )
})
