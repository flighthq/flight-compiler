import type { IrCallSemantics, IrElementAccessSemantics } from './compilerAccessSemanticIntermediateRepresentation.js';
import type { IrBindingIdentity, IrIdentifierReference } from './compilerBindingIntermediateRepresentation.js';
import type { IrBindingPattern } from './compilerBindingPatternIntermediateRepresentation.js';
import type {
  IrAssignmentOperator,
  IrBinaryOperator,
  IrPostfixUnaryOperator,
  IrPrefixUnaryOperator,
} from './compilerOperatorIntermediateRepresentation.js';
import type {
  IrAssignmentOperatorSemantics,
  IrBinaryOperatorSemantics,
  IrUnaryOperatorSemantics,
} from './compilerOperatorSemanticIntermediateRepresentation.js';
import type { IrFunctionTypeParameter, IrType, IrTypeParameter } from './compilerTypeIntermediateRepresentation.js';

export type IrParameter = Omit<IrFunctionTypeParameter, 'name'> &
  Readonly<{ binding: IrBindingIdentity }> &
  (Readonly<{ initializer?: never; optional: false }> | Readonly<{ initializer?: IrExpression; optional: true }>);

export interface IrIdentifierExpression {
  readonly kind: 'identifier';
  readonly reference: IrIdentifierReference;
}

export type IrTupleExpressionElement =
  | Readonly<{ expression: IrExpression; optional: false }>
  | Readonly<{ expression?: IrExpression; optional: true }>;

export type IrTupleSpreadSegment =
  | Readonly<{ element: IrTupleExpressionElement; kind: 'element' }>
  | Readonly<{
      expression: IrExpression;
      kind: 'spread';
      type: Extract<IrType, { kind: 'tuple' }>;
    }>;

export type IrExpression =
  | Readonly<{ kind: 'array'; elements: ReadonlyArray<IrExpression | undefined> }>
  | Readonly<{
      kind: 'assignment';
      left: IrExpression;
      operator: IrAssignmentOperator;
      right: IrExpression;
      semantics: IrAssignmentOperatorSemantics;
    }>
  | Readonly<{ kind: 'await'; expression: IrExpression }>
  | Readonly<{
      kind: 'binary';
      left: IrExpression;
      operator: IrBinaryOperator;
      right: IrExpression;
      semantics: IrBinaryOperatorSemantics;
    }>
  | Readonly<{
      kind: 'call';
      arguments: readonly IrExpression[];
      callee: IrExpression;
      optional: boolean;
      semantics: IrCallSemantics;
      typeArguments: readonly IrType[];
    }>
  | Readonly<{ kind: 'cast'; expression: IrExpression; type: IrType }>
  | Readonly<{ condition: IrExpression; kind: 'conditional'; whenFalse: IrExpression; whenTrue: IrExpression }>
  | Readonly<{
      index: IrExpression;
      kind: 'element';
      object: IrExpression;
      optional: boolean;
      semantics: IrElementAccessSemantics;
    }>
  | Readonly<{
      async: boolean;
      body: readonly IrStatement[];
      binding?: IrBindingIdentity | undefined;
      expression?: IrExpression | undefined;
      kind: 'function';
      parameters: readonly IrParameter[];
      returns: IrType;
      typeParameters: readonly IrTypeParameter[];
    }>
  | IrIdentifierExpression
  | Readonly<{ kind: 'literal'; value: boolean | null | number | string }>
  | Readonly<{
      arguments: readonly IrExpression[];
      callee: IrExpression;
      kind: 'new';
      typeArguments: readonly IrType[];
    }>
  | Readonly<{ kind: 'object'; members: readonly IrObjectMember[] }>
  | Readonly<{ kind: 'property'; name: string; object: IrExpression; optional: boolean }>
  | Readonly<{ flags: string; kind: 'regexp'; pattern: string }>
  | Readonly<{ expression: IrExpression; kind: 'spread' }>
  | Readonly<{ kind: 'template'; parts: ReadonlyArray<IrExpression | string> }>
  | Readonly<{ elements: readonly IrTupleExpressionElement[]; kind: 'tuple' }>
  | Readonly<{ kind: 'tupleRest'; object: IrExpression; start: number }>
  | Readonly<{
      kind: 'tupleSpread';
      segments: readonly IrTupleSpreadSegment[];
      type: Extract<IrType, { kind: 'tuple' }>;
    }>
  | Readonly<{ kind: 'tupleSuffix'; object: IrIdentifierExpression; start: number; width: number }>
  | Readonly<{
      kind: 'unary';
      operand: IrExpression;
      operator: IrPostfixUnaryOperator;
      postfix: true;
      semantics: IrUnaryOperatorSemantics;
    }>
  | Readonly<{
      kind: 'unary';
      operand: IrExpression;
      operator: IrPrefixUnaryOperator;
      postfix: false;
      semantics: IrUnaryOperatorSemantics;
    }>
  | Readonly<{ fallback: IrExpression; kind: 'undefinedDefault'; value: IrExpression }>;

export type IrObjectMember =
  | Readonly<{ key: IrExpression; kind: 'computedProperty'; value: IrExpression }>
  | Readonly<{ kind: 'property'; name: string; value: IrExpression }>
  | Readonly<{ expression: IrExpression; kind: 'spread' }>;

export interface IrNamedVariable {
  readonly binding: IrBindingIdentity;
  readonly initialValue?: 'undefined' | undefined;
  readonly initializer?: IrExpression | undefined;
  readonly mutable: boolean;
  readonly type?: IrType | undefined;
}

export interface IrPatternVariable {
  readonly initializer?: IrExpression | undefined;
  readonly mutable: boolean;
  readonly pattern: IrBindingPattern;
  readonly type?: IrType | undefined;
}

export type IrVariable = IrNamedVariable | IrPatternVariable;

export interface IrCatchClause {
  readonly binding?: IrBindingIdentity | undefined;
  readonly body: IrStatement;
}

export interface IrSwitchCase {
  readonly expression?: IrExpression | undefined;
  readonly statements: readonly IrStatement[];
}

export interface IrForInKeyPlan {
  readonly keys: readonly string[];
  readonly kind: 'staticObject';
}

export type IrSwitchCaseCompletion =
  | Readonly<{ kind: 'abrupt' }>
  | Readonly<{ kind: 'fallthrough' }>
  | Readonly<{ kind: 'localBreak' }>
  | Readonly<{ kind: 'unsupported'; reason: string }>;

export type IrStatement =
  | Readonly<{ kind: 'block'; statements: readonly IrStatement[] }>
  | Readonly<{ kind: 'break' }>
  | Readonly<{ kind: 'continue' }>
  | Readonly<{ body: IrStatement; condition: IrExpression; kind: 'do' }>
  | Readonly<{ expression: IrExpression; kind: 'expression' }>
  | Readonly<{
      body: IrStatement;
      condition?: IrExpression | undefined;
      increment?: IrExpression | undefined;
      initializer?: IrExpression | readonly IrVariable[] | undefined;
      kind: 'for';
    }>
  | Readonly<{ await: boolean; body: IrStatement; iterable: IrExpression; kind: 'forOf'; variable: IrVariable }>
  | Readonly<{
      body: IrStatement;
      keyPlan?: IrForInKeyPlan | undefined;
      kind: 'forIn';
      object: IrExpression;
      variable: IrVariable;
    }>
  | Readonly<{
      condition: IrExpression;
      consequent: IrStatement;
      kind: 'if';
      otherwise?: IrStatement | undefined;
    }>
  | Readonly<{ expression?: IrExpression | undefined; kind: 'return' }>
  | Readonly<{ cases: readonly IrSwitchCase[]; expression: IrExpression; kind: 'switch' }>
  | Readonly<{ expression: IrExpression; kind: 'throw' }>
  | Readonly<{
      catchClause?: IrCatchClause | undefined;
      finallyBody?: IrStatement | undefined;
      kind: 'try';
      tryBody: IrStatement;
    }>
  | Readonly<{ declarations: readonly IrVariable[]; kind: 'variable' }>
  | Readonly<{ body: IrStatement; condition: IrExpression; kind: 'while' }>;
