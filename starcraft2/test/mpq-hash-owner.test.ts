import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const repositoryRoot = join(import.meta.dirname, '..', '..')
const coreRoot = join(repositoryRoot, '..', 'modkit-core')

function trackedTypescript(root: string) {
  return execFileSync('git', ['ls-files', '*.ts'], { cwd: root, encoding: 'utf8' })
    .split(/\r?\n/u)
    .filter(path => path.length > 0 && existsSync(join(root, path)))
}

function mpqHashDefinitions(path: string, source: string) {
  if (!source.includes('mpqHash')) return []
  const parsed = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const definitions: string[] = []
  const visit = (node: ts.Node): void => {
    const namedFunction = ts.isFunctionDeclaration(node) && node.name?.text === 'mpqHash'
    const functionVariable =
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'mpqHash' &&
      node.initializer !== undefined &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    if (namedFunction || functionVariable) {
      const location = parsed.getLineAndCharacterOfPosition(node.getStart(parsed))
      definitions.push(`${path}:${location.line + 1}`)
    }
    ts.forEachChild(node, visit)
  }
  visit(parsed)
  return definitions
}

describe('canonical MPQ hash ownership', () => {
  it('keeps exactly one AST definition in Core and zero in Blizzard', () => {
    const blizzardDefinitions = trackedTypescript(repositoryRoot).flatMap(path =>
      mpqHashDefinitions(path, readFileSync(join(repositoryRoot, path), 'utf8')),
    )
    const coreDefinitions = trackedTypescript(coreRoot).flatMap(path =>
      mpqHashDefinitions(path, readFileSync(join(coreRoot, path), 'utf8')),
    )
    expect(blizzardDefinitions).toEqual([])
    // The owner file, not a line: Core moves other algorithms out of it (crc32 → checksum).
    expect(coreDefinitions.map(definition => definition.replace(/:\d+$/u, ''))).toEqual([
      'packages/codec-kit/src/crypto/mpq.ts',
    ])
  })
})
