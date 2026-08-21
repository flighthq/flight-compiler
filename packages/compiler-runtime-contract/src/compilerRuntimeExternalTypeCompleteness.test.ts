import type { CompilerRuntimeExternalTypeBindingPlan } from '../../compiler-types/src/index.js';
import { analyzeCompilerRuntimeExternalTypeCompleteness } from './compilerRuntimeExternalTypeCompleteness.js';

describe('analyzeCompilerRuntimeExternalTypeCompleteness', () => {
  it('returns a deterministic complete result without changing caller-owned input', () => {
    const required = [{ sourceName: 'Promise' }, { sourceName: 'Map' }, { sourceName: 'Promise' }];
    const plan: CompilerRuntimeExternalTypeBindingPlan = {
      bindings: [
        { externalType: { sourceName: 'Promise' }, capability: 'task', kind: 'runtime' },
        { externalType: { sourceName: 'Map' }, kind: 'native' },
      ],
      contract: 'flight-runtime-contract/1',
    };
    const requiredSnapshot = structuredClone(required);
    const planSnapshot = structuredClone(plan);

    expect(analyzeCompilerRuntimeExternalTypeCompleteness(required, plan)).toEqual({
      contract: 'flight-runtime-contract/1',
      kind: 'complete',
      requiredExternalTypes: [{ sourceName: 'Map' }, { sourceName: 'Promise' }],
      schema: 'flight-runtime-contract-completeness/1',
    });
    expect(required).toEqual(requiredSnapshot);
    expect(plan).toEqual(planSnapshot);
  });

  it('names every missing and duplicate decision in canonical source-name order', () => {
    const plan: CompilerRuntimeExternalTypeBindingPlan = {
      bindings: [
        { externalType: { sourceName: 'Set' }, kind: 'native' },
        { externalType: { sourceName: 'Map' }, kind: 'native' },
        { externalType: { sourceName: 'Map' }, capability: 'map', kind: 'runtime' },
        { externalType: { sourceName: 'E\u0301xternal' }, kind: 'native' },
      ],
      contract: 'flight-runtime-contract/1',
    };

    expect(
      analyzeCompilerRuntimeExternalTypeCompleteness(
        [
          { sourceName: 'Promise' },
          { sourceName: 'Array' },
          { sourceName: '\u00c9xternal' },
          { sourceName: 'WeakMap' },
        ],
        plan,
      ),
    ).toEqual({
      contract: 'flight-runtime-contract/1',
      duplicateExternalTypes: [{ sourceName: 'Map' }],
      kind: 'incomplete',
      missingExternalTypes: [{ sourceName: 'Array' }, { sourceName: 'Promise' }, { sourceName: 'WeakMap' }],
      requiredExternalTypes: [
        { sourceName: 'Array' },
        { sourceName: 'Promise' },
        { sourceName: 'WeakMap' },
        { sourceName: '\u00c9xternal' },
      ],
      schema: 'flight-runtime-contract-completeness/1',
    });
  });

  it('reports missing-only and duplicate-only decisions independently', () => {
    const missing = analyzeCompilerRuntimeExternalTypeCompleteness([{ sourceName: 'Map' }], {
      bindings: [],
      contract: 'flight-runtime-contract/1',
    });
    const duplicate = analyzeCompilerRuntimeExternalTypeCompleteness([], {
      bindings: [
        { externalType: { sourceName: 'Map' }, kind: 'native' },
        { externalType: { sourceName: 'Map' }, capability: 'map', kind: 'runtime' },
      ],
      contract: 'flight-runtime-contract/1',
    });

    expect(missing).toMatchObject({
      duplicateExternalTypes: [],
      kind: 'incomplete',
      missingExternalTypes: [{ sourceName: 'Map' }],
    });
    expect(duplicate).toMatchObject({
      duplicateExternalTypes: [{ sourceName: 'Map' }],
      kind: 'incomplete',
      missingExternalTypes: [],
    });
  });

  it('treats an empty reachable set and empty binding plan as complete', () => {
    expect(
      analyzeCompilerRuntimeExternalTypeCompleteness([], {
        bindings: [],
        contract: 'flight-runtime-contract/1',
      }),
    ).toEqual({
      contract: 'flight-runtime-contract/1',
      kind: 'complete',
      requiredExternalTypes: [],
      schema: 'flight-runtime-contract-completeness/1',
    });
  });
});
