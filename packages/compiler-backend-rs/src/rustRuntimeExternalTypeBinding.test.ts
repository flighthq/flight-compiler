import {
  createCompilerRuntimeExternalTypeBindingPlanRust,
  getCompilerRuntimeExternalTypeTargetRust,
} from './rustRuntimeExternalTypeBinding.js';

describe('createCompilerRuntimeExternalTypeBindingPlanRust', () => {
  it('elects native Rust types and the versioned downstream task capability explicitly', () => {
    const plan = createCompilerRuntimeExternalTypeBindingPlanRust();

    expect(plan.contract).toBe('flight-runtime-contract/1');
    expect(plan.bindings).toEqual([
      { externalType: { sourceName: 'Array' }, kind: 'native' },
      { externalType: { sourceName: 'Boolean' }, kind: 'native' },
      { externalType: { sourceName: 'Float32Array' }, kind: 'native' },
      { externalType: { sourceName: 'Float64Array' }, kind: 'native' },
      { externalType: { sourceName: 'Int16Array' }, kind: 'native' },
      { externalType: { sourceName: 'Int32Array' }, kind: 'native' },
      { externalType: { sourceName: 'Int8Array' }, kind: 'native' },
      { externalType: { sourceName: 'Map' }, kind: 'native' },
      { capability: 'task', externalType: { sourceName: 'Promise' }, kind: 'runtime' },
      { externalType: { sourceName: 'Set' }, kind: 'native' },
      { externalType: { sourceName: 'Uint16Array' }, kind: 'native' },
      { externalType: { sourceName: 'Uint32Array' }, kind: 'native' },
      { externalType: { sourceName: 'Uint8Array' }, kind: 'native' },
      { externalType: { sourceName: 'Uint8ClampedArray' }, kind: 'native' },
    ]);
  });

  it('creates independent plan records', () => {
    const first = createCompilerRuntimeExternalTypeBindingPlanRust();
    const second = createCompilerRuntimeExternalTypeBindingPlanRust();

    (first.bindings as unknown[]).pop();
    expect(second.bindings).toHaveLength(14);
  });
});

describe('getCompilerRuntimeExternalTypeTargetRust', () => {
  it.each([
    ['Array', 'Vec'],
    ['Boolean', 'bool'],
    ['Float32Array', 'Vec<f32>'],
    ['Float64Array', 'Vec<f64>'],
    ['Int16Array', 'Vec<i16>'],
    ['Int32Array', 'Vec<i32>'],
    ['Int8Array', 'Vec<i8>'],
    ['Map', 'std::collections::HashMap'],
    ['Promise', 'FlightTask'],
    ['Set', 'std::collections::HashSet'],
    ['Uint16Array', 'Vec<u16>'],
    ['Uint32Array', 'Vec<u32>'],
    ['Uint8Array', 'Vec<u8>'],
    ['Uint8ClampedArray', 'Vec<u8>'],
  ])('maps %s to %s', (sourceName, targetName) => {
    expect(getCompilerRuntimeExternalTypeTargetRust(sourceName)).toBe(targetName);
  });

  it('has no unknown-type fallback', () => {
    expect(getCompilerRuntimeExternalTypeTargetRust('Unmapped')).toBeUndefined();
  });
});
