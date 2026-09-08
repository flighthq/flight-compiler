import type { IrBindingIdentity } from './compilerBindingIntermediateRepresentation.js';
import type { IrType } from './compilerTypeIntermediateRepresentation.js';

export type IrOperatorValueDomain =
  | 'bigint'
  | 'boolean'
  | 'null'
  | 'number'
  | 'object'
  | 'string'
  | 'symbol'
  | 'undefined'
  | 'unknown';

export interface IrOperatorOperandDomains {
  readonly declared: IrOperatorValueDomain;
  readonly flow: IrOperatorValueDomain;
}

export interface IrAssignmentOperatorSemantics {
  readonly left: IrOperatorOperandDomains;
  readonly result: IrOperatorValueDomain;
  readonly right: IrOperatorOperandDomains;
}

// Which absent values the compared operand can hold, when one side of an equality is `null` or
// `undefined`. A target with a single absent value can compare directly where the source admits only
// one of them, and cannot where the source admits both.
export interface IrNullishComparisonEvidence {
  readonly admitsNull: boolean;
  readonly admitsUndefined: boolean;
  readonly literal: 'null' | 'undefined';
}

// Proof that one equality comparison is exactly a test for one member of a closed union binding.
// The source checker decides the member: targets may elect a tagged representation without
// rediscovering TypeScript control flow from expression spelling.
export interface IrUnionMemberTestEvidence {
  readonly binding: IrBindingIdentity;
  readonly member: IrType;
  readonly whenResult: boolean;
}

export interface IrBinaryOperatorSemantics {
  readonly left: IrOperatorOperandDomains;
  readonly nullishComparison?: IrNullishComparisonEvidence | undefined;
  readonly result: IrOperatorValueDomain;
  readonly right: IrOperatorOperandDomains;
  readonly unionMemberTest?: IrUnionMemberTestEvidence | undefined;
}

export interface IrUnaryOperatorSemantics {
  readonly operand: IrOperatorOperandDomains;
  readonly result: IrOperatorValueDomain;
}
