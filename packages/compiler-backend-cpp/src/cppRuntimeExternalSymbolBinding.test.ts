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
    expect(plan.bindings).toHaveLength(41);
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
    expect(second.bindings).toHaveLength(41);
  });

  it('elects semantic containers and strings as flight-cpp runtime capabilities', () => {
    const plan = createCompilerRuntimeExternalSymbolBindingPlanCpp('flight-cpp');

    expect(plan.bindings).toHaveLength(41);
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
      capability: 'map',
      externalSymbol: { sourceName: 'ReadonlyMap', space: 'type' },
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

  it('returns the profile-specific header for a built-in ReadonlyMap binding', () => {
    expect(getCompilerExternalBindingHeadersCpp('ReadonlyMap', 'type')).toEqual(['unordered_map']);
    expect(getCompilerExternalBindingHeadersCpp('ReadonlyMap', 'type', undefined, 'flight-cpp')).toEqual([
      'flight/map.hpp',
    ]);
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
    ['ReadonlyMap', 'type', 'std::unordered_map'],
    ['Set', 'type', 'std::unordered_set'],
    ['Set', 'value', 'std::unordered_set'],
    ['Uint8Array', 'type', 'std::vector<uint8_t>'],
  ] as const)('maps %s in %s space to %s', (sourceName, space, targetName) => {
    expect(getCompilerRuntimeExternalSymbolTargetCpp(sourceName, space)).toBe(targetName);
  });

  it('maps Number and RangeError in the type space', () => {
    expect(getCompilerRuntimeExternalSymbolTargetCpp('Number', 'type')).toBe('double');
    expect(getCompilerRuntimeExternalSymbolTargetCpp('Number', 'type', 'flight-cpp')).toBe('double');
    expect(getCompilerRuntimeExternalSymbolTargetCpp('RangeError', 'type')).toBe('std::range_error');
    expect(getCompilerRuntimeExternalSymbolTargetCpp('RangeError', 'type', 'flight-cpp')).toBe('std::range_error');
  });

  it('maps String in both spaces for the standard-library profile', () => {
    expect(getCompilerRuntimeExternalSymbolTargetCpp('String', 'type')).toBe('std::string');
    expect(getCompilerRuntimeExternalSymbolTargetCpp('String', 'value')).toBe('std::string');
  });

  it('has no crossed-space or unknown fallback', () => {
    expect(getCompilerRuntimeExternalSymbolTargetCpp('Boolean', 'value')).toBeUndefined();
    expect(getCompilerRuntimeExternalSymbolTargetCpp('Unmapped', 'value')).toBeUndefined();
    for (const [unsupported, space] of [
      ['ArrayBuffer', 'type'],
      ['console', 'value'],
      ['DataView', 'type'],
      ['JSON', 'value'],
      ['Record', 'type'],
      ['RegExp', 'type'],
      ['WeakMap', 'type'],
      ['WebGLProgram', 'type'],
    ] as const) {
      expect(getCompilerRuntimeExternalSymbolTargetCpp(unsupported, space)).toBeUndefined();
      expect(getCompilerRuntimeExternalSymbolTargetCpp(unsupported, space, 'flight-cpp')).toBeUndefined();
    }
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

  it('maps Promise static operations in both runtime profiles', () => {
    expect(getCompilerRuntimeExternalMemberTargetCpp('Promise', 'resolve')).toBe('FlightTask::resolve');
    expect(getCompilerRuntimeExternalMemberTargetCpp('Promise', 'reject')).toBe('FlightTask::reject');
    expect(getCompilerRuntimeExternalMemberTargetCpp('Promise', 'all')).toBe('FlightTask::all');
    expect(getCompilerRuntimeExternalMemberTargetCpp('Promise', 'resolve', 'flight-cpp')).toBe('flight::resolve_task');
  });

  it.each([
    ['Array', 'type', 'flight::Array'],
    ['Date', 'value', 'flight::Date'],
    ['Error', 'type', 'flight::Error'],
    ['Map', 'type', 'flight::Map'],
    ['Promise', 'type', 'flight::Task'],
    ['ReadonlyMap', 'type', 'flight::Map'],
    ['Set', 'value', 'flight::Set'],
    ['String', 'type', 'flight::String'],
    ['Uint8ClampedArray', 'value', 'flight::Uint8ClampedArray'],
  ] as const)('maps %s in %s space to the semantic runtime target %s', (sourceName, space, targetName) => {
    expect(getCompilerRuntimeExternalSymbolTargetCpp(sourceName, space, 'flight-cpp')).toBe(targetName);
  });

  it.each(['flight-cpp', 'standard-library'] as const)(
    'maps numeric globals and RangeError values in the %s profile',
    (runtimeProfile) => {
      expect(getCompilerRuntimeExternalSymbolTargetCpp('Infinity', 'value', runtimeProfile)).toBe(
        'std::numeric_limits<double>::infinity()',
      );
      expect(getCompilerRuntimeExternalSymbolTargetCpp('NaN', 'value', runtimeProfile)).toBe(
        'std::numeric_limits<double>::quiet_NaN()',
      );
      expect(getCompilerRuntimeExternalSymbolTargetCpp('Number', 'value', runtimeProfile)).toBe('double');
      expect(getCompilerRuntimeExternalSymbolTargetCpp('RangeError', 'value', runtimeProfile)).toBe('std::range_error');
    },
  );
});

describe('getCompilerRuntimeExternalMemberTargetCpp', () => {
  it('spells Math namespace members as their C++ standard library equivalents', () => {
    expect(getCompilerRuntimeExternalMemberTargetCpp('Math', 'max')).toBe('std::max');
    expect(getCompilerRuntimeExternalMemberTargetCpp('Math', 'abs')).toBe('std::abs');
    expect(getCompilerRuntimeExternalMemberTargetCpp('Math', 'sqrt')).toBe('std::sqrt');
    expect(getCompilerRuntimeExternalMemberTargetCpp('Math', 'PI')).toBe('M_PI');
  });

  it.each(['flight-cpp', 'standard-library'] as const)(
    'binds the complete Flight SDK Math function surface in the %s profile',
    (runtimeProfile) => {
      for (const member of ['acos', 'asin', 'atan', 'atan2', 'cbrt', 'exp', 'hypot', 'log', 'log2', 'log10', 'tan']) {
        expect(getCompilerRuntimeExternalMemberTargetCpp('Math', member, runtimeProfile)).toBe(`std::${member}`);
      }
    },
  );

  it('uses JavaScript-compatible numeric wrappers with the semantic runtime', () => {
    expect(getCompilerRuntimeExternalMemberTargetCpp('Math', 'round', 'flight-cpp')).toBe('flight::round');
    expect(getCompilerRuntimeExternalMemberTargetCpp('Math', 'pow', 'flight-cpp')).toBe('flight::power');
    expect(getCompilerRuntimeExternalMemberTargetCpp('Math', 'max', 'flight-cpp')).toBe('flight::maximum');
    expect(getCompilerRuntimeExternalMemberTargetCpp('Math', 'min', 'flight-cpp')).toBe('flight::minimum');
  });

  it.each(['flight-cpp', 'standard-library'] as const)(
    'maps Math.imul to an exact signed 32-bit multiplication in the %s profile',
    (runtimeProfile) => {
      const target = getCompilerRuntimeExternalMemberTargetCpp('Math', 'imul', runtimeProfile);
      expect(target).toContain('std::uint32_t');
      expect(target).toContain('std::int64_t');
      expect(target).toContain('4294967296.0');
    },
  );

  it.each(['flight-cpp', 'standard-library'] as const)(
    'maps Number constants and predicates in the %s profile',
    (runtimeProfile) => {
      expect(getCompilerRuntimeExternalMemberTargetCpp('Number', 'EPSILON', runtimeProfile)).toBe(
        'std::numeric_limits<double>::epsilon()',
      );
      expect(getCompilerRuntimeExternalMemberTargetCpp('Number', 'MIN_VALUE', runtimeProfile)).toBe(
        'std::numeric_limits<double>::denorm_min()',
      );
      expect(getCompilerRuntimeExternalMemberTargetCpp('Number', 'isFinite', runtimeProfile)).toBe('std::isfinite');
    },
  );

  it('maps Number.isInteger to the semantic runtime in the flight-cpp profile', () => {
    expect(getCompilerRuntimeExternalMemberTargetCpp('Number', 'isInteger', 'flight-cpp')).toBe('flight::is_integer');
  });

  it('maps Number.isInteger to a finite integral test in the standard-library profile', () => {
    expect(getCompilerRuntimeExternalMemberTargetCpp('Number', 'isInteger', 'standard-library')).toBe(
      '[](double value) noexcept { return std::isfinite(value) && std::trunc(value) == value; }',
    );
  });

  it('claims nothing for an unbound member or an unbound symbol', () => {
    expect(getCompilerRuntimeExternalMemberTargetCpp('Math', 'random')).toBeUndefined();
    expect(getCompilerRuntimeExternalMemberTargetCpp('Array', 'from')).toBeUndefined();
    expect(getCompilerRuntimeExternalMemberTargetCpp('Date', 'now')).toBeUndefined();
    expect(getCompilerRuntimeExternalMemberTargetCpp('console', 'log')).toBeUndefined();
    expect(getCompilerRuntimeExternalMemberTargetCpp('JSON', 'parse')).toBeUndefined();
    expect(getCompilerRuntimeExternalMemberTargetCpp('Unmapped', 'method')).toBeUndefined();
  });
});

describe('isCompilerRuntimeExternalSymbolProvidedCpp', () => {
  it('separates a symbol the runtime provides from one C++ already has', () => {
    expect(isCompilerRuntimeExternalSymbolProvidedCpp('Promise', 'type')).toBe(true);
    expect(isCompilerRuntimeExternalSymbolProvidedCpp('Map', 'type')).toBe(false);
    expect(isCompilerRuntimeExternalSymbolProvidedCpp('NotASymbol', 'type')).toBe(false);
    expect(isCompilerRuntimeExternalSymbolProvidedCpp('Map', 'type', 'flight-cpp')).toBe(true);
    expect(isCompilerRuntimeExternalSymbolProvidedCpp('ReadonlyMap', 'type', 'flight-cpp')).toBe(true);
    expect(isCompilerRuntimeExternalSymbolProvidedCpp('WeakMap', 'type', 'flight-cpp')).toBe(false);
  });
});
