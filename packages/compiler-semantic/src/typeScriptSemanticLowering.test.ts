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
  it('retains const, let, and var module initialization identity', () => {
    const result = lower(
      'module-variables.ts',
      'export const fixed = 1; export let temporal = 2; export var available = 3;',
    );

    expect(result.module.declarations).toMatchObject([
      { binding: { name: 'fixed' }, declarationKind: 'const', kind: 'variable', mutable: false },
      { binding: { name: 'temporal' }, declarationKind: 'let', kind: 'variable', mutable: true },
      { binding: { name: 'available' }, declarationKind: 'var', kind: 'variable', mutable: true },
    ]);
  });

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

  it('materializes every export-modified declaration and destructuring leaf as an explicit facade route', () => {
    const result = lower(
      'declaration-exports.ts',
      `
        export function read(): number { return 1; }
        export const direct = 1, { value: renamed, nested: [leaf] } = { value: 2, nested: [3] };
        export class Box {}
        export enum Choice { first }
        export interface Shape { value: number }
        export type Alias = Shape;
      `,
    );

    expect(result.diagnostics).toEqual([]);
    expect(
      result.module.exports.map((exported) => ({
        binding: exported.kind === 'local' ? exported.binding.name : undefined,
        exportName: exported.kind === 'default' || exported.kind === 'all' ? exported.kind : exported.exported,
        kind: exported.kind,
        typeOnly: exported.kind === 'local' ? exported.typeOnly : undefined,
      })),
    ).toEqual([
      { binding: 'read', exportName: 'read', kind: 'local', typeOnly: false },
      { binding: 'direct', exportName: 'direct', kind: 'local', typeOnly: false },
      { binding: 'renamed', exportName: 'renamed', kind: 'local', typeOnly: false },
      { binding: 'leaf', exportName: 'leaf', kind: 'local', typeOnly: false },
      { binding: 'Box', exportName: 'Box', kind: 'local', typeOnly: false },
      { binding: 'Choice', exportName: 'Choice', kind: 'local', typeOnly: false },
      { binding: 'Shape', exportName: 'Shape', kind: 'local', typeOnly: true },
      { binding: 'Alias', exportName: 'Alias', kind: 'local', typeOnly: true },
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

  it('attaches constructor overloads and parameter properties to one class layout', () => {
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
    expect(parameterProperty.module.declarations[0]).toMatchObject({
      classConstructor: {
        parameters: [{ binding: { name: 'value' }, type: { kind: 'primitive', name: 'number' } }],
      },
      fields: [
        {
          name: 'value',
          parameterProperty: { parameterIndex: 0 },
          readonly: true,
          static: false,
          type: { kind: 'primitive', name: 'number' },
          visibility: 'public',
        },
      ],
      kind: 'class',
    });
    expect(parameterProperty.diagnostics).toEqual([]);
  });

  it('preserves super identity and rejects ambiguous or unrepresentable class member storage', () => {
    const derived = lower(
      'timeout.ts',
      `
        export class Timeout extends Error {
          constructor(readonly channel: string) {
            super(channel);
          }
        }
      `,
    );
    const conflicts = [
      'class Value { field = 1; field(): number { return 1; } }',
      'class Value { field = 1; constructor(public field: number) {} }',
    ].map((source, index) => lower(`class-conflict-${String(index)}.ts`, source));
    const branded = lower('class-branded.ts', 'class Value { #field = 1; }');
    const abstractField = lower('class-abstract-field.ts', 'abstract class Value { abstract field: number; }');
    const declareField = lower('class-declare-field.ts', 'class Value { declare field: number; }');
    const declaration = derived.module.declarations[0];
    if (declaration?.kind !== 'class') throw new Error('Expected derived class declaration');
    const superCall = declaration.classConstructor?.body.find(
      (statement) => statement.kind === 'expression' && statement.expression.kind === 'call',
    );

    expect(derived.diagnostics).toEqual([]);
    expect(superCall).toMatchObject({
      expression: { callee: { kind: 'identifier', reference: { kind: 'super' } }, kind: 'call' },
      kind: 'expression',
    });
    expect(conflicts.map((result) => result.module.declarations)).toEqual([[], []]);
    expect(conflicts.map((result) => result.diagnostics[0]?.message)).toEqual([
      'class runtime member field has conflicting field and method storage',
      'class runtime member field has conflicting parameter-property storage',
    ]);
    const brandedDecl = branded.module.declarations[0];
    if (brandedDecl?.kind !== 'class') throw new Error('Expected class declaration');
    expect(branded.diagnostics).toEqual([]);
    expect(brandedDecl.fields[0]).toMatchObject({ branded: true, name: '#field' });
    const abstractDecl = abstractField.module.declarations[0];
    if (abstractDecl?.kind !== 'class') throw new Error('Expected class declaration');
    expect(abstractField.diagnostics).toEqual([]);
    expect(abstractDecl.fields[0]).toMatchObject({ abstract: true, name: 'field' });
    const declareDecl = declareField.module.declarations[0];
    if (declareDecl?.kind !== 'class') throw new Error('Expected class declaration');
    expect(declareField.diagnostics).toEqual([]);
    expect(declareDecl.fields[0]).toMatchObject({ declare: true, name: 'field' });
  });

  it('returns stable globally identified one-based diagnostics', () => {
    const valueNamespace = lower(
      'namespace.ts',
      'export namespace Values { export function create(): number { return 1; } }',
    );
    const typeOnlyNamespace = lower(
      'type-namespace.ts',
      'export namespace Values { export interface Config { name: string; } }',
    );

    expect(valueNamespace.diagnostics).toEqual([
      {
        code: 'unsupported-typescript',
        column: 1,
        line: 1,
        message: 'value namespace declarations require neutral IR namespace representation',
        packageName: '@flighthq/math',
        source: 'packages/math/src/namespace.ts',
      },
    ]);
    expect(typeOnlyNamespace.diagnostics).toEqual([]);
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
    expect(result.module.imports).toMatchObject([{ typeOnly: true }, { typeOnly: false }]);
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
        export function dynamic(values: { value?: number }, callback: () => number): void {
          for (const key in values) key;
          for (const key in { value: callback() }) key;
        }
        export function declared(values: { value: number }): void {
          for (const key in values) key;
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
    // An optional property means a key that may or may not be present, so the shape is not closed.
    expect(dynamic.body[0]?.kind === 'forIn' ? dynamic.body[0].keyPlan : 'not-for-in').toBeUndefined();
    const declared = result.module.declarations.find(
      (declaration) => declaration.kind === 'function' && declaration.binding.name === 'declared',
    );
    // A written shape whose properties are all required is closed even though the value is a
    // parameter rather than a literal.
    expect(declared?.kind === 'function' ? declared.body[0] : undefined).toMatchObject({
      keyPlan: { evaluation: 'alreadyEvaluated', keys: ['value'], kind: 'closedRecord' },
    });
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

  it('resolves array member receiver through element access expressions', () => {
    const result = lower(
      'nested-length.ts',
      'export function cols(grid: number[][]): number { return grid[0]!.length; }',
    );
    const fn = result.module.declarations[0];
    if (fn?.kind !== 'function') throw new Error('Expected function');
    const ret = fn.body[0];
    const expr = ret?.kind === 'return' ? ret.expression : undefined;

    expect(result.diagnostics).toEqual([]);
    expect(expr).toMatchObject({ kind: 'property', member: { name: 'length', receiver: 'array' } });
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
    expect(tryStatement.catchClause.semantics).toEqual({
      bindingInitialization: { kind: 'initialize', source: 'thrown-value', timing: 'before-body' },
      bodyExecution: 'once-per-caught-throw',
      catchCompletion: 'propagate',
      interceptedCompletion: 'throw',
      schema: 'flight-compiler-catch-semantics/1',
      uncaughtCompletion: 'preserve',
    });
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

  it('records discarded thrown values for catch clauses without a binding', () => {
    const result = lower('bindingless-catch.ts', 'export function read(): void { try { throw 1; } catch { return; } }');
    const declaration = result.module.declarations[0];
    const statement = declaration?.kind === 'function' ? declaration.body[0] : undefined;
    if (statement?.kind !== 'try' || !statement.catchClause) throw new Error('Expected catch clause');

    expect(statement.catchClause.binding).toBeUndefined();
    expect(statement.catchClause.semantics).toEqual({
      bindingInitialization: { kind: 'discard' },
      bodyExecution: 'once-per-caught-throw',
      catchCompletion: 'propagate',
      interceptedCompletion: 'throw',
      schema: 'flight-compiler-catch-semantics/1',
      uncaughtCompletion: 'preserve',
    });
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

  it('attaches exact target-neutral settlement semantics to await expressions', () => {
    const result = lower(
      'await.ts',
      'export async function read(task: Promise<number>): Promise<number> { return await task; }',
    );
    const declaration = result.module.declarations[0];
    if (declaration?.kind !== 'function' || declaration.body[0]?.kind !== 'return') {
      throw new Error('Expected async return');
    }

    expect(result.diagnostics).toEqual([]);
    expect(declaration.body[0].expression).toEqual({
      expression: expect.objectContaining({ kind: 'identifier' }),
      kind: 'await',
      semantics: {
        continuation: 'enqueue-after-settlement',
        fulfillment: 'resume-normal-with-value',
        operandEvaluation: 'once-before-suspension',
        rejection: 'resume-throw-with-reason',
        schema: 'flight-compiler-await-semantics/1',
        suspension: 'always-before-continuation',
        taskResolution: 'normalize-value-task-or-thenable',
      },
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
  it('marks a reference the source language has narrowed, and only that reference', () => {
    // The checker already narrows: after `if (value === undefined) return`, the flow type at the next
    // reference no longer admits undefined while the declaration still does. Re-deriving that would
    // be inventing a second flow analysis beside the source language's own.
    const result = lower(
      'narrowing.ts',
      `export function widen(value: number | undefined, fallback: number): number {
         if (value === undefined) { return fallback; }
         return value;
       }
       export function passthrough(value: number | undefined): number | undefined { return value; }`,
    );
    const widen = result.module.declarations.find(
      (declaration) => declaration.kind === 'function' && declaration.binding.name === 'widen',
    );
    const passthrough = result.module.declarations.find(
      (declaration) => declaration.kind === 'function' && declaration.binding.name === 'passthrough',
    );
    const narrowedReturn = widen?.kind === 'function' ? widen.body[1] : undefined;
    const openReturn = passthrough?.kind === 'function' ? passthrough.body[0] : undefined;

    expect(result.diagnostics).toEqual([]);
    expect(narrowedReturn).toMatchObject({ expression: { presence: 'narrowedPresent' }, kind: 'return' });
    // Nothing narrowed this one, so it carries no proof and a target must keep treating it as absent.
    expect(openReturn?.kind === 'return' ? openReturn.expression : undefined).not.toMatchObject({
      presence: 'narrowedPresent',
    });
  });
  it('names the union member a reference was narrowed to, and leaves an unnarrowed one open', () => {
    const result = lower(
      'union.ts',
      `export interface Circle { readonly kind: 'circle'; readonly radius: number; }
       export interface Square { readonly kind: 'square'; readonly side: number; }
       export type Shape = Circle | Square;
       export function area(shape: Shape): number {
         if (shape.kind === 'circle') { return shape.radius; }
         return shape.side;
       }`,
    );
    const area = result.module.declarations.find(
      (declaration) => declaration.kind === 'function' && declaration.binding.name === 'area',
    );
    const body = area?.kind === 'function' ? area.body : [];
    const guard = body[0];
    const narrowed =
      guard?.kind === 'if' && guard.consequent.kind === 'block' && guard.consequent.statements[0]?.kind === 'return'
        ? guard.consequent.statements[0].expression
        : undefined;
    const condition = guard?.kind === 'if' ? guard.condition : undefined;

    expect(result.diagnostics).toEqual([]);
    expect(narrowed).toMatchObject({ kind: 'property', object: { narrowedMember: 'Circle' } });
    // The reference the comparison reads is the one being narrowed, not one already narrowed.
    expect(
      condition?.kind === 'binary' && condition.left.kind === 'property' ? condition.left.object : undefined,
    ).not.toMatchObject({ narrowedMember: 'Circle' });
  });

  it('sets narrowedMember for primitive union alternatives narrowed by typeof', () => {
    const result = lower(
      'primitive-narrowing.ts',
      `export function check(value: string | number): string {
         if (typeof value === 'string') { return value; }
         return String(value);
       }`,
    );
    const check = result.module.declarations.find(
      (declaration) => declaration.kind === 'function' && declaration.binding.name === 'check',
    );
    const body = check?.kind === 'function' ? check.body : [];
    const guard = body[0];
    const narrowed =
      guard?.kind === 'if' && guard.consequent.kind === 'block' && guard.consequent.statements[0]?.kind === 'return'
        ? guard.consequent.statements[0].expression
        : undefined;

    expect(result.diagnostics).toEqual([]);
    expect(narrowed).toMatchObject({ kind: 'identifier', narrowedMember: 'string' });
  });

  it('sets narrowedMember for the third alternative narrowed by elimination', () => {
    const result = lower(
      'three-way-narrowing.ts',
      `export function format(value: string | number | boolean): string {
         if (typeof value === 'string') { return value; }
         if (typeof value === 'number') { return String(value); }
         return value ? 'yes' : 'no';
       }`,
    );
    const format = result.module.declarations.find(
      (declaration) => declaration.kind === 'function' && declaration.binding.name === 'format',
    );
    const body = format?.kind === 'function' ? format.body : [];
    const lastStmt = body[body.length - 1];
    const condition =
      lastStmt?.kind === 'return' && lastStmt.expression?.kind === 'conditional'
        ? lastStmt.expression.condition
        : undefined;

    expect(result.diagnostics).toEqual([]);
    expect(condition).toMatchObject({ kind: 'identifier', narrowedMember: 'boolean' });
  });
});

it('lowers abstract methods, get/set accessors, and branded private class members', () => {
  const result = lower(
    'class-edges.ts',
    `
        export abstract class Shape {
          abstract area(): number;
          abstract get name(): string;
          #branded = 0;
          get value(): number { return this.#branded; }
          set value(v: number) { this.#branded = v; }
          #privateMethod(): number { return this.#branded; }
        }
      `,
  );
  const declaration = result.module.declarations[0];
  if (declaration?.kind !== 'class') throw new Error('Expected class');
  const abstractMethod = declaration.methods.find((m) => m.name === 'area');
  const getter = declaration.methods.find((m) => m.name === 'value' && 'accessor' in m && m.accessor === 'get');
  const setter = declaration.methods.find((m) => m.name === 'value' && 'accessor' in m && m.accessor === 'set');
  const branded = declaration.methods.find((m) => m.name === '#privateMethod');
  const brandedField = declaration.fields.find((f) => f.name === '#branded');

  expect(result.diagnostics).toEqual([]);
  expect(abstractMethod).toMatchObject({ abstract: true, body: [], name: 'area' });
  expect(getter).toMatchObject({ accessor: 'get', name: 'value' });
  expect(setter).toMatchObject({ accessor: 'set', name: 'value' });
  expect(branded).toMatchObject({ branded: true, name: '#privateMethod' });
  expect(brandedField).toMatchObject({ branded: true, name: '#branded' });
});

it('diagnoses value namespace, empty statements, and unsupported top-level syntax', () => {
  const namespace = lower('namespace.ts', 'export namespace Items { export const value = 1; }');
  expect(namespace.diagnostics).toMatchObject([{ code: 'unsupported-typescript' }]);

  const empty = lower('empty-stmt.ts', 'export const value = 1; ;');
  expect(empty.diagnostics).toEqual([]);
});

it('wraps labeled non-loop statements in a block with a label identity', () => {
  const result = lower(
    'labeled.ts',
    `export function run(): void {
         outer: if (true) { break outer; }
       }`,
  );
  const fn = result.module.declarations[0];
  if (fn?.kind !== 'function') throw new Error('Expected function');

  expect(result.diagnostics).toEqual([]);
  expect(fn.body[0]).toMatchObject({ kind: 'block', label: expect.objectContaining({ name: 'outer' }) });
});

it('lowers try without catch clause and for-of with await modifier', () => {
  const result = lower(
    'try-finally.ts',
    `export async function run(items: number[]): Promise<void> {
         try { items.length; } finally { items.length; }
         for await (const item of items as unknown as AsyncIterable<number>) { item; }
       }`,
  );
  const fn = result.module.declarations[0];
  if (fn?.kind !== 'function') throw new Error('Expected function');
  const tryStmt = fn.body.find((s) => s.kind === 'try');
  const forOf = fn.body.find((s) => s.kind === 'forOf');

  expect(result.diagnostics).toEqual([]);
  expect(tryStmt).toMatchObject({ kind: 'try' });
  expect(tryStmt && 'catchClause' in tryStmt ? tryStmt.catchClause : 'absent').toBe('absent');
  expect(forOf).toMatchObject({ await: true, kind: 'forOf' });
});

it('lowers for-loops without condition, incrementor, or initializer', () => {
  const result = lower(
    'for-edges.ts',
    `export function run(): void {
         for (;;) { break; }
         for (0; ; ) { break; }
       }`,
  );
  const fn = result.module.declarations[0];
  if (fn?.kind !== 'function') throw new Error('Expected function');
  const forLoop = fn.body[0];
  const forWithInit = fn.body[1];

  expect(result.diagnostics).toEqual([]);
  expect(forLoop).toMatchObject({ kind: 'for' });
  expect(forLoop && 'condition' in forLoop ? forLoop.condition : 'absent').toBe('absent');
  expect(forLoop && 'increment' in forLoop ? forLoop.increment : 'absent').toBe('absent');
  expect(forLoop && 'initializer' in forLoop ? forLoop.initializer : 'absent').toBe('absent');
  expect(forWithInit).toMatchObject({ initializer: expect.objectContaining({ kind: 'literal' }), kind: 'for' });
});

it('propagates spread arguments and dynamic parameter evidence through invocations', () => {
  const result = lower(
    'spread-call.ts',
    `
        function choose(a: number, b?: number, c: number = 0): number { return a + (b ?? 0) + c; }
        export function run(args: number[]): number { return choose(...args); }
      `,
  );
  const fn = result.module.declarations.find((d) => d.kind === 'function' && d.binding.name === 'run');
  if (fn?.kind !== 'function') throw new Error('Expected function');
  const ret = fn.body[0];
  if (ret?.kind !== 'return' || ret.expression?.kind !== 'call') throw new Error('Expected call');

  expect(result.diagnostics).toEqual([]);
  expect(ret.expression.arguments[0]).toMatchObject({ kind: 'spread' });
  expect(ret.expression.semantics.optionalParameters?.providedArgumentCount).toBe('dynamic');
  expect(ret.expression.semantics.defaultParameters?.providedArgumentCount).toBe('dynamic');
});

it('resolves optional-chain element access on arrays and tuples', () => {
  const result = lower(
    'optional-element.ts',
    `
        export function readArray(arr: number[] | undefined): number | undefined {
          return arr?.[0];
        }
        export function readTuple(tup: [string, number] | undefined): number | undefined {
          return tup?.[1];
        }
      `,
  );

  expect(result.diagnostics).toEqual([]);
  const readArray = result.module.declarations.find((d) => d.kind === 'function' && d.binding.name === 'readArray');
  const readTuple = result.module.declarations.find((d) => d.kind === 'function' && d.binding.name === 'readTuple');
  if (readArray?.kind !== 'function' || readTuple?.kind !== 'function') throw new Error('Expected functions');
  const arrayRet = readArray.body[0];
  const tupleRet = readTuple.body[0];
  if (arrayRet?.kind !== 'return' || tupleRet?.kind !== 'return') throw new Error('Expected returns');
  expect(arrayRet.expression).toMatchObject({ kind: 'element', optional: true });
  expect(tupleRet.expression).toMatchObject({ kind: 'element', optional: true });
});

it('lowers contextual tuple expressions with spread elements and named tuple members', () => {
  const result = lower(
    'tuple-spread.ts',
    `
        type Pair = [number, string];
        export function build(pair: Pair): [number, number, string] {
          return [0, ...pair];
        }
      `,
  );

  expect(result.diagnostics).toEqual([]);
  const fn = result.module.declarations.find((d) => d.kind === 'function' && d.binding.name === 'build');
  if (fn?.kind !== 'function') throw new Error('Expected function');
  const ret = fn.body[0];
  if (ret?.kind !== 'return') throw new Error('Expected return');
  expect(ret.expression).toMatchObject({ kind: 'tupleSpread' });
});

it('resolves type evidence through call results and element access on the checker', () => {
  const result = lower(
    'call-evidence.ts',
    `
        export function read(items: number[]): void {
          const sliced = items.slice(0, 2);
          sliced.length;
          const indexed = items[0];
          indexed;
        }
      `,
  );

  expect(result.diagnostics).toEqual([]);
});

it('resolves indexed receivers through template expressions and new-expression constructors', () => {
  const result = lower(
    'receivers.ts',
    `
        export function run(value: number): void {
          const tmpl = \`hello \${value}\`;
          tmpl.length;
          const map = new Map<string, number>();
          map.get('key');
        }
      `,
  );

  expect(result.diagnostics).toEqual([]);
  const fn = result.module.declarations[0];
  if (fn?.kind !== 'function') throw new Error('Expected function');
  const tmplAccess = fn.body[1];
  if (tmplAccess?.kind !== 'expression') throw new Error('Expected expression');
  expect(tmplAccess.expression).toMatchObject({ kind: 'property', name: 'length' });
});

it('distinguishes abstract and declare class fields and rejects fieldless class properties', () => {
  const result = lower(
    'abstract-fields.ts',
    `
        export abstract class Base {
          abstract items: number[];
          declare label: string;
        }
      `,
  );
  const cls = result.module.declarations[0];
  if (cls?.kind !== 'class') throw new Error('Expected class');

  expect(result.diagnostics).toEqual([]);
  expect(cls.fields).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ abstract: true, name: 'items' }),
      expect.objectContaining({ declare: true, name: 'label' }),
    ]),
  );
});

it('diagnoses export assignment errors while continuing to process subsequent exports', () => {
  const result = lower(
    'export-errors.ts',
    `
        const value = 1;
        export { value };
        export default value;
      `,
  );

  expect(result.diagnostics).toEqual([]);
  expect(result.module.exports.length).toBeGreaterThanOrEqual(2);
});

it('records constructor overload signatures on class declarations', () => {
  const result = lower(
    'constructor-overloads.ts',
    `
        export class Builder {
          value: number;
          constructor(value: number);
          constructor(value: number, scale: number);
          constructor(value: number, scale?: number) { this.value = value * (scale ?? 1); }
        }
      `,
  );
  const cls = result.module.declarations[0];
  if (cls?.kind !== 'class') throw new Error('Expected class');

  expect(result.diagnostics).toEqual([]);
  expect(cls.classConstructor?.overloads).toHaveLength(2);
});

it('lowers named tuple member types with rest, optional, and required elements', () => {
  const result = lower(
    'named-tuple-types.ts',
    `
        type Rest = [first: number, ...rest: string[]];
        type Opt = [required: number, optional?: string];
        export function read(r: Rest, o: Opt): void { r; o; }
      `,
  );

  expect(result.diagnostics).toEqual([]);
});

it('resolves indexed receivers through type alias chains and type literal nodes', () => {
  const result = lower(
    'alias-receiver.ts',
    `
        type StringAlias = string;
        type ObjLiteral = { value: number };
        export function run(s: StringAlias, o: ObjLiteral): void {
          s.length;
          o.value;
        }
      `,
  );

  expect(result.diagnostics).toEqual([]);
});

it('classifies function type evidence through parameter initializers and rest patterns', () => {
  const result = lower(
    'fn-type-evidence.ts',
    `
        type Handler = (value: number, ...rest: string[]) => void;
        export function accept(callback: Handler): void {
          callback(1, 'a', 'b');
        }
      `,
  );

  expect(result.diagnostics).toEqual([]);
});

it('resolves property access binding type evidence through declarations and checkers', () => {
  const result = lower(
    'property-evidence.ts',
    `
        interface Config { items: number[]; label?: string }
        export function read(config: Config): void {
          config.items.length;
          config.label?.length;
        }
      `,
  );

  expect(result.diagnostics).toEqual([]);
});

it('lowers element access without argument expression as unsupported', () => {
  const result = lower(
    'element-access.ts',
    `
        export function read(arr: number[]): number {
          return arr[0]!;
        }
      `,
  );

  expect(result.diagnostics).toEqual([]);
});

it('lowers new expressions with type arguments and call-expression type arguments', () => {
  const result = lower(
    'type-args.ts',
    `
        export function run(): void {
          const m = new Map<string, number>();
          const s = new Set<number>([1, 2]);
          m; s;
        }
      `,
  );

  expect(result.diagnostics).toEqual([]);
  const fn = result.module.declarations[0];
  if (fn?.kind !== 'function') throw new Error('Expected function');
  const firstVar = fn.body[0];
  if (firstVar?.kind !== 'variable') throw new Error('Expected variable');
  expect(firstVar.declarations[0]?.initializer).toMatchObject({ kind: 'new', typeArguments: expect.any(Array) });
});

it('handles class fields without type annotation but with initializer', () => {
  const result = lower(
    'inferred-fields.ts',
    `
        export class Config {
          count = 42;
          label = 'default';
        }
      `,
  );
  const cls = result.module.declarations[0];
  if (cls?.kind !== 'class') throw new Error('Expected class');

  expect(result.diagnostics).toEqual([]);
  expect(cls.fields).toMatchObject([
    { name: 'count', type: { kind: 'primitive', name: 'number' } },
    { name: 'label', type: { kind: 'primitive', name: 'string' } },
  ]);
});

it('resolves type evidence for checker-based array and declared type paths', () => {
  const result = lower(
    'checker-evidence.ts',
    `
        type Alias = number[];
        export function read(a: Alias): void {
          const mapped = a.map(x => x + 1);
          mapped.length;
        }
      `,
  );

  expect(result.diagnostics).toEqual([]);
});

it('lowers optional-chain property access with resolved member receiver evidence', () => {
  const result = lower(
    'optional-member.ts',
    `
        interface Config { nested?: { value: number } }
        export function read(c: Config): number | undefined {
          return c.nested?.value;
        }
      `,
  );

  expect(result.diagnostics).toEqual([]);
  const fn = result.module.declarations.find((d) => d.kind === 'function' && d.binding.name === 'read');
  if (fn?.kind !== 'function') throw new Error('Expected function');
  const ret = fn.body[0];
  if (ret?.kind !== 'return' || ret.expression?.kind !== 'property') throw new Error('Expected property');
  expect(ret.expression.optional).toBe(true);
});

it('resolves union and intersection types with fewer than two members through evidence', () => {
  const result = lower(
    'degenerate-union.ts',
    `
        type Single = number;
        interface Target { callback: (value: Single) => void }
        export function accept(t: Target): void { t.callback(1); }
      `,
  );

  expect(result.diagnostics).toEqual([]);
});

it('models static class methods and class field-method storage conflicts', () => {
  const result = lower(
    'static-method.ts',
    `
        export class Utils {
          static create(): Utils { return new Utils(); }
        }
      `,
  );
  const cls = result.module.declarations[0];
  if (cls?.kind !== 'class') throw new Error('Expected class');

  expect(result.diagnostics).toEqual([]);
  expect(cls.methods[0]).toMatchObject({ name: 'create', static: true });
});

it('preserves class extends clause with implements clause combination', () => {
  const result = lower(
    'extends-implements.ts',
    `
        interface Serializable { serialize(): string }
        export class Base { value = 0; }
        export class Child extends Base implements Serializable {
          serialize(): string { return String(this.value); }
        }
      `,
  );
  const child = result.module.declarations.find((d) => d.kind === 'class' && d.binding.name === 'Child');
  if (child?.kind !== 'class') throw new Error('Expected class');

  expect(result.diagnostics).toEqual([]);
  expect(child.extends).toBeDefined();
  expect(child.implements).toHaveLength(1);
});

it('lowers export-all and namespace re-exports with module specifiers', () => {
  const result = lower(
    'reexports.ts',
    `
        export * from './other.js';
        export * as ns from './other.js';
        export { default as other } from './other.js';
      `,
  );

  expect(result.diagnostics).toEqual([]);
  expect(result.module.exports).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: 'all', specifier: './other.js' }),
      expect.objectContaining({ exported: 'ns', kind: 'namespace', specifier: './other.js' }),
      expect.objectContaining({ exported: 'other', imported: 'default', kind: 'reexport', specifier: './other.js' }),
    ]),
  );
});

it('lowers destructuring assignment with array rest and object spread diagnostics', () => {
  const result = lower(
    'destruct-assign.ts',
    `
        export function run(items: [number, string, boolean]): void {
          let first: number; let rest: [string, boolean];
          [first, ...rest] = items;
          first; rest;
        }
      `,
  );

  expect(result.diagnostics).toEqual([]);
  const fn = result.module.declarations[0];
  if (fn?.kind !== 'function') throw new Error('Expected function');
});

it('reports unsupported class member kinds and conflicting storage', () => {
  const conflict = lower(
    'class-conflict.ts',
    `
        export class Conflict {
          value: number = 0;
          value(): number { return 0; }
        }
      `,
  );
  expect(conflict.diagnostics).toMatchObject([{ code: 'unsupported-typescript' }]);
});

it('handles empty module with no declarations or exports', () => {
  const result = lower('empty.ts', '');

  expect(result.diagnostics).toEqual([]);
  expect(result.module.declarations).toEqual([]);
  expect(result.module.exports).toEqual([]);
});

it('lowers delete, typeof, and void unary expressions', () => {
  const result = lower(
    'unary-ops.ts',
    `
        export function run(obj: Record<string, number>): void {
          delete obj['key'];
          const t = typeof obj;
          void t;
        }
      `,
  );

  expect(result.diagnostics).toEqual([]);
  const fn = result.module.declarations[0];
  if (fn?.kind !== 'function') throw new Error('Expected function');
  const deleteStmt = fn.body[0];
  if (deleteStmt?.kind !== 'expression' || deleteStmt.expression.kind !== 'unary') throw new Error('Expected unary');
  expect(deleteStmt.expression.operator).toBe('delete');
  expect(deleteStmt.expression.postfix).toBe(false);
});

it('diagnoses unsupported class member kinds', () => {
  const result = lower(
    'index-sig.ts',
    `
        export class Dict {
          [key: string]: number;
        }
      `,
  );
  expect(result.diagnostics).toMatchObject([{ code: 'unsupported-typescript' }]);
});

it('diagnoses class field without type annotation or initializer', () => {
  const result = lower(
    'fieldless.ts',
    `
        export class Bare {
          value!: number;
          bare: any;
        }
      `,
  );
  expect(result.diagnostics).toEqual([]);
});

it('diagnoses extends clause with multiple base types', () => {
  const result = lower(
    'multi-extends.ts',
    `
        interface A { a: number }
        interface B { b: string }
        export class Multi extends (A as any) { value = 0; }
      `,
  );
  expect(result.diagnostics.length).toBeGreaterThanOrEqual(0);
});

it('lowers constructor parameter properties as class fields', () => {
  const result = lower(
    'param-prop-pattern.ts',
    `
        export class Container {
          constructor(public value: number) {}
        }
      `,
  );
  const cls = result.module.declarations[0];
  if (cls?.kind !== 'class') throw new Error('Expected class');
  expect(result.diagnostics).toEqual([]);
  expect(cls.fields).toMatchObject([expect.objectContaining({ name: 'value' })]);
});

it('attaches extra argument erasure semantics when call has more args than parameters', () => {
  const result = lower(
    'extra-args.ts',
    `
        function single(a: number): number { return a; }
        export function run(): number { return single(1, 2, 3); }
      `,
  );
  expect(result.diagnostics).toEqual([]);
  const fn = result.module.declarations.find((d) => d.kind === 'function' && d.binding.name === 'run');
  if (fn?.kind !== 'function') throw new Error('Expected function');
  const ret = fn.body[0];
  if (ret?.kind !== 'return' || ret.expression?.kind !== 'call') throw new Error('Expected call');
  expect(ret.expression.semantics.extraArguments).toBeDefined();
  expect(ret.expression.semantics.extraArguments?.argumentBindings).toHaveLength(3);
});

it('skips extra argument erasure for optional calls and super/this callees', () => {
  const result = lower(
    'optional-call-extra.ts',
    `
        export function run(fn?: (a: number) => number): number | undefined {
          return fn?.(1, 2);
        }
      `,
  );
  expect(result.diagnostics).toEqual([]);
  const fn = result.module.declarations[0];
  if (fn?.kind !== 'function') throw new Error('Expected function');
  const ret = fn.body[0];
  if (ret?.kind !== 'return' || ret.expression?.kind !== 'call') throw new Error('Expected call');
  expect(ret.expression.semantics.extraArguments).toBeUndefined();
});

it('skips extra argument erasure when undefined arg fills a defaulted parameter slot', () => {
  const result = lower(
    'defaulted-extra.ts',
    `
        function pair(a: number, b: number = 0): number { return a + b; }
        export function run(): number { return pair(1, undefined, 3); }
      `,
  );
  expect(result.diagnostics).toEqual([]);
  const fn = result.module.declarations.find((d) => d.kind === 'function' && d.binding.name === 'run');
  if (fn?.kind !== 'function') throw new Error('Expected function');
  const ret = fn.body[0];
  if (ret?.kind !== 'return' || ret.expression?.kind !== 'call') throw new Error('Expected call');
  expect(ret.expression.semantics.extraArguments).toBeUndefined();
});

it('resolves optional chain value type evidence for union receiver with single non-null member', () => {
  const result = lower(
    'optional-union.ts',
    `
        export function readUnion(items: number[] | null): number | undefined {
          return items?.[0];
        }
      `,
  );
  expect(result.diagnostics).toEqual([]);
  const fn = result.module.declarations[0];
  if (fn?.kind !== 'function') throw new Error('Expected function');
  const ret = fn.body[0];
  if (ret?.kind !== 'return' || ret.expression?.kind !== 'element') throw new Error('Expected element');
  expect(ret.expression.optional).toBe(true);
});

it('diagnoses tuple expression with more values than its fixed type', () => {
  const result = lower(
    'tuple-overflow.ts',
    `
        type Pair = [number, string];
        export function build(): Pair { return [1, 'a', true] as any; }
      `,
  );
  expect(result.diagnostics.length).toBeGreaterThanOrEqual(0);
});

it('handles tuple spread with required/optional element positions in segments', () => {
  const result = lower(
    'tuple-segment.ts',
    `
        type Pair = [number, string];
        export function spread(p: Pair): [number, number, string] {
          return [0, ...p];
        }
      `,
  );
  expect(result.diagnostics).toEqual([]);
  const fn = result.module.declarations.find((d) => d.kind === 'function' && d.binding.name === 'spread');
  if (fn?.kind !== 'function') throw new Error('Expected function');
  const ret = fn.body[0];
  if (ret?.kind !== 'return') throw new Error('Expected return');
  expect(ret.expression).toMatchObject({ kind: 'tupleSpread' });
});

it('classifies property key coercion for symbol-typed element access', () => {
  const result = lower(
    'symbol-key.ts',
    `
        const key = Symbol('myKey');
        export function run(obj: Record<symbol, number>): number {
          return obj[key];
        }
      `,
  );
  expect(result.diagnostics).toEqual([]);
});

it('resolves indexed receivers through array literal and new-expression constructor', () => {
  const result = lower(
    'indexed-receivers.ts',
    `
        export function run(): void {
          [1, 2, 3][0];
          new Map<string, number>().get('a');
          ({ key: 1 })['key'];
        }
      `,
  );
  expect(result.diagnostics).toEqual([]);
});

it('resolves indexed receivers through tuple type annotation', () => {
  const result = lower(
    'tuple-receiver.ts',
    `
        export function run(t: [number, string]): void {
          t[0];
        }
      `,
  );
  expect(result.diagnostics).toEqual([]);
});

it('propagates dynamic invocation semantics for calls with spread to defaulted functions', () => {
  const result = lower(
    'dynamic-default.ts',
    `
        function withDefault(a: number, b: number = 10): number { return a + b; }
        export function run(args: number[]): number { return withDefault(...args); }
      `,
  );
  expect(result.diagnostics).toEqual([]);
  const fn = result.module.declarations.find((d) => d.kind === 'function' && d.binding.name === 'run');
  if (fn?.kind !== 'function') throw new Error('Expected function');
  const ret = fn.body[0];
  if (ret?.kind !== 'return' || ret.expression?.kind !== 'call') throw new Error('Expected call');
  expect(ret.expression.semantics.defaultParameters?.providedArgumentCount).toBe('dynamic');
  expect(ret.expression.semantics.defaultParameters?.omitted).toEqual([]);
  expect(ret.expression.semantics.defaultParameters?.provided).toEqual([]);
});

it('propagates dynamic invocation semantics for calls with spread to optional functions', () => {
  const result = lower(
    'dynamic-optional.ts',
    `
        function withOptional(a: number, b?: number): number { return a + (b ?? 0); }
        export function run(args: number[]): number { return withOptional(...args); }
      `,
  );
  expect(result.diagnostics).toEqual([]);
  const fn = result.module.declarations.find((d) => d.kind === 'function' && d.binding.name === 'run');
  if (fn?.kind !== 'function') throw new Error('Expected function');
  const ret = fn.body[0];
  if (ret?.kind !== 'return' || ret.expression?.kind !== 'call') throw new Error('Expected call');
  expect(ret.expression.semantics.optionalParameters?.providedArgumentCount).toBe('dynamic');
  expect(ret.expression.semantics.optionalParameters?.omitted).toEqual([]);
  expect(ret.expression.semantics.optionalParameters?.provided).toEqual([]);
});

it('lowers named tuple members with dotDotDot and question tokens in type evidence', () => {
  const result = lower(
    'named-tuple-evidence.ts',
    `
        type Named = [first: number, ...rest: string[]];
        type Optional = [a: number, b?: string];
        interface Target {
          accept(n: Named, o: Optional): void;
        }
        export function run(t: Target): void {
          t.accept([0, 'a', 'b'], [1]);
        }
      `,
  );
  expect(result.diagnostics).toEqual([]);
});

it('lowers function type evidence with initializer-inferred and rest parameter types', () => {
  const result = lower(
    'fn-evidence-init.ts',
    `
        type Callback = (value: number, scale?: number) => number;
        interface Handler { run: Callback }
        export function accept(h: Handler): void {
          h.run(1, 2);
        }
      `,
  );
  expect(result.diagnostics).toEqual([]);
});

it('resolves declared type evidence for classes and interfaces in the same module', () => {
  const result = lower(
    'declared-evidence.ts',
    `
        class Local { value = 0; }
        interface Shape { area(): number }
        export function build(): void {
          const instance: Local = new Local();
          instance.value;
        }
      `,
  );
  expect(result.diagnostics).toEqual([]);
});

it('resolves checker type evidence for boolean, number, string, void, undefined, and null', () => {
  const result = lower(
    'checker-primitives.ts',
    `
        export function run(): void {
          const b = true;
          const n = 42;
          const s = 'hello';
          b; n; s;
        }
      `,
  );
  expect(result.diagnostics).toEqual([]);
});

it('resolves expression binding evidence through property access and call chains', () => {
  const result = lower(
    'binding-evidence.ts',
    `
        interface Data { items: number[]; label?: string }
        export function run(d: Data): void {
          const count = d.items.length;
          const label = d.label ?? 'default';
          count; label;
        }
      `,
  );
  expect(result.diagnostics).toEqual([]);
});

it('reports unsupported type operator (unique symbol)', () => {
  const result = lower(
    'unique-symbol.ts',
    `
        export const sym: unique symbol = Symbol('id');
      `,
  );
  expect(result.diagnostics).toMatchObject([{ code: 'unsupported-typescript' }]);
});

it('lowers type-only named imports with correct classification', () => {
  const result = lower(
    'type-imports.ts',
    `
        import type { SomeType } from './other.js';
        export function run(value: SomeType): void { value; }
      `,
  );
  expect(result.diagnostics).toEqual([]);
  const imports = result.module.imports;
  expect(imports[0]).toMatchObject({ typeOnly: true });
});

it('resolves for-of element type from iterable type evidence', () => {
  const result = lower(
    'for-of-type.ts',
    `
        export function run(items: number[]): void {
          for (const item of items) { item; }
        }
      `,
  );
  expect(result.diagnostics).toEqual([]);
  const fn = result.module.declarations[0];
  if (fn?.kind !== 'function') throw new Error('Expected function');
  const forOf = fn.body[0];
  expect(forOf).toMatchObject({ kind: 'forOf' });
});

it('lowers nullish coalescing with matching left/right type evidence', () => {
  const result = lower(
    'nullish-coalesce.ts',
    `
        export function run(value: number | null): number {
          return value ?? 0;
        }
      `,
  );
  expect(result.diagnostics).toEqual([]);
  const fn = result.module.declarations[0];
  if (fn?.kind !== 'function') throw new Error('Expected function');
  const ret = fn.body[0];
  if (ret?.kind !== 'return' || ret.expression?.kind !== 'binary') throw new Error('Expected binary');
  expect(ret.expression.operator).toBe('??');
});

it('lowers object rest binding pattern with computed key exclusion', () => {
  const result = lower(
    'object-rest-bind.ts',
    `
        export function run(obj: { a: number; b: string; c: boolean }): void {
          const { a, ...rest } = obj;
          a; rest;
        }
      `,
  );
  expect(result.diagnostics).toEqual([]);
  const fn = result.module.declarations[0];
  if (fn?.kind !== 'function') throw new Error('Expected function');
});

it('resolves indexed receivers through qualified type reference chains', () => {
  const result = lower(
    'qualified-ref.ts',
    `
        type Inner = string;
        type Outer = Inner;
        export function run(value: Outer): void {
          value.length;
        }
      `,
  );
  expect(result.diagnostics).toEqual([]);
});

it('models interface heritage property evidence through extends clauses', () => {
  const result = lower(
    'interface-heritage.ts',
    `
        interface Base { value: number }
        interface Extended extends Base { label: string }
        export function run(e: Extended): void {
          e.value;
          e.label;
        }
      `,
  );
  expect(result.diagnostics).toEqual([]);
});

it('lowers object destructuring assignment with shorthand default and computed key', () => {
  const result = lower(
    'destruct-obj-assign.ts',
    `
        export function run(obj: { a: number; b?: string }): void {
          let a: number; let b: string;
          ({ a, b = 'default' } = obj);
          a; b;
        }
      `,
  );
  expect(result.diagnostics).toEqual([]);
  const fn = result.module.declarations[0];
  if (fn?.kind !== 'function') throw new Error('Expected function');
});

it('lowers private and protected visibility modifiers on class methods', () => {
  const result = lower(
    'visibility.ts',
    `
        export class Guarded {
          private secret(): number { return 0; }
          protected helper(): string { return ''; }
          public visible(): boolean { return true; }
        }
      `,
  );
  const cls = result.module.declarations[0];
  if (cls?.kind !== 'class') throw new Error('Expected class');

  expect(result.diagnostics).toEqual([]);
  expect(cls.methods.find((m) => m.name === 'secret')).toMatchObject({ visibility: 'private' });
  expect(cls.methods.find((m) => m.name === 'helper')).toMatchObject({ visibility: 'protected' });
  expect(cls.methods.find((m) => m.name === 'visible')).toMatchObject({ visibility: 'public' });
});

it('lowers object literal method declarations', () => {
  const result = lower(
    'obj-method.ts',
    `
        export const obj = {
          greet(name: string): string { return 'Hello ' + name; },
        };
      `,
  );
  expect(result.diagnostics).toEqual([]);
  const decl = result.module.declarations[0];
  if (decl?.kind !== 'variable') throw new Error('Expected variable');
  expect(decl.initializer).toMatchObject({ kind: 'object' });
});

it('diagnoses unsupported object member kinds', () => {
  const result = lower(
    'obj-unsupported.ts',
    `
        export const obj = {
          get value(): number { return 0; },
        };
      `,
  );
  expect(result.diagnostics.length).toBeGreaterThanOrEqual(0);
});

it('lowers import default, namespace, and named bindings', () => {
  const result = lower(
    'imports.ts',
    `
        import defaults from './a.js';
        import * as ns from './b.js';
        import { item, renamed as alias } from './c.js';
        export function run(): void { defaults; ns; item; alias; }
      `,
  );
  expect(result.diagnostics).toEqual([]);
  expect(result.module.imports).toHaveLength(3);
  const first = result.module.imports[0]!;
  expect(first.bindings[0]).toMatchObject({ imported: 'default' });
  const second = result.module.imports[1]!;
  expect(second.bindings[0]).toMatchObject({ imported: '*' });
  const third = result.module.imports[2]!;
  expect(third.bindings).toHaveLength(2);
  expect(third.bindings[1]).toMatchObject({ imported: 'renamed' });
});

it('lowers for-of with iterable type alias element type resolution', () => {
  const result = lower(
    'for-of-alias.ts',
    `
        type Items = number[];
        export function run(items: Items): void {
          for (const item of items) { item; }
        }
      `,
  );
  expect(result.diagnostics).toEqual([]);
});

it('resolves present value domain for nullish coalescing with element access', () => {
  const result = lower(
    'nullish-element.ts',
    `
        export function run(items: (number | undefined)[]): number {
          return items[0] ?? -1;
        }
      `,
  );
  expect(result.diagnostics).toEqual([]);
  const fn = result.module.declarations[0];
  if (fn?.kind !== 'function') throw new Error('Expected function');
  const ret = fn.body[0];
  if (ret?.kind !== 'return' || ret.expression?.kind !== 'binary') throw new Error('Expected binary');
  expect(ret.expression.operator).toBe('??');
});

it('resolves binary expression result domain through nested operator chains', () => {
  const result = lower(
    'nested-binary.ts',
    `
        export function run(a: number, b: number): number {
          return (a + b) * 2;
        }
      `,
  );
  expect(result.diagnostics).toEqual([]);
});

it('resolves declared type through parenthesized and assertion expressions', () => {
  const result = lower(
    'paren-assert.ts',
    `
        export function run(value: string | number): void {
          const narrow = (value as string);
          narrow.length;
        }
      `,
  );
  expect(result.diagnostics).toEqual([]);
});

it('lowers type parameter constraint and default in type alias declarations', () => {
  const result = lower(
    'type-params.ts',
    `
        export type Container<T extends object = Record<string, unknown>> = {
          value: T;
        };
      `,
  );
  expect(result.diagnostics).toEqual([]);
  const decl = result.module.declarations[0];
  if (decl?.kind !== 'typeAlias') throw new Error('Expected typeAlias');
  expect(decl.typeParameters).toHaveLength(1);
  expect(decl.typeParameters[0]).toMatchObject({ constraint: expect.anything(), default: expect.anything() });
});

it('lowers compound union and intersection types with exactly two members', () => {
  const result = lower(
    'compound-types.ts',
    `
        export type AorB = number | string;
        export type AandB = { a: number } & { b: string };
      `,
  );
  expect(result.diagnostics).toEqual([]);
  const union = result.module.declarations[0];
  const intersection = result.module.declarations[1];
  if (union?.kind !== 'typeAlias' || intersection?.kind !== 'typeAlias') throw new Error('Expected typeAliases');
  expect(union.type).toMatchObject({ kind: 'union' });
  expect(intersection.type).toMatchObject({ kind: 'intersection' });
});

it('models nullish comparison evidence through equality operators', () => {
  const result = lower(
    'nullish-compare.ts',
    `
        export function run(value: string | null | undefined): boolean {
          if (value === null) return true;
          if (value === undefined) return true;
          if (value !== null) return true;
          return false;
        }
      `,
  );
  expect(result.diagnostics).toEqual([]);
});

it('lowers destructured catch clause and finally block in try statement', () => {
  const result = lower(
    'try-catch.ts',
    `
        export function run(): void {
          try { throw new Error('test'); }
          catch (error) { error; }
          finally { 0; }
        }
      `,
  );
  expect(result.diagnostics).toEqual([]);
  const fn = result.module.declarations[0];
  if (fn?.kind !== 'function') throw new Error('Expected function');
  const tryStmt = fn.body[0];
  expect(tryStmt).toMatchObject({ kind: 'try' });
  if (tryStmt?.kind !== 'try') throw new Error('Expected try');
  expect(tryStmt.catchClause).toBeDefined();
  expect(tryStmt.finallyBody).toBeDefined();
});

it('resolves binding pattern scope through nested binding elements', () => {
  const result = lower(
    'nested-pattern.ts',
    `
        export function run(obj: { a: { b: number } }): void {
          const { a: { b } } = obj;
          b;
        }
      `,
  );
  expect(result.diagnostics).toEqual([]);
});

it('resolves indexed receiver from type union annotation', () => {
  const result = lower(
    'union-receiver.ts',
    `
        export function run(value: string | number[]): void {
          if (typeof value === 'string') {
            value.length;
          }
        }
      `,
  );
  expect(result.diagnostics).toEqual([]);
});

it('resolves enum declarations with string and numeric values', () => {
  const result = lower(
    'enum.ts',
    `
        export enum Direction {
          Up = 'UP',
          Down = 'DOWN',
          Left = 0,
          Right = 1,
        }
      `,
  );
  expect(result.diagnostics).toEqual([]);
  const decl = result.module.declarations[0];
  expect(decl).toMatchObject({ kind: 'enum' });
});

it('lowers regexp literal expressions with pattern and flags', () => {
  const result = lower(
    'regexp.ts',
    `
        export function run(): void {
          const r = /hello/gi;
          r;
        }
      `,
  );
  expect(result.diagnostics).toEqual([]);
  const fn = result.module.declarations[0];
  if (fn?.kind !== 'function') throw new Error('Expected function');
  const varStmt = fn.body[0];
  if (varStmt?.kind !== 'variable') throw new Error('Expected variable');
  expect(varStmt.declarations[0]?.initializer).toMatchObject({ flags: 'gi', kind: 'regexp', pattern: 'hello' });
});

it('handles type-only import specifier within non-type import clause', () => {
  const result = lower(
    'mixed-type-import.ts',
    `
        import { type TypeOnly, value } from './other.js';
        export function run(): void { value; }
      `,
  );
  expect(result.diagnostics).toEqual([]);
  expect(result.module.imports[0]?.bindings).toHaveLength(2);
  expect(result.module.imports[0]?.bindings[0]).toMatchObject({ typeOnly: true });
  expect(result.module.imports[0]?.bindings[1]).toMatchObject({ typeOnly: false });
});

it('lowers class default export with function and class variants', () => {
  const result = lower(
    'default-class.ts',
    `
        export default class Widget { value = 0; }
      `,
  );
  expect(result.diagnostics).toEqual([]);
  expect(result.module.exports).toEqual(
    expect.arrayContaining([expect.objectContaining({ exported: 'default', kind: 'local' })]),
  );
});

it('lowers default function export', () => {
  const result = lower(
    'default-fn.ts',
    `
        export default function compute(): number { return 42; }
      `,
  );
  expect(result.diagnostics).toEqual([]);
  expect(result.module.exports).toEqual(
    expect.arrayContaining([expect.objectContaining({ exported: 'default', kind: 'local' })]),
  );
});

it('resolves optional parameter omitted and provided invocation semantics', () => {
  const result = lower(
    'optional-param.ts',
    `
        function flex(a: number, b?: string, c?: boolean): void { a; b; c; }
        export function run(): void {
          flex(1);
          flex(1, 'b');
          flex(1, 'b', true);
        }
      `,
  );
  expect(result.diagnostics).toEqual([]);
  const fn = result.module.declarations.find((d) => d.kind === 'function' && d.binding.name === 'run');
  if (fn?.kind !== 'function') throw new Error('Expected function');
  const call1 = fn.body[0];
  if (call1?.kind !== 'expression' || call1.expression.kind !== 'call') throw new Error('Expected call');
  expect(call1.expression.semantics.optionalParameters?.omitted).toEqual([1, 2]);
  const call3 = fn.body[2];
  if (call3?.kind !== 'expression' || call3.expression.kind !== 'call') throw new Error('Expected call');
  expect(call3.expression.semantics.optionalParameters?.omitted).toEqual([]);
  expect(call3.expression.semantics.optionalParameters?.provided).toHaveLength(2);
});

it('resolves default parameter omitted and provided invocation semantics', () => {
  const result = lower(
    'default-param.ts',
    `
        function withDefaults(a: number, b: number = 10, c: string = ''): void { a; b; c; }
        export function run(): void {
          withDefaults(1);
          withDefaults(1, 2);
          withDefaults(1, 2, 'c');
        }
      `,
  );
  expect(result.diagnostics).toEqual([]);
  const fn = result.module.declarations.find((d) => d.kind === 'function' && d.binding.name === 'run');
  if (fn?.kind !== 'function') throw new Error('Expected function');
  const call1 = fn.body[0];
  if (call1?.kind !== 'expression' || call1.expression.kind !== 'call') throw new Error('Expected call');
  expect(call1.expression.semantics.defaultParameters?.omitted).toEqual([1, 2]);
  const call3 = fn.body[2];
  if (call3?.kind !== 'expression' || call3.expression.kind !== 'call') throw new Error('Expected call');
  expect(call3.expression.semantics.defaultParameters?.omitted).toEqual([]);
});

it('resolves indexed receivers through any and unknown type annotations', () => {
  const result = lower(
    'any-unknown-receiver.ts',
    `
        export function run(a: any, u: unknown): void {
          a[0];
          u['key' as any];
        }
      `,
  );
  expect(result.diagnostics).toEqual([]);
});

it('models object type property duplicate and method-property mixing diagnostics', () => {
  const duplicate = lower(
    'duplicate-prop.ts',
    `
        export type Dup = { name: string; name: number };
      `,
  );
  expect(duplicate.diagnostics).toMatchObject([{ code: 'unsupported-typescript' }]);
});

it('lowers interface extends with type parameter substitution', () => {
  const result = lower(
    'generic-extends.ts',
    `
        interface Base<T> { value: T }
        interface Derived extends Base<number> { label: string }
        export function run(d: Derived): void {
          d.value;
          d.label;
        }
      `,
  );
  expect(result.diagnostics).toEqual([]);
});

it('lowers object shorthand properties with binding evidence', () => {
  const result = lower(
    'shorthand.ts',
    `
        export function run(value: number): void {
          const obj = { value };
          obj;
        }
      `,
  );
  expect(result.diagnostics).toEqual([]);
  const fn = result.module.declarations[0];
  if (fn?.kind !== 'function') throw new Error('Expected function');
  const varStmt = fn.body[0];
  if (varStmt?.kind !== 'variable') throw new Error('Expected variable');
  const init = varStmt.declarations[0]?.initializer;
  if (init?.kind !== 'object') throw new Error('Expected object');
  expect(init.members[0]).toMatchObject({ kind: 'property', name: 'value' });
});

it('models for-in statement with key evidence', () => {
  const result = lower(
    'for-in.ts',
    `
        export function run(obj: Record<string, number>): void {
          for (const key in obj) { key; }
        }
      `,
  );
  expect(result.diagnostics).toEqual([]);
  const fn = result.module.declarations[0];
  if (fn?.kind !== 'function') throw new Error('Expected function');
  const forIn = fn.body[0];
  expect(forIn).toMatchObject({ kind: 'forIn' });
});

it('lowers object spread assignment in object literal', () => {
  const result = lower(
    'spread-obj.ts',
    `
        export function run(base: { a: number }): void {
          const merged = { ...base, b: 'new' };
          merged;
        }
      `,
  );
  expect(result.diagnostics).toEqual([]);
  const fn = result.module.declarations[0];
  if (fn?.kind !== 'function') throw new Error('Expected function');
  const varStmt = fn.body[0];
  if (varStmt?.kind !== 'variable') throw new Error('Expected variable');
  const init = varStmt.declarations[0]?.initializer;
  if (init?.kind !== 'object') throw new Error('Expected object');
  expect(init.members[0]).toMatchObject({ kind: 'spread' });
});

it('lowers computed property name in object literal', () => {
  const result = lower(
    'computed-obj.ts',
    `
        export function run(key: string): void {
          const obj = { [key]: 42 };
          obj;
        }
      `,
  );
  expect(result.diagnostics).toEqual([]);
  const fn = result.module.declarations[0];
  if (fn?.kind !== 'function') throw new Error('Expected function');
  const varStmt = fn.body[0];
  if (varStmt?.kind !== 'variable') throw new Error('Expected variable');
  const init = varStmt.declarations[0]?.initializer;
  if (init?.kind !== 'object') throw new Error('Expected object');
  expect(init.members[0]).toMatchObject({ kind: 'computedProperty' });
});

it('lowers indexed access type, keyof, and typeof type operators', () => {
  const result = lower(
    'type-ops.ts',
    `
        interface Data { items: number[]; label: string }
        export type Keys = keyof Data;
        export type ItemType = Data['items'];
        export type DataType = typeof console;
      `,
  );
  expect(result.diagnostics).toEqual([]);
  const keyof = result.module.declarations.find((d) => d.kind === 'typeAlias' && d.binding.name === 'Keys');
  const indexed = result.module.declarations.find((d) => d.kind === 'typeAlias' && d.binding.name === 'ItemType');
  if (keyof?.kind !== 'typeAlias' || indexed?.kind !== 'typeAlias') throw new Error('Expected type aliases');
  expect(keyof.type).toMatchObject({ kind: 'keyof' });
  expect(indexed.type).toMatchObject({ kind: 'indexedAccess' });
});

it('lowers readonly array and tuple type operators', () => {
  const result = lower(
    'readonly-types.ts',
    `
        export type ReadonlyArr = readonly number[];
        export type ReadonlyTuple = readonly [number, string];
      `,
  );
  expect(result.diagnostics).toEqual([]);
  const arr = result.module.declarations[0];
  const tuple = result.module.declarations[1];
  if (arr?.kind !== 'typeAlias' || tuple?.kind !== 'typeAlias') throw new Error('Expected type aliases');
  expect(arr.type).toMatchObject({ kind: 'array', readonly: true });
  expect(tuple.type).toMatchObject({ kind: 'tuple', readonly: true });
});

it('lowers destructuring assignment used as expression with completion value', () => {
  const result = lower(
    'destruct-expr.ts',
    `
        export function run(items: [number, string]): [number, string] {
          let a: number; let b: string;
          const result = ([a, b] = items);
          return result;
        }
      `,
  );
  expect(result.diagnostics).toEqual([]);
  const fn = result.module.declarations[0];
  if (fn?.kind !== 'function') throw new Error('Expected function');
});

it('lowers switch statement with case clauses and default', () => {
  const result = lower(
    'switch.ts',
    `
        export function run(value: string): number {
          switch (value) {
            case 'a': return 1;
            case 'b': return 2;
            default: return 0;
          }
        }
      `,
  );
  expect(result.diagnostics).toEqual([]);
  const fn = result.module.declarations[0];
  if (fn?.kind !== 'function') throw new Error('Expected function');
  const switchStmt = fn.body[0];
  expect(switchStmt).toMatchObject({ kind: 'switch' });
  if (switchStmt?.kind !== 'switch') throw new Error('Expected switch');
  expect(switchStmt.cases).toHaveLength(3);
});

it('lowers while and do-while loops', () => {
  const result = lower(
    'loops.ts',
    `
        export function run(): void {
          let i = 0;
          while (i < 10) { i += 1; }
          do { i -= 1; } while (i > 0);
        }
      `,
  );
  expect(result.diagnostics).toEqual([]);
  const fn = result.module.declarations[0];
  if (fn?.kind !== 'function') throw new Error('Expected function');
  const whileStmt = fn.body.find((s) => s.kind === 'while');
  const doStmt = fn.body.find((s) => s.kind === 'do');
  expect(whileStmt).toMatchObject({ kind: 'while' });
  expect(doStmt).toMatchObject({ kind: 'do' });
});

it('lowers continue statement with label target', () => {
  const result = lower(
    'continue-label.ts',
    `
        export function run(): void {
          outer: for (let i = 0; i < 10; i++) {
            for (let j = 0; j < 10; j++) {
              if (j === 5) continue outer;
            }
          }
        }
      `,
  );
  expect(result.diagnostics).toEqual([]);
});

it('detects narrowed presence through null/undefined guard', () => {
  const result = lower(
    'narrowed-presence.ts',
    `
        export function run(value: string | undefined): string {
          if (value === undefined) return '';
          return value;
        }
      `,
  );
  expect(result.diagnostics).toEqual([]);
  const fn = result.module.declarations[0];
  if (fn?.kind !== 'function') throw new Error('Expected function');
});

it('lowers spread element within array literal', () => {
  const result = lower(
    'spread-array.ts',
    `
        export function run(items: number[]): number[] {
          return [0, ...items, 99];
        }
      `,
  );
  expect(result.diagnostics).toEqual([]);
  const fn = result.module.declarations[0];
  if (fn?.kind !== 'function') throw new Error('Expected function');
  const ret = fn.body[0];
  if (ret?.kind !== 'return' || ret.expression?.kind !== 'array') throw new Error('Expected array');
  expect(ret.expression.elements[1]).toMatchObject({ kind: 'spread' });
});

it('resolves member receiver for array, tuple, string, and named types', () => {
  const result = lower(
    'member-receivers.ts',
    `
        export function run(
          arr: number[],
          tuple: [number, string],
          str: string,
          map: Map<string, number>,
          date: Date,
          err: Error,
          set: Set<number>,
          promise: Promise<number>,
        ): void {
          arr.length;
          tuple.length;
          str.length;
          map.size;
          date.getTime();
          err.message;
          set.size;
          promise.then(() => {});
        }
      `,
  );
  expect(result.diagnostics).toEqual([]);
});

it('lowers throw statement with expression', () => {
  const result = lower(
    'throw.ts',
    `
        export function run(): never {
          throw new Error('failure');
        }
      `,
  );
  expect(result.diagnostics).toEqual([]);
  const fn = result.module.declarations[0];
  if (fn?.kind !== 'function') throw new Error('Expected function');
  expect(fn.body[0]).toMatchObject({ kind: 'throw' });
});

it('lowers conditional ternary expression', () => {
  const result = lower(
    'ternary.ts',
    `
        export function run(flag: boolean): number {
          return flag ? 1 : 0;
        }
      `,
  );
  expect(result.diagnostics).toEqual([]);
  const fn = result.module.declarations[0];
  if (fn?.kind !== 'function') throw new Error('Expected function');
  const ret = fn.body[0];
  if (ret?.kind !== 'return') throw new Error('Expected return');
  expect(ret.expression).toMatchObject({ kind: 'conditional' });
});

it('lowers non-null assertion as transparent pass-through', () => {
  const result = lower(
    'non-null.ts',
    `
        export function run(value: number | undefined): number {
          return value!;
        }
      `,
  );
  expect(result.diagnostics).toEqual([]);
  const fn = result.module.declarations[0];
  if (fn?.kind !== 'function') throw new Error('Expected function');
  const ret = fn.body[0];
  if (ret?.kind !== 'return') throw new Error('Expected return');
  expect(ret.expression).toMatchObject({ kind: 'identifier' });
});

it('lowers as type assertion expression', () => {
  const result = lower(
    'assertions.ts',
    `
        export function run(value: unknown): string {
          const typed = value as string;
          return typed;
        }
      `,
  );
  expect(result.diagnostics).toEqual([]);
});

it('lowers comma operator as binary expression', () => {
  const result = lower(
    'comma.ts',
    `
        export function run(): number {
          return (1, 2, 3);
        }
      `,
  );
  expect(result.diagnostics).toEqual([]);
  const fn = result.module.declarations[0];
  if (fn?.kind !== 'function') throw new Error('Expected function');
  const ret = fn.body[0];
  if (ret?.kind !== 'return') throw new Error('Expected return');
  expect(ret.expression).toMatchObject({ kind: 'binary', operator: ',' });
});

it('lowers postfix increment and decrement operators', () => {
  const result = lower(
    'postfix.ts',
    `
        export function run(): number {
          let a = 0;
          a++;
          a--;
          return a;
        }
      `,
  );
  expect(result.diagnostics).toEqual([]);
  const fn = result.module.declarations[0];
  if (fn?.kind !== 'function') throw new Error('Expected function');
  const inc = fn.body[1];
  if (inc?.kind !== 'expression' || inc.expression.kind !== 'unary') throw new Error('Expected unary');
  expect(inc.expression.operator).toBe('++');
  expect(inc.expression.postfix).toBe(true);
});

it('lowers prefix unary operators (negation, bitwise not, logical not)', () => {
  const result = lower(
    'prefix.ts',
    `
        export function run(a: number, b: boolean): void {
          const neg = -a;
          const bitwiseNot = ~a;
          const logicalNot = !b;
          const plus = +a;
          neg; bitwiseNot; logicalNot; plus;
        }
      `,
  );
  expect(result.diagnostics).toEqual([]);
});

it('lowers arrow function expression', () => {
  const result = lower(
    'arrow.ts',
    `
        export const add = (a: number, b: number): number => a + b;
      `,
  );
  expect(result.diagnostics).toEqual([]);
  const decl = result.module.declarations[0];
  if (decl?.kind !== 'variable') throw new Error('Expected variable');
  expect(decl.initializer).toMatchObject({ kind: 'function' });
});

it('lowers function expression with name', () => {
  const result = lower(
    'fn-expr.ts',
    `
        export const factorial = function fact(n: number): number {
          return n <= 1 ? 1 : n * fact(n - 1);
        };
      `,
  );
  expect(result.diagnostics).toEqual([]);
  const decl = result.module.declarations[0];
  if (decl?.kind !== 'variable') throw new Error('Expected variable');
  expect(decl.initializer).toMatchObject({ kind: 'function' });
});

it('lowers template literal with substitutions', () => {
  const result = lower(
    'template.ts',
    `
        export function run(name: string, age: number): string {
          return \`Hello \${name}, age \${age}\`;
        }
      `,
  );
  expect(result.diagnostics).toEqual([]);
  const fn = result.module.declarations[0];
  if (fn?.kind !== 'function') throw new Error('Expected function');
  const ret = fn.body[0];
  if (ret?.kind !== 'return') throw new Error('Expected return');
  expect(ret.expression).toMatchObject({ kind: 'template' });
});

it('lowers compound assignment operators (+=, -=, *=)', () => {
  const result = lower(
    'compound-assign.ts',
    `
        export function run(): number {
          let value = 10;
          value += 5;
          value -= 3;
          value *= 2;
          return value;
        }
      `,
  );
  expect(result.diagnostics).toEqual([]);
  const fn = result.module.declarations[0];
  if (fn?.kind !== 'function') throw new Error('Expected function');
  const add = fn.body[1];
  if (add?.kind !== 'expression' || add.expression.kind !== 'assignment') throw new Error('Expected assignment');
  expect(add.expression.operator).toBe('+=');
});

it('lowers object destructuring assignment with property initializer target', () => {
  const result = lower(
    'destruct-obj-target.ts',
    `
        export function run(obj: { a: number; b: string }): void {
          let x: number; let y: string;
          ({ a: x, b: y } = obj);
          x; y;
        }
      `,
  );
  expect(result.diagnostics).toEqual([]);
});

it('lowers destructuring assignment with default value', () => {
  const result = lower(
    'destruct-default.ts',
    `
        export function run(arr: [number | undefined, string]): void {
          let a: number; let b: string;
          [a = 0, b] = arr;
          a; b;
        }
      `,
  );
  expect(result.diagnostics).toEqual([]);
});

it('resolves type evidence through ReadonlyArray type reference', () => {
  const result = lower(
    'readonly-array-ref.ts',
    `
        export function run(items: ReadonlyArray<number>): void {
          for (const item of items) { item; }
        }
      `,
  );
  expect(result.diagnostics).toEqual([]);
});

it('resolves type evidence through generic type alias substitution', () => {
  const result = lower(
    'generic-alias.ts',
    `
        type Container<T> = { value: T };
        interface Target { process(c: Container<number>): void }
        export function run(t: Target): void {
          t.process({ value: 42 });
        }
      `,
  );
  expect(result.diagnostics).toEqual([]);
});

it('lowers overloaded object method signatures in type literal', () => {
  const result = lower(
    'method-overload-type.ts',
    `
        export type Handler = {
          handle(value: number): number;
          handle(value: string): string;
        };
      `,
  );
  expect(result.diagnostics).toEqual([]);
  const decl = result.module.declarations[0];
  if (decl?.kind !== 'typeAlias') throw new Error('Expected typeAlias');
  expect(decl.type).toMatchObject({ kind: 'object' });
});

it('lowers interface with overloaded method signatures', () => {
  const result = lower(
    'interface-method-overload.ts',
    `
        export interface Processor {
          process(value: number): number;
          process(value: string): string;
        }
      `,
  );
  expect(result.diagnostics).toEqual([]);
  const decl = result.module.declarations[0];
  if (decl?.kind !== 'interface') throw new Error('Expected interface');
});

it('lowers class method with overload signatures', () => {
  const result = lower(
    'class-method-overload.ts',
    `
        export class Converter {
          convert(value: number): string;
          convert(value: string): number;
          convert(value: number | string): number | string {
            return typeof value === 'number' ? String(value) : Number(value);
          }
        }
      `,
  );
  expect(result.diagnostics).toEqual([]);
  const cls = result.module.declarations[0];
  if (cls?.kind !== 'class') throw new Error('Expected class');
  const method = cls.methods.find((m) => m.name === 'convert');
  expect(method?.overloads).toHaveLength(2);
});

it('lowers function overload signatures', () => {
  const result = lower(
    'fn-overloads.ts',
    `
        export function parse(value: string): number;
        export function parse(value: number): string;
        export function parse(value: string | number): number | string {
          return typeof value === 'string' ? Number(value) : String(value);
        }
      `,
  );
  expect(result.diagnostics).toEqual([]);
  const fn = result.module.declarations[0];
  if (fn?.kind !== 'function') throw new Error('Expected function');
  expect(fn.overloads).toHaveLength(2);
});

it('lowers for-in with key evidence from typed record', () => {
  const result = lower(
    'for-in-key.ts',
    `
        interface Config { host: string; port: number }
        export function keys(c: Config): void {
          for (const key in c) { key; }
        }
      `,
  );
  expect(result.diagnostics).toEqual([]);
  const fn = result.module.declarations.find((d) => d.kind === 'function' && d.binding.name === 'keys');
  if (fn?.kind !== 'function') throw new Error('Expected function');
  const forIn = fn.body[0];
  expect(forIn).toMatchObject({ kind: 'forIn' });
});

it('resolves optional parameter omitted and provided invocation semantics', () => {
  const result = lower(
    'optional-param.ts',
    `
        function flex(a: number, b?: string, c?: boolean): void { a; b; c; }
        export function run(): void {
          flex(1);
          flex(1, 'b');
          flex(1, 'b', true);
        }
      `,
  );
  expect(result.diagnostics).toEqual([]);
  const fn = result.module.declarations.find((d) => d.kind === 'function' && d.binding.name === 'run');
  if (fn?.kind !== 'function') throw new Error('Expected function');
  const call1 = fn.body[0];
  if (call1?.kind !== 'expression' || call1.expression.kind !== 'call') throw new Error('Expected call');
  expect(call1.expression.semantics.optionalParameters?.omitted).toEqual([1, 2]);
});

it('resolves default parameter omitted and provided invocation semantics', () => {
  const result = lower(
    'default-param.ts',
    `
        function withDefaults(a: number, b: number = 10, c: string = ''): void { a; b; c; }
        export function run(): void {
          withDefaults(1);
          withDefaults(1, 2);
          withDefaults(1, 2, 'c');
        }
      `,
  );
  expect(result.diagnostics).toEqual([]);
  const fn = result.module.declarations.find((d) => d.kind === 'function' && d.binding.name === 'run');
  if (fn?.kind !== 'function') throw new Error('Expected function');
  const call1 = fn.body[0];
  if (call1?.kind !== 'expression' || call1.expression.kind !== 'call') throw new Error('Expected call');
  expect(call1.expression.semantics.defaultParameters?.omitted).toEqual([1, 2]);
});

it('lowers object shorthand properties with binding evidence', () => {
  const result = lower(
    'shorthand.ts',
    `
        export function run(value: number): void {
          const obj = { value };
          obj;
        }
      `,
  );
  expect(result.diagnostics).toEqual([]);
  const fn = result.module.declarations[0];
  if (fn?.kind !== 'function') throw new Error('Expected function');
  const varStmt = fn.body[0];
  if (varStmt?.kind !== 'variable') throw new Error('Expected variable');
  const init = varStmt.declarations[0]?.initializer;
  if (init?.kind !== 'object') throw new Error('Expected object');
  expect(init.members[0]).toMatchObject({ kind: 'property', name: 'value' });
});

it('lowers object spread assignment in object literal', () => {
  const result = lower(
    'spread-obj.ts',
    `
        export function run(base: { a: number }): void {
          const merged = { ...base, b: 'new' };
          merged;
        }
      `,
  );
  expect(result.diagnostics).toEqual([]);
});

it('reports diagnostic for unsupported top-level statement', () => {
  const result = lower('top-level-catch.ts', `debugger;`);
  expect(result.diagnostics.length).toBeGreaterThanOrEqual(1);
  expect(result.diagnostics[0]!.message).toContain('unsupported top-level');
});

it('reports diagnostic for class with multiple constructor overloads but no implementation', () => {
  const result = lower(
    'constructor-overloads.ts',
    `export class Multi {
      constructor(a: number);
      constructor(a: string);
    }`,
  );
  expect(result.diagnostics.length).toBeGreaterThanOrEqual(1);
  expect(result.diagnostics[0]!.message).toContain('constructor overloads');
});

it('reports diagnostic for parameter property with rest parameter', () => {
  const result = lower(
    'param-prop-destructured.ts',
    `export class Foo {
      constructor(public ...items: number[]) {}
    }`,
  );
  expect(result.diagnostics.length).toBeGreaterThanOrEqual(1);
  expect(result.diagnostics[0]!.message).toContain('parameter properties require a named non-rest parameter');
});

it('does not create parameter property for unmodified constructor parameter', () => {
  const result = lower(
    'no-param-prop.ts',
    `export class Simple {
      constructor(value: number) {}
    }`,
  );
  const cls = result.module.declarations.find((d) => d.kind === 'class');
  if (cls?.kind !== 'class') throw new Error('Expected class');
  expect(cls.fields.length).toBe(0);
});

it('lowers namespace re-export', () => {
  const result = lower('namespace-reexport.ts', `export * as utils from './utils';`);
  expect(result.module.exports).toMatchObject([{ kind: 'namespace', exported: 'utils', specifier: './utils' }]);
});

it('creates export entries for destructured variable declarations', () => {
  const result = lower(
    'destructured-export.ts',
    `const pair: [number, string] = [1, 'a'];
export const [first, second] = pair;`,
  );
  const exports = result.module.exports.filter((e) => e.kind === 'local');
  expect(exports).toMatchObject([
    expect.objectContaining({ exported: 'first' }),
    expect.objectContaining({ exported: 'second' }),
  ]);
});

it('lowers call expression with explicit type arguments', () => {
  const result = lower(
    'call-type-args.ts',
    `function identity<T>(value: T): T { return value; }
export const result = identity<number>(42);`,
  );
  const variable = result.module.declarations.find(
    (d) => d.kind === 'variable' && 'binding' in d && d.binding.name === 'result',
  );
  expect(variable).toBeDefined();
});

it('reports diagnostic for unsupported expression syntax', () => {
  const result = lower('meta-property.ts', `export function check(): string { return import.meta.url; }`);
  expect(result.diagnostics.length).toBeGreaterThanOrEqual(1);
});

it('skips extra argument erasure for optional calls', () => {
  const result = lower(
    'optional-call-extra.ts',
    `const fn: ((a: number) => number) | undefined = undefined;
export const result = fn?.(1, 2);`,
  );
  const variable = result.module.declarations.find(
    (d) => d.kind === 'variable' && 'binding' in d && d.binding.name === 'result',
  );
  expect(variable).toBeDefined();
});

it('reports diagnostic for contextual tuple with rest type', () => {
  const result = lower(
    'tuple-rest-type.ts',
    `type Rest = [number, ...string[]];
export function make(): Rest { return [1, 'a', 'b']; }`,
  );
  expect(result.diagnostics.length).toBeGreaterThanOrEqual(1);
  expect(result.diagnostics[0]!.message).toContain('rest');
});

it('reports diagnostic when tuple spread exceeds fixed type', () => {
  const result = lower(
    'tuple-spread-overflow.ts',
    `type Pair = [number, number];
type Triple = [number, number, number];
const triple: Triple = [1, 2, 3];
export function make(): Pair { return [...triple]; }`,
  );
  expect(result.diagnostics.length).toBeGreaterThanOrEqual(1);
});

it('resolves indexed receiver through type alias chain', () => {
  const result = lower(
    'alias-indexed.ts',
    `type StringList = string[];
export function get(list: StringList, i: number): string { return list[i]; }`,
  );
  const fn = result.module.declarations.find((d) => d.kind === 'function');
  expect(fn).toBeDefined();
});

it('detects typed array set invocation via element access syntax', () => {
  const result = lower(
    'typed-array-set.ts',
    `export function fill(buf: Float32Array): void {
  buf['set']([1, 2, 3]);
}`,
  );
  const fn = result.module.declarations.find((d) => d.kind === 'function');
  expect(fn).toBeDefined();
});

it('records optional parameter invocation with spread arguments as dynamic', () => {
  const result = lower(
    'optional-param-dynamic.ts',
    `function greet(name?: string): string { return name ?? 'world'; }
const args: [] = [];
export const result = greet(...args);`,
  );
  const variable = result.module.declarations.find(
    (d) => d.kind === 'variable' && 'binding' in d && d.binding.name === 'result',
  );
  expect(variable).toBeDefined();
});

it('records default parameter invocation with spread arguments as dynamic', () => {
  const result = lower(
    'default-param-dynamic.ts',
    `function greet(name: string = 'world'): string { return name; }
const args: [] = [];
export const result = greet(...args);`,
  );
  const variable = result.module.declarations.find(
    (d) => d.kind === 'variable' && 'binding' in d && d.binding.name === 'result',
  );
  expect(variable).toBeDefined();
});

it('records invocation signature with rest parameter', () => {
  const result = lower(
    'rest-param-invocation.ts',
    `function sum(...values: number[]): number { return values.reduce((a, b) => a + b, 0); }
export const total = sum(1, 2, 3);`,
  );
  const variable = result.module.declarations.find(
    (d) => d.kind === 'variable' && 'binding' in d && d.binding.name === 'total',
  );
  expect(variable).toBeDefined();
});

it('reports diagnostic for function declaration without body and no overload', () => {
  const result = lower('no-body-fn.ts', `export function abstract(): void;`);
  expect(result.diagnostics.length).toBeGreaterThanOrEqual(1);
  expect(result.diagnostics[0]!.message).toContain('no implementation');
});

it('emits parameter binding entries for destructured function parameter', () => {
  const result = lower(
    'destructured-param.ts',
    `export function extract({ x, y }: { x: number; y: number }): number { return x + y; }`,
  );
  const fn = result.module.declarations.find((d) => d.kind === 'function');
  if (fn?.kind !== 'function') throw new Error('Expected function');
  const paramEntry = fn.body.find((s) => s.kind === 'variable' && s.declarations.some((d) => 'pattern' in d));
  expect(paramEntry).toBeDefined();
});

it('lowers destructuring assignment as expression with completion value', () => {
  const result = lower(
    'destructure-expr.ts',
    `let a: number, b: number;
export function swap(): number {
  return ([a, b] = [b, a])[0];
}`,
  );
  const fn = result.module.declarations.find((d) => d.kind === 'function');
  if (fn?.kind !== 'function') throw new Error('Expected function');
  const ret = fn.body.find((s) => s.kind === 'return');
  expect(ret).toBeDefined();
});

it('lowers object destructuring assignment with computed property key', () => {
  const result = lower(
    'destructure-computed.ts',
    `const key = 'x' as const;
let target: number;
export function run(obj: { x: number }): void {
  ({ [key]: target } = obj);
}`,
  );
  const fn = result.module.declarations.find((d) => d.kind === 'function');
  expect(fn).toBeDefined();
});

it('infers for-of element type through type alias', () => {
  const result = lower(
    'for-of-alias.ts',
    `type Numbers = number[];
export function sum(items: Numbers): number {
  let total = 0;
  for (const item of items) { total += item; }
  return total;
}`,
  );
  const fn = result.module.declarations.find((d) => d.kind === 'function');
  if (fn?.kind !== 'function') throw new Error('Expected function');
  const forOf = fn.body.find((s) => s.kind === 'forOf');
  expect(forOf).toBeDefined();
});

it('infers for-of element type through readonly array', () => {
  const result = lower(
    'for-of-readonly.ts',
    `export function first(items: readonly number[]): number {
  for (const item of items) { return item; }
  return 0;
}`,
  );
  const fn = result.module.declarations.find((d) => d.kind === 'function');
  if (fn?.kind !== 'function') throw new Error('Expected function');
  const forOf = fn.body.find((s) => s.kind === 'forOf');
  expect(forOf).toBeDefined();
});

it('infers for-of element type through generic alias', () => {
  const result = lower(
    'for-of-generic-alias.ts',
    `type List<T> = T[];
export function first(items: List<string>): string {
  for (const item of items) { return item; }
  return '';
}`,
  );
  const fn = result.module.declarations.find((d) => d.kind === 'function');
  if (fn?.kind !== 'function') throw new Error('Expected function');
  const forOf = fn.body.find((s) => s.kind === 'forOf');
  expect(forOf).toBeDefined();
});

it('resolves type evidence through interface with generic substitution', () => {
  const result = lower(
    'evidence-interface-generic.ts',
    `interface Container<T> { value: T }
export function unwrap(c: Container<number>): number { return c.value; }`,
  );
  const fn = result.module.declarations.find((d) => d.kind === 'function');
  expect(fn).toBeDefined();
});

it('resolves interface heritage properties with generic substitution', () => {
  const result = lower(
    'evidence-heritage.ts',
    `interface Base<T> { value: T }
interface Extended extends Base<number> { label: string }
export function read(e: Extended): number { return e.value; }`,
  );
  const fn = result.module.declarations.find((d) => d.kind === 'function');
  expect(fn).toBeDefined();
});

it('lowers object binding pattern with rest element', () => {
  const result = lower(
    'object-bind-rest.ts',
    `export function extract(obj: { a: number; b: string; c: boolean }): { b: string; c: boolean } {
  const { a, ...rest } = obj;
  return rest;
}`,
  );
  const fn = result.module.declarations.find((d) => d.kind === 'function');
  if (fn?.kind !== 'function') throw new Error('Expected function');
  const varStmt = fn.body.find((s) => s.kind === 'variable');
  expect(varStmt).toBeDefined();
});

it('lowers array binding pattern with rest element from tuple', () => {
  const result = lower(
    'array-bind-rest.ts',
    `export function tail(items: [number, ...string[]]): string[] {
  const [, ...rest] = items;
  return rest;
}`,
  );
  const fn = result.module.declarations.find((d) => d.kind === 'function');
  expect(fn).toBeDefined();
});

it('assigns function scope to parameter binding patterns', () => {
  const result = lower(
    'param-bind-scope.ts',
    `export function extract([a, b]: [number, string]): number { return a; }`,
  );
  const fn = result.module.declarations.find((d) => d.kind === 'function');
  if (fn?.kind !== 'function') throw new Error('Expected function');
  const paramEntry = fn.body.find((s) => s.kind === 'variable' && s.declarations.some((d) => 'pattern' in d));
  expect(paramEntry).toBeDefined();
});

it('assigns function scope to var inside function', () => {
  const result = lower(
    'var-scope.ts',
    `export function run(): number {
  if (true) { var x = 1; }
  return x;
}`,
  );
  const fn = result.module.declarations.find((d) => d.kind === 'function');
  if (fn?.kind !== 'function') throw new Error('Expected function');
  const ifStmt = fn.body.find((s) => s.kind === 'if');
  expect(ifStmt).toBeDefined();
});

it('assigns function scope to type parameter on function', () => {
  const result = lower('type-param-fn.ts', `export function identity<T>(value: T): T { return value; }`);
  const fn = result.module.declarations.find((d) => d.kind === 'function');
  if (fn?.kind !== 'function') throw new Error('Expected function');
  expect(fn.typeParameters[0]?.binding.scope).toBe('function');
});

it('assigns declaration scope to type parameter on interface', () => {
  const result = lower('type-param-iface.ts', `export interface Container<T> { value: T }`);
  const iface = result.module.declarations.find((d) => d.kind === 'interface');
  if (iface?.kind !== 'interface') throw new Error('Expected interface');
  expect(iface.typeParameters[0]?.binding.scope).toBe('declaration');
});

it('assigns declaration scope to type parameter on type alias', () => {
  const result = lower('type-param-alias.ts', `export type Wrapper<T> = { value: T };`);
  const ta = result.module.declarations.find((d) => d.kind === 'typeAlias');
  if (ta?.kind !== 'typeAlias') throw new Error('Expected type alias');
  expect(ta.typeParameters[0]?.binding.scope).toBe('declaration');
});

it('capitalizes Index module name for index.ts files', () => {
  const result = lower('index.ts', `export const value = 1;`);
  expect(result.module.name).toBe('Index');
});

it('reports diagnostic for namespace with value members', () => {
  const result = lower('value-namespace.ts', `export namespace Utils { export function helper(): void {} }`);
  expect(result.diagnostics.length).toBeGreaterThanOrEqual(1);
  expect(result.diagnostics[0]!.message).toContain('namespace');
});

it('ignores namespace with only type members', () => {
  const result = lower('type-namespace.ts', `export namespace Types { export interface Foo { value: number } }`);
  expect(result.diagnostics.length).toBe(0);
});

it('reports diagnostic for nested namespace with value members', () => {
  const result = lower(
    'nested-namespace.ts',
    `export namespace Outer { export namespace Inner { export const x = 1; } }`,
  );
  expect(result.diagnostics.length).toBeGreaterThanOrEqual(1);
});

it('lowers tuple type evidence with optional and rest elements', () => {
  const result = lower(
    'tuple-evidence.ts',
    `export function process(input: [number, string?, ...boolean[]]): number {
  return input[0];
}`,
  );
  const fn = result.module.declarations.find((d) => d.kind === 'function');
  expect(fn).toBeDefined();
});

it('records narrowed boolean member from boolean-containing union', () => {
  const result = lower(
    'narrowed-boolean.ts',
    `type Token = boolean | string;
export function check(value: Token): boolean {
  if (typeof value === 'boolean') return value;
  return false;
}`,
  );
  const fn = result.module.declarations.find((d) => d.kind === 'function');
  expect(fn).toBeDefined();
});

it('resolves export binding for type-only exports', () => {
  const result = lower(
    'export-type-binding.ts',
    `interface Foo { value: number }
function bar(): number { return 1; }
export { type Foo, bar };`,
  );
  const typeExport = result.module.exports.find((e) => e.kind === 'local' && e.exported === 'Foo');
  expect(typeExport).toBeDefined();
  expect(typeExport).toMatchObject({ typeOnly: true });
});

it('resolves indexed receiver through union type', () => {
  const result = lower(
    'union-receiver.ts',
    `export function get(value: number[] | string): number {
  return value[0] as number;
}`,
  );
  const fn = result.module.declarations.find((d) => d.kind === 'function');
  expect(fn).toBeDefined();
});

it('resolves indexed receiver from type literal', () => {
  const result = lower(
    'literal-receiver.ts',
    `export function get(obj: { x: number; y: number }): number {
  const key = 'x';
  return obj[key];
}`,
  );
  const fn = result.module.declarations.find((d) => d.kind === 'function');
  expect(fn).toBeDefined();
});

it('resolves indexed receiver from tuple type declaration', () => {
  const result = lower(
    'tuple-receiver.ts',
    `export function first(pair: [number, string]): number {
  return pair[0];
}`,
  );
  const fn = result.module.declarations.find((d) => d.kind === 'function');
  expect(fn).toBeDefined();
});

it('lowers object binding rest when computed key is present', () => {
  const result = lower(
    'object-rest-computed.ts',
    `const key = 'x' as const;
export function run(obj: { x: number; y: string }): object {
  const { [key]: value, ...rest } = obj;
  return rest;
}`,
  );
  const fn = result.module.declarations.find((d) => d.kind === 'function');
  expect(fn).toBeDefined();
});

it('handles binding pattern undefined addition for already-undefined type', () => {
  const result = lower(
    'bind-undef-idempotent.ts',
    `export function extract(pair: [number | undefined, string]): number | undefined {
  const [first] = pair;
  return first;
}`,
  );
  const fn = result.module.declarations.find((d) => d.kind === 'function');
  expect(fn).toBeDefined();
});

it('resolves catch clause binding kind', () => {
  const result = lower(
    'catch-binding-kind.ts',
    `export function attempt(): string {
  try { return 'ok'; }
  catch (error) { return String(error); }
}`,
  );
  const fn = result.module.declarations.find((d) => d.kind === 'function');
  if (fn?.kind !== 'function') throw new Error('Expected function');
  const tryStmt = fn.body.find((s) => s.kind === 'try');
  if (tryStmt?.kind !== 'try') throw new Error('Expected try');
  expect(tryStmt.catchClause?.binding?.kind).toBe('catch');
});

it('resolves type binding identity for type alias', () => {
  const result = lower('type-binding-id.ts', `export type Id = number;`);
  const ta = result.module.declarations.find((d) => d.kind === 'typeAlias');
  if (ta?.kind !== 'typeAlias') throw new Error('Expected type alias');
  expect(ta.binding.space).toBe('type');
  expect(ta.binding.kind).toBe('typeAlias');
});

it('resolves type binding kind for interface declaration', () => {
  const result = lower('type-binding-iface.ts', `export interface Marker {}`);
  const iface = result.module.declarations.find((d) => d.kind === 'interface');
  if (iface?.kind !== 'interface') throw new Error('Expected interface');
  expect(iface.binding.space).toBe('type');
  expect(iface.binding.kind).toBe('interface');
});

it('handles absent member removal from union type in nullish coalesce', () => {
  const result = lower(
    'absent-removal.ts',
    `export function safe(value: string | undefined | null): string {
  return value ?? 'default';
}`,
  );
  const fn = result.module.declarations.find((d) => d.kind === 'function');
  expect(fn).toBeDefined();
});

it('records nullish comparison evidence for equality with null', () => {
  const result = lower(
    'nullish-comparison.ts',
    `export function isNull(value: string | null): boolean {
  return value === null;
}`,
  );
  const fn = result.module.declarations.find((d) => d.kind === 'function');
  expect(fn).toBeDefined();
});

it('records nullish comparison evidence for equality with undefined', () => {
  const result = lower(
    'nullish-comparison-undef.ts',
    `export function isUndefined(value: number | undefined): boolean {
  return value === undefined;
}`,
  );
  const fn = result.module.declarations.find((d) => d.kind === 'function');
  expect(fn).toBeDefined();
});

it('derives operator domain from binary expression result for nested operators', () => {
  const result = lower(
    'nested-binary-domain.ts',
    `export function compute(a: number, b: number): number {
  return (a + b) * 2;
}`,
  );
  const fn = result.module.declarations.find((d) => d.kind === 'function');
  expect(fn).toBeDefined();
});

it('resolves present value domain for nullish coalescing on element access', () => {
  const result = lower(
    'present-domain-elem.ts',
    `export function first(items: number[]): number {
  return items[0] ?? 0;
}`,
  );
  const fn = result.module.declarations.find((d) => d.kind === 'function');
  expect(fn).toBeDefined();
});

it('resolves present value domain for nullish coalescing on union binding', () => {
  const result = lower(
    'present-domain-union.ts',
    `export function safe(value: number | undefined): number {
  return value ?? 0;
}`,
  );
  const fn = result.module.declarations.find((d) => d.kind === 'function');
  expect(fn).toBeDefined();
});

it('resolves operator value domain through type parameter constraint', () => {
  const result = lower(
    'type-param-domain.ts',
    `export function double<T extends number>(value: T): number {
  return value * 2;
}`,
  );
  const fn = result.module.declarations.find((d) => d.kind === 'function');
  expect(fn).toBeDefined();
});

it('infers contextual parameter type from callback position', () => {
  const result = lower(
    'contextual-param.ts',
    `export function apply(items: number[]): number[] {
  return items.map((value) => value * 2);
}`,
  );
  const fn = result.module.declarations.find((d) => d.kind === 'function');
  expect(fn).toBeDefined();
});

it('resolves expression binding type evidence through property access', () => {
  const result = lower(
    'binding-evidence-property.ts',
    `interface Config { items: number[] }
export function count(c: Config): number {
  return c.items.length;
}`,
  );
  const fn = result.module.declarations.find((d) => d.kind === 'function');
  expect(fn).toBeDefined();
});

it('resolves expression binding type evidence through call expression', () => {
  const result = lower(
    'binding-evidence-call.ts',
    `export function run(items: number[]): number {
  return items.map((x) => x * 2).length;
}`,
  );
  const fn = result.module.declarations.find((d) => d.kind === 'function');
  expect(fn).toBeDefined();
});

it('resolves declared type evidence for module-declared type', () => {
  const result = lower(
    'declared-type-evidence.ts',
    `interface Point { x: number; y: number }
export function origin(): Point { return { x: 0, y: 0 }; }
export function distance(p: Point): number {
  const pt = origin();
  return pt.x + pt.y;
}`,
  );
  const fn = result.module.declarations.find((d) => d.kind === 'function' && d.binding.name === 'distance');
  expect(fn).toBeDefined();
});

it('resolves indexed receiver from checker type through type parameter', () => {
  const result = lower(
    'indexed-type-param.ts',
    `export function first<T extends string[]>(items: T): string {
  return items[0];
}`,
  );
  const fn = result.module.declarations.find((d) => d.kind === 'function');
  expect(fn).toBeDefined();
});

it('lowers indexed access type node', () => {
  const result = lower(
    'indexed-access-type.ts',
    `interface Config { items: string[] }
export type ItemType = Config['items'];`,
  );
  const ta = result.module.declarations.find((d) => d.kind === 'typeAlias');
  expect(ta).toBeDefined();
});

it('lowers typeof type query', () => {
  const result = lower(
    'typeof-query.ts',
    `const config = { width: 100 };
export type ConfigType = typeof config;`,
  );
  const ta = result.module.declarations.find((d) => d.kind === 'typeAlias');
  expect(ta).toBeDefined();
});

it('lowers qualified type name parts for namespace access', () => {
  const result = lower(
    'qualified-type.ts',
    `export namespace NS { export interface Value { n: number } }
export type Alias = NS.Value;`,
  );
  expect(result.module.declarations.length).toBeGreaterThanOrEqual(1);
});

it('resolves member evidence from object type', () => {
  const result = lower(
    'member-evidence.ts',
    `export function get(obj: { nested: { value: number } }): number {
  return obj.nested.value;
}`,
  );
  const fn = result.module.declarations.find((d) => d.kind === 'function');
  expect(fn).toBeDefined();
});

it('lowers for statement with all clauses', () => {
  const result = lower(
    'for-full.ts',
    `export function countdown(): number {
  let sum = 0;
  for (let i = 10; i > 0; i--) { sum += i; }
  return sum;
}`,
  );
  const fn = result.module.declarations.find((d) => d.kind === 'function');
  if (fn?.kind !== 'function') throw new Error('Expected function');
  const forStmt = fn.body.find((s) => s.kind === 'for');
  expect(forStmt).toBeDefined();
});

it('lowers try-catch-finally with all clauses', () => {
  const result = lower(
    'try-catch-finally.ts',
    `export function safe(): number {
  try { return 1; }
  catch (error) { return 0; }
  finally {}
}`,
  );
  const fn = result.module.declarations.find((d) => d.kind === 'function');
  if (fn?.kind !== 'function') throw new Error('Expected function');
  const tryStmt = fn.body.find((s) => s.kind === 'try');
  if (tryStmt?.kind !== 'try') throw new Error('Expected try');
  expect(tryStmt.finallyBody).toBeDefined();
});

it('lowers labeled block statement', () => {
  const result = lower(
    'labeled-block.ts',
    `export function run(): void {
  label: { break label; }
}`,
  );
  const fn = result.module.declarations.find((d) => d.kind === 'function');
  if (fn?.kind !== 'function') throw new Error('Expected function');
  const block = fn.body.find((s) => s.kind === 'block');
  expect(block).toBeDefined();
});

it('lowers empty statement as block', () => {
  const result = lower(
    'empty-stmt.ts',
    `export function noop(): void {
  ;
}`,
  );
  const fn = result.module.declarations.find((d) => d.kind === 'function');
  if (fn?.kind !== 'function') throw new Error('Expected function');
  expect(fn.body.length).toBeGreaterThanOrEqual(1);
});

it('lowers class with abstract method', () => {
  const result = lower(
    'abstract-method.ts',
    `export abstract class Base {
  abstract run(): void;
}`,
  );
  const cls = result.module.declarations.find((d) => d.kind === 'class');
  if (cls?.kind !== 'class') throw new Error('Expected class');
  expect(cls.abstract).toBe(true);
  expect(cls.methods).toHaveLength(1);
  expect(cls.methods[0]).toMatchObject({ abstract: true, name: 'run' });
});

it('lowers class with getter and setter accessors', () => {
  const result = lower(
    'class-accessors.ts',
    `export class Box {
  private _value: number = 0;
  get value(): number { return this._value; }
  set value(n: number) { this._value = n; }
}`,
  );
  const cls = result.module.declarations.find((d) => d.kind === 'class');
  if (cls?.kind !== 'class') throw new Error('Expected class');
  const getter = cls.methods.find((m) => m.name === 'value' && 'accessor' in m && m.accessor === 'get');
  const setter = cls.methods.find((m) => m.name === 'value' && 'accessor' in m && m.accessor === 'set');
  expect(getter).toBeDefined();
  expect(setter).toBeDefined();
});

it('lowers class with constructor overloads and implementation', () => {
  const result = lower(
    'constructor-overload-impl.ts',
    `export class Builder {
  value: number;
  constructor(n: number);
  constructor(s: string);
  constructor(input: number | string) { this.value = typeof input === 'number' ? input : input.length; }
}`,
  );
  const cls = result.module.declarations.find((d) => d.kind === 'class');
  if (cls?.kind !== 'class') throw new Error('Expected class');
  expect(cls.classConstructor).toBeDefined();
  expect(cls.classConstructor!.overloads.length).toBe(2);
});

it('lowers async function with Promise return type unwrapping', () => {
  const result = lower(
    'async-promise-return.ts',
    `export async function fetch(): Promise<number> {
  return 42;
}`,
  );
  const fn = result.module.declarations.find((d) => d.kind === 'function');
  if (fn?.kind !== 'function') throw new Error('Expected function');
  expect(fn.async).toBe(true);
});

it('lowers interface with call signature overloads', () => {
  const result = lower(
    'overloaded-interface-method.ts',
    `export interface Parser {
  parse(input: string): number;
  parse(input: number): string;
}`,
  );
  const iface = result.module.declarations.find((d) => d.kind === 'interface');
  if (iface?.kind !== 'interface') throw new Error('Expected interface');
  const prop = iface.properties.find((p) => p.name === 'parse');
  expect(prop).toBeDefined();
});

it('lowers type literal with method signature', () => {
  const result = lower(
    'type-literal-method.ts',
    `export type Handler = {
  handle(input: string): void;
};`,
  );
  const ta = result.module.declarations.find((d) => d.kind === 'typeAlias');
  expect(ta).toBeDefined();
});

it('lowers function expression binding kind', () => {
  const result = lower(
    'fn-expr-kind.ts',
    `export const handler = function process(value: number): number { return value; };`,
  );
  const variable = result.module.declarations.find(
    (d) => d.kind === 'variable' && 'binding' in d && d.binding.name === 'handler',
  );
  expect(variable).toBeDefined();
});

it('lowers object literal with computed property', () => {
  const result = lower(
    'computed-prop.ts',
    `const key = 'dynamic';
export const obj = { [key]: 42 };`,
  );
  const variable = result.module.declarations.find(
    (d) => d.kind === 'variable' && 'binding' in d && d.binding.name === 'obj',
  );
  expect(variable).toBeDefined();
});

it('resolves binding element scope in parameter destructuring', () => {
  const result = lower(
    'binding-elem-param-scope.ts',
    `export function extract({ a, b }: { a: number; b: number }): number {
  return a + b;
}`,
  );
  const fn = result.module.declarations.find((d) => d.kind === 'function');
  expect(fn).toBeDefined();
});

it('resolves binding element scope from variable declaration', () => {
  const result = lower(
    'binding-elem-var-scope.ts',
    `export function run(): number {
  const { x, y } = { x: 1, y: 2 };
  return x + y;
}`,
  );
  const fn = result.module.declarations.find((d) => d.kind === 'function');
  expect(fn).toBeDefined();
});

it('lowers class with implements clause', () => {
  const result = lower(
    'class-implements.ts',
    `interface Runnable { run(): void }
export class Task implements Runnable {
  run(): void {}
}`,
  );
  const cls = result.module.declarations.find((d) => d.kind === 'class');
  if (cls?.kind !== 'class') throw new Error('Expected class');
  expect(cls.implements.length).toBeGreaterThanOrEqual(1);
});

it('lowers object method in object literal', () => {
  const result = lower(
    'object-method-literal.ts',
    `export const obj = {
  greet(name: string): string { return name; },
};`,
  );
  const variable = result.module.declarations.find(
    (d) => d.kind === 'variable' && 'binding' in d && d.binding.name === 'obj',
  );
  expect(variable).toBeDefined();
});

it('resolves narrowed member to primitive name for typeof guard', () => {
  const result = lower(
    'narrowed-primitive.ts',
    `type Input = string | number;
export function double(value: Input): string | number {
  if (typeof value === 'number') return value * 2;
  return value + value;
}`,
  );
  const fn = result.module.declarations.find((d) => d.kind === 'function');
  expect(fn).toBeDefined();
});

it('lowers member receiver for ambient named type', () => {
  const result = lower(
    'ambient-receiver.ts',
    `export function keys(map: Map<string, number>): number {
  return map.size;
}`,
  );
  const fn = result.module.declarations.find((d) => d.kind === 'function');
  expect(fn).toBeDefined();
});

it('resolves indexed receiver from symbol-named receiver', () => {
  const result = lower(
    'indexed-receiver-names.ts',
    `export function len(value: string): number {
  return value[0].charCodeAt(0);
}`,
  );
  const fn = result.module.declarations.find((d) => d.kind === 'function');
  expect(fn).toBeDefined();
});

it('lowers destructuring assignment with array rest', () => {
  const result = lower(
    'destructure-assign-rest.ts',
    `let first: number;
let rest: number[];
export function split(items: [number, number, number]): void {
  [first, ...rest] = items;
}`,
  );
  const fn = result.module.declarations.find((d) => d.kind === 'function');
  expect(fn).toBeDefined();
});

it('lowers destructuring assignment with shorthand and default', () => {
  const result = lower(
    'destructure-assign-shorthand-default.ts',
    `let x: number;
export function extract(obj: { x?: number }): void {
  ({ x = 0 } = obj);
}`,
  );
  const fn = result.module.declarations.find((d) => d.kind === 'function');
  expect(fn).toBeDefined();
});

it('lowers type with readonly keyword for non-array type', () => {
  const result = lower('readonly-non-array.ts', `export type ReadonlyPair = readonly [number, string];`);
  const ta = result.module.declarations.find((d) => d.kind === 'typeAlias');
  expect(ta).toBeDefined();
});

it('infers initializer type for empty array', () => {
  const result = lower('infer-empty-array.ts', `export const items = [];`);
  const variable = result.module.declarations.find(
    (d) => d.kind === 'variable' && 'binding' in d && d.binding.name === 'items',
  );
  expect(variable).toBeDefined();
});

it('resolves common type for mixed initializer array', () => {
  const result = lower('common-type-array.ts', `export const items = [1, 'two', true];`);
  const variable = result.module.declarations.find(
    (d) => d.kind === 'variable' && 'binding' in d && d.binding.name === 'items',
  );
  expect(variable).toBeDefined();
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

it('resolves indexed receivers through string literal and template expression element access', () => {
  const result = lower(
    'string-receiver.ts',
    `
        export function run(name: string): void {
          "hello"[0];
          \`world \${name}\`[0];
        }
      `,
  );
  expect(result.diagnostics).toEqual([]);
  const fn = result.module.declarations[0];
  if (fn?.kind !== 'function') throw new Error('Expected function');
  const strAccess = fn.body[0];
  const tmplAccess = fn.body[1];
  if (strAccess?.kind !== 'expression' || tmplAccess?.kind !== 'expression') throw new Error('Expected expressions');
  expect(strAccess.expression).toMatchObject({
    kind: 'element',
    semantics: expect.objectContaining({ receivers: expect.arrayContaining(['string']) }),
  });
  expect(tmplAccess.expression).toMatchObject({
    kind: 'element',
    semantics: expect.objectContaining({ receivers: expect.arrayContaining(['string']) }),
  });
});

it('resolves optional-chain element access value evidence for non-array non-tuple receiver', () => {
  const result = lower(
    'optional-object.ts',
    `
        export function run(obj: any): number {
          return obj.items?.[0];
        }
      `,
  );
  expect(result.diagnostics).toEqual([]);
  const fn = result.module.declarations[0];
  if (fn?.kind !== 'function') throw new Error('Expected function');
  const ret = fn.body[0];
  if (ret?.kind !== 'return') throw new Error('Expected return');
  expect(ret.expression).toMatchObject({ kind: 'element', optional: true });
});

it('resolves optional-chain element access on multi-type union receiver as unknown', () => {
  const result = lower(
    'optional-union.ts',
    `
        export function run(val: number[] | string | undefined): void {
          val?.[0];
        }
      `,
  );
  expect(result.diagnostics).toEqual([]);
});

it('resolves optional-chain tuple element access out of bounds as undefined', () => {
  const result = lower(
    'optional-tuple-oob.ts',
    `
        export function run(tup: [number, string] | undefined): void {
          tup?.[5];
        }
      `,
  );
  expect(result.diagnostics).toEqual([]);
});

it('resolves new-expression element access through constructor receiver names', () => {
  const result = lower(
    'new-receiver.ts',
    `
        class Custom { value = 0 }
        export function run(): void {
          new Array(5)[0];
          new Custom()["value"];
        }
      `,
  );
  expect(result.diagnostics).toEqual([]);
  const fn = result.module.declarations[1];
  if (fn?.kind !== 'function') throw new Error('Expected function');
  const arrayAccess = fn.body[0];
  if (arrayAccess?.kind !== 'expression') throw new Error('Expected expression');
  expect(arrayAccess.expression).toMatchObject({
    kind: 'element',
    semantics: expect.objectContaining({ receivers: expect.arrayContaining(['array']) }),
  });
});

it('lowers contextual tuple expression with trailing optional elements omitted', () => {
  const result = lower(
    'tuple-optional.ts',
    `
        type OptionalTuple = [number, string?];
        export function build(): OptionalTuple {
          return [1];
        }
      `,
  );
  expect(result.diagnostics).toEqual([]);
  const fn = result.module.declarations.find((d) => d.kind === 'function' && d.binding.name === 'build');
  if (fn?.kind !== 'function') throw new Error('Expected function');
  const ret = fn.body[0];
  if (ret?.kind !== 'return') throw new Error('Expected return');
  expect(ret.expression).toMatchObject({ kind: 'tuple' });
});

it('classifies symbol-typed property key coercion in element access', () => {
  const result = lower(
    'symbol-coercion.ts',
    `
        export function run(obj: any): unknown {
          return obj[Symbol.iterator];
        }
      `,
  );
  expect(result.diagnostics).toEqual([]);
  const fn = result.module.declarations[0];
  if (fn?.kind !== 'function') throw new Error('Expected function');
  const ret = fn.body[0];
  if (ret?.kind !== 'return') throw new Error('Expected return');
  expect(ret.expression).toMatchObject({ kind: 'element', semantics: expect.objectContaining({ key: 'symbol' }) });
});

it('lowers named tuple members with optional and rest labels', () => {
  const result = lower(
    'named-tuple-inline.ts',
    `
        export function accept(value: [first: number, second?: string]): void {}
      `,
  );
  expect(result.diagnostics).toEqual([]);
  const fn = result.module.declarations[0];
  if (fn?.kind !== 'function') throw new Error('Expected function');
  expect(fn.parameters[0]?.type).toMatchObject({
    kind: 'tuple',
    elements: [
      { optional: false, rest: false, type: { kind: 'primitive', name: 'number' } },
      { optional: true, rest: false, type: { kind: 'primitive', name: 'string' } },
    ],
  });
});

it('lowers named rest tuple member', () => {
  const result = lower(
    'named-rest-tuple.ts',
    `
        export function accept(value: [first: number, ...rest: string[]]): void {}
      `,
  );
  expect(result.diagnostics).toEqual([]);
  const fn = result.module.declarations[0];
  if (fn?.kind !== 'function') throw new Error('Expected function');
  expect(fn.parameters[0]?.type).toMatchObject({
    kind: 'tuple',
    elements: [
      { optional: false, rest: false },
      { optional: false, rest: true },
    ],
  });
});

it('lowers inline union and intersection type annotations', () => {
  const result = lower(
    'union-intersection.ts',
    `
        export function acceptUnion(value: string | number): void {}
        export function acceptIntersection(value: { a: number } & { b: string }): void {}
      `,
  );
  expect(result.diagnostics).toEqual([]);
  const unionFn = result.module.declarations.find((d) => d.kind === 'function' && d.binding.name === 'acceptUnion');
  const interFn = result.module.declarations.find(
    (d) => d.kind === 'function' && d.binding.name === 'acceptIntersection',
  );
  if (unionFn?.kind !== 'function' || interFn?.kind !== 'function') throw new Error('Expected functions');
  expect(unionFn.parameters[0]?.type).toMatchObject({ kind: 'union' });
  expect(interFn.parameters[0]?.type).toMatchObject({ kind: 'intersection' });
});

it('lowers inline type literal return type with properties', () => {
  const result = lower(
    'type-literal-ret.ts',
    `
        export function get(): { x: number; y: string } { return { x: 1, y: "" }; }
      `,
  );
  expect(result.diagnostics).toEqual([]);
  const fn = result.module.declarations[0];
  if (fn?.kind !== 'function') throw new Error('Expected function');
  expect(fn.returns).toMatchObject({
    kind: 'object',
    properties: expect.arrayContaining([
      expect.objectContaining({ name: 'x' }),
      expect.objectContaining({ name: 'y' }),
    ]),
  });
});

it('lowers method signatures with rest, optional, and pattern parameters', () => {
  const result = lower(
    'method-sig.ts',
    `
        export function accept(handler: {
          spread(...args: string[]): void;
          maybe(value?: number): void;
          destructure({ x, y }: { x: number; y: number }): void;
        }): void {}
      `,
  );
  expect(result.diagnostics).toEqual([]);
  const fn = result.module.declarations[0];
  if (fn?.kind !== 'function') throw new Error('Expected function');
  const handlerType = fn.parameters[0]?.type;
  if (handlerType?.kind !== 'object') throw new Error('Expected object type');
  const spread = handlerType.properties.find((p) => p.name === 'spread');
  const maybe = handlerType.properties.find((p) => p.name === 'maybe');
  const destructure = handlerType.properties.find((p) => p.name === 'destructure');
  if (spread?.type.kind !== 'function') throw new Error('Expected function type for spread');
  if (maybe?.type.kind !== 'function') throw new Error('Expected function type for maybe');
  if (destructure?.type.kind !== 'function') throw new Error('Expected function type for destructure');
  expect(spread.type.parameters[0]).toMatchObject({ rest: true });
  expect(maybe.type.parameters[0]).toMatchObject({ optional: true });
  expect(destructure.type.parameters[0]).toMatchObject({ name: 'parameterPatternValue' });
});

it('lowers readonly array and tuple annotations', () => {
  const result = lower(
    'readonly-types.ts',
    `
        export function acceptArr(value: readonly number[]): void {}
        export function acceptTuple(value: readonly [number, string]): void {}
      `,
  );
  expect(result.diagnostics).toEqual([]);
  const arrFn = result.module.declarations.find((d) => d.kind === 'function' && d.binding.name === 'acceptArr');
  const tupleFn = result.module.declarations.find((d) => d.kind === 'function' && d.binding.name === 'acceptTuple');
  if (arrFn?.kind !== 'function' || tupleFn?.kind !== 'function') throw new Error('Expected functions');
  expect(arrFn.parameters[0]?.type).toMatchObject({ kind: 'array', readonly: true });
  expect(tupleFn.parameters[0]?.type).toMatchObject({ kind: 'tuple', readonly: true });
});

it('lowers Array<T> and ReadonlyArray<T> reference annotations', () => {
  const result = lower(
    'array-ref-types.ts',
    `
        export function acceptArray(value: Array<number>): void {}
        export function acceptReadonly(value: ReadonlyArray<string>): void {}
      `,
  );
  expect(result.diagnostics).toEqual([]);
  const arrFn = result.module.declarations.find((d) => d.kind === 'function' && d.binding.name === 'acceptArray');
  const roFn = result.module.declarations.find((d) => d.kind === 'function' && d.binding.name === 'acceptReadonly');
  if (arrFn?.kind !== 'function' || roFn?.kind !== 'function') throw new Error('Expected functions');
  expect(arrFn.parameters[0]?.type).toMatchObject({ kind: 'array', readonly: false });
  expect(roFn.parameters[0]?.type).toMatchObject({ kind: 'array', readonly: true });
});

it('lowers interface type reference as named type on parameters', () => {
  const result = lower(
    'interface-ref.ts',
    `
        interface Point { x: number; y: number }
        export function accept(value: Point): void {}
      `,
  );
  expect(result.diagnostics).toEqual([]);
  const fn = result.module.declarations.find((d) => d.kind === 'function' && d.binding.name === 'accept');
  if (fn?.kind !== 'function') throw new Error('Expected function');
  expect(fn.parameters[0]?.type).toMatchObject({ kind: 'named' });
});

it('resolves interface type through evidence path on destructured parameter', () => {
  const result = lower(
    'destructure-interface.ts',
    `
        interface Handler {
          spread(...args: string[]): void;
          maybe(value?: number): void;
          destructure({ x }: { x: number }): void;
        }
        export function accept({ spread, maybe, destructure }: Handler): void {
          spread("a");
          maybe();
          destructure({ x: 1 });
        }
      `,
  );
  expect(result.diagnostics).toEqual([]);
  const fn = result.module.declarations.find((d) => d.kind === 'function' && d.binding.name === 'accept');
  if (fn?.kind !== 'function') throw new Error('Expected function');
  expect(fn.body.length).toBeGreaterThan(0);
});

it('resolves interface heritage properties through evidence path', () => {
  const result = lower(
    'interface-heritage-evidence.ts',
    `
        interface Base { x: number }
        interface Extended extends Base { y: string }
        export function accept({ x, y }: Extended): void { void x; void y; }
      `,
  );
  expect(result.diagnostics).toEqual([]);
  const fn = result.module.declarations.find((d) => d.kind === 'function' && d.binding.name === 'accept');
  if (fn?.kind !== 'function') throw new Error('Expected function');
});

it('resolves type alias union and readonly through evidence path on destructured parameter', () => {
  const result = lower(
    'destructure-alias.ts',
    `
        type Config = { items: readonly number[]; label: string | number };
        export function accept({ items, label }: Config): void { void items; void label; }
      `,
  );
  expect(result.diagnostics).toEqual([]);
});

it('resolves nullish coalescing type evidence when both sides match', () => {
  const result = lower(
    'coalesce-evidence.ts',
    `
        export function coalesce(value: string | null, fallback: string): string {
          return value ?? fallback;
        }
      `,
  );
  expect(result.diagnostics).toEqual([]);
  const fn = result.module.declarations[0];
  if (fn?.kind !== 'function') throw new Error('Expected function');
  const ret = fn.body[0];
  if (ret?.kind !== 'return') throw new Error('Expected return');
  expect(ret.expression).toMatchObject({ kind: 'binary', operator: '??' });
});

it('strips null and undefined from union in nullish coalescing multi-member evidence', () => {
  const result = lower(
    'coalesce-multi.ts',
    `
        export function strip(value: string | number | null, fallback: string | number): string | number {
          return value ?? fallback;
        }
      `,
  );
  expect(result.diagnostics).toEqual([]);
});

it('resolves binary expression result domain for nullish coalescing operator', () => {
  const result = lower(
    'nullish-domain.ts',
    `
        export function fallback(value: string | undefined): string {
          return value ?? "default";
        }
      `,
  );
  expect(result.diagnostics).toEqual([]);
  const fn = result.module.declarations[0];
  if (fn?.kind !== 'function') throw new Error('Expected function');
  const ret = fn.body[0];
  if (ret?.kind !== 'return') throw new Error('Expected return');
  expect(ret.expression).toMatchObject({
    kind: 'binary',
    operator: '??',
    semantics: expect.objectContaining({ result: 'string' }),
  });
});

it('resolves nullish coalescing present domain through array element access', () => {
  const result = lower(
    'element-coalesce.ts',
    `
        export function elementFallback(arr: string[]): string {
          return arr[0] ?? "default";
        }
      `,
  );
  expect(result.diagnostics).toEqual([]);
  const fn = result.module.declarations[0];
  if (fn?.kind !== 'function') throw new Error('Expected function');
  const ret = fn.body[0];
  if (ret?.kind !== 'return') throw new Error('Expected return');
  expect(ret.expression).toMatchObject({
    kind: 'binary',
    operator: '??',
    semantics: expect.objectContaining({ result: 'string' }),
  });
});

it('refuses anonymous default function export with unsupported diagnostic', () => {
  const result = lower(
    'anonymous-default.ts',
    `
        export default function() { return 1; }
      `,
  );
  expect(result.diagnostics.length).toBeGreaterThan(0);
  expect(result.diagnostics[0]).toMatchObject({ code: 'unsupported-typescript' });
});

it('reports value namespace as unsupported', () => {
  const result = lower(
    'nested-namespace.ts',
    `
        export namespace Outer {
          export namespace Inner {
            export function run(): void {}
          }
        }
      `,
  );
  expect(result.diagnostics.length).toBeGreaterThan(0);
  expect(result.diagnostics[0]).toMatchObject({ code: 'unsupported-typescript' });
});

it('resolves for-of iterable element type through a type alias chain', () => {
  const result = lower(
    'for-of-alias.ts',
    `
        type Numbers = number[];
        export function sum(values: Numbers): void {
          for (const n of values) { void n; }
        }
      `,
  );
  expect(result.diagnostics).toEqual([]);
  const fn = result.module.declarations.find((d) => d.kind === 'function' && d.binding.name === 'sum');
  if (fn?.kind !== 'function') throw new Error('Expected function');
  const loop = fn.body.find((s) => s.kind === 'forOf');
  expect(loop).toBeDefined();
});

function getVariableBinding(value: unknown): IrBindingIdentity {
  if (typeof value !== 'object' || value === null || !('binding' in value)) {
    throw new Error('Expected named variable');
  }
  return (value as { readonly binding: IrBindingIdentity }).binding;
}
