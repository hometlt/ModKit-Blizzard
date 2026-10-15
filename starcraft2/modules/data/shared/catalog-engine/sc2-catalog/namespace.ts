import type { TypedNamespace } from './types.js'

/**
 * Create a TypedNamespace proxy over a resolver function.
 * Property access (ns.Marine) and method access (ns.get('Marine')) both call resolver.
 * The ids set determines namespace.size and iteration.
 */
export function createTypedNamespace<T>(
  ids: ReadonlySet<string>,
  resolve: (id: string) => T | undefined,
): TypedNamespace<T> {
  const methods = {
    get(id: string): T | undefined {
      return resolve(id)
    },
    all(): T[] {
      const result: T[] = []
      for (const id of ids) {
        const value = resolve(id)
        if (value !== undefined) result.push(value)
      }
      return result
    },
    find(fn: (entity: T) => boolean): T[] {
      return methods.all().filter(fn)
    },
    keys(): IterableIterator<string> {
      return ids.values()
    },
    *values(): IterableIterator<T> {
      for (const id of ids) {
        const value = resolve(id)
        if (value !== undefined) yield value
      }
    },
    get size(): number {
      return ids.size
    },
  }

  return new Proxy(methods as unknown as TypedNamespace<T>, {
    get(target, prop: string | symbol) {
      if (typeof prop === 'symbol') return undefined
      if (prop in methods) return (methods as Record<string, unknown>)[prop]
      return resolve(prop)
    },
  })
}
