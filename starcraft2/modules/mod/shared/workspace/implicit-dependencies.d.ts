export interface Sc2InstallationDependency {
  readonly id: string
  readonly kind: 'installation-mod'
  readonly required: boolean
  readonly order: number
  readonly state: 'unresolved'
  readonly path: string
  readonly basis: 'declared' | 'engine-implicit'
}

export interface Sc2InstallationDependencyRequest {
  readonly schemaVersion: 1
  readonly gameId: 'blizzard/starcraft-2'
  readonly complete: true
  readonly dependencies: readonly Sc2InstallationDependency[]
}

export const SC2_BUILTIN_PACKAGE_DEPENDENCIES: Readonly<
  Record<string, readonly string[]>
>

export function normalizeSc2PackagePath(value: string): string | undefined
export function canonicalSc2PackagePath(value: string): string | undefined
export function sc2BuiltinDirectDependencies(value: string): readonly string[]
export function sc2BuiltinDependencyClosure(value: string): readonly string[]
export function sc2BuiltinDocumentInfo(value: string): string | undefined
export function sc2InstallationDependencies(
  activePackage: string,
  declared: readonly string[],
): Sc2InstallationDependencyRequest
