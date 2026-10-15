/**
 * JASS 2 syntax tree with source spans, and syntax diagnostics with recovery: a statement that
 * does not parse is reported and skipped to the end of its line, so one mistake does not hide the
 * rest of a 400 KB script.
 */
import { lexJass, type JassToken } from './lexer.js'

export interface JassSpan {
  readonly start: number
  readonly end: number
}

export interface JassName extends JassSpan {
  readonly name: string
}

export type JassExpression =
  | (JassSpan & { readonly kind: 'integer'; readonly text: string })
  | (JassSpan & { readonly kind: 'real'; readonly text: string })
  | (JassSpan & { readonly kind: 'string'; readonly text: string })
  | (JassSpan & { readonly kind: 'rawcode'; readonly text: string })
  | (JassSpan & { readonly kind: 'boolean'; readonly value: boolean })
  | (JassSpan & { readonly kind: 'null' })
  | (JassSpan & { readonly kind: 'name'; readonly name: JassName })
  | (JassSpan & { readonly kind: 'function-ref'; readonly name: JassName })
  | (JassSpan & { readonly kind: 'index'; readonly name: JassName; readonly index: JassExpression })
  | (JassSpan & { readonly kind: 'call'; readonly name: JassName; readonly args: readonly JassExpression[] })
  | (JassSpan & { readonly kind: 'unary'; readonly operator: string; readonly operand: JassExpression })
  | (JassSpan & {
      readonly kind: 'binary'
      readonly operator: string
      readonly left: JassExpression
      readonly right: JassExpression
    })
  | (JassSpan & { readonly kind: 'paren'; readonly inner: JassExpression })

export interface JassVariable extends JassSpan {
  readonly constant: boolean
  readonly type: JassName
  readonly array: boolean
  readonly name: JassName
  readonly init?: JassExpression
}

export interface JassParameter extends JassSpan {
  readonly type: JassName
  readonly name: JassName
}

export type JassStatement =
  | (JassSpan & {
      readonly kind: 'set'
      readonly name: JassName
      readonly index?: JassExpression
      readonly value: JassExpression
    })
  | (JassSpan & { readonly kind: 'call'; readonly call: JassExpression & { kind: 'call' } })
  | (JassSpan & {
      readonly kind: 'if'
      readonly branches: readonly { readonly condition: JassExpression; readonly body: readonly JassStatement[] }[]
      readonly otherwise?: readonly JassStatement[]
    })
  | (JassSpan & { readonly kind: 'loop'; readonly body: readonly JassStatement[] })
  | (JassSpan & { readonly kind: 'exitwhen'; readonly condition: JassExpression })
  | (JassSpan & { readonly kind: 'return'; readonly value?: JassExpression })
  | (JassSpan & { readonly kind: 'debug'; readonly statement: JassStatement })

export type JassDeclaration =
  | (JassSpan & { readonly kind: 'type'; readonly name: JassName; readonly base: JassName })
  | (JassSpan & { readonly kind: 'globals'; readonly variables: readonly JassVariable[] })
  | (JassSpan & {
      readonly kind: 'native'
      readonly constant: boolean
      readonly name: JassName
      readonly parameters: readonly JassParameter[]
      readonly returns: JassName
    })
  | (JassSpan & {
      readonly kind: 'function'
      readonly constant: boolean
      readonly name: JassName
      readonly parameters: readonly JassParameter[]
      readonly returns: JassName
      readonly locals: readonly JassVariable[]
      readonly body: readonly JassStatement[]
    })

export interface JassSyntaxError extends JassSpan {
  readonly message: string
}

export interface JassProgram {
  readonly declarations: readonly JassDeclaration[]
  readonly comments: readonly JassSpan[]
  readonly errors: readonly JassSyntaxError[]
  /** Every non-trivia token, for editor highlighting. */
  readonly tokens: readonly JassToken[]
}

class SyntaxFailure extends Error {
  constructor(readonly span: JassSpan, message: string) {
    super(message)
  }
}

const PRECEDENCE: ReadonlyMap<string, number> = new Map([
  ['or', 1],
  ['and', 2],
  ['==', 3], ['!=', 3], ['<', 3], ['<=', 3], ['>', 3], ['>=', 3],
  ['+', 4], ['-', 4],
  ['*', 5], ['/', 5],
])

export function parseJass(text: string, signal?: AbortSignal): JassProgram {
  const all = lexJass(text, signal)
  const comments = all.filter(token => token.kind === 'comment').map(({ start, end }) => ({ start, end }))
  const tokens = all.filter(token => token.kind !== 'comment')
  const errors: JassSyntaxError[] = []
  let at = 0

  const peek = (ahead = 0): JassToken => tokens[Math.min(at + ahead, tokens.length - 1)]!
  const next = (): JassToken => tokens[Math.min(at++, tokens.length - 1)]!
  const is = (text: string, ahead = 0) => {
    const token = peek(ahead)
    return (token.kind === 'keyword' || token.kind === 'operator') && token.text === text
  }
  const fail = (message: string, token = peek()): never => {
    throw new SyntaxFailure({ start: token.start, end: Math.max(token.end, token.start + 1) }, message)
  }
  const expect = (text: string): JassToken => (is(text) ? next() : fail(`expected «${text}»`))
  const name = (what: string): JassName => {
    const token = peek()
    if (token.kind !== 'identifier') fail(`expected ${what}`)
    next()
    return { name: token.text, start: token.start, end: token.end }
  }
  /** A type is a name, or the keyword `nothing` where a signature allows it. */
  const typeName = (allowNothing: boolean): JassName => {
    const token = peek()
    if (allowNothing && token.kind === 'keyword' && token.text === 'nothing') {
      next()
      return { name: 'nothing', start: token.start, end: token.end }
    }
    return name('a type')
  }
  const skipBlankLines = () => {
    while (peek().kind === 'newline') next()
  }
  const endOfLine = () => {
    const token = peek()
    if (token.kind === 'newline') next()
    else if (token.kind !== 'end') fail(`unexpected «${token.text}» at the end of the line`)
  }
  /** Report and skip the rest of the line; the caller resumes at the next one. */
  const recover = (failure: unknown) => {
    if (!(failure instanceof SyntaxFailure)) throw failure
    errors.push({ ...failure.span, message: failure.message })
    while (peek().kind !== 'newline' && peek().kind !== 'end') next()
    if (peek().kind === 'newline') next()
  }

  const expression = (minimum = 1): JassExpression => {
    let left = unary()
    for (;;) {
      const token = peek()
      const precedence =
        token.kind === 'operator' || token.kind === 'keyword' ? PRECEDENCE.get(token.text) : undefined
      if (precedence === undefined || precedence < minimum) return left
      next()
      const right = expression(precedence + 1)
      left = { kind: 'binary', operator: token.text, left, right, start: left.start, end: right.end }
    }
  }
  const unary = (): JassExpression => {
    const token = peek()
    if ((token.kind === 'keyword' && token.text === 'not') || (token.kind === 'operator' && (token.text === '-' || token.text === '+'))) {
      next()
      const operand = token.text === 'not' ? expression(3) : unary()
      return { kind: 'unary', operator: token.text, operand, start: token.start, end: operand.end }
    }
    return primary()
  }
  const primary = (): JassExpression => {
    const token = next()
    const span = { start: token.start, end: token.end }
    switch (token.kind) {
      case 'integer':
        return { kind: 'integer', text: token.text, ...span }
      case 'real':
        return { kind: 'real', text: token.text, ...span }
      case 'string':
        return { kind: 'string', text: token.text, ...span }
      case 'rawcode':
        return { kind: 'rawcode', text: token.text, ...span }
      case 'keyword':
        if (token.text === 'true' || token.text === 'false')
          return { kind: 'boolean', value: token.text === 'true', ...span }
        if (token.text === 'null') return { kind: 'null', ...span }
        if (token.text === 'function') {
          const target = name('a function name')
          return { kind: 'function-ref', name: target, start: token.start, end: target.end }
        }
        break
      case 'operator':
        if (token.text === '(') {
          const inner = expression()
          const close = expect(')')
          return { kind: 'paren', inner, start: token.start, end: close.end }
        }
        break
      case 'identifier': {
        const reference = { name: token.text, ...span }
        if (is('(')) return call(reference)
        if (is('[')) {
          next()
          const index = expression()
          const close = expect(']')
          return { kind: 'index', name: reference, index, start: token.start, end: close.end }
        }
        return { kind: 'name', name: reference, ...span }
      }
      default:
        break
    }
    at -= 1
    return fail(token.kind === 'newline' || token.kind === 'end' ? 'expected an expression' : `unexpected «${token.text}»`)
  }
  const call = (target: JassName): JassExpression & { kind: 'call' } => {
    expect('(')
    const args: JassExpression[] = []
    if (!is(')')) {
      args.push(expression())
      while (is(',')) {
        next()
        args.push(expression())
      }
    }
    const close = expect(')')
    return { kind: 'call', name: target, args, start: target.start, end: close.end }
  }

  const variable = (local: boolean): JassVariable => {
    const first = peek()
    const constant = !local && is('constant')
    if (constant) next()
    const type = typeName(false)
    const array = is('array')
    if (array) next()
    const variableName = name('a variable name')
    let init: JassExpression | undefined
    if (is('=')) {
      if (array) fail('an array cannot be initialized')
      next()
      init = expression()
    } else if (constant) fail('a constant needs a value')
    return {
      constant,
      type,
      array,
      name: variableName,
      ...(init === undefined ? {} : { init }),
      start: first.start,
      end: init?.end ?? variableName.end,
    }
  }
  const signature = () => {
    expect('takes')
    const parameters: JassParameter[] = []
    if (is('nothing')) next()
    else
      for (;;) {
        const type = typeName(false)
        const parameterName = name('a parameter name')
        parameters.push({ type, name: parameterName, start: type.start, end: parameterName.end })
        if (!is(',')) break
        next()
      }
    expect('returns')
    return { parameters, returns: typeName(true) }
  }

  /** Statements until one of `closers` starts a line; the closer is left for the caller. */
  const block = (closers: readonly string[]): JassStatement[] => {
    const body: JassStatement[] = []
    for (;;) {
      skipBlankLines()
      if (closers.some(closer => is(closer)) || peek().kind === 'end') return body
      if (is('endfunction') || is('function')) return body
      try {
        body.push(statement())
      } catch (failure) {
        recover(failure)
      }
    }
  }
  const statement = (): JassStatement => {
    const first = next()
    const text = first.kind === 'keyword' ? first.text : ''
    switch (text) {
      case 'set': {
        const target = name('a variable name')
        let index: JassExpression | undefined
        if (is('[')) {
          next()
          index = expression()
          expect(']')
        }
        expect('=')
        const value = expression()
        endOfLine()
        return { kind: 'set', name: target, ...(index === undefined ? {} : { index }), value, start: first.start, end: value.end }
      }
      case 'call': {
        const invoked = call(name('a function name'))
        endOfLine()
        return { kind: 'call', call: invoked, start: first.start, end: invoked.end }
      }
      case 'if': {
        const branches: { condition: JassExpression; body: JassStatement[] }[] = []
        let condition = expression()
        expect('then')
        endOfLine()
        let otherwise: JassStatement[] | undefined
        for (;;) {
          branches.push({ condition, body: block(['elseif', 'else', 'endif']) })
          if (is('elseif')) {
            next()
            condition = expression()
            expect('then')
            endOfLine()
            continue
          }
          if (is('else')) {
            next()
            endOfLine()
            otherwise = block(['endif'])
          }
          break
        }
        const close = expect('endif')
        endOfLine()
        return { kind: 'if', branches, ...(otherwise === undefined ? {} : { otherwise }), start: first.start, end: close.end }
      }
      case 'loop': {
        endOfLine()
        const body = block(['endloop'])
        const close = expect('endloop')
        endOfLine()
        return { kind: 'loop', body, start: first.start, end: close.end }
      }
      case 'exitwhen': {
        const condition = expression()
        endOfLine()
        return { kind: 'exitwhen', condition, start: first.start, end: condition.end }
      }
      case 'return': {
        const value = peek().kind === 'newline' || peek().kind === 'end' ? undefined : expression()
        endOfLine()
        return { kind: 'return', ...(value === undefined ? {} : { value }), start: first.start, end: value?.end ?? first.end }
      }
      case 'debug': {
        const inner = statement()
        return { kind: 'debug', statement: inner, start: first.start, end: inner.end }
      }
      default:
        at -= 1
        return fail(`expected a statement, found «${first.text || first.kind}»`)
    }
  }

  const declaration = (): JassDeclaration => {
    const first = peek()
    if (is('type')) {
      next()
      const typeDeclared = name('a type name')
      expect('extends')
      const base = name('a base type')
      endOfLine()
      return { kind: 'type', name: typeDeclared, base, start: first.start, end: base.end }
    }
    if (is('globals')) {
      next()
      endOfLine()
      const variables: JassVariable[] = []
      for (;;) {
        skipBlankLines()
        if (is('endglobals') || peek().kind === 'end') break
        try {
          variables.push(variable(false))
          endOfLine()
        } catch (failure) {
          recover(failure)
        }
      }
      const close = expect('endglobals')
      endOfLine()
      return { kind: 'globals', variables, start: first.start, end: close.end }
    }
    const constant = is('constant')
    if (constant) next()
    if (is('native')) {
      next()
      const nativeName = name('a native name')
      const { parameters, returns } = signature()
      endOfLine()
      return { kind: 'native', constant, name: nativeName, parameters, returns, start: first.start, end: returns.end }
    }
    if (is('function')) {
      next()
      const functionName = name('a function name')
      const { parameters, returns } = signature()
      endOfLine()
      const locals: JassVariable[] = []
      for (;;) {
        skipBlankLines()
        if (!is('local')) break
        try {
          next()
          locals.push(variable(true))
          endOfLine()
        } catch (failure) {
          recover(failure)
        }
      }
      const body = block(['endfunction'])
      // A missing endfunction is reported, and the next declaration still parses.
      const close = is('endfunction') ? next() : undefined
      if (close === undefined)
        errors.push({ start: functionName.start, end: functionName.end, message: `«${functionName.name}» has no endfunction` })
      else endOfLine()
      return {
        kind: 'function',
        constant,
        name: functionName,
        parameters,
        returns,
        locals,
        body,
        start: first.start,
        end: close?.end ?? body.at(-1)?.end ?? locals.at(-1)?.end ?? returns.end,
      }
    }
    return fail(`expected a declaration, found «${first.text || first.kind}»`)
  }

  const declarations: JassDeclaration[] = []
  for (;;) {
    signal?.throwIfAborted()
    skipBlankLines()
    if (peek().kind === 'end') break
    try {
      declarations.push(declaration())
    } catch (failure) {
      recover(failure)
    }
  }
  return {
    declarations,
    comments,
    errors,
    tokens: tokens.filter(token => token.kind !== 'newline' && token.kind !== 'end'),
  }
}
