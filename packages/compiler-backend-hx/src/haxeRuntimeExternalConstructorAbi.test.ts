import { createCompilerRuntimeExternalConstructorAbiPlanHaxe } from './haxeRuntimeExternalConstructorAbi.js';
import { getCompilerRuntimeExternalSymbolTargetHaxe } from './haxeRuntimeExternalSymbolBinding.js';

describe('createCompilerRuntimeExternalConstructorAbiPlanHaxe', () => {
  it('elects exact fixed arities under the versioned constructor ABI contract', () => {
    const plan = createCompilerRuntimeExternalConstructorAbiPlanHaxe();

    expect(plan.contract).toBe('flight-runtime-constructor-abi/1');
    expect(plan.constructors).toHaveLength(17);
    expect(plan.constructors).toContainEqual({
      dynamicArguments: false,
      externalSymbol: { sourceName: 'Uint8Array', space: 'value' },
      fixedArgumentCounts: [0, 1, 2, 3],
    });
    expect(plan.constructors).toContainEqual({
      dynamicArguments: false,
      externalSymbol: { sourceName: 'Promise', space: 'value' },
      fixedArgumentCounts: [1],
    });
    expect(
      plan.constructors.every(
        ({ externalSymbol }) =>
          getCompilerRuntimeExternalSymbolTargetHaxe(externalSymbol.sourceName, externalSymbol.space) !== undefined,
      ),
    ).toBe(true);
  });

  it('creates independent plan records and nested arity lists', () => {
    const first = createCompilerRuntimeExternalConstructorAbiPlanHaxe();
    const second = createCompilerRuntimeExternalConstructorAbiPlanHaxe();

    (first.constructors as unknown[]).pop();
    (first.constructors[0]!.fixedArgumentCounts as number[]).push(2);
    expect(second.constructors).toHaveLength(17);
    expect(second.constructors[0]?.fixedArgumentCounts).toEqual([0]);
  });
});
