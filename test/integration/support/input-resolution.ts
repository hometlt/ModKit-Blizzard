import { ModkitError } from '@modkit/core'
import type { ArtifactSource, InputSearchScope, Lease } from '@modkit/sdk'

export const COMPANION_PATH_REFUSED = 'x3.host/companion-path-refused'

export interface CompanionOriginEntry {
  readonly logicalId: string
  readonly size?: bigint
}

export type CompanionCaseSensitivity = 'sensitive' | 'insensitive'

export interface CompanionEnumerationOptions {
  readonly prefix: string
}

export interface CompanionOrigin {
  readonly primaryLogicalId: string
  readonly caseSensitivity: CompanionCaseSensitivity
  readonly scopes: readonly InputSearchScope[]
  enumerate(
    scope: InputSearchScope,
    options: CompanionEnumerationOptions,
    signal?: AbortSignal,
  ): AsyncIterable<CompanionOriginEntry>
  open(logicalId: string, signal?: AbortSignal): Promise<Lease<ArtifactSource>>
}

const DRIVE_PREFIX = /^[A-Za-z]:/u

function refusePath(value: string, why: string, context: Record<string, unknown>): never {
  throw new ModkitError({
    code: COMPANION_PATH_REFUSED,
    message: `companion logical id «${value}» is refused: ${why}`,
    context: { ...context, logicalId: value },
  })
}

export function normalizeCompanionLogicalId(
  value: string,
  context: Record<string, unknown> = {},
): string {
  if (value.includes('\0')) refusePath(value, 'it contains a NUL byte', context)
  const slashed = value.replaceAll('\\', '/')
  if (slashed.startsWith('//')) refusePath(slashed, 'it is a UNC path', context)
  if (slashed.startsWith('/')) refusePath(slashed, 'it is an absolute path', context)
  if (DRIVE_PREFIX.test(slashed)) refusePath(slashed, 'it carries a drive prefix', context)
  const parts: string[] = []
  for (const part of slashed.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') refusePath(slashed, 'it escapes the confined origin root', context)
    parts.push(part)
  }
  const normalized = parts.join('/')
  if (normalized === '') refusePath(value, 'it names nothing', context)
  return normalized
}
