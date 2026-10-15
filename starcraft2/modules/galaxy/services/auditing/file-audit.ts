/**
 * Node host adapter for script-codec operations.
 *
 * File access stays in this Node adapter while structural detection and fallback auditing remain
 * pure services. The adapter performs the same competing bounded byte classification as a host.
 */
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  auditGalaxyFallbacks,
  auditTriggerFallbacks,
  compareScriptFallbackAudits,
  formatScriptFallbackAudit,
  type ScriptFallbackAuditComparison,
  type ScriptFallbackAuditReport,
} from './fallback-audit.js'
import { detectGalaxyBytes } from '../source-detection.js'
import { detectTriggerBytes } from '../../../triggers/services/source-detection.js'
import {
  GALAXY_CODEC_ID,
  SC2_GAME_ID,
  SC2_TRIGGERS_CODEC_ID,
} from '../../../../shared/scripts/identity.js'

export interface AuditScriptFallbackFileOptions {
  readonly sourcePath: string
  readonly format?: 'json' | 'markdown'
  readonly baselinePath?: string
}

export interface AuditScriptFallbackFileResult {
  readonly codecId: string
  readonly report: ScriptFallbackAuditReport
  readonly comparison?: ScriptFallbackAuditComparison
  readonly output: string
  readonly exitCode: number
}

export async function auditScriptFallbackFile(
  options: AuditScriptFallbackFileOptions,
): Promise<AuditScriptFallbackFileResult | undefined> {
  const sourcePath = resolve(options.sourcePath)
  const bytes = await readFile(sourcePath)
  const context = { uri: sourcePath, gameId: SC2_GAME_ID }
  const [galaxy, triggers] = [
    detectGalaxyBytes(bytes, context),
    detectTriggerBytes(bytes, context),
  ]
  if (galaxy.confidence <= 0 && triggers.confidence <= 0) return undefined
  if (galaxy.confidence === triggers.confidence) return undefined
  const codecId = galaxy.confidence > triggers.confidence ? GALAXY_CODEC_ID : SC2_TRIGGERS_CODEC_ID
  const text = new TextDecoder().decode(bytes)
  const report =
    codecId === SC2_TRIGGERS_CODEC_ID
      ? auditTriggerFallbacks(text, sourcePath)
      : codecId === GALAXY_CODEC_ID
        ? auditGalaxyFallbacks(text, sourcePath)
        : undefined
  if (report === undefined) return undefined

  const comparison =
    options.baselinePath === undefined
      ? undefined
      : compareScriptFallbackAudits(
          JSON.parse(
            await readFile(resolve(options.baselinePath), 'utf8'),
          ) as ScriptFallbackAuditReport,
          report,
        )
  const output =
    options.format === 'markdown'
      ? `${formatScriptFallbackAudit(report).trimEnd()}${
          comparison === undefined
            ? ''
            : `\n- Baseline regressions: ${comparison.regressions.length}\n`
        }`
      : JSON.stringify(comparison === undefined ? report : { report, comparison }, null, 2)
  return {
    codecId,
    report,
    ...(comparison === undefined ? {} : { comparison }),
    output,
    exitCode: comparison !== undefined && comparison.regressions.length > 0 ? 1 : 0,
  }
}
