import ts from 'typescript';

import { lowerTypeScriptSource } from '../../compiler-semantic/src/index.js';
import type { EmittedFile } from '../../compiler-types/src/index.js';
import { createHaxeCompilerBackend, emitIrModuleHaxe } from './haxeCompilerBackend.js';
import { emitIrModuleHaxeExtern } from './haxeExternEmission.js';

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
