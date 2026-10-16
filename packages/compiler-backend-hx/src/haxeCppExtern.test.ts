import ts from 'typescript';

import { normalizeCompilerStructuralValueCanonical } from '../../compiler-canonical-form/src/index.js';
import { lowerTypeScriptSource } from '../../compiler-semantic/src/index.js';
import type {
  CompilerHaxeCppExternPlan,
  CompilerHaxeDualBinding,
  CompilerHaxeDualBindingPlan,
  CompilerHaxePublicBindingIdentity,
  IrDeclaration,
  IrModule,
} from '../../compiler-types/src/index.js';
import { createCompilerHaxeCppExternPlan, emitCompilerHaxeCppExternPlan } from './haxeCppExtern.js';

describe('createCompilerHaxeCppExternPlan', () => {
  it('plans the direct carrier slice and explicit String and optional adapters from published C++ locators', () => {
    const module = lowerFixture();
    const bindings = createBindings(module);
    const snapshot = structuredClone({ bindings, module });

    const first = createCompilerHaxeCppExternPlan({ bindings, modules: [module] });
    const second = createCompilerHaxeCppExternPlan({ bindings, modules: [module] });

    expect(first.schema).toBe('flight-haxe-cpp-extern-plan/1');
    expect(second).toEqual(first);
    expect({ bindings, module }).toEqual(snapshot);
    expect(isDeeplyFrozen(first, new WeakSet())).toBe(true);
    expect(first.declarations.map(({ key }) => key)).toEqual([...first.declarations.map(({ key }) => key)].sort());

    const byName = (name: string) =>
      first.declarations.find((declaration) => declaration.kind === 'function' && declaration.haxeName === name)!;
    expect(byName('clamp')).toMatchObject({
      include: 'flight/fixture/api.hpp',
      parameters: [
        { carrier: { cppType: 'double', haxeType: 'Float', kind: 'float', transport: 'direct' } },
        { carrier: { kind: 'float', transport: 'direct' } },
        { carrier: { kind: 'float', transport: 'direct' } },
      ],
      result: { kind: 'float', transport: 'direct' },
      targetNativeName: 'flight::fixture::clamp_exact',
    });
    expect(byName('inRange')).toMatchObject({ result: { kind: 'boolean', transport: 'direct' } });
    expect(byName('reset')).toMatchObject({ result: { kind: 'void', transport: 'direct' } });
    expect(byName('echo')).toMatchObject({
      adapter: { semantics: ['copy-string-utf8'] },
      parameters: [{ carrier: { cppType: 'flight::String', haxeType: 'String', kind: 'string' } }],
      result: { kind: 'string', transport: 'adapter' },
    });
    expect(byName('approx')).toMatchObject({
      adapter: { semantics: ['copy-optional-presence'] },
      parameters: [
        { carrier: { kind: 'float' } },
        { carrier: { kind: 'float' } },
        { carrier: { cppType: 'std::optional<double>', kind: 'optional-float' }, optional: true },
      ],
    });
    expect(byName('identityStatus')).toMatchObject({
      parameters: [{ carrier: { kind: 'value-record', transport: 'direct' } }],
      result: { kind: 'value-record', transport: 'direct' },
    });
    expect(byName('identityEntity')).toMatchObject({
      parameters: [{ carrier: { kind: 'reference-record', transport: 'direct' } }],
      result: { kind: 'reference-record', transport: 'direct' },
    });

    expect(first.declarations).toContainEqual(
      expect.objectContaining({
        haxeName: 'Status',
        kind: 'type',
        nativeName: 'flight::fixture::Status',
        ownership: 'value',
      }),
    );
    expect(first.declarations).toContainEqual(
      expect.objectContaining({
        haxeName: 'EntityRecord',
        kind: 'type',
        nativeName: 'flight::Ref<flight::fixture::EntityRecord>',
        ownership: 'reference',
      }),
    );
    expect(first.refusals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'cpp-binding-unavailable', detailCode: 'cpp-module-refused' }),
        expect.objectContaining({ code: 'unsupported-carrier', key: 'value:unsupported' }),
        expect.objectContaining({ code: 'unsupported-declaration', key: 'value:Status' }),
      ]),
    );
  });

  it('refuses missing declarations, malformed locators, generic records, callbacks, rows, arrays, and unions', () => {
    const module = lowerFixture();
    const bindings = createBindings(module);
    const missing = createBinding(module, 'clamp', 'value', {
      key: 'value:missing',
      declarationIdentity: '{"missing":true}',
      spelling: 'missing',
    });
    const malformed = createBinding(module, 'clamp', 'value', {
      include: 'bad\nheader.hpp',
      key: 'value:malformed',
      spelling: 'bad-name',
    });
    const result = createCompilerHaxeCppExternPlan({
      bindings: { ...bindings, bindings: [...bindings.bindings, missing, malformed] },
      modules: [module],
    });

    expect(result.refusals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'declaration-missing', key: 'value:missing' }),
        expect.objectContaining({ code: 'invalid-locator', key: 'value:malformed' }),
        expect.objectContaining({ code: 'unsupported-carrier', key: 'type:GenericRecord' }),
        expect.objectContaining({ code: 'unsupported-carrier', key: 'value:unsupported' }),
        expect.objectContaining({ code: 'unsupported-carrier', key: 'value:callback' }),
        expect.objectContaining({ code: 'unsupported-carrier', key: 'value:row' }),
        expect.objectContaining({ code: 'unsupported-carrier', key: 'value:union' }),
      ]),
    );
  });
});

describe('emitCompilerHaxeCppExternPlan', () => {
  it('emits hidden externs with exact native names and explicit conversion headers without unsafe fallbacks', () => {
    const module = lowerFixture();
    const plan = createCompilerHaxeCppExternPlan({ bindings: createBindings(module), modules: [module] });
    const emission = emitCompilerHaxeCppExternPlan(plan);
    const holder = getFile(emission.files, 'flight/_cpp/_fn/Fixture.hx').contents;
    const status = getFile(emission.files, 'flight/_cpp/Status.hx').contents;
    const entity = getFile(emission.files, 'flight/_cpp/EntityRecord.hx').contents;
    const adapters = emission.files
      .filter(({ path }) => path.endsWith('.hpp'))
      .map(({ contents }) => contents)
      .join('\n');
    const all = emission.files.map(({ contents }) => contents).join('\n');

    expect(emission.schema).toBe('flight-haxe-cpp-extern-emission/1');
    expect(isDeeplyFrozen(emission, new WeakSet())).toBe(true);
    expect(holder).toContain('@:native("flight::fixture::clamp_exact")');
    expect(holder).toContain('public static function clamp(value:Float, min:Float, max:Float):Float;');
    expect(holder).toContain('public static function approx(a:Float, b:Float, ?epsilon:Float):Bool;');
    expect(holder).toContain('public static function echo(value:String):String;');
    expect(status).toContain('@:native("flight::fixture::Status")');
    expect(status).toContain('The carrier is copied by value');
    expect(entity).toContain('@:native("flight::Ref<flight::fixture::EntityRecord>")');
    expect(entity).toContain('copying this value retains shared ownership');
    expect(adapters).toContain('flight::String::from_utf8(argument_0.utf8_str())');
    expect(adapters).toContain('return ::String(haxe_result_utf8.data(), haxe_result_utf8.size());');
    expect(adapters).toContain('argument_2.hasValue ? std::optional<double>{argument_2.value}');
    expect(adapters).toContain('flight::fixture::echo_exact(flight_argument_0)');
    expect(all).not.toMatch(/\bDynamic\b|\bcast\b|reinterpret/u);
    expect(emission.files.map(({ path }) => path)).toEqual([...emission.files.map(({ path }) => path)].sort());
  });

  it('returns structured emission refusals for invalid plans and output collisions', () => {
    const invalid = emitCompilerHaxeCppExternPlan({ schema: 'wrong' } as unknown as CompilerHaxeCppExternPlan);
    expect(invalid).toMatchObject({
      files: [],
      refusals: [{ code: 'invalid-plan', phase: 'emission' }],
    });

    const module = lowerFixture();
    const plan = createCompilerHaxeCppExternPlan({ bindings: createBindings(module), modules: [module] });
    const type = plan.declarations.find((declaration) => declaration.kind === 'type')!;
    const collided = emitCompilerHaxeCppExternPlan({
      ...plan,
      declarations: [...plan.declarations, { ...type, key: `${type.key}:duplicate` }],
    });
    expect(collided.refusals).toContainEqual(
      expect.objectContaining({ code: 'output-path-collision', phase: 'emission' }),
    );
    expect(collided.files.some(({ path }) => path.endsWith(`/${type.haxeName}.hx`))).toBe(false);
  });
});

function createBindings(module: Readonly<IrModule>): CompilerHaxeDualBindingPlan {
  const specs = [
    ['Status', 'type'],
    ['Status', 'value'],
    ['EntityRecord', 'type'],
    ['GenericRecord', 'type'],
    ['clamp', 'value'],
    ['inRange', 'value'],
    ['reset', 'value'],
    ['echo', 'value'],
    ['approx', 'value'],
    ['identityStatus', 'value'],
    ['identityEntity', 'value'],
    ['unsupported', 'value'],
    ['callback', 'value'],
    ['row', 'value'],
    ['union', 'value'],
    ['blocked', 'value'],
  ] as const;
  return {
    bindings: specs.map(([name, space]) =>
      createBinding(module, name, space, {
        ...(name === 'blocked' ? { refused: true } : {}),
        spelling: space === 'type' ? name : `${name === 'clamp' ? 'clamp_exact' : `${name}_exact`}`,
      }),
    ),
    schema: 'flight-haxe-dual-binding-plan/1',
  };
}

function createBinding(
  module: Readonly<IrModule>,
  name: string,
  space: 'type' | 'value',
  options: Readonly<{
    declarationIdentity?: string;
    include?: string;
    key?: string;
    refused?: boolean;
    spelling?: string;
  }> = {},
): CompilerHaxeDualBinding {
  const declaration = getDeclaration(module, name);
  const key = options.key ?? `${space}:${name}`;
  const cpp = options.refused
    ? {
        availability: 'refused' as const,
        refusal: {
          code: 'cpp-module-refused' as const,
          detailCode: 'fixture-blocked',
          message: 'fixture C++ module is refused',
          subject: key,
        },
      }
    : {
        availability: 'available' as const,
        locator: {
          carrier: getCarrier(declaration),
          include: options.include ?? 'flight/fixture/api.hpp',
          namespace: 'flight::fixture',
          spelling: options.spelling ?? name,
        },
      };
  const kind = space === 'type' ? 'type' : declaration.kind === 'enum' ? 'type-value' : 'function';
  const publicHaxe: CompilerHaxePublicBindingIdentity =
    kind === 'function'
      ? {
          kind,
          name,
          owner: 'flight.Fixture',
          qualifiedName: `flight.Fixture.${name}`,
          signature: `function ${name}():Dynamic;`,
          typeIdentity: 'Dynamic',
        }
      : {
          kind,
          name,
          owner: 'flight',
          qualifiedName: `flight.${name}`,
          typeIdentity: `flight.${name}`,
        };
  return {
    cpp,
    identity: {
      declarationIdentity:
        options.declarationIdentity ?? normalizeCompilerStructuralValueCanonical(getDeclarationBinding(declaration)),
      exportRoute: key,
      packageName: '@fixture/api',
      source: module.source,
      space,
    },
    javascript: {
      availability: 'available',
      locator: { exportedName: name, specifier: '@fixture/api' },
    },
    key,
    publicHaxe,
  };
}

function getCarrier(declaration: Readonly<IrDeclaration>) {
  if (declaration.kind === 'typeAlias') return 'type-alias' as const;
  if (declaration.kind === 'variable') return 'value' as const;
  return declaration.kind;
}

function getDeclaration(module: Readonly<IrModule>, name: string): Readonly<IrDeclaration> {
  const declaration = module.declarations.find(
    (candidate) => 'binding' in candidate && candidate.binding.name === name,
  );
  if (!declaration) throw new Error(`Missing fixture declaration ${name}`);
  return declaration;
}

function getDeclarationBinding(declaration: Readonly<IrDeclaration>) {
  if (!('binding' in declaration)) throw new Error('Fixture declaration must have one binding');
  return declaration.binding;
}

function lowerFixture(): IrModule {
  const source = `
    export enum Status { ready = 1 }
    export interface EntityRecord { active: boolean; value: number }
    export interface GenericRecord<T> { value: T }
    export function clamp(value: number, min: number, max: number): number { return value; }
    export function inRange(value: number, min: number, max: number): boolean { return true; }
    export function reset(): void {}
    export function echo(value: string): string { return value; }
    export function approx(a: number, b: number, epsilon?: number): boolean { return true; }
    export function identityStatus(value: Status): Status { return value; }
    export function identityEntity(value: EntityRecord): EntityRecord { return value; }
    export function unsupported(values: number[]): number { return values.length; }
    export function callback(value: () => number): number { return value(); }
    export function row(value: { amount: number }): number { return value.amount; }
    export function union(value: number | string): number { return 1; }
    export function blocked(value: number): number { return value; }
  `;
  const sourceFile = ts.createSourceFile('api.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const result = lowerTypeScriptSource(sourceFile, { packageName: '@fixture/api', upstreamDirectory: '.' });
  if (result.diagnostics.length > 0) throw new Error(result.diagnostics.map(({ message }) => message).join('\n'));
  return result.module;
}

function getFile(files: readonly Readonly<{ contents: string; path: string }>[], path: string) {
  const file = files.find((candidate) => candidate.path === path);
  if (!file) throw new Error(`Missing emitted file ${path}`);
  return file;
}

function isDeeplyFrozen(value: unknown, seen: WeakSet<object>): boolean {
  if (!value || typeof value !== 'object' || seen.has(value)) return true;
  seen.add(value);
  return Object.isFrozen(value) && Object.values(value).every((child) => isDeeplyFrozen(child, seen));
}
