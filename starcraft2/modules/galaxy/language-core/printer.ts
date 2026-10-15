import * as gt from './types.js';
import { tokenToString } from './scanner.js';
import { getKindName, isToken} from './utils.js';

/** How a script is laid out. The defaults are this printer's historical style;
 *  `editorPrinterOptions()` reproduces what SC2 Editor's own Galaxy generator
 *  writes, so a generated script can be diffed against an editor-compiled one. */
export interface PrinterOptions {
    indent: string;
    /** `void f (int x)` — the editor separates a declaration's name from its parameters. */
    spaceBeforeParameterList: boolean;
    /** `void f (int x) {` — the editor opens a function body on the signature line. */
    functionBraceOnSameLine: boolean;
}

const DEFAULT_PRINTER_OPTIONS: PrinterOptions = {
    indent: '\t',
    spaceBeforeParameterList: false,
    functionBraceOnSameLine: false,
};

export function editorPrinterOptions(): PrinterOptions {
    return { indent: '    ', spaceBeforeParameterList: true, functionBraceOnSameLine: true };
}

export class Printer {
    output!: string[];
    indent!: number;
    emptyLine: boolean = true;
    private readonly options: PrinterOptions;

    private write(text: string) {
        if (this.emptyLine) {
            this.output.push(this.options.indent.repeat(this.indent));
            this.emptyLine = false;
        }
        this.output.push(text);
    }

    private whitespace(text: string = ' ') {
        if (this.emptyLine) {
            this.output.push(this.options.indent.repeat(this.indent));
            this.emptyLine = false;
        }
        if (text === '\n') {
            this.newLine();
        }
        else {
            this.output.push(text);
        }
    }

    private newLine() {
        this.output.push('\n');
        this.emptyLine = true;
    }

    private increaseIndent() {
        ++this.indent;
    }

    private decreaseIndent() {
        --this.indent;
    }

    private emitNode(node: gt.Node) {
        switch (node.kind) {
            // A synthesized comment line. The parser keeps comments as trivia, so one
            // reaches the printer only when a generator put it in a statement list —
            // SC2 Editor's own section banners are written this way.
            case gt.SyntaxKind.SingleLineCommentTrivia:
            {
                this.write(`// ${(node as unknown as { text?: string }).text ?? ''}`);
                break;
            }

            case gt.SyntaxKind.FunctionDeclaration:
            {
                const func = <gt.FunctionDeclaration>node;
                if (func.modifiers && func.modifiers.length > 0) {
                    this.emitNodeList(func.modifiers, ' ');
                    this.write(' ');
                }
                this.emitNode(func.type);
                this.write(' ');
                this.emitNode(func.name);
                if (this.options.spaceBeforeParameterList) this.write(' ');
                this.write('(');
                this.emitNodeList(func.parameters, ',', ' ');
                this.write(')');
                if (func.body) {
                    if (this.options.functionBraceOnSameLine) this.write(' ');
                    else this.newLine();
                    this.emitNode(func.body);
                }
                else {
                    this.write(';');
                }
                this.newLine();
                break;
            }

            case gt.SyntaxKind.StructDeclaration:
            {
                const struct = <gt.StructDeclaration>node;
                this.write('struct ');
                this.emitNode(struct.name);
                this.write(' {');
                this.newLine();
                this.increaseIndent();
                this.emitNodeList(struct.members, '', '\n', true);
                this.decreaseIndent();
                this.write('};');
                this.newLine();
                break;
            }

            case gt.SyntaxKind.VariableDeclaration:
            case gt.SyntaxKind.PropertyDeclaration:
            {
                const variable = <gt.VariableDeclaration>node;
                if (variable.modifiers && variable.modifiers.length > 0) {
                    this.emitNodeList(variable.modifiers, ' ');
                    this.write(' ');
                }
                this.emitNode(variable.type);
                this.write(' ');
                this.emitNode(variable.name);
                if (variable.kind === gt.SyntaxKind.VariableDeclaration && variable.initializer) {
                    this.whitespace(' ');
                    this.write('=');
                    this.whitespace(' ');
                    this.emitNode(variable.initializer);
                }
                this.write(';');
                break;
            }

            case gt.SyntaxKind.ParameterDeclaration:
            {
                const param = <gt.ParameterDeclaration>node;
                if (param.modifiers && param.modifiers.length > 0) {
                    this.emitNodeList(param.modifiers, ' ');
                    this.write(' ');
                }
                this.emitNode(param.type);
                this.write(' ');
                this.emitNode(param.name);
                break;
            }

            case gt.SyntaxKind.TypedefDeclaration:
            {
                const typedef = <gt.TypedefDeclaration>node;
                this.write('typedef ');
                this.emitNode(typedef.type);
                this.write(' ');
                this.emitNode(typedef.name);
                this.write(';');
                break;
            }

            case gt.SyntaxKind.Identifier:
            {
                const identifier = <gt.Identifier>node;
                this.write(identifier.name);
                break;
            }

            case gt.SyntaxKind.NumericLiteral:
            case gt.SyntaxKind.StringLiteral:
            {
                const literal = <gt.Literal>node;
                this.write(literal.text!);
                break;
            }

            case gt.SyntaxKind.ArrayType:
            {
                const type = <gt.ArrayTypeNode>node;
                this.emitNode(type.elementType);
                this.write('[');
                this.emitNode(type.size);
                this.write(']');
                break;
            }

            case gt.SyntaxKind.MappedType:
            {
                const type = <gt.MappedTypeNode>node;
                this.emitNode(type.returnType);
                this.write('<');
                this.emitNodeList(type.typeArguments!, ',', ' ');
                this.write('>');
                break;
            }

            case gt.SyntaxKind.BinaryExpression:
            {
                const expr = <gt.BinaryExpression>node;
                this.emitNode(expr.left);
                this.whitespace(' ');
                this.emitNode(expr.operatorToken);
                this.whitespace(' ');
                this.emitNode(expr.right);
                break;
            }

            case gt.SyntaxKind.PrefixUnaryExpression:
            {
                const expr = <gt.PrefixUnaryExpression>node;
                this.emitNode(expr.operator);
                this.emitNode(expr.operand);
                break;
            }

            case gt.SyntaxKind.PostfixUnaryExpression:
            {
                const expr = <gt.PostfixUnaryExpression>node;
                this.emitNode(expr.operand);
                this.emitNode(expr.operator);
                break;
            }

            case gt.SyntaxKind.ParenthesizedExpression:
            {
                const expr = <gt.ParenthesizedExpression>node;
                this.write('(');
                this.emitNode(expr.expression);
                this.write(')');
                break;
            }

            case gt.SyntaxKind.CallExpression:
            {
                const expr = <gt.CallExpression>node;
                this.emitNode(expr.expression);
                this.write('(');
                this.emitNodeList(expr.arguments, ',', ' ');
                this.write(')');
                break;
            }

            case gt.SyntaxKind.ElementAccessExpression:
            {
                const expr = <gt.ElementAccessExpression>node;
                this.emitNode(expr.expression);
                this.write('[');
                this.emitNode(expr.argumentExpression);
                this.write(']');
                break;
            }

            case gt.SyntaxKind.PropertyAccessExpression:
            {
                const expr = <gt.PropertyAccessExpression>node;
                this.emitNode(expr.expression);
                this.write('.');
                this.emitNode(expr.name);
                break;
            }

            case gt.SyntaxKind.Block:
            {
                const block = <gt.Block>node;
                this.write('{');
                this.newLine();
                this.increaseIndent();
                this.emitNodeList(block.statements, '', '\n', true);
                this.decreaseIndent();
                this.write('}');
                break;
            }

            case gt.SyntaxKind.IfStatement:
            {
                const ifStmt = <gt.IfStatement>node;
                this.write('if (');
                this.emitNode(ifStmt.expression);
                this.write(')');
                if (ifStmt.thenStatement.kind === gt.SyntaxKind.Block) {
                    this.whitespace(' ');
                    this.emitNode(ifStmt.thenStatement);
                }
                else {
                    this.newLine();
                    this.increaseIndent();
                    this.emitNode(ifStmt.thenStatement);
                    this.decreaseIndent();
                }
                if (ifStmt.elseStatement) {
                    this.whitespace(' ');
                    this.write('else');
                    if (ifStmt.elseStatement.kind === gt.SyntaxKind.Block ||
                        ifStmt.elseStatement.kind === gt.SyntaxKind.IfStatement) {
                        this.whitespace(' ');
                        this.emitNode(ifStmt.elseStatement);
                    }
                    else {
                        this.newLine();
                        this.increaseIndent();
                        this.emitNode(ifStmt.elseStatement);
                        this.decreaseIndent();
                    }
                }
                break;
            }

            case gt.SyntaxKind.WhileStatement:
            {
                const whileStmt = <gt.WhileStatement>node;
                this.write('while (');
                this.emitNode(whileStmt.expression);
                this.write(')');
                if (whileStmt.statement.kind === gt.SyntaxKind.Block) {
                    this.whitespace(' ');
                    this.emitNode(whileStmt.statement);
                }
                else {
                    this.newLine();
                    this.increaseIndent();
                    this.emitNode(whileStmt.statement);
                    this.decreaseIndent();
                }
                break;
            }

            case gt.SyntaxKind.DoStatement:
            {
                const doStmt = <gt.DoStatement>node;
                this.write('do');
                if (doStmt.statement.kind === gt.SyntaxKind.Block) {
                    this.whitespace(' ');
                    this.emitNode(doStmt.statement);
                }
                else {
                    this.newLine();
                    this.increaseIndent();
                    this.emitNode(doStmt.statement);
                    this.decreaseIndent();
                }
                this.whitespace(' ');
                this.write('while (');
                this.emitNode(doStmt.expression);
                this.write(');');
                break;
            }

            case gt.SyntaxKind.ForStatement:
            {
                const forStmt = <gt.ForStatement>node;
                this.write('for (');
                this.write(' ');
                if (forStmt.initializer) {
                    this.emitNode(forStmt.initializer);
                }
                this.write(';');
                if (forStmt.condition) {
                    this.whitespace(' ');
                    this.emitNode(forStmt.condition);
                }
                this.write(';');
                if (forStmt.incrementor) {
                    this.whitespace(' ');
                    this.emitNode(forStmt.incrementor);
                }
                this.write(' )');
                if (forStmt.statement.kind === gt.SyntaxKind.Block) {
                    this.whitespace(' ');
                    this.emitNode(forStmt.statement);
                }
                else {
                    this.newLine();
                    this.increaseIndent();
                    this.emitNode(forStmt.statement);
                    this.decreaseIndent();
                }
                break;
            }

            case gt.SyntaxKind.ReturnStatement:
            {
                const ret = <gt.ReturnStatement>node;
                this.write('return');
                if (ret.expression) {
                    this.whitespace(' ');
                    this.emitNode(ret.expression);
                }
                this.write(';');
                break;
            }

            case gt.SyntaxKind.ExpressionStatement:
            {
                const exprStmt = <gt.ExpressionStatement>node;
                this.emitNode(exprStmt.expression);
                this.write(';');
                break;
            }

            case gt.SyntaxKind.IncludeStatement:
            {
                const inc = <gt.IncludeStatement>node;
                this.write('include ');
                this.emitNode(inc.path);
                break;
            }

            case gt.SyntaxKind.EmptyStatement:
            {
                this.write(';');
                break;
            }

            case gt.SyntaxKind.BreakStatement:
            {
                this.write('break;');
                break;
            }

            case gt.SyntaxKind.ContinueStatement:
            {
                this.write('continue;');
                break;
            }

            case gt.SyntaxKind.BreakpointStatement:
            {
                this.write('breakpoint;');
                break;
            }

            case gt.SyntaxKind.SourceFile:
            {
                const sf = <gt.SourceFile>node;
                this.emitNodeList(sf.statements, '', '\n', true);
                break;
            }

            case gt.SyntaxKind.Unknown:
            {
                // TODO: throw exception?
                break;
            }

            default:
            {
                if (isToken(node)) {
                    this.write(tokenToString(node.kind)!);
                    break;
                }

                throw new Error(`unhandled node '${getKindName(node.kind)}'`);
            }
        }
    }

    private emitNodeList(nodesList: ReadonlyArray<gt.Node>, textSeparator?: string, whitespaceSeparator?: string, includeSeparatorAtEnd: boolean = false) {
        nodesList.forEach((node: gt.Node, index: number) => {
            this.emitNode(node);
            if (includeSeparatorAtEnd || nodesList.length !== (index + 1)) {
                if (textSeparator) {
                    this.write(textSeparator);
                }
                if (whitespaceSeparator) {
                    this.whitespace(whitespaceSeparator);
                }
            }
        });
    }

    private reset() {
        this.output = [];
        this.indent = 0;
    }

    private flush(): string {
        const text = this.output.join('');
        this.reset();
        return text;
    }

    public printNode(node: gt.Node): string {
        this.emitNode(node);
        return this.flush();
    }

    public printFile(sourceFile: gt.SourceFile): string {
        this.emitNode(sourceFile);
        this.newLine();
        return this.flush();
    }

    constructor(options: Partial<PrinterOptions> = {}) {
        this.options = { ...DEFAULT_PRINTER_OPTIONS, ...options };
        this.reset();
    }
}
