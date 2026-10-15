import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface ExtensionPackageSnapshot {
  readonly path: string
  dispose(): void
}

/**
 * Copies exactly the package-published surface into an immutable temporary directory.
 * Dependencies stay outside the attested extension bytes and are exposed through a junction.
 */
export function createExtensionPackageSnapshot(
  extensionSource: string,
  prefix = 'modkit-extension-',
): ExtensionPackageSnapshot {
  const scratch = mkdtempSync(join(tmpdir(), prefix))
  const extension = join(scratch, 'package')
  mkdirSync(extension, { recursive: true })

  const packageJson = JSON.parse(readFileSync(join(extensionSource, 'package.json'), 'utf8')) as {
    files?: unknown
  }
  const packageFiles = Array.isArray(packageJson.files)
    ? packageJson.files.filter((value): value is string => typeof value === 'string')
    : []

  cpSync(join(extensionSource, 'package.json'), join(extension, 'package.json'))
  for (const relativePath of packageFiles) {
    const source = join(extensionSource, relativePath)
    if (existsSync(source)) cpSync(source, join(extension, relativePath), { recursive: true })
  }

  symlinkSync(join(extensionSource, 'node_modules'), join(extension, 'node_modules'), 'junction')
  return {
    path: extension,
    dispose: () => rmSync(scratch, { recursive: true, force: true }),
  }
}
