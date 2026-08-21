import type { IrExpression } from '../../compiler-types/src/index.js';
import {
  createIrStatementValueCallSemantics,
  isIrCallExpressionStatementValueCarrier,
  isIrStatementValueCallSemantics,
} from './compilerStatementValueCompletion.js';

describe('createIrStatementValueCallSemantics', () => {
  it('creates independent immutable semantics for normal values and every abrupt completion', () => {
    const first = createIrStatementValueCallSemantics();
    const second = createIrStatementValueCallSemantics();

    expect(first).toEqual({
      abruptCompletion: 'propagate',
      asyncContext: 'inherit',
      normalCompletion: 'final-return-value',
      thisBinding: 'lexical',
    });
    expect(Object.isFrozen(first)).toBe(true);
    expect(first).not.toBe(second);
  });
});

describe('isIrCallExpressionStatementValueCarrier', () => {
  it('accepts only an immediate zero-argument lexical carrier with one final value return', () => {
    const valid = carrier();
    if (valid.kind !== 'call' || valid.callee.kind !== 'function') throw new Error('Expected carrier fixture');
    const callee = valid.callee;
    const invalid: IrExpression[] = [
      { kind: 'literal', value: 1 },
      { ...valid, semantics: {} },
      { ...valid, semantics: { ...valid.semantics, signature: { parameterCount: 0, providedArgumentCount: 0 } } },
      { ...valid, callee: { kind: 'identifier', reference: { kind: 'ambient', name: 'carrier' } } },
      { ...valid, callee: { ...callee, async: true } },
      { ...valid, callee: { ...callee, binding: null as never } },
      { ...valid, callee: { ...callee, expression: { kind: 'literal', value: 1 } } },
      { ...valid, callee: { ...callee, parameters: [null as never] } },
      { ...valid, callee: { ...callee, typeParameters: [null as never] } },
      { ...valid, arguments: [{ kind: 'literal', value: 1 }] },
      { ...valid, optional: true },
      { ...valid, typeArguments: [{ kind: 'primitive', name: 'number' }] },
      { ...valid, callee: { ...callee, body: [] } },
      { ...valid, callee: { ...callee, body: [{ expression: { kind: 'literal', value: 1 }, kind: 'expression' }] } },
      { ...valid, callee: { ...callee, body: [{ kind: 'return' }] } },
    ];

    expect(isIrCallExpressionStatementValueCarrier(valid)).toBe(true);
    expect(invalid.every((expression) => !isIrCallExpressionStatementValueCarrier(expression))).toBe(true);
  });
});

describe('isIrStatementValueCallSemantics', () => {
  it('rejects absent, non-record, partial, extra, and wrong-literal values', () => {
    const valid = createIrStatementValueCallSemantics();
    const invalid: unknown[] = [
      undefined,
      null,
      [],
      'carrier',
      {},
      { ...valid, extra: true },
      { ...valid, abruptCompletion: 'capture' },
      { ...valid, asyncContext: 'reset' },
      { ...valid, normalCompletion: 'last-expression' },
      { ...valid, thisBinding: 'dynamic' },
    ];

    expect(isIrStatementValueCallSemantics(valid)).toBe(true);
    expect(invalid.every((value) => !isIrStatementValueCallSemantics(value))).toBe(true);
  });
});

function carrier(): IrExpression {
  return {
    arguments: [],
    callee: {
      async: false,
      body: [{ expression: { kind: 'literal', value: 1 }, kind: 'return' }],
      kind: 'function',
      parameters: [],
      returns: { kind: 'primitive', name: 'number' },
      typeParameters: [],
    },
    kind: 'call',
    optional: false,
    semantics: { statementValue: createIrStatementValueCallSemantics() },
    typeArguments: [],
  };
}
