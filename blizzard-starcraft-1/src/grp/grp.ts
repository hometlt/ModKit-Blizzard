/**
 * StarCraft GRP (`unit\**\*.grp`, `tileset\<era>.grp`, cursors, icons): indexed frames of one
 * sprite on a shared canvas. A u16 frame count, the canvas width and height, then per frame its
 * place on the canvas (x, y, width, height as bytes) and the offset of its pixels.
 *
 * A frame's pixels are a table of `height` u16 line offsets (from the frame's offset), each line
 * run-length coded: a byte with 0x80 set skips `n & 0x7f` transparent pixels, one with 0x40 set
 * repeats the next byte `n & 0x3f` times, any other copies the next `n` bytes. The dialog and icon
 * GRPs of the interface store their frames uncoded, `width × height` bytes each. Index 0 is
 * transparent either way.
 */

export interface GrpFrame {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly offset: number
}

export interface Grp {
  readonly width: number
  readonly height: number
  readonly frames: readonly GrpFrame[]
  /** Whether the frames are run-length coded (units, sprites) or plain (interface dialogs). */
  readonly coded: boolean
}

const HEADER_BYTES = 6
const FRAME_BYTES = 8

export function readGrp(bytes: Uint8Array): Grp {
  if (bytes.byteLength < HEADER_BYTES) throw new RangeError('a GRP starts with a 6-byte header')
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const count = data.getUint16(0, true)
  const width = data.getUint16(2, true)
  const height = data.getUint16(4, true)
  if (count === 0 || width === 0 || height === 0) throw new RangeError('a GRP has at least one frame on a canvas of some size')
  if (HEADER_BYTES + count * FRAME_BYTES > bytes.byteLength) throw new RangeError(`the GRP names ${String(count)} frames, more than the file holds`)
  const frames = Array.from({ length: count }, (_, index) => {
    const at = HEADER_BYTES + index * FRAME_BYTES
    const frame = { x: bytes[at]!, y: bytes[at + 1]!, width: bytes[at + 2]!, height: bytes[at + 3]!, offset: data.getUint32(at + 4, true) }
    if (frame.x + frame.width > width || frame.y + frame.height > height)
      throw new RangeError(`GRP frame ${String(index)} lies outside its ${String(width)} × ${String(height)} canvas`)
    if (frame.offset > bytes.byteLength) throw new RangeError(`GRP frame ${String(index)} starts past the end of the file`)
    return frame
  })
  return { width, height, frames, coded: isCoded(bytes, data, frames) }
}

/**
 * A coded frame's first line starts right after its line table; a plain frame's bytes are pixels.
 * Frames of one file are stored one way, so the first frame with lines decides.
 */
function isCoded(bytes: Uint8Array, data: DataView, frames: readonly GrpFrame[]): boolean {
  const frame = frames.find(item => item.width > 0 && item.height > 0)
  if (frame === undefined) return true
  if (frame.offset + 2 * frame.height > bytes.byteLength) return false
  // ponytail: a plain frame whose first two pixels spell exactly 2 × height reads as coded; the
  // interface GRPs that are plain do not start so. Take the format from the file's use if one does.
  return data.getUint16(frame.offset, true) === 2 * frame.height
}

/** The frame's palette indices on the whole canvas, row 0 at the top; 0 where nothing is drawn. */
export function decodeGrpFrame(bytes: Uint8Array, grp: Grp, index: number): Uint8Array {
  const frame = grp.frames[index]
  if (frame === undefined) throw new RangeError(`the GRP has no frame ${String(index)}`)
  const canvas = new Uint8Array(grp.width * grp.height)
  if (!grp.coded) {
    const end = frame.offset + frame.width * frame.height
    if (end > bytes.byteLength) throw new RangeError(`GRP frame ${String(index)} ends past the file`)
    for (let row = 0; row < frame.height; row += 1)
      canvas.set(bytes.subarray(frame.offset + row * frame.width, frame.offset + (row + 1) * frame.width), (frame.y + row) * grp.width + frame.x)
    return canvas
  }
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let row = 0; row < frame.height; row += 1) {
    let at = frame.offset + data.getUint16(frame.offset + 2 * row, true)
    const line = (frame.y + row) * grp.width + frame.x
    for (let column = 0; column < frame.width; ) {
      if (at >= bytes.byteLength) throw new RangeError(`GRP frame ${String(index)} line ${String(row)} runs past the file`)
      const control = bytes[at++]!
      if (control & 0x80) {
        column += control & 0x7f
      } else if (control & 0x40) {
        const count = Math.min(control & 0x3f, frame.width - column)
        canvas.fill(bytes[at++] ?? 0, line + column, line + column + count)
        column += control & 0x3f
      } else {
        const count = Math.min(control, frame.width - column)
        if (at + control > bytes.byteLength) throw new RangeError(`GRP frame ${String(index)} line ${String(row)} runs past the file`)
        canvas.set(bytes.subarray(at, at + count), line + column)
        at += control
        column += control
      }
    }
  }
  return canvas
}
