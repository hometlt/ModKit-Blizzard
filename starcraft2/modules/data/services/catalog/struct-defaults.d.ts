/** Types for `struct-defaults.js` (SC2 root-level structure defaults). */

export function isStarcraft2StructureDefaultTag(tag: string): boolean

export function starcraft2StructureDefaultNamespace(
  path: string | undefined,
  rootTypes: readonly string[],
): string | undefined

export function mergeStructureDefault(defaults: unknown, value: unknown): unknown

export function applyStarcraft2StructureDefaults<T extends Readonly<Record<string, unknown>>>(
  typeId: string,
  entityId: string,
  fields: T,
  defaultsFor: (structureType: string) => unknown,
  options?: { readonly wrapsIndexed?: boolean },
): T
