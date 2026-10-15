/**
 * CASC namespace codec: bounded marker detection, read-only inspection, paging and extraction.
 * Detection needs no root parser or storage reader; those load only for an inspected installation.
 * The reader remains the single owner of build/cache selection and archive decoding.
 */
import { createInspectionCodec, createTreeDataSource, simpleLease } from '@modkit/codec-kit'

import { CASC_LIMITS, cascError, throwIfCancelled } from './limits.js'
import { cascSourceFromNamespace } from './source.js'

const ID = 'blizzard/casc'
// An installation is `.build.info` beside one data directory holding the storage folders. The
// directory names are the ones `detectCascDataDirectory` reads; `probe.markers` in
// `contributions/codec-casc.json` declares every pair.
const DATA_DIRECTORIES = Object.freeze(['SC2Data', 'HeroesData', 'Data'])
const STORAGE_FOLDERS = Object.freeze(['config', 'data', 'indices'])

function normalizedPath(path) {
  return String(path).replaceAll('\\', '/').replace(/^\/+/, '').toLowerCase()
}

/**
 * The page a caller may have: a limit above the budget is answered with a budget-sized page and a
 * cursor, as the namespace contract allows — the host walks a listing 512 at a time.
 */
function validPage(page) {
  if (!Number.isSafeInteger(page.limit) || page.limit <= 0) {
    throw cascError(
      'x3.casc/page-limit-invalid',
      'CASC namespace page limit must be a positive safe integer',
      {
        limit: page.limit,
      },
    )
  }
  return Math.min(page.limit, CASC_LIMITS.maxPageItems)
}

function namespaceEntry(table, at, revision) {
  const path = table.keyAt(at)
  return Object.freeze({
    id: path,
    path,
    name: path.split('/').at(-1) ?? path,
    kind: 'file',
    size: BigInt(table.contentSizeAt(at)),
    revision,
  })
}

// A path the name table does not spell but the reader resolves — a Diablo III `Textures/<sno>.tex`,
// a configured alias or prefix — answers as that one file when asked for exactly, so a host open by
// logical id finds it. Listings never enumerate such paths.
function aliasEntry(reader, path, revision) {
  if (path === '' || reader.resolveFile(path) === undefined) return undefined
  const size = reader.contentSizeOf(path)
  return Object.freeze({
    id: path,
    path,
    name: path.split('/').at(-1) ?? path,
    kind: 'file',
    ...(size === undefined ? {} : { size: BigInt(size) }),
    revision,
  })
}

function validateBasenameSearch(query) {
  if (
    query === null ||
    typeof query !== 'object' ||
    Array.isArray(query) ||
    !Object.keys(query).every(
      key => key === 'kind' || key === 'basenames' || key === 'caseSensitive',
    ) ||
    query.kind !== 'basename-any' ||
    !Array.isArray(query.basenames) ||
    query.basenames.length === 0 ||
    query.basenames.length > CASC_LIMITS.maxSearchBasenames ||
    typeof query.caseSensitive !== 'boolean' ||
    query.basenames.some(
      item =>
        typeof item !== 'string' ||
        item.length === 0 ||
        item.length > CASC_LIMITS.maxPathBytes ||
        item.includes('/') ||
        item.includes('\\') ||
        item.includes('\0') ||
        item === '.' ||
        item === '..',
    )
  ) {
    throw cascError(
      'x3.casc/search-query-invalid',
      'CASC namespace search requires bounded basename-any terms',
    )
  }
  const identities = query.caseSensitive
    ? query.basenames
    : query.basenames.map(item => item.toLowerCase())
  if (new Set(identities).size !== identities.length) {
    throw cascError(
      'x3.casc/search-query-invalid',
      'CASC namespace search basenames must be unique under the requested case rule',
    )
  }
}

/**
 * The parsed name index of an installed game, kept between windows.
 *
 * Parsing an installed StarCraft II root costs ~4 s and a 20 MB BLTE decode before one file can
 * be read; reloading the cached index is a file read. The host names the directory it may be
 * written to (`cacheDirectory`) and the user keeps the switch, on unless turned off: per game by
 * its `.build.info` product (`games: { d3: { cacheIndex: false } }`), for all games (`cacheIndex`),
 * or per installation through `bySource`. The answer is a function of the product, which the reader
 * learns from `.build.info`. The `node:fs` reader is imported on demand, so a browser worker simply
 * runs without a cache.
 */
export async function openIndexCache(settings, sourceUri, notes) {
  const shared = usableDirectory(settings['indexCacheDirectory'])
  const own = usableDirectory(settings['cacheDirectory'])
  // The host's one directory for index caches (sdk `index-caches`), shared with the SC2 content
  // source; a host that has none still gives this contribution its own.
  const directory = shared ?? own
  if (directory === undefined) return undefined
  let cacheModule
  try {
    cacheModule = await import('./root-cache-node.js')
  } catch (error) {
    notes.push(`CASC index cache unavailable: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
  const { cascGameOf, canonicalInstallation, createInstallationRootCache, removeLegacyCache } = cacheModule
  if (shared !== undefined && own !== undefined) await removeLegacyCache(own, sourceUri)
  const note = message => notes.push(message)
  const installation = canonicalInstallation(sourceUri)
  return product =>
    cacheIndexEnabled(settings, product)
      ? createInstallationRootCache(
          directory,
          sourceUri,
          { info: note, warn: note },
          { game: cascGameOf(product), product, kind: 'names', installation },
        )
      : undefined
}

function usableDirectory(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/** The name-index switch for one game: its own setting, else the setting for all games, else on. */
export function cacheIndexEnabled(settings, product) {
  const games = settings['games']
  const own = games !== null && typeof games === 'object' ? games[product]?.cacheIndex : undefined
  if (typeof own === 'boolean') return own
  return settings['cacheIndex'] !== false
}

export async function detectCascMarkers(markers) {
  const observed = new Map(markers.map(marker => [marker.path, marker.kind]))
  const dataDir =
    observed.get('.build.info') === 'file'
      ? DATA_DIRECTORIES.find(dir =>
          STORAGE_FOLDERS.every(folder => observed.get(`${dir}/${folder}`) === 'directory'),
        )
      : undefined
  return dataDir === undefined
    ? {
        confidence: 0,
        kind: 'structure',
        note: 'required CASC markers are absent: .build.info and a data directory with config, data and indices',
      }
    : { confidence: 0.99, kind: 'structure', note: `CASC installation structure (${dataDir})` }
}

export function createCascNamespaceSource(reader, sourceRef, revision) {
  const table = reader.entryIndex
  const immediateChildren = (path, page) => {
    const limit = validPage(page)
    const presentation = String(path).replaceAll('\\', '/').replace(/^\/+|\/+$/gu, '')
    const normalized = normalizedPath(path).replace(/\/+$/u, '')
    const prefix = normalized ? `${normalized}/` : ''
    const first = table.lowerBound(prefix)
    const end = table.lowerBound(`${prefix}\uffff`)
    const start = page.cursor === undefined ? first : Number(page.cursor)
    if (!Number.isSafeInteger(start) || start < first || start > end) {
      throw cascError('x3.casc/children-cursor-invalid', 'CASC child cursor is invalid', {
        cursor: page.cursor,
      })
    }
    const items = []
    let index = start
    while (index < end && items.length < limit) {
      const tail = table.keyAt(index).slice(prefix.length)
      const slash = tail.indexOf('/')
      const segment = slash === -1 ? tail : tail.slice(0, slash)
      if (!segment) {
        index += 1
        continue
      }
      const name = !presentation && segment === 'mods'
        ? 'Mods'
        : !presentation && segment === 'campaigns'
          ? 'Campaigns'
          : segment
      const outputPath = [presentation, name].filter(Boolean).join('/')
      if (slash !== -1) {
        const childPrefix = `${prefix}${segment}/`
        items.push(Object.freeze({
          id: prefix + segment,
          path: outputPath,
          name,
          kind: 'directory',
          revision,
        }))
        index = table.lowerBound(`${childPrefix}\uffff`)
      } else {
        items.push(
          Object.freeze({ ...namespaceEntry(table, index, revision), path: outputPath, name }),
        )
        index += 1
      }
    }
    return Object.freeze({
      items: Object.freeze(items),
      ...(index < end ? { nextCursor: String(index) } : {}),
    })
  }
  return Object.freeze({
    async list(prefix, page, signal) {
      throwIfCancelled(signal)
      const limit = validPage(page)
      const normalizedPrefix = normalizedPath(prefix)
      const first = table.lowerBound(normalizedPrefix)
      const start = page.cursor === undefined ? first : Number(page.cursor)
      if (!Number.isSafeInteger(start) || start < first || start > table.size) {
        throw cascError('x3.casc/page-cursor-invalid', 'CASC namespace cursor is invalid', {
          cursor: page.cursor,
        })
      }
      const items = []
      let index = start
      while (
        index < table.size &&
        table.keyAt(index).startsWith(normalizedPrefix) &&
        items.length < limit
      ) {
        items.push(namespaceEntry(table, index, revision))
        index += 1
      }
      if (items.length === 0 && page.cursor === undefined) {
        const alias = aliasEntry(reader, normalizedPrefix, revision)
        if (alias !== undefined) return Object.freeze({ items: Object.freeze([alias]) })
      }
      return Object.freeze({
        items: Object.freeze(items),
        ...(index < table.size && table.keyAt(index).startsWith(normalizedPrefix)
          ? { nextCursor: String(index) }
          : {}),
      })
    },
    // One file by exact path, without walking the listing: a table name or a path only the reader
    // resolves (a Diablo III SNO path). CASC names ignore case, so the entry answers under the
    // caller's spelling — the host accepts a lookup only when the id is the one it asked for.
    async lookup(path, signal) {
      throwIfCancelled(signal)
      const normalized = normalizedPath(path)
      const at = table.lowerBound(normalized)
      const entry =
        at < table.size && table.keyAt(at) === normalized
          ? namespaceEntry(table, at, revision)
          : aliasEntry(reader, normalized, revision)
      if (entry === undefined) return undefined
      const spelled = String(path).replaceAll('\\', '/').replace(/^\/+/u, '')
      return spelled === entry.id
        ? entry
        : Object.freeze({ ...entry, id: spelled, path: spelled, name: spelled.split('/').at(-1) })
    },
    async children(path, page, signal) {
      throwIfCancelled(signal)
      return immediateChildren(path, page)
    },
    async search(query, page, signal) {
      throwIfCancelled(signal)
      const limit = validPage(page)
      validateBasenameSearch(query)
      const terms = [...new Set(query.basenames)].map(item =>
        query.caseSensitive ? item : item.toLowerCase(),
      )
      const wanted = new Set(terms)
      const start = page.cursor === undefined ? 0 : Number(page.cursor)
      if (!Number.isSafeInteger(start) || start < 0 || start > table.size) {
        throw cascError(
          'x3.casc/search-cursor-invalid',
          'CASC namespace search cursor is invalid',
          {
            cursor: page.cursor,
          },
        )
      }
      const items = []
      let index = start
      const matches = at => {
        const path = table.keyAt(at)
        const basename = path.slice(path.lastIndexOf('/') + 1)
        return wanted.has(query.caseSensitive ? basename : basename.toLowerCase())
      }
      while (index < table.size && items.length < limit) {
        const at = index
        index += 1
        if (matches(at)) items.push(namespaceEntry(table, at, revision))
      }
      while (index < table.size && !matches(index)) index += 1
      return Object.freeze({
        items: Object.freeze(items),
        ...(index < table.size ? { nextCursor: String(index) } : {}),
      })
    },
    async openEntry(entryId, signal) {
      throwIfCancelled(signal)
      const path = normalizedPath(entryId)
      if (reader.resolveFile(path) === undefined) {
        throw cascError('x3.casc/entry-not-found', 'CASC entry does not exist', { path })
      }
      return simpleLease(
        Object.freeze({
          id: `${sourceRef.id}!/${path}`,
          uri: `casc-entry:${encodeURIComponent(sourceRef.uri)}!/${encodeURIComponent(path)}`,
          parentIds: Object.freeze([sourceRef.id]),
        }),
      )
    },
  })
}

const definition = Object.freeze({
  id: ID,
  version: '1.0.0',
  format: Object.freeze({ id: 'casc', label: 'Blizzard CASC installed storage' }),
  operations: Object.freeze([
    Object.freeze({
      id: 'container.extract',
      handlerId: 'extract-entry',
      mutatesSource: false,
      requiredPermissions: Object.freeze(['read-source']),
      outputKinds: Object.freeze(['bytes']),
    }),
  ]),
  namespace: Object.freeze({
    detect: detectCascMarkers,
    async inspect(namespace, context) {
      throwIfCancelled(context.signal)
      const cacheNotes = []
      const rootCache = await openIndexCache(
        context.settings ?? {},
        context.input.root.uri,
        cacheNotes,
      )
      const { CascReader } = await import('./reader.js')
      throwIfCancelled(context.signal)
      const reader = await CascReader.open(cascSourceFromNamespace(namespace, context.signal), {
        ...(context.signal === undefined ? {} : { signal: context.signal }),
        ...(rootCache === undefined ? {} : { rootCache }),
      })
      const tree = createTreeDataSource({
        kind: 'archive',
        label: 'CASC installation',
        preview: `${reader.entryIndex.size} named files (${reader.rootFormat} root)`,
        children: [
          {
            kind: 'directory',
            label: reader.dataDir,
            preview: 'Local read-only data containers',
          },
        ],
      })
      return {
        detection: await detectCascMarkers([
          { path: '.build.info', kind: 'file' },
          ...STORAGE_FOLDERS.map(folder => ({
            path: `${reader.dataDir}/${folder}`,
            kind: 'directory',
          })),
        ]),
        summary: {
          format: 'casc',
          rootFormat: reader.rootFormat,
          entries: reader.entryIndex.size,
          rootContentKey: reader.rootContentKey,
        },
        metadata: [
          {
            id: 'casc-installation',
            label: 'CASC installation',
            entries: [
              { key: 'rootFormat', value: reader.rootFormat },
              { key: 'entries', value: reader.entryIndex.size },
              { key: 'rootContentKey', value: reader.rootContentKey },
            ],
          },
        ],
        traits: [
          { id: 'container.entries', parameters: { count: reader.entryIndex.size } },
          { id: 'structure.hierarchy', parameters: { root: reader.rootFormat } },
        ],
        dataSources: {
          'common.view/tree-data-source': tree,
          'common.view/namespace-entry-source': createCascNamespaceSource(
            reader,
            context.input.root,
            context.input.revisions.namespaceRevision,
          ),
        },
        handlers: {
          'extract-entry': async input => {
            if (input === null || typeof input !== 'object' || Array.isArray(input)) {
              throw new TypeError('container.extract requires {entryId}')
            }
            const entryId = String(input.entryId ?? '')
            return { kind: 'bytes', value: await reader.readPath(entryId) }
          },
        },
        maxDecodedBytes: CASC_LIMITS.maxDecodedBytes,
        unsupportedFeatures: ['encrypted-blte-chunks', 'tvfs-multi-span-reads'],
        // What the index cache did this open, so a slow open can be told from a cached one.
        diagnostics: Object.freeze(
          cacheNotes.map((message, index) =>
            Object.freeze({
              id: `blizzard/casc-index-cache-${index}`,
              severity: 'information',
              code: 'blizzard/casc-index-cache',
              category: 'performance',
              message,
            }),
          ),
        ),
      }
    },
  }),
})

export const abiVersion = 1
export const createCodec = context => createInspectionCodec(definition, context)
