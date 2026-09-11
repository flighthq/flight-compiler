import {
  createCompilerRuntimeExternalSymbolBindingPlanCpp,
  getCompilerExternalBindingCallResultTypeCpp,
  getCompilerExternalBindingConstructionCpp,
  getCompilerExternalBindingEvidenceCpp,
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
    expect(plan.bindings).toHaveLength(50);
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
    expect(plan.bindings).toContainEqual({
      externalSymbol: { sourceName: 'Object', space: 'value' },
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
    expect(second.bindings).toHaveLength(50);
  });

  it('elects semantic containers and strings as flight-cpp runtime capabilities', () => {
    const plan = createCompilerRuntimeExternalSymbolBindingPlanCpp('flight-cpp');

    expect(plan.bindings).toHaveLength(78);
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
    expect(plan.bindings).toContainEqual({
      capability: 'set',
      externalSymbol: { sourceName: 'ReadonlySet', space: 'type' },
      kind: 'runtime',
    });
    expect(plan.bindings).toContainEqual({
      capability: 'symbol',
      externalSymbol: { sourceName: 'Symbol', space: 'value' },
      kind: 'runtime',
    });
    expect(plan.bindings).toContainEqual({
      capability: 'internationalization',
      externalSymbol: { sourceName: 'Intl.NumberFormatOptions', space: 'type' },
      kind: 'runtime',
    });
    expect(plan.bindings).toContainEqual({
      capability: 'regexp',
      externalSymbol: { sourceName: 'RegExpExecArray', space: 'type' },
      kind: 'runtime',
    });
    expect(plan.bindings).toContainEqual({
      capability: 'object',
      externalSymbol: { sourceName: 'Object', space: 'value' },
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

describe('getCompilerExternalBindingCallResultTypeCpp', () => {
  const timerBindings = {
    bindings: [
      {
        callResultType: 'host::TimerHandle',
        headers: ['host/timer.hpp'],
        nullability: 'non-null' as const,
        ownership: 'value' as const,
        sourceName: 'setTimeout',
        space: 'value' as const,
        targetName: 'host::set_timeout',
      },
    ],
    schema: 'flight-cpp-external-bindings/1' as const,
  };

  it('returns exact call-result evidence only for a downstream value binding', () => {
    expect(getCompilerExternalBindingCallResultTypeCpp('setTimeout', timerBindings)).toBe('host::TimerHandle');
    expect(getCompilerExternalBindingCallResultTypeCpp('Missing', timerBindings)).toBeUndefined();
    expect(getCompilerExternalBindingCallResultTypeCpp('NativeSurface', externalBindings)).toBeUndefined();
  });

  it('rejects malformed, type-space, and ambiguous call-result evidence', () => {
    expect(() =>
      getCompilerExternalBindingCallResultTypeCpp('setTimeout', {
        bindings: [{ ...timerBindings.bindings[0]!, callResultType: '' }],
        schema: 'flight-cpp-external-bindings/1',
      }),
    ).toThrow('malformed call-result type');
    expect(() =>
      getCompilerExternalBindingCallResultTypeCpp('setTimeout', {
        bindings: [{ ...timerBindings.bindings[0]!, space: 'type' }],
        schema: 'flight-cpp-external-bindings/1',
      }),
    ).toThrow('malformed call-result type');
    expect(() =>
      getCompilerExternalBindingCallResultTypeCpp('setTimeout', {
        bindings: [timerBindings.bindings[0]!, { ...timerBindings.bindings[0]!, callResultType: 'host::OtherHandle' }],
        schema: 'flight-cpp-external-bindings/1',
      }),
    ).toThrow('ambiguous for setTimeout[value]');
  });
});

describe('getCompilerExternalBindingEvidenceCpp', () => {
  it('returns exact validated ownership and nullability evidence for one external symbol space', () => {
    const manifest = {
      bindings: [
        {
          headers: ['host/gpu.hpp'],
          nullability: 'nullable' as const,
          ownership: 'shared' as const,
          sourceName: 'GPUDevice',
          space: 'type' as const,
          targetName: 'host::GpuDevice',
        },
      ],
      schema: 'flight-cpp-external-bindings/1' as const,
    };

    expect(getCompilerExternalBindingEvidenceCpp('GPUDevice', 'type', manifest)).toEqual({
      nullability: 'nullable',
      ownership: 'shared',
      sourceName: 'GPUDevice',
      space: 'type',
      targetName: 'host::GpuDevice',
    });
    expect(getCompilerExternalBindingEvidenceCpp('GPUDevice', 'value', manifest)).toBeUndefined();
  });

  it('rejects ambiguous normalized identities and malformed evidence instead of choosing one', () => {
    const binding = {
      headers: ['host/gpu.hpp'],
      nullability: 'non-null' as const,
      ownership: 'owned' as const,
      sourceName: 'GPUDevice',
      space: 'type' as const,
      targetName: 'host::GpuDevice',
    };
    expect(() =>
      getCompilerExternalBindingEvidenceCpp('GPUDevice', 'type', {
        bindings: [binding, { ...binding, targetName: 'host::OtherGpuDevice' }],
        schema: 'flight-cpp-external-bindings/1',
      }),
    ).toThrow('ambiguous for GPUDevice[type]');
    expect(() =>
      getCompilerExternalBindingEvidenceCpp('GPUDevice', 'type', {
        bindings: [{ ...binding, ownership: 'unknown' as 'shared' }],
        schema: 'flight-cpp-external-bindings/1',
      }),
    ).toThrow('malformed');
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

  it('returns the profile-specific header for a built-in ReadonlySet binding', () => {
    expect(getCompilerExternalBindingHeadersCpp('ReadonlySet', 'type')).toEqual(['unordered_set']);
    expect(getCompilerExternalBindingHeadersCpp('ReadonlySet', 'type', undefined, 'flight-cpp')).toEqual([]);
  });

  it('returns the semantic runtime header for the interned symbol binding', () => {
    expect(getCompilerExternalBindingHeadersCpp('Symbol', 'value')).toEqual([]);
    expect(getCompilerExternalBindingHeadersCpp('Symbol', 'value', undefined, 'flight-cpp')).toEqual([
      'flight/symbol.hpp',
    ]);
  });

  it('returns profile-specific Object operation support headers', () => {
    expect(getCompilerExternalBindingHeadersCpp('Object', 'value', undefined, 'flight-cpp')).toEqual([
      'cmath',
      'flight/object.hpp',
      'type_traits',
    ]);
    expect(getCompilerExternalBindingHeadersCpp('Object', 'value', undefined, 'standard-library')).toEqual([
      'cmath',
      'type_traits',
      'vector',
    ]);
  });

  it.each(['flight-cpp', 'standard-library'] as const)(
    'includes native random and numeric predicate support in the %s profile',
    (runtimeProfile) => {
      expect(getCompilerExternalBindingHeadersCpp('Math', 'value', undefined, runtimeProfile)).toContain('random');
      expect(getCompilerExternalBindingHeadersCpp('isNaN', 'value', undefined, runtimeProfile)).toEqual(['cmath']);
    },
  );

  it('returns semantic runtime headers for the newly modeled portable services', () => {
    expect(getCompilerExternalBindingHeadersCpp('ArrayBuffer', 'value', undefined, 'flight-cpp')).toEqual([
      'flight/array_buffer.hpp',
    ]);
    expect(getCompilerExternalBindingHeadersCpp('Intl.Collator', 'type', undefined, 'flight-cpp')).toEqual([
      'flight/intl.hpp',
    ]);
    expect(getCompilerExternalBindingHeadersCpp('RegExp', 'type', undefined, 'flight-cpp')).toEqual([
      'flight/regexp.hpp',
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
    ['ReadonlySet', 'type', 'std::unordered_set'],
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
      ['console', 'value'],
      ['DataView', 'type'],
      ['JSON', 'value'],
      ['RegExp', 'type'],
      ['WebGLProgram', 'type'],
    ] as const) {
      expect(getCompilerRuntimeExternalSymbolTargetCpp(unsupported, space)).toBeUndefined();
    }
    expect(getCompilerRuntimeExternalSymbolTargetCpp('console', 'value', 'flight-cpp')).toBeUndefined();
    expect(getCompilerRuntimeExternalSymbolTargetCpp('WebGLProgram', 'type', 'flight-cpp')).toBeUndefined();
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

  it('maps interned symbols only through the semantic runtime profile', () => {
    expect(getCompilerRuntimeExternalSymbolTargetCpp('Symbol', 'value')).toBeUndefined();
    expect(getCompilerRuntimeExternalSymbolTargetCpp('Symbol', 'value', 'flight-cpp')).toBe('flight::Symbol');
    expect(getCompilerRuntimeExternalMemberTargetCpp('Symbol', 'for')).toBeUndefined();
    expect(getCompilerRuntimeExternalMemberTargetCpp('Symbol', 'for', 'flight-cpp')).toBe('flight::Symbol::for_key');
  });

  it.each([
    ['Array', 'type', 'flight::Array'],
    ['ArrayBuffer', 'value', 'flight::ArrayBuffer'],
    ['DataView', 'type', 'flight::DataView'],
    ['Date', 'value', 'flight::Date'],
    ['Error', 'type', 'flight::Error'],
    ['Map', 'type', 'flight::Map'],
    ['Promise', 'type', 'flight::Task'],
    ['ReadonlyMap', 'type', 'flight::Map'],
    ['ReadonlySet', 'type', 'flight::Set'],
    ['Set', 'value', 'flight::Set'],
    ['String', 'type', 'flight::String'],
    ['TextDecoder', 'value', 'flight::TextDecoder'],
    ['Uint8ClampedArray', 'value', 'flight::Uint8ClampedArray'],
    ['URL', 'value', 'flight::Url'],
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
      expect(getCompilerRuntimeExternalSymbolTargetCpp('Number', 'value', runtimeProfile)).toBe(
        runtimeProfile === 'flight-cpp' ? 'flight::to_number' : 'double',
      );
      expect(getCompilerRuntimeExternalMemberTargetCpp('Number', 'NaN', runtimeProfile)).toBe(
        'std::numeric_limits<double>::quiet_NaN()',
      );
      expect(getCompilerRuntimeExternalSymbolTargetCpp('RangeError', 'value', runtimeProfile)).toBe('std::range_error');
    },
  );

  it.each(['flight-cpp', 'standard-library'] as const)(
    'binds Math.random to a process-local C++ random source in the %s profile',
    (runtimeProfile) => {
      const target = getCompilerRuntimeExternalMemberTargetCpp('Math', 'random', runtimeProfile);
      expect(target).toContain('thread_local std::mt19937_64');
      expect(target).toContain('std::generate_canonical<double, 53>');
    },
  );

  it('maps portable service namespaces and functions through the semantic runtime profile', () => {
    expect(getCompilerRuntimeExternalMemberTargetCpp('Object', 'keys', 'flight-cpp')).toBe('flight::object_keys');
    expect(getCompilerRuntimeExternalMemberTargetCpp('JSON', 'parse', 'flight-cpp')).toBe('flight::Json::parse');
    expect(getCompilerRuntimeExternalMemberTargetCpp('Intl', 'Collator', 'flight-cpp')).toBe('flight::IntlCollator');
    expect(getCompilerRuntimeExternalMemberTargetCpp('String', 'fromCodePoint', 'flight-cpp')).toBe(
      'flight::String::from_code_point',
    );
    expect(getCompilerRuntimeExternalSymbolTargetCpp('parseInt', 'value', 'flight-cpp')).toBe('flight::parse_int');
    expect(getCompilerRuntimeExternalSymbolTargetCpp('isNaN', 'value', 'flight-cpp')).toBe('std::isnan');
  });
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
    'maps Object.is to exact SameValue semantics in the %s profile',
    (runtimeProfile) => {
      const target = getCompilerRuntimeExternalMemberTargetCpp('Object', 'is', runtimeProfile);
      expect(target).toContain('!std::is_same_v<Left, Right>');
      expect(target).toContain('std::isnan(left) && std::isnan(right)');
      expect(target).toContain('std::signbit(left) == std::signbit(right)');
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
    expect(isCompilerRuntimeExternalSymbolProvidedCpp('Object', 'value', 'flight-cpp')).toBe(true);
    expect(isCompilerRuntimeExternalSymbolProvidedCpp('Symbol', 'value', 'flight-cpp')).toBe(true);
    expect(isCompilerRuntimeExternalSymbolProvidedCpp('JSON', 'value', 'flight-cpp')).toBe(true);
    expect(isCompilerRuntimeExternalSymbolProvidedCpp('RegExpExecArray', 'type', 'flight-cpp')).toBe(true);
    expect(isCompilerRuntimeExternalSymbolProvidedCpp('WeakMap', 'type', 'flight-cpp')).toBe(false);
  });
});
