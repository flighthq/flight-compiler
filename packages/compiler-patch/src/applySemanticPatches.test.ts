import type { IrFunctionDeclaration, IrModule, SemanticPatch } from '../../compiler-types/src/index.js';
import { applySemanticPatches, defineSemanticPatches } from './index.js';

function createModule(): IrModule {
  const declaration: IrFunctionDeclaration = {
    async: false,
    body: [],
    exported: true,
    kind: 'function',
    name: 'clamp',
    origin: {
      column: 1,
      fingerprint: 'sha256:clamp',
      line: 1,
      packageName: '@flighthq/math',
      source: 'packages/math/src/clamp.ts',
    },
    overloads: [],
    parameters: [],
    returns: { kind: 'primitive', name: 'number' },
    typeParameters: [],
  };
  return {
    declarations: [declaration],
    exports: [],
    imports: [],
    name: 'clamp',
    packageName: '@flighthq/math',
    source: 'packages/math/src/clamp.ts',
  };
}

function renamePatch(id: string, name: string, scope: SemanticPatch['scope']): SemanticPatch {
  return {
    expect: { fingerprint: 'sha256:clamp', kind: 'function' },
    id,
    name,
    operation: 'rename',
    reason: 'test',
    scope,
    target: { export: 'clamp', package: '@flighthq/math', source: 'packages/math/src/clamp.ts' },
  };
}

describe('semantic patches', () => {
  it('applies backend patches after neutral patches independent of patch identifiers', () => {
    const patches = defineSemanticPatches([
      renamePatch('zzz-neutral', 'neutralName', { kind: 'neutral' }),
      renamePatch('aaa-rust', 'rustName', { backend: 'rust', kind: 'backend' }),
    ]);

    const rust = applySemanticPatches([createModule()], patches, 'rust');
    const haxe = applySemanticPatches([createModule()], patches, 'haxe');

    expect(rust.modules[0]?.declarations[0]?.name).toBe('rustName');
    expect(rust.audit.applied.map((record) => record.id)).toEqual(['zzz-neutral', 'aaa-rust']);
    expect(haxe.modules[0]?.declarations[0]?.name).toBe('neutralName');
    expect(haxe.audit.summary).toEqual({ applied: 1, skipped: 1 });
  });

  it('rejects stale, unmatched, and conflicting patch identities', () => {
    const valid = renamePatch('math.clamp.rename', 'renamed', { kind: 'neutral' });
    const stale = { ...valid, expect: { ...valid.expect, fingerprint: 'sha256:stale' } };
    const unmatched = { ...valid, id: 'math.missing.rename', target: { ...valid.target, export: 'missing' } };
    const conflicting = renamePatch('math.clamp.rename-again', 'again', { kind: 'neutral' });

    expect(() => applySemanticPatches([createModule()], [stale], 'haxe')).toThrow('Stale semantic patch');
    expect(() => applySemanticPatches([createModule()], [unmatched], 'haxe')).toThrow('Unmatched semantic patch');
    expect(() => applySemanticPatches([createModule()], [valid, conflicting], 'haxe')).toThrow(
      'Conflicting semantic patches',
    );
  });
});
