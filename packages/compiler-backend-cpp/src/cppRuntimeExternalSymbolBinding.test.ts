import {
  createCompilerRuntimeExternalSymbolBindingPlanCpp,
  getCompilerExternalBindingConstructionCpp,
  getCompilerExternalBindingHeadersCpp,
  getCompilerRuntimeExternalMemberTargetCpp,
  getCompilerRuntimeExternalSymbolTargetCpp,
  isCompilerRuntimeExternalSymbolProvidedCpp,
} from './cppRuntimeExternalSymbolBinding.js';

const externalBindings = {
  bindings: [
    {
      construction: { kind: 'factory' as const, targetName: 'host::create_surface' },
      headers: ['host/surface.hpp'],
      members: [{ sourceMember: 'preferredFormat', targetName: 'host::preferred_format' }],
      nullability: 'non-null' as const,
      ownership: 'shared' as const,
      sourceName: 'NativeSurface',
      space: 'value' as const,
      targetName: 'host::Surface',
    },
  ],
  schema: 'flight-cpp-external-bindings/1' as const,
};

describe('createCompilerRuntimeExternalSymbolBindingPlanCpp', () => {
  it('elects type and value decisions under the versioned runtime contract', () => {
    const plan = createCompilerRuntimeExternalSymbolBindingPlanCpp();

    expect(plan.contract).toBe('flight-runtime-contract/2');
    expect(plan.bindings).toHaveLength(34);
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
    expect(second.bindings).toHaveLength(34);
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

  it('adds downstream native bindings without making them runtime capabilities', () => {
    const plan = createCompilerRuntimeExternalSymbolBindingPlanCpp('flight-cpp', externalBindings);

    expect(plan.bindings).toContainEqual({
      externalSymbol: { sourceName: 'NativeSurface', space: 'value' },
      kind: 'native',
    });
  });

  it('rejects malformed manifests and unsafe header spellings', () => {
    expect(() =>
      createCompilerRuntimeExternalSymbolBindingPlanCpp('flight-cpp', {
        bindings: [],
        schema: 'other' as 'flight-cpp-external-bindings/1',
      }),
    ).toThrow('flight-cpp-external-bindings/1');
    expect(() =>
      createCompilerRuntimeExternalSymbolBindingPlanCpp('flight-cpp', {
        bindings: [{ ...externalBindings.bindings[0]!, headers: ['../host.hpp'] }],
        schema: 'flight-cpp-external-bindings/1',
      }),
    ).toThrow('malformed');
  });
});

describe('getCompilerExternalBindingConstructionCpp', () => {
  it('returns an explicit constructor or factory mapping only for a downstream value binding', () => {
    expect(getCompilerExternalBindingConstructionCpp('NativeSurface', externalBindings)).toEqual({
      kind: 'factory',
      targetName: 'host::create_surface',
    });
    expect(getCompilerExternalBindingConstructionCpp('Missing', externalBindings)).toBeUndefined();
  });
});

describe('getCompilerExternalBindingHeadersCpp', () => {
  it('returns the headers owned by an exact downstream type/value-space binding', () => {
    expect(getCompilerExternalBindingHeadersCpp('NativeSurface', 'value', externalBindings)).toEqual([
      'host/surface.hpp',
    ]);
    expect(getCompilerExternalBindingHeadersCpp('NativeSurface', 'type', externalBindings)).toEqual([]);
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
    ['WeakMap', 'type', 'std::unordered_map'],
    ['WeakMap', 'value', 'std::unordered_map'],
  ] as const)('maps %s in %s space to %s', (sourceName, space, targetName) => {
    expect(getCompilerRuntimeExternalSymbolTargetCpp(sourceName, space)).toBe(targetName);
  });

  it('has no crossed-space or unknown fallback', () => {
    expect(getCompilerRuntimeExternalSymbolTargetCpp('Boolean', 'value')).toBeUndefined();
    expect(getCompilerRuntimeExternalSymbolTargetCpp('Unmapped', 'value')).toBeUndefined();
  });

  it('resolves downstream native symbols and static members in their exact spaces', () => {
    expect(getCompilerRuntimeExternalSymbolTargetCpp('NativeSurface', 'value', 'flight-cpp', externalBindings)).toBe(
      'host::Surface',
    );
    expect(
      getCompilerRuntimeExternalMemberTargetCpp('NativeSurface', 'preferredFormat', 'flight-cpp', externalBindings),
    ).toBe('host::preferred_format');
    expect(
      getCompilerRuntimeExternalSymbolTargetCpp('NativeSurface', 'type', 'flight-cpp', externalBindings),
    ).toBeUndefined();
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
    ['WeakMap', 'type', 'flight::WeakMap'],
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

  it('uses JavaScript-compatible numeric wrappers with the semantic runtime', () => {
    expect(getCompilerRuntimeExternalMemberTargetCpp('Math', 'round', 'flight-cpp')).toBe('flight::round');
    expect(getCompilerRuntimeExternalMemberTargetCpp('Math', 'pow', 'flight-cpp')).toBe('flight::power');
    expect(getCompilerRuntimeExternalMemberTargetCpp('Math', 'max', 'flight-cpp')).toBe('flight::maximum');
    expect(getCompilerRuntimeExternalMemberTargetCpp('Math', 'min', 'flight-cpp')).toBe('flight::minimum');
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
