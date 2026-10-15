/** SC2 conversation→FaceFX bindings at an explicit scene position. Catalog inheritance/localization
 * stay at the existing Data port; this adapter publishes every sound variation, never chooses a
 * random asset or guesses an FXE filename. No graph evaluation, audio execution or bone deformation.
 * Invoked by sc2-cutscene.facial-at; native offsets/pitch and FaceFX graph semantics remain partial.
 */
import type { InspectionContext } from '@modkit/codec-kit'
import type { DataResolvedEntity } from '@modkit/sdk'
import { catalogAssetLogicalId } from '../../../../../shared/catalog-model.js'
import { assertCutsceneTime, type CompiledCutscene } from './evaluate.js'

/** Capture authored fields and independent line clocks; retain ambiguity instead of selecting an asset. */
export async function cutsceneFacialAt(context: InspectionContext, compiled: CompiledCutscene,
  models: ReadonlyMap<string, DataResolvedEntity>, timeMs: number, signal?: AbortSignal) {
  assertCutsceneTime(timeMs)
  signal?.throwIfAborted()
  const frame = compiled.sceneAt(timeMs), nodes = new Map(frame.nodes.map(node => [node.sourceStart, node]))
  const lines = frame.activeClips.filter(clip => clip.kind === 'Conversation').map(clip => {
    let owner = clip.ownerStart === null ? undefined : nodes.get(clip.ownerStart)
    // Nodes are a decoded tree; still bound the walk and reject any impossible cycle.
    const seen = new Set<number>()
    while (owner !== undefined && owner.kind !== 'Actor') {
      if (seen.has(owner.sourceStart)) throw new TypeError('Cyclic facial actor ancestry')
      seen.add(owner.sourceStart)
      owner = owner.parentStart === null ? undefined : nodes.get(owner.parentStart)
    }
    return { clip, actor: owner }
  })
  const soundIds = [...new Set(lines.map(line => line.clip.attributes['soundLink']).filter((id): id is string => !!id))]
  const sounds = new Map<string, DataResolvedEntity>()
  for (let offset = 0; offset < soundIds.length; offset += 128) {
    signal?.throwIfAborted()
    for (const entity of await context.catalog?.entities(soundIds.slice(offset, offset + 128)
      .map(entityId => ({ namespace: 'Sound', entityId })), signal) ?? []) sounds.set(entity.entityId, entity)
  }
  return { revision: String(context.input.revisions.revision), timeMs, completeness: 'partial',
    timeUnit: frame.timeUnit, graphEvaluated: false, bonePosesApplied: false,
    lines: lines.map(({ clip, actor }) => {
      const soundId = clip.attributes['soundLink'], sound = sounds.get(soundId ?? '')
      const model = models.get(actor?.attributes['modelLink'] ?? '')
      const controller = actor?.attributes['fxaOverride'] ?? model?.fields['FacialController']
      const entries = sound?.fields['AssetArray']
      const assets = (entries === undefined ? [] : Array.isArray(entries) ? entries : [entries]).map((entry, ordinal) => {
        const wrapper = entry !== null && typeof entry === 'object' && !Array.isArray(entry) ? entry : undefined
        const asset = wrapper?.['value'] ?? entry
        const fields = asset !== null && typeof asset === 'object' && !Array.isArray(asset) ? asset : {}
        return { index: wrapper?.['index'] ?? ordinal, file: fields['File'] ?? null,
          facialFile: fields['FacialFile'] ?? null, facialGroup: fields['FacialGroup'] ?? null,
          facialAnimation: fields['FacialAnim'] ?? null, weight: fields['Weight'] ?? null,
          offset: fields['Offset'] ?? null, pitch: fields['Pitch'] ?? null }
      })
      const diagnostics = ['FaceFX graph link IDs, bone pose basis and M3Weight require a verified native profile; no facial deformation is applied.']
      if (actor === undefined) diagnostics.push('No enclosing actor; facial binding is unresolved.')
      if (sound === undefined) diagnostics.push('Sound catalog entity is unresolved in the selected context.')
      if (assets.length !== 1) diagnostics.push('Sound asset selection is ambiguous or empty; all authored variations are retained.')
      if (typeof controller !== 'string' || controller.length === 0) diagnostics.push('No facial controller is declared for this actor.')
      if (clip.attributes['durationOffset'] !== undefined || clip.attributes['startOffset'] !== undefined)
        diagnostics.push('Authored offsets are retained; native facial clock semantics are unverified.')
      return { clipGuid: clip.guid, sourceStart: clip.sourceStart, actorGuid: actor?.guid ?? null,
        modelLink: actor?.attributes['modelLink'] ?? null, soundLink: soundId ?? null,
        startMs: clip.start, endMs: clip.end, elapsedSeconds: clip.elapsed / 1000,
        facialGroup: clip.attributes['facialGroup'] ?? null, facialAnimation: clip.attributes['facialAnim'] ?? null,
        authoredOffsets: { startOffset: clip.attributes['startOffset'] ?? null, durationOffset: clip.attributes['durationOffset'] ?? null },
        controller: typeof controller === 'string' && controller.length > 0
          ? { authoredPath: controller, logicalId: catalogAssetLogicalId(model, 'FacialController', controller),
            source: actor?.attributes['fxaOverride'] === undefined ? 'CModel.FacialController' : 'actor.fxaOverride' } : null,
        assets, diagnostics }
    }) }
}
