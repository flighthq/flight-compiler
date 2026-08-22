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

  it('keeps object copy semantics explicit without burdening ordinary object construction', () => {
    const plain = {
      kind: 'object',
      members: [],
      type: { kind: 'object', properties: [] },
    } as const satisfies IrExpression;
    const copied = {
      copySemantics: {
        evaluation: 'left-to-right-once',
        nullish: 'skip',
        overwrite: 'replace-value-preserve-key-position',
        propertyKeys: 'own-enumerable-string-and-symbol',
        propertyReads: 'get-once-in-own-key-order',
        targetWrites: 'create-data-property',
      },
      kind: 'object',
      members: [{ expression: { kind: 'literal', value: null }, kind: 'spread' }],
      type: { kind: 'object', properties: [] },
    } as const satisfies IrExpression;

    expect(plain).not.toHaveProperty('copySemantics');
    expect(copied.copySemantics.nullish).toBe('skip');
  });

  it('requires settlement semantics on every await expression', () => {
    const awaited = {
      expression: { kind: 'literal', value: 1 },
      kind: 'await',
      semantics: {
        continuation: 'enqueue-after-settlement',
        fulfillment: 'resume-normal-with-value',
        operandEvaluation: 'once-before-suspension',
        rejection: 'resume-throw-with-reason',
        schema: 'flight-compiler-await-semantics/1',
        suspension: 'always-before-continuation',
        taskResolution: 'normalize-value-task-or-thenable',
      },
    } as const satisfies IrExpression;

    expect(awaited.semantics.schema).toBe('flight-compiler-await-semantics/1');
  });

  it('requires thrown-value semantics on every catch clause', () => {
    const caught = {
      body: { kind: 'block', statements: [] },
      semantics: {
        bindingInitialization: { kind: 'discard' },
        bodyExecution: 'once-per-caught-throw',
        catchCompletion: 'propagate',
        interceptedCompletion: 'throw',
        schema: 'flight-compiler-catch-semantics/1',
        uncaughtCompletion: 'preserve',
      },
    } as const satisfies NonNullable<Extract<IrStatement, { kind: 'try' }>['catchClause']>;

    expect(caught.semantics.bindingInitialization).toEqual({ kind: 'discard' });
  });
});
