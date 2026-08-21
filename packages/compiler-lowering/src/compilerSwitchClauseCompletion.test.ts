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
