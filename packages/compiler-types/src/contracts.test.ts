import type { CompilerBackend, IrModule, SemanticPatch } from './index.js';

describe('compiler contracts', () => {
  it('represent modules, patches, and backends as plain data and functions', () => {
    const module: IrModule = {
      declarations: [],
      exports: [],
      imports: [],
      name: 'value',
      packageName: '@flighthq/math',
      source: 'packages/math/src/value.ts',
    };
    const patch: SemanticPatch = {
      expect: { fingerprint: 'sha256:value', kind: 'function' },
      id: 'math.value.remove',
      operation: 'remove',
      reason: 'contract fixture',
      scope: { kind: 'neutral' },
      target: { exportName: 'value', packageName: '@flighthq/math', source: module.source },
    };
    const backend: CompilerBackend = {
      emitModule: () => [],
      name: 'fixture',
    };

    expect(module).toMatchObject({ name: 'value', packageName: '@flighthq/math' });
    expect(patch).toMatchObject({ id: 'math.value.remove', operation: 'remove' });
    expect(backend.emitModule(module, { modules: [module], options: {} })).toEqual([]);
  });
});
