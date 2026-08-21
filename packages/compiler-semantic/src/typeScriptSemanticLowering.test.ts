import ts from 'typescript';

import type { IrBindingIdentity, IrExpression } from '../../compiler-types/src/index.js';
import { lowerTypeScriptSource } from './typeScriptSemanticLowering.js';

function lower(file: string, source: string) {
  const sourceFile = ts.createSourceFile(`/flight/packages/math/src/${file}`, source, ts.ScriptTarget.Latest, true);
  return lowerTypeScriptSource(sourceFile, {
    packageName: '@flighthq/math',
    upstreamDirectory: '/flight',
  });
}

describe('lowerTypeScriptSource', () => {
  it('resolves enum auto-increment values after explicit discriminants', () => {
    const result = lower('mode.ts', 'export enum Mode { A = 1, B, C = Mode.A << 3, D }');

    expect(result.diagnostics).toEqual([]);
    expect(result.module.declarations[0]).toMatchObject({
      kind: 'enum',
      members: [
        { name: 'A', value: 1 },
        { name: 'B', value: 2 },
        { name: 'C', value: 8 },
        { name: 'D', value: 9 },
      ],
    });
  });

  it('preserves string enum representation in the neutral IR', () => {
    const result = lower('kind.ts', "export enum Kind { A = 'a', B = 'b' }");

    expect(result.module.declarations[0]).toMatchObject({
      kind: 'enum',
      members: [
        { name: 'A', value: 'a' },
        { name: 'B', value: 'b' },
      ],
    });
  });

  it('evaluates the complete supported enum constant algebra and rejects invalid neighbors', () => {
    const evaluated = lower(
      'enum-constants.ts',
      `
        export enum Operations {
          Base = 8,
          Copied = Base,
          Qualified = Operations.Copied,
          Parenthesized = (Qualified),
          Negative = -Base,
          Positive = +Base,
          Add = Base + 2,
          Subtract = Base - 2,
          Multiply = Base * 2,
          Divide = Base / 2,
          Remainder = Base % 3,
          Power = Base ** 2,
          LeftShift = Base << 1,
          RightShift = Base >> 1,
          UnsignedShift = -1 >>> 1,
          And = Base & 3,
          Or = Base | 2,
          Xor = Base ^ 3,
          Separated = 1_024,
          Template = \`template\`,
        }
      `,
    );

    expect(evaluated.diagnostics).toEqual([]);
    expect(evaluated.module.declarations[0]).toMatchObject({
      kind: 'enum',
      members: [
        { name: 'Base', value: 8 },
        { name: 'Copied', value: 8 },
        { name: 'Qualified', value: 8 },
        { name: 'Parenthesized', value: 8 },
        { name: 'Negative', value: -8 },
        { name: 'Positive', value: 8 },
        { name: 'Add', value: 10 },
        { name: 'Subtract', value: 6 },
        { name: 'Multiply', value: 16 },
        { name: 'Divide', value: 4 },
        { name: 'Remainder', value: 2 },
        { name: 'Power', value: 64 },
        { name: 'LeftShift', value: 16 },
        { name: 'RightShift', value: 4 },
        { name: 'UnsignedShift', value: 2_147_483_647 },
        { name: 'And', value: 0 },
        { name: 'Or', value: 10 },
        { name: 'Xor', value: 11 },
        { name: 'Separated', value: 1_024 },
        { name: 'Template', value: 'template' },
      ],
    });

    const rejected = lower(
      'invalid-enums.ts',
      `
        export enum Text { First = 'first', Missing }
        export enum Forward { First = Forward.Later, Later = 1 }
        export enum Call { Value = Number() }
        export enum Valid { Value = 1 }
      `,
    );

    expect(rejected.module.declarations).toHaveLength(1);
    expect(rejected.module.declarations[0]).toMatchObject({ kind: 'enum', binding: { name: 'Valid' } });
    expect(rejected.diagnostics.map((diagnostic) => diagnostic.message)).toEqual([
      'enum member after a string value requires an initializer',
      'enum initializer must be a constant number, string, or prior member reference',
      'enum initializer must be a constant number, string, or prior member reference',
    ]);
  });

  it('attaches ordered overload signatures and diagnoses an orphan overload set', () => {
    const result = lower(
      'overloads.ts',
      `
        export function convert(value: string): string;
        export function convert(value: number, radix?: number): number;
        export function convert(value: string | number, radix = 10): string | number { return value; }
        export function orphan(value: boolean): boolean;
      `,
    );
    const [convert] = result.module.declarations;
    if (convert?.kind !== 'function') throw new Error('Expected the implemented overloaded function');

    expect(
      convert.overloads.map((overload) => ({
        parameters: overload.parameters.map((parameter) => ({
          name: parameter.binding.name,
          optional: parameter.optional,
          rest: parameter.rest,
          type: parameter.type,
        })),
        returns: overload.returns,
      })),
    ).toEqual([
      {
        parameters: [{ name: 'value', optional: false, rest: false, type: { kind: 'primitive', name: 'string' } }],
        returns: { kind: 'primitive', name: 'string' },
      },
      {
        parameters: [
          { name: 'value', optional: false, rest: false, type: { kind: 'primitive', name: 'number' } },
          { name: 'radix', optional: true, rest: false, type: { kind: 'primitive', name: 'number' } },
        ],
        returns: { kind: 'primitive', name: 'number' },
      },
    ]);
    expect(convert.parameters[1]).toMatchObject({
      initializer: { kind: 'literal', value: 10 },
      optional: true,
      rest: false,
    });
    expect(result.module.declarations).toHaveLength(1);
    expect(result.diagnostics.map((diagnostic) => diagnostic.message)).toEqual([
      'function overload orphan has no implementation (1 signature(s))',
    ]);
  });

  it('represents re-exports and default exports instead of silently skipping them', () => {
    const result = lower(
      'barrel.ts',
      "export { thing as value } from './thing.js'; export * from './other.js'; export default 1;",
    );

    expect(result.module.exports).toEqual([
      { exported: 'value', imported: 'thing', kind: 'reexport', specifier: './thing.js', typeOnly: false },
      { kind: 'all', specifier: './other.js', typeOnly: false },
      { expression: { kind: 'literal', value: 1 }, kind: 'default' },
    ]);
  });

  it('represents every export topology and isolates rejected export statements', () => {
    const topology = lower(
      'export-topology.ts',
      `
        export type { Remote as PublicRemote } from './remote.js';
        export * as namespace from './namespace.js';
        export type * from './types.js';
      `,
    );

    expect(topology.diagnostics).toEqual([]);
    expect(topology.module.exports).toEqual([
      {
        exported: 'PublicRemote',
        imported: 'Remote',
        kind: 'reexport',
        specifier: './remote.js',
        typeOnly: true,
      },
      { exported: 'namespace', kind: 'namespace', specifier: './namespace.js', typeOnly: false },
      { kind: 'all', specifier: './types.js', typeOnly: true },
    ]);

    const defaultFunction = lower('default-function.ts', 'export default function create(): number { return 1; }');
    const functionDeclaration = defaultFunction.module.declarations[0];
    if (functionDeclaration?.kind !== 'function') throw new Error('Expected a default function declaration');
    expect(defaultFunction.module.exports).toEqual([
      {
        binding: functionDeclaration.binding,
        exported: 'default',
        kind: 'local',
        typeOnly: false,
      },
    ]);

    const defaultClass = lower('default-class.ts', 'export default class Box {}');
    const classDeclaration = defaultClass.module.declarations[0];
    if (classDeclaration?.kind !== 'class') throw new Error('Expected a default class declaration');
    expect(defaultClass.module.exports).toEqual([
      {
        binding: classDeclaration.binding,
        exported: 'default',
        kind: 'local',
        typeOnly: false,
      },
    ]);

    const rejected = lower(
      'rejected-exports.ts',
      'const value = 1; export = value; export { missing }; export default value;',
    );
    expect(rejected.diagnostics.map((diagnostic) => diagnostic.message)).toEqual([
      'export = assignments are not ECMAScript exports',
      'export binding missing cannot be resolved',
    ]);
    expect(rejected.module.exports).toEqual([
      {
        expression: {
          kind: 'identifier',
          reference: { binding: getVariableBinding(rejected.module.declarations[0]), kind: 'binding' },
        },
        kind: 'default',
      },
    ]);
  });

  it('links type-only local exports to their source-backed declaration identity', () => {
    const result = lower('types.ts', 'type Value = number; export type { Value };');

    expect(result.diagnostics).toEqual([]);
    expect(result.module.exports).toEqual([
      {
        binding: expect.objectContaining({ kind: 'typeAlias', name: 'Value', scope: 'module' }),
        exported: 'Value',
        kind: 'local',
        typeOnly: true,
      },
    ]);
  });

  it('diagnoses constructor overloads and parameter properties without partial class IR', () => {
    const overloads = lower(
      'point.ts',
      'export class Point { constructor(a: number); constructor(a: string); constructor(x: number | string) {} }',
    );
    const parameterProperty = lower('value.ts', 'export class Value { constructor(public readonly value: number) {} }');

    expect(overloads.module.declarations).toEqual([]);
    expect(overloads.diagnostics[0]?.message).toContain('constructor overloads');
    expect(parameterProperty.module.declarations).toEqual([]);
    expect(parameterProperty.diagnostics[0]?.message).toContain('parameter properties');
  });

  it('returns stable globally identified one-based diagnostics', () => {
    const result = lower('namespace.ts', 'export namespace Values {}');

    expect(result.diagnostics).toEqual([
      {
        code: 'unsupported-typescript',
        column: 1,
        line: 1,
        message: 'namespace declarations are not represented in the neutral IR yet',
        packageName: '@flighthq/math',
        source: 'packages/math/src/namespace.ts',
      },
    ]);
  });

  it('uses per-declarator fingerprints and lowers negative literal types', () => {
    const result = lower('values.ts', 'export const a = 1, b = 2; export type Sign = -1 | 0 | 1;');
    const [a, b, sign] = result.module.declarations;

    expect(a?.origin.fingerprint).not.toBe(b?.origin.fingerprint);
    expect(sign).toMatchObject({ kind: 'typeAlias', type: { kind: 'union' } });
    if (sign?.kind !== 'typeAlias' || sign.type.kind !== 'union') throw new Error('Expected union type alias');
    expect(sign.type.types[0]).toEqual({ kind: 'literal', value: -1 });
  });

  it('maps every atomic and literal TypeScript type to its neutral domain', () => {
    const result = lower(
      'atomic-types.ts',
      `
        export type AnyValue = any;
        export type UnknownValue = unknown;
        export type ObjectValue = object;
        export type ThisValue = this;
        export type NeverValue = never;
        export type UndefinedValue = undefined;
        export type BooleanValue = boolean;
        export type NumberValue = number;
        export type BigIntValue = bigint;
        export type StringValue = string;
        export type SymbolValue = symbol;
        export type VoidValue = void;
        export type NullValue = null;
        export type TextValue = 'text';
        export type NumericValue = 12;
        export type NegativeValue = -12;
        export type TrueValue = true;
        export type FalseValue = false;
      `,
    );

    expect(result.diagnostics).toEqual([]);
    expect(
      result.module.declarations.map((declaration) => {
        if (declaration.kind !== 'typeAlias') throw new Error('Expected only type-alias declarations');
        return [declaration.binding.name, declaration.type];
      }),
    ).toEqual([
      ['AnyValue', { kind: 'unknown', source: 'any' }],
      ['UnknownValue', { kind: 'unknown', source: 'unknown' }],
      ['ObjectValue', { kind: 'unknown', source: 'object' }],
      ['ThisValue', { kind: 'unknown', source: 'this' }],
      ['NeverValue', { kind: 'never' }],
      ['UndefinedValue', { kind: 'undefined' }],
      ['BooleanValue', { kind: 'primitive', name: 'boolean' }],
      ['NumberValue', { kind: 'primitive', name: 'number' }],
      ['BigIntValue', { kind: 'primitive', name: 'bigint' }],
      ['StringValue', { kind: 'primitive', name: 'string' }],
      ['SymbolValue', { kind: 'primitive', name: 'symbol' }],
      ['VoidValue', { kind: 'primitive', name: 'void' }],
      ['NullValue', { kind: 'null' }],
      ['TextValue', { kind: 'literal', value: 'text' }],
      ['NumericValue', { kind: 'literal', value: 12 }],
      ['NegativeValue', { kind: 'literal', value: -12 }],
      ['TrueValue', { kind: 'literal', value: true }],
      ['FalseValue', { kind: 'literal', value: false }],
    ]);
  });

  it('preserves composite type cardinality, readonly state, and function structure', () => {
    const result = lower(
      'composite-types.ts',
      `
        export type MutableArray = number[];
        export type GenericArray = Array<string>;
        export type ReadonlyGenericArray = ReadonlyArray<boolean>;
        export type MutableTuple = [number, label?: string, ...values: boolean[]];
        export type ReadonlyTuple = readonly [number, string];
        export type UnionValue = number | string | boolean;
        export type IntersectionValue = { left: number } & { right: string };
        export type Callback = <T extends string | number = string>(
          this: object,
          value: T,
          optional?: number,
          ...flags: boolean[]
        ) => T;
        export type Shape = {
          readonly value?: number;
          convert<T>(input: T): T;
        };
      `,
    );
    const types = new Map(
      result.module.declarations.map((declaration) => {
        if (declaration.kind !== 'typeAlias') throw new Error('Expected only type-alias declarations');
        return [declaration.binding.name, declaration.type] as const;
      }),
    );

    expect(result.diagnostics).toEqual([]);
    expect(types.get('MutableArray')).toEqual({
      element: { kind: 'primitive', name: 'number' },
      kind: 'array',
      readonly: false,
    });
    expect(types.get('GenericArray')).toEqual({
      element: { kind: 'primitive', name: 'string' },
      kind: 'array',
      readonly: false,
    });
    expect(types.get('ReadonlyGenericArray')).toEqual({
      element: { kind: 'primitive', name: 'boolean' },
      kind: 'array',
      readonly: true,
    });
    expect(types.get('MutableTuple')).toEqual({
      elements: [
        { optional: false, rest: false, type: { kind: 'primitive', name: 'number' } },
        { optional: true, rest: false, type: { kind: 'primitive', name: 'string' } },
        {
          optional: false,
          rest: true,
          type: { element: { kind: 'primitive', name: 'boolean' }, kind: 'array', readonly: false },
        },
      ],
      kind: 'tuple',
      readonly: false,
    });
    expect(types.get('ReadonlyTuple')).toEqual({
      elements: [
        { optional: false, rest: false, type: { kind: 'primitive', name: 'number' } },
        { optional: false, rest: false, type: { kind: 'primitive', name: 'string' } },
      ],
      kind: 'tuple',
      readonly: true,
    });
    expect(types.get('UnionValue')).toEqual({
      kind: 'union',
      types: [
        { kind: 'primitive', name: 'number' },
        { kind: 'primitive', name: 'string' },
        { kind: 'primitive', name: 'boolean' },
      ],
    });
    expect(types.get('IntersectionValue')).toEqual({
      kind: 'intersection',
      types: [
        {
          kind: 'object',
          properties: [{ name: 'left', optional: false, readonly: false, type: { kind: 'primitive', name: 'number' } }],
        },
        {
          kind: 'object',
          properties: [
            { name: 'right', optional: false, readonly: false, type: { kind: 'primitive', name: 'string' } },
          ],
        },
      ],
    });
    expect(types.get('Callback')).toMatchObject({
      kind: 'function',
      parameters: [
        {
          name: 'value',
          optional: false,
          rest: false,
          type: { kind: 'named', reference: { binding: { name: 'T', space: 'type' }, kind: 'binding', path: [] } },
        },
        { name: 'optional', optional: true, rest: false, type: { kind: 'primitive', name: 'number' } },
        {
          name: 'flags',
          optional: false,
          rest: true,
          type: { element: { kind: 'primitive', name: 'boolean' }, kind: 'array', readonly: false },
        },
      ],
      returns: { kind: 'named', reference: { binding: { name: 'T', space: 'type' }, kind: 'binding', path: [] } },
      typeParameters: [
        {
          binding: { name: 'T', space: 'type' },
          constraint: {
            kind: 'union',
            types: [
              { kind: 'primitive', name: 'string' },
              { kind: 'primitive', name: 'number' },
            ],
          },
          default: { kind: 'primitive', name: 'string' },
        },
      ],
    });
    expect(types.get('Shape')).toMatchObject({
      kind: 'object',
      properties: [
        { name: 'value', optional: true, readonly: true, type: { kind: 'primitive', name: 'number' } },
        {
          name: 'convert',
          optional: false,
          readonly: true,
          type: {
            kind: 'function',
            parameters: [
              {
                name: 'input',
                optional: false,
                rest: false,
                type: { kind: 'named', reference: { binding: { name: 'T' }, kind: 'binding', path: [] } },
              },
            ],
            returns: { kind: 'named', reference: { binding: { name: 'T' }, kind: 'binding', path: [] } },
            typeParameters: [{ binding: { name: 'T', space: 'type' } }],
          },
        },
      ],
    });
  });

  it('preserves named and operator type identity while isolating unsupported type families', () => {
    const supported = lower(
      'referenced-types.ts',
      `
        export interface Box<T> { value: T; }
        export const sample = 1;
        export type Named = Box<number>;
        export type AmbientQualified = External.Box<string>;
        export type Key = keyof Box<number>;
        export type Indexed = Box<number>['value'];
        export type Query = typeof sample;
        export type Parenthesized = (((number)));
        export type NonCanonicalArray = Array<number, string>;
        export type AnonymousTuple = [number?, ...string[]];
        export type NamedRequiredTuple = [value: number];
        export type ReadonlyNamed = readonly Box<number>;
      `,
    );
    const [box, sample, ...aliases] = supported.module.declarations;
    if (box?.kind !== 'interface' || sample?.kind !== 'variable') {
      throw new Error('Expected the referenced type and value declarations');
    }
    const types = new Map(
      aliases.map((declaration) => {
        if (declaration.kind !== 'typeAlias') throw new Error('Expected type-alias declarations');
        return [declaration.binding.name, declaration.type] as const;
      }),
    );

    expect(supported.diagnostics).toEqual([]);
    expect(types.get('Named')).toMatchObject({
      kind: 'named',
      reference: { binding: box.binding, kind: 'binding', path: [] },
      typeArguments: [{ kind: 'primitive', name: 'number' }],
    });
    expect(types.get('AmbientQualified')).toEqual({
      kind: 'named',
      reference: { kind: 'ambient', name: 'External.Box' },
      typeArguments: [{ kind: 'primitive', name: 'string' }],
    });
    expect(types.get('Key')).toMatchObject({
      kind: 'keyof',
      type: {
        kind: 'named',
        reference: { binding: box.binding, kind: 'binding', path: [] },
        typeArguments: [{ kind: 'primitive', name: 'number' }],
      },
    });
    expect(types.get('Indexed')).toMatchObject({
      index: { kind: 'literal', value: 'value' },
      kind: 'indexedAccess',
      object: {
        kind: 'named',
        reference: { binding: box.binding, kind: 'binding', path: [] },
        typeArguments: [{ kind: 'primitive', name: 'number' }],
      },
    });
    expect(types.get('Query')).toEqual({
      kind: 'typeOf',
      reference: { binding: getVariableBinding(sample), kind: 'binding', path: [] },
    });
    expect(types.get('Parenthesized')).toEqual({ kind: 'primitive', name: 'number' });
    expect(types.get('NonCanonicalArray')).toEqual({
      kind: 'named',
      reference: { kind: 'ambient', name: 'Array' },
      typeArguments: [
        { kind: 'primitive', name: 'number' },
        { kind: 'primitive', name: 'string' },
      ],
    });
    expect(types.get('AnonymousTuple')).toEqual({
      elements: [
        { optional: true, rest: false, type: { kind: 'primitive', name: 'number' } },
        {
          optional: false,
          rest: true,
          type: { element: { kind: 'primitive', name: 'string' }, kind: 'array', readonly: false },
        },
      ],
      kind: 'tuple',
      readonly: false,
    });
    expect(types.get('NamedRequiredTuple')).toEqual({
      elements: [{ optional: false, rest: false, type: { kind: 'primitive', name: 'number' } }],
      kind: 'tuple',
      readonly: false,
    });
    expect(types.get('ReadonlyNamed')).toEqual(types.get('Named'));

    const rejected = lower(
      'unsupported-types.ts',
      `
        export type BigLiteral = 1n;
        export type Unique = unique symbol;
        export type Conditional<T> = T extends string ? true : false;
        export type Mapped<T> = { [K in keyof T]: T[K] };
        export type Constructor = new () => object;
        export type TemplateValue = \`value-${'${string}'}\`;
        export type CallableMember = { (value: number): number };
        export type MissingPropertyType = { value };
        export type ComputedProperty = { ['value']: number };
        export type Valid = number;
      `,
    );

    expect(rejected.module.declarations).toHaveLength(1);
    expect(rejected.module.declarations[0]).toMatchObject({ binding: { name: 'Valid' }, kind: 'typeAlias' });
    expect(rejected.diagnostics.map((diagnostic) => diagnostic.message)).toEqual([
      'unsupported literal type',
      'unsupported type operator unique',
      'unsupported type ConditionalType',
      'unsupported type MappedType',
      'unsupported type ConstructorType',
      'unsupported type TemplateLiteralType',
      'unsupported type member CallSignature',
      'property signature requires a type',
      'computed property names require expression-level representation',
    ]);
  });

  it('separates executable defaults from function types', () => {
    const result = lower('contracts.ts', 'export const callback = (value: number = 1): number => value;');
    const [callback] = result.module.declarations;

    expect(callback).toMatchObject({
      initializer: { kind: 'function', parameters: [{ initializer: { kind: 'literal', value: 1 } }] },
      kind: 'variable',
      type: { kind: 'function', parameters: [{ name: 'value', optional: true, rest: false }] },
    });
    if (
      callback?.kind !== 'variable' ||
      callback.type?.kind !== 'function' ||
      callback.initializer?.kind !== 'function'
    ) {
      throw new Error('Expected a function-valued variable');
    }
    expect(callback.type.parameters[0]).not.toHaveProperty('initializer');
    expect(callback.initializer.parameters[0]).toHaveProperty('initializer');
  });

  it('distinguishes absent and explicit class constructors', () => {
    const result = lower('constructors.ts', 'export class Implicit {} export class Explicit { constructor() {} }');
    const [implicit, explicit] = result.module.declarations;

    expect(implicit).toMatchObject({ binding: { name: 'Implicit' }, kind: 'class' });
    expect(implicit).not.toHaveProperty('classConstructor');
    expect(explicit).toMatchObject({
      binding: { name: 'Explicit' },
      classConstructor: { body: [], parameters: [] },
      kind: 'class',
    });
  });

  it('represents interface heritage as type references and structural members as properties', () => {
    const result = lower(
      'box.ts',
      'interface Base<Value> { readonly value: Value } export interface Box<Value> extends Base<Value> { get(): Value }',
    );
    const box = result.module.declarations[1];

    expect(box).toMatchObject({
      binding: { kind: 'interface', name: 'Box', space: 'type' },
      extends: [
        {
          kind: 'named',
          reference: { binding: { kind: 'interface', name: 'Base', space: 'type' }, kind: 'binding', path: [] },
          typeArguments: [
            {
              kind: 'named',
              reference: { binding: { kind: 'typeParameter', name: 'Value', space: 'type' }, kind: 'binding' },
            },
          ],
        },
      ],
      kind: 'interface',
      properties: [
        {
          name: 'get',
          optional: false,
          readonly: true,
          type: {
            kind: 'function',
            parameters: [],
            returns: {
              kind: 'named',
              reference: { binding: { kind: 'typeParameter', name: 'Value', space: 'type' }, kind: 'binding' },
            },
          },
        },
      ],
    });
    if (box?.kind !== 'interface') throw new Error('Expected Box interface');
    const parameter = box.typeParameters[0]?.binding;
    const heritageParameter = box.extends[0]?.typeArguments[0];
    const methodReturn = box.properties[0]?.type;
    if (
      heritageParameter?.kind !== 'named' ||
      methodReturn?.kind !== 'function' ||
      methodReturn.returns.kind !== 'named'
    ) {
      throw new Error('Expected type parameter references');
    }
    expect(heritageParameter.reference).toMatchObject({ binding: { id: parameter?.id }, kind: 'binding' });
    expect(methodReturn.returns.reference).toMatchObject({ binding: { id: parameter?.id }, kind: 'binding' });
  });

  it('resolves type-only imports, dual-space imports, and shadowed type parameters by identity', () => {
    const result = lower(
      'type-bindings.ts',
      "import type { Remote as Imported } from './types.js'; import { RemoteClass } from './classes.js'; type Alias = Imported; export function identity<Imported>(value: Imported, instance: RemoteClass): Imported { return value; }",
    );
    const typeImport = result.module.imports[0]?.bindings[0]?.binding;
    const dualImport = result.module.imports[1]?.bindings[0]?.binding;
    const [alias, identity] = result.module.declarations;

    expect(result.diagnostics).toEqual([]);
    expect(typeImport).toMatchObject({ kind: 'import', name: 'Imported', space: 'type' });
    expect(dualImport).toMatchObject({ kind: 'import', name: 'RemoteClass', space: 'value' });
    if (alias?.kind !== 'typeAlias' || identity?.kind !== 'function' || alias.type.kind !== 'named') {
      throw new Error('Expected alias and generic function declarations');
    }
    const typeParameter = identity.typeParameters[0]?.binding;
    const parameterType = identity.parameters[0]?.type;
    const instanceType = identity.parameters[1]?.type;
    expect(alias.type.reference).toMatchObject({ binding: { id: typeImport?.id }, kind: 'binding', path: [] });
    expect(typeParameter).toMatchObject({ kind: 'typeParameter', name: 'Imported', space: 'type' });
    expect(typeParameter?.id).not.toBe(typeImport?.id);
    if (parameterType?.kind !== 'named' || instanceType?.kind !== 'named' || identity.returns.kind !== 'named') {
      throw new Error('Expected named parameter and return types');
    }
    expect(parameterType.reference).toMatchObject({ binding: { id: typeParameter?.id }, kind: 'binding' });
    expect(identity.returns.reference).toMatchObject({ binding: { id: typeParameter?.id }, kind: 'binding' });
    expect(instanceType.reference).toMatchObject({ binding: { id: dualImport?.id }, kind: 'binding' });
  });

  it('preserves qualified type paths and restricts typeof queries to value-space identity', () => {
    const result = lower(
      'qualified-types.ts',
      "import type * as Types from './types.js'; const sample = 1; export type Remote = Types.Value; export type Sample = typeof sample;",
    );
    const imported = result.module.imports[0]?.bindings[0]?.binding;
    const [sample, remote, sampleType] = result.module.declarations;

    expect(result.diagnostics).toEqual([]);
    if (
      sample?.kind !== 'variable' ||
      remote?.kind !== 'typeAlias' ||
      remote.type.kind !== 'named' ||
      sampleType?.kind !== 'typeAlias' ||
      sampleType.type.kind !== 'typeOf'
    ) {
      throw new Error('Expected value, qualified type, and typeof declarations');
    }
    expect(remote.type.reference).toMatchObject({
      binding: { id: imported?.id, space: 'type' },
      kind: 'binding',
      path: ['Value'],
    });
    expect(sampleType.type.reference).toMatchObject({
      binding: { id: getVariableBinding(sample).id, space: 'value' },
      kind: 'binding',
      path: [],
    });
  });

  it('normalizes assignment, binary, prefix, postfix, and keyword operator families', () => {
    const result = lower(
      'operators.ts',
      'export function operators(value: number, other: number): number { value **= other; value++; --value; typeof value; return (value ** other, value ?? other); }',
    );
    const [operators] = result.module.declarations;

    expect(result.diagnostics).toEqual([]);
    expect(operators).toMatchObject({
      body: [
        { expression: { kind: 'assignment', operator: '**=' }, kind: 'expression' },
        { expression: { kind: 'unary', operator: '++', postfix: true }, kind: 'expression' },
        { expression: { kind: 'unary', operator: '--', postfix: false }, kind: 'expression' },
        { expression: { kind: 'unary', operator: 'typeof', postfix: false }, kind: 'expression' },
        {
          expression: {
            kind: 'binary',
            left: { kind: 'binary', operator: '**' },
            operator: ',',
            right: { kind: 'binary', operator: '??' },
          },
          kind: 'return',
        },
      ],
      kind: 'function',
    });
  });

  it('preserves static operator operand and result domains without target policy', () => {
    const result = lower(
      'operator-domains.ts',
      'export function domains(numberValue: number, text: string, flag: boolean, mystery: any): void { numberValue + numberValue; text + text; text + numberValue; !flag; !mystery; typeof numberValue; }',
    );
    const [domains] = result.module.declarations;

    expect(result.diagnostics).toEqual([]);
    expect(domains).toMatchObject({
      body: [
        {
          expression: {
            semantics: {
              left: { declared: 'number', flow: 'number' },
              result: 'number',
              right: { declared: 'number', flow: 'number' },
            },
          },
        },
        {
          expression: {
            semantics: {
              left: { declared: 'string', flow: 'string' },
              result: 'string',
              right: { declared: 'string', flow: 'string' },
            },
          },
        },
        {
          expression: {
            semantics: {
              left: { declared: 'string', flow: 'string' },
              result: 'string',
              right: { declared: 'number', flow: 'number' },
            },
          },
        },
        { expression: { semantics: { operand: { declared: 'boolean', flow: 'boolean' }, result: 'boolean' } } },
        { expression: { semantics: { operand: { declared: 'unknown', flow: 'unknown' }, result: 'boolean' } } },
        { expression: { semantics: { operand: { declared: 'number', flow: 'number' }, result: 'string' } } },
      ],
      kind: 'function',
    });
  });

  it('distinguishes declared operand domains from flow-narrowed checker domains', () => {
    const result = lower(
      'operator-narrowing.ts',
      `
        export function calculate(value: number | string, other: number | boolean): number {
          if (typeof value === 'number' && typeof other === 'number') {
            value += other;
            -value;
            return value + other;
          }
          return (value as number) + 1;
        }
      `,
    );
    const [calculate] = result.module.declarations;

    expect(result.diagnostics).toEqual([]);
    const narrowed = calculate?.kind === 'function' ? calculate.body[0] : undefined;
    const statements =
      narrowed?.kind === 'if' && narrowed.consequent.kind === 'block' ? narrowed.consequent.statements : [];
    const [assignment, unary, binary] = statements;
    if (
      assignment?.kind !== 'expression' ||
      assignment.expression.kind !== 'assignment' ||
      unary?.kind !== 'expression' ||
      unary.expression.kind !== 'unary' ||
      binary?.kind !== 'return' ||
      binary.expression?.kind !== 'binary'
    ) {
      throw new Error('Expected narrowed assignment, unary, and binary expressions');
    }
    expect([assignment.expression.semantics, unary.expression.semantics, binary.expression.semantics]).toEqual([
      {
        left: { declared: 'unknown', flow: 'number' },
        result: 'number',
        right: { declared: 'unknown', flow: 'number' },
      },
      { operand: { declared: 'unknown', flow: 'number' }, result: 'number' },
      {
        left: { declared: 'unknown', flow: 'number' },
        result: 'number',
        right: { declared: 'unknown', flow: 'number' },
      },
    ]);
    const asserted = calculate?.kind === 'function' ? calculate.body[1] : undefined;
    if (asserted?.kind !== 'return' || asserted.expression?.kind !== 'binary') {
      throw new Error('Expected asserted binary expression');
    }
    expect(asserted.expression.semantics).toEqual({
      left: { declared: 'unknown', flow: 'number' },
      result: 'number',
      right: { declared: 'number', flow: 'number' },
    });
  });

  it('preserves indexed receiver sets without target policy or union aliases', () => {
    const result = lower(
      'indexed-receivers.ts',
      'type Values = readonly number[]; type Mixed = Uint32Array | Uint16Array; export function read(array: Values, floats: Float32Array, mixed: Mixed, record: { value: number }, text: string, mystery: any): unknown[] { return [array[0], floats[0], mixed[0], record["value"], text[0], mystery[0]]; }',
    );
    const [, , read] = result.module.declarations;

    expect(result.diagnostics).toEqual([]);
    if (read?.kind !== 'function' || read.body[0]?.kind !== 'return' || read.body[0].expression?.kind !== 'array') {
      throw new Error('Expected indexed receiver expressions');
    }
    expect(
      read.body[0].expression.elements.map((element) =>
        element?.kind === 'element' ? element.semantics.receivers : undefined,
      ),
    ).toEqual([['array'], ['float32Array'], ['uint16Array', 'uint32Array'], ['object'], ['string'], ['unknown']]);
  });

  it('identifies typed-array set calls from receiver semantics rather than member spelling', () => {
    const result = lower(
      'typed-array-set.ts',
      'type Buffers = Uint8Array | Float32Array; interface Custom { set(values: number[]): void } export function copy(target: Buffers, big: BigInt64Array, custom: Custom, array: number[], source: number[]): void { target.set(source); big["set"](source); custom.set(source); array["set"](source); target.subarray(); }',
    );
    const [, , copy] = result.module.declarations;

    expect(result.diagnostics).toEqual([]);
    if (copy?.kind !== 'function') throw new Error('Expected typed-array copy function');
    expect(
      copy.body.map((statement) =>
        statement.kind === 'expression' && statement.expression.kind === 'call'
          ? statement.expression.semantics
          : undefined,
      ),
    ).toEqual([
      { typedArraySet: { receivers: ['float32Array', 'uint8Array'] } },
      { typedArraySet: { receivers: ['bigInt64Array'] } },
      {},
      {},
      {},
    ]);
  });

  it('resolves deterministic identities through module, lexical, closure, import, class, and control-flow scopes', () => {
    const source = `
      import { external as imported } from './dependency.js';
      const value = 1;
      export { value as exportedValue };
      export function read(value: number, values: number[]): number {
        const local = value;
        {
          const value = local;
          const closure = (): number => value;
        }
        for (const value of values) { value; }
        const undefined = local;
        try { throw Error; } catch (error) { return error ? imported : undefined; }
      }
      export class Holder {
        read(value: number): Holder { value; return this; }
      }
    `;
    const result = lower('bindings.ts', source);
    const [moduleValue, read, holder] = result.module.declarations;

    expect(result.diagnostics).toEqual([]);
    if (moduleValue?.kind !== 'variable' || read?.kind !== 'function' || holder?.kind !== 'class') {
      throw new Error('Expected value, function, and class declarations');
    }
    const imported = result.module.imports[0]?.bindings[0]?.binding;
    const localExport = result.module.exports[0];
    expect(imported).toMatchObject({ kind: 'import', name: 'imported', scope: 'module' });
    expect(localExport).toMatchObject({
      binding: { id: getVariableBinding(moduleValue).id },
      exported: 'exportedValue',
      kind: 'local',
    });
    expect(getVariableBinding(moduleValue)).toMatchObject({
      kind: 'variable',
      name: 'value',
      packageName: '@flighthq/math',
      scope: 'module',
      source: 'packages/math/src/bindings.ts',
    });
    expect(read.binding.id).not.toBe(getVariableBinding(moduleValue).id);

    const [valueParameter, valuesParameter] = read.parameters;
    const [localStatement, nestedStatement, loopStatement, undefinedStatement, tryStatement] = read.body;
    if (
      !valueParameter ||
      !valuesParameter ||
      localStatement?.kind !== 'variable' ||
      nestedStatement?.kind !== 'block' ||
      loopStatement?.kind !== 'forOf' ||
      undefinedStatement?.kind !== 'variable' ||
      tryStatement?.kind !== 'try'
    ) {
      throw new Error('Expected binding coverage statements');
    }
    const local = localStatement.declarations[0]!;
    expect(bindingReference(local.initializer).id).toBe(valueParameter.binding.id);

    const [shadowStatement, closureStatement] = nestedStatement.statements;
    if (shadowStatement?.kind !== 'variable' || closureStatement?.kind !== 'variable') {
      throw new Error('Expected nested shadow and closure variables');
    }
    const shadow = shadowStatement.declarations[0]!;
    const closure = closureStatement.declarations[0]?.initializer;
    expect(bindingReference(shadow.initializer).id).toBe(getVariableBinding(local).id);
    expect(getVariableBinding(shadow).id).not.toBe(valueParameter.binding.id);
    if (closure?.kind !== 'function' || !closure.expression) throw new Error('Expected expression-bodied closure');
    expect(bindingReference(closure.expression).id).toBe(getVariableBinding(shadow).id);

    expect(bindingReference(loopStatement.iterable).id).toBe(valuesParameter.binding.id);
    if (loopStatement.body.kind !== 'block' || loopStatement.body.statements[0]?.kind !== 'expression') {
      throw new Error('Expected loop expression body');
    }
    expect(bindingReference(loopStatement.body.statements[0].expression).id).toBe(
      getVariableBinding(loopStatement.variable).id,
    );

    const undefinedVariable = undefinedStatement.declarations[0]!;
    expect(getVariableBinding(undefinedVariable)).toMatchObject({
      kind: 'variable',
      name: 'undefined',
      scope: 'block',
    });
    expect(bindingReference(undefinedVariable.initializer).id).toBe(getVariableBinding(local).id);
    if (!tryStatement.catchClause || tryStatement.catchClause.body.kind !== 'block') {
      throw new Error('Expected catch clause');
    }
    if (tryStatement.tryBody.kind !== 'block' || tryStatement.tryBody.statements[0]?.kind !== 'throw') {
      throw new Error('Expected try throw statement');
    }
    expect(ambientReference(tryStatement.tryBody.statements[0].expression)).toBe('Error');
    const returned = tryStatement.catchClause.body.statements[0];
    if (returned?.kind !== 'return' || returned.expression?.kind !== 'conditional') {
      throw new Error('Expected conditional catch return');
    }
    expect(bindingReference(returned.expression.condition).id).toBe(tryStatement.catchClause.binding?.id);
    expect(bindingReference(returned.expression.whenTrue).id).toBe(imported?.id);
    expect(bindingReference(returned.expression.whenFalse).id).toBe(getVariableBinding(undefinedVariable).id);

    const method = holder.methods[0];
    if (!method || method.body[0]?.kind !== 'expression' || method.body[1]?.kind !== 'return') {
      throw new Error('Expected class method binding references');
    }
    expect(bindingReference(method.body[0].expression).id).toBe(method.parameters[0]?.binding.id);
    expect(method.body[1].expression).toEqual({ kind: 'identifier', reference: { kind: 'this' } });
    expect(lower('bindings.ts', source).module).toEqual(result.module);
  });

  it('preserves fixed, omitted, nested, defaulted, rest, hoisted, and iteration array bindings', () => {
    const source = `
      export function unpack(
        input: [number | undefined, string, [number | undefined], ...boolean[]],
        rows: number[][],
        fallback: number,
      ): number {
        const [first = fallback, , [nested = first], ...rest]: [
          number | undefined,
          string,
          [number | undefined],
          ...boolean[],
        ] = input;
        var [hoisted] = input;
        for (const [head, ...tail] of rows) { return head + tail.length; }
        return nested + hoisted + rest.length;
      }
    `;
    const result = lower('array-bindings.ts', source);
    const declaration = result.module.declarations[0];
    if (declaration?.kind !== 'function') throw new Error('Expected function declaration');
    const [fixedStatement, hoistedStatement, loopStatement] = declaration.body;
    if (
      fixedStatement?.kind !== 'variable' ||
      hoistedStatement?.kind !== 'variable' ||
      loopStatement?.kind !== 'forOf'
    ) {
      throw new Error('Expected fixed, hoisted, and iteration bindings');
    }
    const fixed = fixedStatement.declarations[0];
    const hoisted = hoistedStatement.declarations[0];
    if (!fixed || !('pattern' in fixed) || !hoisted || !('pattern' in hoisted)) {
      throw new Error('Expected array binding patterns');
    }
    if (!('pattern' in loopStatement.variable)) throw new Error('Expected iteration binding pattern');
    const first = fixed.pattern.kind === 'array' ? fixed.pattern.elements[0] : undefined;
    const nestedPattern = fixed.pattern.kind === 'array' ? fixed.pattern.elements[2]?.pattern : undefined;
    const nested = nestedPattern?.kind === 'array' ? nestedPattern.elements[0] : undefined;
    if (first?.pattern.kind !== 'binding' || nested?.pattern.kind !== 'binding') {
      throw new Error('Expected named fixed and nested binding leaves');
    }
    const fallback = declaration.parameters[2]?.binding;

    expect(result.diagnostics).toEqual([]);
    expect(fixed).toMatchObject({
      initializer: { kind: 'identifier', reference: { binding: declaration.parameters[0]?.binding, kind: 'binding' } },
      mutable: false,
      pattern: {
        elements: [
          {
            initializer: { kind: 'identifier', reference: { binding: fallback, kind: 'binding' } },
            pattern: { binding: { kind: 'variable', name: 'first', scope: 'block' }, kind: 'binding' },
          },
          undefined,
          {
            pattern: {
              elements: [
                {
                  initializer: {
                    kind: 'identifier',
                    reference: { binding: first.pattern.binding, kind: 'binding' },
                  },
                  pattern: { binding: { kind: 'variable', name: 'nested', scope: 'block' }, kind: 'binding' },
                },
              ],
              kind: 'array',
              scope: 'block',
            },
          },
        ],
        kind: 'array',
        rest: { binding: { kind: 'variable', name: 'rest', scope: 'block' }, kind: 'binding' },
        scope: 'block',
      },
      type: { elements: expect.any(Array), kind: 'tuple', readonly: false },
    });
    expect(nested.initializer).toMatchObject({
      kind: 'identifier',
      reference: { binding: first.pattern.binding, kind: 'binding' },
    });
    expect(hoisted).toMatchObject({
      mutable: true,
      pattern: {
        elements: [{ pattern: { binding: { name: 'hoisted', scope: 'function' }, kind: 'binding' } }],
        kind: 'array',
        scope: 'function',
      },
    });
    expect(loopStatement.variable).toMatchObject({
      mutable: false,
      pattern: {
        elements: [{ pattern: { binding: { name: 'head', scope: 'block' }, kind: 'binding' } }],
        kind: 'array',
        rest: { binding: { name: 'tail', scope: 'block' }, kind: 'binding' },
        scope: 'block',
      },
    });
    expect(loopStatement.variable.initializer).toBeUndefined();
    expect(first.pattern.binding.id).not.toBe(nested.pattern.binding.id);
    expect(first.pattern.binding.fingerprint).toMatch(/^sha256:[\da-f]{64}$/u);
    expect(lower('array-bindings.ts', source).module).toEqual(result.module);
  });

  it('diagnoses object and invalid rest binding patterns while continuing with later declarations', () => {
    const object = lower(
      'object-bindings.ts',
      'const { rejected } = { rejected: 1 }; const [kept] = [2]; export { kept as retained };',
    );
    const rest = lower('rest-binding.ts', 'const [...values = []] = [];');

    expect(object.diagnostics.map((diagnostic) => diagnostic.message)).toEqual([
      'object binding patterns are not represented in the neutral IR yet',
    ]);
    expect(object.module.declarations).toHaveLength(1);
    expect(object.module.declarations[0]).toMatchObject({
      kind: 'variable',
      pattern: {
        elements: [{ pattern: { binding: { name: 'kept' }, kind: 'binding' } }],
        kind: 'array',
      },
    });
    expect(object.module.exports).toMatchObject([
      {
        binding: { name: 'kept', scope: 'module' },
        exported: 'retained',
        kind: 'local',
        typeOnly: false,
      },
    ]);
    expect(rest.module.declarations).toEqual([]);
    expect(rest.diagnostics.map((diagnostic) => diagnostic.message)).toEqual([
      'array binding rest cannot have a default initializer',
    ]);
  });

  it('classifies module, declaration, function, and block binding scopes without collapsing hoisted variables', () => {
    const result = lower(
      'scopes.ts',
      `
        export function scopes<T>(input: T): T {
          {
            var lifted = input;
            let block = input;
            const fixed = block;
          }
          return lifted;
        }
        export class Box<T> {
          read<U>(value: U): T { return value as unknown as T; }
        }
      `,
    );
    const [scopes, box] = result.module.declarations;
    if (scopes?.kind !== 'function' || box?.kind !== 'class') throw new Error('Expected function and class');
    const nested = scopes.body[0];
    if (nested?.kind !== 'block') throw new Error('Expected nested block');
    const variables = nested.statements.flatMap((statement) =>
      statement.kind === 'variable' ? statement.declarations : [],
    );
    const method = box.methods[0];
    if (!method) throw new Error('Expected class method');

    expect(scopes.binding.scope).toBe('module');
    expect(scopes.typeParameters[0]?.binding.scope).toBe('function');
    expect(scopes.parameters[0]?.binding.scope).toBe('function');
    expect(
      variables.map((variable) => [getVariableBinding(variable).name, getVariableBinding(variable).scope]),
    ).toEqual([
      ['lifted', 'function'],
      ['block', 'block'],
      ['fixed', 'block'],
    ]);
    expect(box.typeParameters[0]?.binding.scope).toBe('declaration');
    expect(method.typeParameters[0]?.binding.scope).toBe('function');
    expect(method.parameters[0]?.binding.scope).toBe('function');
  });

  it('keeps a named function-expression binding distinct from its same-named owner', () => {
    const result = lower('recursion.ts', 'export const recurse = function recurse(): number { return recurse(); };');
    const [owner] = result.module.declarations;

    if (owner?.kind !== 'variable' || owner.initializer?.kind !== 'function' || !owner.initializer.binding) {
      throw new Error('Expected named function expression');
    }
    const returned = owner.initializer.body[0];
    if (returned?.kind !== 'return' || returned.expression?.kind !== 'call') {
      throw new Error('Expected recursive call');
    }
    expect(owner.initializer.binding).toMatchObject({ kind: 'function', name: 'recurse', scope: 'function' });
    expect(owner.initializer.binding.id).not.toBe(getVariableBinding(owner).id);
    expect(bindingReference(returned.expression.callee).id).toBe(owner.initializer.binding.id);
  });

  it('resolves symbols on an internal analysis tree without mutating the caller-owned AST', () => {
    const sourceFile = ts.createSourceFile(
      '/flight/packages/math/src/owned.ts',
      'export function read(): number { const value = 1; return value; }',
      ts.ScriptTarget.Latest,
      true,
    );
    const functionStatement = sourceFile.statements[0];
    if (!functionStatement || !ts.isFunctionDeclaration(functionStatement) || !functionStatement.body) {
      throw new Error('Expected function statement');
    }
    const variableStatement = functionStatement.body.statements[0];
    const returnStatement = functionStatement.body.statements[1];
    if (
      !variableStatement ||
      !returnStatement ||
      !ts.isVariableStatement(variableStatement) ||
      !ts.isReturnStatement(returnStatement)
    ) {
      throw new Error('Expected variable and return statements');
    }
    const declaration = variableStatement.declarationList.declarations[0]!;
    const state = [sourceFile, declaration, returnStatement.expression!].map(
      (node) => node as unknown as { flowNode?: unknown; locals?: unknown; symbol?: unknown },
    );
    const snapshot = () => state.map(({ flowNode, locals, symbol }) => ({ flowNode, locals, symbol }));
    const unbound = [
      { flowNode: undefined, locals: undefined, symbol: undefined },
      { flowNode: undefined, locals: undefined, symbol: undefined },
      { flowNode: undefined, locals: undefined, symbol: undefined },
    ];
    expect(snapshot()).toEqual(unbound);

    const result = lowerTypeScriptSource(sourceFile, {
      packageName: '@flighthq/math',
      upstreamDirectory: '/flight',
    });

    expect(result.diagnostics).toEqual([]);
    expect(snapshot()).toEqual(unbound);
  });

  it('resolves shorthand object values to their lexical bindings rather than their property symbols', () => {
    const result = lower(
      'shorthand.ts',
      'export function create(value: number): object { const output = value; return { value, output }; }',
    );
    const declaration = result.module.declarations[0];
    if (declaration?.kind !== 'function') throw new Error('Expected function declaration');
    const local = declaration.body[0];
    const returned = declaration.body[1];
    if (local?.kind !== 'variable' || returned?.kind !== 'return' || returned.expression?.kind !== 'object') {
      throw new Error('Expected local and shorthand object return');
    }

    expect(result.diagnostics).toEqual([]);
    expect(returned.expression.members).toMatchObject([
      { kind: 'property', name: 'value', value: { reference: { binding: declaration.parameters[0]?.binding } } },
      {
        kind: 'property',
        name: 'output',
        value: { reference: { binding: getVariableBinding(local.declarations[0]) } },
      },
    ]);
  });

  it('diagnoses optional rest parameters instead of constructing invalid IR', () => {
    const parameter = lower('parameter.ts', 'export function invalid(...values?: number[]): void {}');

    expect(parameter.module.declarations).toEqual([]);
    expect(parameter.diagnostics[0]?.message).toBe('rest parameters cannot be optional or defaulted');
  });

  it('diagnoses defaulted rest parameters instead of constructing invalid IR', () => {
    const parameter = lower('parameter.ts', 'export function invalid(...values: number[] = []): void {}');

    expect(parameter.module.declarations).toEqual([]);
    expect(parameter.diagnostics[0]?.message).toBe('rest parameters cannot be optional or defaulted');
  });

  it('diagnoses optional rest tuple elements instead of constructing invalid IR', () => {
    const tuple = lower('tuple.ts', 'export type Invalid = [...values?: number[]];');

    expect(tuple.module.declarations).toEqual([]);
    expect(tuple.diagnostics[0]?.message).toBe('rest tuple elements cannot be optional');
  });
});

function ambientReference(expression: Readonly<IrExpression> | undefined): string {
  if (expression?.kind !== 'identifier' || expression.reference.kind !== 'ambient') {
    throw new Error('Expected an ambient identifier reference');
  }
  return expression.reference.name;
}

function bindingReference(expression: Readonly<IrExpression> | undefined): IrBindingIdentity {
  if (expression?.kind !== 'identifier' || expression.reference.kind !== 'binding') {
    throw new Error('Expected a bound identifier reference');
  }
  return expression.reference.binding;
}

function getVariableBinding(value: unknown): IrBindingIdentity {
  if (typeof value !== 'object' || value === null || !('binding' in value)) {
    throw new Error('Expected named variable');
  }
  return (value as { readonly binding: IrBindingIdentity }).binding;
}
