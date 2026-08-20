import type {
  IrIndexedReceiver,
  IrTypedArrayElementWidth,
  IrTypedArrayReceiver,
} from './compilerAccessSemanticIntermediateRepresentation.js';
import type {
  IrAssignmentOperator,
  IrBinaryOperator,
  IrPostfixUnaryOperator,
  IrPrefixUnaryOperator,
} from './compilerOperatorIntermediateRepresentation.js';
import type {
  IrOperatorOperandDomains,
  IrOperatorValueDomain,
} from './compilerOperatorSemanticIntermediateRepresentation.js';

export type CompilerStaticTruthinessContext =
  | 'conditionalExpression'
  | 'controlFlowCondition'
  | 'logicalOperand'
  | 'negationOperand';

export type CompilerStaticIndexedAccessMode = 'read' | 'readWrite' | 'write';

export type CompilerStaticNumericArithmeticFact =
  | Readonly<{
      kind: 'numericArithmetic';
      left: IrOperatorOperandDomains;
      operation: 'assignment';
      operator: Extract<IrAssignmentOperator, '%=' | '**=' | '*=' | '+=' | '-=' | '/='>;
      result: 'bigint' | 'number';
      right: IrOperatorOperandDomains;
    }>
  | Readonly<{
      kind: 'numericArithmetic';
      left: IrOperatorOperandDomains;
      operation: 'binary';
      operator: Extract<IrBinaryOperator, '%' | '**' | '*' | '+' | '-' | '/'>;
      result: 'bigint' | 'number';
      right: IrOperatorOperandDomains;
    }>
  | Readonly<{
      kind: 'numericArithmetic';
      operand: IrOperatorOperandDomains;
      operation: 'postfixUnary';
      operator: IrPostfixUnaryOperator;
      result: 'bigint' | 'number';
    }>
  | Readonly<{
      kind: 'numericArithmetic';
      operand: IrOperatorOperandDomains;
      operation: 'prefixUnary';
      operator: Extract<IrPrefixUnaryOperator, '+' | '++' | '-' | '--'>;
      result: 'bigint' | 'number';
    }>;

export type CompilerStaticFactCount =
  | Readonly<{
      count: number;
      domain: IrOperatorValueDomain;
      kind: 'truthiness';
      context: CompilerStaticTruthinessContext;
    }>
  | Readonly<{
      count: number;
      domain: 'bigint' | 'number';
      kind: 'numericRelation';
    }>
  | (CompilerStaticNumericArithmeticFact & Readonly<{ count: number }>)
  | Readonly<{
      count: number;
      kind: 'logicalExpression';
      left: IrOperatorValueDomain;
      operator: Extract<IrBinaryOperator, '&&' | '||'>;
      result: IrOperatorValueDomain;
      right: IrOperatorValueDomain;
    }>
  | Readonly<{
      access: CompilerStaticIndexedAccessMode;
      count: number;
      kind: 'indexedAccess';
      receivers: readonly [IrIndexedReceiver, ...IrIndexedReceiver[]];
    }>
  | Readonly<{
      count: number;
      kind: 'typedArraySet';
      receivers: readonly [IrTypedArrayReceiver, ...IrTypedArrayReceiver[]];
    }>
  | Readonly<{
      count: number;
      kind: 'mixedWidthIndexedWrite';
      receivers: readonly [IrTypedArrayReceiver, IrTypedArrayReceiver, ...IrTypedArrayReceiver[]];
      widths: readonly [IrTypedArrayElementWidth, IrTypedArrayElementWidth, ...IrTypedArrayElementWidth[]];
    }>;

export interface CompilerStaticFactAudit {
  readonly facts: readonly CompilerStaticFactCount[];
  readonly modules: number;
  readonly schema: 'flight-compiler-static-facts/5';
}
