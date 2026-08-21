import type { IrSwitchCase } from '../../compiler-types/src/index.js';
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
});
