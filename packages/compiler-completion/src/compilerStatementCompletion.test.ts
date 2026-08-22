import type {
  IrBindingIdentity,
  IrControlFlowLabelIdentity,
  IrExpression,
  IrStatement,
  IrVariable,
} from '../../compiler-types/src/index.js';
import { createIrCatchSemantics } from './compilerCatchCompletion.js';
import {
  getIrStatementListCompletionSet,
  isCompilerStatementCompletionFailure,
} from './compilerStatementCompletion.js';

const expression: IrExpression = { kind: 'literal', value: 1 };

function createLabel(name: string): IrControlFlowLabelIdentity {
  return {
    column: 1,
    fingerprint: `sha256:${name}`,
    id: `label:${name}`,
    line: 1,
    name,
    packageName: '@flighthq/completion-fixture',
    source: 'packages/completion-fixture/src/statement.ts',
  };
}

function createVariable(initializer?: IrExpression): IrVariable {
  const binding: IrBindingIdentity = {
    column: 1,
    fingerprint: 'sha256:variable',
    id: 'binding:variable',
    kind: 'variable',
    line: 1,
    name: 'value',
    packageName: '@flighthq/completion-fixture',
    scope: 'block',
    source: 'packages/completion-fixture/src/statement.ts',
    space: 'value',
  };
  return { binding, ...(initializer ? { initializer } : {}), mutable: false };
}

describe('getIrStatementListCompletionSet', () => {
  it('derives empty, sequential, expression, declaration, return, and throw routes', () => {
    expect(getIrStatementListCompletionSet([]).completions).toEqual([{ kind: 'normal' }]);
    expect(getIrStatementListCompletionSet([{ expression, kind: 'expression' }]).completions).toEqual([
      { kind: 'normal' },
      { kind: 'throw' },
    ]);
    expect(
      getIrStatementListCompletionSet([
        { expression, kind: 'expression' },
        { kind: 'return' },
        { expression, kind: 'throw' },
      ]).completions,
    ).toEqual([{ kind: 'return' }, { kind: 'throw' }]);
    expect(getIrStatementListCompletionSet([{ expression, kind: 'return' }]).completions).toEqual([
      { kind: 'return' },
      { kind: 'throw' },
    ]);
    expect(getIrStatementListCompletionSet([{ expression, kind: 'throw' }]).completions).toEqual([{ kind: 'throw' }]);
    expect(
      getIrStatementListCompletionSet([{ declarations: [createVariable()], kind: 'variable' }]).completions,
    ).toEqual([{ kind: 'normal' }]);
    expect(
      getIrStatementListCompletionSet([{ declarations: [createVariable(expression)], kind: 'variable' }]).completions,
    ).toEqual([{ kind: 'normal' }, { kind: 'throw' }]);
  });

  it('unions both conditional branches and condition-evaluation failure', () => {
    const statement: IrStatement = {
      condition: expression,
      consequent: { kind: 'return' },
      kind: 'if',
      otherwise: { kind: 'break', target: createLabel('outer') },
    };

    expect(getIrStatementListCompletionSet([statement]).completions).toEqual([
      { kind: 'break', target: 'label:outer' },
      { kind: 'return' },
      { kind: 'throw' },
    ]);
    expect(
      getIrStatementListCompletionSet([{ condition: expression, consequent: { kind: 'return' }, kind: 'if' }])
        .completions,
    ).toEqual([{ kind: 'normal' }, { kind: 'return' }, { kind: 'throw' }]);
  });

  it('lets labeled blocks consume only their own targeted break', () => {
    const owner = createLabel('owner');
    const foreign = createLabel('foreign');
    const fixtures: readonly [IrStatement, readonly unknown[]][] = [
      [{ kind: 'block', label: owner, statements: [{ kind: 'break', target: owner }] }, [{ kind: 'normal' }]],
      [
        { kind: 'block', label: owner, statements: [{ kind: 'break', target: foreign }] },
        [{ kind: 'break', target: 'label:foreign' }],
      ],
      [{ kind: 'block', label: owner, statements: [{ kind: 'break' }] }, [{ kind: 'break' }]],
      [
        { kind: 'block', label: owner, statements: [{ kind: 'continue', target: owner }] },
        [{ kind: 'continue', target: 'label:owner' }],
      ],
    ];

    for (const [statement, expected] of fixtures) {
      expect(getIrStatementListCompletionSet([statement]).completions).toEqual(expected);
    }
  });

  it('lets loops consume only local or exactly targeted break and continue routes', () => {
    const owner = createLabel('owner');
    const foreign = createLabel('foreign');
    const createLoop = (body: IrStatement): IrStatement => ({
      body,
      condition: expression,
      kind: 'while',
      label: owner,
    });

    for (const body of [
      { kind: 'break' },
      { kind: 'continue' },
      { kind: 'break', target: owner },
      { kind: 'continue', target: owner },
    ] as const) {
      expect(getIrStatementListCompletionSet([createLoop(body)]).completions).toEqual([
        { kind: 'normal' },
        { kind: 'throw' },
      ]);
    }
    expect(getIrStatementListCompletionSet([createLoop({ kind: 'break', target: foreign })]).completions).toEqual([
      { kind: 'normal' },
      { kind: 'break', target: 'label:foreign' },
      { kind: 'throw' },
    ]);
    expect(getIrStatementListCompletionSet([createLoop({ kind: 'continue', target: foreign })]).completions).toEqual([
      { kind: 'normal' },
      { kind: 'continue', target: 'label:foreign' },
      { kind: 'throw' },
    ]);
  });

  it('distinguishes unconditional loops from condition, increment, and posttest exits', () => {
    const forever = (body: IrStatement, increment?: IrExpression): IrStatement => ({
      body,
      ...(increment ? { increment } : {}),
      kind: 'for',
    });

    expect(getIrStatementListCompletionSet([forever({ kind: 'block', statements: [] })]).completions).toEqual([]);
    expect(getIrStatementListCompletionSet([forever({ kind: 'continue' })]).completions).toEqual([]);
    expect(getIrStatementListCompletionSet([forever({ kind: 'break' })]).completions).toEqual([{ kind: 'normal' }]);
    expect(getIrStatementListCompletionSet([forever({ kind: 'continue' }, expression)]).completions).toEqual([
      { kind: 'throw' },
    ]);
    expect(
      getIrStatementListCompletionSet([
        { body: { kind: 'break' }, condition: expression, initializer: expression, kind: 'for' },
      ]).completions,
    ).toEqual([{ kind: 'normal' }, { kind: 'throw' }]);
    expect(
      getIrStatementListCompletionSet([{ body: { kind: 'break' }, initializer: [createVariable()], kind: 'for' }])
        .completions,
    ).toEqual([{ kind: 'normal' }]);
    expect(
      getIrStatementListCompletionSet([
        { body: { kind: 'break' }, initializer: [createVariable(expression)], kind: 'for' },
      ]).completions,
    ).toEqual([{ kind: 'normal' }, { kind: 'throw' }]);
    expect(
      getIrStatementListCompletionSet([{ body: { kind: 'continue' }, condition: expression, kind: 'do' }]).completions,
    ).toEqual([{ kind: 'normal' }, { kind: 'throw' }]);
    expect(
      getIrStatementListCompletionSet([{ body: { kind: 'return' }, condition: expression, kind: 'do' }]).completions,
    ).toEqual([{ kind: 'return' }]);
  });

  it('accounts for enumeration entry, exit, iterator failure, and escaping body control', () => {
    const foreign = createLabel('foreign');
    const variable = createVariable();
    const statements: IrStatement[] = [
      { body: { kind: 'return' }, kind: 'forIn', object: expression, variable },
      { await: false, body: { kind: 'continue', target: foreign }, iterable: expression, kind: 'forOf', variable },
    ];

    expect(getIrStatementListCompletionSet([statements[0]!]).completions).toEqual([
      { kind: 'normal' },
      { kind: 'return' },
      { kind: 'throw' },
    ]);
    expect(getIrStatementListCompletionSet([statements[1]!]).completions).toEqual([
      { kind: 'normal' },
      { kind: 'continue', target: 'label:foreign' },
      { kind: 'throw' },
    ]);
  });

  it('analyzes every switch entry with fallthrough and consumes only switch-owned break', () => {
    const owner = createLabel('owner');
    const foreign = createLabel('foreign');
    const statement: IrStatement = {
      cases: [
        { expression, statements: [{ kind: 'return' }] },
        { expression, statements: [{ kind: 'break', target: owner }] },
        { statements: [{ kind: 'continue', target: foreign }] },
      ],
      expression,
      kind: 'switch',
      label: owner,
    };

    expect(getIrStatementListCompletionSet([statement]).completions).toEqual([
      { kind: 'normal' },
      { kind: 'continue', target: 'label:foreign' },
      { kind: 'return' },
      { kind: 'throw' },
    ]);
    expect(
      getIrStatementListCompletionSet([
        {
          cases: [{ expression, statements: [{ kind: 'continue', target: owner }] }],
          expression,
          kind: 'switch',
          label: owner,
        },
      ]).completions,
    ).toEqual([{ kind: 'normal' }, { kind: 'continue', target: 'label:owner' }, { kind: 'throw' }]);
    expect(getIrStatementListCompletionSet([{ cases: [], expression, kind: 'switch' }]).completions).toEqual([
      { kind: 'normal' },
      { kind: 'throw' },
    ]);
  });

  it('composes try, catch, and finally in language order', () => {
    const catchClause = {
      body: { kind: 'return' } as const,
      semantics: createIrCatchSemantics('absent'),
    };

    expect(
      getIrStatementListCompletionSet([{ catchClause, kind: 'try', tryBody: { expression, kind: 'expression' } }])
        .completions,
    ).toEqual([{ kind: 'normal' }, { kind: 'return' }]);
    expect(
      getIrStatementListCompletionSet([{ catchClause, kind: 'try', tryBody: { kind: 'return' } }]).completions,
    ).toEqual([{ kind: 'return' }]);
    expect(
      getIrStatementListCompletionSet([{ kind: 'try', tryBody: { expression, kind: 'expression' } }]).completions,
    ).toEqual([{ kind: 'normal' }, { kind: 'throw' }]);
    expect(
      getIrStatementListCompletionSet([
        {
          catchClause,
          finallyBody: { expression, kind: 'throw' },
          kind: 'try',
          tryBody: { expression, kind: 'expression' },
        },
      ]).completions,
    ).toEqual([{ kind: 'throw' }]);
  });

  it('validates unreachable tail statements and nested statement lists', () => {
    const unknown = { kind: 'future-statement' } as unknown as IrStatement;

    expect(() => getIrStatementListCompletionSet([{ kind: 'return' }, unknown])).toThrow(
      expect.objectContaining({ code: 'unknown-statement-kind', path: ['statements', 1, 'kind'] }),
    );
    expect(() =>
      getIrStatementListCompletionSet([{ kind: 'block', statements: null } as unknown as IrStatement]),
    ).toThrow(
      expect.objectContaining({
        code: 'invalid-statement-list',
        path: ['statements', 0, 'statements'],
      }),
    );
  });
});

describe('isCompilerStatementCompletionFailure', () => {
  it('accepts every exact failure code and rejects malformed lookalikes', () => {
    const failures: unknown[] = [];
    const attempts = [
      () => getIrStatementListCompletionSet(null as never),
      () => getIrStatementListCompletionSet([null as never]),
      () =>
        getIrStatementListCompletionSet([
          {
            kind: 'block',
            label: { ...createLabel('invalid'), id: '' },
            statements: [],
          },
        ]),
    ];
    for (const attempt of attempts) {
      try {
        attempt();
      } catch (error) {
        failures.push(error);
      }
    }

    expect(failures).toHaveLength(attempts.length);
    expect(failures.every(isCompilerStatementCompletionFailure)).toBe(true);
    expect(isCompilerStatementCompletionFailure(new Error('ordinary'))).toBe(false);
    expect(
      isCompilerStatementCompletionFailure(
        Object.assign(new Error('lookalike'), {
          code: 'unknown',
          kind: 'compiler-statement-completion',
          path: [],
        }),
      ),
    ).toBe(false);
    expect(
      isCompilerStatementCompletionFailure(
        Object.assign(new Error('lookalike'), {
          code: 'unknown-statement-kind',
          kind: 'compiler-statement-completion',
          path: null,
        }),
      ),
    ).toBe(false);
  });
});
