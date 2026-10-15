import { readFile } from 'node:fs/promises'
import { createM3CollisionSplatFixture } from './m3-collision-splats.fixture.mjs'
import { M3SectionList } from '../../dist/m3/native/binary/sections.js'
import { serializeM3SectionGraph } from '../../dist/m3/native/structural.js'
export async function createM3BillboardFixture(flags = 0x100010) {
  const bytes = await createM3CollisionSplatFixture(),
    xml = await readFile(new URL('../../src/m3/native/structures.xml', import.meta.url), 'utf8'),
    sections = await M3SectionList.load(bytes.slice().buffer, xml),
    bones = sections.getSectionByReference(sections.model.bones)
  for (const bone of bones.content) bone.flags = 0
  bones.content[0].flags = flags
  return Uint8Array.from(serializeM3SectionGraph(sections))
}
