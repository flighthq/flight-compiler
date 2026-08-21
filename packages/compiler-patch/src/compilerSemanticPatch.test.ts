import { fingerprintSourceText } from '../../compiler-provenance/src/index.js';
import type {
  IrDeclaration,
  IrFunctionDeclaration,
  IrModule,
  IrTypeAliasDeclaration,
  SemanticPatch,
  SemanticPatchFailure,
  SemanticPatchFailureCode,
} from '../../compiler-types/src/index.js';
import {
  analyzeSemanticPatchSet,
  applySemanticPatchSet,
  defineSemanticPatchSet,
  isSemanticPatchFailure,
} from './compilerSemanticPatch.js';

const packageName = '@flighthq/math';
const source = 'packages/math/src/clamp.ts';

describe('analyzeSemanticPatchSet', () => {
  it('previews ordered before-and-after snapshots and the exact application audit without returning modules', () => {
    const module = createModule();
    const patches: SemanticPatch[] = [
      {
        ...patchBase('03-rust', 'clamp', 'function'),
        name: 'rustName',
        operation: 'rename',
        scope: { backend: 'rust', kind: 'backend' },
      },
      {
        ...patchBase('02-body', 'clamp', 'function'),
        body: [{ expression: { kind: 'literal', value: 1 }, kind: 'return' }],
        operation: 'replaceBody',
        scope: { backend: 'haxe', kind: 'backend' },
      },
      renamePatch('01-rename', 'bounded', { kind: 'neutral' }),
    ];
    const moduleSnapshot = structuredClone(module);
    const patchSnapshot = structuredClone(patches);

    const analysis = analyzeSemanticPatchSet([module], patches, 'haxe');
    const applied = applySemanticPatchSet([module], patches, 'haxe');

    expect(analysis.schema).toBe('flight-compiler-patch-analysis/1');
    expect(analysis.audit).toEqual(applied.audit);
    expect(analysis.audit.skipped.map((record) => record.id)).toEqual(['03-rust']);
    expect(analysis.changes.map(({ patch }) => patch.id)).toEqual(['01-rename', '02-body']);
    expect(analysis.changes[0]).toMatchObject({
      after: { binding: { name: 'bounded' } },
      before: { binding: { name: 'clamp' } },
      patch: { operation: 'rename' },
    });
    expect(analysis.changes[1]).toMatchObject({
      after: { binding: { name: 'bounded' }, body: [{ kind: 'return' }] },
      before: { binding: { name: 'bounded' }, body: [] },
      patch: { operation: 'replaceBody' },
    });
    expect(analysis).not.toHaveProperty('modules');
    expect(analysis.changes[0]?.before).not.toBe(module.declarations[0]);
    expect(module).toEqual(moduleSnapshot);
    expect(patches).toEqual(patchSnapshot);
  });

  it('represents removal by omitting the after snapshot and shares tagged validation failures', () => {
    const remove: SemanticPatch = {
      ...patchBase('remove', 'clamp', 'function'),
      operation: 'remove',
    };
    const analysis = analyzeSemanticPatchSet([createModule()], [remove], 'haxe');

    expect(analysis.changes).toHaveLength(1);
    expect(analysis.changes[0]).not.toHaveProperty('after');
    expect(analysis.changes[0]?.before).toMatchObject({ binding: { name: 'clamp' } });
    expect(() => analyzeSemanticPatchSet([createModule()], [remove], '')).toThrowError(
      expect.objectContaining({ code: 'invalid-patch-backend', kind: 'semantic-patch' }),
    );
    expect(analyzeSemanticPatchSet([], [], 'haxe')).toEqual({
      audit: {
        applied: [],
        backend: 'haxe',
        schema: 'flight-compiler-patch-audit/2',
        skipped: [],
        summary: { applied: 0, skipped: 0 },
      },
      changes: [],
      schema: 'flight-compiler-patch-analysis/1',
    });
  });
});

describe('applySemanticPatchSet', () => {
  it('applies backend patches after neutral patches independent of patch identifiers', () => {
    const patches = defineSemanticPatchSet([
      renamePatch('zzz-neutral', 'neutralName', { kind: 'neutral' }),
      renamePatch('aaa-rust', 'rustName', { backend: 'rust', kind: 'backend' }),
    ]);

    const rust = applySemanticPatchSet([createModule()], patches, 'rust');
    const haxe = applySemanticPatchSet([createModule()], patches, 'haxe');

    expect(rust.modules[0]?.declarations[0]).toMatchObject({ binding: { name: 'rustName' } });
    expect(rust.audit.applied.map((record) => record.id)).toEqual(['zzz-neutral', 'aaa-rust']);
    expect(haxe.modules[0]?.declarations[0]).toMatchObject({ binding: { name: 'neutralName' } });
    expect(haxe.audit).toMatchObject({
      backend: 'haxe',
      schema: 'flight-compiler-patch-audit/2',
      skipped: [
        {
          fingerprint: patches[1].expect.fingerprint,
          id: 'aaa-rust',
          operation: 'rename',
          reason: 'test',
          scope: { backend: 'rust', kind: 'backend' },
          skipReason: 'backend-mismatch',
          target: patches[1].target,
        },
      ],
    });
    expect(haxe.audit.summary).toEqual({ applied: 1, skipped: 1 });
  });

  // Two targets differing only by backend must coexist: that is how one upstream declaration carries a
  // different correction per target. Mutating the scope key in validateConflicts collapses them into
  // one key and raises a false conflict, and nothing noticed until this case existed.
  it('lets two backends correct the same declaration without conflicting', () => {
    const patches = defineSemanticPatchSet([
      renamePatch('rust-rename', 'rustName', { backend: 'rust', kind: 'backend' }),
      renamePatch('haxe-rename', 'haxeName', { backend: 'haxe', kind: 'backend' }),
    ]);

    const rust = applySemanticPatchSet([createModule()], patches, 'rust');
    const haxe = applySemanticPatchSet([createModule()], patches, 'haxe');

    expect(rust.modules[0]?.declarations[0]).toMatchObject({ binding: { name: 'rustName' } });
    expect(rust.audit.summary).toEqual({ applied: 1, skipped: 1 });
    expect(rust.audit.skipped.map((record) => record.id)).toEqual(['haxe-rename']);
    expect(haxe.modules[0]?.declarations[0]).toMatchObject({ binding: { name: 'haxeName' } });
    expect(haxe.audit.summary).toEqual({ applied: 1, skipped: 1 });
    expect(haxe.audit.skipped.map((record) => record.id)).toEqual(['rust-rename']);
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
        ...patchBase('04-type', 'Range', 'typeAlias'),
        operation: 'replaceType',
        type: { kind: 'primitive', name: 'string' },
      },
    ]);

    const result = applySemanticPatchSet([module], patches, 'haxe');
    const declarations = result.modules[0]?.declarations;

    expect(declarations?.map(declarationName)).toEqual(['bounded', 'Range']);
    expect(declarations?.[0]).toMatchObject({
      body: [{ expression: { kind: 'literal', value: 1 }, kind: 'return' }],
      kind: 'function',
    });
    expect(declarations?.[1]).toMatchObject({ kind: 'typeAlias', type: { kind: 'primitive', name: 'string' } });
    expect(result.audit.applied.map((record) => record.id)).toEqual(['01-body', '02-rename', '03-remove', '04-type']);
    expect(result.audit.summary).toEqual({ applied: 4, skipped: 0 });
    expect(result.audit.skipped).toEqual([]);
    const bodyPatch = patches.find((patch) => patch.id === '01-body');
    expect(result.audit.applied[0]?.scope).not.toBe(bodyPatch?.scope);
    expect(result.audit.applied[0]?.target).not.toBe(bodyPatch?.target);
    expect(module.declarations.map(declarationName)).toEqual(['clamp', 'Range', 'obsolete']);
    expect((module.declarations[0] as IrFunctionDeclaration).body).toEqual([]);
    expect((module.declarations[1] as IrTypeAliasDeclaration).type).toEqual({ kind: 'primitive', name: 'number' });
  });

  it('orders same-scope patch identities by code unit rather than host locale', () => {
    const declarations = ['first', 'second', 'third'].map(createFunctionDeclaration);
    const patches: SemanticPatch[] = [
      { ...patchBase('é-third', 'third', 'function'), name: 'thirdPatched', operation: 'rename' },
      { ...patchBase('a-second', 'second', 'function'), name: 'secondPatched', operation: 'rename' },
      { ...patchBase('Z-first', 'first', 'function'), name: 'firstPatched', operation: 'rename' },
    ];

    const result = applySemanticPatchSet([createModule(declarations)], patches, 'haxe');

    expect(result.audit.applied.map((record) => record.id)).toEqual(['Z-first', 'a-second', 'é-third']);
    expect(result.modules[0]?.declarations.map(declarationName)).toEqual([
      'firstPatched',
      'secondPatched',
      'thirdPatched',
    ]);
  });

  it('records skipped patches deterministically without retaining caller-owned records', () => {
    const patches: SemanticPatch[] = [
      {
        ...patchBase('é-range', 'Range', 'typeAlias'),
        name: 'Span',
        operation: 'rename',
        scope: { backend: 'rust', kind: 'backend' },
      },
      renamePatch('Z-clamp', 'bounded', { backend: 'rust', kind: 'backend' }),
    ];
    const snapshot = structuredClone(patches);
    const forward = applySemanticPatchSet([createModule()], patches, 'haxe');
    const reverse = applySemanticPatchSet([createModule()], [...patches].reverse(), 'haxe');

    expect(forward.audit.skipped.map((record) => record.id)).toEqual(['Z-clamp', 'é-range']);
    expect(reverse.audit.skipped).toEqual(forward.audit.skipped);
    expect(forward.audit.summary).toEqual({ applied: 0, skipped: 2 });
    expect(forward.audit.skipped[0]?.scope).not.toBe(patches[1]?.scope);
    expect(forward.audit.skipped[0]?.target).not.toBe(patches[1]?.target);
    expect(patches).toEqual(snapshot);
  });

  it('renames a binding introduction without rewriting source-backed reference identity', () => {
    const declaration = createFunctionDeclaration('clamp');
    const module = createModule([
      {
        ...declaration,
        body: [
          {
            expression: { kind: 'identifier', reference: { binding: declaration.binding, kind: 'binding' } },
            kind: 'return',
          },
        ],
      },
    ]);
    const result = applySemanticPatchSet(
      [module],
      [renamePatch('math.clamp.rename', 'bounded', { kind: 'neutral' })],
      'haxe',
    );
    const renamed = result.modules[0]?.declarations[0];

    if (renamed?.kind !== 'function' || renamed.body[0]?.kind !== 'return') {
      throw new Error('Expected renamed function');
    }
    expect(renamed.binding).toMatchObject({ id: declaration.binding.id, name: 'bounded' });
    expect(renamed.body[0].expression).toMatchObject({
      reference: { binding: { id: declaration.binding.id, name: 'clamp' }, kind: 'binding' },
    });
    expect(module.declarations[0]).toMatchObject({ binding: { name: 'clamp' } });
  });

  it('renames type-space introductions without rewriting source-backed type references', () => {
    const declaration = createTypeDeclaration('Range');
    const module = createModule([
      {
        ...declaration,
        type: {
          kind: 'named',
          reference: { binding: declaration.binding, kind: 'binding', path: [] },
          typeArguments: [],
        },
      },
    ]);
    const result = applySemanticPatchSet(
      [module],
      [
        {
          ...patchBase('math.range.rename', 'Range', 'typeAlias'),
          name: 'Span',
          operation: 'rename',
        },
      ],
      'haxe',
    );
    const renamed = result.modules[0]?.declarations[0];

    if (renamed?.kind !== 'typeAlias' || renamed.type.kind !== 'named') {
      throw new Error('Expected renamed type alias');
    }
    expect(renamed.binding).toMatchObject({ id: declaration.binding.id, name: 'Span', space: 'type' });
    expect(renamed.type.reference).toMatchObject({
      binding: { id: declaration.binding.id, name: 'Range', space: 'type' },
      kind: 'binding',
    });
    expect(module.declarations[0]).toMatchObject({ binding: { name: 'Range' } });
  });

  it('returns a tagged failure for every invalid identity or operation state', () => {
    const valid = renamePatch('math.clamp.rename', 'renamed', { kind: 'neutral' });
    const cases: Array<{
      backend?: string;
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
        code: 'invalid-patch-expectation',
        patches: [{ ...valid, expect: { ...valid.expect, fingerprint: 'sha256:invalid' } }],
      },
      {
        backend: ' ',
        code: 'invalid-patch-backend',
        patches: [valid],
      },
      {
        code: 'invalid-patch-expectation',
        patches: [{ ...valid, expect: null } as unknown as SemanticPatch],
      },
      {
        code: 'invalid-patch-expectation',
        patches: [{ ...valid, expect: { ...valid.expect, kind: 'invalid' } } as unknown as SemanticPatch],
      },
      {
        code: 'invalid-patch-id',
        patches: [{ ...valid, id: ' ' }],
      },
      {
        code: 'invalid-patch-id',
        patches: [undefined as unknown as SemanticPatch],
      },
      {
        code: 'invalid-patch-operation',
        patches: [{ ...valid, name: ' ', operation: 'rename' }],
      },
      {
        code: 'invalid-patch-operation',
        patches: [{ ...valid, body: undefined, operation: 'replaceBody' } as unknown as SemanticPatch],
      },
      {
        code: 'invalid-patch-operation',
        patches: [{ ...valid, operation: 'replaceType', type: null } as unknown as SemanticPatch],
      },
      {
        code: 'invalid-patch-reason',
        patches: [{ ...valid, reason: '' }],
      },
      {
        code: 'invalid-patch-scope',
        patches: [{ ...valid, scope: { backend: '', kind: 'backend' } }],
      },
      {
        code: 'invalid-patch-target',
        patches: [{ ...valid, target: { ...valid.target, exportName: '' } }],
      },
      {
        code: 'invalid-patch-target',
        patches: [{ ...valid, target: { ...valid.target, packageName: '' } }],
      },
      {
        code: 'invalid-patch-target',
        patches: [{ ...valid, target: { ...valid.target, source: '' } }],
      },
      {
        code: 'invalid-patch-target',
        patches: [{ ...valid, target: null } as unknown as SemanticPatch],
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
        patches: [{ ...valid, expect: { ...valid.expect, kind: 'typeAlias' } }],
      },
      {
        code: 'stale-patch-fingerprint',
        patches: [{ ...valid, expect: { ...valid.expect, fingerprint: fingerprintSourceText('stale') } }],
      },
      {
        code: 'unmatched-patch-target',
        patches: [{ ...valid, target: { ...valid.target, exportName: 'missing' } }],
      },
    ];

    for (const fixture of cases) {
      const failure = captureFailure(fixture.modules ?? [createModule()], fixture.patches, fixture.backend);
      expect(failure).toMatchObject({
        code: fixture.code,
        kind: 'semantic-patch',
        name: 'SemanticPatchError',
      });
      if (fixture.code === 'invalid-patch-backend' || fixture.code === 'invalid-patch-id') {
        expect(failure.patchIds).toEqual([]);
      } else expect(failure.patchIds.length).toBeGreaterThan(0);
      expect(failure.subject.length).toBeGreaterThan(0);
    }
  });

  it('reports conflicts deterministically regardless of input order', () => {
    const first = renamePatch('Z-first', 'first', { kind: 'neutral' });
    const second = renamePatch('é-second', 'second', { kind: 'neutral' });

    const forward = captureFailure([createModule()], [first, second]);
    const reverse = captureFailure([createModule()], [second, first]);

    expect(reverse.code).toBe('conflicting-patch-operation');
    expect(reverse.message).toBe(forward.message);
    expect(reverse.patchIds).toEqual(forward.patchIds);
    expect(reverse.patchIds).toEqual(['Z-first', 'é-second']);
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

function captureFailure(modules: IrModule[], patches: SemanticPatch[], backend = 'haxe'): SemanticPatchFailure {
  try {
    applySemanticPatchSet(modules, patches, backend);
    throw new Error('Expected semantic patch application to fail');
  } catch (error) {
    if (!isSemanticPatchFailure(error)) throw error;
    return error;
  }
}

function createFunctionDeclaration(name: string): IrFunctionDeclaration {
  return {
    async: false,
    binding: {
      column: 1,
      fingerprint: fingerprintSourceText(name),
      id: `binding:[${JSON.stringify(packageName)},${JSON.stringify(source)},${JSON.stringify(name)}]`,
      kind: 'function',
      line: 1,
      name,
      packageName,
      scope: 'module',
      space: 'value',
      source,
    },
    body: [],
    exported: true,
    kind: 'function',
    origin: {
      column: 1,
      fingerprint: fingerprintSourceText(name),
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

function declarationName(declaration: Readonly<IrDeclaration>): string {
  if (declaration.kind === 'variable' && 'pattern' in declaration) throw new TypeError('expected a named declaration');
  return declaration.binding.name;
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

function createTypeDeclaration(name: string): IrTypeAliasDeclaration {
  return {
    binding: {
      column: 1,
      fingerprint: fingerprintSourceText(name),
      id: `type-binding:[${JSON.stringify(packageName)},${JSON.stringify(source)},${JSON.stringify(name)}]`,
      kind: 'typeAlias',
      line: 1,
      name,
      packageName,
      scope: 'module',
      source,
      space: 'type',
    },
    exported: true,
    kind: 'typeAlias',
    origin: {
      column: 1,
      fingerprint: fingerprintSourceText(name),
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
    expect: { fingerprint: fingerprintSourceText(exportName), kind },
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
