import { addM3FieldTracks } from '../../../dist/m3/uvm/field-tracks.js'
import { schemaText } from './schema.js'
import { M3SectionList } from '../../../dist/m3/native/binary/sections.js'
import { snapshotJson } from '@modkit/codec-kit/json-snapshot'
import { buildM3RenderEffects } from '../../../dist/m3/native/builder/effects.js'
import { M3AnimationReferenceTrackExtractor } from '../../../dist/m3/native/animation/tracks.js'
import { buildParticles, buildRibbons, buildForces, buildWarps, buildProjections } from '../../../dist/m3/native/builder/metadata.js'

/** Versioned PAR_/PARC/RIB_/FOR_/WRP_/PROJ extraction is the pinned implementation.
 * Geometry is the REGN projection before material batch expansion. No simulation runs here. */
export function projectM3Effects(sections, primitives, budget, signal) {
  signal?.throwIfAborted()
  for (const key of ['maxNodes', 'maxScalarBytes', 'maxDepth']) {
    if (!Number.isSafeInteger(budget[key]) || budget[key] <= 0)
      throw new RangeError(`M3 effects budget ${key} must be positive`)
  }
  const model = sections.model
  if (model === null) throw new TypeError('M3 effects require a native model record')
  let records = 0
  for (const field of [
    'particle_systems',
    'particle_copies',
    'ribbons',
    'forces',
    'warps',
    'projections',
  ]) {
    const reference = model[field]
    const count = reference?.entries ?? 0
    if (!Number.isSafeInteger(count) || count < 0 || (records += count) > budget.maxNodes)
      throw new RangeError('M3 effects records exceed node budget')
    if (count > 0 && sections.getSectionByReference(reference)?.content.length !== count)
      throw new TypeError(`M3 effects ${field} reference is incomplete`)
  }
  let meshBytes = 0
  const meshes = primitives.map(primitive => {
    meshBytes += primitive.positions.byteLength + primitive.indices.byteLength
    if (meshBytes > budget.maxScalarBytes)
      throw new RangeError('M3 effect emission meshes exceed byte budget')
    const region = /^mesh-0-primitive-(\d+)$/.exec(primitive.id)?.[1]
    if (region === undefined) throw new TypeError('M3 effects require explicit REGN primitive IDs')
    return {
      name: `M3_Region_${region}`,
      materialIndex: 0,
      primitiveTopology: primitive.topology,
      positions: primitive.positions,
      indices: primitive.indices,
    }
  })
  const conversion = buildM3RenderEffects(
    model,
    sections,
    buildParticles(model, sections),
    buildRibbons(model, sections),
    buildForces(model, sections),
    buildWarps(model, sections),
    buildProjections(model, sections),
    meshes,
  )
  const byPositions = new Map(primitives.map(primitive => [primitive.positions, primitive]))
  const emissionMeshes = []
  for (const [particle, emitter] of conversion.effects.particles.entries()) {
    for (const [mesh, geometry] of (emitter.emitShapeMeshes ?? []).entries()) {
      signal?.throwIfAborted()
      if (emissionMeshes.length >= budget.maxNodes)
        throw new RangeError('M3 emission mesh correspondences exceed node budget')
      const primitive = byPositions.get(geometry.positions)
      if (primitive === undefined || primitive.indices !== geometry.indices)
        throw new TypeError('M3 emission mesh lacks its native REGN buffer identity')
      emissionMeshes.push({ particle, mesh, regionId: primitive.id })
    }
  }
  // Only emission meshes contain typed arrays. Carry them as bounded owned numeric arrays
  // across the converter boundary, then store them in UVM binary accessors.
  const extractor = new M3AnimationReferenceTrackExtractor(model, sections)
  const effects = addM3FieldTracks(
    {
      ...conversion.effects,
      particles: conversion.effects.particles.map(particle => ({
        ...particle,
        ...(particle.emitShapeMeshes === undefined
          ? {}
          : {
              emitShapeMeshes: particle.emitShapeMeshes.map(mesh => ({
                positions: [...mesh.positions],
                indices: [...mesh.indices],
              })),
            }),
      })),
    },
    sections,
    reference => extractor.extract(reference),
    budget,
    signal,
  )
  return snapshotJson(
    {
      effects,
      particleLighting: conversion.particleLighting,
      diagnostics: conversion.diagnostics,
      animationMetadata: conversion.animationMetadata,
      emissionMeshes,
    },
    { maxDepth: budget.maxDepth, maxNodes: budget.maxNodes, maxBytes: budget.maxScalarBytes },
    signal,
  )
}

export async function decodeM3Effects(bytes, budget, signal, primitives = []) {
  signal?.throwIfAborted()
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.length > budget.maxInputBytes ||
    bytes.length > budget.maxScalarBytes
  )
    throw new RangeError('M3 effects source exceeds input budget')
  if (bytes.length < 24) throw new TypeError('M3 effects source header is truncated')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const offset = view.getUint32(4, true),
    count = view.getUint32(8, true)
  if (count === 0 || count > budget.maxNodes || offset + count * 16 > bytes.length)
    throw new RangeError('M3 effects section index exceeds budget')
  const snapshot = Uint8Array.from(bytes)
  const sections = await M3SectionList.load(snapshot.buffer, schemaText())
  return projectM3Effects(sections, primitives, budget, signal)
}
