import { describe, expect, it } from 'vitest'

import {
  canonicalSc2PackagePath,
  sc2BuiltinDependencyClosure,
  sc2BuiltinDocumentInfo,
  sc2InstallationDependencies,
} from '../shared/workspace/implicit-dependencies.js'

describe('SC2 engine package dependencies', () => {
  it('normalizes CASC URIs and DocumentInfo references without losing package kind', () => {
    expect(
      canonicalSc2PackagePath(
        'modkit-container:/c:/Apps/StarCraft%20II!/Campaigns/VoidStory.SC2Campaign',
      ),
    ).toBe('Campaigns/VoidStory.SC2Campaign')
    expect(
      canonicalSc2PackagePath(
        'bnet:Void (Mod)/0.0/999,file:Mods\\Void.SC2Mod',
      ),
    ).toBe('Mods/Void.SC2Mod')
  })

  it('keeps an installation-relative path whole when a mod nests its own mods folder', () => {
    const backslash = String.fromCharCode(92)
    expect(
      canonicalSc2PackagePath(['file:Mods', 'tiberium-crossover', 'mods', 'tib-data.SC2Mod'].join(backslash)),
    ).toBe('Mods/tiberium-crossover/mods/tib-data.SC2Mod')
    // A host path has no installation root to cut at; the nearest package folder still names it.
    expect(canonicalSc2PackagePath('file:///C:/Games/Mods/Custom.SC2Mod')).toBe('Mods/Custom.SC2Mod')
  })

  it('resolves the complete Void mod, campaign, and story layers dependency first', () => {
    expect(sc2BuiltinDependencyClosure('Mods/Void.SC2Mod')).toEqual([
      'Mods/Core.SC2Mod',
      'Mods/Liberty.SC2Mod',
      'Mods/Swarm.SC2Mod',
    ])
    expect(sc2BuiltinDependencyClosure('Campaigns/VoidStory.SC2Campaign')).toEqual([
      'Mods/Core.SC2Mod',
      'Mods/Liberty.SC2Mod',
      'Campaigns/Liberty.SC2Campaign',
      'Mods/Swarm.SC2Mod',
      'Campaigns/Swarm.SC2Campaign',
      'Mods/Void.SC2Mod',
      'Campaigns/Void.SC2Campaign',
    ])
  })

  it('projects engine edges as an ordinary virtual DocumentInfo', () => {
    expect(sc2BuiltinDocumentInfo('Mods/Void.SC2Mod')).toContain(
      '<Value>file:Mods/Swarm.SC2Mod</Value>',
    )
    expect(sc2BuiltinDocumentInfo('Campaigns/VoidStory.SC2Campaign')).toContain(
      '<Value>file:Campaigns/Void.SC2Campaign</Value>',
    )
    expect(sc2BuiltinDocumentInfo('Mods/Core.SC2Mod')).toContain('<Dependencies>')
    expect(sc2BuiltinDocumentInfo('Mods/Custom.SC2Mod')).toBeUndefined()
  })

  it('loads only Core beneath a map or mod that declares nothing', () => {
    for (const active of ['Custom.SC2Mod', 'Maps/Custom.SC2Map', 'C:/Maps/Custom.SC2Map']) {
      expect(sc2InstallationDependencies(active, []).dependencies).toEqual([
        expect.objectContaining({ path: 'Mods/Core.SC2Mod', required: false, basis: 'engine-implicit' }),
      ])
    }
    expect(sc2InstallationDependencies('Mods/Core.SC2Mod', []).dependencies).toEqual([])
  })

  it('merges declared and engine dependencies while preserving required provenance', () => {
    const request = sc2InstallationDependencies('Custom.SC2Mod', [
      'bnet:Void Story/0.0/999,file:Campaigns/VoidStory.SC2Campaign',
    ])
    expect(request.dependencies.map(item => item.path)).toEqual([
      'Mods/Core.SC2Mod',
      'Mods/Liberty.SC2Mod',
      'Campaigns/Liberty.SC2Campaign',
      'Mods/Swarm.SC2Mod',
      'Campaigns/Swarm.SC2Campaign',
      'Mods/Void.SC2Mod',
      'Campaigns/Void.SC2Campaign',
      'Campaigns/VoidStory.SC2Campaign',
    ])
    expect(request.dependencies.at(-1)).toMatchObject({
      required: true,
      basis: 'declared',
    })
    expect(request.dependencies.slice(0, -1).every(item => !item.required)).toBe(true)
  })
})
