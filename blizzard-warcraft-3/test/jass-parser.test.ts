import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { extension } from './war3-harness.js'

const { parseJass } = (await import(
  pathToFileURL(join(extension, 'dist', 'jass', 'parser.js')).href
)) as typeof import('../dist/jass/parser.js')

const SCRIPT = `// A script written for the parser test.
type thing extends handle
constant native MakeThing takes integer id, real x returns thing
globals
    constant integer LIMIT = $0A
    real array delays
    thing last = null
endglobals

function Count takes integer step returns integer
    local integer total = 0
    loop
        exitwhen total >= LIMIT or not (step > 0)
        set total = total + step * -1
        set delays[total] = .5
    endloop
    if total == 'hfoo' then
        call MakeThing('A', 1.5)
    elseif total != 0 then
        return 1
    else
        debug call Count(1)
    endif
    return total
endfunction
`

describe('JASS parser', () => {
  it('reads every declaration and statement of the language', () => {
    const program = parseJass(SCRIPT)
    expect(program.errors).toEqual([])
    expect(program.declarations.map(item => item.kind)).toEqual(['type', 'native', 'globals', 'function'])
    const [type, native, globals, fn] = program.declarations
    expect(type).toMatchObject({ name: { name: 'thing' }, base: { name: 'handle' } })
    expect(native).toMatchObject({ constant: true, name: { name: 'MakeThing' }, returns: { name: 'thing' } })
    if (native?.kind !== 'native' || globals?.kind !== 'globals' || fn?.kind !== 'function') throw new Error('shape')
    expect(native.parameters.map(item => `${item.type.name} ${item.name.name}`)).toEqual(['integer id', 'real x'])
    expect(globals.variables.map(item => [item.constant, item.type.name, item.array, item.name.name])).toEqual([
      [true, 'integer', false, 'LIMIT'],
      [false, 'real', true, 'delays'],
      [false, 'thing', false, 'last'],
    ])
    expect(fn.locals.map(item => item.name.name)).toEqual(['total'])
    expect(fn.body.map(item => item.kind)).toEqual(['loop', 'if', 'return'])
    const loop = fn.body[0]
    if (loop?.kind !== 'loop') throw new Error('shape')
    // `not` binds looser than a comparison and tighter than `or`.
    expect(loop.body[0]).toMatchObject({
      kind: 'exitwhen',
      condition: { kind: 'binary', operator: 'or', right: { kind: 'unary', operator: 'not' } },
    })
    // `*` binds tighter than `+`, and the minus is unary.
    expect(loop.body[1]).toMatchObject({
      kind: 'set',
      value: { operator: '+', right: { operator: '*', right: { kind: 'unary', operator: '-' } } },
    })
    const branch = fn.body[1]
    if (branch?.kind !== 'if') throw new Error('shape')
    expect(branch.branches).toHaveLength(2)
    expect(branch.otherwise?.[0]).toMatchObject({ kind: 'debug', statement: { kind: 'call' } })
    // Spans are offsets into the source.
    expect(SCRIPT.slice(fn.name.start, fn.name.end)).toBe('Count')
  })

  it('reports a broken line and keeps reading the rest', () => {
    const program = parseJass(`function Broken takes nothing returns nothing
    set = 5
    call Fine()
endfunction
function Next takes nothing returns nothing
endfunction
`)
    expect(program.errors).toHaveLength(1)
    expect(program.errors[0]?.message).toMatch(/expected a variable name/u)
    expect(program.declarations.map(item => (item.kind === 'function' ? item.name.name : item.kind))).toEqual([
      'Broken',
      'Next',
    ])
  })

  it('names a function without its endfunction and still reads the next one', () => {
    const program = parseJass(`function Open takes nothing returns nothing
    call Something()
function After takes nothing returns nothing
endfunction
`)
    expect(program.errors.map(item => item.message)).toEqual(['«Open» has no endfunction'])
    expect(program.declarations).toHaveLength(2)
  })
})
