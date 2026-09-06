import { createCompilerRuntimeExternalConstructorAbiPlanRust } from './rustRuntimeExternalConstructorAbi.js';
import { getCompilerRuntimeExternalSymbolTargetRust } from './rustRuntimeExternalSymbolBinding.js';

describe('createCompilerRuntimeExternalConstructorAbiPlanRust', () => {
  it('elects only exact zero-argument native factories under the versioned constructor ABI contract', () => {
    const plan = createCompilerRuntimeExternalConstructorAbiPlanRust();

    expect(plan.contract).toBe('flight-runtime-constructor-abi/1');
    expect(plan.constructors).toHaveLength(13);
    expect(plan.constructors).toContainEqual({
      dynamicArguments: false,
      externalSymbol: { sourceName: 'Uint8Array', space: 'value' },
      fixedArgumentCounts: [0],
    });
    expect(plan.constructors).not.toContainEqual(
      expect.objectContaining({ externalSymbol: { sourceName: 'Promise', space: 'value' } }),
    );
    expect(
      plan.constructors.every(
        ({ externalSymbol }) =>
          getCompilerRuntimeExternalSymbolTargetRust(externalSymbol.sourceName, externalSymbol.space) !== undefined,
      ),
    ).toBe(true);
  });

  it('creates independent plan records and nested arity lists', () => {
    const first = createCompilerRuntimeExternalConstructorAbiPlanRust();
    const second = createCompilerRuntimeExternalConstructorAbiPlanRust();

    (first.constructors as unknown[]).pop();
    (first.constructors[0]!.fixedArgumentCounts as number[]).push(1);
    expect(second.constructors).toHaveLength(13);
    expect(second.constructors[0]?.fixedArgumentCounts).toEqual([0]);
  });
});
