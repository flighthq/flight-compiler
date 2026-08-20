import { isCompilerInvariantFailure } from './compilerSourceEmission.js';
import {
  createCompilerTargetNameAllocation,
  createIrModuleTargetNameAllocation,
} from './compilerTargetNameAllocation.js';

describe('createCompilerTargetNameAllocation', () => {
  it('allocates collisions deterministically without consuming another preferred name', () => {
    const candidates = [
      { identity: 'third', preferredName: 'value_2', scope: 'module' },
      { identity: 'second', preferredName: 'value', scope: 'module' },
      { identity: 'first', preferredName: 'value', scope: 'module' },
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
      { identity: 'third', preferredName: 'value_2', scope: 'module' },
      { identity: 'second', preferredName: 'value', scope: 'module' },
      { identity: 'first', preferredName: 'value', scope: 'module' },
    ]);
  });

  it('keeps the same preferred spelling independent across target scopes', () => {
    expect(
      createCompilerTargetNameAllocation([
        { identity: 'local', preferredName: 'value', scope: 'function' },
        { identity: 'module', preferredName: 'value', scope: 'module' },
      ]),
    ).toEqual([
      { identity: 'local', name: 'value', scope: 'function' },
      { identity: 'module', name: 'value', scope: 'module' },
    ]);
  });

  it('normalizes canonically equivalent target spellings before collision allocation', () => {
    expect(
      createCompilerTargetNameAllocation([
        { identity: 'decomposed', preferredName: 'cafe\u0301', scope: 'module' },
        { identity: 'composed', preferredName: 'caf\u00e9', scope: 'module' },
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
        { identity: 'same', preferredName: 'first', scope: 'module' },
        { identity: 'same', preferredName: 'second', scope: 'module' },
      ],
      subject: 'same',
    },
    {
      code: 'invalid-target-name-candidate',
      input: [{ identity: '', preferredName: 'value', scope: 'module' }],
      subject: 'value',
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

describe('createIrModuleTargetNameAllocation', () => {
  it('collects module and nested binding introductions without treating references as new candidates', () => {
    const binding = (id: string, name: string) => ({
      column: 1,
      fingerprint: id.repeat(64).slice(0, 64),
      id,
      kind: 'variable' as const,
      line: 1,
      name,
      packageName: '@flighthq/math',
      scope: 'local' as const,
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
});
