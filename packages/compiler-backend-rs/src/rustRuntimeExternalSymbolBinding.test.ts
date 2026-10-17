import {
  collectCompilerRustExternalBindingRepresentationRefusals,
  createCompilerRuntimeExternalSymbolBindingPlanRust,
  createCompilerRustRuntimeExternalSymbolBindingPlan,
  getCompilerRuntimeExternalMemberTargetRust,
  getCompilerRuntimeExternalSymbolTargetRust,
  isCompilerRuntimeExternalSymbolProvidedRust,
} from './rustRuntimeExternalSymbolBinding.js';

describe('createCompilerRuntimeExternalSymbolBindingPlanRust', () => {
  it('elects type and value decisions under the versioned runtime contract', () => {
    const plan = createCompilerRuntimeExternalSymbolBindingPlanRust();

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
    expect(plan.bindings.filter(({ externalSymbol }) => externalSymbol.sourceName === 'Uint8Array')).toEqual([
      {
        capability: 'uint8-array',
        externalSymbol: { sourceName: 'Uint8Array', space: 'type' },
        kind: 'runtime',
      },
      {
        capability: 'uint8-array',
        externalSymbol: { sourceName: 'Uint8Array', space: 'value' },
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
    const first = createCompilerRuntimeExternalSymbolBindingPlanRust();
    const second = createCompilerRuntimeExternalSymbolBindingPlanRust();

    (first.bindings as unknown[]).pop();
    expect(second.bindings).toHaveLength(50);
  });

  it('adds versioned downstream host bindings without treating them as runtime capabilities', () => {
    const externalBindings = {
      bindings: [
        {
          nullability: 'non-null' as const,
          ownership: 'owned' as const,
          sourceName: 'HTMLImageElement',
          space: 'type' as const,
          targetName: 'host::Image',
        },
        {
          members: [{ sourceMember: 'create', targetName: 'host::Image::create' }],
          nullability: 'non-null' as const,
          ownership: 'owned' as const,
          sourceName: 'HTMLImageElement',
          space: 'value' as const,
          targetName: 'host::Image',
        },
      ],
      schema: 'flight-rust-external-bindings/1' as const,
    };

    expect(createCompilerRuntimeExternalSymbolBindingPlanRust(externalBindings).bindings).toContainEqual({
      externalSymbol: { sourceName: 'HTMLImageElement', space: 'type' },
      kind: 'native',
    });
    expect(getCompilerRuntimeExternalSymbolTargetRust('HTMLImageElement', 'type', externalBindings)).toBe(
      'host::Image',
    );
    expect(getCompilerRuntimeExternalMemberTargetRust('HTMLImageElement', 'create', externalBindings)).toBe(
      'host::Image::create',
    );
    expect(isCompilerRuntimeExternalSymbolProvidedRust('HTMLImageElement', 'type', externalBindings)).toBe(false);
  });

  it('rejects malformed downstream host binding manifests', () => {
    expect(() =>
      createCompilerRuntimeExternalSymbolBindingPlanRust({ bindings: [], schema: 'wrong' } as never),
    ).toThrow('flight-rust-external-bindings/1');
    expect(() =>
      createCompilerRuntimeExternalSymbolBindingPlanRust({
        bindings: [
          {
            nullability: 'non-null',
            ownership: 'shared',
            sourceName: '',
            space: 'type',
            targetName: 'host::Image',
          },
        ],
        schema: 'flight-rust-external-bindings/1',
      }),
    ).toThrow('Rust external binding 0 is malformed');
  });
});

describe('collectCompilerRustExternalBindingRepresentationRefusals', () => {
  it.each(['owned', 'value'] as const)('accepts direct non-null %s host carriers', (ownership) => {
    expect(
      collectCompilerRustExternalBindingRepresentationRefusals({
        bindings: [
          {
            nullability: 'non-null',
            ownership,
            sourceName: 'Blob',
            space: 'type',
            targetName: 'host::Blob',
          },
        ],
        schema: 'flight-rust-external-bindings/1',
      }),
    ).toEqual([]);
  });

  it.each(['borrowed', 'shared'] as const)('refuses unrepresented %s host ownership', (ownership) => {
    expect(
      collectCompilerRustExternalBindingRepresentationRefusals({
        bindings: [
          {
            nullability: 'non-null',
            ownership,
            sourceName: 'Blob',
            space: 'type',
            targetName: 'host::Blob',
          },
        ],
        schema: 'flight-rust-external-bindings/1',
      }),
    ).toEqual([
      {
        message: `downstream Rust host binding Blob (type) declares ${ownership} ownership, but direct target carrier host::Blob is passed by value`,
        rule: 'rust-host-binding-ownership-unrepresented',
      },
    ]);
  });

  it('refuses unrepresented nullable host carriers in deterministic order', () => {
    const bindings = [
      {
        nullability: 'nullable' as const,
        ownership: 'owned' as const,
        sourceName: 'VideoFrame',
        space: 'type' as const,
        targetName: 'host::VideoFrame',
      },
      {
        nullability: 'nullable' as const,
        ownership: 'value' as const,
        sourceName: 'Blob',
        space: 'type' as const,
        targetName: 'host::Blob',
      },
    ];
    const manifest = (orderedBindings: typeof bindings) => ({
      bindings: orderedBindings,
      schema: 'flight-rust-external-bindings/1' as const,
    });
    const forward = collectCompilerRustExternalBindingRepresentationRefusals(manifest(bindings));
    const reverse = collectCompilerRustExternalBindingRepresentationRefusals(manifest([...bindings].reverse()));

    expect(forward).toEqual(reverse);
    expect(forward.map(({ rule }) => rule)).toEqual([
      'rust-host-binding-nullability-unrepresented',
      'rust-host-binding-nullability-unrepresented',
    ]);
    expect(forward.map(({ message }) => message)).toEqual([
      expect.stringContaining('Blob (type)'),
      expect.stringContaining('VideoFrame (type)'),
    ]);
  });
});

describe('createCompilerRustRuntimeExternalSymbolBindingPlan', () => {
  it('publishes exact target and task-member spellings in deterministic symbol order', () => {
    const plan = createCompilerRustRuntimeExternalSymbolBindingPlan();
    const identities = plan.bindings.map(
      ({ externalSymbol }) => `${externalSymbol.sourceName}\u0000${externalSymbol.space}`,
    );

    expect(plan.contract).toBe('flight-runtime-contract/2');
    expect(plan.schema).toBe('flight-rust-runtime-external-symbol-bindings/1');
    expect(identities).toEqual([...identities].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)));
    expect(plan.bindings).toContainEqual({
      capability: 'task',
      externalSymbol: { sourceName: 'Promise', space: 'value' },
      kind: 'runtime',
      members: [{ sourceMember: 'resolve', targetName: 'FlightTask::ready' }],
      targetName: 'FlightTask',
    });
  });

  it('keeps downstream host ownership and nullability outside the compiler-owned symbol plan', () => {
    const plan = createCompilerRustRuntimeExternalSymbolBindingPlan();

    expect(plan.bindings).toHaveLength(50);
    expect(
      plan.bindings.some((binding) => Object.hasOwn(binding, 'ownership') || Object.hasOwn(binding, 'nullability')),
    ).toBe(false);
    expect(plan.bindings.some(({ externalSymbol }) => externalSymbol.sourceName === 'HTMLImageElement')).toBe(false);
  });

  it('returns independent nested manifest records', () => {
    const first = createCompilerRustRuntimeExternalSymbolBindingPlan();
    const second = createCompilerRustRuntimeExternalSymbolBindingPlan();
    const firstPromise = first.bindings.find(
      ({ externalSymbol }) => externalSymbol.sourceName === 'Promise' && externalSymbol.space === 'value',
    );
    const secondPromise = second.bindings.find(
      ({ externalSymbol }) => externalSymbol.sourceName === 'Promise' && externalSymbol.space === 'value',
    );
    if (!firstPromise?.members) throw new Error('expected the first Promise value member binding');

    (first.bindings as unknown[]).pop();
    (firstPromise.members as unknown[]).pop();
    expect(second.bindings).toHaveLength(50);
    expect(secondPromise?.members).toEqual([{ sourceMember: 'resolve', targetName: 'FlightTask::ready' }]);
  });
});

describe('getCompilerRuntimeExternalSymbolTargetRust', () => {
  it.each([
    ['Array', 'type', 'Vec'],
    ['Array', 'value', 'Vec'],
    ['ArrayLike', 'type', 'Vec'],
    ['ArrayBuffer', 'type', 'FlightArrayBuffer'],
    ['ArrayBuffer', 'value', 'FlightArrayBuffer'],
    ['Boolean', 'type', 'bool'],
    ['Date', 'type', 'FlightDate'],
    ['Date', 'value', 'FlightDate'],
    ['DataView', 'type', 'FlightDataView'],
    ['DataView', 'value', 'FlightDataView'],
    ['Error', 'type', 'Error'],
    ['Error', 'value', 'Error'],
    ['Float32Array', 'type', 'FlightFloat32Array'],
    ['Float32Array', 'value', 'FlightFloat32Array'],
    ['Float64Array', 'type', 'FlightFloat64Array'],
    ['Float64Array', 'value', 'FlightFloat64Array'],
    ['Int16Array', 'type', 'FlightInt16Array'],
    ['Int16Array', 'value', 'FlightInt16Array'],
    ['Int32Array', 'type', 'FlightInt32Array'],
    ['Int32Array', 'value', 'FlightInt32Array'],
    ['Int8Array', 'type', 'FlightInt8Array'],
    ['Int8Array', 'value', 'FlightInt8Array'],
    ['Map', 'type', 'std::collections::HashMap'],
    ['Map', 'value', 'std::collections::HashMap'],
    ['Promise', 'type', 'FlightTask'],
    ['Promise', 'value', 'FlightTask'],
    ['ReadonlyMap', 'type', 'std::collections::HashMap'],
    ['ReadonlySet', 'type', 'std::collections::HashSet'],
    ['Set', 'type', 'std::collections::HashSet'],
    ['Set', 'value', 'std::collections::HashSet'],
    ['String', 'type', 'String'],
    ['String', 'value', 'String'],
    ['Uint16Array', 'type', 'FlightUint16Array'],
    ['Uint16Array', 'value', 'FlightUint16Array'],
    ['Uint32Array', 'type', 'FlightUint32Array'],
    ['Uint32Array', 'value', 'FlightUint32Array'],
    ['Uint8Array', 'type', 'FlightUint8Array'],
    ['Uint8Array', 'value', 'FlightUint8Array'],
    ['Uint8ClampedArray', 'type', 'FlightUint8ClampedArray'],
    ['Uint8ClampedArray', 'value', 'FlightUint8ClampedArray'],
    ['WeakMap', 'type', 'std::collections::HashMap'],
    ['WeakMap', 'value', 'std::collections::HashMap'],
  ] as const)('maps %s in %s space to %s', (sourceName, space, targetName) => {
    expect(getCompilerRuntimeExternalSymbolTargetRust(sourceName, space)).toBe(targetName);
  });

  it('has no crossed-space or unknown fallback', () => {
    expect(getCompilerRuntimeExternalSymbolTargetRust('Boolean', 'value')).toBeUndefined();
    expect(getCompilerRuntimeExternalSymbolTargetRust('Unmapped', 'value')).toBeUndefined();
  });
});

describe('getCompilerRuntimeExternalMemberTargetRust', () => {
  it('maps source task normalization to the runtime ready constructor', () => {
    expect(getCompilerRuntimeExternalMemberTargetRust('Promise', 'resolve')).toBe('FlightTask::ready');
  });

  it('spells a namespace member whole, because the symbol has no target name of its own', () => {
    // `Math` is not a Rust type: `Math.max` is `f64::max` and there is nothing to call `Math`. A
    // binding that maps one symbol to one name cannot express that, which is why members are bound.
    expect(getCompilerRuntimeExternalMemberTargetRust('Math', 'max')).toBe('f64::max');
    expect(getCompilerRuntimeExternalMemberTargetRust('Math', 'abs')).toBe('f64::abs');
    expect(getCompilerRuntimeExternalMemberTargetRust('Math', 'sqrt')).toBe('f64::sqrt');
    expect(getCompilerRuntimeExternalMemberTargetRust('Math', 'pow')).toBe('f64::powf');
    expect(getCompilerRuntimeExternalMemberTargetRust('Math', 'ceil')).toBe('f64::ceil');
    expect(getCompilerRuntimeExternalMemberTargetRust('Math', 'round')).toBe('flight_runtime::round');
    expect(getCompilerRuntimeExternalMemberTargetRust('Math', 'atan2')).toBe('f64::atan2');
    expect(getCompilerRuntimeExternalMemberTargetRust('Math', 'hypot')).toBe('f64::hypot');
    expect(getCompilerRuntimeExternalMemberTargetRust('Math', 'log')).toBe('f64::ln');
  });

  it('claims nothing for an unbound member or an unbound symbol', () => {
    expect(getCompilerRuntimeExternalMemberTargetRust('Math', 'random')).toBeUndefined();
    expect(getCompilerRuntimeExternalMemberTargetRust('Array', 'from')).toBeUndefined();
    expect(getCompilerRuntimeExternalMemberTargetRust('Date', 'now')).toBeUndefined();
    expect(getCompilerRuntimeExternalMemberTargetRust('Promise', 'all')).toBeUndefined();
  });
});

describe('isCompilerRuntimeExternalSymbolProvidedRust', () => {
  it('separates a symbol the runtime crate defines from one Rust already has', () => {
    // `Promise` becomes a type the runtime provides and the module has to import; `Map` becomes
    // `std::collections::HashMap`, which is already in scope and must not be imported from it.
    expect(isCompilerRuntimeExternalSymbolProvidedRust('Promise', 'type')).toBe(true);
    expect(isCompilerRuntimeExternalSymbolProvidedRust('Uint8Array', 'type')).toBe(true);
    expect(isCompilerRuntimeExternalSymbolProvidedRust('Map', 'type')).toBe(false);
    expect(isCompilerRuntimeExternalSymbolProvidedRust('NotASymbol', 'type')).toBe(false);
  });
});
