/**
 * Deterministic, browser-safe evidence for source-preserving script fallbacks.
 *
 * This module deliberately lowers only for analysis. It does not import the runtime or execute
 * `EngineAst`; callers retain ownership of source discovery and bounded reads through their
 * MK3 byte-source/content-port session.
 */

import { galaxySourceToEngineProgram, parseGalaxySource } from '@modkit/blizzard-starcraft2/galaxy/analysis/index.js'
import {
  parseTriggerXmlSync,
  triggerLibrariesToEngineProgram,
} from '@modkit/blizzard-starcraft2/triggers/document/index.js'
import type { ArtifactByteSource, DetectionResult } from '@modkit/sdk'
import {
  GALAXY_EXTENSION,
  SC2_GAME_ID,
  SC2_TRIGGERS_BARE_NAMES,
  SC2_TRIGGERS_EXTENSIONS,
} from '../../../../shared/scripts/identity.js'

export type ScriptFallbackCodec = 'galaxy' | 'sc2-triggers'
export type ScriptFallbackKind = 'EngineRawStatement' | 'EngineRawExpression'
export type ScriptFallbackReason = 'unsupported-lowering' | 'source-preserving-custom-script'

export interface ScriptFallbackEvidence {
  readonly format?: string
  readonly fileName?: string
  readonly libraryId?: string
  readonly elementId?: string
  readonly elementType?: string
}

export interface ScriptFallbackFinding {
  readonly codec: ScriptFallbackCodec
  readonly source: string
  readonly kind: ScriptFallbackKind
  readonly reason: ScriptFallbackReason
  readonly language: string
  readonly code: string
  readonly libraryId?: string
  readonly functionName?: string
  readonly evidence: ScriptFallbackEvidence
}

export interface ScriptFallbackAuditDiagnostic {
  readonly code:
    | 'script-fallback-audit.input-malformed'
    | 'script-fallback-audit.library-missing'
    | 'script-fallback-audit.source-missing'
    | 'script-fallback-audit.dependency-missing'
    | 'script-fallback-audit.dependency-ambiguous'
    | 'script-fallback-audit.dependency-circular'
    | 'script-fallback-audit.compiled-galaxy-dependency'
    | 'script-fallback-audit.corpus-limit-reached'
    | 'script-fallback-audit.source-ambiguous'
    | 'script-fallback-audit.source-too-large'
  readonly message: string
  readonly source: string
}

export interface ScriptNonExecutableSummary {
  /**
   * Lexical comments in Galaxy or XML/Comment elements in Trigger XML. They are evidence that
   * content was intentionally ignored, never evidence of a lowering gap.
   */
  readonly comments: number
}

export interface ScriptPayloadSentinelFunction {
  readonly name?: string
  readonly library?: string
  readonly id?: string
  readonly count: number
}

export interface ScriptPayloadSentinelSummary {
  /** `__MKX_SF__` tails carrying source-preserving sub-functions. */
  readonly transportTails: number
  /** `__MKX_FCJSON__:<base64-json>` payload strings. */
  readonly jsonPayloads: number
  readonly decodedJsonPayloads: number
  readonly malformedJsonPayloads: number
  /** Root FunctionDef identities from successfully decoded payloads. */
  readonly rootFunctionDefs: readonly ScriptPayloadSentinelFunction[]
}

export interface ScriptFallbackAuditReport {
  readonly schemaVersion: 1
  readonly codec: ScriptFallbackCodec
  readonly source: string
  readonly findings: readonly ScriptFallbackFinding[]
  readonly diagnostics: readonly ScriptFallbackAuditDiagnostic[]
  readonly summary: Readonly<Record<ScriptFallbackReason, number>>
  readonly payloadSentinels?: ScriptPayloadSentinelSummary
  readonly nonExecutable?: ScriptNonExecutableSummary
}

export interface ScriptFallbackAuditComparison {
  readonly added: readonly ScriptFallbackFinding[]
  readonly removed: readonly ScriptFallbackFinding[]
  /** New raw fallback evidence: the only entries a CI baseline should fail on by default. */
  readonly regressions: readonly ScriptFallbackFinding[]
}

export interface ResolverFallbackAuditOptions {
  readonly resolver: ScriptAuditContentPort
  readonly galaxyPaths?: readonly string[]
  readonly triggerPaths?: readonly string[]
  readonly maxBytes?: number
  readonly signal?: AbortSignal
}

export interface ResolverFallbackAuditReport {
  readonly reports: readonly ScriptFallbackAuditReport[]
  readonly diagnostics: readonly ScriptFallbackAuditDiagnostic[]
}

/**
 * A codec's bounded structural detector over bytes already leased by the audit service.
 *
 * The corpus audit needs to decide Galaxy vs Trigger XML per source, and that decision belongs to
 * the codecs. This package holds no codec, so the caller supplies the two probes; a host that has
 * registered the codecs supplies their pure byte classifiers. This avoids re-reading every
 * candidate once per competing detector.
 */
export type ScriptFallbackDetector = (
  bytes: Uint8Array,
  context: { readonly uri: string; readonly gameId?: string },
) => DetectionResult | Promise<DetectionResult>

export interface ScriptFallbackDetectors {
  readonly galaxy: ScriptFallbackDetector
  readonly sc2Triggers: ScriptFallbackDetector
}

export interface ScriptAuditResolvedSource {
  readonly source: ArtifactByteSource
  readonly path?: string
  readonly mountRole?: 'base' | 'dependency' | 'overlay' | 'generated' | string
}

export interface ScriptAuditChild {
  readonly kind: 'file' | 'directory' | string
  readonly path: string
  readonly mountId?: string
}

export interface ScriptAuditDependency {
  readonly id: string
  readonly label?: string
  readonly state: 'resolved' | 'missing' | 'ambiguous' | 'circular'
}

/** Host-owned discovery port. It deliberately exposes MK3 byte sources, not the old codec API. */
export interface ScriptAuditContentPort {
  readonly gameId?: string
  resolveAll(request: {
    readonly path: string
    readonly mountIds?: readonly string[]
    readonly signal?: AbortSignal
  }): AsyncIterable<ScriptAuditResolvedSource>
  list(request: {
    readonly includeShadowed: boolean
    readonly signal?: AbortSignal
  }): AsyncIterable<ScriptAuditChild>
  dependencies(signal?: AbortSignal): Promise<readonly ScriptAuditDependency[]>
}

export interface ResolverFallbackCorpusAuditOptions {
  readonly resolver: ScriptAuditContentPort
  /** The two structural probes that make the routing decision. Supplied by the host. */
  readonly detectors: ScriptFallbackDetectors
  /** Maximum candidate sources to structurally detect and audit. Default: 256. */
  readonly maxSources?: number
  readonly maxBytes?: number
  readonly signal?: AbortSignal
}

const DEFAULT_MAX_AUDIT_SOURCE_BYTES = 8 * 1024 * 1024
const DEFAULT_MAX_AUDIT_CORPUS_SOURCES = 256

interface AuditContext {
  readonly libraryId?: string
  readonly functionName?: string
}

interface RawNode {
  readonly kind: ScriptFallbackKind
  readonly language: string
  readonly code: string
  readonly source?: {
    readonly format?: string
    readonly fileName?: string
    readonly moduleId?: string
    readonly elementId?: string
    readonly elementType?: string
  }
}

function isRawNode(value: unknown): value is RawNode {
  if (value === null || typeof value !== 'object') return false
  const node = value as Partial<RawNode>
  return (
    (node.kind === 'EngineRawStatement' || node.kind === 'EngineRawExpression') &&
    typeof node.language === 'string' &&
    typeof node.code === 'string'
  )
}

function fallbackReason(node: RawNode): ScriptFallbackReason {
  return node.language === 'trigger-script'
    ? 'source-preserving-custom-script'
    : 'unsupported-lowering'
}

function stableFindings(
  findings: readonly ScriptFallbackFinding[],
): readonly ScriptFallbackFinding[] {
  return [...findings].sort((left, right) => {
    const leftKey = [
      left.codec,
      left.source,
      left.libraryId ?? '',
      left.functionName ?? '',
      left.evidence.elementId ?? '',
      left.kind,
      left.reason,
      left.code,
    ].join('\u0000')
    const rightKey = [
      right.codec,
      right.source,
      right.libraryId ?? '',
      right.functionName ?? '',
      right.evidence.elementId ?? '',
      right.kind,
      right.reason,
      right.code,
    ].join('\u0000')
    return leftKey.localeCompare(rightKey)
  })
}

function collectRawFindings(
  program: unknown,
  codec: ScriptFallbackCodec,
  source: string,
): readonly ScriptFallbackFinding[] {
  const findings: ScriptFallbackFinding[] = []
  const visited = new Set<object>()
  const visit = (value: unknown, context: AuditContext): void => {
    if (value === null || typeof value !== 'object') return
    if (visited.has(value)) return
    visited.add(value)
    const node = value as Record<string, unknown>
    const nextContext: AuditContext = {
      ...(context.libraryId === undefined ? {} : { libraryId: context.libraryId }),
      ...(context.functionName === undefined ? {} : { functionName: context.functionName }),
      ...(node['kind'] === 'EngineModule' && typeof node['id'] === 'string'
        ? { libraryId: node['id'] }
        : {}),
      ...(node['kind'] === 'EngineFunction' && typeof node['name'] === 'string'
        ? { functionName: node['name'] }
        : {}),
    }
    if (isRawNode(node)) {
      findings.push({
        codec,
        source,
        kind: node.kind,
        reason: fallbackReason(node),
        language: node.language,
        code: node.code,
        ...(nextContext.libraryId === undefined ? {} : { libraryId: nextContext.libraryId }),
        ...(nextContext.functionName === undefined
          ? {}
          : { functionName: nextContext.functionName }),
        evidence: {
          ...(node.source?.format === undefined ? {} : { format: node.source.format }),
          ...(node.source?.fileName === undefined ? {} : { fileName: node.source.fileName }),
          ...(node.source?.moduleId === undefined ? {} : { libraryId: node.source.moduleId }),
          ...(node.source?.elementId === undefined ? {} : { elementId: node.source.elementId }),
          ...(node.source?.elementType === undefined
            ? {}
            : { elementType: node.source.elementType }),
        },
      })
    }
    for (const key of Object.keys(node).sort()) visit(node[key], nextContext)
  }
  visit(program, {})
  return stableFindings(findings)
}

function report(
  codec: ScriptFallbackCodec,
  source: string,
  findings: readonly ScriptFallbackFinding[],
  diagnostics: readonly ScriptFallbackAuditDiagnostic[] = [],
  payloadSentinels?: ScriptPayloadSentinelSummary,
  nonExecutable?: ScriptNonExecutableSummary,
): ScriptFallbackAuditReport {
  const summary: Record<ScriptFallbackReason, number> = {
    'unsupported-lowering': 0,
    'source-preserving-custom-script': 0,
  }
  for (const finding of findings) summary[finding.reason] += 1
  return {
    schemaVersion: 1,
    codec,
    source,
    findings,
    diagnostics: [...diagnostics].sort((left, right) => left.code.localeCompare(right.code)),
    summary,
    ...(payloadSentinels === undefined ? {} : { payloadSentinels }),
    ...(nonExecutable === undefined ? {} : { nonExecutable }),
  }
}

function maskGalaxyComments(source: string): {
  readonly source: string
  readonly nonExecutable: ScriptNonExecutableSummary
} {
  const masked = source.split('')
  let comments = 0
  let index = 0
  while (index < source.length) {
    const character = source[index]
    if (character === '"' || character === "'") {
      const quote = character
      index += 1
      while (index < source.length) {
        if (source[index] === '\\') {
          index += 2
          continue
        }
        if (source[index] === quote) {
          index += 1
          break
        }
        index += 1
      }
      continue
    }
    if (character === '/' && source[index + 1] === '/') {
      comments += 1
      masked[index] = ' '
      masked[index + 1] = ' '
      index += 2
      while (index < source.length && source[index] !== '\n') {
        masked[index] = ' '
        index += 1
      }
      continue
    }
    if (character === '/' && source[index + 1] === '*') {
      comments += 1
      masked[index] = ' '
      masked[index + 1] = ' '
      index += 2
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) {
        if (source[index] !== '\r' && source[index] !== '\n') masked[index] = ' '
        index += 1
      }
      if (index < source.length) {
        masked[index] = ' '
        masked[index + 1] = ' '
        index += 2
      }
      continue
    }
    index += 1
  }
  return { source: masked.join(''), nonExecutable: { comments } }
}

function countTriggerComments(xml: string): number {
  const xmlComments = [...xml.matchAll(/<!--[\s\S]*?-->/g)].length
  const commentElements = [...xml.matchAll(/<Element\b[^>]*\bType\s*=\s*["']Comment["'][^>]*>/gi)]
    .length
  return xmlComments + commentElements
}

function decodedBase64Json(encoded: string): unknown {
  const binary = globalThis.atob(encoded)
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0))
  return JSON.parse(new TextDecoder().decode(bytes))
}

function payloadFunctionDef(payload: unknown): {
  readonly name?: string
  readonly library?: string
  readonly id?: string
} {
  if (payload === null || typeof payload !== 'object') return {}
  const functionDef = (payload as { functionDef?: unknown }).functionDef
  if (functionDef === null || typeof functionDef !== 'object') return {}
  const value = functionDef as Record<string, unknown>
  return {
    ...(typeof value['name'] === 'string' ? { name: value['name'] } : {}),
    ...(typeof value['library'] === 'string' ? { library: value['library'] } : {}),
    ...(typeof value['id'] === 'string' ? { id: value['id'] } : {}),
  }
}

/** Decode only the source-preserving payload envelope; never retain proprietary payload text. */
export function auditScriptPayloadSentinels(source: string): ScriptPayloadSentinelSummary {
  const transportTails = [...source.matchAll(/["']__MKX_SF__["']/g)].length
  const payloads = [...source.matchAll(/__MKX_FCJSON__:([A-Za-z0-9+/]+={0,2})/g)].flatMap(match =>
    match[1] === undefined ? [] : [match[1]],
  )
  let decodedJsonPayloads = 0
  let malformedJsonPayloads = 0
  const functions = new Map<
    string,
    { name?: string; library?: string; id?: string; count: number }
  >()
  for (const encoded of payloads) {
    try {
      const identity = payloadFunctionDef(decodedBase64Json(encoded))
      decodedJsonPayloads += 1
      const key = [identity.library ?? '', identity.id ?? '', identity.name ?? ''].join('\u0000')
      const current = functions.get(key)
      if (current) current.count += 1
      else functions.set(key, { ...identity, count: 1 })
    } catch {
      malformedJsonPayloads += 1
    }
  }
  return {
    transportTails,
    jsonPayloads: payloads.length,
    decodedJsonPayloads,
    malformedJsonPayloads,
    rootFunctionDefs: [...functions.values()].sort((left, right) => {
      const leftKey = [left.library ?? '', left.name ?? '', left.id ?? ''].join('\u0000')
      const rightKey = [right.library ?? '', right.name ?? '', right.id ?? ''].join('\u0000')
      return leftKey.localeCompare(rightKey)
    }),
  }
}

/** Audit a parsed/lowered program supplied by a semantic codec or test fixture. */
export function auditEngineFallbacks(
  codec: ScriptFallbackCodec,
  source: string,
  program: unknown,
  payloadSentinels?: ScriptPayloadSentinelSummary,
  nonExecutable?: ScriptNonExecutableSummary,
): ScriptFallbackAuditReport {
  return report(
    codec,
    source,
    collectRawFindings(program, codec, source),
    [],
    payloadSentinels,
    nonExecutable,
  )
}

/** Lower one Galaxy source for analysis and report every raw fallback deterministically. */
export function auditGalaxyFallbacks(
  source: string,
  fileName = 'Lib.galaxy',
): ScriptFallbackAuditReport {
  const masked = maskGalaxyComments(source)
  try {
    const parsed = parseGalaxySource(masked.source, { fileName })
    return auditEngineFallbacks(
      'galaxy',
      fileName,
      galaxySourceToEngineProgram(parsed, { moduleId: fileName, includeRawFallbacks: true }),
      auditScriptPayloadSentinels(source),
      masked.nonExecutable,
    )
  } catch (error) {
    return report(
      'galaxy',
      fileName,
      [],
      [
        {
          code: 'script-fallback-audit.input-malformed',
          message: error instanceof Error ? error.message : String(error),
          source: fileName,
        },
      ],
      auditScriptPayloadSentinels(source),
      masked.nonExecutable,
    )
  }
}

/** Lower Trigger XML for analysis. Empty or malformed input is never counted as a converter gap. */
export function auditTriggerFallbacks(
  xml: string,
  fileName = 'Triggers',
): ScriptFallbackAuditReport {
  try {
    const libraries = [...parseTriggerXmlSync(xml).values()]
    if (libraries.length === 0) {
      return report(
        'sc2-triggers',
        fileName,
        [],
        [
          {
            code: 'script-fallback-audit.library-missing',
            message: `Trigger XML '${fileName}' contains no library.`,
            source: fileName,
          },
        ],
        auditScriptPayloadSentinels(xml),
        { comments: countTriggerComments(xml) },
      )
    }
    return auditEngineFallbacks(
      'sc2-triggers',
      fileName,
      triggerLibrariesToEngineProgram(libraries, { fileName, includeRawFallbacks: true }),
      auditScriptPayloadSentinels(xml),
      { comments: countTriggerComments(xml) },
    )
  } catch (error) {
    return report(
      'sc2-triggers',
      fileName,
      [],
      [
        {
          code: 'script-fallback-audit.input-malformed',
          message: error instanceof Error ? error.message : String(error),
          source: fileName,
        },
      ],
      auditScriptPayloadSentinels(xml),
      { comments: countTriggerComments(xml) },
    )
  }
}

/** Stable Markdown summary for a CLI/host without duplicating audit logic. */
export function formatScriptFallbackAudit(report: ScriptFallbackAuditReport): string {
  const lines = [
    `# Script fallback audit: ${report.source}`,
    '',
    `- Codec: \`${report.codec}\``,
    `- Unsupported lowering: ${report.summary['unsupported-lowering']}`,
    `- Source-preserving custom script: ${report.summary['source-preserving-custom-script']}`,
    `- Input diagnostics: ${report.diagnostics.length}`,
    ...(report.nonExecutable === undefined
      ? []
      : [`- Ignored comment/non-executable entries: ${report.nonExecutable.comments}`]),
    ...(report.payloadSentinels === undefined
      ? []
      : [
          `- Source-preserving payload tails: ${report.payloadSentinels.transportTails}`,
          `- Decoded payload JSON: ${report.payloadSentinels.decodedJsonPayloads}/${report.payloadSentinels.jsonPayloads}`,
          `- Malformed payload JSON: ${report.payloadSentinels.malformedJsonPayloads}`,
        ]),
  ]
  if (report.findings.length > 0) {
    lines.push('', '## Findings', '')
    for (const finding of report.findings) {
      lines.push(
        `- \`${finding.reason}\` — ${finding.libraryId ?? 'unknown library'} / ${
          finding.functionName ?? finding.evidence.elementId ?? 'unknown element'
        }`,
      )
    }
  }
  return `${lines.join('\n')}\n`
}

function findingKey(finding: ScriptFallbackFinding): string {
  return [
    finding.codec,
    finding.source,
    finding.kind,
    finding.reason,
    finding.language,
    finding.libraryId ?? '',
    finding.functionName ?? '',
    finding.evidence.elementId ?? '',
    finding.evidence.elementType ?? '',
    finding.code,
  ].join('\u0000')
}

/** Compare deterministic reports without treating fixed fallback evidence as a CI failure. */
export function compareScriptFallbackAudits(
  baseline: ScriptFallbackAuditReport,
  candidate: ScriptFallbackAuditReport,
): ScriptFallbackAuditComparison {
  const baselineByKey = new Map(baseline.findings.map(finding => [findingKey(finding), finding]))
  const candidateByKey = new Map(candidate.findings.map(finding => [findingKey(finding), finding]))
  const added = stableFindings(
    [...candidateByKey].filter(([key]) => !baselineByKey.has(key)).map(([, finding]) => finding),
  )
  const removed = stableFindings(
    [...baselineByKey].filter(([key]) => !candidateByKey.has(key)).map(([, finding]) => finding),
  )
  return { added, removed, regressions: added }
}

async function auditResolverPaths(
  resolver: ScriptAuditContentPort,
  codec: ScriptFallbackCodec,
  paths: readonly string[],
  maxBytes: number,
  signal: AbortSignal | undefined,
): Promise<ResolverFallbackAuditReport> {
  const reports: ScriptFallbackAuditReport[] = []
  const diagnostics: ScriptFallbackAuditDiagnostic[] = []
  const seen = new Set<string>()
  for (const rawPath of paths) {
    signal?.throwIfAborted()
    const path = rawPath.replace(/\\/g, '/').replace(/^\/+/, '')
    if (!path) continue
    let found = false
    for await (const resolved of resolver.resolveAll({ path, ...(signal === undefined ? {} : { signal }) })) {
      signal?.throwIfAborted()
      if (seen.has(resolved.source.ref.id)) continue
      seen.add(resolved.source.ref.id)
      found = true
      const bytes = await readAuditSource(resolved.source, maxBytes, signal)
      const source = new TextDecoder().decode(bytes)
      const fileName = resolved.path || resolved.source.ref.uri || resolved.source.ref.id
      reports.push(
        codec === 'galaxy'
          ? auditGalaxyFallbacks(source, fileName)
          : auditTriggerFallbacks(source, fileName),
      )
    }
    if (!found) {
      diagnostics.push({
        code: 'script-fallback-audit.source-missing',
        message: `No mounted script source resolved '${path}'.`,
        source: path,
      })
    }
  }
  return { reports, diagnostics }
}

/**
 * Audit explicitly addressed Galaxy and Trigger paths through an ordered content chain. The
 * resolver owns mount/dependency ordering; this operation neither discovers paths nor opens an
 * install, archive, or filesystem location itself.
 */
export async function auditResolverFallbacks(
  options: ResolverFallbackAuditOptions,
): Promise<ResolverFallbackAuditReport> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_AUDIT_SOURCE_BYTES
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new RangeError('Fallback audit maxBytes must be a positive integer.')
  }
  const [galaxy, triggers] = await Promise.all([
    auditResolverPaths(
      options.resolver,
      'galaxy',
      options.galaxyPaths ?? [],
      maxBytes,
      options.signal,
    ),
    auditResolverPaths(
      options.resolver,
      'sc2-triggers',
      options.triggerPaths ?? [],
      maxBytes,
      options.signal,
    ),
  ])
  return {
    reports: [...galaxy.reports, ...triggers.reports].sort((left, right) =>
      `${left.codec}\u0000${left.source}`.localeCompare(`${right.codec}\u0000${right.source}`),
    ),
    diagnostics: [...galaxy.diagnostics, ...triggers.diagnostics].sort((left, right) =>
      `${left.code}\u0000${left.source}`.localeCompare(`${right.code}\u0000${right.source}`),
    ),
  }
}

async function readAuditSource(
  source: ArtifactByteSource,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  signal?.throwIfAborted()
  if (source.size !== undefined && source.size > BigInt(maxBytes)) {
    throw new RangeError(`Script source exceeds the configured ${maxBytes}-byte audit limit.`)
  }
  // Unknown-size sources are probed one byte beyond the budget so an exact-size prefix cannot
  // silently disguise a larger source as complete.
  const requested = source.size === undefined ? maxBytes + 1 : Number(source.size)
  const bytes = await source.read(0n, requested, signal)
  if (bytes.byteLength > requested || bytes.byteLength > maxBytes) {
    throw new RangeError('Script source returned bytes beyond the requested audit range.')
  }
  return bytes
}

function isScriptCandidate(path: string): boolean {
  const normalized = path.replace(/\\/g, '/').toLowerCase()
  const name = normalized.split('/').at(-1) ?? normalized
  return (
    normalized.endsWith(GALAXY_EXTENSION) ||
    // Generic `.xml` is useful for direct-file detection but far too broad for a mounted SC2
    // corpus (where almost every catalog is XML). Bare `Triggers`, `.sc2lib`, and `.triggers`
    // retain precise candidate evidence before the structural detector makes the decision.
    SC2_TRIGGERS_EXTENSIONS.filter(extension => extension !== '.xml').some(extension =>
      normalized.endsWith(extension),
    ) ||
    SC2_TRIGGERS_BARE_NAMES.includes(name)
  )
}

/**
 * Discover and audit a bounded mounted script corpus. Filename evidence only prefilters
 * candidates; the codec-specific bounded structural detectors make the routing decision.
 */
export async function auditResolverFallbackCorpus(
  options: ResolverFallbackCorpusAuditOptions,
): Promise<ResolverFallbackAuditReport> {
  const maxSources = options.maxSources ?? DEFAULT_MAX_AUDIT_CORPUS_SOURCES
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_AUDIT_SOURCE_BYTES
  if (!Number.isSafeInteger(maxSources) || maxSources <= 0) {
    throw new RangeError('Fallback corpus maxSources must be a positive integer.')
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new RangeError('Fallback corpus maxBytes must be a positive integer.')
  }
  const reports: ScriptFallbackAuditReport[] = []
  const diagnostics: ScriptFallbackAuditDiagnostic[] = []
  for (const dependency of await options.resolver.dependencies(options.signal)) {
    if (dependency.state === 'resolved') continue
    const code = {
      missing: 'script-fallback-audit.dependency-missing',
      ambiguous: 'script-fallback-audit.dependency-ambiguous',
      circular: 'script-fallback-audit.dependency-circular',
    } as const
    diagnostics.push({
      code: code[dependency.state],
      message: `Dependency '${dependency.label ?? dependency.id}' is ${dependency.state}.`,
      source: dependency.id,
    })
  }

  const seen = new Set<string>()
  let candidates = 0
  for await (const child of options.resolver.list({
    includeShadowed: true,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })) {
    options.signal?.throwIfAborted()
    if (child.kind !== 'file' || !isScriptCandidate(child.path)) continue
    if (candidates >= maxSources) {
      diagnostics.push({
        code: 'script-fallback-audit.corpus-limit-reached',
        message: `Script corpus discovery stopped at the configured ${maxSources}-source limit.`,
        source: child.path,
      })
      break
    }
    candidates += 1
    for await (const resolved of options.resolver.resolveAll({
      path: child.path,
      ...(child.mountId === undefined ? {} : { mountIds: [child.mountId] }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })) {
      options.signal?.throwIfAborted()
      if (seen.has(resolved.source.ref.id)) continue
      seen.add(resolved.source.ref.id)
      if (resolved.source.size !== undefined && resolved.source.size > BigInt(maxBytes)) {
        diagnostics.push({
          code: 'script-fallback-audit.source-too-large',
          message: `Script source exceeds the configured ${maxBytes}-byte audit limit.`,
          source: child.path,
        })
        continue
      }
      let bytes: Uint8Array
      try {
        bytes = await readAuditSource(resolved.source, maxBytes, options.signal)
      } catch (error) {
        if (!(error instanceof RangeError)) throw error
        diagnostics.push({
          code: 'script-fallback-audit.source-too-large',
          message: `Script source exceeds the configured ${maxBytes}-byte audit limit.`,
          source: child.path,
        })
        continue
      }
      const uri = resolved.path || resolved.source.ref.uri || resolved.source.ref.id
      const context = { uri, gameId: options.resolver.gameId || SC2_GAME_ID }
      const [galaxy, triggers] = await Promise.all([
        options.detectors.galaxy(bytes, context),
        options.detectors.sc2Triggers(bytes, context),
      ])
      if (galaxy.confidence <= 0 && triggers.confidence <= 0) continue
      if (galaxy.confidence === triggers.confidence) {
        diagnostics.push({
          code: 'script-fallback-audit.source-ambiguous',
          message: `Script source matched Galaxy and Trigger XML with equal confidence ${galaxy.confidence}.`,
          source: child.path,
        })
        continue
      }
      const source = new TextDecoder().decode(bytes)
      const fileName = uri
      if (
        galaxy.confidence > triggers.confidence &&
        (resolved.mountRole === 'base' || resolved.mountRole === 'dependency')
      ) {
        diagnostics.push({
          code: 'script-fallback-audit.compiled-galaxy-dependency',
          message:
            'Compiled Galaxy dependency source is audited directly; it is not evidence of a missing Trigger XML conversion.',
          source: fileName,
        })
      }
      reports.push(
        galaxy.confidence > triggers.confidence
          ? auditGalaxyFallbacks(source, fileName)
          : auditTriggerFallbacks(source, fileName),
      )
    }
  }
  return {
    reports: reports.sort((left, right) =>
      `${left.codec}\u0000${left.source}`.localeCompare(`${right.codec}\u0000${right.source}`),
    ),
    diagnostics: diagnostics.sort((left, right) =>
      `${left.code}\u0000${left.source}`.localeCompare(`${right.code}\u0000${right.source}`),
    ),
  }
}
