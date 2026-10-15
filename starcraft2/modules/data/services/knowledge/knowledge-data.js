import knowledgeManifest from '../../../../contributions/knowledge-data.json' with { type: 'json' }

const fieldKey = (typeId, canonicalPath) => `${typeId}:${canonicalPath.join('.')}`

const freezeSource = source => Object.freeze({ ...source })
const freezeEntry = entry =>
  Object.freeze({
    ...entry,
    target: Object.freeze({
      ...entry.target,
      ...(entry.target.schema === undefined
        ? {}
        : { schema: Object.freeze({ ...entry.target.schema }) }),
      ...(entry.target.canonicalPath === undefined
        ? {}
        : { canonicalPath: Object.freeze([...entry.target.canonicalPath]) }),
    }),
    sources: Object.freeze(entry.sources.map(freezeSource)),
  })

const entries = Object.freeze(knowledgeManifest.spec.entries.map(freezeEntry))
const fields = new Map(
  entries
    .filter(entry => entry.target.kind === 'field')
    .map(entry => [fieldKey(entry.target.typeId, entry.target.canonicalPath), entry]),
)

/** Curated, schema-revision-bound field prose; absence is explicit and never synthesized. */
export function starcraft2FieldKnowledge(typeId, canonicalPath) {
  if (typeof typeId !== 'string' || !Array.isArray(canonicalPath)) return undefined
  return fields.get(fieldKey(typeId, canonicalPath))
}

export const STARCRAFT2_KNOWLEDGE_ENTRY_COUNT = entries.length
