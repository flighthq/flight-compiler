import type {
  IrAssignmentOperator,
  IrAssignmentOperatorSemantics,
  IrBinaryOperator,
  IrBinaryOperatorSemantics,
  IrExpression,
  IrOperatorOperandDomains,
  IrPrefixUnaryOperator,
  IrUnaryOperatorSemantics,
} from '../../compiler-types/src/index.js';
import { getCompilerStaticNumericArithmeticFact } from './compilerStaticNumericArithmetic.js';

type AssignmentExpression = Extract<IrExpression, { kind: 'assignment' }>;
type BinaryExpression = Extract<IrExpression, { kind: 'binary' }>;
type PrefixUnaryExpression = Extract<IrExpression, { kind: 'unary'; postfix: false }>;
type PostfixUnaryExpression = Extract<IrExpression, { kind: 'unary'; postfix: true }>;

describe('getCompilerStaticNumericArithmeticFact', () => {
  it('preserves every closed arithmetic operator and its operation shape', () => {
    const assignmentOperators = ['%=', '**=', '*=', '+=', '-=', '/='] as const;
    const binaryOperators = ['%', '**', '*', '+', '-', '/'] as const;
    const prefixOperators = ['+', '++', '-', '--'] as const;
    const postfixOperators = ['++', '--'] as const;

    expect(
      assignmentOperators.map((operator) =>
        getCompilerStaticNumericArithmeticFact(createAssignmentExpression(operator)),
      ),
    ).toEqual(
      assignmentOperators.map((operator) => ({
        kind: 'numericArithmetic',
        left: { declared: 'number', flow: 'number' },
        operation: 'assignment',
        operator,
        result: 'number',
        right: { declared: 'number', flow: 'number' },
      })),
    );
    expect(
      binaryOperators.map((operator) => getCompilerStaticNumericArithmeticFact(createBinaryExpression(operator))),
    ).toEqual(
      binaryOperators.map((operator) => ({
        kind: 'numericArithmetic',
        left: { declared: 'number', flow: 'number' },
        operation: 'binary',
        operator,
        result: 'number',
        right: { declared: 'number', flow: 'number' },
      })),
    );
    expect(
      prefixOperators.map((operator) => getCompilerStaticNumericArithmeticFact(createPrefixUnaryExpression(operator))),
    ).toEqual(
      prefixOperators.map((operator) => ({
        kind: 'numericArithmetic',
        operand: { declared: 'number', flow: 'number' },
        operation: 'prefixUnary',
        operator,
        result: 'number',
      })),
    );
    expect(
      postfixOperators.map((operator) =>
        getCompilerStaticNumericArithmeticFact(createPostfixUnaryExpression(operator)),
      ),
    ).toEqual(
      postfixOperators.map((operator) => ({
        kind: 'numericArithmetic',
        operand: { declared: 'number', flow: 'number' },
        operation: 'postfixUnary',
        operator,
        result: 'number',
      })),
    );
  });

  it('retains narrowed declared-versus-flow domains without changing the expression', () => {
    const narrowed: IrOperatorOperandDomains = { declared: 'unknown', flow: 'number' };
    const expression = createBinaryExpression('+', {
      left: narrowed,
      result: 'number',
      right: narrowed,
    });
    const snapshot = structuredClone(expression);
    const fact = getCompilerStaticNumericArithmeticFact(expression);

    expect(fact).toEqual({
      kind: 'numericArithmetic',
      left: narrowed,
      operation: 'binary',
      operator: '+',
      result: 'number',
      right: narrowed,
    });
    expect(expression).toEqual(snapshot);
    if (fact?.operation !== 'binary') throw new Error('Expected binary numeric arithmetic');
    expect(fact.left).not.toBe(expression.semantics.left);
    expect(fact.right).not.toBe(expression.semantics.right);
  });

  it('accepts bigint and excludes non-arithmetic, coercive, and inconsistent semantics', () => {
    const bigint: IrOperatorOperandDomains = { declared: 'bigint', flow: 'bigint' };
    const text: IrOperatorOperandDomains = { declared: 'string', flow: 'string' };
    const number: IrOperatorOperandDomains = { declared: 'number', flow: 'number' };

    expect(
      getCompilerStaticNumericArithmeticFact(
        createBinaryExpression('-', { left: bigint, result: 'bigint', right: bigint }),
      ),
    ).toMatchObject({ operation: 'binary', operator: '-', result: 'bigint' });
    expect(getCompilerStaticNumericArithmeticFact(createAssignmentExpression('='))).toBeUndefined();
    expect(getCompilerStaticNumericArithmeticFact(createBinaryExpression('&'))).toBeUndefined();
    expect(getCompilerStaticNumericArithmeticFact(createPrefixUnaryExpression('~'))).toBeUndefined();
    expect(
      getCompilerStaticNumericArithmeticFact(
        createBinaryExpression('+', { left: text, result: 'string', right: text }),
      ),
    ).toBeUndefined();
    expect(
      getCompilerStaticNumericArithmeticFact(
        createBinaryExpression('-', { left: number, result: 'number', right: bigint }),
      ),
    ).toBeUndefined();
    expect(
      getCompilerStaticNumericArithmeticFact(
        createAssignmentExpression('+=', { left: number, result: 'number', right: bigint }),
      ),
    ).toBeUndefined();
    expect(
      getCompilerStaticNumericArithmeticFact(
        createBinaryExpression('-', { left: number, result: 'unknown', right: number }),
      ),
    ).toBeUndefined();
    expect(
      getCompilerStaticNumericArithmeticFact(createPrefixUnaryExpression('+', { operand: text, result: 'number' })),
    ).toBeUndefined();
    expect(
      getCompilerStaticNumericArithmeticFact(createPostfixUnaryExpression('++', { operand: text, result: 'number' })),
    ).toBeUndefined();
  });
});

function createAssignmentExpression(
  operator: IrAssignmentOperator,
  semantics: IrAssignmentOperatorSemantics = createBinarySemantics(),
): AssignmentExpression {
  return { kind: 'assignment', left: literal, operator, right: literal, semantics };
}

function createBinaryExpression(
  operator: IrBinaryOperator,
  semantics: IrBinaryOperatorSemantics = createBinarySemantics(),
): BinaryExpression {
  return { kind: 'binary', left: literal, operator, right: literal, semantics };
}

function createBinarySemantics(): IrBinaryOperatorSemantics {
  return { left: numberDomains, result: 'number', right: numberDomains };
}

function createPostfixUnaryExpression(
  operator: '++' | '--',
  semantics: IrUnaryOperatorSemantics = createUnarySemantics(),
): PostfixUnaryExpression {
  return { kind: 'unary', operand: literal, operator, postfix: true, semantics };
}

function createPrefixUnaryExpression(
  operator: IrPrefixUnaryOperator,
  semantics: IrUnaryOperatorSemantics = createUnarySemantics(),
): PrefixUnaryExpression {
  return { kind: 'unary', operand: literal, operator, postfix: false, semantics };
}

function createUnarySemantics(): IrUnaryOperatorSemantics {
  return { operand: numberDomains, result: 'number' };
}

const literal: IrExpression = { kind: 'literal', value: 1 };
const numberDomains: IrOperatorOperandDomains = { declared: 'number', flow: 'number' };
