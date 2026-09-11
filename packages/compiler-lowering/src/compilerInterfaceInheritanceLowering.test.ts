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

  it('replaces inherited properties with compatible direct refinements', () => {
    const module = lower(
      'refined-property.ts',
      `
        interface Base { optional?: number; type: string; }
        export interface Refined extends Base { optional: number; type: 'specific'; }
      `,
    );
    const output = lowerIrModuleWithCompilerPasses(module, [createCompilerLoweringPassInterfaceInheritance([module])]);

    expect(getInterface(output, 'Refined')).toMatchObject({
      extends: [],
      properties: [
        { name: 'optional', optional: false, type: { kind: 'primitive', name: 'number' } },
        { name: 'type', type: { kind: 'literal', value: 'specific' } },
      ],
    });
  });

  it('resolves imported aliases before checking direct property refinements', () => {
    const kind = lowerInPackage('@flighthq/model', 'model', 'kind.ts', 'export type Kind = string;');
    const base = lowerInPackage(
      '@flighthq/model',
      'model',
      'base.ts',
      "import type { Kind } from './kind'; export interface Base { kind: Kind; }",
    );
    const derived = lowerInPackage(
      '@flighthq/model',
      'model',
      'derived.ts',
      "import type { Base } from './base'; export interface Derived extends Base { kind: 'Derived'; }",
    );
    const output = lowerIrModuleWithCompilerPasses(derived, [
      createCompilerLoweringPassInterfaceInheritance([derived, base, kind]),
    ]);

    expect(getInterface(output, 'Derived')).toMatchObject({
      extends: [],
      properties: [{ name: 'kind', type: { kind: 'literal', value: 'Derived' } }],
    });
  });

  it('resolves typeof constants before checking direct property refinements', () => {
    const module = lower(
      'typeof-refined-property.ts',
      `
        type Kind = string;
        const DerivedKind = 'Derived';
        interface Base { kind: Kind; }
        export interface Derived extends Base { kind: typeof DerivedKind; }
      `,
    );
    const output = lowerIrModuleWithCompilerPasses(module, [createCompilerLoweringPassInterfaceInheritance([module])]);

    expect(getInterface(output, 'Derived').properties).toMatchObject([
      { name: 'kind', type: { kind: 'literal', value: 'Derived' } },
    ]);
  });

  it('keeps the narrower property contributed by structural intersections', () => {
    const module = lower(
      'intersection-refined-property.ts',
      `
        interface BaseData { base: number; }
        interface DerivedData extends BaseData { derived: number; }
        type Base = { data: BaseData | null };
        type Refined = { data: DerivedData | null };
        type Combined = Base & Refined;
        export interface Derived extends Combined { active: boolean; }
      `,
    );
    const output = lowerIrModuleWithCompilerPasses(module, [createCompilerLoweringPassInterfaceInheritance([module])]);

    expect(getInterface(output, 'Derived').properties).toMatchObject([
      { name: 'data', type: { kind: 'union', types: [{ kind: 'named' }, { kind: 'null' }] } },
      { name: 'active' },
    ]);
  });

  it('keeps TypeScript interface method parameter refinements', () => {
    const module = lower(
      'method-refinement.ts',
      `
        interface Renderable { kind: string; }
        interface Sprite extends Renderable { image: string; }
        interface Renderer { create(source: Renderable): object | null; }
        export interface SpriteRenderer extends Renderer { create(source: Sprite): object | null; }
      `,
    );
    const output = lowerIrModuleWithCompilerPasses(module, [createCompilerLoweringPassInterfaceInheritance([module])]);
    const create = getInterface(output, 'SpriteRenderer').properties.find((property) => property.name === 'create');

    expect(create).toMatchObject({
      type: { kind: 'function', parameters: [{ type: { kind: 'named', reference: { binding: { name: 'Sprite' } } } }] },
    });
  });

  it('ignores nested property readonly markers when proving a direct refinement', () => {
    const module = lower(
      'readonly-refinement.ts',
      `
        interface Source { kind: string; }
        interface RenderTarget extends Source { readonly kind: 'renderTarget'; }
        interface Texture { source: Source | null; }
        export interface RenderTexture extends Texture { source: RenderTarget; }
      `,
    );
    const output = lowerIrModuleWithCompilerPasses(module, [createCompilerLoweringPassInterfaceInheritance([module])]);

    expect(getInterface(output, 'RenderTexture').properties).toMatchObject([
      { name: 'source', type: { kind: 'named', reference: { binding: { name: 'RenderTarget' } } } },
    ]);
  });

  it('flattens Pick and Omit heritage over imported package-owned structures', () => {
    const signals = lowerInPackage(
      '@flighthq/model',
      'model',
      'signals.ts',
      'export interface Signals { key: string; pointer: number; text: string; }',
    );
    const source = lowerInPackage(
      '@flighthq/model',
      'model',
      'source.ts',
      `
        import type { Signals } from './signals';
        export interface Keyboard extends Pick<Signals, 'key' | 'text'> {}
        export interface WithoutPointer extends Omit<Signals, 'pointer'> {}
      `,
    );
    const output = lowerIrModuleWithCompilerPasses(source, [
      createCompilerLoweringPassInterfaceInheritance([source, signals]),
    ]);

    expect(getInterface(output, 'Keyboard').properties.map((property) => property.name)).toEqual(['key', 'text']);
    expect(getInterface(output, 'WithoutPointer').properties.map((property) => property.name)).toEqual(['key', 'text']);
  });

  it('erases ambient utility heritage only through an explicit target policy', () => {
    const module = lower(
      'ambient-pick.ts',
      "export interface Context extends Pick<WebGL2RenderingContext, 'clear'> {}",
    );

    expect(() =>
      lowerIrModuleWithCompilerPasses(module, [createCompilerLoweringPassInterfaceInheritance([module])]),
    ).toThrow('inherits a nonlocal interface that cannot be structurally resolved');

    const output = lowerIrModuleWithCompilerPasses(module, [
      createCompilerLoweringPassInterfaceInheritance([module], undefined, {
        eraseAmbientUtilityHeritage: (reference, declaration) =>
          declaration.binding.name === 'Context' &&
          reference.reference.kind === 'ambient' &&
          reference.reference.name === 'Pick',
      }),
    ]);

    expect(getInterface(output, 'Context')).toMatchObject({ extends: [], properties: [] });
  });

  it('flattens Partial heritage over a local generic structure', () => {
    const module = lower(
      'partial-heritage.ts',
      `
        interface Base<Value> { required: Value; readonly stable: string; }
        export interface Optional extends Partial<Base<number>> { own: boolean; }
      `,
    );
    const output = lowerIrModuleWithCompilerPasses(module, [createCompilerLoweringPassInterfaceInheritance([module])]);

    expect(getInterface(output, 'Optional')).toMatchObject({
      extends: [],
      properties: [
        { name: 'required', optional: true, readonly: false, type: { kind: 'primitive', name: 'number' } },
        { name: 'stable', optional: true, readonly: true, type: { kind: 'primitive', name: 'string' } },
        { name: 'own', optional: false, readonly: false, type: { kind: 'primitive', name: 'boolean' } },
      ],
    });
  });

  it('deduplicates identical diamonds and refuses unresolved, cyclic, arity, and incompatible heritage', () => {
    const module = lower(
      'failures.ts',
      `
        type Alias = string;
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
          typeArguments: [],
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
      [unavailable, 'heritage type alias Alias is not object-shaped'],
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

  it('rebinds inherited cross-module property types through direct type imports', () => {
    const detail = lowerInPackage(
      '@flighthq/model',
      'model',
      'detail.ts',
      'export interface Detail { value: number; }',
    );
    const base = lowerInPackage(
      '@flighthq/model',
      'model',
      'base.ts',
      "import type { Detail } from './detail'; export interface Base { detail: Detail; }",
    );
    const derived = lowerInPackage(
      '@flighthq/model',
      'model',
      'derived.ts',
      "import type { Base } from './base'; export interface Derived extends Base { active: boolean; }",
    );
    const output = lowerIrModuleWithCompilerPasses(
      derived,
      [createCompilerLoweringPassInterfaceInheritance([derived, base, detail])],
      { verificationDepth: 'idempotence' },
    );
    const inherited = getInterface(output, 'Derived').properties[0];

    expect(output.imports).toHaveLength(2);
    expect(output.imports[1]).toMatchObject({
      bindings: [{ imported: 'Detail', typeOnly: true }],
      specifier: './detail.js',
      typeOnly: true,
    });
    expect(inherited).toMatchObject({
      name: 'detail',
      type: { kind: 'named', reference: { binding: output.imports[1]!.bindings[0]!.binding, kind: 'binding' } },
    });
    expect(derived.imports).toHaveLength(1);
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

  it('flattens generic object and intersection type aliases used as heritage', () => {
    const module = lower(
      'alias-heritage.ts',
      `
        type Positioned<Value> = { value: Value };
        type Named = { label: string };
        type Model<Value> = Positioned<Value> & Named;
        export interface Derived extends Model<number> { active: boolean; }
      `,
    );
    const pass = createCompilerLoweringPassInterfaceInheritance([module]);

    const output = lowerIrModuleWithCompilerPasses(module, [pass], { verificationDepth: 'idempotence' });

    expect(getInterface(output, 'Derived')).toMatchObject({
      extends: [],
      properties: [
        { name: 'value', type: { kind: 'primitive', name: 'number' } },
        { name: 'label', type: { kind: 'primitive', name: 'string' } },
        { name: 'active', type: { kind: 'primitive', name: 'boolean' } },
      ],
    });
  });

  it('flattens the public instance shape of class heritage', () => {
    const module = lower(
      'class-heritage.ts',
      `
        class Base<Value> {
          value: Value;
          read(): Value { return this.value; }
        }
        export interface Derived extends Base<number> { active: boolean; }
      `,
    );
    const output = lowerIrModuleWithCompilerPasses(module, [createCompilerLoweringPassInterfaceInheritance([module])]);

    expect(getInterface(output, 'Derived')).toMatchObject({
      extends: [],
      properties: [
        { name: 'value', type: { kind: 'primitive', name: 'number' } },
        {
          name: 'read',
          type: { kind: 'function', parameters: [], returns: { kind: 'primitive', name: 'number' } },
        },
        { name: 'active', type: { kind: 'primitive', name: 'boolean' } },
      ],
    });
  });

  it('flattens class ancestry and overloads while ignoring static shape', () => {
    const module = lower(
      'class-heritage-overloads.ts',
      `
        class Parent { parent: string; }
        class Base extends Parent {
          static version: number;
          optional?: number;
          static create(): Base { return new Base(); }
          read(value: number): string;
          read(value: number, suffix?: string): string;
          read(value: number, suffix?: string, ...flags: boolean[]): string { return String(value); }
        }
        export interface Derived extends Base { active: boolean; }
      `,
    );
    const output = lowerIrModuleWithCompilerPasses(module, [createCompilerLoweringPassInterfaceInheritance([module])]);
    const derived = getInterface(output, 'Derived');

    expect(derived.properties.map((property) => property.name)).toEqual(['parent', 'optional', 'read', 'active']);
    expect(derived.properties.find((property) => property.name === 'read')).toMatchObject({
      type: { kind: 'intersection', types: [{ kind: 'function' }, { kind: 'function' }, { kind: 'function' }] },
    });
  });

  it('refuses class heritage whose nominal or accessor shape cannot be represented structurally', () => {
    const nominal = lower(
      'nominal-class-heritage.ts',
      'class Base { private secret: number = 0; } export interface Derived extends Base {}',
    );
    const accessor = lower(
      'accessor-class-heritage.ts',
      'class Base { get value(): number { return 1; } } export interface Derived extends Base {}',
    );

    expect(() =>
      lowerIrModuleWithCompilerPasses(nominal, [createCompilerLoweringPassInterfaceInheritance([nominal])]),
    ).toThrow('class Base heritage has nominal field secret');
    expect(() =>
      lowerIrModuleWithCompilerPasses(accessor, [createCompilerLoweringPassInterfaceInheritance([accessor])]),
    ).toThrow('class Base heritage has unsupported method value');
  });

  it('refuses a nonstructural local declaration used as interface heritage', () => {
    const module = lower('enum-heritage.ts', 'enum Kind { Value } export interface Derived extends Kind {}');

    expect(() =>
      lowerIrModuleWithCompilerPasses(module, [createCompilerLoweringPassInterfaceInheritance([module])]),
    ).toThrow('inherits unavailable interface Kind');
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

  it('rejects malformed module graphs before flattening heritage', () => {
    const subject = lower('subject.ts', 'export interface Subject {}');
    const duplicate = lowerInPackage('@flighthq/model', 'model', 'duplicate.ts', 'export interface Duplicate {}');
    const duplicateModulePass = createCompilerLoweringPassInterfaceInheritance([
      subject,
      duplicate,
      structuredClone(duplicate),
    ]);

    expect(() => duplicateModulePass.lowerIrModule(subject)).toThrow(
      'Interface inheritance module set contains a duplicate module identity',
    );

    const malformed = {
      ...subject,
      declarations: [...subject.declarations, subject.declarations[0]!],
    };
    const duplicateDeclarationPass = createCompilerLoweringPassInterfaceInheritance([malformed]);

    expect(() => duplicateDeclarationPass.lowerIrModule(malformed)).toThrow(
      'Interface inheritance module contains a duplicate structural declaration identity',
    );
  });

  it('terminates cyclic star exports and relative imports that escape the package root', () => {
    const first = lowerInPackage('@flighthq/model', 'model', 'first.ts', "export * from './second.js';");
    const second = lowerInPackage('@flighthq/model', 'model', 'second.ts', "export * from './first.js';");
    const cyclicConsumer = lowerInPackage(
      '@flighthq/model',
      'model',
      'cyclic-consumer.ts',
      "import type { Missing } from './first.js'; export interface Derived extends Missing {}",
    );
    expect(() =>
      lowerIrModuleWithCompilerPasses(cyclicConsumer, [
        createCompilerLoweringPassInterfaceInheritance([cyclicConsumer, first, second]),
      ]),
    ).toThrow('inherits unavailable interface Missing');

    const escapedConsumer = lowerInPackage(
      '@flighthq/model',
      'model',
      'escaped-consumer.ts',
      "import type { Missing } from '../../../../../../missing.js'; export interface Derived extends Missing {}",
    );
    expect(() =>
      lowerIrModuleWithCompilerPasses(escapedConsumer, [
        createCompilerLoweringPassInterfaceInheritance([escapedConsumer]),
      ]),
    ).toThrow('inherits unavailable interface Missing');
  });

  it('refuses malformed qualified namespace heritage references', () => {
    const base = lowerInPackage('@flighthq/model', 'model', 'base.ts', 'export interface Base {}');
    const derived = lowerInPackage(
      '@flighthq/model',
      'model',
      'derived.ts',
      "import type * as Shared from './base.js'; export interface Derived extends Shared.Base {}",
    );
    const declaration = getInterface(derived, 'Derived');
    const malformed = replaceInterface(derived, declaration, {
      extends: [
        {
          ...declaration.extends[0]!,
          reference: { ...declaration.extends[0]!.reference, path: ['Base', 'Nested'] },
        } as IrTypeReference,
      ],
    });

    expect(() =>
      lowerIrModuleWithCompilerPasses(malformed, [createCompilerLoweringPassInterfaceInheritance([malformed, base])]),
    ).toThrow('inherits unavailable interface Shared');
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
