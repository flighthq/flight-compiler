import ts from 'typescript';

import { lowerTypeScriptSource } from '../../compiler-semantic/src/index.js';
import type {
  CompilerModuleResolutionPlan,
  IrInterfaceDeclaration,
  IrModule,
  IrTypeReference,
} from '../../compiler-types/src/index.js';
import { createCompilerLoweringPassInterfaceInheritance } from './compilerInterfaceInheritanceLowering.js';
import { isCompilerLoweringFailure, lowerIrModuleWithCompilerPasses } from './compilerLoweringPass.js';

describe('createCompilerLoweringPassInterfaceInheritance', () => {
  it('flattens transitive generic and defaulted heritage without changing the input', () => {
    const module = lower(
      'generic.ts',
      `
        interface Root<Value> {
          array: Value[];
          callback: (value: Value) => Value;
          genericCallback: <Inner extends Value = Value>(value: Inner) => Value;
          plainGeneric: <T>(value: T) => T;
          indexed: Value[keyof Value];
          intersection: Value & { fixed: string };
          key: keyof Value;
          maybe: Value | null;
          named: Promise<Value>;
          pair: [Value, Value?];
          record: { nested: Value };
          literal: 'ready';
          impossible: never;
          typeQuery: typeof console;
          missing: undefined;
          uncertain: unknown;
        }
        interface Defaults<Value = number> { defaultValue: Value; }
        interface Middle<Value> extends Root<Value>, Defaults {}
        export interface Leaf extends Middle<number> { own: boolean; }
      `,
    );
    const snapshot = structuredClone(module);
    const pass = createCompilerLoweringPassInterfaceInheritance();
    const output = lowerIrModuleWithCompilerPasses(module, [pass], { verificationDepth: 'idempotence' });
    const leaf = getInterface(output, 'Leaf');

    expect(pass).toMatchObject({ idempotent: true, name: 'interface-inheritance', runsAfter: [] });
    expect(leaf.extends).toEqual([]);
    expect(leaf.properties.map((property) => property.name)).toEqual([
      'array',
      'callback',
      'genericCallback',
      'plainGeneric',
      'indexed',
      'intersection',
      'key',
      'maybe',
      'named',
      'pair',
      'record',
      'literal',
      'impossible',
      'typeQuery',
      'missing',
      'uncertain',
      'defaultValue',
      'own',
    ]);
    expect(leaf.properties).toMatchObject([
      { type: { element: { kind: 'primitive', name: 'number' }, kind: 'array' } },
      {
        type: {
          kind: 'function',
          parameters: [{ type: { kind: 'primitive', name: 'number' } }],
          returns: { kind: 'primitive', name: 'number' },
        },
      },
      {
        type: {
          kind: 'function',
          parameters: [{ type: { kind: 'named' } }],
          returns: { kind: 'primitive', name: 'number' },
          typeParameters: [
            {
              constraint: { kind: 'primitive', name: 'number' },
              default: { kind: 'primitive', name: 'number' },
            },
          ],
        },
      },
      {
        type: {
          kind: 'function',
          parameters: [{ type: { kind: 'named' } }],
          returns: { kind: 'named' },
          typeParameters: [{}],
        },
      },
      {
        type: {
          index: { kind: 'keyof', type: { kind: 'primitive', name: 'number' } },
          kind: 'indexedAccess',
          object: { kind: 'primitive', name: 'number' },
        },
      },
      {
        type: {
          kind: 'intersection',
          types: [{ kind: 'primitive', name: 'number' }, { kind: 'object' }],
        },
      },
      { type: { kind: 'keyof', type: { kind: 'primitive', name: 'number' } } },
      { type: { kind: 'union', types: [{ kind: 'primitive', name: 'number' }, { kind: 'null' }] } },
      { type: { kind: 'named', typeArguments: [{ kind: 'primitive', name: 'number' }] } },
      {
        type: {
          elements: [{ type: { kind: 'primitive', name: 'number' } }, { type: { kind: 'primitive', name: 'number' } }],
          kind: 'tuple',
        },
      },
      { type: { kind: 'object', properties: [{ type: { kind: 'primitive', name: 'number' } }] } },
      { type: { kind: 'literal', value: 'ready' } },
      { type: { kind: 'never' } },
      { type: { kind: 'typeOf' } },
      { type: { kind: 'undefined' } },
      { type: { kind: 'unknown', source: 'unknown' } },
      { type: { kind: 'primitive', name: 'number' } },
      { type: { kind: 'primitive', name: 'boolean' } },
    ]);
    expect(
      output.declarations
        .filter((declaration) => declaration.kind === 'interface')
        .every((declaration) => declaration.extends.length === 0),
    ).toBe(true);
    expect(module).toEqual(snapshot);
    expect(pass.verifyIrModule(module)).toEqual({
      kind: 'invalid',
      reason: 'interface inheritance remains after structural flattening',
    });
    expect(pass.verifyIrModule(output)).toEqual({ kind: 'valid' });

    const rootGeneric = getInterface(module, 'Root').properties.find((property) => property.name === 'genericCallback');
    const leafGeneric = leaf.properties.find((property) => property.name === 'genericCallback');
    if (rootGeneric?.type.kind !== 'function' || leafGeneric?.type.kind !== 'function') {
      throw new Error('Expected inherited generic callback function types');
    }
    const rootBinding = rootGeneric.type.typeParameters[0]!.binding;
    const leafBinding = leafGeneric.type.typeParameters[0]!.binding;
    expect(leafBinding.id).not.toBe(rootBinding.id);
    expect(leafBinding.id).toContain('interface-inheritance');
    expect(leafGeneric.type.parameters[0]!.type).toMatchObject({
      reference: { binding: { id: leafBinding.id }, kind: 'binding' },
    });
  });

  it('deduplicates identical diamonds and refuses unresolved, cyclic, arity, and incompatible heritage', () => {
    const module = lower(
      'failures.ts',
      `
        type Alias = { other: string };
        interface Root<Value> { value: Value; }
        interface Left extends Root<number> {}
        interface Right extends Root<number> {}
        export interface Diamond extends Left, Right {}
      `,
    );
    const pass = createCompilerLoweringPassInterfaceInheritance();
    const output = lowerIrModuleWithCompilerPasses(module, [pass]);

    expect(getInterface(output, 'Diamond').properties).toMatchObject([
      { name: 'value', type: { kind: 'primitive', name: 'number' } },
    ]);

    const root = getInterface(module, 'Root');
    const left = getInterface(module, 'Left');
    const right = getInterface(module, 'Right');
    const diamond = getInterface(module, 'Diamond');
    const alias = module.declarations.find((declaration) => declaration.kind === 'typeAlias');
    if (!alias) throw new Error('Expected Alias type declaration');
    const missingArgument = replaceInterface(module, left, {
      extends: [{ ...left.extends[0]!, typeArguments: [] }],
    });
    const tooManyArguments = replaceInterface(module, left, {
      extends: [{ ...left.extends[0]!, typeArguments: [{ kind: 'primitive', name: 'number' }, { kind: 'null' }] }],
    });
    const unresolved = replaceInterface(module, left, {
      extends: [
        {
          ...left.extends[0]!,
          reference: { kind: 'ambient', name: 'External' },
        } as IrTypeReference,
      ],
    });
    const qualified = replaceInterface(module, left, {
      extends: [
        {
          ...left.extends[0]!,
          reference: { binding: root.binding, kind: 'binding', path: ['Nested'] },
        },
      ],
    });
    const unavailable = replaceInterface(module, left, {
      extends: [
        {
          ...left.extends[0]!,
          reference: {
            binding: alias.binding,
            kind: 'binding',
            path: [],
          },
        },
      ],
    });
    const cyclic = replaceInterface(module, root, {
      extends: [
        {
          kind: 'named',
          reference: { binding: diamond.binding, kind: 'binding', path: [] },
          typeArguments: [],
        },
      ],
    });
    const incompatibleRight = {
      ...right,
      extends: [],
      properties: [{ ...root.properties[0]!, type: { kind: 'primitive', name: 'string' } as const }],
    };
    const incompatible = replaceInterface(module, right, incompatibleRight);

    for (const [subject, message] of [
      [missingArgument, 'requires heritage type argument Value'],
      [tooManyArguments, 'receives too many heritage type arguments'],
      [unresolved, 'inherits a nonlocal interface'],
      [qualified, 'inherits a nonlocal interface'],
      [unavailable, 'inherits unavailable interface Alias'],
      [cyclic, 'has cyclic structural inheritance'],
      [incompatible, 'inherits incompatible property value'],
    ] as const) {
      expect(() => lowerIrModuleWithCompilerPasses(subject, [pass])).toThrow(message);
      try {
        lowerIrModuleWithCompilerPasses(subject, [pass]);
      } catch (error) {
        expect(isCompilerLoweringFailure(error)).toBe(true);
        if (isCompilerLoweringFailure(error)) expect(error.code).toBe('unsupported-ir');
      }
    }
  });

  it('re-throws non-substitution errors from malformed heritage type parameters', () => {
    const module = lower(
      'rethrow.ts',
      `
        interface Root<Value> { value: Value; }
        interface Left extends Root<number> {}
        export interface Leaf extends Left {}
      `,
    );
    const root = getInterface(module, 'Root');
    const malformed = replaceInterface(module, root, {
      typeParameters: [null] as never,
    });
    const pass = createCompilerLoweringPassInterfaceInheritance();

    expect(() => pass.lowerIrModule(malformed)).toThrow(TypeError);
    expect(() => pass.lowerIrModule(malformed)).not.toThrow(expect.objectContaining({ kind: 'compiler-lowering' }));
  });

  it('flattens imported generic heritage through namespace and reexport graph routes', () => {
    const base = lowerInPackage(
      '@flighthq/model',
      'model',
      'base.ts',
      'export interface Base<Value> { value: Value; }',
    );
    const barrel = lowerInPackage(
      '@flighthq/shared',
      'shared',
      'index.ts',
      "export type { Base as Renamed } from '@flighthq/model';",
    );
    const derived = lowerInPackage(
      '@flighthq/app',
      'app',
      'derived.ts',
      "import type * as Shared from '@flighthq/shared'; export interface Derived extends Shared.Renamed<string> { active: boolean; }",
    );
    const resolution: CompilerModuleResolutionPlan = {
      edges: [
        {
          importer: identity(barrel),
          specifier: '@flighthq/model',
          target: { packageName: base.packageName, source: base.source },
        },
        {
          importer: identity(derived),
          specifier: '@flighthq/shared',
          target: { packageName: barrel.packageName, source: barrel.source },
        },
      ],
      schema: 'flight-compiler-module-resolution/1',
    };
    const pass = createCompilerLoweringPassInterfaceInheritance([derived, barrel, base], resolution);
    const output = lowerIrModuleWithCompilerPasses(derived, [pass], { verificationDepth: 'idempotence' });

    expect(getInterface(output, 'Derived')).toMatchObject({
      extends: [],
      properties: [
        { name: 'value', type: { kind: 'primitive', name: 'string' } },
        { name: 'active', type: { kind: 'primitive', name: 'boolean' } },
      ],
    });
    expect(derived).toEqual(
      lowerInPackage(
        '@flighthq/app',
        'app',
        'derived.ts',
        "import type * as Shared from '@flighthq/shared'; export interface Derived extends Shared.Renamed<string> { active: boolean; }",
      ),
    );
  });

  it('resolves named imports through relative star exports and source extension mappings', () => {
    const base = lowerInPackage(
      '@flighthq/model',
      'model',
      'base.cts',
      'interface Base { value: number; } export type { Base };',
    );
    const mixin = lowerInPackage(
      '@flighthq/model',
      'model',
      'mixin.ts',
      'export interface Mixin { enabled: boolean; }',
    );
    const barrel = lowerInPackage(
      '@flighthq/model',
      'model',
      'nested/index.ts',
      "export * from '../base.cjs'; export * from '../mixin';",
    );
    const derived = lowerInPackage(
      '@flighthq/model',
      'model',
      'consumer.ts',
      "import type { Base, Mixin } from './nested'; export interface Derived extends Base, Mixin { label: string; }",
    );
    const pass = createCompilerLoweringPassInterfaceInheritance([derived, barrel, mixin, base]);

    const output = lowerIrModuleWithCompilerPasses(derived, [pass], { verificationDepth: 'idempotence' });

    expect(getInterface(output, 'Derived')).toMatchObject({
      extends: [],
      properties: [
        { name: 'value', type: { kind: 'primitive', name: 'number' } },
        { name: 'enabled', type: { kind: 'primitive', name: 'boolean' } },
        { name: 'label', type: { kind: 'primitive', name: 'string' } },
      ],
    });
  });

  it('refuses missing, ambiguous, and cyclic imported heritage deterministically', () => {
    const unavailable = lowerInPackage(
      '@flighthq/app',
      'app',
      'unavailable.ts',
      "import type { Missing } from './missing.js'; export interface Derived extends Missing {}",
    );
    expect(() =>
      lowerIrModuleWithCompilerPasses(unavailable, [createCompilerLoweringPassInterfaceInheritance([unavailable])]),
    ).toThrow('inherits unavailable interface Missing');

    const first = lowerInPackage('@flight/first', 'first', 'base.ts', 'export interface Base { first: string; }');
    const second = lowerInPackage('@flight/second', 'second', 'base.ts', 'export interface Base { second: string; }');
    const ambiguous = lowerInPackage(
      '@flighthq/app',
      'app',
      'ambiguous.ts',
      "import type { Base } from '@flight/shared'; export interface Derived extends Base {}",
    );
    const ambiguousResolution: CompilerModuleResolutionPlan = {
      edges: [
        {
          specifier: '@flight/shared',
          target: { packageName: first.packageName, source: first.source },
        },
        {
          specifier: '@flight/shared',
          target: { packageName: second.packageName, source: second.source },
        },
      ],
      schema: 'flight-compiler-module-resolution/1',
    };
    expect(() =>
      lowerIrModuleWithCompilerPasses(ambiguous, [
        createCompilerLoweringPassInterfaceInheritance([ambiguous, first, second], ambiguousResolution),
      ]),
    ).toThrow('inherits ambiguous interface Base');

    const left = lowerInPackage(
      '@flighthq/cycle',
      'cycle',
      'left.ts',
      "import type { Right } from './right.js'; export interface Left extends Right {}",
    );
    const right = lowerInPackage(
      '@flighthq/cycle',
      'cycle',
      'right.ts',
      "import type { Left } from './left.js'; export interface Right extends Left {}",
    );
    expect(() =>
      lowerIrModuleWithCompilerPasses(left, [createCompilerLoweringPassInterfaceInheritance([left, right])]),
    ).toThrow('has cyclic structural inheritance');
  });
});

function getInterface(module: Readonly<IrModule>, name: string): Readonly<IrInterfaceDeclaration> {
  const declaration = module.declarations.find(
    (candidate): candidate is IrInterfaceDeclaration =>
      candidate.kind === 'interface' && candidate.binding.name === name,
  );
  if (!declaration) throw new Error(`Expected interface ${name}`);
  return declaration;
}

function lower(file: string, source: string): IrModule {
  return lowerTypeScriptSource(
    ts.createSourceFile(`/flight/packages/lowering/src/${file}`, source, ts.ScriptTarget.Latest, true),
    { packageName: '@flighthq/lowering', upstreamDirectory: '/flight' },
  ).module;
}

function lowerInPackage(packageName: string, packageDirectory: string, file: string, source: string): IrModule {
  return lowerTypeScriptSource(
    ts.createSourceFile(`/flight/packages/${packageDirectory}/src/${file}`, source, ts.ScriptTarget.Latest, true),
    { packageName, upstreamDirectory: '/flight' },
  ).module;
}

function identity(module: Readonly<IrModule>) {
  return { name: module.name, packageName: module.packageName, source: module.source };
}

function replaceInterface(
  module: Readonly<IrModule>,
  declaration: Readonly<IrInterfaceDeclaration>,
  replacement: Partial<IrInterfaceDeclaration>,
): IrModule {
  return {
    ...module,
    declarations: module.declarations.map((candidate) =>
      candidate === declaration ? { ...declaration, ...replacement } : candidate,
    ),
  };
}
