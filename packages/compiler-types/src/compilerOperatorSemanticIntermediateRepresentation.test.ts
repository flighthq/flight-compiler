import type {
  IrAssignmentOperatorSemantics,
  IrBinaryOperatorSemantics,
  IrNullishComparisonEvidence,
  IrOperatorOperandDomains,
  IrOperatorValueDomain,
  IrUnionMemberTestEvidence,
  IrUnaryOperatorSemantics,
} from './compilerOperatorSemanticIntermediateRepresentation.js';

describe('compiler operator semantic intermediate representation contracts', () => {
  it('uses one closed target-neutral value-domain vocabulary for every operator arity', () => {
    expectTypeOf<IrOperatorValueDomain>().toEqualTypeOf<
      'bigint' | 'boolean' | 'null' | 'number' | 'object' | 'string' | 'symbol' | 'undefined' | 'unknown'
    >();
    expectTypeOf<IrOperatorOperandDomains>().toEqualTypeOf<
      Readonly<{
        declared: IrOperatorValueDomain;
        flow: IrOperatorValueDomain;
      }>
    >();
    expectTypeOf<IrAssignmentOperatorSemantics>().toEqualTypeOf<
      Readonly<{
        left: IrOperatorOperandDomains;
        result: IrOperatorValueDomain;
        right: IrOperatorOperandDomains;
      }>
    >();
    // A binary comparison carries one thing an assignment cannot: which absent values the compared
    // operand admits, which is what a single-absent-value target needs to decide `x === undefined`.
    expectTypeOf<IrBinaryOperatorSemantics>().toEqualTypeOf<
      Readonly<{
        left: IrOperatorOperandDomains;
        nullishComparison?: IrNullishComparisonEvidence | undefined;
        result: IrOperatorValueDomain;
        right: IrOperatorOperandDomains;
        unionMemberTest?: IrUnionMemberTestEvidence | undefined;
      }>
    >();
    expectTypeOf<IrUnaryOperatorSemantics>().toEqualTypeOf<
      Readonly<{
        operand: IrOperatorOperandDomains;
        result: IrOperatorValueDomain;
      }>
    >();
  });
});
