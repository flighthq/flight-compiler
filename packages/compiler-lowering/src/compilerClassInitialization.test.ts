import ts from 'typescript';

import { lowerTypeScriptSource } from '../../compiler-semantic/src/index.js';
import type { IrClassDeclaration, IrClassField } from '../../compiler-types/src/index.js';
import { createIrClassInitializationPlan, isIrClassInitializationFailure } from './compilerClassInitialization.js';

describe('createIrClassInitializationPlan', () => {
  it('retains source field identity while separating runtime timing and value selection', () => {
    const declaration = createClass([
      createField('first', false, { kind: 'literal', value: 1 }),
      createField('shared', true),
      createField('second', false),
      createField('version', true, { kind: 'literal', value: 2 }),
    ]);

    expect(createIrClassInitializationPlan(declaration)).toEqual({
      constructor: { kind: 'implicit-base' },
      fields: [
        { fieldIndex: 0, timing: 'base-instance-binding', value: 'initializer' },
        { fieldIndex: 1, timing: 'class-evaluation', value: 'undefined' },
        { fieldIndex: 2, timing: 'base-instance-binding', value: 'undefined' },
        { fieldIndex: 3, timing: 'class-evaluation', value: 'initializer' },
      ],
      schema: 'flight-compiler-class-initialization/1',
    });
  });

  it('places derived instance fields after super returns and identifies implicit argument forwarding', () => {
    const derived = createClass([createField('value', false)], { derived: true });
    const explicitDerived = createClass([createField('value', false)], {
      explicitConstructor: true,
      derived: true,
    });
    const explicitBase = createClass([], { explicitConstructor: true });

    expect(createIrClassInitializationPlan(derived)).toMatchObject({
      constructor: { argumentForwarding: 'all', kind: 'implicit-derived' },
      fields: [{ timing: 'derived-super-return' }],
    });
    expect(createIrClassInitializationPlan(explicitDerived)).toMatchObject({
      constructor: { kind: 'explicit' },
      fields: [{ timing: 'derived-super-return' }],
    });
    expect(createIrClassInitializationPlan(explicitBase)).toMatchObject({
      constructor: { kind: 'explicit' },
      fields: [],
    });
  });

  it('derives executable field order from semantically lowered TypeScript classes', () => {
    const sourceFile = ts.createSourceFile(
      '/flight/packages/test/src/classes.ts',
      `
        export class Base {
          first = 1;
          static shared = 2;
          optional?: number;
          constructor(input = 0) { input; }
        }
        export class Derived extends Base {
          child = 3;
          empty?: number;
        }
      `,
      ts.ScriptTarget.Latest,
      true,
    );
    const result = lowerTypeScriptSource(sourceFile, {
      packageName: '@flighthq/test',
      upstreamDirectory: '/flight',
    });
    const [base, derived] = result.module.declarations;
    if (base?.kind !== 'class' || derived?.kind !== 'class') throw new Error('Expected class declarations');

    const basePlan = createIrClassInitializationPlan(base);
    const derivedPlan = createIrClassInitializationPlan(derived);

    expect(result.diagnostics).toEqual([]);
    expect(basePlan.constructor).toEqual({ kind: 'explicit' });
    expect(basePlan.fields.map((field) => ({ ...field, name: base.fields[field.fieldIndex]!.name }))).toEqual([
      { fieldIndex: 0, name: 'first', timing: 'base-instance-binding', value: 'initializer' },
      { fieldIndex: 1, name: 'shared', timing: 'class-evaluation', value: 'initializer' },
      { fieldIndex: 2, name: 'optional', timing: 'base-instance-binding', value: 'undefined' },
    ]);
    expect(derivedPlan).toMatchObject({
      constructor: { argumentForwarding: 'all', kind: 'implicit-derived' },
      fields: [
        { fieldIndex: 0, timing: 'derived-super-return', value: 'initializer' },
        { fieldIndex: 1, timing: 'derived-super-return', value: 'undefined' },
      ],
    });
  });

  it('orders parameter-property storage after ordinary fields at the constructor-specific boundary', () => {
    const sourceFile = ts.createSourceFile(
      '/flight/packages/test/src/parameter-properties.ts',
      `
        class Base {
          first = 1;
          constructor(public base: number) {}
        }
        export class Derived extends Base {
          child = 2;
          constructor(base: number, readonly label: string) { super(base); }
        }
      `,
      ts.ScriptTarget.Latest,
      true,
    );
    const result = lowerTypeScriptSource(sourceFile, {
      packageName: '@flighthq/test',
      upstreamDirectory: '/flight',
    });
    const [base, derived] = result.module.declarations;
    if (base?.kind !== 'class' || derived?.kind !== 'class') throw new Error('Expected class declarations');

    expect(result.diagnostics).toEqual([]);
    expect(createIrClassInitializationPlan(base).fields).toEqual([
      { fieldIndex: 0, timing: 'base-instance-binding', value: 'initializer' },
      {
        fieldIndex: 1,
        parameterIndex: 0,
        timing: 'base-constructor-body-entry',
        value: 'parameter',
      },
    ]);
    expect(createIrClassInitializationPlan(derived).fields).toEqual([
      { fieldIndex: 0, timing: 'derived-super-return', value: 'initializer' },
      {
        fieldIndex: 1,
        parameterIndex: 1,
        timing: 'derived-super-return-after-fields',
        value: 'parameter',
      },
    ]);
    expect(derived.classConstructor?.body).toContainEqual({
      expression: expect.objectContaining({
        callee: { kind: 'identifier', reference: { kind: 'super' } },
        kind: 'call',
      }),
      kind: 'expression',
    });
  });

  it('returns deeply frozen data without changing the class declaration', () => {
    const declaration = createClass([createField('value', false)]);
    const snapshot = structuredClone(declaration);

    const plan = createIrClassInitializationPlan(declaration);

    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.constructor)).toBe(true);
    expect(Object.isFrozen(plan.fields)).toBe(true);
    expect(plan.fields.every(Object.isFrozen)).toBe(true);
    expect(declaration).toEqual(snapshot);
  });

  it('rejects malformed declarations, heritage, constructors, and fields through stable paths', () => {
    const invalidParameterProperty = createClass(
      [{ ...createField('value', false), parameterProperty: { parameterIndex: 0 } } as never],
      { explicitConstructor: true },
    );
    const fixtures = [
      { code: 'invalid-class-declaration', path: ['declaration'], value: null },
      { code: 'invalid-class-declaration', path: ['declaration'], value: [] },
      { code: 'invalid-class-declaration', path: ['declaration'], value: { fields: [], kind: 'function' } },
      { code: 'invalid-class-declaration', path: ['declaration'], value: { fields: null, kind: 'class' } },
      {
        code: 'invalid-class-declaration',
        path: ['declaration', 'extends'],
        value: { extends: null, fields: [], kind: 'class' },
      },
      {
        code: 'invalid-class-declaration',
        path: ['declaration', 'classConstructor'],
        value: { classConstructor: {}, fields: [], kind: 'class' },
      },
      {
        code: 'invalid-class-field',
        path: ['declaration', 'fields', 0],
        value: { fields: [null], kind: 'class' },
      },
      {
        code: 'invalid-class-field',
        path: ['declaration', 'fields', 0],
        value: { fields: [{}], kind: 'class' },
      },
      {
        code: 'invalid-parameter-property',
        path: ['declaration', 'fields', 0, 'parameterProperty'],
        value: invalidParameterProperty,
      },
    ];

    for (const fixture of fixtures) {
      expect(() => createIrClassInitializationPlan(fixture.value as never)).toThrow(
        expect.objectContaining({ code: fixture.code, path: fixture.path }),
      );
    }
  });
});

describe('isIrClassInitializationFailure', () => {
  it('accepts every stable failure code and rejects ordinary and malformed errors', () => {
    const failures: unknown[] = [];
    const invalidParameterProperty = createClass(
      [{ ...createField('value', false), parameterProperty: { parameterIndex: 0 } } as never],
      { explicitConstructor: true },
    );
    for (const value of [null, { fields: [{}], kind: 'class' }, invalidParameterProperty]) {
      try {
        createIrClassInitializationPlan(value as never);
      } catch (error) {
        failures.push(error);
      }
    }

    expect(failures).toHaveLength(3);
    expect(failures.every(isIrClassInitializationFailure)).toBe(true);
    expect(isIrClassInitializationFailure(new Error('ordinary'))).toBe(false);
    expect(
      isIrClassInitializationFailure(
        Object.assign(new Error('lookalike'), {
          code: 'unknown',
          kind: 'ir-class-initialization',
          path: [],
        }),
      ),
    ).toBe(false);
  });
});

function createClass(
  fields: readonly IrClassField[],
  options: Readonly<{ derived?: boolean; explicitConstructor?: boolean }> = {},
): IrClassDeclaration {
  const origin = {
    column: 1,
    fingerprint: `sha256:${'0'.repeat(64)}` as IrClassDeclaration['origin']['fingerprint'],
    line: 1,
    packageName: '@flighthq/test',
    source: 'test.ts',
  };
  return {
    abstract: false,
    binding: {
      ...origin,
      id: 'test.ts:class:Fixture',
      kind: 'class',
      name: 'Fixture',
      scope: 'module',
      space: 'value',
    },
    ...(options.explicitConstructor ? { classConstructor: { body: [], overloads: [], parameters: [] } } : {}),
    exported: true,
    ...(options.derived
      ? {
          extends: { kind: 'named' as const, reference: { kind: 'ambient' as const, name: 'Base' }, typeArguments: [] },
        }
      : {}),
    fields,
    implements: [],
    kind: 'class',
    methods: [],
    origin,
    typeParameters: [],
  };
}

function createField(name: string, static_: boolean, initializer?: IrClassField['initializer']): IrClassField {
  return {
    ...(initializer ? { initializer } : {}),
    name,
    optional: false,
    readonly: false,
    static: static_,
    type: { kind: 'primitive', name: 'number' },
    visibility: 'public',
  };
}
