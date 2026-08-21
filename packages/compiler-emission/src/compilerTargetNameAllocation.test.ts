import type { IrBindingIdentity } from '../../compiler-types/src/index.js';
import { isCompilerInvariantFailure } from './compilerSourceEmission.js';
import {
  createCompilerTargetNameAllocation,
  createIrModuleTargetNameAllocation,
  isCompilerTargetNameAllocationFailure,
} from './compilerTargetNameAllocation.js';

describe('createCompilerTargetNameAllocation', () => {
  it('allocates collisions deterministically without consuming another preferred name', () => {
    const candidates = [
      { disposition: 'renamable' as const, identity: 'third', preferredName: 'value_2', scope: 'module' },
      { disposition: 'renamable' as const, identity: 'second', preferredName: 'value', scope: 'module' },
      { disposition: 'renamable' as const, identity: 'first', preferredName: 'value', scope: 'module' },
    ];

    expect(createCompilerTargetNameAllocation(candidates)).toEqual([
      { identity: 'first', name: 'value', scope: 'module' },
      { identity: 'second', name: 'value_3', scope: 'module' },
      { identity: 'third', name: 'value_2', scope: 'module' },
    ]);
    expect(createCompilerTargetNameAllocation([...candidates].reverse())).toEqual(
      createCompilerTargetNameAllocation(candidates),
    );
    expect(candidates).toEqual([
      { disposition: 'renamable', identity: 'third', preferredName: 'value_2', scope: 'module' },
      { disposition: 'renamable', identity: 'second', preferredName: 'value', scope: 'module' },
      { disposition: 'renamable', identity: 'first', preferredName: 'value', scope: 'module' },
    ]);
  });

  it('preserves a fixed target name and renames an internal collision independently of input order', () => {
    const candidates = [
      { disposition: 'renamable' as const, identity: 'internal', preferredName: 'value', scope: 'module' },
      { disposition: 'fixed' as const, identity: 'public', preferredName: 'value', scope: 'module' },
    ];
    const expected = [
      { identity: 'internal', name: 'value_2', scope: 'module' },
      { identity: 'public', name: 'value', scope: 'module' },
    ];

    expect(createCompilerTargetNameAllocation(candidates)).toEqual(expected);
    expect(createCompilerTargetNameAllocation([...candidates].reverse())).toEqual(expected);
  });

  it('refuses canonically equivalent fixed target names with deterministic identities', () => {
    const candidates = [
      { disposition: 'fixed' as const, identity: 'second', preferredName: 'cafe\u0301', scope: 'module' },
      { disposition: 'fixed' as const, identity: 'first', preferredName: 'caf\u00e9', scope: 'module' },
    ];

    try {
      createCompilerTargetNameAllocation(candidates);
      expect.unreachable('Expected fixed target names to collide');
    } catch (error) {
      expect(isCompilerTargetNameAllocationFailure(error)).toBe(true);
      expect(error).toMatchObject({
        code: 'fixed-target-name-collision',
        identities: ['first', 'second'],
        kind: 'target-name-allocation',
        name: 'CompilerTargetNameAllocationError',
        scope: 'module',
        targetName: 'caf\u00e9',
      });
    }
    expect(candidates[0]?.preferredName).toBe('cafe\u0301');
  });

  it('keeps the same preferred spelling independent across target scopes', () => {
    expect(
      createCompilerTargetNameAllocation([
        { disposition: 'renamable', identity: 'local', preferredName: 'value', scope: 'function' },
        { disposition: 'renamable', identity: 'module', preferredName: 'value', scope: 'module' },
      ]),
    ).toEqual([
      { identity: 'local', name: 'value', scope: 'function' },
      { identity: 'module', name: 'value', scope: 'module' },
    ]);
  });

  it('normalizes canonically equivalent target spellings before collision allocation', () => {
    expect(
      createCompilerTargetNameAllocation([
        { disposition: 'renamable', identity: 'decomposed', preferredName: 'cafe\u0301', scope: 'module' },
        { disposition: 'renamable', identity: 'composed', preferredName: 'caf\u00e9', scope: 'module' },
      ]),
    ).toEqual([
      { identity: 'composed', name: 'caf\u00e9', scope: 'module' },
      { identity: 'decomposed', name: 'caf\u00e9_2', scope: 'module' },
    ]);
  });

  it.each([
    {
      code: 'duplicate-target-name-identity',
      input: [
        { disposition: 'renamable' as const, identity: 'same', preferredName: 'first', scope: 'module' },
        { disposition: 'renamable' as const, identity: 'same', preferredName: 'second', scope: 'module' },
      ],
      subject: 'same',
    },
    {
      code: 'invalid-target-name-candidate',
      input: [{ disposition: 'renamable' as const, identity: '', preferredName: 'value', scope: 'module' }],
      subject: 'value',
    },
    {
      code: 'invalid-target-name-candidate',
      input: [{ disposition: 'invalid' as never, identity: 'value', preferredName: 'value', scope: 'module' }],
      subject: 'value',
    },
    {
      code: 'invalid-target-name-candidate',
      input: [{ disposition: 'invalid' as never, identity: 'candidate', preferredName: 'value', scope: 'module' }],
      subject: 'candidate',
    },
    {
      code: 'invalid-target-name-candidate',
      input: [{ disposition: 'renamable' as const, identity: 'candidate', preferredName: '', scope: 'module' }],
      subject: 'candidate',
    },
    {
      code: 'invalid-target-name-candidate',
      input: [{ disposition: 'renamable' as const, identity: 'candidate', preferredName: 'value', scope: '' }],
      subject: 'candidate',
    },
    {
      code: 'invalid-target-name-candidate',
      input: [{ disposition: 'renamable' as const, identity: '', preferredName: '', scope: '' }],
      subject: '<empty>',
    },
  ])('fails invalid candidates with stable $code identity', ({ code, input, subject }) => {
    try {
      createCompilerTargetNameAllocation(input);
      expect.unreachable('Expected target name allocation to fail');
    } catch (error) {
      expect(isCompilerInvariantFailure(error)).toBe(true);
      expect(error).toMatchObject({ code, kind: 'compiler-invariant', subject });
    }
  });
});

describe('isCompilerTargetNameAllocationFailure', () => {
  it('accepts only complete tagged target-name allocation failures', () => {
    let failure: unknown;
    try {
      createCompilerTargetNameAllocation([
        { disposition: 'fixed', identity: 'first', preferredName: 'value', scope: 'module' },
        { disposition: 'fixed', identity: 'second', preferredName: 'value', scope: 'module' },
      ]);
    } catch (error) {
      failure = error;
    }

    if (!isCompilerTargetNameAllocationFailure(failure)) {
      throw new Error('Expected a target-name allocation failure fixture');
    }
    const changeFailure = (changes: Readonly<Record<string, unknown>>): Error =>
      Object.assign(new Error('changed'), failure, changes);

    expect(isCompilerTargetNameAllocationFailure(new Error('plain'))).toBe(false);
    expect(isCompilerTargetNameAllocationFailure(changeFailure({ kind: 'unknown' }))).toBe(false);
    expect(isCompilerTargetNameAllocationFailure(changeFailure({ code: 'unknown' }))).toBe(false);
    expect(isCompilerTargetNameAllocationFailure(changeFailure({ identities: 'first,second' }))).toBe(false);
    expect(isCompilerTargetNameAllocationFailure(changeFailure({ identities: [] }))).toBe(false);
    expect(isCompilerTargetNameAllocationFailure(changeFailure({ identities: ['first', 2] }))).toBe(false);
    expect(isCompilerTargetNameAllocationFailure(changeFailure({ identities: ['first', ''] }))).toBe(false);
    expect(isCompilerTargetNameAllocationFailure(changeFailure({ scope: 1 }))).toBe(false);
    expect(isCompilerTargetNameAllocationFailure(changeFailure({ scope: '' }))).toBe(false);
    expect(isCompilerTargetNameAllocationFailure(changeFailure({ targetName: 1 }))).toBe(false);
    expect(isCompilerTargetNameAllocationFailure(changeFailure({ targetName: '' }))).toBe(false);
  });
});

describe('createIrModuleTargetNameAllocation', () => {
  it('collects module and nested binding introductions without treating references as new candidates', () => {
    const binding = (id: string, name: string): IrBindingIdentity => ({
      column: 1,
      fingerprint: `sha256:${'0'.repeat(64)}`,
      id,
      kind: 'variable' as const,
      line: 1,
      name,
      packageName: '@flighthq/math',
      scope: 'function' as const,
      space: 'value' as const,
      source: 'value.ts',
    });
    const moduleBinding = { ...binding('module', 'value'), scope: 'module' as const };
    const localBinding = binding('local', 'value');
    const module = {
      declarations: [
        {
          binding: moduleBinding,
          exported: true,
          initializer: {
            async: false,
            body: [
              {
                declarations: [
                  {
                    binding: localBinding,
                    initializer: {
                      kind: 'identifier' as const,
                      reference: { binding: moduleBinding, kind: 'binding' as const },
                    },
                    mutable: false,
                  },
                ],
                kind: 'variable' as const,
              },
            ],
            kind: 'function' as const,
            parameters: [],
            returns: { kind: 'primitive' as const, name: 'void' as const },
            typeParameters: [],
          },
          kind: 'variable' as const,
          mutable: false,
          origin: moduleBinding,
        },
      ],
      exports: [],
      imports: [],
      name: 'Value',
      packageName: '@flighthq/math',
      source: 'value.ts',
    };

    expect(
      createIrModuleTargetNameAllocation(module, (candidate) => ({
        namespace: 'value',
        preferredName: candidate.name,
      })),
    ).toEqual([
      { identity: 'local', name: 'value', scope: expect.stringContaining('function:') },
      { identity: 'module', name: 'value', scope: 'value\0module' },
    ]);
  });

  it('collects bindings introduced in computed keys, spread members, and template parts', () => {
    const binding = (id: string): IrBindingIdentity => ({
      column: 1,
      fingerprint: `sha256:${'0'.repeat(64)}`,
      id,
      kind: 'variable' as const,
      line: 1,
      name: 'value',
      packageName: '@flighthq/math',
      scope: 'function' as const,
      space: 'value' as const,
      source: 'value.ts',
    });
    const introducer = (id: string) => ({
      async: false,
      binding: binding(id),
      body: [],
      kind: 'function' as const,
      parameters: [],
      returns: { kind: 'primitive' as const, name: 'void' as const },
      typeParameters: [],
    });
    const moduleBinding = { ...binding('module'), scope: 'module' as const };
    const module = {
      declarations: [
        {
          binding: moduleBinding,
          exported: true,
          initializer: {
            kind: 'object' as const,
            members: [
              { key: introducer('computedKey'), kind: 'computedProperty' as const, value: introducer('computedValue') },
              { expression: introducer('spreadExpression'), kind: 'spread' as const },
              {
                kind: 'property' as const,
                name: 'plain',
                value: { kind: 'template' as const, parts: ['prefix', introducer('templatePart')] },
              },
            ],
          },
          kind: 'variable' as const,
          mutable: false,
          origin: moduleBinding,
        },
      ],
      exports: [],
      imports: [],
      name: 'Value',
      packageName: '@flighthq/math',
      source: 'value.ts',
    };

    expect(
      createIrModuleTargetNameAllocation(module, (candidate) => ({
        namespace: 'value',
        preferredName: candidate.name,
      })),
    ).toEqual([
      { identity: 'computedKey', name: 'value', scope: 'value\0function:computedKey' },
      { identity: 'computedValue', name: 'value', scope: 'value\0function:computedValue' },
      { identity: 'module', name: 'value', scope: 'value\0module' },
      { identity: 'spreadExpression', name: 'value', scope: 'value\0function:spreadExpression' },
      { identity: 'templatePart', name: 'value', scope: 'value\0function:templatePart' },
    ]);
  });

  it('collects every array pattern leaf and default-expression binding in its lexical target scope', () => {
    const binding = (id: string, name: string): IrBindingIdentity => ({
      column: 1,
      fingerprint: `sha256:${'0'.repeat(64)}`,
      id,
      kind: 'variable',
      line: 1,
      name,
      packageName: '@flighthq/math',
      scope: 'module',
      space: 'value',
      source: 'pattern.ts',
    });
    const first = binding('first', 'first');
    const nested = binding('nested', 'nested');
    const rest = binding('rest', 'rest');
    const defaultBinding = { ...binding('default', 'fallback'), kind: 'function' as const };
    const module = {
      declarations: [
        {
          exported: true,
          initializer: { kind: 'array' as const, elements: [] },
          kind: 'variable' as const,
          mutable: false,
          origin: first,
          pattern: {
            ...first,
            elements: [
              { pattern: { binding: first, kind: 'binding' as const } },
              undefined,
              {
                initializer: {
                  async: false,
                  binding: defaultBinding,
                  body: [],
                  kind: 'function' as const,
                  parameters: [],
                  returns: { kind: 'primitive' as const, name: 'void' as const },
                  typeParameters: [],
                },
                pattern: {
                  ...nested,
                  elements: [{ pattern: { binding: nested, kind: 'binding' as const } }],
                  kind: 'array' as const,
                  scope: 'module' as const,
                },
              },
            ],
            kind: 'array' as const,
            rest: { binding: rest, kind: 'binding' as const },
            scope: 'module' as const,
          },
        },
      ],
      exports: [],
      imports: [],
      name: 'Pattern',
      packageName: '@flighthq/math',
      source: 'pattern.ts',
    };

    expect(
      createIrModuleTargetNameAllocation(module, (candidate) => ({
        namespace: 'value',
        preferredName: candidate.name,
      })),
    ).toEqual([
      { identity: 'default', name: 'fallback', scope: 'value\0function:default' },
      { identity: 'first', name: 'first', scope: 'value\0module' },
      { identity: 'nested', name: 'nested', scope: 'value\0module' },
      { identity: 'rest', name: 'rest', scope: 'value\0module' },
    ]);
  });
});
