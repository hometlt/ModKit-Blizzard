/**
 * Warcraft III Reforged PopcornFX bake codec (`.pkb`): the effect a CORN emitter runs, as a tree —
 * its layers with their renderers (billboard mode, blend, texture, atlas), samplers (curves, shapes,
 * event streams, turbulence), compiled scripts and particle fields, the event graph and the record
 * classes — a layer table and a JSON export.
 *
 * Owner: GAME-WARCRAFT3. Read-only; the format is `bake.ts`, the effect `effect.ts`, the scripts
 * `script.ts`. This module owns the MK3 surface: budgets, cancellation, the published facets. The
 * effect is not simulated here.
 */
import type { InspectionContext } from '@modkit/codec-kit'
import type { HostOperationHandler } from '@modkit/host'
import type { JsonValue, OperationDecl } from '@modkit/sdk'
import { createInspectionCodec, createTableDataSource, createTreeDataSource } from '@modkit/codec-kit'
import { PkbBake } from './bake.js'
import { pkEffectOf, type PkEffect, type PkLayer, type PkSampler } from './effect.js'
import type { PkScript } from './script.js'

const ID = 'blizzard/war3-pkb'

const operations: readonly OperationDecl[] = [
  {
    id: 'export.convert' as OperationDecl['id'],
    handlerId: 'export-convert',
    mutatesSource: false,
    requiredPermissions: ['read-source'],
    outputKinds: ['json'],
  },
]

const LAYER_COLUMNS = ['layer', 'renderers', 'texture', 'billboard', 'blend', 'samplers', 'scripts', 'fields'] as const

const scriptsOf = (layer: PkLayer): { role: string; script: PkScript }[] =>
  (
    [
      ['spawn', layer.spawn],
      ['evolve on spawn', layer.evolveOnSpawn],
      ['evolve', layer.evolve],
    ] as const
  ).flatMap(([role, script]) => (script === undefined ? [] : [{ role, script }]))

function layerRow(layer: PkLayer): string[] {
  const first = layer.renderers[0]
  return [
    layer.name,
    String(layer.renderers.length),
    first?.texture ?? '',
    first?.billboard ?? '',
    first?.blend ?? '',
    String(layer.samplers.length),
    scriptsOf(layer).map(({ role }) => role).join(', '),
    String(layer.fields.length),
  ]
}

function samplerPreview(sampler: PkSampler): string {
  switch (sampler.kind) {
    case 'curve':
      return `curve, ${String(sampler.curve.dimension)}D, ${String(sampler.curve.times.length)} knots`
    case 'shape':
      return `shape ${String(sampler.shape.type)}, radius ${sampler.shape.radius.toFixed(3)}, height ${sampler.shape.height.toFixed(3)}`
    case 'event-stream':
      return `events at ${sampler.times.map(time => time.toFixed(2)).join(', ')} s`
    case 'turbulence':
      return `turbulence, wavelength ${sampler.wavelength.toFixed(3)}, strength ${sampler.strength.toFixed(3)}`
    default:
      return sampler.className || sampler.kind
  }
}

/** The effect as plain JSON: what `export.convert` returns. */
export function war3PkbJson(effect: PkEffect): JsonValue {
  return {
    format: 'war3-pkb',
    version: effect.version,
    layers: effect.layers.map(layer => ({
      name: layer.name,
      record: layer.record,
      fields: layer.fields.map(field => ({ name: field.name, kind: field.kind })),
      renderers: layer.renderers.map(renderer => ({
        kind: renderer.kind,
        material: renderer.material,
        texture: renderer.texture,
        billboard: renderer.billboard,
        blend: renderer.blend,
        atlas: [...renderer.atlas],
        size2d: renderer.size2d,
        flipUvs: renderer.flipUvs,
        inputs: { ...renderer.inputs },
      })),
      samplers: layer.samplers.map(sampler => JSON.parse(JSON.stringify(sampler)) as JsonValue),
      scripts: scriptsOf(layer).map(({ role, script }) => ({
        role,
        instructions: script.code.length,
        constants: script.constants.length,
        externals: script.externals.map(external => external.name),
        functions: [...script.functions],
      })),
      outputPayloads: Object.fromEntries(Object.entries(layer.outputPayloads).map(([event, names]) => [event, [...names]])),
      inputPayloads: [...layer.inputPayloads],
      spatialLayers: [...layer.spatialLayers],
      ...(layer.warnings.length === 0 ? {} : { warnings: [...layer.warnings] }),
    })),
    graph: {
      slots: effect.slots.map(slot => ({ layer: slot.layer, inputEvents: [...slot.inputEvents], outputEvents: [...slot.outputEvents] })),
      events: effect.events.map(event => ({ name: event.name, targetSlots: [...event.targetSlots] })),
    },
    classes: effect.classes.map(item => ({ name: item.name, count: item.count })),
    ...(effect.warnings.length === 0 ? {} : { warnings: [...effect.warnings] }),
  }
}

const definition = Object.freeze({
  id: ID,
  format: Object.freeze({ id: 'war3-pkb', label: 'PopcornFX bake' }),
  operations,
  async detect(prefix: Uint8Array) {
    return PkbBake.detect(prefix)
      ? { confidence: 0.99, kind: 'magic', note: 'pkb-magic' }
      : { confidence: 0, kind: 'magic', note: 'pkb-magic-missing' }
  },
  async inspect(bytes: Uint8Array, context: InspectionContext) {
    context.signal?.throwIfAborted()
    const bake = PkbBake.read(bytes, context.signal)
    if (bake.count > context.budget.maxNodes) throw new RangeError('PopcornFX bake exceeds maxNodes budget')
    const effect = pkEffectOf(bake, context.signal)
    const renderers = effect.layers.reduce((sum, layer) => sum + layer.renderers.length, 0)
    return {
      summary: {
        format: 'war3-pkb',
        version: effect.version,
        records: bake.count,
        layers: effect.layers.length,
        renderers,
        events: effect.events.length,
      },
      metadata: [
        {
          id: 'war3-pkb',
          label: 'PopcornFX bake',
          entries: [
            { key: 'records', value: bake.count },
            { key: 'classes', value: effect.classes.length },
            { key: 'layers', value: effect.layers.length },
            { key: 'renderers', value: renderers },
            { key: 'events', value: effect.events.length },
          ],
        },
      ],
      traits: [{ id: 'content.binary', parameters: { bytes: String(bytes.byteLength) } }],
      handlers: {
        'export-convert': (async () => ({ kind: 'json', value: war3PkbJson(effect) })) satisfies HostOperationHandler,
      },
      dataSources: {
        'common.view/table-data-source': createTableDataSource({
          header: [...LAYER_COLUMNS],
          rows: effect.layers.map(layerRow),
        }),
        'common.view/tree-data-source': createTreeDataSource({
          kind: 'effect',
          label: 'PopcornFX effect',
          preview: `${String(effect.layers.length)} layers, ${String(renderers)} renderers`,
          children: [
            {
              kind: 'layers',
              label: 'Layers',
              preview: String(effect.layers.length),
              children: effect.layers.map(layer => ({
                kind: 'layer',
                label: layer.name,
                preview: layerRow(layer).slice(1).filter(Boolean).join(', '),
                children: () => [
                  ...layer.renderers.map(renderer => ({
                    kind: 'renderer',
                    label: `${renderer.kind} renderer`,
                    preview: [renderer.texture, renderer.billboard, renderer.blend, `atlas ${renderer.atlas.join('×')}`].filter(Boolean).join(', '),
                    children: Object.entries(renderer.inputs).map(([input, field]) => ({
                      kind: 'input',
                      label: input,
                      preview: layer.fields[field]?.name ?? String(field),
                    })),
                  })),
                  ...layer.samplers.map(sampler => ({ kind: 'sampler', label: sampler.name, preview: samplerPreview(sampler) })),
                  ...scriptsOf(layer).map(({ role, script }) => ({
                    kind: 'script',
                    label: `${role} script`,
                    preview: `${String(script.code.length)} instructions, ${String(script.constants.length)} constants`,
                    children: [
                      ...script.externals.map(external => ({ kind: 'external', label: external.name, preview: external.type })),
                      ...script.functions.map(fn => ({ kind: 'function', label: fn })),
                    ],
                  })),
                  {
                    kind: 'fields',
                    label: 'Fields',
                    preview: String(layer.fields.length),
                    children: layer.fields.map(field => ({ kind: 'field', label: field.name, preview: `kind 0x${field.kind.toString(16)}` })),
                  },
                  ...Object.entries(layer.outputPayloads).map(([event, names]) => ({ kind: 'event', label: event, preview: names.join(', ') })),
                  ...layer.warnings.map(warning => ({ kind: 'warning', label: warning })),
                ],
              })),
            },
            {
              kind: 'events',
              label: 'Events',
              preview: String(effect.events.length),
              children: effect.events.map((event, index) => ({
                kind: 'event',
                label: event.name === '' ? `event ${String(index)}` : event.name,
                preview: `slots ${event.targetSlots.join(', ')}`,
              })),
            },
            {
              kind: 'classes',
              label: 'Record classes',
              preview: String(effect.classes.length),
              children: effect.classes.map(item => ({ kind: 'class', label: item.name, preview: String(item.count) })),
            },
          ],
        }),
      },
      unsupportedFeatures: ['effect-simulation'],
    }
  },
})

export const abiVersion = 1
export const createCodec = (context: unknown): unknown =>
  (createInspectionCodec as (definition: unknown, context: unknown) => unknown)(definition, context)
