// Initial-world actor messages. No entity/model names are special-cased here.
const record = value => value?.value && typeof value.value === 'object' ? value.value : value
const list = value => value === undefined ? [] : Array.isArray(value) ? value : [value]

export function initialActorPresentation(object, actor, lookup) {
  const levels = new Map()
  const unit = object.kind === 'unit' ? lookup('Unit', object.typeId) : undefined
  for (const raw of list(unit?.fields?.BehaviorArray)) {
    const id = record(raw)?.Link
    if (typeof id !== 'string') continue
    const behavior = lookup('Behavior', id)
    if (behavior?.typeId !== 'CBehaviorResource') continue
    const fields = behavior.fields
    const count = Number(fields.DepletionVariationCount)
    const threshold = Number(fields.DepletionThreshold)
    const amount = object.resources ?? Number(fields.Contents)
    if (count > 0 && threshold > 0 && Number.isFinite(amount))
      levels.set(id.toLowerCase(), Math.max(0, Math.min(count - 1, Math.ceil(amount * count / threshold) - 1)))
  }
  let modelId
  let name = 'Stand', loop = true, speed = 1, randomStart = false
  const groups = new Set()
  let animated = false
  // Actors the unit creates at rest (a mineral field's splat of small crystals at its feet).
  const created = new Set()
  const events = [], visitedMacros = new Set()
  const collect = (current, depth = 0) => {
    if (depth >= 16) return
    for (const raw of list(current?.fields?.Macros)) {
      const id = raw?.value ?? raw
      if (typeof id !== 'string' || visitedMacros.has(id)) continue
      visitedMacros.add(id)
      collect(lookup('Actor', id), depth + 1)
    }
    events.push(...list(current?.fields?.On))
  }
  collect(actor)
  for (const raw of events) {
    const event = record(raw)
    // Messages explicitly addressed to other actors must not mutate this model.
    if (event?.Target && event.Target !== '_Self') continue
    const [trigger, ...conditions] = String(event?.Terms ?? '').split(';').map(s => s.trim())
    const behavior = /^BehaviorLevel\.([^.]+)\.Start$/iu.exec(trigger)
    const level = behavior ? levels.get(behavior[1].toLowerCase()) : undefined
    if (trigger !== 'ActorCreation' && level === undefined) continue
    if (!conditions.every(term => {
      const expected = /^Level (\d+)$/u.exec(term)
      if (expected) return level === Number(expected[1])
      // The world is the game's, not the editor's: an editor helper (InvisibleWalkablePlatform8x8,
      // alias _EditorHelper) plays its hiding Work animation on `ActorCreation; !IsInEditor`.
      if (term === '!IsInEditor') return true
      if (term === 'IsInEditor') return false
      // The map preview uses the high-detail authored model variant.
      return term === 'Option Shader Ultra'
    })) continue
    const [command, ...args] = String(event.Send ?? '').match(/"[^"]*"|\S+/gu)?.map(s => s.replace(/^"|"$/gu, '')) ?? []
    if (command === 'ModelSwap' && args[0]) modelId = args[0]
    if (command === 'AnimGroupApply' && args[0]) { groups.add(args[0]); animated = true }
    if (command === 'AnimGroupRemove') groups.delete(args[0])
    if (command === 'AnimPlay' && args[1]) {
      name = args[1].replaceAll(',', ' ')
      const flags = args.slice(2).flatMap(value => value.split(','))
      loop = flags.includes('PlayForever')
      randomStart = flags.includes('RandomStartOffset')
      animated = true
    }
    // A bracket plays its opening, then its content until it closes: at rest the content shows,
    // looping unless ContentPlayOnce (AnimBracketStart <name> <opening> <content> <closing> <flags>).
    if (command === 'AnimBracketStart' && args[2] && args[2] !== 'IGNORE') {
      name = args[2].replaceAll(',', ' ')
      loop = !args.slice(4).flatMap(value => value.split(',')).includes('ContentPlayOnce')
      randomStart = false
      animated = true
    }
    if (command === 'AnimSetTimeScale' && Number(args[1]) > 0) speed = Number(args[1])
    if (command === 'Create' && args[0]) created.add(args[0])
  }
  return {
    ...(modelId === undefined ? {} : { modelId }),
    ...(created.size === 0 ? {} : { createdActors: [...created] }),
    ...(animated
      ? { presentationAnimation: { name, groups: [...groups], loop, speed, ...(randomStart ? { randomStart } : {}) } }
      : {}),
  }
}
