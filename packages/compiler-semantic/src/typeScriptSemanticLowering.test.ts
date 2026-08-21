import ts from 'typescript';

import type { IrBindingIdentity, IrExpression, IrStatement } from '../../compiler-types/src/index.js';
import { lowerTypeScriptSource } from './typeScriptSemanticLowering.js';

function lower(file: string, source: string) {
  const sourceFile = ts.createSourceFile(`/flight/packages/math/src/${file}`, source, ts.ScriptTarget.Latest, true);
  return lowerTypeScriptSource(sourceFile, {
    packageName: '@flighthq/math',
    upstreamDirectory: '/flight',
  });
}

describe('lowerTypeScriptSource', () => {
  it('records nominal object construction targets and closed inferred anonymous shapes', () => {
    const result = lower(
      'object-construction.ts',
      `
        interface Named { value: number }
        export function create(): Named {
          const anonymous = { value: 1, label: 'flight' };
          anonymous;
          return { value: 2 };
        }
      `,
    );
    const declaration = result.module.declarations[1];
    if (declaration?.kind !== 'function') throw new Error('Expected function declaration');
    const variable = declaration.body[0];
    const returned = declaration.body[2];
    if (
      variable?.kind !== 'variable' ||
      variable.declarations[0]?.initializer?.kind !== 'object' ||
      returned?.kind !== 'return' ||
      returned.expression?.kind !== 'object'
    ) {
      throw new Error('Expected object constructions');
    }

    expect(variable.declarations[0].initializer.type).toEqual({
      kind: 'object',
      properties: [
        { name: 'value', optional: false, readonly: false, type: { kind: 'primitive', name: 'number' } },
        { name: 'label', optional: false, readonly: false, type: { kind: 'primitive', name: 'string' } },
      ],
    });
    expect(returned.expression.type).toMatchObject({
      kind: 'named',
      reference: { binding: { name: 'Named', space: 'type' }, kind: 'binding', path: [] },
    });
    expect(returned.expression.copySemantics).toBeUndefined();
  });

  it('records exact object-spread copy semantics without changing member evaluation order', () => {
    const result = lower(
      'object-copy.ts',
      `
        function effect(value: string): any { return value; }
        export function copy(source: { first: number; second?: number }) {
          return {
            first: effect('before'),
            ...source,
            first: effect('after'),
            [effect('key')]: effect('computed'),
          };
        }
      `,
    );
    const declaration = result.module.declarations[1];
    const returned = declaration?.kind === 'function' ? declaration.body[0] : undefined;
    if (returned?.kind !== 'return' || returned.expression?.kind !== 'object') {
      throw new Error('Expected object copy expression');
    }

    expect(returned.expression.copySemantics).toEqual({
      evaluation: 'left-to-right-once',
      nullish: 'skip',
      overwrite: 'replace-value-preserve-key-position',
      propertyKeys: 'own-enumerable-string-and-symbol',
      propertyReads: 'get-once-in-own-key-order',
      targetWrites: 'create-data-property',
    });
    expect(returned.expression.members.map((member) => member.kind)).toEqual([
      'property',
      'spread',
      'property',
      'computedProperty',
    ]);
    expect(returned.expression.members).toMatchObject([
      { kind: 'property', name: 'first', value: { arguments: [{ value: 'before' }], kind: 'call' } },
      { expression: { kind: 'identifier', reference: { binding: { name: 'source' } } }, kind: 'spread' },
      { kind: 'property', name: 'first', value: { arguments: [{ value: 'after' }], kind: 'call' } },
      {
        key: { arguments: [{ value: 'key' }], kind: 'call' },
        kind: 'computedProperty',
        value: { arguments: [{ value: 'computed' }], kind: 'call' },
      },
    ]);
  });

  it('propagates nominal construction targets through records, arrays, tuples, and conditional arms', () => {
    const result = lower(
      'nested-object-construction.ts',
      `
        interface Item { value: number }
        interface Container { selected: Item; values: Item[]; pair: [Item] }
        export function create(flag: boolean): Container {
          return {
            selected: flag ? { value: 1 } : { value: 2 },
            values: [{ value: 3 }],
            pair: [{ value: 4 }],
          };
        }
      `,
    );
    const declaration = result.module.declarations[2];
    const returned = declaration?.kind === 'function' ? declaration.body[0] : undefined;
    if (returned?.kind !== 'return' || returned.expression?.kind !== 'object') {
      throw new Error('Expected nested object construction');
    }
    const selected = returned.expression.members[0];
    const values = returned.expression.members[1];
    const pair = returned.expression.members[2];
    if (
      selected?.kind !== 'property' ||
      selected.value.kind !== 'conditional' ||
      selected.value.whenTrue.kind !== 'object' ||
      selected.value.whenFalse.kind !== 'object' ||
      values?.kind !== 'property' ||
      values.value.kind !== 'array' ||
      values.value.elements[0]?.kind !== 'object' ||
      pair?.kind !== 'property' ||
      pair.value.kind !== 'tuple' ||
      pair.value.elements[0]?.expression?.kind !== 'object'
    ) {
      throw new Error('Expected nested construction containers');
    }
    const objectTypes = [
      selected.value.whenTrue.type,
      selected.value.whenFalse.type,
      values.value.elements[0].type,
      pair.value.elements[0].expression.type,
    ];
    expect(objectTypes).toEqual(
      objectTypes.map(() =>
        expect.objectContaining({
          kind: 'named',
          reference: expect.objectContaining({ binding: expect.objectContaining({ name: 'Item' }) }),
        }),
      ),
    );
  });

  it('substitutes generic interfaces, aliases, and defaults through nested construction targets', () => {
    const result = lower(
      'generic-object-construction.ts',
      `
        interface Item { label: string }
        interface Box<Value> { value: Value }
        interface DefaultBox<Value = Item> { value: Value }
        type Envelope<Value> = { box: Box<Value> };
        export function create(): Envelope<Item> {
          return { box: { value: { label: 'nested' } } };
        }
        export function createDefault(): DefaultBox {
          return { value: { label: 'defaulted' } };
        }
      `,
    );
    const constructions = result.module.declarations
      .filter((declaration) => declaration.kind === 'function')
      .map((declaration) => declaration.body[0])
      .map((statement) => (statement?.kind === 'return' ? statement.expression : undefined));
    const envelope = constructions[0];
    const defaultBox = constructions[1];
    if (envelope?.kind !== 'object' || defaultBox?.kind !== 'object') {
      throw new Error('Expected generic object constructions');
    }
    const box = envelope.members[0];
    const defaultValue = defaultBox.members[0];
    if (
      box?.kind !== 'property' ||
      box.value.kind !== 'object' ||
      box.value.members[0]?.kind !== 'property' ||
      box.value.members[0].value.kind !== 'object' ||
      defaultValue?.kind !== 'property' ||
      defaultValue.value.kind !== 'object'
    ) {
      throw new Error('Expected substituted nested record values');
    }

    expect(box.value.type).toMatchObject({
      kind: 'named',
      reference: { binding: { name: 'Box' } },
      typeArguments: [{ reference: { binding: { name: 'Item' } } }],
    });
    expect(box.value.members[0].value.type).toMatchObject({
      kind: 'named',
      reference: { binding: { name: 'Item' } },
      typeArguments: [],
    });
    expect(defaultValue.value.type).toMatchObject({
      kind: 'named',
      reference: { binding: { name: 'Item' } },
      typeArguments: [],
    });
  });

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

  it('models class method implementations and interface method overload sets without duplicate runtime members', () => {
    const result = lower(
      'method-overloads.ts',
      `
        export interface Chooser {
          choose(value: string): string;
          choose(value: number): number;
        }
        export class Picker {
          choose(value: number): number;
          choose(value: number, radix?: number): number;
          choose(value: number, radix = 10): number { return value + radix; }
        }
        export function read(picker: Picker): number { return picker.choose(1); }
      `,
    );
    const interfaceDeclaration = result.module.declarations.find((declaration) => declaration.kind === 'interface');
    const classDeclaration = result.module.declarations.find((declaration) => declaration.kind === 'class');
    const read = result.module.declarations.find(
      (declaration) => declaration.kind === 'function' && declaration.binding.name === 'read',
    );
    if (interfaceDeclaration?.kind !== 'interface' || classDeclaration?.kind !== 'class' || read?.kind !== 'function') {
      throw new Error('Expected method overload declarations');
    }
    const call = read.body[0]?.kind === 'return' ? read.body[0].expression : undefined;

    expect(interfaceDeclaration.properties).toEqual([
      {
        name: 'choose',
        optional: false,
        readonly: true,
        type: {
          kind: 'intersection',
          types: [
            expect.objectContaining({ kind: 'function', returns: { kind: 'primitive', name: 'string' } }),
            expect.objectContaining({ kind: 'function', returns: { kind: 'primitive', name: 'number' } }),
          ],
        },
      },
    ]);
    expect(classDeclaration.methods).toHaveLength(1);
    expect(classDeclaration.methods[0]).toMatchObject({
      name: 'choose',
      overloads: [
        { parameters: [{ binding: { name: 'value' } }], returns: { kind: 'primitive', name: 'number' } },
        {
          parameters: [{ binding: { name: 'value' } }, { binding: { name: 'radix' }, optional: true }],
          returns: { kind: 'primitive', name: 'number' },
        },
      ],
      parameters: [
        { binding: { name: 'value' } },
        { binding: { name: 'radix' }, initializer: { kind: 'literal', value: 10 }, optional: true },
      ],
    });
    expect(call).toMatchObject({
      kind: 'call',
      semantics: {
        defaultParameters: { defaulted: [1], omitted: [1], parameterCount: 2, providedArgumentCount: 1 },
        overloadImplementation: {
          implementationParameterCount: 2,
          overloadIndex: 0,
          resolvedParameterCount: 1,
        },
      },
    });
    expect(result.diagnostics).toEqual([]);

    const orphan = lower('orphan-method.ts', 'export class Picker { choose(value: number): number; }');
    expect(orphan.module.declarations).toEqual([]);
    expect(orphan.diagnostics.map((diagnostic) => diagnostic.message)).toEqual([
      'class method choose requires one implementation',
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

  it('attaches constructor overloads and diagnoses parameter properties without partial class IR', () => {
    const overloads = lower(
      'point.ts',
      'export class Point { constructor(a: number); constructor(a: string); constructor(x: number | string) {} }',
    );
    const parameterProperty = lower('value.ts', 'export class Value { constructor(public readonly value: number) {} }');
    const point = overloads.module.declarations[0];

    expect(point).toMatchObject({
      binding: { name: 'Point' },
      classConstructor: {
        overloads: [
          { parameters: [{ binding: { name: 'a' }, type: { kind: 'primitive', name: 'number' } }] },
          { parameters: [{ binding: { name: 'a' }, type: { kind: 'primitive', name: 'string' } }] },
        ],
        parameters: [{ binding: { name: 'x' }, type: { kind: 'union' } }],
      },
      kind: 'class',
    });
    expect(overloads.diagnostics).toEqual([]);
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
      classConstructor: { body: [], overloads: [], parameters: [] },
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

  it('retains iteration and destructuring type evidence for operator domains', () => {
    const result = lower(
      'binding-operator-domains.ts',
      `
        export function calculate(
          values: number[],
          rows: Array<[number, string]>,
          optional: [number?],
          nested: [[number, string]],
          suffix: [boolean, number, string],
          variadic: [number, ...string[]],
        ): void {
          for (var value of values) value += 1;
          for (var [rowNumber, rowText] of rows) { rowNumber += 1; rowText += '!'; }
          const [fallback = 0]: [number?] = optional;
          fallback += 1;
          const [[nestedNumber, nestedText]]: [[number, string]] = nested;
          nestedNumber += 1; nestedText += '!';
          const [, ...[suffixNumber, suffixText]]: [boolean, number, string] = suffix;
          suffixNumber += 1; suffixText += '!';
          const [head, ...tail]: [number, ...string[]] = variadic;
          head += 1; tail;
        }
      `,
    );
    const declaration = result.module.declarations.find(
      (item) => item.kind === 'function' && item.binding.name === 'calculate',
    );
    if (declaration?.kind !== 'function') throw new Error('Expected calculate function');
    const assignments = collectAssignmentExpressions(declaration.body);

    expect(result.diagnostics).toEqual([]);
    expect(assignments.map((assignment) => assignment.semantics.left)).toEqual([
      { declared: 'number', flow: 'number' },
      { declared: 'number', flow: 'number' },
      { declared: 'string', flow: 'string' },
      { declared: 'number', flow: 'number' },
      { declared: 'number', flow: 'number' },
      { declared: 'string', flow: 'string' },
      { declared: 'number', flow: 'number' },
      { declared: 'string', flow: 'string' },
      { declared: 'number', flow: 'number' },
    ]);
    expect(assignments.map((assignment) => assignment.semantics.result)).toEqual([
      'number',
      'number',
      'string',
      'number',
      'number',
      'string',
      'number',
      'string',
      'number',
    ]);
  });

  it('classifies exact key order and object evaluation for literal and closed-record for-in sources', () => {
    const result = lower(
      'for-in-keys.ts',
      `
        export function fixed(): string {
          for (const key in { second: 2, 10: 10, 2: 2, first: 1 }) return key;
          return '';
        }
        export function dynamic(values: { value: number }, callback: () => number): void {
          for (const key in values) key;
          for (const key in { value: callback() }) key;
        }
        export function closed(): void {
          const values = { second: 2, first: 1 } as const;
          for (const key in values) key;
        }
      `,
    );
    const fixed = result.module.declarations.find(
      (declaration) => declaration.kind === 'function' && declaration.binding.name === 'fixed',
    );
    const dynamic = result.module.declarations.find(
      (declaration) => declaration.kind === 'function' && declaration.binding.name === 'dynamic',
    );
    const closed = result.module.declarations.find(
      (declaration) => declaration.kind === 'function' && declaration.binding.name === 'closed',
    );
    if (fixed?.kind !== 'function' || dynamic?.kind !== 'function' || closed?.kind !== 'function')
      throw new Error('Expected for-in functions');
    const fixedLoop = fixed.body[0];

    expect(result.diagnostics).toEqual([]);
    expect(fixedLoop).toMatchObject({
      keyPlan: { evaluation: 'elide', keys: ['2', '10', 'second', 'first'], kind: 'objectLiteral' },
    });
    expect(dynamic.body[0]?.kind === 'forIn' ? dynamic.body[0].keyPlan : 'not-for-in').toBeUndefined();
    expect(dynamic.body[1]).toMatchObject({
      keyPlan: { evaluation: 'preserve', keys: ['value'], kind: 'objectLiteral' },
    });
    expect(closed.body[1]).toMatchObject({
      keyPlan: { evaluation: 'alreadyEvaluated', keys: ['second', 'first'], kind: 'closedRecord' },
    });
  });

  it('substitutes generic alias evidence through iteration, destructuring, operators, and tuple spreads', () => {
    const result = lower(
      'generic-alias-evidence.ts',
      `
        type Pair<T, U = string> = [T, U];
        type Wrapped<T> = Pair<T>;
        type Rows<T> = Array<Pair<T>>;
        export function visit(rows: Rows<number>, pair: Wrapped<number>, values: Pair<number, boolean>): void {
          for (const [rowNumber, rowText] of rows) { rowNumber += 1; rowText += '!'; }
          const [valueNumber, valueFlag]: Pair<number, boolean> = values;
          valueNumber += 1; valueFlag &&= true;
          const copy: Pair<number> = [...pair];
          copy;
        }
      `,
    );
    const declaration = result.module.declarations.find(
      (item) => item.kind === 'function' && item.binding.name === 'visit',
    );
    if (declaration?.kind !== 'function') throw new Error('Expected generic alias evidence function');
    const assignments = collectAssignmentExpressions(declaration.body);
    const variables = declaration.body
      .filter((statement) => statement.kind === 'variable')
      .flatMap((statement) => statement.declarations);
    const copy = variables.find((variable) => !('pattern' in variable) && variable.binding.name === 'copy');

    expect(result.diagnostics).toEqual([]);
    expect(assignments.map((assignment) => assignment.semantics.left.flow)).toEqual([
      'number',
      'string',
      'number',
      'boolean',
    ]);
    expect(copy?.initializer).toMatchObject({
      kind: 'tupleSpread',
      type: { elements: [{ type: { name: 'number' } }, { type: { name: 'string' } }] },
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
      'type Values = readonly number[]; type Mixed = Uint32Array | Uint16Array; export function read(array: Values, tuple: readonly [number, number], floats: Float32Array, mixed: Mixed, record: { value: number }, text: string, mystery: any): unknown[] { return [array[0], tuple[0], floats[0], mixed[0], record["value"], text[0], mystery[0]]; }',
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
    ).toEqual([
      ['array'],
      ['tuple'],
      ['float32Array'],
      ['uint16Array', 'uint32Array'],
      ['object'],
      ['string'],
      ['unknown'],
    ]);
  });

  it('records optional-chain receiver and projected value type evidence', () => {
    const result = lower(
      'optional-chain-evidence.ts',
      'interface Value { count: number } export function read(value: Value | undefined, values: number[] | undefined, callback: ((value: number) => number) | undefined, present: number[]): Array<number | undefined> { return [value?.count, values?.[0], callback?.(1), present?.[0]]; }',
    );
    const read = result.module.declarations[1];
    if (read?.kind !== 'function' || read.body[0]?.kind !== 'return' || read.body[0].expression?.kind !== 'array') {
      throw new Error('Expected optional-chain array result');
    }

    expect(
      read.body[0].expression.elements.map((element) => {
        if (element?.kind === 'property') return element.optionalChain;
        if (element?.kind === 'element' || element?.kind === 'call') return element.semantics.optionalChain;
        return undefined;
      }),
    ).toMatchObject([
      {
        receiverEvaluation: 'once',
        receiverNullish: 'possible',
        receiverType: {
          kind: 'union',
          types: [
            { kind: 'named', reference: { binding: { name: 'Value' }, kind: 'binding', path: [] }, typeArguments: [] },
            { kind: 'undefined' },
          ],
        },
        result: 'undefined',
        shortCircuit: 'nullish',
        valueType: { kind: 'primitive', name: 'number' },
      },
      {
        receiverEvaluation: 'once',
        receiverNullish: 'possible',
        receiverType: {
          kind: 'union',
          types: [
            { element: { kind: 'primitive', name: 'number' }, kind: 'array', readonly: false },
            { kind: 'undefined' },
          ],
        },
        result: 'undefined',
        shortCircuit: 'nullish',
        valueType: { kind: 'primitive', name: 'number' },
      },
      {
        receiverEvaluation: 'once',
        receiverNullish: 'possible',
        receiverType: {
          kind: 'union',
          types: [
            {
              kind: 'function',
              parameters: [
                { name: 'value', optional: false, rest: false, type: { kind: 'primitive', name: 'number' } },
              ],
              returns: { kind: 'primitive', name: 'number' },
              typeParameters: [],
            },
            { kind: 'undefined' },
          ],
        },
        result: 'undefined',
        shortCircuit: 'nullish',
        valueType: { kind: 'primitive', name: 'number' },
      },
      {
        receiverEvaluation: 'once',
        receiverNullish: 'excluded',
        receiverType: { element: { kind: 'primitive', name: 'number' }, kind: 'array', readonly: false },
        result: 'undefined',
        shortCircuit: 'nullish',
        valueType: { kind: 'primitive', name: 'number' },
      },
    ]);
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
      { signature: { parameterCount: 1, providedArgumentCount: 1 } },
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

  it('resolves labeled break and continue references to one control-flow identity', () => {
    const result = lower(
      'labeled-flow.ts',
      'export function scan(): void { outer: for (let index = 0; index < 2; index++) { switch (index) { case 0: continue outer; default: break outer; } } }',
    );
    const declaration = result.module.declarations[0];
    const loop = declaration?.kind === 'function' ? declaration.body[0] : undefined;
    const body = loop?.kind === 'for' && loop.body.kind === 'block' ? loop.body.statements[0] : undefined;
    if (loop?.kind !== 'for' || body?.kind !== 'switch') throw new Error('Expected labeled loop and nested switch');
    const continued = body.cases[0]?.statements[0];
    const broken = body.cases[1]?.statements[0];

    expect(loop.label).toMatchObject({ id: expect.stringContaining('control-flow-label:'), name: 'outer' });
    expect(continued).toMatchObject({ kind: 'continue', target: { id: loop.label?.id, name: 'outer' } });
    expect(broken).toMatchObject({ kind: 'break', target: { id: loop.label?.id, name: 'outer' } });
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
      type: { element: { kind: 'primitive', name: 'number' }, kind: 'array' },
    });
    expect(loopStatement.variable.initializer).toBeUndefined();
    expect(first.pattern.binding.id).not.toBe(nested.pattern.binding.id);
    expect(first.pattern.binding.fingerprint).toMatch(/^sha256:[\da-f]{64}$/u);
    expect(lower('array-bindings.ts', source).module).toEqual(result.module);
  });

  it('preserves syntactic iterable element-type evidence for for-of bindings', () => {
    const result = lower(
      'iterable-evidence.ts',
      `
        type Row = [number, string];
        type Rows = ReadonlyArray<Row>;
        type GenericRows<T> = ReadonlyArray<T>;
        type ArrayRows<T> = T[];
        type NestedRows<T> = GenericRows<T>;
        type DefaultRows<T = Row> = ReadonlyArray<T>;
        function createRows(): Rows { throw new Error(); }
        class Holder { rows: Row[] = []; }
        export function read(rows: Row[], holder: Holder, generic: GenericRows<Row>, arrayRows: ArrayRows<Row>, nested: NestedRows<Row>, defaulted: DefaultRows, mystery: any): void {
          for (const [first, second] of rows) { first; second; }
          for (const [first, second] of createRows()) { first; second; }
          for (const [first, second] of holder.rows) { first; second; }
          for (const [first, second] of generic) { first; second; }
          for (const [first, second] of arrayRows) { first; second; }
          for (const [first, second] of nested) { first; second; }
          for (const [first, second] of defaulted) { first; second; }
          for (const [first, second] of mystery) { first; second; }
        }
      `,
    );
    const declaration = result.module.declarations.find(
      (item) => item.kind === 'function' && item.binding.name === 'read',
    );
    if (declaration?.kind !== 'function') throw new Error('Expected read function');
    const loops = declaration.body.filter((statement) => statement.kind === 'forOf');

    expect(result.diagnostics).toEqual([]);
    expect(loops).toHaveLength(8);
    for (const loop of loops.slice(0, 7)) {
      expect(loop.variable.type).toMatchObject({
        elements: [{ type: { kind: 'primitive', name: 'number' } }, { type: { kind: 'primitive', name: 'string' } }],
        kind: 'tuple',
      });
      if (!('pattern' in loop.variable) || loop.variable.pattern.kind !== 'array') {
        throw new Error('Expected typed array iteration binding');
      }
      expect(loop.variable.pattern.elements).toMatchObject([
        { pattern: { type: { kind: 'primitive', name: 'number' } } },
        { pattern: { type: { kind: 'primitive', name: 'string' } } },
      ]);
    }
    expect(loops[7]?.variable.type).toBeUndefined();
  });

  it('preserves named, renamed, nested, defaulted, computed, and rest object binding evidence', () => {
    const result = lower(
      'object-bindings.ts',
      `
        type Box<T> = { value?: T; nested: { text: string }; other: boolean };
        const key = 'other';
        export const { value: renamed = 1, nested: { text }, [key]: computed, ...rest }: Box<number> = {
          nested: { text: 'flight' },
          other: true,
        };
      `,
    );
    const declaration = result.module.declarations.find(
      (item) => item.kind === 'variable' && 'pattern' in item && item.pattern.kind === 'object',
    );
    if (declaration?.kind !== 'variable' || !('pattern' in declaration) || declaration.pattern.kind !== 'object') {
      throw new Error('Expected object binding declaration');
    }

    expect(result.diagnostics).toEqual([]);
    expect(declaration.pattern).toMatchObject({
      kind: 'object',
      properties: [
        {
          initializer: { kind: 'literal', value: 1 },
          key: { kind: 'named', name: 'value' },
          pattern: { binding: { name: 'renamed' }, kind: 'binding', type: { kind: 'primitive', name: 'number' } },
        },
        {
          key: { kind: 'named', name: 'nested' },
          pattern: {
            kind: 'object',
            properties: [
              {
                key: { kind: 'named', name: 'text' },
                pattern: { binding: { name: 'text' }, type: { kind: 'primitive', name: 'string' } },
              },
            ],
          },
        },
        {
          key: { coercion: 'string', expression: { kind: 'identifier' }, kind: 'computed' },
          pattern: { binding: { name: 'computed' }, kind: 'binding' },
        },
      ],
      rest: {
        binding: { name: 'rest' },
        kind: 'binding',
        type: { kind: 'unknown', source: 'object' },
      },
      scope: 'module',
    });
  });

  it('lowers destructured parameters to typed carrier parameters and ordered entry bindings', () => {
    const result = lower(
      'parameter-bindings.ts',
      `
        type Shape = { value?: number; nested: { text: string } };
        export function read(
          { value = 1, nested: { text } }: Shape,
          [first, ...tail]: [number, string],
        ): string { return text + value + first + tail[0]; }
        export const concise = ({ value }: { value: number }): number => value + 1;
      `,
    );
    const read = result.module.declarations.find(
      (declaration) => declaration.kind === 'function' && declaration.binding.name === 'read',
    );
    const concise = result.module.declarations.find(
      (declaration) =>
        declaration.kind === 'variable' && 'binding' in declaration && declaration.binding.name === 'concise',
    );
    if (read?.kind !== 'function' || concise?.kind !== 'variable' || concise.initializer?.kind !== 'function') {
      throw new Error('Expected destructured parameter functions');
    }

    expect(result.diagnostics).toEqual([]);
    expect(read.parameters).toMatchObject([
      { binding: { kind: 'parameter', name: 'parameterPatternValue' }, type: { kind: 'named' } },
      { binding: { kind: 'parameter', name: 'parameterPatternValue' }, type: { kind: 'tuple' } },
    ]);
    expect(read.parameters[0]?.binding.id).not.toBe(read.parameters[1]?.binding.id);
    expect(read.body).toMatchObject([
      {
        declarations: [
          {
            pattern: {
              kind: 'object',
              properties: [
                { key: { name: 'value' }, pattern: { binding: { name: 'value' } } },
                { key: { name: 'nested' }, pattern: { kind: 'object' } },
              ],
              scope: 'function',
            },
          },
        ],
        kind: 'variable',
      },
      {
        declarations: [{ pattern: { kind: 'array', scope: 'function' } }],
        kind: 'variable',
      },
      { kind: 'return' },
    ]);
    expect(concise.initializer.expression).toBeUndefined();
    expect(concise.initializer.body).toMatchObject([
      { declarations: [{ pattern: { kind: 'object' } }], kind: 'variable' },
      { expression: { kind: 'binary' }, kind: 'return' },
    ]);
  });

  it('normalizes statement destructuring assignments through single-evaluation projection blocks', () => {
    const result = lower(
      'assignment-bindings.ts',
      `
        export function assign(
          tuple: [number, { name?: string }, boolean],
          record: { count: number },
        ): string {
          let first = 0;
          let name = '';
          let tail: [boolean] = [false];
          let count = 0;
          [first, { name = 'flight' }, ...tail] = tuple;
          ({ count } = record);
          return name + first + tail[0] + count;
        }
      `,
    );
    const declaration = result.module.declarations[0];
    if (declaration?.kind !== 'function') throw new Error('Expected assignment function');
    const arrayBlock = declaration.body[4];
    const objectBlock = declaration.body[5];
    if (arrayBlock?.kind !== 'block' || objectBlock?.kind !== 'block') {
      throw new Error('Expected destructuring projection blocks');
    }

    expect(result.diagnostics).toEqual([]);
    expect(arrayBlock.statements).toMatchObject([
      {
        declarations: [
          {
            binding: { name: 'destructuringAssignmentValue' },
            initializer: { kind: 'identifier' },
            type: { kind: 'tuple' },
          },
        ],
        kind: 'variable',
      },
      { expression: { left: { reference: { binding: { name: 'first' } } }, right: { kind: 'element' } } },
      { declarations: [{ binding: { name: 'destructuringAssignmentValue' } }], kind: 'variable' },
      {
        expression: {
          left: { reference: { binding: { name: 'name' } } },
          right: { kind: 'undefinedDefault' },
        },
      },
      { expression: { left: { reference: { binding: { name: 'tail' } } }, right: { kind: 'tupleRest' } } },
    ]);
    expect(objectBlock.statements).toMatchObject([
      { declarations: [{ binding: { name: 'destructuringAssignmentValue' } }], kind: 'variable' },
      {
        expression: {
          left: { reference: { binding: { name: 'count' } } },
          right: { kind: 'property', name: 'count' },
        },
      },
    ]);
    expect(
      new Set(
        arrayBlock.statements.flatMap((statement) =>
          statement.kind === 'variable'
            ? statement.declarations.flatMap((variable) => ('binding' in variable ? [variable.binding.id] : []))
            : [],
        ),
      ).size,
    ).toBe(2);
  });

  it('models destructuring assignment completion values with one aggregate carrier', () => {
    const result = lower(
      'assignment-value.ts',
      'export function assign(tuple: [number]): [number] { let value = 0; return ([value] = tuple); }',
    );
    const declaration = result.module.declarations[0];
    if (declaration?.kind !== 'function' || declaration.body[1]?.kind !== 'return') {
      throw new Error('Expected assignment completion return');
    }
    const completion = declaration.body[1].expression;

    expect(result.diagnostics).toEqual([]);
    expect(completion).toMatchObject({
      callee: {
        body: [
          { declarations: [{ binding: { name: 'destructuringAssignmentValue' } }], kind: 'variable' },
          { expression: { left: { reference: { binding: { name: 'value' } } } }, kind: 'expression' },
          { expression: { reference: { binding: { name: 'destructuringAssignmentValue' } } }, kind: 'return' },
        ],
        kind: 'function',
      },
      kind: 'call',
      semantics: {
        statementValue: {
          abruptCompletion: 'propagate',
          asyncContext: 'inherit',
          normalCompletion: 'final-return-value',
          thisBinding: 'lexical',
        },
      },
    });
  });

  it('records default-parameter ABI positions and fixed call-site omissions independently of syntax', () => {
    const result = lower(
      'default-parameter-abi.ts',
      `
        function choose(first: number, second = first + 1, third = 3): number { return third; }
        export function read(): number { choose(1); return choose(1, 2); }
      `,
    );
    const declaration = result.module.declarations.find(
      (item) => item.kind === 'function' && item.binding.name === 'read',
    );
    if (declaration?.kind !== 'function') throw new Error('Expected read function');
    const first = declaration.body[0];
    const second = declaration.body[1];

    expect(first).toMatchObject({
      expression: {
        semantics: {
          defaultParameters: { defaulted: [1, 2], omitted: [1, 2], parameterCount: 3, providedArgumentCount: 1 },
        },
      },
    });
    expect(second).toMatchObject({
      expression: {
        semantics: {
          defaultParameters: { defaulted: [1, 2], omitted: [2], parameterCount: 3, providedArgumentCount: 2 },
        },
      },
    });
  });

  it('records optional-parameter ABI positions and fixed call-site omissions independently of syntax', () => {
    const result = lower(
      'optional-parameter-abi.ts',
      `
        function choose(first: number, second?: number, third?: number): number { return first; }
        export function read(): number { choose(1); return choose(1, 2); }
      `,
    );
    const declaration = result.module.declarations.find(
      (item) => item.kind === 'function' && item.binding.name === 'read',
    );
    if (declaration?.kind !== 'function') throw new Error('Expected read function');
    const first = declaration.body[0];
    const second = declaration.body[1];

    expect(first).toMatchObject({
      expression: {
        semantics: {
          optionalParameters: {
            omitted: [1, 2],
            optional: [1, 2],
            parameterCount: 3,
            provided: [],
            providedArgumentCount: 1,
          },
        },
      },
    });
    expect(second).toMatchObject({
      expression: {
        semantics: {
          optionalParameters: {
            omitted: [2],
            optional: [1, 2],
            parameterCount: 3,
            provided: [
              {
                argumentType: { kind: 'primitive', name: 'number' },
                parameterType: { kind: 'primitive', name: 'number' },
                position: 1,
              },
            ],
            providedArgumentCount: 2,
          },
        },
      },
    });
  });

  it('classifies provided default and optional arguments as value, null, or undefined with type evidence', () => {
    const result = lower(
      'parameter-argument-values.ts',
      `
        function fallback(value: number | null = 1): number | null { return value; }
        function optional(value?: number | null): number | null | undefined { return value; }
        export function read(): void {
          fallback();
          fallback(1);
          fallback(null);
          fallback((undefined as number | undefined));
          optional();
          optional(1);
          optional(null);
          optional((undefined as number | undefined));
        }
        export function readLocal(): void {
          const undefined: number = 2;
          fallback(undefined);
        }
      `,
    );
    const declaration = result.module.declarations.find(
      (item) => item.kind === 'function' && item.binding.name === 'read',
    );
    const local = result.module.declarations.find(
      (item) => item.kind === 'function' && item.binding.name === 'readLocal',
    );
    if (declaration?.kind !== 'function' || local?.kind !== 'function') throw new Error('Expected read functions');
    const calls = declaration.body.flatMap((statement) =>
      statement.kind === 'expression' && statement.expression.kind === 'call' ? [statement.expression] : [],
    );

    expect(calls.slice(0, 4).map((call) => call?.semantics.defaultParameters?.provided[0]?.value)).toEqual([
      undefined,
      'value',
      'null',
      'undefined',
    ]);
    expect(calls.slice(4).map((call) => call?.semantics.optionalParameters?.provided[0]?.value)).toEqual([
      undefined,
      'value',
      'null',
      'undefined',
    ]);
    expect(calls[1]?.semantics.defaultParameters?.provided[0]).toMatchObject({
      argumentType: { kind: 'primitive', name: 'number' },
      parameterType: { kind: 'union', types: [{ kind: 'primitive', name: 'number' }, { kind: 'null' }] },
      position: 0,
    });
    const localCall = local.body[1];
    expect(
      localCall?.kind === 'expression' && localCall.expression.kind === 'call'
        ? localCall.expression.semantics.defaultParameters?.provided[0]?.value
        : undefined,
    ).toBe('value');
    expect(result.diagnostics).toEqual([]);
  });

  it('resolves overload typing separately from the local implementation ABI', () => {
    const result = lower(
      'overload-implementation-abi.ts',
      `
        function choose(value: number): number;
        function choose(value: number, radix?: number): number;
        function choose(value: number, radix = 10): number { return value + radix; }
        function maybe(value: number): number;
        function maybe(value: number, enabled?: boolean): number;
        function maybe(value: number, enabled?: boolean): number { return enabled ? value : 0; }
        export function read(): number { choose(1); choose(1, 2); maybe(1); return maybe(1, true); }
      `,
    );
    const declaration = result.module.declarations.find(
      (item) => item.kind === 'function' && item.binding.name === 'read',
    );
    if (declaration?.kind !== 'function') throw new Error('Expected read function');
    const calls = declaration.body.map((statement) =>
      statement.kind === 'expression' || statement.kind === 'return' ? statement.expression : undefined,
    );

    expect(calls).toMatchObject([
      {
        semantics: {
          defaultParameters: { defaulted: [1], omitted: [1], parameterCount: 2, providedArgumentCount: 1 },
          overloadImplementation: {
            implementationParameterCount: 2,
            overloadIndex: 0,
            resolvedParameterCount: 1,
          },
        },
      },
      {
        semantics: {
          defaultParameters: { defaulted: [1], omitted: [], parameterCount: 2, providedArgumentCount: 2 },
          overloadImplementation: {
            implementationParameterCount: 2,
            overloadIndex: 1,
            resolvedParameterCount: 2,
          },
        },
      },
      {
        semantics: {
          optionalParameters: {
            omitted: [1],
            optional: [1],
            parameterCount: 2,
            provided: [],
            providedArgumentCount: 1,
          },
          overloadImplementation: {
            implementationParameterCount: 2,
            overloadIndex: 0,
            resolvedParameterCount: 1,
          },
        },
      },
      {
        semantics: {
          optionalParameters: {
            omitted: [],
            optional: [1],
            parameterCount: 2,
            provided: [
              {
                argumentType: { kind: 'primitive', name: 'boolean' },
                parameterType: { kind: 'primitive', name: 'boolean' },
                position: 1,
              },
            ],
            providedArgumentCount: 2,
          },
          overloadImplementation: {
            implementationParameterCount: 2,
            overloadIndex: 1,
            resolvedParameterCount: 2,
          },
        },
      },
    ]);
    expect(result.diagnostics).toEqual([]);
  });

  it('resolves constructor overload typing separately from the local implementation ABI', () => {
    const result = lower(
      'constructor-implementation-abi.ts',
      `
        class Box {
          constructor(value: number);
          constructor(value: number, radix?: number);
          constructor(value: number, radix = 10) { value; radix; }
        }
        export function create(): Box { return new Box(1); }
      `,
    );
    const declaration = result.module.declarations.find(
      (item) => item.kind === 'function' && item.binding.name === 'create',
    );
    const statement = declaration?.kind === 'function' ? declaration.body[0] : undefined;
    const expression = statement?.kind === 'return' ? statement.expression : undefined;

    expect(expression).toMatchObject({
      arguments: [{ kind: 'literal', value: 1 }],
      kind: 'new',
      semantics: {
        signature: { parameterCount: 2, providedArgumentCount: 1 },
        defaultParameters: {
          defaulted: [1],
          omitted: [1],
          parameterCount: 2,
          providedArgumentCount: 1,
        },
        overloadImplementation: {
          implementationParameterCount: 2,
          overloadIndex: 0,
          resolvedParameterCount: 1,
        },
      },
    });
    expect(result.diagnostics).toEqual([]);
  });

  it('plans stable left-to-right carriers for neutral fixed extra-argument erasure', () => {
    const result = lower(
      'extra-argument-erasure.ts',
      `
        function effect(value: number): number { return value; }
        function choose(value: number): number { return value; }
        function collect(first: number, ...rest: number[]): number { return first; }
        export function read(): number { collect(1, 2, 3); return choose(effect(1), effect(2)); }
      `,
    );
    const declaration = result.module.declarations.find(
      (item) => item.kind === 'function' && item.binding.name === 'read',
    );
    if (declaration?.kind !== 'function') throw new Error('Expected read function');
    const restCall = declaration.body[0]?.kind === 'expression' ? declaration.body[0].expression : undefined;
    const call = declaration.body[1]?.kind === 'return' ? declaration.body[1].expression : undefined;
    if (call?.kind !== 'call') throw new Error('Expected extra-argument call evidence');

    expect(restCall).toMatchObject({
      kind: 'call',
      semantics: { signature: { parameterCount: 2, providedArgumentCount: 3, restParameter: 1 } },
    });
    expect(call).toMatchObject({
      arguments: [{ kind: 'call' }, { kind: 'call' }],
      semantics: {
        extraArguments: {
          argumentBindings: [{ name: 'callArgument0' }, { name: 'callArgument1' }],
          resultType: { kind: 'primitive', name: 'number' },
        },
        signature: { parameterCount: 1, providedArgumentCount: 2 },
      },
    });
    const identities = call.semantics.extraArguments?.argumentBindings.map((binding) => binding.id) ?? [];
    expect(new Set(identities).size).toBe(2);
    expect(identities.every((identity) => identity.includes('call-argument'))).toBe(true);
    expect(result.diagnostics).toEqual([]);
  });

  it('represents undefined as an option value only when contextual type evidence permits it', () => {
    const result = lower(
      'contextual-undefined.ts',
      `
        function fallback(value = 1): number { return value; }
        function optional(value?: number): number { return 0; }
        export function maybe(): number | undefined { fallback(undefined); optional(undefined); return undefined; }
        export function bare(): undefined { return undefined; }
      `,
    );
    const maybe = result.module.declarations.find((item) => item.kind === 'function' && item.binding.name === 'maybe');
    const bare = result.module.declarations.find((item) => item.kind === 'function' && item.binding.name === 'bare');
    if (maybe?.kind !== 'function' || bare?.kind !== 'function') throw new Error('Expected contextual functions');

    expect(maybe.body).toMatchObject([
      { expression: { arguments: [{ kind: 'undefinedValue', type: { kind: 'union' } }] } },
      { expression: { arguments: [{ kind: 'undefinedValue', type: { kind: 'union' } }] } },
      { expression: { kind: 'undefinedValue', type: { kind: 'union' } }, kind: 'return' },
    ]);
    expect(bare.body).toMatchObject([
      { expression: { kind: 'identifier', reference: { kind: 'ambient', name: 'undefined' } }, kind: 'return' },
    ]);
  });

  it('substitutes generic interface evidence through readonly and union property wrappers', () => {
    const result = lower(
      'generic-interface-evidence.ts',
      `
        interface Box<Value> { readonly value: readonly [Value] | undefined }
        export function read(box: Box<number>): void {
          const { value }: Box<number> = box;
          value;
        }
      `,
    );
    const declaration = result.module.declarations.find(
      (item) => item.kind === 'function' && item.binding.name === 'read',
    );
    if (declaration?.kind !== 'function' || declaration.body[0]?.kind !== 'variable') {
      throw new Error('Expected binding declaration');
    }
    const variable = declaration.body[0].declarations[0];
    if (!variable || !('pattern' in variable) || variable.pattern.kind !== 'object') {
      throw new Error('Expected object pattern');
    }

    expect(variable.pattern.properties[0]).toMatchObject({
      pattern: {
        type: {
          kind: 'union',
          types: [
            { elements: [{ type: { kind: 'primitive', name: 'number' } }], kind: 'tuple', readonly: true },
            { kind: 'undefined' },
          ],
        },
      },
    });
  });

  it('flattens inherited generic interface evidence and diagnoses incompatible diamonds', () => {
    const inherited = lower(
      'inherited-interface-evidence.ts',
      `
        interface Base<Value> { readonly base: Value }
        interface Middle<Value> extends Base<readonly [Value]> { middle: Value | undefined }
        interface Leaf<Value> extends Middle<Value> { leaf: boolean }
        export function read(value: Leaf<number>): void {
          const { base, middle, leaf }: Leaf<number> = value;
          base; middle; leaf;
        }
      `,
    );
    const declaration = inherited.module.declarations.find(
      (item) => item.kind === 'function' && item.binding.name === 'read',
    );
    const variable =
      declaration?.kind === 'function' && declaration.body[0]?.kind === 'variable'
        ? declaration.body[0].declarations[0]
        : undefined;
    if (!variable || !('pattern' in variable) || variable.pattern.kind !== 'object') {
      throw new Error('Expected inherited object pattern evidence');
    }

    expect(variable.pattern.properties).toMatchObject([
      {
        pattern: {
          binding: { name: 'base' },
          type: {
            elements: [{ type: { kind: 'primitive', name: 'number' } }],
            kind: 'tuple',
            readonly: true,
          },
        },
      },
      {
        pattern: {
          binding: { name: 'middle' },
          type: {
            kind: 'union',
            types: [{ kind: 'primitive', name: 'number' }, { kind: 'undefined' }],
          },
        },
      },
      { pattern: { binding: { name: 'leaf' }, type: { kind: 'primitive', name: 'boolean' } } },
    ]);

    const conflict = lower(
      'incompatible-interface-evidence.ts',
      'interface Left { value: number } interface Right { value: string } interface Combined extends Left, Right {} export function read(input: Combined): void { const { value }: Combined = input; value; }',
    );
    expect(conflict.diagnostics).toContainEqual(
      expect.objectContaining({ message: 'interface Combined inherits incompatible property value' }),
    );
  });

  it('distinguishes contextual fixed tuple expressions from open array expressions', () => {
    const result = lower(
      'tuple-expressions.ts',
      `
        export const required: [number, string] = [1, 'flight'];
        export const optional: [number, string?] = [2];
        export const open: number[] = [3];
        export function read(value: [number] = [4]): [number] { return value; }
        export class Holder { value: [number] = [5]; }
      `,
    );
    const [required, optional, open, read, holder] = result.module.declarations;
    if (
      required?.kind !== 'variable' ||
      optional?.kind !== 'variable' ||
      open?.kind !== 'variable' ||
      read?.kind !== 'function' ||
      holder?.kind !== 'class'
    ) {
      throw new Error('Expected contextual tuple declarations');
    }

    expect(result.diagnostics).toEqual([]);
    expect(required.initializer).toMatchObject({
      elements: [
        { expression: { value: 1 }, optional: false },
        { expression: { value: 'flight' }, optional: false },
      ],
      kind: 'tuple',
    });
    expect(optional.initializer).toEqual({
      elements: [{ expression: { kind: 'literal', value: 2 }, optional: false }, { optional: true }],
      kind: 'tuple',
    });
    expect(open.initializer).toMatchObject({ kind: 'array' });
    expect(read.parameters[0]?.initializer).toMatchObject({ kind: 'tuple' });
    expect(holder.fields[0]?.initializer).toMatchObject({ kind: 'tuple' });
  });

  it('represents fixed tuple spread construction with source and result layouts', () => {
    const result = lower(
      'tuple-spread.ts',
      `
        type Pair = [number, string];
        const pair: Pair = [1, 'flight'];
        export const combined: [boolean, number, string, boolean?] = [true, ...pair];
        const optionalPair: [number, string?] = [2];
        export const optionalCombined: [number, string?] = [...optionalPair];
      `,
    );
    const combined = result.module.declarations.find(
      (declaration) =>
        declaration.kind === 'variable' && 'binding' in declaration && declaration.binding.name === 'combined',
    );
    const optional = result.module.declarations.find(
      (declaration) =>
        declaration.kind === 'variable' && 'binding' in declaration && declaration.binding.name === 'optionalCombined',
    );
    const pair = result.module.declarations.find(
      (declaration) =>
        declaration.kind === 'variable' && 'binding' in declaration && declaration.binding.name === 'pair',
    );
    if (combined?.kind !== 'variable' || optional?.kind !== 'variable' || pair?.kind !== 'variable') {
      throw new Error('Expected tuple spread declarations');
    }

    expect(result.diagnostics).toEqual([]);
    expect(pair.initializer).toMatchObject({ kind: 'tuple' });
    expect(combined.initializer).toMatchObject({
      kind: 'tupleSpread',
      segments: [
        { element: { expression: { value: true }, optional: false }, kind: 'element' },
        {
          expression: { kind: 'identifier' },
          kind: 'spread',
          type: {
            elements: [{ optional: false }, { optional: false }],
            kind: 'tuple',
          },
        },
        { element: { optional: true }, kind: 'element' },
      ],
      type: { elements: [{ optional: false }, { optional: false }, { optional: false }, { optional: true }] },
    });
    expect(optional.initializer).toMatchObject({
      kind: 'tupleSpread',
      segments: [{ kind: 'spread', type: { elements: [{ optional: false }, { optional: true }] } }],
    });
  });

  it('propagates generic tuple return contexts through functions, methods, closures, and async values', () => {
    const result = lower(
      'return-context.ts',
      `
        type Pair<T> = [T, string];
        export function direct(): Pair<number> { return [1, 'direct']; }
        export async function asynchronous(): Promise<Pair<number>> { return [2, 'async']; }
        export class Factory { create(): Pair<number> { return [3, 'method']; } }
        export const block = (): Pair<number> => { return [4, 'block']; };
        export const concise = (): Pair<number> => [5, 'concise'];
        export const holder = { create(): Pair<number> { return [6, 'object']; } };
      `,
    );
    const initializers = result.module.declarations
      .filter((declaration) => declaration.kind === 'variable' && 'binding' in declaration)
      .map((declaration) => declaration.initializer);
    const direct = result.module.declarations.find(
      (declaration) => declaration.kind === 'function' && declaration.binding.name === 'direct',
    );
    const asynchronous = result.module.declarations.find(
      (declaration) => declaration.kind === 'function' && declaration.binding.name === 'asynchronous',
    );
    const factory = result.module.declarations.find((declaration) => declaration.kind === 'class');
    if (direct?.kind !== 'function' || asynchronous?.kind !== 'function' || factory?.kind !== 'class') {
      throw new Error('Expected contextual return declarations');
    }
    const block = initializers[0];
    const concise = initializers[1];
    const holder = initializers[2];
    const holderMember = holder?.kind === 'object' ? holder.members[0] : undefined;
    const holderFunction = holderMember?.kind === 'property' ? holderMember.value : undefined;

    expect(result.diagnostics).toEqual([]);
    expect(direct.body[0]).toMatchObject({ expression: { kind: 'tuple' }, kind: 'return' });
    expect(asynchronous.body[0]).toMatchObject({ expression: { kind: 'tuple' }, kind: 'return' });
    expect(factory.methods[0]?.body[0]).toMatchObject({ expression: { kind: 'tuple' }, kind: 'return' });
    expect(block).toMatchObject({ body: [{ expression: { kind: 'tuple' }, kind: 'return' }], kind: 'function' });
    expect(concise).toMatchObject({ expression: { kind: 'tuple' }, kind: 'function' });
    expect(holderFunction).toMatchObject({
      body: [{ expression: { kind: 'tuple' }, kind: 'return' }],
      kind: 'function',
    });
  });

  it.each([
    ['contextual tuple expression rest at index 1 is not represented yet', '[number, ...number[]]', '[1, 2]'],
    ['contextual tuple expression has more values than its fixed tuple type', '[number]', '[1, 2]'],
    ['contextual tuple expression requires a value at index 0', '[number]', '[]'],
    ['contextual tuple expression spread requires a statically known fixed tuple', '[number]', '[...values]'],
  ])('diagnoses invalid contextual tuple expressions: %s', (message, type, value) => {
    const source = `const values: number[] = [1]; export const rejected: ${type} = ${value}; export const kept = 2;`;
    const result = lower('invalid-tuple-expression.ts', source);

    expect(result.diagnostics.map((diagnostic) => diagnostic.message)).toContain(message);
    expect(result.module.declarations).toMatchObject([{ binding: { name: 'values' } }, { binding: { name: 'kept' } }]);
  });

  it('rejects optional tuple spread values at required result positions', () => {
    const result = lower(
      'invalid-optional-tuple-spread.ts',
      'const values: [number?] = []; export const rejected: [number] = [...values]; export const kept = 2;',
    );

    expect(result.diagnostics.map((diagnostic) => diagnostic.message)).toContain(
      'optional tuple spread value cannot initialize required index 0',
    );
    expect(result.module.declarations).toMatchObject([{ binding: { name: 'values' } }, { binding: { name: 'kept' } }]);
  });

  it('accepts object bindings and diagnoses invalid rest patterns while continuing with later declarations', () => {
    const object = lower(
      'object-bindings.ts',
      'const { rejected } = { rejected: 1 }; const [kept] = [2]; export { kept as retained };',
    );
    const rest = lower('rest-binding.ts', 'const [...values = []] = [];');

    expect(object.diagnostics).toEqual([]);
    expect(object.module.declarations).toHaveLength(2);
    expect(object.module.declarations[0]).toMatchObject({
      kind: 'variable',
      pattern: {
        kind: 'object',
        properties: [{ key: { name: 'rejected' }, pattern: { binding: { name: 'rejected' } } }],
      },
    });
    expect(object.module.declarations[1]).toMatchObject({
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

function collectAssignmentExpressions(
  statements: readonly Readonly<IrStatement>[],
): Array<Extract<IrExpression, { kind: 'assignment' }>> {
  const assignments: Array<Extract<IrExpression, { kind: 'assignment' }>> = [];
  const visit = (statement: Readonly<IrStatement>): void => {
    if (statement.kind === 'expression' && statement.expression.kind === 'assignment') {
      assignments.push(statement.expression);
    }
    if (statement.kind === 'block') statement.statements.forEach(visit);
    if (statement.kind === 'do' || statement.kind === 'while') visit(statement.body);
    if (statement.kind === 'for' || statement.kind === 'forIn' || statement.kind === 'forOf') visit(statement.body);
    if (statement.kind === 'if') {
      visit(statement.consequent);
      if (statement.otherwise) visit(statement.otherwise);
    }
    if (statement.kind === 'switch') statement.cases.forEach((switchCase) => switchCase.statements.forEach(visit));
    if (statement.kind === 'try') {
      visit(statement.tryBody);
      if (statement.catchClause) visit(statement.catchClause.body);
      if (statement.finallyBody) visit(statement.finallyBody);
    }
  };
  statements.forEach(visit);
  return assignments;
}

function getVariableBinding(value: unknown): IrBindingIdentity {
  if (typeof value !== 'object' || value === null || !('binding' in value)) {
    throw new Error('Expected named variable');
  }
  return (value as { readonly binding: IrBindingIdentity }).binding;
}
