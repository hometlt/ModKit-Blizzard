// The worker side of `parseMndxInThread` (mndx.js): parse one MNDX root, answer with its index.
import { parentPort } from 'node:worker_threads'
import { MndxNameDb } from './mndx.js'

parentPort.once('message', rootBytes => {
  try {
    const index = MndxNameDb.parse(rootBytes).serialize()
    parentPort.postMessage({ index }, [index.buffer])
  } catch (error) {
    parentPort.postMessage({ error: error instanceof Error ? error.message : String(error) })
  }
})
