/**
 * The "Locked By BadName" header protection, as published SC2 mods have carried it for years.
 *
 * StormLib validates three header fields the game itself never reads — the declared header size,
 * the declared archive size and the format version — and it repairs them before checking the
 * header's own MD5. Randomising those fields and then storing the MD5 of the corrupted header
 * makes that repair fail (ERROR_FAKE_MPQ_HEADER), while every field the engine uses — the sector
 * size shift, the table offsets and their entry counts — is left exactly as it was.
 *
 * This protects a published archive from casual unpacking. It is not encryption: anything that
 * reads the functional fields, including Modkit's own reader, opens the archive unchanged.
 */
import { createHash, randomBytes } from 'node:crypto'

const MPQ_V4_HEADER_BYTES = 0xd0
const MAGIC = 0x1a51504d // 'MPQ\x1a'

/** True when these bytes begin with an MPQ v4 header long enough to protect. */
export function isProtectableMpq(bytes) {
  return bytes.length >= MPQ_V4_HEADER_BYTES &&
    Buffer.from(bytes.buffer, bytes.byteOffset, 4).readUInt32LE(0) === MAGIC
}

/**
 * Return a copy whose StormLib-validated header fields are junk and whose header MD5 matches that
 * junk. The archive's payload, tables and every functional field are untouched.
 */
export function protectMpqHeader(bytes) {
  if (!isProtectableMpq(bytes)) {
    throw new Error('Header protection needs an MPQ v4 archive (.SC2Map/.SC2Mod)')
  }
  const out = Buffer.from(bytes)
  // Declared header size, declared archive size and format version: ten bytes the engine ignores.
  randomBytes(10).copy(out, 4)
  // Two more bytes inside the v4 block that no reader depends on.
  randomBytes(2).copy(out, 104)
  // The header's own MD5, over the corrupted bytes, so a repaired header can never match it.
  createHash('md5').update(out.subarray(0, 0xc0)).digest().copy(out, 0xc0)
  return new Uint8Array(out)
}
