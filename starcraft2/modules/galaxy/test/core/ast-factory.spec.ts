import { describe, it, expect } from 'vitest';
import { SyntaxKind, Printer } from '@modkit/blizzard-starcraft2/galaxy/language-core';
import {
  createIdentifier,
  createNumericLiteral,
  createStringLiteral,
  createBinaryExpression,
  createPrefixUnaryExpression,
  createUnaryNot,
  createParenthesizedExpression,
  createForStatement,
  createIfStatement,
  createWhileStatement,
  createReturnStatement,
  createExpressionStatement,
  createBlock,
  createFunctionDeclaration,
  createParameter,
  createVariableDeclaration,
} from '@modkit/blizzard-starcraft2/triggers/galaxy-conversion/internal/ast-factory.js';

describe('ast-factory', () => {
  const printer = new Printer();

  describe('createPrefixUnaryExpression', () => {
    it('creates !expr (logical not)', () => {
      const expr = createPrefixUnaryExpression(
        SyntaxKind.ExclamationToken,
        createIdentifier('runActions')
      );
      expect(expr.kind).toBe(SyntaxKind.PrefixUnaryExpression);
      expect(expr.operator.kind).toBe(SyntaxKind.ExclamationToken);
      expect((expr.operand as any).name).toBe('runActions');
      const code = printer.printNode(expr);
      expect(code).toBe('!runActions');
    });

    it('creates -expr (negation)', () => {
      const expr = createPrefixUnaryExpression(
        SyntaxKind.MinusToken,
        createNumericLiteral(5)
      );
      const code = printer.printNode(expr);
      expect(code).toBe('-5');
    });
  });

  describe('createUnaryNot', () => {
    it('is a shorthand for !expr', () => {
      const expr = createUnaryNot(createIdentifier('testConds'));
      const code = printer.printNode(expr);
      expect(code).toBe('!testConds');
    });
  });

  describe('createParenthesizedExpression', () => {
    it('wraps expression in parentheses', () => {
      const inner = createBinaryExpression(
        createIdentifier('a'),
        SyntaxKind.EqualsEqualsToken,
        createNumericLiteral(1)
      );
      const expr = createParenthesizedExpression(inner);
      expect(expr.kind).toBe(SyntaxKind.ParenthesizedExpression);
      const code = printer.printNode(expr);
      expect(code).toBe('(a == 1)');
    });

    it('works with nested parentheses', () => {
      const inner = createUnaryNot(
        createParenthesizedExpression(
          createBinaryExpression(
            createCallExpression('GameIsOnline', []),
            SyntaxKind.EqualsEqualsToken,
            createIdentifier('true')
          )
        )
      );
      const code = printer.printNode(inner);
      expect(code).toBe('!(GameIsOnline() == true)');
    });
  });

  describe('createForStatement', () => {
    it('creates a basic for loop', () => {
      const forLoop = createForStatement(
        null,
        createBinaryExpression(
          createIdentifier('i'),
          SyntaxKind.LessThanEqualsToken,
          createNumericLiteral(10)
        ),
        createExpressionStatement(
          createBinaryExpression(
            createIdentifier('i'),
            SyntaxKind.PlusEqualsToken,
            createNumericLiteral(1)
          )
        ).expression,
        [
          createExpressionStatement(
            createCallExpression('DoSomething', [])
          ),
        ]
      );
      const code = printer.printNode(forLoop);
      expect(code).toContain('for (');
      expect(code).toContain('; i <= 10;');
      expect(code).toContain('i += 1');
      expect(code).toContain('DoSomething()');
    });

    it('creates for loop with initializer', () => {
      const init = createBinaryExpression(
        createIdentifier('autoVar'),
        SyntaxKind.EqualsToken,
        createNumericLiteral(1)
      );
      const forLoop = createForStatement(
        init,
        createBinaryExpression(
          createIdentifier('autoVar'),
          SyntaxKind.LessThanEqualsToken,
          createIdentifier('autoEnd')
        ),
        createExpressionStatement(
          createBinaryExpression(
            createIdentifier('autoVar'),
            SyntaxKind.PlusEqualsToken,
            createNumericLiteral(1)
          )
        ).expression,
        []
      );
      const code = printer.printNode(forLoop);
      expect(code).toContain('for ( autoVar = 1; autoVar <= autoEnd; autoVar += 1 )');
    });
  });

  describe('createBinaryExpression with EqualsToken', () => {
    it('creates assignment expression', () => {
      const expr = createBinaryExpression(
        createIdentifier('lv_var'),
        SyntaxKind.EqualsToken,
        createNumericLiteral(5)
      );
      const code = printer.printNode(expr);
      expect(code).toBe('lv_var = 5');
    });
  });
});

function createCallExpression(name: string, args: any[]): any {
  // Helper for tests — simplified
  const arr = args as any;
  arr.line = 0; arr.char = 0; arr.pos = 0; arr.end = 0;
  return {
    kind: SyntaxKind.CallExpression,
    line: 0, char: 0, pos: 0, end: 0,
    expression: createIdentifier(name),
    arguments: arr,
    syntaxTokens: [],
    id: 1,
  };
}
