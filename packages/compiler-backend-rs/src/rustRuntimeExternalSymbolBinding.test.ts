import {
  createCompilerRuntimeExternalSymbolBindingPlanRust,
  getCompilerRuntimeExternalMemberTargetRust,
  getCompilerRuntimeExternalSymbolTargetRust,
} from './rustRuntimeExternalSymbolBinding.js';

describe('createCompilerRuntimeExternalSymbolBindingPlanRust', () => {
  it('elects type and value decisions under the versioned runtime contract', () => {
    const plan = createCompilerRuntimeExternalSymbolBindingPlanRust();

    expect(plan.contract).toBe('flight-runtime-contract/2');
    expect(plan.bindings).toHaveLength(29);
    expect(plan.bindings.filter(({ externalSymbol }) => externalSymbol.sourceName === 'Promise')).toEqual([
      {
        capability: 'task',
        externalSymbol: { sourceName: 'Promise', space: 'type' },
        kind: 'runtime',
      },
      {
        capability: 'task',
        externalSymbol: { sourceName: 'Promise', space: 'value' },
        kind: 'runtime',
      },
    ]);
    expect(plan.bindings).toContainEqual({
      externalSymbol: { sourceName: 'Error', space: 'value' },
      kind: 'native',
    });
    expect(plan.bindings).not.toContainEqual({
      externalSymbol: { sourceName: 'Error', space: 'type' },
      kind: 'native',
    });
    expect(new Set(plan.bindings.map(({ externalSymbol }) => JSON.stringify(externalSymbol)))).toHaveLength(
      plan.bindings.length,
    );
  });

  it('creates independent plan records', () => {
    const first = createCompilerRuntimeExternalSymbolBindingPlanRust();
    const second = createCompilerRuntimeExternalSymbolBindingPlanRust();

    (first.bindings as unknown[]).pop();
    expect(second.bindings).toHaveLength(29);
  });
});

describe('getCompilerRuntimeExternalSymbolTargetRust', () => {
  it.each([
    ['Array', 'type', 'Vec'],
    ['Array', 'value', 'Vec'],
    ['Boolean', 'type', 'bool'],
    ['Error', 'value', 'Error'],
    ['Float32Array', 'type', 'Vec<f32>'],
    ['Float32Array', 'value', 'Vec<f32>'],
    ['Float64Array', 'type', 'Vec<f64>'],
    ['Float64Array', 'value', 'Vec<f64>'],
    ['Int16Array', 'type', 'Vec<i16>'],
    ['Int16Array', 'value', 'Vec<i16>'],
    ['Int32Array', 'type', 'Vec<i32>'],
    ['Int32Array', 'value', 'Vec<i32>'],
    ['Int8Array', 'type', 'Vec<i8>'],
    ['Int8Array', 'value', 'Vec<i8>'],
    ['Map', 'type', 'std::collections::HashMap'],
    ['Map', 'value', 'std::collections::HashMap'],
    ['Promise', 'type', 'FlightTask'],
    ['Promise', 'value', 'FlightTask'],
    ['Set', 'type', 'std::collections::HashSet'],
    ['Set', 'value', 'std::collections::HashSet'],
    ['Uint16Array', 'type', 'Vec<u16>'],
    ['Uint16Array', 'value', 'Vec<u16>'],
    ['Uint32Array', 'type', 'Vec<u32>'],
    ['Uint32Array', 'value', 'Vec<u32>'],
    ['Uint8Array', 'type', 'Vec<u8>'],
    ['Uint8Array', 'value', 'Vec<u8>'],
    ['Uint8ClampedArray', 'type', 'Vec<u8>'],
    ['Uint8ClampedArray', 'value', 'Vec<u8>'],
  ] as const)('maps %s in %s space to %s', (sourceName, space, targetName) => {
    expect(getCompilerRuntimeExternalSymbolTargetRust(sourceName, space)).toBe(targetName);
  });

  it('has no crossed-space or unknown fallback', () => {
    expect(getCompilerRuntimeExternalSymbolTargetRust('Boolean', 'value')).toBeUndefined();
    expect(getCompilerRuntimeExternalSymbolTargetRust('Error', 'type')).toBeUndefined();
    expect(getCompilerRuntimeExternalSymbolTargetRust('Unmapped', 'value')).toBeUndefined();
  });
});

describe('getCompilerRuntimeExternalMemberTargetRust', () => {
  it('spells a namespace member whole, because the symbol has no target name of its own', () => {
    // `Math` is not a Rust type: `Math.max` is `f64::max` and there is nothing to call `Math`. A
    // binding that maps one symbol to one name cannot express that, which is why members are bound.
    expect(getCompilerRuntimeExternalMemberTargetRust('Math', 'max')).toBe('f64::max');
    expect(getCompilerRuntimeExternalMemberTargetRust('Math', 'abs')).toBe('f64::abs');
    expect(getCompilerRuntimeExternalMemberTargetRust('Math', 'sqrt')).toBe('f64::sqrt');
  });

  it('claims nothing for an unbound member or an unbound symbol', () => {
    expect(getCompilerRuntimeExternalMemberTargetRust('Math', 'atan2')).toBeUndefined();
    expect(getCompilerRuntimeExternalMemberTargetRust('Array', 'from')).toBeUndefined();
    expect(getCompilerRuntimeExternalMemberTargetRust('Date', 'now')).toBeUndefined();
  });
});
