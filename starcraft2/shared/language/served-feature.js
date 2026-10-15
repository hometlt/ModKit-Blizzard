/** Bounded semantic feature transport. Language/model owners remain on the mod server; Host owns editor identities. */
import { servedProjectDiagnostics } from './served-project-diagnostics.js'
export async function servedLanguageFeature(request, port, feature) {
  const context = request.workspaceContext?.modContext
  if (context?.document === undefined || port === undefined) throw new TypeError('served language feature needs a mod context')
  const parameters = {}
  for (const key of ['position', 'range', 'diagnostics', 'query', 'color', 'maxEdits', 'newName', 'includeDeclaration']) {
    if (request[key] !== undefined) parameters[key] = request[key]
  }
  const answer = await port.query(context.scope, { kind: 'language.feature', feature, document: context.document,
    documentVersion: request.document.version, maxResults: request.maxResults, maxDocuments: request.maxDocuments,
    semanticInputs: (request.workspaceContext?.semanticInputs ?? []).filter(input => input.kind === 'locale-set'),
    incomplete: request.workspaceIncomplete === true, parameters }, request.signal)
  if (answer?.revision !== context.revision) throw new Error('language.feature answered another revision')
  if (typeof answer.hasValue !== 'boolean' || !Array.isArray(answer.documents) || !Array.isArray(answer.identities)) throw new TypeError('invalid served feature projection')
  if (!answer.hasValue) return undefined
  let nodes = 0
  /** Replies may be frozen by a worker boundary; copy only the bounded result, never model inputs. */
  const copy = (value, depth = 0) => {
    if (++nodes > 200_000 || depth > 64) throw new TypeError('served feature result exceeds structural bounds')
    if (Array.isArray(value)) return value.map(part => copy(part, depth + 1))
    if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, part]) => [key, copy(part, depth + 1)]))
    return value
  }
  const value = copy(answer.value)
  /** Restore only explicit projected paths, so authored values cannot collide with transport markers. */
  const uriOf = index => {
    const uri = answer.documents[index]?.uri
    if (!Number.isSafeInteger(index) || index < 0 || typeof uri !== 'string') throw new TypeError('served feature named a document without a Host URI')
    return uri
  }
  if (answer.identities.length > 200_000) throw new TypeError('served feature identity projection exceeds bounds')
  for (const identity of answer.identities) {
    if (!Array.isArray(identity.path) || identity.path.length < 1 || identity.path.length > 64) throw new TypeError('invalid served feature identity path')
    let parent = value
    for (const key of identity.path.slice(0, -1)) {
      if (parent === null || typeof parent !== 'object' || !Object.hasOwn(parent, key)) throw new TypeError('served identity path is outside its result')
      parent = parent[key]
    }
    const key = identity.path.at(-1)
    if (parent === null || typeof parent !== 'object' || !Object.hasOwn(parent, key)) throw new TypeError('served identity path is outside its result')
    parent[key] = identity.parts === undefined ? uriOf(identity.document)
      : identity.parts.map(part => typeof part === 'string' ? part : uriOf(part.document)).join('')
    if (key === 'uri' && parent.documentVersion !== undefined) {
      const version = answer.documents[identity.document].documentVersion
      if (!Number.isSafeInteger(version) || version < 0) throw new TypeError('served edit has no Host document version')
      parent.documentVersion = version
    }
  }
  return value
}

/** Attach existing codec surfaces to the shared server transport, preserving standalone implementations. */
export function withServedLanguageFeatures(provider, port, features, documentLocalFeatures = []) {
  features = features.filter(feature => typeof provider[feature] === 'function')
  const local = [...new Set([...(provider.documentLocalFeatures ?? []), ...documentLocalFeatures])]
  if (port === undefined) return Object.freeze({ ...provider, documentLocalFeatures: Object.freeze(local) })
  return Object.freeze({ ...provider, documentLocalFeatures: Object.freeze(local),
    semanticContextRequirements: Object.freeze([...(provider.semanticContextRequirements ?? []), { kind: 'mod-context', gameId: 'blizzard/starcraft-2' }]),
    modContextFeatures: Object.freeze([...new Set([...(provider.modContextFeatures ?? []), ...features, 'projectDiagnostics'])]),
    projectDiagnostics: request => servedProjectDiagnostics(request, port),
    modContextFeatureApplies: () => true, modContextCompletionApplies: () => true,
    ...Object.fromEntries(features.map(feature => [feature, request => request.workspaceContext?.modContext?.document === undefined
      ? provider[feature](request) : servedLanguageFeature(request, port, feature)])),
  })
}
