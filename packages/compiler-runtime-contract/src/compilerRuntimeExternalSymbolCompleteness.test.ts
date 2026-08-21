import type { CompilerRuntimeExternalSymbolBindingPlan } from '../../compiler-types/src/index.js';
import {
  analyzeCompilerRuntimeExternalSymbolCompleteness,
  isCompilerRuntimeContractMismatchFailure,
} from './compilerRuntimeExternalSymbolCompleteness.js';

describe('analyzeCompilerRuntimeExternalSymbolCompleteness', () => {
  it('keeps type and value decisions for one source symbol distinct', () => {
    const required = [
      { sourceName: 'Promise', space: 'value' },
      { sourceName: 'Promise', space: 'type' },
      { sourceName: 'Promise', space: 'value' },
    ] as const;
    const plan: CompilerRuntimeExternalSymbolBindingPlan = {
      bindings: [
        { externalSymbol: { sourceName: 'Promise', space: 'type' }, capability: 'task', kind: 'runtime' },
        { externalSymbol: { sourceName: 'Promise', space: 'value' }, capability: 'task', kind: 'runtime' },
      ],
      contract: 'flight-runtime-contract/2',
    };
    const requiredSnapshot = structuredClone(required);
    const planSnapshot = structuredClone(plan);

    expect(analyzeCompilerRuntimeExternalSymbolCompleteness(required, plan)).toEqual({
      contract: 'flight-runtime-contract/2',
      kind: 'complete',
      requiredExternalSymbols: [
        { sourceName: 'Promise', space: 'type' },
        { sourceName: 'Promise', space: 'value' },
      ],
      schema: 'flight-runtime-contract-completeness/2',
    });
    expect(required).toEqual(requiredSnapshot);
    expect(plan).toEqual(planSnapshot);
  });

  it('reports missing-only and duplicate-only decisions independently', () => {
    const missing = analyzeCompilerRuntimeExternalSymbolCompleteness(
      [
        { sourceName: 'Map', space: 'type' },
        { sourceName: 'Map', space: 'value' },
      ],
      {
        bindings: [{ externalSymbol: { sourceName: 'Map', space: 'type' }, kind: 'native' }],
        contract: 'flight-runtime-contract/2',
      },
    );
    const duplicate = analyzeCompilerRuntimeExternalSymbolCompleteness([], {
      bindings: [
        { externalSymbol: { sourceName: 'Map', space: 'value' }, kind: 'native' },
        { externalSymbol: { sourceName: 'Map', space: 'value' }, capability: 'map', kind: 'runtime' },
      ],
      contract: 'flight-runtime-contract/2',
    });

    expect(missing).toMatchObject({
      duplicateExternalSymbols: [],
      kind: 'incomplete',
      missingExternalSymbols: [{ sourceName: 'Map', space: 'value' }],
    });
    expect(duplicate).toMatchObject({
      duplicateExternalSymbols: [{ sourceName: 'Map', space: 'value' }],
      kind: 'incomplete',
      missingExternalSymbols: [],
    });
  });

  it('normalizes, deduplicates, and canonically orders complete identities', () => {
    expect(
      analyzeCompilerRuntimeExternalSymbolCompleteness(
        [
          { sourceName: 'Zed', space: 'value' },
          { sourceName: 'E\u0301xternal', space: 'value' },
          { sourceName: '\u00c9xternal', space: 'value' },
          { sourceName: 'Zed', space: 'type' },
        ],
        {
          bindings: [
            { externalSymbol: { sourceName: 'Zed', space: 'type' }, kind: 'native' },
            { externalSymbol: { sourceName: '\u00c9xternal', space: 'value' }, kind: 'native' },
            { externalSymbol: { sourceName: 'Zed', space: 'value' }, kind: 'native' },
          ],
          contract: 'flight-runtime-contract/2',
        },
      ),
    ).toEqual({
      contract: 'flight-runtime-contract/2',
      kind: 'complete',
      requiredExternalSymbols: [
        { sourceName: 'Zed', space: 'type' },
        { sourceName: 'Zed', space: 'value' },
        { sourceName: '\u00c9xternal', space: 'value' },
      ],
      schema: 'flight-runtime-contract-completeness/2',
    });
    expect(
      analyzeCompilerRuntimeExternalSymbolCompleteness([], {
        bindings: [],
        contract: 'flight-runtime-contract/2',
      }),
    ).toEqual({
      contract: 'flight-runtime-contract/2',
      kind: 'complete',
      requiredExternalSymbols: [],
      schema: 'flight-runtime-contract-completeness/2',
    });
  });

  it('refuses a binding plan for a different runtime contract version', () => {
    const incompatiblePlan = {
      bindings: [],
      contract: 'flight-runtime-contract/1',
    } as unknown as CompilerRuntimeExternalSymbolBindingPlan;

    try {
      analyzeCompilerRuntimeExternalSymbolCompleteness([], incompatiblePlan);
      expect.unreachable('Expected the incompatible runtime contract to fail');
    } catch (error) {
      expect(isCompilerRuntimeContractMismatchFailure(error)).toBe(true);
      expect(error).toMatchObject({
        expected: 'flight-runtime-contract/2',
        kind: 'runtime-contract-mismatch',
        message: 'Runtime binding plan uses flight-runtime-contract/1; expected flight-runtime-contract/2',
        name: 'CompilerRuntimeContractMismatchError',
        received: 'flight-runtime-contract/1',
      });
    }
  });
});

describe('isCompilerRuntimeContractMismatchFailure', () => {
  it('rejects ordinary errors and incomplete lookalikes', () => {
    const valid = Object.assign(new Error('mismatch'), {
      expected: 'flight-runtime-contract/2',
      kind: 'runtime-contract-mismatch',
      received: 'flight-runtime-contract/1',
    });

    expect(isCompilerRuntimeContractMismatchFailure(valid)).toBe(true);
    expect(isCompilerRuntimeContractMismatchFailure(new Error('plain'))).toBe(false);
    expect(isCompilerRuntimeContractMismatchFailure({ ...valid, expected: 'flight-runtime-contract/1' })).toBe(false);
    expect(isCompilerRuntimeContractMismatchFailure(Object.assign(new Error('missing'), valid, { received: 1 }))).toBe(
      false,
    );
  });
});
