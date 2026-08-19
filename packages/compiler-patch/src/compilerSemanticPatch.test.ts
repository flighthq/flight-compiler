import type {
  IrDeclaration,
  IrFunctionDeclaration,
  IrModule,
  IrTypeDeclaration,
  SemanticPatch,
  SemanticPatchFailure,
  SemanticPatchFailureCode,
} from '../../compiler-types/src/index.js';
import { applySemanticPatchSet, defineSemanticPatchSet, isSemanticPatchFailure } from './compilerSemanticPatch.js';

const packageName = '@flighthq/math';
const source = 'packages/math/src/clamp.ts';

describe('applySemanticPatchSet', () => {
  it('applies backend patches after neutral patches independent of patch identifiers', () => {
    const patches = defineSemanticPatchSet([
      renamePatch('zzz-neutral', 'neutralName', { kind: 'neutral' }),
      renamePatch('aaa-rust', 'rustName', { backend: 'rust', kind: 'backend' }),
    ]);

    const rust = applySemanticPatchSet([createModule()], patches, 'rust');
    const haxe = applySemanticPatchSet([createModule()], patches, 'haxe');

    expect(rust.modules[0]?.declarations[0]?.name).toBe('rustName');
    expect(rust.audit.applied.map((record) => record.id)).toEqual(['zzz-neutral', 'aaa-rust']);
    expect(haxe.modules[0]?.declarations[0]?.name).toBe('neutralName');
    expect(haxe.audit.summary).toEqual({ applied: 1, skipped: 1 });
  });

  it('applies every operation deterministically without mutating caller-owned input', () => {
    const module = createModule([
      createFunctionDeclaration('clamp'),
      createTypeDeclaration('Range'),
      createFunctionDeclaration('obsolete'),
    ]);
    const patches = defineSemanticPatchSet([
      {
        ...patchBase('03-remove', 'obsolete', 'function'),
        operation: 'remove',
      },
      {
        ...patchBase('01-body', 'clamp', 'function'),
        body: [{ expression: { kind: 'literal', value: 1 }, kind: 'return' }],
        operation: 'replaceBody',
      },
      renamePatch('02-rename', 'bounded', { kind: 'neutral' }),
      {
        ...patchBase('04-type', 'Range', 'type'),
        operation: 'replaceType',
        type: { kind: 'primitive', name: 'string' },
      },
    ]);

    const result = applySemanticPatchSet([module], patches, 'haxe');
    const declarations = result.modules[0]?.declarations;

    expect(declarations?.map((declaration) => declaration.name)).toEqual(['bounded', 'Range']);
    expect(declarations?.[0]).toMatchObject({
      body: [{ expression: { kind: 'literal', value: 1 }, kind: 'return' }],
      kind: 'function',
    });
    expect(declarations?.[1]).toMatchObject({ kind: 'type', type: { kind: 'primitive', name: 'string' } });
    expect(result.audit.applied.map((record) => record.id)).toEqual(['01-body', '02-rename', '03-remove', '04-type']);
    expect(result.audit.summary).toEqual({ applied: 4, skipped: 0 });
    const bodyPatch = patches.find((patch) => patch.id === '01-body');
    expect(result.audit.applied[0]?.scope).not.toBe(bodyPatch?.scope);
    expect(result.audit.applied[0]?.target).not.toBe(bodyPatch?.target);
    expect(module.declarations.map((declaration) => declaration.name)).toEqual(['clamp', 'Range', 'obsolete']);
    expect((module.declarations[0] as IrFunctionDeclaration).body).toEqual([]);
    expect((module.declarations[1] as IrTypeDeclaration).type).toEqual({ kind: 'primitive', name: 'number' });
  });

  it('returns a tagged failure for every invalid identity or operation state', () => {
    const valid = renamePatch('math.clamp.rename', 'renamed', { kind: 'neutral' });
    const cases: Array<{
      code: SemanticPatchFailureCode;
      modules?: IrModule[];
      patches: SemanticPatch[];
    }> = [
      {
        code: 'ambiguous-patch-target',
        modules: [createModule(), { ...createModule(), name: 'Other' }],
        patches: [valid],
      },
      {
        code: 'conflicting-patch-operation',
        patches: [valid, renamePatch('math.clamp.rename-again', 'again', { kind: 'neutral' })],
      },
      {
        code: 'conflicting-patch-removal',
        patches: [
          valid,
          {
            ...patchBase('math.clamp.remove', 'clamp', 'function'),
            operation: 'remove',
          },
        ],
      },
      {
        code: 'duplicate-patch-id',
        patches: [valid, renamePatch('math.clamp.rename', 'again', { kind: 'neutral' })],
      },
      {
        code: 'incompatible-patch-operation',
        patches: [
          {
            ...patchBase('math.clamp.type', 'clamp', 'function'),
            operation: 'replaceType',
            type: { kind: 'primitive', name: 'string' },
          },
        ],
      },
      {
        code: 'patch-kind-mismatch',
        patches: [{ ...valid, expect: { fingerprint: 'sha256:clamp', kind: 'type' } }],
      },
      {
        code: 'stale-patch-fingerprint',
        patches: [{ ...valid, expect: { ...valid.expect, fingerprint: 'sha256:stale' } }],
      },
      {
        code: 'unmatched-patch-target',
        patches: [{ ...valid, target: { ...valid.target, exportName: 'missing' } }],
      },
    ];

    for (const fixture of cases) {
      const failure = captureFailure(fixture.modules ?? [createModule()], fixture.patches);
      expect(failure).toMatchObject({
        code: fixture.code,
        kind: 'semantic-patch',
        name: 'SemanticPatchError',
      });
      expect(failure.patchIds.length).toBeGreaterThan(0);
      expect(failure.subject.length).toBeGreaterThan(0);
    }
  });

  it('reports conflicts deterministically regardless of input order', () => {
    const first = renamePatch('a-first', 'first', { kind: 'neutral' });
    const second = renamePatch('z-second', 'second', { kind: 'neutral' });

    const forward = captureFailure([createModule()], [first, second]);
    const reverse = captureFailure([createModule()], [second, first]);

    expect(reverse.code).toBe('conflicting-patch-operation');
    expect(reverse.message).toBe(forward.message);
    expect(reverse.patchIds).toEqual(forward.patchIds);
  });
});

describe('defineSemanticPatchSet', () => {
  it('preserves the exact caller-owned patch tuple without allocation or mutation', () => {
    const patches = [renamePatch('math.clamp.rename', 'bounded', { kind: 'neutral' })] as const;

    expect(defineSemanticPatchSet(patches)).toBe(patches);
    expect(patches[0]).toMatchObject({ name: 'bounded', operation: 'rename' });
  });
});

describe('isSemanticPatchFailure', () => {
  it('accepts produced failures and rejects malformed tagged lookalikes', () => {
    const valid = captureFailure([], [renamePatch('math.clamp.rename', 'bounded', { kind: 'neutral' })]);
    const unknownCode = Object.assign(new Error('forged patch failure'), {
      code: 'future-code',
      kind: 'semantic-patch',
      patchIds: ['fixture'],
      subject: 'fixture',
    });
    const malformedIds = Object.assign(new Error('forged patch failure'), {
      code: 'duplicate-patch-id',
      kind: 'semantic-patch',
      patchIds: [1],
      subject: 'fixture',
    });
    const internalInvariant = Object.assign(new Error('forged patch failure'), {
      code: 'patch-index-desynchronized',
      kind: 'semantic-patch',
      patchIds: ['fixture'],
      subject: 'fixture',
    });

    expect(isSemanticPatchFailure(valid)).toBe(true);
    expect(isSemanticPatchFailure(internalInvariant)).toBe(true);
    expect(isSemanticPatchFailure(unknownCode)).toBe(false);
    expect(isSemanticPatchFailure(malformedIds)).toBe(false);
  });
});

function captureFailure(modules: IrModule[], patches: SemanticPatch[]): SemanticPatchFailure {
  try {
    applySemanticPatchSet(modules, patches, 'haxe');
    throw new Error('Expected semantic patch application to fail');
  } catch (error) {
    if (!isSemanticPatchFailure(error)) throw error;
    return error;
  }
}

function createFunctionDeclaration(name: string): IrFunctionDeclaration {
  return {
    async: false,
    body: [],
    exported: true,
    kind: 'function',
    name,
    origin: {
      column: 1,
      fingerprint: `sha256:${name}`,
      line: 1,
      packageName,
      source,
    },
    overloads: [],
    parameters: [],
    returns: { kind: 'primitive', name: 'number' },
    typeParameters: [],
  };
}

function createModule(declarations: IrDeclaration[] = [createFunctionDeclaration('clamp')]): IrModule {
  return {
    declarations,
    exports: [],
    imports: [],
    name: 'Clamp',
    packageName,
    source,
  };
}

function createTypeDeclaration(name: string): IrTypeDeclaration {
  return {
    exported: true,
    kind: 'type',
    name,
    origin: {
      column: 1,
      fingerprint: `sha256:${name}`,
      line: 1,
      packageName,
      source,
    },
    type: { kind: 'primitive', name: 'number' },
    typeParameters: [],
  };
}

function patchBase(
  id: string,
  exportName: string,
  kind: SemanticPatch['expect']['kind'],
): Pick<SemanticPatch, 'expect' | 'id' | 'reason' | 'scope' | 'target'> {
  return {
    expect: { fingerprint: `sha256:${exportName}`, kind },
    id,
    reason: 'test',
    scope: { kind: 'neutral' },
    target: { exportName, packageName, source },
  };
}

function renamePatch(id: string, name: string, scope: SemanticPatch['scope']): SemanticPatch {
  return {
    ...patchBase(id, 'clamp', 'function'),
    name,
    operation: 'rename',
    scope,
  };
}
