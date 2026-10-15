/**
 * Unit tests for g2t-payload.ts — payload decode helpers for Galaxy→trigger.
 * These functions decode the __MKX_SF__ / __MKX_FCJSON__ sentinel payloads
 * that trigger-to-galaxy embeds in Galaxy calls for unresolved sub-function trees.
 */
import { describe, it, expect } from 'vitest';
import { SyntaxKind } from '@modkit/blizzard-starcraft2/galaxy/language-core';
import {
  readStringLiteral,
  readIntLiteral,
  decodeUnknownSubFunctionPayload,
  decodeRoleToken,
} from '@modkit/blizzard-starcraft2/triggers/galaxy-conversion/internal/g2t-payload.js';
import {
  UNKNOWN_SUBFUNC_JSON_SENTINEL,
  UNKNOWN_SUBFUNC_TYPE_SENTINEL,
} from '@modkit/blizzard-starcraft2/triggers/document/payload-sentinels.js';

// ---------------------------------------------------------------------------
// Helpers — minimal mock AST nodes
// ---------------------------------------------------------------------------

const strNode = (value: string) => ({ kind: SyntaxKind.StringLiteral, value });
const numNode = (v: number) => ({ kind: SyntaxKind.NumericLiteral, text: String(v), value: v });
const idNode = (name: string) => ({ kind: SyntaxKind.Identifier, name });
const paren = (expr: any) => ({ kind: SyntaxKind.ParenthesizedExpression, expression: expr });

function makeRoleCtx(entries: Array<[string, { library: string; id: string }]> = []): any {
  return { roleToSubFuncType: new Map(entries) };
}

// ---------------------------------------------------------------------------
// readStringLiteral
// ---------------------------------------------------------------------------

describe('readStringLiteral', () => {
  it('reads the value from a StringLiteral node', () => {
    expect(readStringLiteral(strNode('hello'))).toBe('hello');
  });

  it('reads an empty string', () => {
    expect(readStringLiteral(strNode(''))).toBe('');
  });

  it('unwraps parentheses before reading', () => {
    expect(readStringLiteral(paren(strNode('world')))).toBe('world');
  });

  it('returns undefined for non-string nodes', () => {
    expect(readStringLiteral(idNode('x'))).toBeUndefined();
    expect(readStringLiteral(numNode(5))).toBeUndefined();
  });

  it('returns undefined for null/undefined', () => {
    expect(readStringLiteral(null)).toBeUndefined();
    expect(readStringLiteral(undefined)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// readIntLiteral
// ---------------------------------------------------------------------------

describe('readIntLiteral', () => {
  it('reads a positive integer', () => {
    expect(readIntLiteral(numNode(42))).toBe(42);
  });

  it('reads zero', () => {
    expect(readIntLiteral(numNode(0))).toBe(0);
  });

  it('truncates floating-point values to integer', () => {
    const floatNode = { kind: SyntaxKind.NumericLiteral, text: '3.9', value: 3.9 };
    expect(readIntLiteral(floatNode)).toBe(3);
  });

  it('unwraps parentheses', () => {
    expect(readIntLiteral(paren(numNode(7)))).toBe(7);
  });

  it('returns undefined for non-numeric nodes', () => {
    expect(readIntLiteral(idNode('count'))).toBeUndefined();
    expect(readIntLiteral(strNode('5'))).toBeUndefined();
  });

  it('returns undefined for null/undefined', () => {
    expect(readIntLiteral(null)).toBeUndefined();
    expect(readIntLiteral(undefined)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// decodeUnknownSubFunctionPayload
// ---------------------------------------------------------------------------

describe('decodeUnknownSubFunctionPayload', () => {
  function encode(obj: unknown): string {
    const json = JSON.stringify(obj);
    const b64 = Buffer.from(json, 'utf8').toString('base64');
    return `${UNKNOWN_SUBFUNC_JSON_SENTINEL}:${b64}`;
  }

  it('decodes a valid base64-JSON payload', () => {
    const payload = { functionDef: { id: 'ABC', library: 'Ntve' }, parameters: [] };
    expect(decodeUnknownSubFunctionPayload(encode(payload))).toEqual(payload);
  });

  it('returns undefined when the sentinel prefix is missing', () => {
    const b64 = Buffer.from('{}', 'utf8').toString('base64');
    expect(decodeUnknownSubFunctionPayload(b64)).toBeUndefined();
  });

  it('rejects malformed encoded payloads instead of silently losing the tree', () => {
    expect(() => decodeUnknownSubFunctionPayload(`${UNKNOWN_SUBFUNC_JSON_SENTINEL}:!!!invalid!!!`)).toThrow('Invalid encoded Trigger function-call payload');
  });

  it('returns undefined for undefined input', () => {
    expect(decodeUnknownSubFunctionPayload(undefined)).toBeUndefined();
  });

  it('returns undefined for empty string', () => {
    expect(decodeUnknownSubFunctionPayload('')).toBeUndefined();
  });

  it('preserves nested payload structures', () => {
    const payload = {
      functionDef: { id: 'X1', name: 'IfThenElse' },
      subFunctions: [
        { functionDef: { id: 'X2', name: 'Comparison' }, parameters: [] },
      ],
    };
    expect(decodeUnknownSubFunctionPayload(encode(payload))).toEqual(payload);
  });
});

// ---------------------------------------------------------------------------
// decodeRoleToken
// ---------------------------------------------------------------------------

describe('decodeRoleToken', () => {
  it('returns undefined for undefined input', () => {
    expect(decodeRoleToken(undefined, makeRoleCtx())).toBeUndefined();
  });

  it('resolves a known role name via ctx.roleToSubFuncType', () => {
    const ctx = makeRoleCtx([
      ['Actions', { library: 'Ntve', id: '00000007' }],
      ['Conditions', { library: 'Ntve', id: '00000003' }],
    ]);
    expect(decodeRoleToken('Actions', ctx)).toEqual({ library: 'Ntve', id: '00000007' });
    expect(decodeRoleToken('Conditions', ctx)).toEqual({ library: 'Ntve', id: '00000003' });
  });

  it('returns undefined for an unknown role name', () => {
    const ctx = makeRoleCtx([['Actions', { library: 'Ntve', id: '00000007' }]]);
    expect(decodeRoleToken('UnknownRole', ctx)).toBeUndefined();
  });

  it('decodes a __MKX_SFT__:lib:id token', () => {
    const token = `${UNKNOWN_SUBFUNC_TYPE_SENTINEL}:DPAN:A1B2C3D4`;
    expect(decodeRoleToken(token, makeRoleCtx())).toEqual({ library: 'DPAN', id: 'A1B2C3D4' });
  });

  it('returns undefined for a malformed __MKX_SFT__ token with no colon separator', () => {
    const token = `${UNKNOWN_SUBFUNC_TYPE_SENTINEL}:DPAN`;
    expect(decodeRoleToken(token, makeRoleCtx())).toBeUndefined();
  });

  it('prefers __MKX_SFT__ decoding over roleToSubFuncType lookup', () => {
    const token = `${UNKNOWN_SUBFUNC_TYPE_SENTINEL}:LIB:RAWID`;
    const ctx = makeRoleCtx([[token, { library: 'OTHER', id: 'WRONG' }]]);
    expect(decodeRoleToken(token, ctx)).toEqual({ library: 'LIB', id: 'RAWID' });
  });
});
