import type {
  IrBindingIdentity,
  IrExpression,
  IrIdentifierExpression,
  IrModule,
  IrStatement,
  IrTypeBindingIdentity,
  IrVariable,
} from '../../compiler-types/src/index.js';
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
          declarationKind: 'const' as const,
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
            thisMode: 'lexical' as const,
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
      thisMode: 'lexical' as const,
      typeParameters: [],
    });
    const moduleBinding = { ...binding('module'), scope: 'module' as const };
    const module = {
      declarations: [
        {
          binding: moduleBinding,
          declarationKind: 'const' as const,
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
            type: { kind: 'unknown' as const, source: 'object' as const },
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
          declarationKind: 'const' as const,
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
                  thisMode: 'lexical' as const,
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

  it('collects every object pattern leaf, computed key, and rest binding in its lexical target scope', () => {
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
    const named = binding('named', 'named');
    const nested = binding('nested', 'nested');
    const rest = binding('rest', 'rest');
    const key = binding('key', 'key');
    const fallback = { ...binding('fallback', 'fallback'), kind: 'function' as const };
    const module = {
      declarations: [
        {
          declarationKind: 'const' as const,
          exported: true,
          initializer: { kind: 'array' as const, elements: [] },
          kind: 'variable' as const,
          mutable: false,
          origin: named,
          pattern: {
            ...named,
            kind: 'object' as const,
            properties: [
              { key: { kind: 'named' as const, name: 'named' }, pattern: { binding: named, kind: 'binding' as const } },
              {
                initializer: {
                  async: false,
                  binding: fallback,
                  body: [],
                  kind: 'function' as const,
                  parameters: [],
                  returns: { kind: 'primitive' as const, name: 'void' as const },
                  thisMode: 'lexical' as const,
                  typeParameters: [],
                },
                key: {
                  coercion: 'string' as const,
                  expression: {
                    async: false,
                    binding: key,
                    body: [],
                    kind: 'function' as const,
                    parameters: [],
                    returns: { kind: 'primitive' as const, name: 'void' as const },
                    thisMode: 'lexical' as const,
                    typeParameters: [],
                  },
                  kind: 'computed' as const,
                },
                pattern: {
                  ...nested,
                  kind: 'object' as const,
                  properties: [
                    {
                      key: { kind: 'named' as const, name: 'nested' },
                      pattern: { binding: nested, kind: 'binding' as const },
                    },
                  ],
                  scope: 'module' as const,
                },
              },
            ],
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

    // Every leaf a destructuring pattern introduces is a binding the target must be able to name.
    // Object patterns were previously walked as if they introduced none, so their leaves reached
    // emission with no allocated name and no collision protection.
    expect(
      createIrModuleTargetNameAllocation(module, (candidate) => ({
        namespace: 'value',
        preferredName: candidate.name,
      })),
    ).toEqual([
      { identity: 'fallback', name: 'fallback', scope: 'value\0function:fallback' },
      { identity: 'key', name: 'key', scope: 'value\0function:key' },
      { identity: 'named', name: 'named', scope: 'value\0module' },
      { identity: 'nested', name: 'nested', scope: 'value\0module' },
      { identity: 'rest', name: 'rest', scope: 'value\0module' },
    ]);
  });

  it('collects import bindings at module scope', () => {
    const module = createFixtureModule({
      imports: [
        {
          bindings: [{ binding: createBinding('imported', 'imported'), imported: 'value', typeOnly: false as const }],
          specifier: './other.js',
          typeOnly: false,
        },
      ],
    });

    const ids = allocateIds(module);
    expect(ids).toContainEqual({ identity: 'imported', name: 'imported', scope: 'value\0module' });
  });

  it('collects class binding, type parameters, constructor parameters, constructor body, fields, and methods', () => {
    const classBinding = { ...createBinding('MyClass', 'MyClass'), kind: 'class' as const, scope: 'module' as const };
    const typeParam = createTypeBinding('T', 'T');
    const ctorParam = createBinding('ctorArg', 'ctorArg');
    const ctorLocal = createBinding('ctorLocal', 'ctorLocal');
    const ctorDefaultBinding = createBinding('ctorDefault', 'ctorDefault');
    const fieldInitBinding = createBinding('fieldInit', 'fieldInit');
    const methodTypeParam = createTypeBinding('U', 'U');
    const methodParam = createBinding('methodArg', 'methodArg');
    const methodLocal = createBinding('methodLocal', 'methodLocal');
    const methodDefaultBinding = createBinding('methodDefault', 'methodDefault');
    const module = createFixtureModule({
      declarations: [
        {
          abstract: false,
          binding: classBinding,
          classConstructor: {
            body: [variableStatement(ctorLocal, createLiteral(1))],
            overloads: [],
            parameters: [
              {
                binding: ctorParam,
                initializer: createFunctionExpression(ctorDefaultBinding),
                optional: true as const,
                rest: false as const,
                type: primitiveType,
              },
            ],
          },
          exported: true,
          extends: undefined,
          fields: [
            {
              initializer: createFunctionExpression(fieldInitBinding),
              name: 'field',
              optional: false,
              readonly: false,
              static: false,
              type: primitiveType,
              visibility: 'public' as const,
            },
          ],
          implements: [],
          kind: 'class' as const,
          methods: [
            {
              async: false,
              body: [variableStatement(methodLocal, createLiteral(2))],
              name: 'method',
              overloads: [],
              parameters: [
                {
                  binding: methodParam,
                  initializer: createFunctionExpression(methodDefaultBinding),
                  optional: true as const,
                  rest: false as const,
                  type: primitiveType,
                },
              ],
              returns: primitiveType,
              static: false,
              typeParameters: [{ binding: methodTypeParam, constraint: undefined, default: undefined }],
              visibility: 'public' as const,
            },
          ],
          origin: classBinding,
          typeParameters: [{ binding: typeParam, constraint: undefined, default: undefined }],
        },
      ],
    });

    const ids = allocateIds(module);
    expect(ids).toContainEqual(expect.objectContaining({ identity: 'MyClass' }));
    expect(ids).toContainEqual(expect.objectContaining({ identity: 'T' }));
    expect(ids).toContainEqual(expect.objectContaining({ identity: 'ctorArg' }));
    expect(ids).toContainEqual(expect.objectContaining({ identity: 'ctorLocal' }));
    expect(ids).toContainEqual(expect.objectContaining({ identity: 'ctorDefault' }));
    expect(ids).toContainEqual(expect.objectContaining({ identity: 'fieldInit' }));
    expect(ids).toContainEqual(expect.objectContaining({ identity: 'U' }));
    expect(ids).toContainEqual(expect.objectContaining({ identity: 'methodArg' }));
    expect(ids).toContainEqual(expect.objectContaining({ identity: 'methodLocal' }));
    expect(ids).toContainEqual(expect.objectContaining({ identity: 'methodDefault' }));
  });

  it('assigns renamable disposition when class, enum, or variable declarations are not exported', () => {
    const classBinding = { ...createBinding('Internal', 'Internal'), kind: 'class' as const, scope: 'module' as const };
    const enumBinding = { ...createBinding('Status', 'Status'), kind: 'enum' as const, scope: 'module' as const };
    const varBinding = { ...createBinding('local', 'local'), scope: 'module' as const };
    const module = createFixtureModule({
      declarations: [
        {
          abstract: false,
          binding: classBinding,
          exported: false,
          extends: undefined,
          fields: [],
          implements: [],
          kind: 'class' as const,
          methods: [],
          origin: classBinding,
          typeParameters: [],
        },
        { binding: enumBinding, exported: false, kind: 'enum' as const, members: [], origin: enumBinding },
        {
          binding: varBinding,
          declarationKind: 'const' as const,
          exported: false,
          kind: 'variable' as const,
          mutable: false,
          origin: varBinding,
        },
      ],
    });

    const ids = allocateIds(module);
    expect(ids).toContainEqual(expect.objectContaining({ identity: 'Internal' }));
    expect(ids).toContainEqual(expect.objectContaining({ identity: 'Status' }));
    expect(ids).toContainEqual(expect.objectContaining({ identity: 'local' }));
  });

  it('collects enum and interface/typeAlias bindings and type parameters', () => {
    const enumBinding = { ...createBinding('Color', 'Color'), kind: 'enum' as const, scope: 'module' as const };
    const ifaceBinding = createTypeBinding('Shape', 'Shape');
    const ifaceTypeParam = createTypeBinding('V', 'V');
    const aliasBinding = createTypeBinding('Name', 'Name');
    const aliasTypeParam = createTypeBinding('W', 'W');
    const module = createFixtureModule({
      declarations: [
        { binding: enumBinding, exported: true, kind: 'enum' as const, members: [], origin: enumBinding },
        {
          binding: ifaceBinding,
          exported: false,
          extends: [],
          kind: 'interface' as const,
          origin: ifaceBinding,
          properties: [],
          typeParameters: [{ binding: ifaceTypeParam, constraint: undefined, default: undefined }],
        },
        {
          binding: aliasBinding,
          exported: true,
          kind: 'typeAlias' as const,
          origin: aliasBinding,
          type: { kind: 'primitive' as const, name: 'string' as const },
          typeParameters: [{ binding: aliasTypeParam, constraint: undefined, default: undefined }],
        },
      ],
    });

    const ids = allocateIds(module);
    expect(ids).toContainEqual(expect.objectContaining({ identity: 'Color' }));
    expect(ids).toContainEqual(expect.objectContaining({ identity: 'Shape' }));
    expect(ids).toContainEqual(expect.objectContaining({ identity: 'V' }));
    expect(ids).toContainEqual(expect.objectContaining({ identity: 'Name' }));
    expect(ids).toContainEqual(expect.objectContaining({ identity: 'W' }));
  });

  it('collects function declaration bindings including type parameters and parameter defaults', () => {
    const fnBinding = { ...createBinding('read', 'read'), kind: 'function' as const, scope: 'module' as const };
    const fnTypeParam = createTypeBinding('R', 'R');
    const fnParam = createBinding('input', 'input');
    const fnLocal = createBinding('result', 'result');
    const fnDefaultBinding = createBinding('fnDefault', 'fnDefault');
    const module = createFixtureModule({
      declarations: [
        {
          async: false,
          binding: fnBinding,
          body: [variableStatement(fnLocal, createLiteral(0))],
          exported: true,
          kind: 'function' as const,
          origin: fnBinding,
          overloads: [],
          parameters: [
            {
              binding: fnParam,
              initializer: createFunctionExpression(fnDefaultBinding),
              optional: true as const,
              rest: false as const,
              type: primitiveType,
            },
          ],
          returns: primitiveType,
          typeParameters: [{ binding: fnTypeParam, constraint: undefined, default: undefined }],
        },
      ],
    });

    const ids = allocateIds(module);
    expect(ids).toContainEqual(expect.objectContaining({ identity: 'read' }));
    expect(ids).toContainEqual(expect.objectContaining({ identity: 'R' }));
    expect(ids).toContainEqual(expect.objectContaining({ identity: 'input' }));
    expect(ids).toContainEqual(expect.objectContaining({ identity: 'result' }));
    expect(ids).toContainEqual(expect.objectContaining({ identity: 'fnDefault' }));
  });

  it('collects variable with pattern binding and initializer expression', () => {
    const patternLeaf = createBinding('x', 'x');
    const initBinding = createBinding('initFn', 'initFn');
    const module = createFixtureModule({
      declarations: [
        {
          declarationKind: 'const' as const,
          exported: false,
          initializer: createFunctionExpression(initBinding),
          kind: 'variable' as const,
          mutable: false,
          origin: patternLeaf,
          pattern: {
            ...patternLeaf,
            elements: [{ pattern: { binding: patternLeaf, kind: 'binding' as const } }],
            kind: 'array' as const,
            scope: 'module' as const,
          },
        },
      ],
    });

    const ids = allocateIds(module);
    expect(ids).toContainEqual(expect.objectContaining({ identity: 'x' }));
    expect(ids).toContainEqual(expect.objectContaining({ identity: 'initFn' }));
  });

  it('collects bindings from all expression kinds inside a function body', () => {
    const fn = (id: string): IrExpression => createFunctionExpression(createBinding(id, id));
    const ident: IrExpression = { kind: 'identifier' as const, reference: { kind: 'ambient' as const, name: 'x' } };
    const lit = createLiteral(1);

    const expressions: IrExpression[] = [
      { elements: [fn('arrayEl'), undefined], kind: 'array' },
      { kind: 'assignment', left: ident, operator: '=', right: fn('assignRight'), semantics: {} as never },
      { kind: 'binary', left: fn('binLeft'), operator: '+', right: fn('binRight'), semantics: {} as never },
      { expression: fn('awaitExpr'), kind: 'await', semantics: {} as never },
      { expression: fn('castExpr'), kind: 'cast', type: primitiveType },
      { expression: fn('spreadExpr'), kind: 'spread' },
      {
        arguments: [fn('callArg')],
        callee: fn('callCallee'),
        kind: 'call',
        optional: false,
        semantics: { resultType: primitiveType },
        typeArguments: [],
      },
      {
        arguments: [fn('newArg')],
        callee: fn('newCallee'),
        kind: 'new',
        semantics: {},
        typeArguments: [],
      },
      {
        condition: fn('condCond'),
        kind: 'conditional',
        whenFalse: fn('condFalse'),
        whenTrue: fn('condTrue'),
      },
      { index: fn('elemIdx'), kind: 'element', object: fn('elemObj'), optional: false, semantics: {} as never },
      {
        async: false,
        binding: createBinding('innerFn', 'innerFn'),
        body: [],
        expression: fn('fnResult'),
        kind: 'function',
        parameters: [
          {
            binding: createBinding('fnParam', 'fnParam'),
            initializer: fn('fnParamDefault'),
            optional: true as const,
            rest: false as const,
            type: primitiveType,
          },
        ],
        returns: primitiveType,
        thisMode: 'lexical' as const,
        typeParameters: [{ binding: createTypeBinding('FT', 'FT'), constraint: undefined, default: undefined }],
      },
      { kind: 'identifier', reference: { kind: 'ambient', name: 'ignored' } },
      lit,
      { kind: 'regexp', flags: '', pattern: 'x' },
      { kind: 'undefinedValue', type: { kind: 'undefined' as const } },
      {
        kind: 'object',
        members: [{ kind: 'property' as const, name: 'p', value: lit }],
        type: { kind: 'unknown' as const, source: 'object' as const },
      },
      { kind: 'property', name: 'prop', object: fn('propObj'), optional: false },
      {
        excluded: [
          { kind: 'named' as const, name: 'a' },
          { coercion: 'string' as const, expression: fn('restKey'), kind: 'computed' as const },
        ],
        kind: 'objectRest',
        object: fn('restObj') as unknown as IrIdentifierExpression,
        type: { kind: 'object' as const, properties: [] },
      },
      {
        elements: [{ expression: fn('tupleEl'), optional: false as const }, { optional: true as const }],
        kind: 'tuple',
      },
      {
        kind: 'tupleSpread',
        segments: [
          { element: { expression: fn('tsEl'), optional: false as const }, kind: 'element' as const },
          { element: { optional: true as const }, kind: 'element' as const },
          {
            expression: fn('tsSpread'),
            kind: 'spread' as const,
            type: { elements: [], kind: 'tuple' as const, readonly: false },
          },
        ],
        type: { elements: [], kind: 'tuple' as const, readonly: false },
      },
      { kind: 'tupleRest', object: fn('tupleRestObj'), start: 0 },
      { kind: 'tupleSuffix', object: fn('tupleSufObj') as unknown as IrIdentifierExpression, start: 0, width: 1 },
      { kind: 'unary', operand: fn('unaryOp'), operator: '-', postfix: false as const, semantics: {} as never },
      {
        fallback: fn('udFallback'),
        kind: 'undefinedDefault',
        value: fn('udValue'),
      },
    ];

    const declBinding = { ...createBinding('host', 'host'), kind: 'function' as const, scope: 'module' as const };
    const module = createFixtureModule({
      declarations: [
        {
          async: false,
          binding: declBinding,
          body: expressions.map(
            (expression, index): IrStatement =>
              variableStatement(createBinding(`v${String(index)}`, `v${String(index)}`), expression),
          ),
          exported: false,
          kind: 'function' as const,
          origin: declBinding,
          overloads: [],
          parameters: [],
          returns: primitiveType,
          typeParameters: [],
        },
      ],
    });

    const ids = allocateIds(module);
    const identities = ids.map((allocation) => allocation.identity);
    for (const expected of [
      'arrayEl',
      'assignRight',
      'binLeft',
      'binRight',
      'awaitExpr',
      'castExpr',
      'spreadExpr',
      'callCallee',
      'callArg',
      'newCallee',
      'newArg',
      'condCond',
      'condFalse',
      'condTrue',
      'elemIdx',
      'elemObj',
      'innerFn',
      'fnParam',
      'fnParamDefault',
      'FT',
      'fnResult',
      'propObj',
      'restObj',
      'restKey',
      'tupleEl',
      'tsEl',
      'tsSpread',
      'tupleRestObj',
      'tupleSufObj',
      'unaryOp',
      'udFallback',
      'udValue',
    ]) {
      expect(identities).toContain(expected);
    }
  });

  it('collects bindings from all statement kinds inside a function body', () => {
    const fn = (id: string): IrExpression => createFunctionExpression(createBinding(id, id));
    const ident: IrExpression = { kind: 'identifier' as const, reference: { kind: 'ambient' as const, name: 'x' } };
    const lit = createLiteral(1);
    const noop: IrStatement = { expression: lit, kind: 'expression' };

    const statements: IrStatement[] = [
      { kind: 'block', statements: [variableStatement(createBinding('blockLocal', 'blockLocal'), lit)] },
      { kind: 'break' as const },
      { kind: 'continue' as const },
      { body: noop, condition: fn('doWhileCond'), kind: 'do' },
      { body: noop, condition: fn('whileCond'), kind: 'while' },
      { expression: fn('exprStmt'), kind: 'expression' },
      { expression: fn('throwExpr'), kind: 'throw' },
      {
        body: noop,
        condition: fn('forCond'),
        increment: fn('forInc'),
        initializer: [{ binding: createBinding('forVar', 'forVar'), initializer: lit, mutable: true } as IrVariable],
        kind: 'for',
      },
      {
        body: noop,
        initializer: fn('forExprInit'),
        kind: 'for',
      },
      {
        body: noop,
        kind: 'forIn',
        object: fn('forInObj'),
        variable: { binding: createBinding('forInVar', 'forInVar'), mutable: false } as IrVariable,
      },
      {
        await: false,
        body: noop,
        iterable: fn('forOfIter'),
        kind: 'forOf',
        variable: { binding: createBinding('forOfVar', 'forOfVar'), mutable: false } as IrVariable,
      },
      {
        condition: fn('ifCond'),
        consequent: variableStatement(createBinding('ifLocal', 'ifLocal'), lit),
        kind: 'if',
        otherwise: variableStatement(createBinding('elseLocal', 'elseLocal'), lit),
      },
      { expression: fn('retExpr'), kind: 'return' },
      { kind: 'return' as const },
      {
        cases: [
          {
            expression: fn('caseExpr'),
            statements: [variableStatement(createBinding('caseLocal', 'caseLocal'), lit)],
          },
          { statements: [noop] },
        ],
        expression: fn('switchExpr'),
        kind: 'switch',
      },
      {
        catchClause: {
          binding: createBinding('caught', 'caught'),
          body: variableStatement(createBinding('catchLocal', 'catchLocal'), lit),
          semantics: {} as never,
        },
        finallyBody: variableStatement(createBinding('finallyLocal', 'finallyLocal'), lit),
        kind: 'try',
        tryBody: variableStatement(createBinding('tryLocal', 'tryLocal'), lit),
      },
      {
        declarations: [{ binding: createBinding('varDecl', 'varDecl'), initializer: lit, mutable: false }],
        kind: 'variable',
      },
    ];

    const declBinding = {
      ...createBinding('stmtHost', 'stmtHost'),
      kind: 'function' as const,
      scope: 'module' as const,
    };
    const module = createFixtureModule({
      declarations: [
        {
          async: false,
          binding: declBinding,
          body: statements,
          exported: false,
          kind: 'function' as const,
          origin: declBinding,
          overloads: [],
          parameters: [],
          returns: primitiveType,
          typeParameters: [],
        },
      ],
    });

    const ids = allocateIds(module);
    const identities = ids.map((allocation) => allocation.identity);
    for (const expected of [
      'blockLocal',
      'doWhileCond',
      'whileCond',
      'exprStmt',
      'throwExpr',
      'forCond',
      'forInc',
      'forVar',
      'forExprInit',
      'forInObj',
      'forInVar',
      'forOfIter',
      'forOfVar',
      'ifCond',
      'ifLocal',
      'elseLocal',
      'retExpr',
      'switchExpr',
      'caseExpr',
      'caseLocal',
      'caught',
      'catchLocal',
      'finallyLocal',
      'tryLocal',
      'varDecl',
    ]) {
      expect(identities).toContain(expected);
    }
  });

  it('collects pattern variable bindings in statements', () => {
    const patternBinding = createBinding('pv', 'pv');
    const declBinding = { ...createBinding('patHost', 'patHost'), kind: 'function' as const, scope: 'module' as const };
    const lit = createLiteral(1);
    const module = createFixtureModule({
      declarations: [
        {
          binding: declBinding,
          body: [
            {
              declarations: [
                {
                  initializer: lit,
                  mutable: false,
                  pattern: {
                    ...patternBinding,
                    elements: [{ pattern: { binding: patternBinding, kind: 'binding' as const } }],
                    kind: 'array' as const,
                    scope: 'block' as const,
                  },
                } as IrVariable,
              ],
              kind: 'variable' as const,
            },
          ],
          async: false,
          exported: false,
          kind: 'function' as const,
          origin: declBinding,
          overloads: [],
          parameters: [],
          returns: primitiveType,
          typeParameters: [],
        },
      ],
    });

    const ids = allocateIds(module);
    expect(ids).toContainEqual(expect.objectContaining({ identity: 'pv' }));
  });
});

const primitiveType = { kind: 'primitive' as const, name: 'number' as const };

function allocateIds(module: IrModule): readonly { identity: string; name: string; scope: string }[] {
  return createIrModuleTargetNameAllocation(module, (candidate) => ({
    namespace: 'value',
    preferredName: candidate.name,
  }));
}

function createBinding(id: string, name: string): IrBindingIdentity {
  return {
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
  };
}

function createTypeBinding(id: string, name: string): IrTypeBindingIdentity {
  return {
    column: 1,
    fingerprint: `sha256:${'0'.repeat(64)}`,
    id,
    kind: 'typeParameter' as const,
    line: 1,
    name,
    packageName: '@flighthq/math',
    scope: 'function' as const,
    space: 'type' as const,
    source: 'value.ts',
  };
}

function createFixtureModule(overrides: Partial<IrModule>): IrModule {
  return {
    declarations: [],
    exports: [],
    imports: [],
    name: 'Fixture',
    packageName: '@flighthq/math',
    source: 'fixture.ts',
    ...overrides,
  } as IrModule;
}

function createFunctionExpression(binding: IrBindingIdentity): IrExpression {
  return {
    async: false,
    binding,
    body: [],
    kind: 'function' as const,
    parameters: [],
    returns: primitiveType,
    thisMode: 'lexical' as const,
    typeParameters: [],
  };
}

function createLiteral(value: number): IrExpression {
  return { kind: 'literal' as const, value };
}

function variableStatement(binding: IrBindingIdentity, initializer: IrExpression): IrStatement {
  return {
    declarations: [{ binding, initializer, mutable: false }],
    kind: 'variable' as const,
  };
}
