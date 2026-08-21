import type { CompilerRuntimeExternalSymbolBindingPlan } from '../../compiler-types/src/index.js';
import { analyzeCompilerRuntimeExternalSymbolCompleteness } from './compilerRuntimeExternalSymbolCompleteness.js';

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
});
