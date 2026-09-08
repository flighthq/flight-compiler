import type { IrBindingIdentity, IrExport, IrModule } from '../../compiler-types/src/index.js';
import { createCompilerModuleFacadeIdentities, isCompilerModuleFacadeFailure } from './compilerModuleFacadeIdentity.js';

function createBinding(id = 'binding:value'): IrBindingIdentity {
  return {
    column: 1,
    fingerprint: 'sha256:value',
    id,
    kind: 'variable',
    line: 1,
    name: 'value',
    packageName: '@flighthq/math',
    scope: 'module',
    source: 'packages/math/src/barrel.ts',
    space: 'value',
  };
}

function createModule(exports: readonly IrExport[], changes: Partial<IrModule> = {}): IrModule {
  return {
    declarations: [],
    exports,
    imports: [],
    name: 'Barrel',
    packageName: '@flighthq/math',
    source: 'packages/math/src/barrel.ts',
    ...changes,
  };
}

describe('createCompilerModuleFacadeIdentities', () => {
  it('creates immutable identities for every facade topology without changing its module', () => {
    const module = createModule([
      { kind: 'all', specifier: './all.js', typeOnly: false },
      { exported: 'renamed', imported: 'source', kind: 'reexport', specifier: './named.js', typeOnly: false },
      { exported: 'namespace', kind: 'namespace', specifier: './namespace.js', typeOnly: false },
      { binding: createBinding(), exported: 'local', kind: 'local', typeOnly: false },
      { binding: createBinding('binding:type'), exported: 'Type', kind: 'local', typeOnly: true },
      { expression: { kind: 'literal', value: 1 }, kind: 'default' },
    ]);
    const snapshot = structuredClone(module);

    const identities = createCompilerModuleFacadeIdentities(module);

    expect(identities.map(({ exportName, lane, source }) => ({ exportName, lane, source }))).toEqual(
      expect.arrayContaining([
        { exportName: '*', lane: 'value', source: { kind: 'module-all', specifier: './all.js' } },
        { exportName: 'Type', lane: 'type', source: { bindingId: 'binding:type', kind: 'local-binding' } },
        { exportName: 'default', lane: 'value', source: { kind: 'local-expression' } },
        { exportName: 'local', lane: 'value', source: { bindingId: 'binding:value', kind: 'local-binding' } },
        { exportName: 'namespace', lane: 'value', source: { kind: 'module-namespace', specifier: './namespace.js' } },
        {
          exportName: 'renamed',
          lane: 'value',
          source: { imported: 'source', kind: 'module-binding', specifier: './named.js' },
        },
      ]),
    );
    expect(identities.every((identity) => identity.identity.startsWith('module-facade:'))).toBe(true);
    expect(identities.map((identity) => identity.identity)).toEqual(
      [...identities].map((identity) => identity.identity).sort(),
    );
    expect(Object.isFrozen(identities)).toBe(true);
    expect(identities.every(Object.isFrozen)).toBe(true);
    expect(identities.every((identity) => Object.isFrozen(identity.module) && Object.isFrozen(identity.source))).toBe(
      true,
    );
    expect(module).toEqual(snapshot);
  });

  it('is independent of export order and host path separators', () => {
    const exports: IrExport[] = [
      { exported: 'second', imported: 'value', kind: 'reexport', specifier: './second.js', typeOnly: false },
      { exported: 'first', kind: 'namespace', specifier: './first.js', typeOnly: false },
    ];
    const posix = createModule(exports);
    const windows = createModule([...exports].reverse(), { source: 'packages\\math\\src\\barrel.ts' });

    expect(createCompilerModuleFacadeIdentities(posix)).toEqual(createCompilerModuleFacadeIdentities(windows));
  });

  it('identifies public slots independently of their current local or remote implementation route', () => {
    const local = createCompilerModuleFacadeIdentities(
      createModule([{ binding: createBinding(), exported: 'value', kind: 'local', typeOnly: false }]),
    )[0]!;
    const reexported = createCompilerModuleFacadeIdentities(
      createModule([
        { exported: 'value', imported: 'renamed', kind: 'reexport', specifier: './remote.js', typeOnly: false },
      ]),
    )[0]!;
    const namespaced = createCompilerModuleFacadeIdentities(
      createModule([{ exported: 'value', kind: 'namespace', specifier: './remote.js', typeOnly: false }]),
    )[0]!;
    const localDefault = createCompilerModuleFacadeIdentities(
      createModule([{ binding: createBinding(), exported: 'default', kind: 'local', typeOnly: false }]),
    )[0]!;
    const expressionDefault = createCompilerModuleFacadeIdentities(
      createModule([{ expression: { kind: 'literal', value: 1 }, kind: 'default' }]),
    )[0]!;

    expect(local.identity).toBe(reexported.identity);
    expect(local.identity).toBe(namespaced.identity);
    expect(localDefault.identity).toBe(expressionDefault.identity);
    expect(local.source).not.toEqual(reexported.source);
  });

  it('separates modules, type and value lanes, and distinct star-export sources', () => {
    const lanes = createCompilerModuleFacadeIdentities(
      createModule([
        { binding: createBinding(), exported: 'Value', kind: 'local', typeOnly: false },
        { binding: createBinding('binding:type'), exported: 'Value', kind: 'local', typeOnly: true },
      ]),
    );
    const stars = createCompilerModuleFacadeIdentities(
      createModule([
        { kind: 'all', specifier: './first.js', typeOnly: false },
        { kind: 'all', specifier: './second.js', typeOnly: false },
      ]),
    );
    const typeOnly = createCompilerModuleFacadeIdentities(
      createModule([
        { kind: 'all', specifier: './types.js', typeOnly: true },
        { exported: 'Namespace', kind: 'namespace', specifier: './namespace.js', typeOnly: true },
        { exported: 'Remote', imported: 'Type', kind: 'reexport', specifier: './remote.js', typeOnly: true },
      ]),
    );
    const otherModule = createCompilerModuleFacadeIdentities(
      createModule([{ binding: createBinding(), exported: 'Value', kind: 'local', typeOnly: false }], {
        name: 'Other',
        source: 'packages/math/src/other.ts',
      }),
    );

    expect(new Set(lanes.map((identity) => identity.identity)).size).toBe(2);
    expect(new Set(stars.map((identity) => identity.identity)).size).toBe(2);
    expect(typeOnly.every((identity) => identity.lane === 'type')).toBe(true);
    expect(lanes.find((identity) => identity.lane === 'value')?.identity).not.toBe(otherModule[0]?.identity);
  });

  it('rejects duplicate named public slots and duplicate star sources deterministically', () => {
    const named = createModule([
      { binding: createBinding(), exported: 'value', kind: 'local', typeOnly: false },
      { exported: 'value', imported: 'remote', kind: 'reexport', specifier: './remote.js', typeOnly: false },
    ]);
    const stars = createModule([
      { kind: 'all', specifier: './remote.js', typeOnly: false },
      { kind: 'all', specifier: './remote.js', typeOnly: false },
    ]);

    for (const module of [named, { ...named, exports: [...named.exports].reverse() }, stars]) {
      expect(() => createCompilerModuleFacadeIdentities(module)).toThrow(
        expect.objectContaining({ code: 'duplicate-facade-identity', kind: 'compiler-module-facade' }),
      );
    }
  });

  it('rejects malformed module and export records through stable subjects', () => {
    const invalidModules: IrModule[] = [
      createModule([], { name: '' }),
      createModule([], { name: 1 as never }),
      createModule([], { packageName: '' }),
      createModule([], { packageName: 1 as never }),
      createModule([], { source: '' }),
      createModule([], { source: 1 as never }),
      createModule([], { exports: null as never }),
    ];
    expect(() => createCompilerModuleFacadeIdentities(null as never)).toThrow(
      expect.objectContaining({ code: 'invalid-facade-module' }),
    );
    expect(() => createCompilerModuleFacadeIdentities(42 as never)).toThrow(
      expect.objectContaining({ code: 'invalid-facade-module' }),
    );
    for (const module of invalidModules) {
      expect(() => createCompilerModuleFacadeIdentities(module)).toThrow(
        expect.objectContaining({ code: 'invalid-facade-module', kind: 'compiler-module-facade' }),
      );
    }

    const malformed: unknown[] = [
      null,
      1,
      'export',
      [],
      Object.assign([], { kind: 'all', specifier: './value.js', typeOnly: false }),
      {},
      { kind: 'unknown' },
      { extra: true, kind: 'all', specifier: './value.js', typeOnly: false },
      { extra: true, kind: 'all', specifier: './value.js' },
      { kind: 'all', specifier: '', typeOnly: false },
      { kind: 'all', specifier: 1, typeOnly: false },
      { kind: 'all', specifier: './value.js', typeOnly: 'false' },
      { extra: true, expression: { kind: 'literal', value: 1 }, kind: 'default' },
      { expression: null, kind: 'default' },
      { expression: 1, kind: 'default' },
      { expression: [], kind: 'default' },
      { binding: {}, exported: 'value', kind: 'local', typeOnly: false },
      { binding: null, exported: 'value', kind: 'local', typeOnly: false },
      { binding: 'value', exported: 'value', kind: 'local', typeOnly: false },
      { binding: { id: '' }, exported: 'value', kind: 'local', typeOnly: false },
      { binding: createBinding(), exported: '', kind: 'local', typeOnly: false },
      { binding: createBinding(), exported: 1, kind: 'local', typeOnly: false },
      { binding: createBinding(), exported: 'value', kind: 'local', typeOnly: 'false' },
      { exported: '', kind: 'namespace', specifier: './value.js', typeOnly: false },
      { exported: 'value', kind: 'namespace', specifier: '', typeOnly: false },
      { exported: 1, kind: 'namespace', specifier: './value.js', typeOnly: false },
      { exported: 'value', kind: 'namespace', specifier: './value.js', typeOnly: 'false' },
      { exported: 'value', imported: '', kind: 'reexport', specifier: './value.js', typeOnly: false },
      { exported: 'value', imported: 1, kind: 'reexport', specifier: './value.js', typeOnly: false },
      { exported: 'value', imported: 'remote', kind: 'reexport', specifier: '', typeOnly: false },
      { exported: 'value', imported: 'remote', kind: 'reexport', specifier: './value.js', typeOnly: 'false' },
    ];
    for (const exported of malformed) {
      expect(() => createCompilerModuleFacadeIdentities(createModule([exported as IrExport]))).toThrow(
        expect.objectContaining({
          code: 'invalid-facade-export',
          kind: 'compiler-module-facade',
          subject: 'exports[0]',
        }),
      );
    }
  });
});

describe('isCompilerModuleFacadeFailure', () => {
  it('accepts every exact failure code and rejects malformed lookalikes', () => {
    const failures: unknown[] = [];
    const attempts = [
      () => createCompilerModuleFacadeIdentities(createModule([], { name: '' })),
      () => createCompilerModuleFacadeIdentities(createModule([null as never])),
      () =>
        createCompilerModuleFacadeIdentities(
          createModule([
            { binding: createBinding(), exported: 'value', kind: 'local', typeOnly: false },
            { exported: 'value', imported: 'value', kind: 'reexport', specifier: './value.js', typeOnly: false },
          ]),
        ),
    ];
    for (const attempt of attempts) {
      try {
        attempt();
      } catch (error) {
        failures.push(error);
      }
    }

    expect(failures).toHaveLength(attempts.length);
    expect(failures.every(isCompilerModuleFacadeFailure)).toBe(true);
    expect(isCompilerModuleFacadeFailure(new Error('ordinary'))).toBe(false);
    const exact = { code: 'invalid-facade-export', kind: 'compiler-module-facade', subject: 'exports[0]' } as const;
    expect(isCompilerModuleFacadeFailure(exact)).toBe(false);
    expect(isCompilerModuleFacadeFailure(Object.assign(new Error('lookalike'), exact, { code: 'unknown' }))).toBe(
      false,
    );
    expect(isCompilerModuleFacadeFailure(Object.assign(new Error('lookalike'), exact, { subject: 1 }))).toBe(false);
    expect(isCompilerModuleFacadeFailure(Object.assign(new Error('lookalike'), exact, { subject: '' }))).toBe(false);
  });
});
