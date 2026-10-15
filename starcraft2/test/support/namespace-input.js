export function createNamespaceInput(files, options = {}) {
  const entries = new Map(Object.entries(files))
  const directories = new Set()
  for (const path of entries.keys()) {
    const parts = path.split('/')
    for (let index = 1; index < parts.length; index += 1) {
      directories.add(parts.slice(0, index).join('/'))
    }
  }
  const revision = options.revision ?? 'content-hash.sha256:sc2-namespace-fixture'
  const uri = options.uri ?? 'memory://sc2/namespace-fixture.SC2Map'
  const root = Object.freeze({ id: uri, uri })
  const namespace = Object.freeze({
    revision,
    async *list(parent) {
      const prefix = parent === '' ? '' : `${parent}/`
      const seen = new Set()
      for (const directory of directories) {
        if (!directory.startsWith(prefix)) continue
        const rest = directory.slice(prefix.length)
        if (rest.includes('/') || seen.has(directory)) continue
        seen.add(directory)
        yield Object.freeze({ path: directory, kind: 'directory' })
      }
      for (const [path, bytes] of entries) {
        if (!path.startsWith(prefix)) continue
        const rest = path.slice(prefix.length)
        if (rest.includes('/')) continue
        yield Object.freeze({ path, kind: 'file', size: BigInt(bytes.byteLength) })
      }
    },
    async open(path) {
      if (directories.has(path)) {
        return Object.freeze({
          value: Object.freeze({ kind: 'namespace' }),
          release: async () => undefined,
        })
      }
      const bytes = entries.get(path)
      if (bytes === undefined) throw new RangeError(`missing namespace entry ${path}`)
      const ref = Object.freeze({
        id: `${root.id}?entry=${encodeURIComponent(path)}`,
        uri: `${root.uri}?entry=${encodeURIComponent(path)}`,
        parentIds: Object.freeze([root.id]),
      })
      return Object.freeze({
        value: Object.freeze({
          kind: 'bytes',
          ref,
          revision,
          size: BigInt(bytes.byteLength),
          async read(offset, length) {
            return bytes.slice(Number(offset), Number(offset) + length)
          },
          async *stream() {
            yield bytes
          },
        }),
        release: async () => undefined,
      })
    },
  })
  return Object.freeze({
    originKind: 'namespace',
    root,
    bindings: Object.freeze([]),
    revisions: Object.freeze({
      topology: 'namespace',
      revision,
      namespaceRevision: revision,
      bindings: Object.freeze([]),
      compositionFingerprint: `namespace-fixture:${uri}:${revision}`,
    }),
    bindingsFor: () => Object.freeze([]),
    async openBinding() {
      throw new RangeError('fixture has no companion bindings')
    },
    async openNamespace() {
      return Object.freeze({ value: namespace, release: async () => undefined })
    },
  })
}
