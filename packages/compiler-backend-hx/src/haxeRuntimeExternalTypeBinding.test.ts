import {
  createCompilerRuntimeExternalTypeBindingPlanHaxe,
  getCompilerRuntimeExternalTypeTargetHaxe,
} from './haxeRuntimeExternalTypeBinding.js';

describe('createCompilerRuntimeExternalTypeBindingPlanHaxe', () => {
  it('elects native Haxe types and versioned downstream runtime capabilities explicitly', () => {
    const plan = createCompilerRuntimeExternalTypeBindingPlanHaxe();

    expect(plan.contract).toBe('flight-runtime-contract/1');
    expect(plan.bindings).toEqual([
      { externalType: { sourceName: 'Array' }, kind: 'native' },
      { externalType: { sourceName: 'Boolean' }, kind: 'native' },
      { capability: 'float32-array', externalType: { sourceName: 'Float32Array' }, kind: 'runtime' },
      { capability: 'float64-array', externalType: { sourceName: 'Float64Array' }, kind: 'runtime' },
      { capability: 'int16-array', externalType: { sourceName: 'Int16Array' }, kind: 'runtime' },
      { capability: 'int32-array', externalType: { sourceName: 'Int32Array' }, kind: 'runtime' },
      { capability: 'int8-array', externalType: { sourceName: 'Int8Array' }, kind: 'runtime' },
      { capability: 'map', externalType: { sourceName: 'Map' }, kind: 'runtime' },
      { capability: 'task', externalType: { sourceName: 'Promise' }, kind: 'runtime' },
      { capability: 'set', externalType: { sourceName: 'Set' }, kind: 'runtime' },
      { capability: 'uint16-array', externalType: { sourceName: 'Uint16Array' }, kind: 'runtime' },
      { capability: 'uint32-array', externalType: { sourceName: 'Uint32Array' }, kind: 'runtime' },
      { capability: 'uint8-array', externalType: { sourceName: 'Uint8Array' }, kind: 'runtime' },
      {
        capability: 'uint8-clamped-array',
        externalType: { sourceName: 'Uint8ClampedArray' },
        kind: 'runtime',
      },
    ]);
  });

  it('creates independent plan records', () => {
    const first = createCompilerRuntimeExternalTypeBindingPlanHaxe();
    const second = createCompilerRuntimeExternalTypeBindingPlanHaxe();

    (first.bindings as unknown[]).pop();
    expect(second.bindings).toHaveLength(14);
  });
});

describe('getCompilerRuntimeExternalTypeTargetHaxe', () => {
  it.each([
    ['Array', 'Array'],
    ['Boolean', 'Bool'],
    ['Float32Array', 'flighthq._internal._Float32Array'],
    ['Float64Array', 'flighthq._internal._Float64Array'],
    ['Int16Array', 'flighthq._internal._Int16Array'],
    ['Int32Array', 'flighthq._internal._Int32Array'],
    ['Int8Array', 'flighthq._internal._Int8Array'],
    ['Map', 'flighthq._internal._Map'],
    ['Promise', 'flighthq._internal._Promise'],
    ['Set', 'flighthq._internal._Set'],
    ['Uint16Array', 'flighthq._internal._UInt16Array'],
    ['Uint32Array', 'flighthq._internal._UInt32Array'],
    ['Uint8Array', 'flighthq._internal._UInt8Array'],
    ['Uint8ClampedArray', 'flighthq._internal._UInt8ClampedArray'],
  ])('maps %s to %s', (sourceName, targetName) => {
    expect(getCompilerRuntimeExternalTypeTargetHaxe(sourceName)).toBe(targetName);
  });

  it('supports a configured runtime module and has no unknown-type fallback', () => {
    expect(getCompilerRuntimeExternalTypeTargetHaxe('Uint8Array', 'custom.runtime')).toBe('custom.runtime._UInt8Array');
    expect(getCompilerRuntimeExternalTypeTargetHaxe('Unmapped')).toBeUndefined();
  });
});
