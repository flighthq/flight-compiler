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

export interface IrBinaryOperatorSemantics {
  readonly left: IrOperatorOperandDomains;
  readonly nullishComparison?: IrNullishComparisonEvidence | undefined;
  readonly result: IrOperatorValueDomain;
  readonly right: IrOperatorOperandDomains;
}

export interface IrUnaryOperatorSemantics {
  readonly operand: IrOperatorOperandDomains;
  readonly result: IrOperatorValueDomain;
}
