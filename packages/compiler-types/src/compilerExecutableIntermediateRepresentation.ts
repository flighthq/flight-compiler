import type {
  IrCallSemantics,
  IrElementAccessSemantics,
  IrInvocationSemantics,
  IrOptionalChainSemantics,
  IrPropertyKeyCoercion,
} from './compilerAccessSemanticIntermediateRepresentation.js';
import type { IrAwaitSemantics } from './compilerAsyncTaskCompletionContract.js';
import type { IrBindingIdentity, IrIdentifierReference } from './compilerBindingIntermediateRepresentation.js';
import type { IrBindingPattern } from './compilerBindingPatternIntermediateRepresentation.js';
import type { IrCatchSemantics } from './compilerCatchCompletionContract.js';
import type {
  IrAssignmentOperator,
  IrBinaryOperator,
  IrPostfixUnaryOperator,
  IrPrefixUnaryOperator,
} from './compilerOperatorIntermediateRepresentation.js';
import type {
  IrAssignmentOperatorSemantics,
  IrBinaryOperatorSemantics,
  IrOperatorValueDomain,
  IrUnaryOperatorSemantics,
} from './compilerOperatorSemanticIntermediateRepresentation.js';
import type { CompilerSourceOrigin } from './compilerSourceIdentity.js';
import type { IrFunctionTypeParameter, IrType, IrTypeParameter } from './compilerTypeIntermediateRepresentation.js';

export type IrParameter = Omit<IrFunctionTypeParameter, 'name'> &
  Readonly<{ binding: IrBindingIdentity }> &
  (Readonly<{ initializer?: never; optional: false }> | Readonly<{ initializer?: IrExpression; optional: true }>);

// A member of the ambient surface, named together with the kind of value it was resolved against.
// This is what lets a backend decide a spelling from a table rather than from a name it hopes is
// unique, and what lets it refuse a member it has not decided how to lower.
export type IrResolvedMemberReceiver = 'array' | 'date' | 'map' | 'number' | 'set' | 'string' | 'task' | 'tuple';

export interface IrResolvedMember {
  readonly name: string;
  readonly receiver: IrResolvedMemberReceiver;
}

export interface IrIdentifierExpression {
  readonly kind: 'identifier';
  // Which member of a union-typed binding control flow has proved this reference to hold, named by
  // the member type. A target that represents a union as one open shape ignores it; a target that
  // represents it as a closed set of alternatives cannot reach the member's own fields without it.
  readonly narrowedMember?: string | undefined;
  // Whether control flow has proved, at this reference, that a binding whose declared type admits an
  // absent value does not hold one here. Comparing against `null` or `undefined` is not narrowing on
  // its own: the proof belongs to the reference, not to the comparison, which is why it travels here.
  readonly presence?: 'narrowedPresent' | undefined;
  readonly reference: IrIdentifierReference;
}

export interface IrControlFlowLabelIdentity extends CompilerSourceOrigin {
  readonly id: string;
  readonly name: string;
}

export interface IrObjectCopySemantics {
  readonly evaluation: 'left-to-right-once';
  readonly nullish: 'skip';
  readonly overwrite: 'replace-value-preserve-key-position';
  readonly propertyKeys: 'own-enumerable-string-and-symbol';
  readonly propertyReads: 'get-once-in-own-key-order';
  readonly targetWrites: 'create-data-property';
}

export type IrObjectExpression = Readonly<{
  kind: 'object';
  members: readonly IrObjectMember[];
  type: IrType;
}> &
  (Readonly<{ copySemantics?: never }> | Readonly<{ copySemantics: IrObjectCopySemantics }>);

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
  | Readonly<{ kind: 'await'; expression: IrExpression; semantics: IrAwaitSemantics }>
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
      thisMode: 'dynamic' | 'lexical';
      typeParameters: readonly IrTypeParameter[];
    }>
  | IrIdentifierExpression
  | Readonly<{ kind: 'literal'; value: boolean | null | number | string }>
  | Readonly<{
      arguments: readonly IrExpression[];
      callee: IrExpression;
      kind: 'new';
      semantics: IrInvocationSemantics;
      typeArguments: readonly IrType[];
    }>
  | IrObjectExpression
  | Readonly<{
      excluded: readonly IrObjectRestKey[];
      kind: 'objectRest';
      object: IrIdentifierExpression;
      type: IrType;
    }>
  | Readonly<{
      // Whether reading this member can produce no value because the written type declares it
      // optional. Distinct from an optional chain, which is about the object being absent rather than
      // the member; a target that represents absence in the type needs both.
      absent?: 'optionalMember' | undefined;
      kind: 'property';
      // Which built-in member the written type resolved this to. The property name alone cannot tell
      // an array's `length` from a field that happens to be called one, and every target spells the
      // ambient surface differently, so the receiver it was resolved against travels with the name.
      member?: IrResolvedMember | undefined;
      name: string;
      object: IrExpression;
      optional: boolean;
      optionalChain?: IrOptionalChainSemantics | undefined;
    }>
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
  | Readonly<{ kind: 'undefinedValue'; type: IrType }>
  | Readonly<{ fallback: IrExpression; kind: 'undefinedDefault'; value: IrExpression }>;

export type IrObjectMember =
  | Readonly<{ key: IrExpression; kind: 'computedProperty'; value: IrExpression }>
  | Readonly<{ kind: 'property'; name: string; value: IrExpression }>
  | Readonly<{ expression: IrExpression; kind: 'spread' }>;

export type IrObjectRestKey =
  | Readonly<{ coercion: IrPropertyKeyCoercion; kind: 'computed'; expression: IrExpression }>
  | Readonly<{ kind: 'named'; name: string }>;

export interface IrNamedVariable {
  readonly binding: IrBindingIdentity;
  readonly initialValue?: 'undefined' | 'uninitialized' | undefined;
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
  readonly semantics: IrCatchSemantics;
}

export interface IrSwitchCase {
  readonly expression?: IrExpression | undefined;
  readonly statements: readonly IrStatement[];
}

export type IrForInKeyPlan =
  | Readonly<{ evaluation: 'elide' | 'preserve'; keys: readonly string[]; kind: 'objectLiteral' }>
  | Readonly<{ evaluation: 'alreadyEvaluated'; keys: readonly string[]; kind: 'closedRecord' }>;

export type IrSwitchCaseCompletion =
  | Readonly<{ kind: 'abrupt' }>
  | Readonly<{ kind: 'fallthrough' }>
  | Readonly<{ kind: 'localBreak' }>
  | Readonly<{ kind: 'unsupported'; reason: string }>;

export type IrStatement =
  | Readonly<{ kind: 'block'; label?: IrControlFlowLabelIdentity | undefined; statements: readonly IrStatement[] }>
  | Readonly<{ kind: 'break'; target?: IrControlFlowLabelIdentity | undefined }>
  | Readonly<{ kind: 'continue'; target?: IrControlFlowLabelIdentity | undefined }>
  | Readonly<{
      body: IrStatement;
      condition: IrExpression;
      kind: 'do';
      label?: IrControlFlowLabelIdentity | undefined;
    }>
  | Readonly<{ expression: IrExpression; kind: 'expression' }>
  | Readonly<{
      body: IrStatement;
      condition?: IrExpression | undefined;
      increment?: IrExpression | undefined;
      initializer?: IrExpression | readonly IrVariable[] | undefined;
      kind: 'for';
      label?: IrControlFlowLabelIdentity | undefined;
    }>
  | Readonly<{
      await: boolean;
      body: IrStatement;
      iterable: IrExpression;
      kind: 'forOf';
      label?: IrControlFlowLabelIdentity | undefined;
      variable: IrVariable;
    }>
  | Readonly<{
      body: IrStatement;
      keyPlan?: IrForInKeyPlan | undefined;
      kind: 'forIn';
      label?: IrControlFlowLabelIdentity | undefined;
      object: IrExpression;
      variable: IrVariable;
    }>
  | Readonly<{
      condition: IrExpression;
      consequent: IrStatement;
      kind: 'if';
      origin?: CompilerSourceOrigin | undefined;
      otherwise?: IrStatement | undefined;
    }>
  | Readonly<{ expression?: IrExpression | undefined; kind: 'return' }>
  | Readonly<{
      cases: readonly IrSwitchCase[];
      expression: IrExpression;
      kind: 'switch';
      label?: IrControlFlowLabelIdentity | undefined;
      origin?: CompilerSourceOrigin | undefined;
      // What the subject compares as. A pass that rewrites a switch into equality tests cannot ask a
      // checker, so the domain travels with the statement.
      subjectDomain?: IrOperatorValueDomain | undefined;
    }>
  | Readonly<{ expression: IrExpression; kind: 'throw' }>
  | Readonly<{
      catchClause?: IrCatchClause | undefined;
      finallyBody?: IrStatement | undefined;
      kind: 'try';
      tryBody: IrStatement;
    }>
  | Readonly<{ declarations: readonly IrVariable[]; kind: 'variable' }>
  | Readonly<{
      body: IrStatement;
      condition: IrExpression;
      kind: 'while';
      label?: IrControlFlowLabelIdentity | undefined;
    }>;
