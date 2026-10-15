import { createInspectionCodec, type InspectionTreeNode } from '@modkit/codec-kit'
import {
  createEditorXmlDocumentDefinition,
  editorXmlDocumentOperations,
  xmlElementNode,
} from '../../../../shared/documents/editor-xml-document-codec.js'
import {
  readAIData,
  writeEditorLayout,
  type AIDataResult,
  type CustomAiStep,
  type DifficultyValues,
} from '../../../../shared/format/formats/ai-data.js'

const perLevel = (values: DifficultyValues): string => values.map(({ level, value }) => `${level}:${value}`).join(' ')

function stepNode(step: CustomAiStep, path: readonly string[]): InspectionTreeNode {
  const label = step.type === 'Comment' ? `Comment ${step.text ?? ''}`.trim() : `${step.type}${step.id === undefined ? '' : ` ${step.id}`}`
  const flags = [step.noWait && 'no wait', step.onceOnly && 'once only', step.createUnits && 'create units'].filter(Boolean)
  const preview = step.type === 'Comment'
    ? ''
    : [`${step.units.length} unit types`, `${step.points.length} points`, ...flags].join(', ')
  return {
    kind: 'custom-ai-step',
    label,
    preview,
    semanticPath: path,
    children: [
      ...step.units.map((unit, index) => ({ kind: 'custom-ai-unit', label: unit.type, preview: perLevel(unit.counts), semanticPath: [...path, 'units', String(index)] })),
      ...step.times.map((time, index) => ({
        kind: 'custom-ai-time',
        label: `Time ${time.type}`,
        preview: [perLevel(time.durations), time.trigger === undefined ? '' : `trigger ${time.trigger}`].filter(Boolean).join(', '),
        semanticPath: [...path, 'times', String(index)],
      })),
      ...step.points.map((point, index) => ({
        kind: 'custom-ai-point',
        label: `${point.type} point`,
        preview: [`id ${point.id}`, point.active === undefined ? '' : `levels ${point.active.join(' ')}`].filter(Boolean).join(', '),
        semanticPath: [...path, 'points', String(index)],
      })),
      ...(step.unknown ?? []).map((element, index) => xmlElementNode(element, [...path, 'unknown', String(index)])),
    ],
  }
}

function unknownElements(document: AIDataResult): number {
  return (document.unknown?.length ?? 0) + document.definitions.reduce(
    (sum, definition) => sum + (definition.unknown?.length ?? 0) + definition.steps.reduce((steps, step) => steps + (step.unknown?.length ?? 0), 0),
    0,
  )
}

export const definition = createEditorXmlDocumentDefinition<AIDataResult>({
  id: 'blizzard/sc2-custom-ai',
  formatId: 'sc2-custom-ai',
  label: 'CustomAI',
  rootTag: 'AIData',
  pathPattern: /(?:^|[\\/])CustomAI$/iu,
  diagnosticPrefix: 'blizzard.sc2-custom-ai',
  unsupportedFeatures: ['ai-runtime-execution'],
  read: readAIData,
  layout: writeEditorLayout,
  summary: document => ({
    definitions: document.definitions.length,
    steps: document.definitions.reduce((sum, item) => sum + item.steps.length, 0),
    waves: document.definitions.reduce((sum, item) => sum + item.steps.filter(step => step.type === 'Wave').length, 0),
    unknownElements: unknownElements(document),
  }),
  tree: document => [
    ...document.definitions.map((item, index) => ({
      kind: 'custom-ai-definition',
      label: `Definition ${item.id}`,
      preview: [
        item.sourcePlayer === undefined ? '' : `player ${item.sourcePlayer}`,
        item.targetPlayers.length === 0 ? '' : `targets ${item.targetPlayers.join(' ')}`,
        `${item.steps.length} steps`,
      ].filter(Boolean).join(', '),
      semanticPath: ['definitions', String(index)],
      children: [
        ...item.steps.map((step, stepIndex) => stepNode(step, ['definitions', String(index), 'steps', String(stepIndex)])),
        ...(item.unknown ?? []).map((element, elementIndex) => xmlElementNode(element, ['definitions', String(index), 'unknown', String(elementIndex)])),
      ],
    })),
    ...(document.unknown ?? []).map((element, index) => xmlElementNode(element, ['unknown', String(index)])),
  ],
  table: document => ({
    header: ['definition', 'step', 'type', 'id', 'units', 'points', 'times'],
    rows: document.definitions.flatMap(item => item.steps.map((step, index) => [
      item.id,
      String(index),
      step.type,
      step.id === undefined ? '' : String(step.id),
      step.units.map(unit => unit.type).join(' '),
      String(step.points.length),
      step.times.map(time => time.type).join(' '),
    ])),
  }),
})
export const operations = editorXmlDocumentOperations(definition.id)
export const abiVersion = 1
export const createCodec = (context?: unknown) => createInspectionCodec(definition, context as never)
