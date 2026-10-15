import { describe, expect, it } from 'vitest'

import {
  getNodeChildren,
  getTokenAtPosition,
  Parser,
  SyntaxKind,
} from '@modkit/blizzard-starcraft2/galaxy/language-core'

describe('Galaxy language-core source navigation', () => {
  const text = 'void Main() { string id = "Marine"; int value = 1; }'
  const source = new Parser().parseFile('test.galaxy', text)

  it('finds syntax tokens without the legacy language host', () => {
    const stringToken = getTokenAtPosition(text.indexOf('Marine') + 2, source)
    const identifier = getTokenAtPosition(text.indexOf('id =') + 1, source)

    expect(stringToken?.kind).toBe(SyntaxKind.StringLiteral)
    expect((stringToken as { value?: string } | undefined)?.value).toBe('Marine')
    expect(identifier?.kind).toBe(SyntaxKind.Identifier)
  })

  it('keeps whitespace selection behavior used by the language host', () => {
    const whitespace = text.indexOf('id =') + 2

    expect(getTokenAtPosition(whitespace, source)).toBeUndefined()
    expect(getTokenAtPosition(whitespace, source, true)?.kind).toBe(SyntaxKind.EqualsToken)
  })

  it('orders semantic children and syntax tokens by source position', () => {
    const children = getNodeChildren(source)

    expect(children.length).toBeGreaterThan(0)
    expect(children.every((child, index) => index === 0 || children[index - 1]!.pos <= child.pos)).toBe(true)
  })
})
