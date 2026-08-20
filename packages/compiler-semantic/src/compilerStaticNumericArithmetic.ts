import type {
  CompilerStaticNumericArithmeticFact,
  IrAssignmentOperator,
  IrAssignmentOperatorSemantics,
  IrBinaryOperator,
  IrBinaryOperatorSemantics,
  IrExpression,
  IrOperatorOperandDomains,
  IrOperatorValueDomain,
  IrPrefixUnaryOperator,
  IrUnaryOperatorSemantics,
} from '../../compiler-types/src/index.js';

type NumericArithmeticExpression = Extract<IrExpression, { kind: 'assignment' | 'binary' | 'unary' }>;
type NumericAssignmentOperator = Extract<CompilerStaticNumericArithmeticFact, { operation: 'assignment' }>['operator'];
type NumericBinaryOperator = Extract<CompilerStaticNumericArithmeticFact, { operation: 'binary' }>['operator'];
type NumericPrefixUnaryOperator = Extract<
  CompilerStaticNumericArithmeticFact,
  { operation: 'prefixUnary' }
>['operator'];

export function getCompilerStaticNumericArithmeticFact(
  expression: Readonly<NumericArithmeticExpression>,
): CompilerStaticNumericArithmeticFact | undefined {
  switch (expression.kind) {
    case 'assignment': {
      if (!isNumericAssignmentOperator(expression.operator)) return undefined;
      const result = getNumericBinaryOperationResult(expression.semantics);
      return result
        ? {
            kind: 'numericArithmetic',
            left: cloneOperatorOperandDomains(expression.semantics.left),
            operation: 'assignment',
            operator: expression.operator,
            result,
            right: cloneOperatorOperandDomains(expression.semantics.right),
          }
        : undefined;
    }
    case 'binary': {
      if (!isNumericBinaryOperator(expression.operator)) return undefined;
      const result = getNumericBinaryOperationResult(expression.semantics);
      return result
        ? {
            kind: 'numericArithmetic',
            left: cloneOperatorOperandDomains(expression.semantics.left),
            operation: 'binary',
            operator: expression.operator,
            result,
            right: cloneOperatorOperandDomains(expression.semantics.right),
          }
        : undefined;
    }
    case 'unary': {
      const result = getNumericUnaryOperationResult(expression.semantics);
      if (!result) return undefined;
      if (expression.postfix) {
        return {
          kind: 'numericArithmetic',
          operand: cloneOperatorOperandDomains(expression.semantics.operand),
          operation: 'postfixUnary',
          operator: expression.operator,
          result,
        };
      }
      return isNumericPrefixUnaryOperator(expression.operator)
        ? {
            kind: 'numericArithmetic',
            operand: cloneOperatorOperandDomains(expression.semantics.operand),
            operation: 'prefixUnary',
            operator: expression.operator,
            result,
          }
        : undefined;
    }
  }
}

function cloneOperatorOperandDomains(domains: Readonly<IrOperatorOperandDomains>): IrOperatorOperandDomains {
  return { declared: domains.declared, flow: domains.flow };
}

function getNumericBinaryOperationResult(
  semantics: Readonly<IrAssignmentOperatorSemantics | IrBinaryOperatorSemantics>,
): 'bigint' | 'number' | undefined {
  return semantics.left.flow === semantics.right.flow &&
    semantics.result === semantics.left.flow &&
    isNumericOperatorValueDomain(semantics.result)
    ? semantics.result
    : undefined;
}

function getNumericUnaryOperationResult(
  semantics: Readonly<IrUnaryOperatorSemantics>,
): 'bigint' | 'number' | undefined {
  return semantics.result === semantics.operand.flow && isNumericOperatorValueDomain(semantics.result)
    ? semantics.result
    : undefined;
}

function isNumericAssignmentOperator(operator: IrAssignmentOperator): operator is NumericAssignmentOperator {
  return Object.hasOwn(numericAssignmentOperators, operator);
}

function isNumericBinaryOperator(operator: IrBinaryOperator): operator is NumericBinaryOperator {
  return Object.hasOwn(numericBinaryOperators, operator);
}

function isNumericOperatorValueDomain(domain: IrOperatorValueDomain): domain is 'bigint' | 'number' {
  return domain === 'bigint' || domain === 'number';
}

function isNumericPrefixUnaryOperator(operator: IrPrefixUnaryOperator): operator is NumericPrefixUnaryOperator {
  return Object.hasOwn(numericPrefixUnaryOperators, operator);
}

const numericAssignmentOperators: Readonly<Record<NumericAssignmentOperator, true>> = {
  '%=': true,
  '**=': true,
  '*=': true,
  '+=': true,
  '-=': true,
  '/=': true,
};

const numericBinaryOperators: Readonly<Record<NumericBinaryOperator, true>> = {
  '%': true,
  '**': true,
  '*': true,
  '+': true,
  '-': true,
  '/': true,
};

const numericPrefixUnaryOperators: Readonly<Record<NumericPrefixUnaryOperator, true>> = {
  '+': true,
  '++': true,
  '-': true,
  '--': true,
};
