// Variable specifiers, so a browser bundle does not try to resolve them.
const NODE_WORKER_THREADS = 'node:worker_threads'
const NODE_OS = 'node:os'

/** A stream this small decodes faster in place than it crosses to a thread and back. */
export const BLTE_IN_PLACE_BYTES = 64 * 1024

/**
 * Threads a storage on Node's main thread decodes with: there a text search decoding every file
 * stalls the whole extension host (12 s of zlib, BLTE and buffers for one SC2 search). Elsewhere,
 * or without worker threads, 0 — decode in place.
 */
export async function defaultBlteDecodeThreads() {
  try {
    const threads = await import(NODE_WORKER_THREADS)
    if (threads.isMainThread !== true) return 0
    const { availableParallelism } = await import(NODE_OS)
    return Math.max(0, Math.min(4, availableParallelism() - 1))
  } catch {
    return 0
  }
}

/**
 * A pool of `blte-thread.js` workers. `decode` answers the decoded bytes, owning their buffer, or
 * rejects with the thread's error. A worker holds the process open only while it has work.
 */
export async function createBlteDecodePool(size) {
  const { Worker } = await import(NODE_WORKER_THREADS)
  const workers = []
  let nextId = 0
  let turn = 0
  for (let index = 0; index < size; index++) {
    const worker = new Worker(new URL('./blte-thread.js', import.meta.url))
    const pending = new Map()
    const settle = () => (pending.size === 0 ? worker.unref() : worker.ref())
    worker.on('message', ({ id, decoded, error }) => {
      const task = pending.get(id)
      if (task === undefined) return
      pending.delete(id)
      settle()
      if (error === undefined) task.resolve(decoded)
      else task.reject(new Error(error))
    })
    const failAll = error => {
      for (const task of pending.values()) task.reject(error)
      pending.clear()
    }
    worker.on('error', failAll)
    worker.on('exit', code => failAll(new Error(`BLTE decode thread exited with code ${code}`)))
    worker.unref()
    workers.push({ worker, pending, settle })
  }
  return Object.freeze({
    decode(bytes, maxOutputBytes) {
      const { worker, pending, settle } = workers[turn++ % workers.length]
      return new Promise((resolve, reject) => {
        const id = nextId++
        pending.set(id, { resolve, reject })
        settle()
        const copy = bytes.slice()
        worker.postMessage({ id, bytes: copy, maxOutputBytes }, [copy.buffer])
      })
    },
    async close() {
      await Promise.all(workers.map(({ worker }) => worker.terminate()))
    },
  })
}
