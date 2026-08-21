import type { IrExpression, IrParameter, IrStatement } from './compilerExecutableIntermediateRepresentation.js';
import type { CompilerSourceOrigin } from './compilerSourceIdentity.js';

describe('compiler executable intermediate representation contracts', () => {
  it('adds executable initializer data without weakening the type-only parameter contract', () => {
    const expression: IrExpression = { kind: 'literal', value: 1 };
    const origin: CompilerSourceOrigin = {
      column: 1,
      fingerprint: 'sha256:value',
      line: 1,
      packageName: '@flighthq/math',
      source: 'packages/math/src/value.ts',
    };
    const parameter: IrParameter = {
      binding: {
        ...origin,
        id: 'binding:["@flighthq/math","packages/math/src/value.ts",0]',
        kind: 'parameter',
        name: 'value',
        scope: 'function',
        space: 'value',
      },
      initializer: expression,
      optional: true,
      rest: false,
      type: { kind: 'primitive', name: 'number' },
    };
    const statement: IrStatement = { expression, kind: 'return' };

    expect(parameter.initializer).toBe(expression);
    expect(statement.expression).toBe(expression);
    expectTypeOf<IrParameter>().toHaveProperty('binding');
  });

  it('couples postfix unary position to valid operators', () => {
    expectTypeOf<Extract<IrExpression, { kind: 'unary'; postfix: true }>['operator']>().toEqualTypeOf<'++' | '--'>();
    expectTypeOf<Extract<IrExpression, { kind: 'binary' }>['semantics']>().toHaveProperty('result');
  });
});
