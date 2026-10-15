import { expect, it } from 'vitest'
import { initialActorPresentation } from '../modules/map/providers/semantic/actor-presentation.js'

it('evaluates initial resource and creation events from resolved catalogs, without mineral-name rules', () => {
  const catalog = new Map([
    ['Unit/Rock', { fields: { BehaviorArray: [{ value: { Link: 'Ore' } }] } }],
    ['Behavior/Ore', { typeId: 'CBehaviorResource', fields: { Contents: '1500', DepletionThreshold: '750', DepletionVariationCount: '4' } }],
  ])
  const actor = { fields: { On: [
    { Terms: 'ActorCreation; Option Shader Ultra', Send: 'ModelSwap RockHigh' },
    { Terms: 'ActorCreation', Send: 'AnimPlay Idle Stand PlayForever' },
    { Terms: 'BehaviorLevel.Ore.Start; Level 0', Send: 'AnimGroupApply A' },
    { Terms: 'BehaviorLevel.Ore.Start; Level 3', Send: 'AnimGroupApply D' },
    { Terms: 'ActorCreation; UnknownCondition', Send: 'ModelSwap Wrong' },
    { Terms: 'ActorCreation', Target: 'AnotherActor', Send: 'ModelSwap Wrong' },
  ] } }
  const lookup = (ns, id) => catalog.get(`${ns}/${id}`)
  expect(initialActorPresentation({ kind: 'unit', typeId: 'Rock', resources: 5 }, actor, lookup)).toEqual({
    modelId: 'RockHigh', presentationAnimation: { name: 'Stand', groups: ['A'], loop: true, speed: 1 },
  })
  expect(initialActorPresentation({ kind: 'unit', typeId: 'Rock' }, actor, lookup).presentationAnimation.groups).toEqual(['D'])
})

it('plays an inherited macro animation with comma-separated flags', () => {
  const macro = { fields: { On: [{ Terms: 'ActorCreation', Send: 'AnimPlay Idle Stand PlayForever,RandomStartOffset' }] } }
  const result = initialActorPresentation({ kind: 'doodad' }, { fields: { Macros: [{ index: '0', value: 'IdleMacro' }] } },
    (namespace, id) => namespace === 'Actor' && id === 'IdleMacro' ? macro : undefined)
  // The default doodad actor starts each copy at a random point of the loop.
  expect(result.presentationAnimation).toEqual({ name: 'Stand', groups: [], loop: true, speed: 1, randomStart: true })
})

it('names the actors a resource level creates, such as a mineral field splat', () => {
  const catalog = new Map([
    ['Unit/Field', { fields: { BehaviorArray: [{ value: { Link: 'Minerals' } }] } }],
    ['Behavior/Minerals', { typeId: 'CBehaviorResource', fields: { Contents: '1800', DepletionThreshold: '1800', DepletionVariationCount: '4' } }],
  ])
  const actor = { fields: { On: [
    { Terms: 'BehaviorLevel.Minerals.Start; Level 0', Send: 'Create FieldSplatSmall' },
    { Terms: 'BehaviorLevel.Minerals.Start; Level 3', Send: 'Create FieldSplat' },
    { Terms: 'ActorCreation', Send: 'Create FieldSound' },
  ] } }
  const lookup = (ns: string, id: string) => catalog.get(`${ns}/${id}`)
  // A full field is at its top level; which created actor is a model is the provider's question.
  expect(initialActorPresentation({ kind: 'unit', typeId: 'Field' }, actor, lookup).createdActors).toEqual(['FieldSplat', 'FieldSound'])
  expect(initialActorPresentation({ kind: 'unit', typeId: 'Field', resources: 100 }, actor, lookup).createdActors).toEqual(['FieldSplatSmall', 'FieldSound'])
})

it('shows the content of an animation bracket started at creation', () => {
  const actor = (send: string) => ({ fields: { On: [{ Terms: 'ActorCreation', Send: send }] } })
  const none = () => undefined
  expect(initialActorPresentation({ kind: 'doodad' }, actor('AnimBracketStart Open Birth Stand,Work Death'), none).presentationAnimation)
    .toEqual({ name: 'Stand Work', groups: [], loop: true, speed: 1 })
  expect(initialActorPresentation({ kind: 'doodad' }, actor('AnimBracketStart Once Birth Spell Death ContentPlayOnce'), none).presentationAnimation)
    .toMatchObject({ name: 'Spell', loop: false })
})

it('plays what the game plays, not the editor: an editor helper hides itself outside the editor', () => {
  // Liberty's InvisibleWalkablePlatform8x8 (alias _EditorHelper).
  const actor = { fields: { On: [
    { Terms: 'ActorCreation', Send: '$Stand PlayForever,RandomStartOffset' },
    { Terms: 'ActorCreation; !IsInEditor', Send: 'AnimPlay Work Work PlayForever' },
    { Terms: 'ActorCreation; IsInEditor', Send: 'AnimPlay Shown Birth' },
  ] } }
  expect(initialActorPresentation({ kind: 'doodad' }, actor, () => undefined).presentationAnimation)
    .toEqual({ name: 'Work', groups: [], loop: true, speed: 1 })
})
