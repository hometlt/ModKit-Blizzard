/**
 * SC2Layout summary as narrow domain values: metadata groups, capability traits and the
 * single-file findings. The native codec projects these directly; the legacy descriptor in
 * `describe.ts` wraps them.
 */

import { inspectSc2Layout, type Sc2LayoutDocument } from './document.js'
import { layoutBasename, SC2_GAME_ID, SC2_LAYOUT_CODEC_ID } from './identity.js'

export const SC2_LAYOUT_WORKSPACE_DIAGNOSTIC_ID = 'sc2-layout.workspace.unresolved'
export const SC2_LAYOUT_VISUAL_RENDER_DIAGNOSTIC_ID = 'sc2-layout.visual-render.unavailable'
export const SC2_LAYOUT_LANGUAGE_DIAGNOSTIC_ID = 'sc2-layout.language.schema-required'
export const SC2_LAYOUT_EDIT_DIAGNOSTIC_ID = 'sc2-layout.edit.transaction-unavailable'

type Scalar = string | number | boolean

export interface Sc2LayoutMetadataEntry {
  readonly id: string
  readonly label: string
  readonly value: Scalar | readonly string[]
  readonly kind?: 'text' | 'path' | 'id' | 'number' | 'boolean' | 'list'
}

export interface Sc2LayoutMetadataGroup {
  readonly id: string
  readonly label: string
  readonly order: number
  readonly entries: readonly Sc2LayoutMetadataEntry[]
}

export interface Sc2LayoutTrait {
  readonly id: string
  readonly version: number
  readonly state: 'available' | 'partial' | 'dependency-required'
  readonly parameters: Readonly<Record<string, Scalar>>
  readonly diagnosticIds?: readonly string[]
}

export interface Sc2LayoutFinding {
  readonly id: string
  readonly severity: 'warning' | 'info'
  /** Historical dotted code, e.g. `sc2-layout.workspace-not-resolved`. */
  readonly code: string
  readonly category: 'missing-companion' | 'runtime-unavailable'
  readonly message: string
  readonly detail?: Readonly<Record<string, Scalar>>
}

function entry(
  id: string,
  label: string,
  value: Sc2LayoutMetadataEntry['value'],
  kind?: Sc2LayoutMetadataEntry['kind'],
): Sc2LayoutMetadataEntry {
  return { id, label, value, ...(kind === undefined ? {} : { kind }) }
}

export function sc2LayoutDiagnostics(document: Sc2LayoutDocument): readonly Sc2LayoutFinding[] {
  const dependencyCount = document.stats.includeCount + document.stats.templateCount
  return [
    {
      id: SC2_LAYOUT_WORKSPACE_DIAGNOSTIC_ID,
      severity: dependencyCount > 0 ? 'warning' : 'info',
      code: 'sc2-layout.workspace-not-resolved',
      category: 'missing-companion',
      message:
        'This descriptor covers one source file only; templates, includes, hookups, and dependency overrides have not been resolved through a schema-backed Store.',
      detail: {
        declaredIncludes: document.stats.includeCount,
        declaredTemplates: document.stats.templateCount,
      },
    },
    {
      id: SC2_LAYOUT_VISUAL_RENDER_DIAGNOSTIC_ID,
      severity: 'info',
      code: 'sc2-layout.visual-render-unavailable',
      category: 'runtime-unavailable',
      message:
        'The visual render pipeline in src/rendering is not exposed until a browser-safe schema/workspace integration is attached.',
    },
    {
      id: SC2_LAYOUT_LANGUAGE_DIAGNOSTIC_ID,
      severity: 'info',
      code: 'sc2-layout.language-schema-required',
      category: 'runtime-unavailable',
      message:
        'Schema validation, completion, navigation, and reference analysis remain in the full layout language workspace.',
    },
    {
      id: SC2_LAYOUT_EDIT_DIAGNOSTIC_ID,
      severity: 'info',
      code: 'sc2-layout.edit-catalog-context-required',
      category: 'missing-companion',
      message:
        'Codec-owned reference-rename transactions are available through sc2-mod, which supplies the shared catalog rename routing and applies all child edits together.',
    },
  ]
}

export function sc2LayoutTraits(document: Sc2LayoutDocument): readonly Sc2LayoutTrait[] {
  const dependencies = document.stats.includeCount
  return [
    {
      id: 'game.layout',
      version: 1,
      state: 'partial',
      parameters: {
        game: SC2_GAME_ID,
        parsed: true,
        resolved: false,
        visuallyRendered: false,
      },
      diagnosticIds: [SC2_LAYOUT_WORKSPACE_DIAGNOSTIC_ID],
    },
    {
      id: 'code.source',
      version: 1,
      state: 'available',
      parameters: { language: 'sc2layout', encoding: 'utf-8' },
    },
    {
      id: 'content.text',
      version: 1,
      state: 'available',
      parameters: { language: 'xml', encoding: 'utf-8', bytes: document.bytes.byteLength },
    },
    {
      id: 'content.metadata',
      version: 1,
      state: 'available',
      parameters: { format: SC2_LAYOUT_CODEC_ID },
    },
    {
      id: 'structure.hierarchy',
      version: 1,
      state: 'available',
      parameters: { nodes: document.stats.frameCount, lazy: false },
    },
    {
      id: 'document.outline',
      version: 1,
      state: 'available',
      parameters: { count: document.stats.frameCount },
    },
    {
      id: 'source.dependencies',
      version: 1,
      state: dependencies === 0 ? 'available' : 'dependency-required',
      parameters: { count: dependencies, resolved: dependencies === 0 },
      ...(dependencies === 0 ? {} : { diagnosticIds: [SC2_LAYOUT_WORKSPACE_DIAGNOSTIC_ID] }),
    },
  ]
}

export function sc2LayoutMetadata(document: Sc2LayoutDocument): readonly Sc2LayoutMetadataGroup[] {
  const summary = inspectSc2Layout(document)
  return [
    {
      id: 'identity',
      label: 'Layout',
      order: 10,
      entries: [
        entry('name', 'Name', layoutBasename(document.source.path), 'text'),
        entry('path', 'Path', document.source.path, 'path'),
        entry('codec', 'Codec', SC2_LAYOUT_CODEC_ID, 'id'),
      ],
    },
    {
      id: 'structure',
      label: 'Parsed structure',
      order: 20,
      entries: [
        entry('frames', 'Frames', summary.stats.frameCount, 'number'),
        entry('topLevelFrames', 'Top-level frames', summary.stats.topLevelFrameCount, 'number'),
        entry('properties', 'Properties', summary.stats.propertyCount, 'number'),
        entry('anchors', 'Anchors', summary.stats.anchorCount, 'number'),
        entry('constants', 'Constants', summary.stats.constantCount, 'number'),
        entry('animations', 'Animations', summary.stats.animationCount, 'number'),
        entry('references', 'References', summary.stats.referenceCount, 'number'),
      ],
    },
    {
      id: 'dependencies',
      label: 'Declared dependencies',
      order: 30,
      entries: [
        entry('includes', 'Includes', summary.includes, 'list'),
        entry('templates', 'Templates', summary.templates, 'list'),
        entry('resolved', 'Workspace resolved', false, 'boolean'),
      ],
    },
  ]
}

