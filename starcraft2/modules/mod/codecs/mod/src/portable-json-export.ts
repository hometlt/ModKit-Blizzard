import type { SC2Mod } from '../../../shared/core/index.js'
import type { JsonMod, JsonModEntity } from '../../../shared/json-mod.js'

export interface JsonModExportOptions {
  readonly namespaces?: string[]
  readonly name?: string
  readonly mode?: 'raw' | 'full'
  readonly deps?: string[]
}

/** Browser-safe projection of the pinned JSON-mod serializer. */
export function exportJsonMod(mod: SC2Mod, options: JsonModExportOptions = {}): JsonMod {
  const { mode = 'raw', namespaces, name, deps = [] } = options
  const namespaceList = (namespaces ?? mod.namespaces()).filter(namespace => mod.all(namespace).length > 0)
  const entries: JsonMod['entries'] = {}
  for (const namespace of namespaceList) {
    const baseClass = `C${namespace}`
    const namespaceEntries: Record<string, JsonModEntity> = {}
    for (const raw of mod.all(namespace)) {
      const entity = raw as Readonly<{
        id: string
        class: string
        parent?: string
        data: Readonly<Record<string, unknown>>
      }>
      const fields = mode === 'full'
        ? (mod.getResolved(namespace, entity.id) as Readonly<Record<string, unknown>> | undefined) ?? {}
        : entity.data
      const output: Record<string, unknown> = { ...fields }
      if (entity.class !== baseClass) output['class'] = entity.class
      if (mode === 'raw' && entity.parent !== undefined) output['parent'] = entity.parent
      namespaceEntries[entity.id] = output as JsonModEntity
    }
    entries[namespace] = namespaceEntries
  }
  return {
    manifest: name === undefined ? { format: 'modkit-json-mod@1' } : { format: 'modkit-json-mod@1', name },
    deps,
    entries,
  }
}
