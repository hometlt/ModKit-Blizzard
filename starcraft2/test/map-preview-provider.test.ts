import { describe, expect, it } from 'vitest'
import { MAP_PREVIEW_PREPARATION_CONTRACT } from '@modkit/sdk/maps'
import {
  STARCRAFT2_MAP_PREVIEW_PREPARATION_ID,
  createProvider,
  prepareStarcraft2MapPreview,
} from '../modules/map/providers/preview/runtime.js'

const entry = (path: string, kind: 'file' | 'directory' = 'file') => ({
  path,
  kind,
  ...(kind === 'file' ? { size: '42' } : {}),
})

const mapEntries = (root: string) => [
  entry(`${root}/Objects`),
  entry(`${root}/Regions`),
  entry(`${root}/t3HeightMap`),
]

const subject = (
  entries: readonly ReturnType<typeof entry>[],
  options: Readonly<{
    formatId?: string
    namespaceState?: 'unavailable' | 'complete' | 'truncated'
    namespaceSource?: boolean
    extraction?: boolean
    namespaceSearches?: readonly unknown[]
  }> = {},
) => ({
  schemaVersion: 1 as const,
  subjectUri:
    options.formatId === 'sc2-map' || options.formatId === 'sc2-map-directory'
      ? 'file:///fixtures/One.SC2Map'
      : 'file:///fixtures/StarCraft%20II',
  revision: 'content-hash.sha256:fixture-sc2',
  formatId: options.formatId ?? 'casc',
  traits: ['container.entries'],
  dataSources:
    options.namespaceSource === false
      ? []
      : [{ contract: 'common.view/namespace-entry-source', major: 1 }],
  operations: options.extraction === false ? [] : [{ id: 'container.extract', state: 'available' }],
  namespace: { state: options.namespaceState ?? ('complete' as const), entries },
  ...(options.namespaceSearches === undefined
    ? {}
    : { namespaceSearches: options.namespaceSearches }),
})

const request = (
  entries: readonly ReturnType<typeof entry>[],
  options: Parameters<typeof subject>[1] = {},
  selectionId?: string,
) => {
  const openedSubject = subject(entries, options)
  const searchedEntries = (options.namespaceSearches ?? []).flatMap(search =>
    Array.isArray((search as { readonly entries?: unknown }).entries)
      ? ((search as { readonly entries: readonly ReturnType<typeof entry>[] }).entries ?? [])
      : [],
  )
  const roots = [
    ...new Set(
      [...entries, ...searchedEntries]
        .filter(
          item => item.kind === 'file' && /(?:^|[\\/])(?:objects|mapobjects)$/iu.test(item.path),
        )
        .map(item => item.path.replace(/\\/gu, '/').replace(/\/?(?:objects|mapobjects)$/iu, '')),
    ),
  ]
  return {
    subject: {
      ...openedSubject,
      documentReads: roots.map(root => ({
        documentId: 'sc2-map-document-info',
        path: root.length === 0 ? 'DocumentInfo' : `${root.toLowerCase()}/documentinfo`,
        state: 'read' as const,
        text: '<DocInfo><Dependencies/></DocInfo>',
      })),
    },
    ...(selectionId === undefined ? {} : { selectionId }),
    maxCandidates: 16,
    maxRoots: 8,
    maxDepth: 8,
  }
}

describe('StarCraft II map preview preparation', () => {
  it('publishes the stable preparation port for casc and conditional sc2-map subjects', async () => {
    const lease = await createProvider({
      contract: MAP_PREVIEW_PREPARATION_CONTRACT,
      major: 1,
    })

    expect(Object.keys(lease.value).sort()).toEqual([
      'contract',
      'preparationId',
      'prepare',
      'subjectFormatIds',
    ])
    expect(lease.value).toMatchObject({
      contract: MAP_PREVIEW_PREPARATION_CONTRACT,
      preparationId: STARCRAFT2_MAP_PREVIEW_PREPARATION_ID,
      subjectFormatIds: ['casc', 'sc2-map', 'sc2-map-directory'],
    })
    await lease.release()
    expect(() => createProvider({ contract: 'common.map/resolved-workspace', major: 1 })).toThrow(
      'unsupported StarCraft II map-preview preparation selection',
    )
  })

  it('is not applicable to another format or a complete namespace without a proved map root', async () => {
    const wrongFormat = await prepareStarcraft2MapPreview(
      request([], { formatId: 'warzone-wz', namespaceSource: false, extraction: false }),
    )
    expect(wrongFormat).toMatchObject({
      state: 'not-applicable',
      diagnostics: [{ code: expect.stringMatching(/format-not-applicable$/u) }],
    })

    const incomplete = await prepareStarcraft2MapPreview(
      request([
        entry('campaigns/liberty.sc2campaign/base.sc2maps/maps/example.sc2map/objects'),
        entry('campaigns/liberty.sc2campaign/base.sc2maps/maps/example.sc2map/regions'),
      ]),
    )
    expect(incomplete).toMatchObject({
      state: 'not-applicable',
      diagnostics: [{ code: expect.stringMatching(/map-absent$/u) }],
    })
  })

  it('accepts a standalone map whose optional Regions document is absent', async () => {
    const result = await prepareStarcraft2MapPreview(
      request([entry('Objects'), entry('t3HeightMap')], { formatId: 'sc2-map' }),
    )

    expect(result).toMatchObject({
      state: 'prepared',
      plan: {
        workspace: {
          activeRootId: 'map',
          roots: expect.arrayContaining([
            expect.objectContaining({ rootId: 'map' }),
            expect.objectContaining({ rootId: 'stock-core' }),
          ]),
        },
        resources: {
          strategy: 'host-resolved',
          resolverId: 'modkit.node/game-installation-resource-map-preview',
          subjectNamespaceRoots: [
            { rootId: 'map', namespacePrefix: '', assetRoots: ['Base.SC2Assets', '*.SC2Assets', ''] },
          ],
        },
      },
    })
    // A map that declares nothing loads Core alone: Liberty is a declaration, not a default.
    if (result.state !== 'prepared') throw new Error(JSON.stringify(result))
    expect(result.plan.workspace.roots.map(root => root.rootId)).toEqual(['map', 'stock-core'])
  })

  it('prepares one installed CASC map with an exact logical-root namespace remap', async () => {
    const root = 'Campaigns/Liberty.SC2Campaign/Base.SC2Maps/Maps/Campaign/TArcade.SC2Map'
    const preparedRequest = request([
      entry(`${root}\\Objects`),
      entry(`${root}/Regions`),
      entry(`${root}/t3HeightMap`),
      entry(`${root}/Base.SC2Data/GameData/UnitData.xml`),
    ])
    const documentRound = await prepareStarcraft2MapPreview({
      ...preparedRequest,
      subject: { ...preparedRequest.subject, documentReads: [] },
    })
    expect(documentRound).toMatchObject({
      state: 'document-read-required',
      documents: [{ documentId: 'sc2-map-document-info' }],
    })
    const result = await prepareStarcraft2MapPreview(preparedRequest)

    expect(result.state).toBe('prepared')
    if (result.state !== 'prepared') throw new Error('single installed map did not prepare')
    const normalizedRoot = root.toLowerCase()
    expect(result.plan).toMatchObject({
      schemaVersion: 1,
      workspace: {
        gameId: 'blizzard/starcraft-2',
        activeRootId: 'map',
        sources: [
          {
            sourceId: 'starcraft2-opened-subject',
            kind: 'casc-subject',
            location: 'map-preview:opened-subject',
          },
        ],
        roots: expect.arrayContaining([
          expect.objectContaining({
            rootId: 'map',
            sourceId: 'starcraft2-opened-subject',
            sourcePath: normalizedRoot,
            displayName: 'tarcade.sc2map',
            kind: 'map',
            dependencies: expect.arrayContaining([
              expect.objectContaining({ targetRootId: 'stock-liberty-campaign' }),
            ]),
          }),
          expect.objectContaining({
            rootId: 'stock-liberty-campaign',
            sourcePath: 'campaigns/liberty.sc2campaign',
          }),
          expect.objectContaining({
            rootId: 'stock-liberty',
            sourcePath: 'mods/liberty.sc2mod',
          }),
          expect.objectContaining({ rootId: 'stock-core', sourcePath: 'mods/core.sc2mod' }),
        ]),
        maxRoots: 4,
        maxDepth: 4,
      },
      resources: {
        schemaVersion: 1,
        strategy: 'subject-namespace',
        roots: expect.arrayContaining([
          { rootId: 'map', namespacePrefix: normalizedRoot },
          { rootId: 'stock-liberty-campaign', namespacePrefix: 'campaigns/liberty.sc2campaign' },
          { rootId: 'stock-liberty', namespacePrefix: 'mods/liberty.sc2mod' },
          { rootId: 'stock-core', namespacePrefix: 'mods/core.sc2mod' },
        ]),
      },
    })
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: expect.stringMatching(/document-info-closure$/u) }),
    )
    expect(JSON.parse(JSON.stringify(result))).toEqual(result)
  })

  it('expands a Void Story mission through every campaign and data release', async () => {
    const root = 'Campaigns/Void.SC2Campaign/Base.SC2Maps/Maps/Campaign/Void/PAiur01.SC2Map'
    const preparedRequest = request(mapEntries(root))
    const mapRead = preparedRequest.subject.documentReads[0]
    const dependencyRound = await prepareStarcraft2MapPreview({
      ...preparedRequest,
      maxRoots: 16,
      maxDepth: 16,
      subject: {
        ...preparedRequest.subject,
        documentReads: [{
          ...mapRead,
          text: '<DocInfo><Dependencies><Value>bnet:Void Story (Campaign)/0.0/999,file:Campaigns/VoidStory.SC2Campaign</Value></Dependencies></DocInfo>',
        }],
      },
    })
    expect(dependencyRound.state).toBe('document-read-required')
    if (dependencyRound.state !== 'document-read-required') {
      throw new Error(JSON.stringify(dependencyRound))
    }
    const result = await prepareStarcraft2MapPreview({
      ...preparedRequest,
      maxRoots: 16,
      maxDepth: 16,
      subject: {
        ...preparedRequest.subject,
        documentReads: [
          {
            ...mapRead,
            text: '<DocInfo><Dependencies><Value>bnet:Void Story (Campaign)/0.0/999,file:Campaigns/VoidStory.SC2Campaign</Value></Dependencies></DocInfo>',
          },
          ...dependencyRound.documents.map(document => ({
            documentId: document.documentId,
            path: document.path,
            state: 'missing' as const,
          })),
        ],
      },
    })
    expect(result.state).toBe('prepared')
    if (result.state !== 'prepared') throw new Error(JSON.stringify(result))
    expect(result.plan.workspace.roots.map(item => item.sourcePath)).toEqual(
      expect.arrayContaining([
        'mods/core.sc2mod',
        'mods/liberty.sc2mod',
        'campaigns/liberty.sc2campaign',
        'mods/swarm.sc2mod',
        'campaigns/swarm.sc2campaign',
        'mods/void.sc2mod',
        'campaigns/void.sc2campaign',
        'campaigns/voidstory.sc2campaign',
      ]),
    )
  })

  it('keeps a loose map in its subject namespace and host-resolves installed dependencies', async () => {
    const base = request([entry('Objects'), entry('Regions'), entry('t3HeightMap')], {
      formatId: 'sc2-map-directory',
    })
    const prepared = await prepareStarcraft2MapPreview({
      ...base,
      subject: {
        ...base.subject,
        documentReads: [
          {
            documentId: 'sc2-map-document-info',
            path: 'DocumentInfo',
            state: 'read',
            text: '<DocInfo><Dependencies><Value>bnet:Custom (Mod)/0.0/1,file:Mods/Custom.SC2Mod</Value></Dependencies></DocInfo>',
          },
        ],
      },
    })

    expect(prepared).toMatchObject({
      state: 'prepared',
      plan: {
        workspace: {
          roots: expect.arrayContaining([
            expect.objectContaining({ rootId: 'map' }),
            expect.objectContaining({ rootId: 'stock-core', sourcePath: 'mods/core.sc2mod' }),
            expect.objectContaining({ sourcePath: 'mods/custom.sc2mod' }),
          ]),
        },
        resources: {
          strategy: 'host-resolved',
          resolverId: 'modkit.node/game-installation-resource-map-preview',
          subjectNamespaceRoots: [
            { rootId: 'map', namespacePrefix: '', assetRoots: ['Base.SC2Assets', '*.SC2Assets', ''] },
          ],
          roots: expect.arrayContaining([
            expect.objectContaining({
              locator: expect.objectContaining({
                kind: 'game-installation-subject',
                relativePaths: ['mods/custom.sc2mod'],
                namespaceFallbackPrefix: 'mods/custom.sc2mod',
              }),
            }),
          ]),
        },
      },
    })
  })

  it('reaches every root from the map when a dependency names a nested mods folder', async () => {
    // mission-nod.SC2Map: an installed mod keeps its own packages below Mods/tiberium-crossover, written
    // with backslashes; every root the plan names must hang off the map, or the host refuses the workspace.
    const base = request([entry('Objects'), entry('Regions'), entry('t3HeightMap')], { formatId: 'sc2-map-directory' })
    const prepared = await prepareStarcraft2MapPreview({
      ...base,
      subject: {
        ...base.subject,
        documentReads: [{
          documentId: 'sc2-map-document-info',
          path: 'DocumentInfo',
          state: 'read',
          text: [
            '<DocInfo><Dependencies>',
            '<Value>bnet:Void (Mod)/0.0/999,file:Mods/Void.SC2Mod</Value>',
            '<Value>file:Mods\\tiberium-crossover\\assets\\tib-assets-campaign.SC2Mod</Value>',
            '<Value>file:Mods\\tiberium-crossover\\mods\\tib-data.SC2Mod</Value>',
            '</Dependencies></DocInfo>',
          ].join(''),
        }],
      },
    })
    expect(prepared.state).toBe('prepared')
    if (prepared.state !== 'prepared') throw new Error(JSON.stringify(prepared))
    const roots = prepared.plan.workspace.roots
    const byId = new Map(roots.map(root => [root.rootId, root]))
    const reached = new Set<string>()
    const visit = (rootId: string): void => {
      if (reached.has(rootId)) return
      reached.add(rootId)
      for (const dependency of byId.get(rootId)?.dependencies ?? []) visit(dependency.targetRootId)
    }
    visit('map')
    expect(roots.map(root => root.rootId).filter(rootId => !reached.has(rootId))).toEqual([])
    expect(roots.map(root => root.sourcePath)).toEqual(expect.arrayContaining([
      'mods/tiberium-crossover/mods/tib-data.sc2mod',
      'mods/tiberium-crossover/assets/tib-assets-campaign.sc2mod',
      'mods/void.sc2mod',
    ]))
    expect(prepared.plan.resources.roots.map(root => root.rootId).sort()).toEqual(roots.filter(root => root.rootId !== 'map').map(root => root.rootId).sort())
  })

  it('mounts the stock releases below a declared one, whose DocumentInfo lives in the installation', async () => {
    // A melee map declares Void only. Swarm defines assets Void maps use (KorhalCity1), and its own
    // DocumentInfo is inside the installation, so nothing else would mount it.
    const base = request([entry('Objects'), entry('Regions'), entry('t3HeightMap')], {
      formatId: 'sc2-map',
    })
    const prepared = await prepareStarcraft2MapPreview({
      ...base,
      subject: {
        ...base.subject,
        documentReads: [
          {
            documentId: 'sc2-map-document-info',
            path: 'DocumentInfo',
            state: 'read',
            text: '<DocInfo><Dependencies><Value>bnet:Void (Mod)/0.0/999,file:Mods/Void.SC2Mod</Value></Dependencies></DocInfo>',
          },
        ],
      },
    })

    expect(prepared.state).toBe('prepared')
    if (prepared.state !== 'prepared') throw new Error(JSON.stringify(prepared))
    const roots = prepared.plan.workspace.roots.map(root => root.sourcePath)
    expect(roots).toEqual(
      expect.arrayContaining([
        'mods/core.sc2mod',
        'mods/liberty.sc2mod',
        'mods/swarm.sc2mod',
        'mods/void.sc2mod',
      ]),
    )
    // Swarm sits on Liberty, and the declared Void root keeps its place on Swarm.
    expect(
      prepared.plan.workspace.roots.find(root => root.sourcePath === 'mods/swarm.sc2mod')
        ?.dependencies,
    ).toEqual([expect.objectContaining({ targetRootId: 'stock-liberty' })])
  })

  it('follows dependency DocumentInfo files and preserves dependency-first graph edges', async () => {
    const root = 'maps/custom.sc2map'
    const initial = request(mapEntries(root))
    const mapRead = initial.subject.documentReads[0]
    const withDirectDependency = {
      ...initial,
      subject: {
        ...initial.subject,
        documentReads: [
          {
            ...mapRead,
            text: '<DocInfo><Dependencies><Value>bnet:Custom (Mod)/0.0/1,file:Mods/Custom.SC2Mod</Value></Dependencies></DocInfo>',
          },
        ],
      },
    }
    const dependencyRound = await prepareStarcraft2MapPreview(withDirectDependency)
    expect(dependencyRound).toMatchObject({
      state: 'document-read-required',
      documents: [{ path: 'mods/custom.sc2mod/documentinfo' }],
    })
    if (dependencyRound.state !== 'document-read-required') {
      throw new Error('custom dependency did not request its DocumentInfo')
    }
    const dependencyReads = [
      ...withDirectDependency.subject.documentReads,
      {
        documentId: dependencyRound.documents[0].documentId,
        path: dependencyRound.documents[0].path,
        state: 'read' as const,
        text: '<DocInfo><Dependencies><Value>bnet:Core (Mod)/0.0/1,file:Mods/Core.SC2Mod</Value></Dependencies></DocInfo>',
      },
    ]
    let prepared = await prepareStarcraft2MapPreview({
      ...withDirectDependency,
      subject: {
        ...withDirectDependency.subject,
        documentReads: dependencyReads,
      },
    })
    if (prepared.state === 'document-read-required') {
      expect(prepared.documents).toEqual([
        expect.objectContaining({ path: 'mods/core.sc2mod/documentinfo' }),
      ])
      prepared = await prepareStarcraft2MapPreview({
        ...withDirectDependency,
        subject: {
          ...withDirectDependency.subject,
          documentReads: [
            ...dependencyReads,
            ...prepared.documents.map(document => ({
              documentId: document.documentId,
              path: document.path,
              state: 'read' as const,
              text: '<DocInfo><Dependencies/></DocInfo>',
            })),
          ],
        },
      })
    }
    expect(prepared).toMatchObject({
      state: 'prepared',
      plan: {
        workspace: {
          roots: expect.arrayContaining([
            expect.objectContaining({
              rootId: 'map',
              dependencies: expect.arrayContaining([
                expect.objectContaining({ ref: 'mods/custom.sc2mod' }),
              ]),
            }),
            expect.objectContaining({
              sourcePath: 'mods/custom.sc2mod',
              dependencies: expect.arrayContaining([
                expect.objectContaining({ targetRootId: 'stock-core' }),
              ]),
            }),
          ]),
        },
      },
      diagnostics: [{ code: expect.stringMatching(/document-info-closure$/u) }],
    })
  })

  it('requires an opaque deterministic selection for multiple complete roots', async () => {
    const alpha = 'campaigns/liberty.sc2campaign/base.sc2maps/maps/alpha.sc2map'
    const zulu = 'campaigns/liberty.sc2campaign/base.sc2maps/maps/zulu.sc2map'
    const entries = [...mapEntries(zulu), ...mapEntries(alpha)]
    const selection = await prepareStarcraft2MapPreview(request(entries))
    expect(selection.state).toBe('selection-required')
    if (selection.state !== 'selection-required') throw new Error('selection was not requested')
    expect(selection.candidates.map(candidate => candidate.sourcePath)).toEqual([alpha, zulu])
    expect(
      selection.candidates.every(candidate => !candidate.candidateId.includes('.sc2map')),
    ).toBe(true)

    const reordered = await prepareStarcraft2MapPreview(request([...entries].reverse()))
    expect(reordered).toMatchObject({
      state: 'selection-required',
      candidates: selection.candidates,
    })
    const chosen = selection.candidates[1]
    const prepared = await prepareStarcraft2MapPreview(request(entries, {}, chosen.candidateId))
    expect(prepared).toMatchObject({
      state: 'prepared',
      plan: {
        workspace: {
          roots: expect.arrayContaining([expect.objectContaining({ sourcePath: zulu })]),
        },
        resources: {
          roots: expect.arrayContaining([{ rootId: 'map', namespacePrefix: zulu }]),
        },
      },
    })

    const unknown = await prepareStarcraft2MapPreview(request(entries, {}, 'sc2-map:not-issued'))
    expect(unknown).toMatchObject({
      state: 'unresolved',
      diagnostics: [{ code: expect.stringMatching(/selection-invalid$/u) }],
    })
  })

  it('never guesses from a truncated CASC listing but accepts a selected fully proved root', async () => {
    const root = 'campaigns/liberty.sc2campaign/base.sc2maps/maps/campaign/tarcade.sc2map'
    const complete = await prepareStarcraft2MapPreview(request(mapEntries(root)))
    expect(complete.state).toBe('prepared')
    if (complete.state !== 'prepared') throw new Error('complete root did not prepare')

    const truncated = await prepareStarcraft2MapPreview(
      request(mapEntries(root), { namespaceState: 'truncated' }),
    )
    expect(truncated).toMatchObject({
      state: 'namespace-search-required',
      searches: [
        {
          searchId: 'sc2-map-marker-documents',
          query: {
            kind: 'basename-any',
            basenames: ['mapheightmap', 'mapobjects', 'objects', 'regions', 't3heightmap'],
            caseSensitive: false,
          },
        },
      ],
      diagnostics: [{ code: expect.stringMatching(/indexed-marker-search-required$/u) }],
    })
    if (truncated.state !== 'namespace-search-required') {
      throw new Error('truncated root did not request an indexed search')
    }
    expect(JSON.parse(JSON.stringify(truncated))).toEqual(truncated)

    const searchedOptions = {
      namespaceState: 'truncated' as const,
      namespaceSearches: [
        {
          searchId: truncated.searches[0].searchId,
          state: 'truncated',
          entries: mapEntries(root),
        },
      ],
    }
    const selection = await prepareStarcraft2MapPreview(request([], searchedOptions))
    expect(selection).toMatchObject({
      state: 'selection-required',
      candidates: [{ sourcePath: root }],
      diagnostics: [{ code: expect.stringMatching(/truncated-selection-required$/u) }],
    })
    if (selection.state !== 'selection-required') {
      throw new Error('truncated search did not require explicit selection')
    }
    const selected = await prepareStarcraft2MapPreview(
      request([], searchedOptions, selection.candidates[0].candidateId),
    )
    expect(selected).toMatchObject({
      state: 'prepared',
      diagnostics: [
        { code: expect.stringMatching(/truncated-selection-confirmed$/u) },
        { code: expect.stringMatching(/document-info-closure$/u) },
      ],
    })

    const noProof = await prepareStarcraft2MapPreview(
      request([], {
        namespaceState: 'truncated',
        namespaceSearches: [
          {
            searchId: 'sc2-map-marker-documents',
            state: 'truncated',
            entries: [entry(`${root}/objects`)],
          },
        ],
      }),
    )
    expect(noProof).toMatchObject({
      state: 'unresolved',
      diagnostics: [{ code: expect.stringMatching(/prefix-discovery-required$/u) }],
    })

    const unsupported = await prepareStarcraft2MapPreview(
      request([], {
        namespaceState: 'truncated',
        namespaceSearches: [
          { searchId: 'sc2-map-marker-documents', state: 'unsupported', entries: [] },
        ],
      }),
    )
    expect(unsupported).toMatchObject({
      state: 'unresolved',
      diagnostics: [{ code: expect.stringMatching(/indexed-marker-search-unsupported$/u) }],
    })
  })

  it('prepares a standalone namespace root only when the codec really exposes extraction', async () => {
    const entries = [entry('MapObjects'), entry('Regions'), entry('MapHeightMap')]
    const unavailable = await prepareStarcraft2MapPreview(
      request(entries, { formatId: 'sc2-map', extraction: false }),
    )
    expect(unavailable).toMatchObject({
      state: 'unresolved',
      diagnostics: [{ code: expect.stringMatching(/standalone-extraction-unavailable$/u) }],
    })

    const prepared = await prepareStarcraft2MapPreview(request(entries, { formatId: 'sc2-map' }))
    expect(prepared.state).toBe('prepared')
    if (prepared.state !== 'prepared') throw new Error('extractable standalone map did not prepare')
    expect(prepared.plan).toMatchObject({
      workspace: {
        roots: expect.arrayContaining([
          expect.objectContaining({
            sourcePath: expect.stringMatching(/^opened\/[0-9a-f]{16}\.sc2map$/u),
            displayName: 'One.SC2Map',
          }),
          expect.objectContaining({ rootId: 'stock-core' }),
        ]),
      },
      resources: {
        strategy: 'host-resolved',
        resolverId: 'modkit.node/game-installation-resource-map-preview',
        subjectNamespaceRoots: [
            { rootId: 'map', namespacePrefix: '', assetRoots: ['Base.SC2Assets', '*.SC2Assets', ''] },
          ],
      },
    })
  })

  it('fails closed on missing capabilities, candidate overflow and unsafe paths', async () => {
    const root = 'campaigns/liberty.sc2campaign/base.sc2maps/maps/one.sc2map'
    const missingNamespace = await prepareStarcraft2MapPreview(
      request(mapEntries(root), { namespaceSource: false }),
    )
    expect(missingNamespace).toMatchObject({
      state: 'unresolved',
      diagnostics: [{ code: expect.stringMatching(/namespace-unavailable$/u) }],
    })

    const missingExtract = await prepareStarcraft2MapPreview(
      request(mapEntries(root), { extraction: false }),
    )
    expect(missingExtract).toMatchObject({
      state: 'unresolved',
      diagnostics: [{ code: expect.stringMatching(/extraction-unavailable$/u) }],
    })

    const overflow = await prepareStarcraft2MapPreview({
      ...request([
        ...mapEntries(root),
        ...mapEntries('campaigns/liberty.sc2campaign/base.sc2maps/maps/two.sc2map'),
      ]),
      maxCandidates: 1,
    })
    expect(overflow).toMatchObject({
      state: 'selection-required',
      candidates: [{ sourcePath: root }],
      diagnostics: [{ code: expect.stringMatching(/candidate-list-truncated$/u) }],
    })

    const unsafe = await prepareStarcraft2MapPreview(
      request([...mapEntries('../escape.sc2map'), ...mapEntries(root)]),
    )
    expect(unsafe).toMatchObject({
      state: 'prepared',
      diagnostics: [
        { code: expect.stringMatching(/namespace-paths-refused$/u) },
        { code: expect.stringMatching(/document-info-closure$/u) },
      ],
    })
  })
})
