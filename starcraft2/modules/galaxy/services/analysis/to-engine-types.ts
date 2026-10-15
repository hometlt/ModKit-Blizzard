/**
 * Single SC2 normalized lowering representation, shared by Galaxy, Triggers and Runtime.
 * These are the existing producers' JSON fields, not a Core IR or an executable profile.
 * Native type/literal encoding is retained; admission must establish its meaning.
 */

/** Primitive payload; source spans remain authoritative for native token interpretation. */
export type EngineLiteralValue = string | number | boolean | null;

/** Native source identity and half-open UTF-16 offsets into a Galaxy file. */
export interface EngineSourceRef {
  readonly format: 'galaxy' | 'triggers';
  readonly fileName?: string | undefined;
  readonly moduleId?: string | undefined;
  readonly elementId?: string | undefined;
  readonly elementType?: string | undefined;
  readonly span?: Readonly<{ start: number; end: number }> | undefined;
}

/** Native spelling and optional Trigger type-element identity, not a verified UVB type. */
export interface EngineTypeRef {
  readonly name: string;
  readonly gameType?: string | undefined;
  readonly elementId?: string | undefined;
  readonly moduleId?: string | undefined;
}

/** Existing serialized discriminator and its optional source witness. */
export interface EngineNodeBase<Kind extends string> {
  readonly kind: Kind;
  readonly source?: EngineSourceRef | undefined;
}

export interface EngineProgram extends EngineNodeBase<'EngineProgram'> {
  readonly modules: readonly EngineModule[];
}
export interface EngineModule extends EngineNodeBase<'EngineModule'> {
  readonly id: string;
  readonly name?: string | undefined;
  readonly imports?: readonly Readonly<{ moduleId: string; source?: EngineSourceRef | undefined }>[] | undefined;
  readonly globals: readonly EngineVariable[];
  readonly functions: readonly EngineFunction[];
  readonly triggers: readonly EngineTrigger[];
  readonly structs: readonly EngineStruct[];
  readonly presets?: readonly EnginePreset[] | undefined;
}

/** IDs belong to native source declarations; they are not private Runtime handles. */
export interface EngineVariable extends EngineNodeBase<'EngineVariable'> {
  readonly id: string;
  readonly name: string;
  readonly type: EngineTypeRef;
  readonly scope: 'global' | 'local' | 'parameter' | 'struct-field';
  readonly constant?: boolean | undefined;
  readonly initialValue?: EngineExpression | undefined;
  readonly arrayDimensions?: readonly EngineExpression[] | undefined;
}
export interface EngineFunction extends EngineNodeBase<'EngineFunction'> {
  readonly id: string;
  readonly name: string;
  readonly returnType: EngineTypeRef;
  readonly parameters: readonly EngineVariable[];
  readonly locals: readonly EngineVariable[];
  readonly body: readonly EngineStatement[];
  readonly flags: Readonly<{
    native?: boolean | undefined;
    hasBody?: boolean | undefined;
    action?: boolean | undefined;
    call?: boolean | undefined;
    customScript?: boolean | undefined;
  }>;
}
export interface EngineStruct extends EngineNodeBase<'EngineStruct'> {
  readonly id: string;
  readonly name: string;
  readonly fields: readonly EngineVariable[];
}
export interface EnginePreset extends EngineNodeBase<'EnginePreset'> {
  readonly id: string;
  readonly name?: string | undefined;
  readonly baseType?: EngineTypeRef | undefined;
  readonly values: readonly Readonly<{
    id: string;
    name?: string | undefined;
    value?: string | undefined;
    source?: EngineSourceRef | undefined;
  }>[];
}
export interface EngineTrigger extends EngineNodeBase<'EngineTrigger'> {
  readonly id: string;
  readonly name?: string | undefined;
  readonly enabled: boolean;
  readonly events: readonly EngineCallExpression[];
  readonly conditions: readonly EngineCallExpression[];
  readonly actions: readonly EngineStatement[];
  readonly locals: readonly EngineVariable[];
}

export interface EngineLiteralExpression extends EngineNodeBase<'EngineLiteralExpression'> {
  readonly value: EngineLiteralValue;
  readonly valueType?: EngineTypeRef | undefined;
}
export interface EngineIdentifierExpression extends EngineNodeBase<'EngineIdentifierExpression'> {
  readonly name: string;
}
export interface EngineVariableRefExpression extends EngineNodeBase<'EngineVariableRefExpression'> {
  readonly variableId: string;
  readonly moduleId?: string | undefined;
}
export interface EngineParameterRefExpression extends EngineNodeBase<'EngineParameterRefExpression'> {
  readonly parameterId: string;
}
export interface EngineCallExpression extends EngineNodeBase<'EngineCallExpression'> {
  readonly callee: Readonly<{
    name?: string | undefined;
    functionId?: string | undefined;
    moduleId?: string | undefined;
    nativeId?: string | undefined;
  }>;
  readonly args: readonly EngineExpression[];
  readonly native?: boolean | undefined;
}
export interface EngineMemberExpression extends EngineNodeBase<'EngineMemberExpression'> {
  readonly object: EngineExpression;
  readonly member: string;
}
export interface EngineElementAccessExpression extends EngineNodeBase<'EngineElementAccessExpression'> {
  readonly object: EngineExpression;
  readonly index: EngineExpression;
}
export interface EngineUnaryExpression extends EngineNodeBase<'EngineUnaryExpression'> {
  readonly operator: string;
  readonly operand: EngineExpression;
}
export interface EngineBinaryExpression extends EngineNodeBase<'EngineBinaryExpression'> {
  readonly operator: string;
  readonly left: EngineExpression;
  readonly right: EngineExpression;
}
/** Preserved unsupported source is analysis data, never permission to execute text. */
export interface EngineRawExpression extends EngineNodeBase<'EngineRawExpression'> {
  readonly language: 'galaxy' | 'triggers';
  readonly code: string;
}
export type EngineExpression = EngineLiteralExpression | EngineIdentifierExpression
  | EngineVariableRefExpression | EngineParameterRefExpression | EngineCallExpression
  | EngineMemberExpression | EngineElementAccessExpression | EngineUnaryExpression
  | EngineBinaryExpression | EngineRawExpression;

export interface EngineBlockStatement extends EngineNodeBase<'EngineBlockStatement'> {
  readonly statements: readonly EngineStatement[];
}
export interface EngineVariableStatement extends EngineNodeBase<'EngineVariableStatement'> {
  readonly variable: EngineVariable;
}
export interface EngineIfStatement extends EngineNodeBase<'EngineIfStatement'> {
  readonly condition: EngineExpression;
  readonly then: readonly EngineStatement[];
  readonly else?: readonly EngineStatement[] | undefined;
}
export interface EngineWhileStatement extends EngineNodeBase<'EngineWhileStatement'> {
  readonly condition: EngineExpression;
  readonly body: readonly EngineStatement[];
}
export interface EngineReturnStatement extends EngineNodeBase<'EngineReturnStatement'> {
  readonly value?: EngineExpression | undefined;
}
export interface EngineBreakStatement extends EngineNodeBase<'EngineBreakStatement'> {}
export interface EngineContinueStatement extends EngineNodeBase<'EngineContinueStatement'> {}
export interface EngineAssignmentStatement extends EngineNodeBase<'EngineAssignmentStatement'> {
  readonly target: EngineExpression;
  readonly value: EngineExpression;
  readonly operator?: '=' | '+=' | '-=' | '*=' | '/=' | undefined;
}
export interface EngineExpressionStatement extends EngineNodeBase<'EngineExpressionStatement'> {
  readonly expression: EngineExpression;
}
export interface EngineSwitchCase {
  readonly value: EngineExpression;
  readonly body: readonly EngineStatement[];
}
export interface EngineSwitchStatement extends EngineNodeBase<'EngineSwitchStatement'> {
  readonly discriminant: EngineExpression;
  readonly cases: readonly EngineSwitchCase[];
  readonly default?: readonly EngineStatement[] | undefined;
}
export interface EngineForEachStatement extends EngineNodeBase<'EngineForEachStatement'> {
  readonly variable: EngineVariable;
  readonly iterable: EngineExpression;
  readonly body: readonly EngineStatement[];
}
export interface EngineRawStatement extends EngineNodeBase<'EngineRawStatement'> {
  readonly language: 'galaxy' | 'triggers';
  readonly code: string;
}
export type EngineStatement = EngineBlockStatement | EngineVariableStatement | EngineIfStatement
  | EngineWhileStatement | EngineReturnStatement | EngineBreakStatement | EngineContinueStatement
  | EngineAssignmentStatement | EngineExpressionStatement | EngineSwitchStatement
  | EngineForEachStatement | EngineRawStatement;

export type EngineNode = EngineProgram | EngineModule | EngineVariable | EngineFunction
  | EngineStruct | EnginePreset | EngineTrigger | EngineExpression | EngineStatement;
