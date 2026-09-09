import {
  createCompilerRuntimeExternalSymbolBindingPlanCpp,
  getCompilerRuntimeExternalMemberTargetCpp,
  getCompilerRuntimeExternalSymbolTargetCpp,
  isCompilerRuntimeExternalSymbolProvidedCpp,
} from './cppRuntimeExternalSymbolBinding.js';

describe('createCompilerRuntimeExternalSymbolBindingPlanCpp', () => {
  it('elects type and value decisions under the versioned runtime contract', () => {
    const plan = createCompilerRuntimeExternalSymbolBindingPlanCpp();

    expect(plan.contract).toBe('flight-runtime-contract/2');
    expect(plan.bindings).toHaveLength(32);
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
      externalSymbol: { sourceName: 'Error', space: 'type' },
      kind: 'native',
    });
    expect(plan.bindings).toContainEqual({
      externalSymbol: { sourceName: 'Error', space: 'value' },
      kind: 'native',
    });
    expect(new Set(plan.bindings.map(({ externalSymbol }) => JSON.stringify(externalSymbol)))).toHaveLength(
      plan.bindings.length,
    );
  });

  it('creates independent plan records', () => {
    const first = createCompilerRuntimeExternalSymbolBindingPlanCpp();
    const second = createCompilerRuntimeExternalSymbolBindingPlanCpp();

    (first.bindings as unknown[]).pop();
    expect(second.bindings).toHaveLength(32);
  });

  it('elects semantic containers and strings as flight-cpp runtime capabilities', () => {
    const plan = createCompilerRuntimeExternalSymbolBindingPlanCpp('flight-cpp');

    expect(plan.bindings).toHaveLength(36);
    expect(plan.bindings).toContainEqual({
      capability: 'array',
      externalSymbol: { sourceName: 'Array', space: 'type' },
      kind: 'runtime',
    });
    expect(plan.bindings).toContainEqual({
      capability: 'string',
      externalSymbol: { sourceName: 'String', space: 'value' },
      kind: 'runtime',
    });
    expect(plan.bindings).toContainEqual({
      capability: 'error',
      externalSymbol: { sourceName: 'Error', space: 'type' },
      kind: 'runtime',
    });
    expect(plan.bindings).toContainEqual({
      capability: 'weak-map',
      externalSymbol: { sourceName: 'WeakMap', space: 'type' },
      kind: 'runtime',
    });
  });
});

describe('getCompilerRuntimeExternalSymbolTargetCpp', () => {
  it.each([
    ['Array', 'type', 'std::vector'],
    ['Array', 'value', 'std::vector'],
    ['Boolean', 'type', 'bool'],
    ['Date', 'type', 'FlightDate'],
    ['Date', 'value', 'FlightDate'],
    ['Error', 'type', 'std::runtime_error'],
    ['Error', 'value', 'std::runtime_error'],
    ['Float32Array', 'type', 'std::vector<float>'],
    ['Float64Array', 'type', 'std::vector<double>'],
    ['Int32Array', 'type', 'std::vector<int32_t>'],
    ['Map', 'type', 'std::unordered_map'],
    ['Map', 'value', 'std::unordered_map'],
    ['Promise', 'type', 'FlightTask'],
    ['Promise', 'value', 'FlightTask'],
    ['Set', 'type', 'std::unordered_set'],
    ['Set', 'value', 'std::unordered_set'],
    ['Uint8Array', 'type', 'std::vector<uint8_t>'],
  ] as const)('maps %s in %s space to %s', (sourceName, space, targetName) => {
    expect(getCompilerRuntimeExternalSymbolTargetCpp(sourceName, space)).toBe(targetName);
  });

  it('has no crossed-space or unknown fallback', () => {
    expect(getCompilerRuntimeExternalSymbolTargetCpp('Boolean', 'value')).toBeUndefined();
    expect(getCompilerRuntimeExternalSymbolTargetCpp('Unmapped', 'value')).toBeUndefined();
  });

  it.each([
    ['Array', 'type', 'flight::Array'],
    ['Date', 'value', 'flight::Date'],
    ['Error', 'type', 'flight::Error'],
    ['Map', 'type', 'flight::Map'],
    ['Promise', 'type', 'flight::Task'],
    ['Set', 'value', 'flight::Set'],
    ['String', 'type', 'flight::String'],
    ['Uint8ClampedArray', 'value', 'flight::Uint8ClampedArray'],
  ] as const)('maps %s in %s space to the semantic runtime target %s', (sourceName, space, targetName) => {
    expect(getCompilerRuntimeExternalSymbolTargetCpp(sourceName, space, 'flight-cpp')).toBe(targetName);
  });
});

describe('getCompilerRuntimeExternalMemberTargetCpp', () => {
  it('spells Math namespace members as their C++ standard library equivalents', () => {
    expect(getCompilerRuntimeExternalMemberTargetCpp('Math', 'max')).toBe('std::max');
    expect(getCompilerRuntimeExternalMemberTargetCpp('Math', 'abs')).toBe('std::abs');
    expect(getCompilerRuntimeExternalMemberTargetCpp('Math', 'sqrt')).toBe('std::sqrt');
    expect(getCompilerRuntimeExternalMemberTargetCpp('Math', 'PI')).toBe('M_PI');
  });

  it('uses the JavaScript-compatible rounding wrapper with the semantic runtime', () => {
    expect(getCompilerRuntimeExternalMemberTargetCpp('Math', 'round', 'flight-cpp')).toBe('flight::round');
  });

  it('claims nothing for an unbound member or an unbound symbol', () => {
    expect(getCompilerRuntimeExternalMemberTargetCpp('Math', 'atan2')).toBeUndefined();
    expect(getCompilerRuntimeExternalMemberTargetCpp('Array', 'from')).toBeUndefined();
    expect(getCompilerRuntimeExternalMemberTargetCpp('Date', 'now')).toBeUndefined();
    expect(getCompilerRuntimeExternalMemberTargetCpp('Unmapped', 'method')).toBeUndefined();
  });
});

describe('isCompilerRuntimeExternalSymbolProvidedCpp', () => {
  it('separates a symbol the runtime provides from one C++ already has', () => {
    expect(isCompilerRuntimeExternalSymbolProvidedCpp('Promise', 'type')).toBe(true);
    expect(isCompilerRuntimeExternalSymbolProvidedCpp('Map', 'type')).toBe(false);
    expect(isCompilerRuntimeExternalSymbolProvidedCpp('NotASymbol', 'type')).toBe(false);
    expect(isCompilerRuntimeExternalSymbolProvidedCpp('Map', 'type', 'flight-cpp')).toBe(true);
  });
});
