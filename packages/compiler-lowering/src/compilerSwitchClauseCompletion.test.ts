import type { IrControlFlowLabelIdentity, IrSwitchCase } from '../../compiler-types/src/index.js';
import { getIrSwitchCaseCompletion } from './compilerSwitchClauseCompletion.js';

describe('getIrSwitchCaseCompletion', () => {
  it('classifies direct fallthrough and terminal completions', () => {
    const expression = { expression: { kind: 'literal', value: 1 }, kind: 'expression' } as const;

    expect(getIrSwitchCaseCompletion({ statements: [] })).toEqual({ kind: 'fallthrough' });
    expect(getIrSwitchCaseCompletion({ statements: [expression] })).toEqual({ kind: 'fallthrough' });
    expect(getIrSwitchCaseCompletion({ statements: [expression, { kind: 'break' }] })).toEqual({
      kind: 'localBreak',
    });
    expect(getIrSwitchCaseCompletion({ statements: [{ kind: 'return' }] })).toEqual({ kind: 'abrupt' });
    expect(getIrSwitchCaseCompletion({ statements: [{ kind: 'continue' }, { kind: 'return' }] })).toEqual({
      kind: 'abrupt',
    });
    expect(
      getIrSwitchCaseCompletion({ statements: [{ expression: { kind: 'literal', value: 1 }, kind: 'throw' }] }),
    ).toEqual({ kind: 'abrupt' });
  });

  it('rejects nonterminal switch-local breaks but ignores breaks owned by nested constructs', () => {
    const conditional: IrSwitchCase = {
      statements: [
        {
          condition: { kind: 'literal', value: true },
          consequent: { kind: 'break' },
          kind: 'if',
        },
      ],
    };
    const nested: IrSwitchCase = {
      statements: [
        {
          condition: { kind: 'literal', value: true },
          kind: 'while',
          body: { kind: 'break' },
        },
      ],
    };

    expect(getIrSwitchCaseCompletion(conditional)).toEqual({
      kind: 'unsupported',
      reason: 'switch-local break must be the final direct statement of its clause',
    });
    expect(getIrSwitchCaseCompletion(nested)).toEqual({ kind: 'fallthrough' });
  });

  it('recognizes abrupt completions nested inside blocks', () => {
    expect(
      getIrSwitchCaseCompletion({
        statements: [{ kind: 'block', statements: [{ kind: 'return' }] }],
      }),
    ).toEqual({ kind: 'abrupt' });
    expect(
      getIrSwitchCaseCompletion({
        statements: [{ kind: 'block', statements: [] }],
      }),
    ).toEqual({ kind: 'fallthrough' });
    expect(getIrSwitchCaseCompletion({ statements: [{ kind: 'continue' }] })).toEqual({ kind: 'abrupt' });
  });

  it('detects switch-target breaks inside if/else, try/catch/finally, blocks, nested switches, and labeled loops', () => {
    const switchLabel = createLabel('sw');
    const ifElseBreak: IrSwitchCase = {
      statements: [
        {
          condition: { kind: 'literal', value: true },
          consequent: { expression: { kind: 'literal', value: 0 }, kind: 'expression' },
          kind: 'if',
          otherwise: { kind: 'break', target: switchLabel },
        },
      ],
    };
    const blockBreak: IrSwitchCase = {
      statements: [{ kind: 'block', statements: [{ kind: 'break', target: switchLabel }] }],
    };
    const tryBreak: IrSwitchCase = {
      statements: [
        {
          kind: 'try',
          tryBody: { kind: 'break', target: switchLabel },
        },
      ],
    };
    const catchBreak: IrSwitchCase = {
      statements: [
        {
          kind: 'try',
          tryBody: { expression: { kind: 'literal', value: 0 }, kind: 'expression' },
          catchClause: {
            body: { kind: 'break', target: switchLabel },
            semantics: {
              bindingInitialization: { kind: 'discard' },
              bodyExecution: 'once-per-caught-throw',
              catchCompletion: 'propagate',
              interceptedCompletion: 'throw',
              schema: 'flight-compiler-catch-semantics/1',
              uncaughtCompletion: 'preserve',
            },
          },
        },
      ],
    };
    const finallyBreak: IrSwitchCase = {
      statements: [
        {
          kind: 'try',
          tryBody: { expression: { kind: 'literal', value: 0 }, kind: 'expression' },
          finallyBody: { kind: 'break', target: switchLabel },
        },
      ],
    };
    const nestedSwitchBreak: IrSwitchCase = {
      statements: [
        {
          cases: [{ statements: [{ kind: 'break', target: switchLabel }] }],
          expression: { kind: 'literal', value: 0 },
          kind: 'switch',
        },
      ],
    };
    const labeledLoopBreak: IrSwitchCase = {
      statements: [
        {
          body: { kind: 'break', target: switchLabel },
          condition: { kind: 'literal', value: true },
          kind: 'do',
        },
      ],
    };
    const forBreak: IrSwitchCase = {
      statements: [
        {
          body: { kind: 'break', target: switchLabel },
          kind: 'for',
        },
      ],
    };
    const forInBreak: IrSwitchCase = {
      statements: [
        {
          body: { kind: 'break', target: switchLabel },
          kind: 'forIn',
          object: { kind: 'literal', value: 0 },
          variable: {
            binding: {
              column: 1,
              fingerprint: `sha256:${'0'.repeat(64)}` as never,
              id: 'k',
              kind: 'variable',
              line: 1,
              name: 'k',
              packageName: '@flighthq/test',
              scope: 'block',
              source: 'test.ts',
              space: 'value',
            },
            mutable: false,
          },
        },
      ],
    };
    const forOfBreak: IrSwitchCase = {
      statements: [
        {
          await: false,
          body: { kind: 'break', target: switchLabel },
          iterable: { kind: 'literal', value: 0 },
          kind: 'forOf',
          variable: {
            binding: {
              column: 1,
              fingerprint: `sha256:${'0'.repeat(64)}` as never,
              id: 'v',
              kind: 'variable',
              line: 1,
              name: 'v',
              packageName: '@flighthq/test',
              scope: 'block',
              source: 'test.ts',
              space: 'value',
            },
            mutable: false,
          },
        },
      ],
    };

    for (const fixture of [
      ifElseBreak,
      blockBreak,
      tryBreak,
      catchBreak,
      finallyBreak,
      nestedSwitchBreak,
      labeledLoopBreak,
      forBreak,
      forInBreak,
      forOfBreak,
    ]) {
      expect(getIrSwitchCaseCompletion(fixture, switchLabel.id)).toEqual({
        kind: 'unsupported',
        reason: 'switch-local break must be the final direct statement of its clause',
      });
    }
  });

  it('visits preceding containers without finding breaks when the clause ends differently', () => {
    const switchLabel = createLabel('sw');
    const expression = { expression: { kind: 'literal', value: 0 }, kind: 'expression' } as const;
    const ifWithoutElse: IrSwitchCase = {
      statements: [
        {
          condition: { kind: 'literal', value: true },
          consequent: expression,
          kind: 'if',
        },
        { kind: 'break', target: switchLabel },
      ],
    };
    const tryWithoutFinally: IrSwitchCase = {
      statements: [
        {
          kind: 'try',
          tryBody: expression,
        },
        { kind: 'break', target: switchLabel },
      ],
    };
    const nestedSwitchNoLabel: IrSwitchCase = {
      statements: [
        {
          cases: [{ statements: [{ kind: 'break' }] }],
          expression: { kind: 'literal', value: 0 },
          kind: 'switch',
        },
      ],
    };

    expect(getIrSwitchCaseCompletion(ifWithoutElse, switchLabel.id)).toEqual({ kind: 'localBreak' });
    expect(getIrSwitchCaseCompletion(tryWithoutFinally, switchLabel.id)).toEqual({ kind: 'localBreak' });
    expect(getIrSwitchCaseCompletion(nestedSwitchNoLabel)).toEqual({ kind: 'fallthrough' });
  });

  it('treats a targeted break as non-local when the switch has no label', () => {
    const outerLabel = createLabel('outer');

    expect(getIrSwitchCaseCompletion({ statements: [{ kind: 'break', target: outerLabel }] })).toEqual({
      kind: 'abrupt',
    });
  });

  it('distinguishes a labeled switch break from an exit targeting an outer construct', () => {
    const switchLabel = createLabel('switch');
    const outerLabel = createLabel('outer');

    expect(getIrSwitchCaseCompletion({ statements: [{ kind: 'break', target: switchLabel }] }, switchLabel.id)).toEqual(
      { kind: 'localBreak' },
    );
    expect(getIrSwitchCaseCompletion({ statements: [{ kind: 'break', target: outerLabel }] }, switchLabel.id)).toEqual({
      kind: 'abrupt',
    });
    expect(
      getIrSwitchCaseCompletion(
        {
          statements: [
            {
              body: { kind: 'break', target: switchLabel },
              condition: { kind: 'literal', value: true },
              kind: 'while',
            },
          ],
        },
        switchLabel.id,
      ),
    ).toEqual({
      kind: 'unsupported',
      reason: 'switch-local break must be the final direct statement of its clause',
    });
  });
});

function createLabel(name: string): IrControlFlowLabelIdentity {
  return {
    column: 1,
    fingerprint: `sha256:${'0'.repeat(64)}` as IrControlFlowLabelIdentity['fingerprint'],
    id: `label:${name}`,
    line: 1,
    name,
    packageName: '@flighthq/test',
    source: 'test.ts',
  };
}
