// The worker side of `createBlteDecodePool` (blte-pool.js): decode BLTE streams off the main thread.
import { parentPort } from 'node:worker_threads'

import { loadInflateSync } from '@modkit/codec-kit/compression/inflate'

import { decodeBlte } from './blte.js'

const inflateZlib = await loadInflateSync('zlib')

parentPort.on('message', ({ id, bytes, maxOutputBytes }) => {
  try {
    let decoded = decodeBlte(bytes, { maxOutputBytes, inflateZlib })
    if (decoded.byteOffset !== 0 || decoded.byteLength !== decoded.buffer.byteLength) {
      decoded = decoded.slice()
    }
    parentPort.postMessage({ id, decoded }, [decoded.buffer])
  } catch (error) {
    parentPort.postMessage({ id, error: error instanceof Error ? error.message : String(error) })
  }
})
