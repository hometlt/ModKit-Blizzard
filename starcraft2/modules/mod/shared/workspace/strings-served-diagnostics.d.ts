/**
 * The Strings module's served diagnostics (`strings/providers/language/src/served-diagnostics.ts`),
 * as the mod server uses it. This project resolves `@modkit/blizzard-starcraft2/strings/served-diagnostics`
 * here (`tsconfig.sc2-mod.json` paths) so it does not compile the Strings sources; the runtime
 * import is the package export.
 */
export interface StringsServedDiagnostics {
  hover(layerId: string, path: string, uri: string, position: { readonly line: number; readonly character: number }): unknown
  update(
    documents: Iterable<{ readonly layerId: string; readonly path: string; readonly languageId: string; readonly text: string }>,
  ): void
  diagnostics(
    layerId: string,
    path: string,
    uri: string,
    options: { readonly maxResults: number; readonly incomplete: boolean },
  ): unknown
}

export function createStringsServedDiagnostics(): StringsServedDiagnostics
