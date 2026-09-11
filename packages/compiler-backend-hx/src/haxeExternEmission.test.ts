import ts from 'typescript';

import { lowerTypeScriptSource } from '../../compiler-semantic/src/index.js';
import type { CompilerModuleResolutionPlan, EmittedFile } from '../../compiler-types/src/index.js';
import { createHaxeCompilerBackend, emitIrModuleHaxe } from './haxeCompilerBackend.js';
import { emitIrModuleHaxeExtern, emitIrModuleHaxeExternWithContext } from './haxeExternEmission.js';

describe('emitIrModuleHaxeExtern', () => {
  it('emits exported interfaces as structural typedefs and values on the package contract holder', () => {
    const module = lower(
      '@flighthq/geometry',
      'vector.ts',
      `
        export interface Vector2 { x: number; readonly y: number; label?: string }
        export function createVector2(x?: number, y?: number): Vector2 { return { x: x ?? 0, y: y ?? 0 }; }
        export const ORIGIN: Vector2 = { x: 0, y: 0 };
      `,
    );
    const snapshot = structuredClone(module);

    const files = emitIrModuleHaxeExtern(module, { rootPackage: 'flight' });
    const typedef = findFile(files, 'flight/_js/Vector2.hx');
    const holder = findFile(files, 'flight/_js/_fn/Geometry.hx');

    expect(typedef.contents).toContain('package flight._js;');
    expect(typedef.contents).toContain('typedef Vector2 = {');
    expect(typedef.contents).toContain('var x:Float;');
    expect(typedef.contents).toContain('var y:Float;');
    expect(typedef.contents).toContain('@:optional var label:String;');
    expect(typedef.contents).not.toContain('@:jsImport');
    expect(holder.contents).toContain('@:jsImport("@flighthq/geometry/contract")');
    expect(holder.contents).not.toContain('@:jsRequire');
    expect(holder.contents).toContain('extern class Geometry {');
    expect(holder.contents).toContain('static function createVector2(?x:Float, ?y:Float):flight.Vector2;');
    expect(holder.contents).toContain('static var ORIGIN:flight.Vector2;');
    expect(holder.contents).not.toContain('return {');
    expect(module).toEqual(snapshot);
  });

  it('groups values from every package module into one deterministically ordered holder', () => {
    const distance = lower(
      '@flighthq/geometry',
      'distance.ts',
      'export function distanceBetween(left: number, right: number): number { return right - left; }',
    );
    const vector = lower(
      '@flighthq/geometry',
      'vector.ts',
      'export function createVector2(x: number): number { return x; }',
    );
    const backend = createHaxeCompilerBackend();
    const session = backend.createEmissionSession!({
      modules: [vector, distance],
      options: { emissionMode: 'extern', rootPackage: 'flight' },
    });

    const files = [distance, vector].flatMap((module) => session.emitModule(module));
    const holders = files.filter((file) => file.path === 'flight/_js/_fn/Geometry.hx');

    expect(holders).toHaveLength(1);
    expect(holders[0]!.contents).toContain('static function createVector2(x:Float):Float;');
    expect(holders[0]!.contents).toContain('static function distanceBetween(left:Float, right:Float):Float;');
    expect(holders[0]!.contents.indexOf('createVector2')).toBeLessThan(holders[0]!.contents.indexOf('distanceBetween'));
  });

  it('inlines local and imported generic aliases at holder use sites without alias files', () => {
    const aliases = lower(
      '@flighthq/geometry',
      'aliases.ts',
      'export type Result<Value> = { value: Value; ok: boolean };',
    );
    const factory = lower(
      '@flighthq/geometry',
      'factory.ts',
      `
        import type { Result as Outcome } from './aliases.js';
        type Optional<Value> = Value | null;
        export function create(): Outcome<Optional<number>> { return { value: 1, ok: true }; }
      `,
    );
    const backend = createHaxeCompilerBackend();
    const session = backend.createEmissionSession!({
      modules: [factory, aliases],
      options: { emissionMode: 'extern', rootPackage: 'flight' },
    });

    const files = [aliases, factory].flatMap((module) => session.emitModule(module));
    const holder = findFile(files, 'flight/_js/_fn/Geometry.hx');

    expect(holder.contents).toContain('static function create():{ value:Null<Float>, ok:Bool };');
    expect(files.every((file) => !file.path.endsWith('/Result.hx') && !file.path.endsWith('/Optional.hx'))).toBe(true);
  });

  it('flattens generic interface inheritance before structural typedef emission', () => {
    const module = lower(
      '@flighthq/types',
      'model.ts',
      `
        interface Base<Value> { value: Value }
        export interface Model extends Base<number> { label: string }
      `,
    );

    const typedef = findFile(emitIrModuleHaxeExtern(module, { rootPackage: 'flight' }), 'flight/_js/Model.hx');

    expect(typedef.contents).toContain('var value:Float;');
    expect(typedef.contents).toContain('var label:String;');
    expect(typedef.contents).not.toContain('extends');
  });

  it('widens a Pick of a bound ambient host interface to its native Haxe extern', () => {
    const module = lower(
      '@flighthq/types',
      'context.ts',
      "type ContextMember = 'clear'; export interface Context extends Pick<WebGL2RenderingContext, ContextMember> {}",
    );

    const typedef = findFile(emitIrModuleHaxeExtern(module, { rootPackage: 'flight' }), 'flight/_js/Context.hx');

    expect(typedef.contents).toContain('typedef Context = js.html.webgl.WebGL2RenderingContext;');
  });

  it('emits callable interface members, generic constraints, and runtime types', () => {
    const module = lower(
      '@flighthq/types',
      'hooks.ts',
      "export interface Hooks<Value extends string, Result> { '#secret': number; pending: Promise<Value>; run?(...values: number[]): Result; transform?(value?: number): Value; validate(value: number): Value }",
    );

    const typedef = findFile(emitIrModuleHaxeExtern(module, { rootPackage: 'flight' }), 'flight/_js/Hooks.hx');

    expect(typedef.contents).toContain('typedef Hooks<Value:String, Result> = {');
    expect(typedef.contents).toContain('var secret:Float;');
    expect(typedef.contents).toContain('var pending:flighthq._internal._Promise<Value>;');
    expect(typedef.contents).toContain('@:optional function run(...values:Float):Result;');
    expect(typedef.contents).toContain('@:optional function transform(?value:Float):Value;');
    expect(typedef.contents).toContain('function validate(value:Float):Value;');
  });

  it('emits generic package functions, rest parameters, and untyped variables', () => {
    const module = lower(
      '@flighthq/types',
      'values.ts',
      'export let current; export function first<Value extends string>(...values: Value[]): Value { return values[0]!; }',
    );

    const holder = findFile(emitIrModuleHaxeExtern(module), 'flighthq/_js/_fn/Types.hx');

    expect(holder.contents).toContain('static var current:Dynamic;');
    expect(holder.contents).toContain('static function first<Value:String>(...values:Value):Value;');
  });

  it('keeps the single-file public emitter transpile-only and defaults the backend to transpilation', () => {
    const module = lower('@flighthq/geometry', 'value.ts', 'export function value(): number { return 1; }');
    const implicit = emitIrModuleHaxe(module);
    const explicit = emitIrModuleHaxe(module, { emissionMode: 'transpile' });
    const backend = createHaxeCompilerBackend();

    expect(implicit).toEqual(explicit);
    expect(implicit.contents).toContain('return 1;');
    expect(() => emitIrModuleHaxe(module, { emissionMode: 'extern' })).toThrow(
      'emitIrModuleHaxe is the single-file transpile API',
    );
    expect(
      backend.emitModule(module, { modules: [module], options: { emissionMode: 'extern' } })[0]?.contents,
    ).not.toContain('return 1;');
  });

  it.each([
    ['class', 'export class Model {}', 'source class Model extern representation is not yet specified by flight-hx'],
    [
      'enum',
      "export enum Mode { Ready = 'ready' }",
      'source enum Mode extern representation is not yet specified by flight-hx',
    ],
  ])('refuses exported source %s declarations', (_kind, source, message) => {
    const module = lower('@flighthq/types', 'unsupported.ts', source);

    expect(() => emitIrModuleHaxeExtern(module)).toThrow(message);
  });

  it('preserves keyword export identity with native metadata on the package holder', () => {
    const module = lower(
      '@flighthq/types',
      'factory.ts',
      'function original(value = 1): number { return value; } export { original as default };',
    );

    const holder = findFile(emitIrModuleHaxeExtern(module), 'flighthq/_js/_fn/Types.hx');

    expect(holder.contents).toContain('@:native("default")');
    expect(holder.contents).toContain('static function default_(?value:Float):Float;');
  });

  it('fails loudly when distinct exports collide after Haxe member escaping', () => {
    const module = lower(
      '@flighthq/types',
      'collision.ts',
      'function original(): void {} export { original as default }; export function default_(): void {}',
    );

    expect(() => emitIrModuleHaxeExtern(module)).toThrow(
      'package exports default and default_ share Haxe holder member default_',
    );
  });

  it('fails loudly when function parameters collide after Haxe keyword escaping', () => {
    const module = structuredClone(
      lower(
        '@flighthq/types',
        'parameter-collision.ts',
        'export function read(first: number, second: number): number { return first + second; }',
      ),
    );
    const declaration = module.declarations[0];
    if (declaration?.kind !== 'function') throw new TypeError('expected function declaration');
    (declaration.parameters[0]!.binding as { name: string }).name = 'default_';
    (declaration.parameters[1]!.binding as { name: string }).name = 'default';

    expect(() => emitIrModuleHaxeExtern(module)).toThrow('function parameters share Haxe name default_');
  });

  it('ignores local destructuring while collecting public package values', () => {
    const module = lower(
      '@flighthq/types',
      'local-pattern.ts',
      'const { hidden } = { hidden: 1 }; export function value(): number { return hidden; }',
    );

    const holder = findFile(emitIrModuleHaxeExtern(module), 'flighthq/_js/_fn/Types.hx');
    expect(holder.contents).toContain('static function value():Float;');
  });

  it.each([
    ['default expression', 'export default 1;', 'default expression exports have no flight-hx extern representation'],
    [
      'binding pattern',
      'const source = { value: 1 }; export const { value } = source;',
      'exported binding patterns require declaration splitting before extern emission',
    ],
    ['external type', 'export interface Public { value: Missing }', 'external type Missing has no Haxe binding'],
    [
      'private interface',
      'interface Private { value: number } export function read(value: Private): number { return value.value; }',
      'non-exported interface Private cannot appear in a public flight-hx extern shape',
    ],
    [
      'source class type',
      'class Model {} export function read(value: Model): void {}',
      'source class Model extern representation is not yet specified by flight-hx',
    ],
  ])('refuses unsupported public %s shapes', (_kind, source, message) => {
    const module = lower('@flighthq/types', 'unsupported-shape.ts', source);

    expect(() => emitIrModuleHaxeExtern(module)).toThrow(message);
  });

  it.each([
    [
      'cyclic aliases',
      'type First = Second; type Second = First; export function read(): First { throw new Error(); }',
      'type alias First is cyclic',
    ],
    [
      'missing type arguments',
      'type Box<Value> = { value: Value }; export function read(): Box { throw new Error(); }',
      'type alias Box cannot be inlined',
    ],
  ])('refuses %s while inlining public aliases', (_kind, source, message) => {
    const module = lower('@flighthq/types', 'invalid-alias.ts', source);

    expect(() => emitIrModuleHaxeExtern(module)).toThrow(message);
  });
});

describe('emitIrModuleHaxeExternWithContext', () => {
  it('places the source package contract specifier in custom ESM import metadata', () => {
    const module = lower('@flighthq/geometry', 'value.ts', 'export function value(): number { return 1; }');

    const holder = findFile(
      emitIrModuleHaxeExternWithContext(module, [module], undefined, { rootPackage: 'flight' }),
      'flight/_js/_fn/Geometry.hx',
    );

    expect(holder.contents).toContain('@:jsImport("@flighthq/geometry/contract")');
    expect(holder.contents).not.toContain('@:jsRequire');
  });

  it('resolves imported interfaces through importer-specific package edges', () => {
    const types = lower('@flighthq/types', 'model.ts', 'export interface Model { value: number }');
    const consumer = lower(
      '@flighthq/consumer',
      'consumer.ts',
      "import type { Flag } from '@flighthq/unused'; import type { Model as ExternalModel } from '@flighthq/types'; export function accept(model: ExternalModel): void {}",
    );
    const resolution: CompilerModuleResolutionPlan = {
      edges: [
        {
          importer: { name: consumer.name, packageName: consumer.packageName, source: consumer.source },
          specifier: '@flighthq/types',
          target: { packageName: types.packageName, source: types.source },
        },
      ],
      schema: 'flight-compiler-module-resolution/1',
    };

    const holder = findFile(
      emitIrModuleHaxeExternWithContext(consumer, [consumer, types], resolution, { rootPackage: 'flight' }),
      'flight/_js/_fn/Consumer.hx',
    );

    expect(holder.contents).toContain('static function accept(model:flight.Model):Void;');
  });

  it('follows named and star reexports while inlining imported aliases', () => {
    const aliases = lower(
      '@flighthq/types',
      'aliases.ts',
      "export type Result<Value> = { value: Value }; export type Flag = boolean; export * from './barrel.js';",
    );
    const barrel = lower(
      '@flighthq/types',
      'barrel.ts',
      "export type { Result as Outcome } from './aliases.js'; export * from './aliases.js';",
    );
    const consumer = lower(
      '@flighthq/types',
      'consumer.ts',
      "import type { Flag, Outcome } from './barrel.js'; export function read(): Outcome<Flag> { throw new Error(); }",
    );

    const holder = findFile(
      emitIrModuleHaxeExternWithContext(aliases, [consumer, barrel, aliases], undefined, { rootPackage: 'flight' }),
      'flight/_js/_fn/Types.hx',
    );

    expect(holder.contents).toContain('static function read():{ value:Bool };');
  });

  it('resolves parent-relative extensionless alias imports', () => {
    const aliases = lower('@flighthq/types', 'aliases.ts', 'export type Result = { value: number };');
    const consumer = lower(
      '@flighthq/types',
      'nested/consumer.ts',
      "import type { Result } from '../aliases'; export function read(): Result { throw new Error(); }",
    );

    const holder = findFile(
      emitIrModuleHaxeExternWithContext(aliases, [consumer, aliases], undefined, { rootPackage: 'flight' }),
      'flight/_js/_fn/Types.hx',
    );

    expect(holder.contents).toContain('static function read():{ value:Float };');
  });

  it('refuses qualified namespace aliases because the extern ABI has no qualified alias spelling', () => {
    const aliases = lower('@flighthq/types', 'aliases.ts', 'export type Result = { value: number };');
    const consumer = lower(
      '@flighthq/types',
      'consumer.ts',
      "import type * as Types from './aliases.js'; export function read(): Types.Result { throw new Error(); }",
    );

    expect(() =>
      emitIrModuleHaxeExternWithContext(aliases, [consumer, aliases], undefined, { rootPackage: 'flight' }),
    ).toThrow('qualified type alias references cannot be inlined into Haxe externs');
  });

  it('refuses imported aliases with ambiguous package-wide resolution', () => {
    const first = lower('@flighthq/first', 'alias.ts', 'export type Result = { first: number };');
    const second = lower('@flighthq/second', 'alias.ts', 'export type Result = { second: number };');
    const consumer = lower(
      '@flighthq/consumer',
      'consumer.ts',
      "import type { Result } from '@flighthq/ambiguous'; export function read(): Result { throw new Error(); }",
    );
    const resolution: CompilerModuleResolutionPlan = {
      edges: [first, second].map((module) => ({
        specifier: '@flighthq/ambiguous',
        target: { packageName: module.packageName, source: module.source },
      })),
      schema: 'flight-compiler-module-resolution/1',
    };

    expect(() =>
      emitIrModuleHaxeExternWithContext(consumer, [consumer, first, second], resolution, { rootPackage: 'flight' }),
    ).toThrow('imported type alias Result resolves ambiguously');
  });

  it('falls back to namespace binding spelling when no exported alias is present', () => {
    const types = lower('@flighthq/types', 'types.ts', 'export interface Model { value: number }');
    const consumer = lower(
      '@flighthq/consumer',
      'consumer.ts',
      "import type * as Types from '@flighthq/types'; export function read(value: Types.Missing): void {}",
    );
    const resolution: CompilerModuleResolutionPlan = {
      edges: [
        {
          specifier: '@flighthq/types',
          target: { packageName: types.packageName, source: types.source },
        },
      ],
      schema: 'flight-compiler-module-resolution/1',
    };

    const holder = findFile(
      emitIrModuleHaxeExternWithContext(consumer, [consumer, types], resolution, { rootPackage: 'flight' }),
      'flight/_js/_fn/Consumer.hx',
    );

    expect(holder.contents).toContain('static function read(value:flight.Types.Missing):Void;');
  });

  it('uses declaration identity to deterministically reject duplicate exports from duplicate source records', () => {
    const first = lower('@flighthq/types', 'duplicate.ts', 'export function value(): number { return 1; }');
    const second = {
      ...lower('@flighthq/types', 'duplicate.ts', 'export function value(): number { return 2; }'),
      name: `${first.name}Alternate`,
    };

    expect(() =>
      emitIrModuleHaxeExternWithContext(first, [second, first], undefined, { rootPackage: 'flight' }),
    ).toThrow('package exports value and value share Haxe holder member value');
  });

  it('uses declaration export flags when an explicit facade record is absent', () => {
    const lowered = lower('@flighthq/types', 'direct.ts', 'export function value(): number { return 1; }');
    const module = { ...lowered, exports: [] };

    const holder = findFile(
      emitIrModuleHaxeExternWithContext(module, [module], undefined, { rootPackage: 'flight' }),
      'flight/_js/_fn/Types.hx',
    );

    expect(holder.contents).toContain('static function value():Float;');
  });
});

function findFile(files: readonly EmittedFile[], path: string): EmittedFile {
  const file = files.find((candidate) => candidate.path === path);
  if (!file) throw new Error(`Missing emitted file ${path}`);
  return file;
}

function lower(packageName: string, file: string, source: string) {
  const packageDirectory = packageName.slice(packageName.lastIndexOf('/') + 1);
  const sourceFile = ts.createSourceFile(
    `/flight/packages/${packageDirectory}/src/${file}`,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  return lowerTypeScriptSource(sourceFile, {
    packageName,
    upstreamDirectory: '/flight',
  }).module;
}
