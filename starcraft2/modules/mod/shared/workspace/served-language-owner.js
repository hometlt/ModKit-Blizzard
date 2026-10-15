/**
 * Language feature projection over the documents the mod server already owns. Data reuses its retained
 * session through data.language; Galaxy and structural Layout use their retained indexes;
 * Strings/Style use their canonical rename owners. Bounds, editable origins and mixed-index
 * uncertainty are preserved. Remaining codec surfaces use their existing owners, loaded on demand.
 * Vocabulary and asset-path metadata are retained by revision; asset bytes are never read here.
 * Replies contain bounded results and explicit layer/path identities, leaving URI/version/write
 * validation to Host. Standalone implementations remain at each language owner; no grammar lives here.
 */
import { createSc2DataLanguageProvider } from '../../../../dist/modules/data/providers/language/src/language.js'
import { renameAcrossLanguages } from '../../../data/providers/language/runtime.js'
import { createSc2StringsLanguageProvider } from '../../../../dist/modules/strings/providers/language/src/language.js'
import { styleNameAt, styleNameRename, styleNamePrepareRename, Positions } from '../../../../dist/modules/style/providers/language/src/style-names.js'
import { renameStrings, prepareStringsRename } from '../../../../dist/modules/strings/providers/language/src/workspace.js'
import { onStringKey } from '../../../layout/providers/language/runtime.js'
import { servedLinkUri } from '../../../galaxy/language/served-links.js'
import { definitionRequestAt } from '../../../../dist/modules/data/shared/format/language/definition.js'
import { stringCatalogFromWorkspace } from '../../../../dist/shared/language/string-workspace.js'

/** One immutable request projection per revision, delegating every rule to its existing language owner. */
export function createServedLanguageOwner(dataQuestion) {
  const data = createSc2DataLanguageProvider({ modContexts: { query: (_scope, question, signal) => dataQuestion(question, signal) } })
  const strings = createSc2StringsLanguageProvider()
  let vocabularyProvider
  let assetInputs = [], assetPaths = new Map(), assetLayers = [], assetsIncomplete = false
  /** Resolve only known retained file identities, including binary assets absent from language documents. */
  const placeOf = uri => {
    const known = places.get(uri)
    if (known !== undefined) return known
    if (typeof uri !== 'string' || !uri.startsWith('content-source://')) return undefined
    const parsed = new URL(uri), sourceId = decodeURIComponent(parsed.host)
    const fullPath = parsed.pathname.split('/').filter(Boolean).map(decodeURIComponent).join('/')
    for (const [index, layer] of assetLayers.entries()) {
      const prefix = layer.sourcePath.replace(/^\/+|\/+$/gu, '')
      if (sourceId !== layer.sourceId || !fullPath.startsWith(`${prefix}/`)) continue
      const file = assetPaths.get(fullPath.slice(prefix.length + 1).toLowerCase())
      if (file?.owner === index) return { layerId: layer.id, path: file.path }
    }
    return undefined
  }
  const owners = new Map([['sc2-data', data], ['sc2-strings', strings]])
  /** Optional codec implementations load only when that language is actually requested. */
  const ownerOf = async languageId => {
    if (owners.has(languageId)) return owners.get(languageId)
    let owner
    if (languageId === 'sc2-style') owner = (await import('../../../../dist/modules/style/providers/language/src/language.js')).createSc2StyleLanguageProvider()
    else if (languageId === 'sc2-wizard') owner = (await import('../../../../dist/modules/wizard/providers/language/src/language.js')).createSc2WizardLanguageProvider()
    else if (languageId === 'sc2-bank') owner = (await import('../../../../dist/modules/banks/providers/language/src/language.js')).createSc2BankLanguageProvider()
    else if (languageId === 'sc2-bank-list') owner = (await import('../../../../dist/modules/banks/providers/language/src/bank-list-language.js')).createSc2BankListLanguageProvider()
    else if (['sc2-cutscene', 'storm-cutscene'].includes(languageId)) owner = (await import('../../../../dist/modules/cutscene/providers/language/src/language.js')).createCutsceneLanguageProvider()
    if (owner !== undefined) owners.set(languageId, owner)
    return owner
  }
  let generation, documents = [], byUri = new Map(), places = new Map(), editable = new Set(), incomplete = true, precedence = new Map(), origins = [], editableUris = []
  /** A bounded request view over held identities, shared by preparation and planning. */
  const requestFor = (question, signal) => {
  const uri = servedLinkUri(question.document.layerId, question.document.path)
  const primary = byUri.get(uri)
  if (primary === undefined) return undefined
  // The caller bounds result/changed documents; it does not truncate the server's already-held model.
  const selected = documents
  const partial = question.incomplete || incomplete
  const request = {
    document: primary, workspaceDocuments: selected, position: question.position,
    newName: question.newName, maxEdits: question.maxEdits, maxResults: question.maxResults,
    maxDocuments: Math.max(question.maxDocuments, selected.length),
    workspaceIncomplete: partial,
        editableDocumentUris: editableUris, signal,
    workspaceContext: { id: 'served-language', revision: generation, semanticComplete: !partial,
          documentOrigins: origins, semanticInputs: [...(question.semanticInputs ?? []), ...assetInputs], modContext: { scope: 'served', revision: generation, complete: !partial } },
  }
    return { request, primary, uri }
  }
  /** Adapt the existing Galaxy index keys to the mixed owner's document identities. */
  const galaxyLinks = links => {
    const translate = name => byUri.get(name)?.uri ?? name
    return { ...links, targetAt: (name, offset) => links.targetAt(translate(name), offset),
      definitionAt: (name, offset) => links.definitionAt(translate(name), offset),
      renameAt: (name, offset, newName, maximum) => links.renameAt(translate(name), offset, newName, maximum) }
  }
  return {
    /** The canonical Data engine decides which requests need the retained path listing. */
    async needsContentPaths(question, signal) {
      const found = requestFor({ ...question, position: question.parameters.position }, signal)
      if (found?.primary.languageId !== 'sc2-data') return false
      if (question.feature === 'completion') return !(await data.modContextCompletionApplies(found.request))
      return question.feature === 'definition' && definitionRequestAt(found.primary.text,
        new Positions(found.primary.text).offset(question.parameters.position))?.kind === 'file'
    },
    /** Bind a bounded path index already owned by the server; no asset bytes or model are copied. */
    contentPaths(inputs, layers, paths, owners, partial) {
      if (assetInputs === inputs) return
      assetInputs = inputs; assetLayers = layers; assetsIncomplete = partial
      assetPaths = new Map(paths.map((path, index) => [path.toLowerCase(), { path, owner: owners[index] }]))
    },
    /** Reuse immutable request documents for remaining canonical language surfaces. */
    async feature(question, signal, links) {
      const found = requestFor({ ...question, position: question.parameters.position ?? { line: 0, character: 0 } }, signal)
      if (found === undefined) return undefined
      if (found.primary.languageId === 'sc2-strings' && ['completion', 'documentColors'].includes(question.feature)) {
        vocabularyProvider ??= createSc2StringsLanguageProvider({ catalog: stringCatalogFromWorkspace(documents) })
      }
      const request = { ...found.request, ...question.parameters }
      if (['completion', 'definition'].includes(question.feature) && found.primary.languageId === 'sc2-data' && assetsIncomplete) {
        request.workspaceIncomplete = true
        request.workspaceContext = { ...request.workspaceContext, semanticComplete: false }
      }
      if (question.feature === 'rename' && (request.workspaceIncomplete || links?.isIncomplete)) return undefined
      if (found.primary.languageId === 'sc2-triggers') return (await import('../../../triggers/providers/language/runtime.js')).sc2TriggersFeatureIn(request, links, question.feature)
      const map = ['sc2-map-objects', 'sc2-map-preload'].includes(found.primary.languageId)
        ? (await import('../../../../dist/modules/map/providers/language/src/language.js')).createSc2MapDocumentLanguage(['sc2-map-objects', 'sc2-map-preload'], () => links) : undefined
      const provider = map ?? (found.primary.languageId === 'sc2-strings' ? vocabularyProvider ?? strings : await ownerOf(found.primary.languageId))
      if (typeof provider?.[question.feature] !== 'function') throw new TypeError('this served language owner has no requested feature')
      const value = await provider[question.feature](request)
      return value !== null && typeof value === 'object' && 'isIncomplete' in value
        ? { ...value, isIncomplete: value.isIncomplete || request.workspaceIncomplete } : value
    },
    /** Only identities/results cross the port; explicit paths keep user strings free of reserved tokens. */
    project(value) {
      const named = [], slots = new Map(), identities = []
      let nodes = 0
      const slotOf = uri => {
        let slot = slots.get(uri)
        if (slot === undefined) {
          const place = placeOf(uri)
          slot = named.push({ layerId: place.layerId, path: place.path }) - 1
          slots.set(uri, slot)
        }
        return slot
      }
      const encode = (item, path = [], depth = 0) => {
        if (++nodes > 200_000 || depth > 64) throw new TypeError('served feature result exceeds structural bounds')
        if (typeof item === 'string') {
          if (placeOf(item) !== undefined) identities.push({ path, document: slotOf(item) })
          else if (item.includes('modkit-served-')) {
            const parts = []
            let cursor = 0
            for (const match of item.matchAll(/modkit-served-(?:links|layout|strings|style):\/\/[^`"'<>\r\n]*/gu)) {
              if (match.index < cursor) continue
              let end = match.index + match[0].length
              while (end > match.index && !places.has(item.slice(match.index, end))) end -= 1
              if (end === match.index) continue
              parts.push(item.slice(cursor, match.index), { document: slotOf(item.slice(match.index, end)) })
              cursor = end
            }
            if (cursor > 0) { parts.push(item.slice(cursor)); identities.push({ path, parts }) }
          }
          return item
        }
        if (Array.isArray(item)) return item.map((part, index) => encode(part, [...path, index], depth + 1))
        if (item !== null && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([key, part]) => [key, encode(part, [...path, key], depth + 1)]))
        return item
      }
      if (value === undefined) return { hasValue: false, documents: [], identities: [] }
      const projected = encode(value)
      return { hasValue: true, documents: named, identities, value: projected }
    },
    /** Data diagnostics use the same retained Data session as authoring and rename. */
    async dataDiagnostics(question, signal) {
      const found = requestFor(question, signal)
      return found === undefined ? { diagnostics: [], isIncomplete: true } : data.diagnostics(found.request)
    },
    /** Prepare through the same canonical name rules and retained indexes as planning. */
    async prepare(question, links, galaxyPrepare, layoutPrepare, signal) {
      const found = requestFor(question, signal)
      if (found === undefined) return undefined
      const { request, primary, uri } = found
      if (primary.languageId === 'sc2-data') return data.prepareRename(request)
      if (primary.languageId === 'sc2-wizard') return (await ownerOf('sc2-wizard')).prepareRename(request)
      if (['sc2-style', 'sc2-strings', 'sc2-layout'].includes(primary.languageId) && styleNameAt(request)) return styleNamePrepareRename(request)
      if (primary.languageId === 'sc2-strings') return strings.prepareRename(request)
      if (primary.languageId === 'galaxy')
        return onStringKey(request) ? prepareStringsRename(primary, request.position)
          : galaxyPrepare(question, request, byUri, editable, galaxyLinks(links))
      if (primary.languageId === 'sc2-layout') {
        const offset = new Positions(primary.text).offset(question.position)
        const target = links.references.find(item => item.uri === uri && item.start <= offset && offset <= item.end)
        if (target !== undefined) return { range: new Positions(primary.text).range(target.start, target.end), placeholder: target.entityId }
        if (onStringKey(request)) return prepareStringsRename(primary, request.position)
        return layoutPrepare(question, request)
      }
      return undefined
    },
    /** Keep bounded immutable document identities and Host source authority until the revision changes. */
    update(next, layers, revision) {
      if (generation === revision) return
      generation = revision
      vocabularyProvider = undefined
      assetInputs = []; assetPaths = new Map(); assetLayers = []; assetsIncomplete = false
      precedence = new Map(layers.map((layer, index) => [layer.id, index]))
      documents = []; byUri = new Map(); places = new Map(); editable = new Set(); incomplete = false
      let chars = 0
      for (const item of next) {
        if (documents.length >= 4096 || item.text.length > 64 * 1024 * 1024 || chars + item.text.length > 128 * 1024 * 1024) {
          incomplete = true
          continue
        }
        chars += item.text.length
        const uri = servedLinkUri(item.layerId, item.path)
        const document = Object.freeze({ uri, languageId: item.languageId, version: 0, text: item.text })
        documents.push(document)
        const writable = layers.find(layer => layer.id === item.layerId)?.sourceId === 'host'
        // Every alias here is an existing owner's index key; returned plans still name one place.
        const aliases = [uri, `${item.layerId}\0${item.path}`, ...['layout', 'strings', 'style'].map(kind =>
          `modkit-served-${kind}://${encodeURIComponent(item.layerId)}/${item.path}`)]
        for (const alias of aliases) {
          byUri.set(alias, document)
          places.set(alias, { layerId: item.layerId, path: item.path, writable })
          if (writable) editable.add(alias)
        }
      }
      editableUris = [...editable]
      origins = documents.map(document => {
        const place = places.get(document.uri)
        return Object.freeze({ uri: document.uri, layerId: place.layerId, logicalId: place.path,
          precedence: precedence.get(place.layerId), sourceRevision: generation, readOnly: !place.writable })
      })
    },
    /** Delegate the plan to the existing owner, then project only changed documents. */
    async rename(question, links, galaxyRename, layoutRename, signal) {
      const found = requestFor(question, signal)
      if (found === undefined) return { documents: [], edit: null }
      const { request, primary, uri } = found
      let edit
      if (primary.languageId === 'sc2-data') edit = await renameAcrossLanguages(data, request, links)
      else if (primary.languageId === 'sc2-wizard') edit = await (await ownerOf('sc2-wizard')).rename(request)
      else if (['sc2-style', 'sc2-strings', 'sc2-layout'].includes(primary.languageId) && styleNameAt(request)) edit = styleNameRename(request)
      else if (primary.languageId === 'sc2-strings') edit = await strings.rename(request)
      else if (primary.languageId === 'galaxy') {
        // a StringExternal literal names a GameStrings key: its owner renames it everywhere
        edit = onStringKey(request) ? renameStrings(request)
          : await galaxyRename(question, request, byUri, editable, galaxyLinks(links))
      } else if (primary.languageId === 'sc2-layout') {
        const offset = new Positions(primary.text).offset(question.position)
        const literal = links.references.find(item => item.uri === uri && item.start <= offset && offset <= item.end)
        edit = literal !== undefined ? links.renameAt(uri, offset, question.newName, question.maxEdits)
          : onStringKey(request) ? renameStrings(request) : await layoutRename(question, request)
      }
      if (edit === undefined || edit.isComplete !== true || edit.documentChanges.length > question.maxDocuments) return { documents: [], edit: null }
      const named = [], changes = []
      for (const change of edit.documentChanges) {
        const place = places.get(change.uri)
        if (place === undefined) throw new TypeError('rename owner named a document outside its chain')
        const document = named.push({ layerId: place.layerId, path: place.path }) - 1
        changes.push({ document, edits: change.edits })
      }
      return { documents: named, edit: { isComplete: true, changes } }
    },
  }
}
