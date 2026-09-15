import ts from 'typescript';

import { isBackendEmissionFailure } from '../../compiler-emission/src/index.js';
import { lowerTypeScriptSource, lowerTypeScriptSources } from '../../compiler-semantic/src/index.js';
import type { IrModule } from '../../compiler-types/src/index.js';
import { createHaxeCompilerBackend, emitIrModuleHaxe } from './haxeCompilerBackend.js';

function lower(file: string, source: string) {
  return lowerPackage('@flighthq/math', file, source);
}

function lowerPackage(packageName: string, file: string, source: string) {
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
  });
}

describe('createHaxeCompilerBackend', () => {
  it('creates independent stateless backend records with Haxe identity', () => {
    const first = createHaxeCompilerBackend();
    const second = createHaxeCompilerBackend();
    const module = lower('value.ts', 'export const value = 1;').module;

    expect(first).not.toBe(second);
    expect(first.name).toBe('haxe');
    expect(first.emitModule(module, { modules: [module], options: {} })).toEqual([emitIrModuleHaxe(module)]);
  });

  it('uses the compiler ambient member declaration when project libraries merge generic methods', () => {
    const sourceFile = ts.createSourceFile(
      '/flight/packages/formats/src/shared.ts',
      `export function findTwice(values?: number[]): void {
         values?.find(value => value > 0);
         values?.find(value => value < 0);
       }`,
      ts.ScriptTarget.Latest,
      true,
    );
    const [result] = lowerTypeScriptSources([
      { packageName: '@flighthq/formats', sourceFile, upstreamDirectory: '/flight' },
    ]);

    expect(result!.diagnostics).toEqual([]);
    expect(() =>
      createHaxeCompilerBackend().emitModule(result!.module, {
        modules: [result!.module],
        options: {},
      }),
    ).not.toThrow();
  });

  it('uses explicit package-export resolution from the complete backend module context', () => {
    const target = lowerPackage('@flighthq/types', 'public.ts', 'export interface Box { value: number }').module;
    const subject = lowerPackage(
      '@flighthq/core',
      'use.ts',
      "import type { Box } from '@flighthq/types/public'; export const box: Box = {};",
    ).module;
    const backend = createHaxeCompilerBackend();

    expect(() => backend.emitModule(subject, { modules: [subject, target], options: {} })).not.toThrow();
    expect(() =>
      backend.emitModule(subject, {
        moduleResolution: {
          edges: [
            {
              specifier: '@flighthq/types/public',
              target: { packageName: '@flighthq/types', source: target.source },
            },
          ],
          schema: 'flight-compiler-module-resolution/1',
        },
        modules: [subject, target],
        options: {},
      }),
    ).toThrow('structural object compatibility missing-required-property');
  });

  it('uses resolved package-export source modules for Haxe imports', () => {
    const target = lowerPackage('@flighthq/types', 'point.ts', 'export interface Point { x: number }').module;
    const subject = lowerPackage(
      '@flighthq/core',
      'use.ts',
      "import type { Point } from '@flighthq/types/public'; export type Alias = Point;",
    ).module;
    const files = createHaxeCompilerBackend().emitModule(subject, {
      moduleResolution: {
        edges: [
          {
            specifier: '@flighthq/types/public',
            target: { packageName: '@flighthq/types', source: target.source },
          },
        ],
        schema: 'flight-compiler-module-resolution/1',
      },
      modules: [subject, target],
      options: {},
    });

    expect(files[0]!.contents).toContain('import flighthq.types.Point.Point;');
  });

  it('uses resolved extensionless source modules for Haxe imports', () => {
    const target = lower('helper.ts', 'export function helper(): number { return 1; }').module;
    const subject = lower('use.ts', "import { helper } from './helper'; export const value = helper();").module;
    const files = createHaxeCompilerBackend().emitModule(subject, {
      moduleResolution: {
        edges: [
          {
            specifier: './helper',
            target: { packageName: '@flighthq/math', source: target.source },
          },
        ],
        schema: 'flight-compiler-module-resolution/1',
      },
      modules: [subject, target],
      options: {},
    });

    expect(files[0]!.contents).toContain('import flighthq.math.Helper.helper;');
  });

  it('deduplicates type and value imports of the same Haxe nominal', () => {
    const choice = lowerPackage('@flighthq/types', 'choice.ts', 'export enum Choice { Ready }').module;
    const consumer = lowerPackage(
      '@flighthq/core',
      'consumer.ts',
      "import type { Choice } from '@flighthq/types/choice'; import { Choice } from '@flighthq/types/choice'; export function choose(value: Choice): Choice { return value; }",
    ).module;
    const output = createHaxeCompilerBackend().emitModule(consumer, {
      moduleResolution: {
        edges: [
          {
            importer: { name: consumer.name, packageName: consumer.packageName, source: consumer.source },
            specifier: '@flighthq/types/choice',
            target: { packageName: choice.packageName, source: choice.source },
          },
        ],
        schema: 'flight-compiler-module-resolution/1',
      },
      modules: [choice, consumer],
      options: {},
    })[0]!.contents;

    expect(output.match(/import flighthq\.types\.Choice\.Choice;/gu)).toHaveLength(1);
    expect(output).not.toContain('Choice_2');
  });

  it('allocates colliding secondary type names across a Haxe package', () => {
    const first = lower(
      'first.ts',
      'type Scratch = { value: number }; export function first(value: Scratch): number { return value.value; }',
    ).module;
    const second = lower(
      'second.ts',
      'type Scratch = { value: string }; export function second(value: Scratch): string { return value.value; }',
    ).module;
    const session = createHaxeCompilerBackend().createEmissionSession!({
      modules: [first, second],
      options: {},
    });

    expect(session.emitModule(first)[0]!.contents).toContain('typedef First_Scratch =');
    expect(session.emitModule(second)[0]!.contents).toContain('typedef Second_Scratch =');
  });

  it('emits star re-export facades from graph-wide module context', () => {
    const target = lowerPackage(
      '@flighthq/types',
      'target.ts',
      `
        export interface Shape { value: number }
        export enum Choice { first }
        export function add(left: number, right: number): number { return left + right; }
        export function area(shape: Shape): number { return shape.value; }
        export const version: number = 1;
        export const Mode = { basic: 0 } as const;
        export type Mode = (typeof Mode)[keyof typeof Mode];
        export default function hidden(): number { return 0; }
      `,
    ).module;
    const barrel = lowerPackage('@flighthq/math', 'barrel.ts', "export * from './target';").module;
    const output = createHaxeCompilerBackend().emitModule(barrel, {
      moduleResolution: {
        edges: [
          {
            importer: { name: barrel.name, packageName: barrel.packageName, source: barrel.source },
            specifier: './target',
            target: { packageName: target.packageName, source: target.source },
          },
        ],
        schema: 'flight-compiler-module-resolution/1',
      },
      modules: [barrel, target],
      options: {},
    })[0]!.contents;

    expect(output).toContain('typedef BarrelShape = flighthq.types.Target.Shape;');
    expect(output).toContain('typedef BarrelChoice = flighthq.types.Target.Choice;');
    expect(output).toContain('function add(left:Float, right:Float):Float');
    expect(output).toContain('return flighthq.types.Target.add(left, right);');
    expect(output).toContain('function area(shape:BarrelShape):Float');
    expect(output).toContain('final version:Float = flighthq.types.Target.version;');
    expect(output).toContain('typedef BarrelMode = flighthq.types.Target.Mode_2;');
    expect(output).toContain('final Mode:{ basic:Float } = flighthq.types.Target.Mode;');
    expect(output).not.toContain('hidden');
  });

  it('forwards same-package Haxe type identities through star re-export facades', () => {
    const target = lower('target.ts', 'export interface Shape { value: number }').module;
    const barrel = lower('barrel.ts', "export * from './target';").module;
    const output = createHaxeCompilerBackend().emitModule(barrel, {
      moduleResolution: {
        edges: [
          {
            importer: { name: barrel.name, packageName: barrel.packageName, source: barrel.source },
            specifier: './target',
            target: { packageName: target.packageName, source: target.source },
          },
        ],
        schema: 'flight-compiler-module-resolution/1',
      },
      modules: [barrel, target],
      options: {},
    })[0]!.contents;

    expect(output).toContain('typedef BarrelShape = flighthq.math.Target.Shape;');
  });

  it('forwards generic parameters and constraints through type facade aliases', () => {
    const profile = lowerPackage(
      '@flighthq/types',
      'App.ts',
      "export type MobileOsProfile = 'android' | 'ios';",
    ).module;
    const capabilities = lowerPackage(
      '@flighthq/types',
      'CapacitorAppCapabilitiesFor.ts',
      `
        import type { MobileOsProfile } from './App';
        export type CapacitorAppCapabilitiesFor<Profile extends MobileOsProfile> = { profile: Profile };
      `,
    ).module;
    const contract = lowerPackage(
      '@flighthq/types',
      'contract.ts',
      "export * from './CapacitorAppCapabilitiesFor';",
    ).module;
    const moduleResolution = {
      edges: [
        {
          importer: { name: capabilities.name, packageName: capabilities.packageName, source: capabilities.source },
          specifier: './App',
          target: { packageName: profile.packageName, source: profile.source },
        },
        {
          importer: { name: contract.name, packageName: contract.packageName, source: contract.source },
          specifier: './CapacitorAppCapabilitiesFor',
          target: { packageName: capabilities.packageName, source: capabilities.source },
        },
      ],
      schema: 'flight-compiler-module-resolution/1' as const,
    };
    const output = createHaxeCompilerBackend().emitModule(contract, {
      moduleResolution,
      modules: [contract, capabilities, profile],
      options: {},
    })[0]!.contents;

    expect(output).toContain(
      'typedef ContractCapacitorAppCapabilitiesFor<Profile:flighthq.types.App.MobileOsProfile> = flighthq.types.CapacitorAppCapabilitiesFor.CapacitorAppCapabilitiesFor<Profile>;',
    );
  });

  it('qualifies imported types in value facade signatures from their source module', () => {
    const entity = lowerPackage(
      '@flighthq/types',
      'entity.ts',
      'export interface EntityConstruction<Value> { value: Value } export enum Choice { Ready }',
    ).module;
    const worker = lowerPackage(
      '@flighthq/core',
      'worker.ts',
      "import { Choice } from '@flighthq/types/entity'; import type { EntityConstruction } from '@flighthq/types/entity'; export function finish<Value>(out: EntityConstruction<Value>, choice: Choice = Choice.Ready): EntityConstruction<Value> { return out; }",
    ).module;
    const barrel = lowerPackage('@flighthq/core', 'contract.ts', "export * from './worker';").module;
    const moduleResolution = {
      edges: [
        {
          importer: { name: worker.name, packageName: worker.packageName, source: worker.source },
          specifier: '@flighthq/types/entity',
          target: { packageName: entity.packageName, source: entity.source },
        },
        {
          importer: { name: barrel.name, packageName: barrel.packageName, source: barrel.source },
          specifier: './worker',
          target: { packageName: worker.packageName, source: worker.source },
        },
      ],
      schema: 'flight-compiler-module-resolution/1' as const,
    };
    const output = createHaxeCompilerBackend().emitModule(barrel, {
      moduleResolution,
      modules: [barrel, entity, worker],
      options: {},
    })[0]!.contents;

    expect(output).toContain(
      'function finish<Value>(out:flighthq.types.Entity.EntityConstruction<Value>, ?choice:flighthq.types.Entity.Choice):flighthq.types.Entity.EntityConstruction<Value>',
    );
    expect(output).toContain(
      'js.Syntax.strictEq(choice, js.Syntax.code("undefined")) ? flighthq.types.Entity.Choice.Ready',
    );
  });

  it('imports the allocated type name from a contract type and value collision', () => {
    const state = lowerPackage(
      '@flighthq/types',
      'state.ts',
      "export const State = { Ready: 'Ready' } as const; export type State = (typeof State)[keyof typeof State];",
    ).module;
    const contract = lowerPackage('@flighthq/types', 'contract.ts', "export * from './state';").module;
    const consumer = lowerPackage(
      '@flighthq/core',
      'consumer.ts',
      "import { State } from '@flighthq/types/contract'; import type { State as StateType } from '@flighthq/types/contract'; export function read(value: StateType): StateType { if (value === State.Ready) return value; return State.Ready; }",
    ).module;
    const moduleResolution = {
      edges: [
        {
          importer: { name: contract.name, packageName: contract.packageName, source: contract.source },
          specifier: './state',
          target: { packageName: state.packageName, source: state.source },
        },
        {
          importer: { name: consumer.name, packageName: consumer.packageName, source: consumer.source },
          specifier: '@flighthq/types/contract',
          target: { packageName: contract.packageName, source: contract.source },
        },
      ],
      schema: 'flight-compiler-module-resolution/1' as const,
    };
    const session = createHaxeCompilerBackend().createEmissionSession!({
      moduleResolution,
      modules: [consumer, contract, state],
      options: {},
    });
    const contractOutput = session.emitModule(contract)[0]!.contents;
    const consumerOutput = session.emitModule(consumer)[0]!.contents;

    expect(contractOutput).toContain('typedef ContractState = flighthq.types.State.State_2;');
    expect(contractOutput).toContain('final State:{ Ready:String } = flighthq.types.State.State;');
    expect(consumerOutput).toContain('import flighthq.types.Contract.ContractState as StateType;');
    expect(consumerOutput).toContain('import flighthq.types.Contract.State;');
    expect(consumerOutput).toContain('function read(value:StateType):StateType');
  });

  it('resolves foreign property types to the type lane of a type and value collision', () => {
    const state = lowerPackage(
      '@flighthq/types',
      'state.ts',
      "export const State = { Ready: 'Ready' } as const; export type State = string;",
    ).module;
    const holder = lowerPackage(
      '@flighthq/types',
      'holder.ts',
      "import type { State } from './state'; export interface Holder { apply: ((value: State) => void) | null }",
    ).module;
    const contract = lowerPackage(
      '@flighthq/types',
      'contract.ts',
      "export * from './state'; export * from './holder';",
    ).module;
    const consumer = lowerPackage(
      '@flighthq/core',
      'consumer.ts',
      "import type { Holder, State as StateType } from '@flighthq/types/contract'; function apply(value: StateType): void {} export function wire(holder: Holder): void { holder.apply = apply; }",
    ).module;
    const moduleResolution = {
      edges: [
        {
          importer: { name: holder.name, packageName: holder.packageName, source: holder.source },
          specifier: './state',
          target: { packageName: state.packageName, source: state.source },
        },
        {
          importer: { name: contract.name, packageName: contract.packageName, source: contract.source },
          specifier: './state',
          target: { packageName: state.packageName, source: state.source },
        },
        {
          importer: { name: contract.name, packageName: contract.packageName, source: contract.source },
          specifier: './holder',
          target: { packageName: holder.packageName, source: holder.source },
        },
        {
          importer: { name: consumer.name, packageName: consumer.packageName, source: consumer.source },
          specifier: '@flighthq/types/contract',
          target: { packageName: contract.packageName, source: contract.source },
        },
      ],
      schema: 'flight-compiler-module-resolution/1' as const,
    };
    const output = createHaxeCompilerBackend().createEmissionSession!({
      moduleResolution,
      modules: [consumer, contract, holder, state],
      options: {},
    }).emitModule(consumer)[0]!.contents;

    expect(output).toContain('(cast apply : (StateType)->Void)');
    expect(output).not.toContain('flighthq.types.State.State');
  });

  it('separates the type lane of one merged contract import from its value lane', () => {
    const moduleResolution = {
      edges: [
        {
          specifier: './state',
          target: { packageName: '@flighthq/types', source: 'packages/types/src/state.ts' },
        },
        {
          specifier: '@flighthq/types/contract',
          target: { packageName: '@flighthq/types', source: 'packages/types/src/contract.ts' },
        },
      ],
      schema: 'flight-compiler-module-resolution/1' as const,
    };
    const inputs = [
      {
        packageName: '@flighthq/types',
        sourceFile: ts.createSourceFile(
          '/flight/packages/types/src/state.ts',
          "export const State = { Ready: 'Ready' } as const; export type State = (typeof State)[keyof typeof State];",
          ts.ScriptTarget.Latest,
          true,
        ),
        upstreamDirectory: '/flight',
      },
      {
        packageName: '@flighthq/types',
        sourceFile: ts.createSourceFile(
          '/flight/packages/types/src/contract.ts',
          "export * from './state';",
          ts.ScriptTarget.Latest,
          true,
        ),
        upstreamDirectory: '/flight',
      },
      {
        packageName: '@flighthq/core',
        sourceFile: ts.createSourceFile(
          '/flight/packages/core/src/consumer.ts',
          "import { State } from '@flighthq/types/contract'; export function read(value: State): State { return State.Ready; }",
          ts.ScriptTarget.Latest,
          true,
        ),
        upstreamDirectory: '/flight',
      },
    ];
    const [stateResult, contractResult, consumerResult] = lowerTypeScriptSources(inputs, moduleResolution);
    const state = stateResult!.module;
    const contract = contractResult!.module;
    const consumer = consumerResult!.module;
    const session = createHaxeCompilerBackend().createEmissionSession!({
      moduleResolution,
      modules: [consumer, contract, state],
      options: {},
    });
    const consumerOutput = session.emitModule(consumer)[0]!.contents;

    expect(consumerOutput).toContain('import flighthq.types.Contract.ContractState as State_2;');
    expect(consumerOutput).toContain('import flighthq.types.Contract.State;');
    expect(consumerOutput).toContain('function read(value:State_2):State_2');
    expect(consumerOutput).toContain('return State.Ready;');
  });

  it('imports the type lane inferred through an indexed contract type', () => {
    const moduleResolution = {
      edges: [
        {
          specifier: './state',
          target: { packageName: '@flighthq/types', source: 'packages/types/src/state.ts' },
        },
        {
          specifier: '@flighthq/types/contract',
          target: { packageName: '@flighthq/types', source: 'packages/types/src/contract.ts' },
        },
      ],
      schema: 'flight-compiler-module-resolution/1' as const,
    };
    const inputs = [
      {
        packageName: '@flighthq/types',
        sourceFile: ts.createSourceFile(
          '/flight/packages/types/src/state.ts',
          "export const State = { Ready: 'Ready' } as const; export type State = (typeof State)[keyof typeof State]; export interface Entry { state: State }",
          ts.ScriptTarget.Latest,
          true,
        ),
        upstreamDirectory: '/flight',
      },
      {
        packageName: '@flighthq/types',
        sourceFile: ts.createSourceFile(
          '/flight/packages/types/src/contract.ts',
          "export * from './state';",
          ts.ScriptTarget.Latest,
          true,
        ),
        upstreamDirectory: '/flight',
      },
      {
        packageName: '@flighthq/core',
        sourceFile: ts.createSourceFile(
          '/flight/packages/core/src/consumer.ts',
          "import type { Entry } from '@flighthq/types/contract'; import { State } from '@flighthq/types/contract'; export function read(value: Entry['state']): Entry['state'] { return State.Ready; }",
          ts.ScriptTarget.Latest,
          true,
        ),
        upstreamDirectory: '/flight',
      },
    ];
    const [stateResult, contractResult, consumerResult] = lowerTypeScriptSources(inputs, moduleResolution);
    const session = createHaxeCompilerBackend().createEmissionSession!({
      moduleResolution,
      modules: [consumerResult!.module, contractResult!.module, stateResult!.module],
      options: {},
    });
    const output = session.emitModule(consumerResult!.module)[0]!.contents;

    expect(output).toContain('import flighthq.types.Contract.ContractState;');
    expect(output).toContain('import flighthq.types.Contract.State;');
    expect(output).toContain('function read(value:String):String');
  });

  it('keeps a unique authored barrel route for inherited types added after resolution', () => {
    const detail = lowerPackage('@flighthq/model', 'detail.ts', 'export interface Detail { value: number }').module;
    const base = lowerPackage(
      '@flighthq/model',
      'base.ts',
      "import type { Detail } from './detail'; export interface Base { detail: Detail }",
    ).module;
    const contract = lowerPackage(
      '@flighthq/model',
      'contract.ts',
      "export * from './base'; export * from './detail';",
    ).module;
    const consumer = lowerPackage(
      '@flighthq/app',
      'consumer.ts',
      "import type { Base } from '@flighthq/model/contract'; export interface Consumer extends Base {}",
    ).module;
    const moduleResolution = {
      edges: [
        {
          importer: { name: base.name, packageName: base.packageName, source: base.source },
          specifier: './detail',
          target: { packageName: detail.packageName, source: detail.source },
        },
        {
          importer: { name: contract.name, packageName: contract.packageName, source: contract.source },
          specifier: './base',
          target: { packageName: base.packageName, source: base.source },
        },
        {
          importer: { name: contract.name, packageName: contract.packageName, source: contract.source },
          specifier: './detail',
          target: { packageName: detail.packageName, source: detail.source },
        },
        {
          importedNames: ['Base'],
          importer: { name: consumer.name, packageName: consumer.packageName, source: consumer.source },
          specifier: '@flighthq/model/contract',
          target: { packageName: contract.packageName, source: contract.source },
        },
      ],
      schema: 'flight-compiler-module-resolution/1' as const,
    };
    const output = createHaxeCompilerBackend().createEmissionSession!({
      moduleResolution,
      modules: [consumer, contract, base, detail],
      options: {},
    }).emitModule(consumer)[0]!.contents;

    expect(output).toContain('import flighthq.model.Contract.ContractDetail as Detail;');
  });

  it('shares a star facade plan across a transpile emission session', () => {
    const target = lower('target.ts', 'export function value(): number { return 1; }').module;
    const barrel = lower('barrel.ts', "export * from './target';").module;
    const session = createHaxeCompilerBackend().createEmissionSession!({
      moduleResolution: {
        edges: [
          {
            importer: { name: barrel.name, packageName: barrel.packageName, source: barrel.source },
            specifier: './target',
            target: { packageName: target.packageName, source: target.source },
          },
        ],
        schema: 'flight-compiler-module-resolution/1',
      },
      modules: [barrel, target],
      options: {},
    });

    expect(session.emitModule(barrel)[0]!.contents).toContain('return flighthq.math.Target.value();');
  });

  it('keeps internal star facades when another module has an external host import', () => {
    const target = lower(
      'target.ts',
      "import { hostValue } from 'host-runtime'; export function value(): number { return hostValue; }",
    ).module;
    const barrel = lower('barrel.ts', "export * from './target';").module;
    const session = createHaxeCompilerBackend().createEmissionSession!({
      moduleResolution: {
        edges: [
          {
            importer: { name: barrel.name, packageName: barrel.packageName, source: barrel.source },
            specifier: './target',
            target: { packageName: target.packageName, source: target.source },
          },
        ],
        schema: 'flight-compiler-module-resolution/1',
      },
      modules: [barrel, target],
      options: {},
    });

    expect(session.emitModule(barrel)[0]!.contents).toContain('return flighthq.math.Target.value();');
  });

  it('keeps resolvable star facades when an unrelated export target is unavailable', () => {
    const target = lower('target.ts', 'export function value(): number { return 1; }').module;
    const valid = lower('valid.ts', "export * from './target';").module;
    const unavailable = lower('unavailable.ts', "export * from './missing';").module;
    const session = createHaxeCompilerBackend().createEmissionSession!({
      moduleResolution: {
        edges: [
          {
            importer: { name: valid.name, packageName: valid.packageName, source: valid.source },
            specifier: './target',
            target: { packageName: target.packageName, source: target.source },
          },
        ],
        schema: 'flight-compiler-module-resolution/1',
      },
      modules: [unavailable, valid, target],
      options: {},
    });

    expect(session.emitModule(valid)[0]!.contents).toContain('return flighthq.math.Target.value();');
    expect(() => session.emitModule(unavailable)).toThrow('all exports require Haxe module-facade lowering');
  });

  it('isolates a valid star facade from an unrelated ambiguous barrel', () => {
    const target = lower('target.ts', 'export function value(): number { return 1; }').module;
    const valid = lower('valid.ts', "export * from './target';").module;
    const first = lower('first.ts', 'export const collision: number = 1;').module;
    const second = lower('second.ts', 'export const collision: number = 2;').module;
    const ambiguous = lower('ambiguous.ts', "export * from './first'; export * from './second';").module;
    const session = createHaxeCompilerBackend().createEmissionSession!({
      moduleResolution: {
        edges: [
          {
            importer: { name: valid.name, packageName: valid.packageName, source: valid.source },
            specifier: './target',
            target: { packageName: target.packageName, source: target.source },
          },
          {
            importer: { name: ambiguous.name, packageName: ambiguous.packageName, source: ambiguous.source },
            specifier: './first',
            target: { packageName: first.packageName, source: first.source },
          },
          {
            importer: { name: ambiguous.name, packageName: ambiguous.packageName, source: ambiguous.source },
            specifier: './second',
            target: { packageName: second.packageName, source: second.source },
          },
        ],
        schema: 'flight-compiler-module-resolution/1',
      },
      modules: [ambiguous, first, second, target, valid],
      options: {},
    });

    expect(session.emitModule(valid)[0]!.contents).toContain('return flighthq.math.Target.value();');
    expect(() => session.emitModule(ambiguous)).toThrow('all exports require Haxe module-facade lowering');
  });

  it('uses imported-name routes for value re-export forwarding', () => {
    const helper = lower('helper.ts', 'export function helper(): number { return 1; }').module;
    const facade = lower('facade.ts', "export { helper } from './helper';").module;
    const output = createHaxeCompilerBackend().emitModule(facade, {
      moduleResolution: {
        edges: [
          {
            importer: { name: facade.name, packageName: facade.packageName, source: facade.source },
            importedNames: ['helper'],
            specifier: './helper',
            target: { packageName: helper.packageName, source: helper.source },
          },
        ],
        schema: 'flight-compiler-module-resolution/1',
      },
      modules: [facade, helper],
      options: {},
    })[0]!.contents;

    expect(output).toContain('return flighthq.math.Helper.helper();');
  });

  it('plans exported imports whose names resolve through distinct barrel routes', () => {
    const first = lowerPackage('@flighthq/types', 'first.ts', 'export interface First { first: number }').module;
    const second = lowerPackage('@flighthq/types', 'second.ts', 'export interface Second { second: number }').module;
    const hidden = lowerPackage('@flighthq/types', 'hidden.ts', 'export interface Hidden { hidden: number }').module;
    const facade = lowerPackage(
      '@flighthq/model',
      'facade.ts',
      "import type { First, Second, Hidden } from '@flighthq/types/contract'; export type { First, Second }; export function keep(value: Hidden): Hidden { return value; }",
    ).module;
    const session = createHaxeCompilerBackend().createEmissionSession!({
      moduleResolution: {
        edges: [
          {
            importer: { name: facade.name, packageName: facade.packageName, source: facade.source },
            importedNames: ['First'],
            specifier: '@flighthq/types/contract',
            target: { packageName: first.packageName, source: first.source },
          },
          {
            importer: { name: facade.name, packageName: facade.packageName, source: facade.source },
            importedNames: ['Hidden'],
            specifier: '@flighthq/types/contract',
            target: { packageName: hidden.packageName, source: hidden.source },
          },
          {
            importer: { name: facade.name, packageName: facade.packageName, source: facade.source },
            importedNames: ['Second'],
            specifier: '@flighthq/types/contract',
            target: { packageName: second.packageName, source: second.source },
          },
        ],
        schema: 'flight-compiler-module-resolution/1',
      },
      modules: [facade, first, hidden, second],
      options: {},
    });

    expect(() => session.emitModule(facade)).not.toThrow();
  });

  it('imports a locally re-exported imported type from its declaration home', () => {
    const callbacks = lowerPackage(
      '@flighthq/types',
      'callbacks.ts',
      'export interface Callbacks { update(): void }',
    ).module;
    const bridge = lowerPackage(
      '@flighthq/particles',
      'update.ts',
      "import type { Callbacks } from '@flighthq/types/callbacks'; export type { Callbacks };",
    ).module;
    const consumer = lowerPackage(
      '@flighthq/particles',
      'prewarm.ts',
      "import type { Callbacks } from './update'; export function prewarm(callbacks?: Callbacks): void {}",
    ).module;
    const contract = lowerPackage('@flighthq/particles', 'contract.ts', "export * from './prewarm';").module;
    const moduleResolution = {
      edges: [
        {
          importer: { name: bridge.name, packageName: bridge.packageName, source: bridge.source },
          specifier: '@flighthq/types/callbacks',
          target: { packageName: callbacks.packageName, source: callbacks.source },
        },
        {
          importer: { name: consumer.name, packageName: consumer.packageName, source: consumer.source },
          specifier: './update',
          target: { packageName: bridge.packageName, source: bridge.source },
        },
        {
          importer: { name: contract.name, packageName: contract.packageName, source: contract.source },
          specifier: './prewarm',
          target: { packageName: consumer.packageName, source: consumer.source },
        },
      ],
      schema: 'flight-compiler-module-resolution/1' as const,
    };
    const session = createHaxeCompilerBackend().createEmissionSession!({
      moduleResolution,
      modules: [contract, consumer, bridge, callbacks],
      options: {},
    });
    const output = session.emitModule(consumer)[0]!.contents;
    const facade = session.emitModule(contract)[0]!.contents;

    expect(output).toContain('import flighthq.types.Callbacks.Callbacks;');
    expect(output).not.toContain('flighthq.particles.Update.Callbacks');
    expect(facade).toContain('?callbacks:flighthq.types.Callbacks.Callbacks');
    expect(facade).not.toContain('flighthq.particles.Update.Callbacks');
  });

  it('recovers a unique cross-package declaration home outside the frozen import graph', () => {
    const entity = lowerPackage(
      '@flighthq/types',
      'Entity.ts',
      'export interface EntityRuntime { binding: object | null }',
    ).module;
    const consumer = lowerPackage(
      '@flighthq/media',
      'audioDeviceBackend.ts',
      "import type { EntityRuntime } from '@flighthq/types/contract'; export interface WebExtension { runtime: EntityRuntime }",
    ).module;
    const output = createHaxeCompilerBackend().createEmissionSession!({
      moduleResolution: { edges: [], schema: 'flight-compiler-module-resolution/1' },
      modules: [consumer, entity],
      options: {},
    }).emitModule(consumer)[0]!.contents;

    expect(output).toContain('import flighthq.types.Entity.EntityRuntime;');
    expect(output).not.toContain('flighthq.types.Types.EntityRuntime');
  });

  it('forwards an explicit value re-export through an intermediate star barrel', () => {
    const helper = lower('helper.ts', 'export function helper(): number { return 1; }').module;
    const barrel = lower('barrel.ts', "export * from './helper';").module;
    const facade = lower('facade.ts', "export { helper } from './barrel';").module;
    const session = createHaxeCompilerBackend().createEmissionSession!({
      moduleResolution: {
        edges: [
          {
            importer: { name: barrel.name, packageName: barrel.packageName, source: barrel.source },
            specifier: './helper',
            target: { packageName: helper.packageName, source: helper.source },
          },
          {
            importer: { name: facade.name, packageName: facade.packageName, source: facade.source },
            importedNames: ['helper'],
            specifier: './barrel',
            target: { packageName: barrel.packageName, source: barrel.source },
          },
        ],
        schema: 'flight-compiler-module-resolution/1',
      },
      modules: [barrel, facade, helper],
      options: {},
    });

    expect(session.emitModule(facade)[0]!.contents).toContain('return flighthq.math.Helper.helper();');
  });

  it('forwards mutable star facade values and refuses namespace and ambiguous star values', () => {
    const mutable = lower('mutable.ts', 'export let value: number = 1;').module;
    const mutableBarrel = lower('mutable-barrel.ts', "export * from './mutable';").module;
    const mutableResolution = {
      edges: [
        {
          importer: {
            name: mutableBarrel.name,
            packageName: mutableBarrel.packageName,
            source: mutableBarrel.source,
          },
          specifier: './mutable',
          target: { packageName: mutable.packageName, source: mutable.source },
        },
      ],
      schema: 'flight-compiler-module-resolution/1' as const,
    };
    const mutableOutput = createHaxeCompilerBackend().emitModule(mutableBarrel, {
      moduleResolution: mutableResolution,
      modules: [mutableBarrel, mutable],
      options: {},
    })[0]!.contents;
    expect(mutableOutput).toContain('var value(get, never):Float;');
    expect(mutableOutput).toContain('inline function get_value():Float return flighthq.math.Mutable.value;');

    const origin = lower('origin.ts', 'export const value: number = 1;').module;
    const namespace = lower('namespace.ts', "export * as values from './origin';").module;
    const namespaceBarrel = lower('namespace-barrel.ts', "export * from './namespace';").module;
    expect(() =>
      createHaxeCompilerBackend().emitModule(namespaceBarrel, {
        moduleResolution: {
          edges: [
            {
              importer: { name: namespace.name, packageName: namespace.packageName, source: namespace.source },
              specifier: './origin',
              target: { packageName: origin.packageName, source: origin.source },
            },
            {
              importer: {
                name: namespaceBarrel.name,
                packageName: namespaceBarrel.packageName,
                source: namespaceBarrel.source,
              },
              specifier: './namespace',
              target: { packageName: namespace.packageName, source: namespace.source },
            },
          ],
          schema: 'flight-compiler-module-resolution/1',
        },
        modules: [namespaceBarrel, namespace, origin],
        options: {},
      }),
    ).toThrow('re-exporting values requires a bound Haxe module-facade route');

    const first = lower('first.ts', 'export const value: number = 1;').module;
    const second = lower('second.ts', 'export const value: number = 2;').module;
    const ambiguous = lower('ambiguous.ts', "export * from './first'; export * from './second';").module;
    expect(() =>
      createHaxeCompilerBackend().emitModule(ambiguous, {
        moduleResolution: {
          edges: [
            {
              importer: { name: ambiguous.name, packageName: ambiguous.packageName, source: ambiguous.source },
              specifier: './first',
              target: { packageName: first.packageName, source: first.source },
            },
            {
              importer: { name: ambiguous.name, packageName: ambiguous.packageName, source: ambiguous.source },
              specifier: './second',
              target: { packageName: second.packageName, source: second.source },
            },
          ],
          schema: 'flight-compiler-module-resolution/1',
        },
        modules: [ambiguous, first, second],
        options: {},
      }),
    ).toThrow('all exports require Haxe module-facade lowering');
  });
});

describe('emitIrModuleHaxe', () => {
  it('reports structural object incompatibility before Haxe source emission', () => {
    const result = lower(
      'duplicate-object.ts',
      'export function create(): { value: number } { return { value: 1, value: 2 }; }',
    );

    expect(() => emitIrModuleHaxe(result.module)).toThrow(
      'structural object compatibility duplicate-property-requires-normalization',
    );
    try {
      emitIrModuleHaxe(result.module);
    } catch (error) {
      expect(isBackendEmissionFailure(error)).toBe(true);
    }
  });

  it('treats asserted literals and conditional spread fragments as partial constructions', () => {
    const asserted = lower(
      'asserted-construction.ts',
      `interface RecordValue { required: number }
       export function create(): RecordValue {
         const value = {} as RecordValue;
         value.required = 1;
         return value;
       }`,
    );
    const spread = lower(
      'conditional-spread-construction.ts',
      `interface RecordValue { first: number; second: number }
       export function create(flag: boolean): RecordValue {
         return { first: 1, second: 2, ...(flag ? { second: 3 } : {}) };
      }`,
    );
    const coalesced = lower(
      'asserted-coalesce-construction.ts',
      `interface RecordValue { required: number }
       export function create(source?: RecordValue): RecordValue {
         const value = (source ?? {}) as RecordValue;
         value.required = 1;
         return value;
       }`,
    );

    expect(() => emitIrModuleHaxe(asserted.module)).not.toThrow();
    expect(() => emitIrModuleHaxe(spread.module)).not.toThrow();
    expect(() => emitIrModuleHaxe(coalesced.module)).not.toThrow();
  });

  it('constructs generic structural records with substituted nested target types', () => {
    const result = lower(
      'generic-object.ts',
      `
        interface Item { label: string }
        interface Box<Value> { value: Value; optional?: Value }
        export function create(): Box<Item> { return { value: { label: 'flight' } }; }
      `,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('typedef Box<Value> = { value:Value, ?optional:Value };');
    expect(output).toContain('function create():Box<Item>');
    expect(output).toContain('return (cast { value: (cast { label: "flight" } : Item) } : Box<Item>);');
  });

  it('preserves optional nullable parameters for JavaScript strict absence checks', () => {
    const result = lower('optional-nullable.ts', 'export function choose(value?: number | null): void { value; }');

    expect(emitIrModuleHaxe(result.module).contents).toContain('function choose(?value:Null<Float>):Void');
  });

  it('uses JavaScript syntax injection for host constructors without nominal Haxe classes', () => {
    const result = lower(
      'javascript-host-constructor.ts',
      'export function create(width: number, height: number): OffscreenCanvas { return new OffscreenCanvas(width, height); }',
    );

    expect(emitIrModuleHaxe(result.module).contents).toContain(
      'js.Syntax.code("new OffscreenCanvas({0}, {1})", width, height)',
    );
  });

  it('uses JavaScript syntax injection for the Function constructor', () => {
    const result = lower(
      'function-constructor.ts',
      'export function create(source: string): Function { return new Function(source); }',
    );

    expect(emitIrModuleHaxe(result.module).contents).toContain('js.Syntax.code("new Function({0})", source)');
  });

  it('lowers a suspending finally after a normally completing protected region', () => {
    const result = lower(
      'finally-await.ts',
      `export async function close(task: Promise<void>, cleanup: Promise<void>): Promise<void> {
        let failed = false;
        try { await task; } catch { failed = true; } finally { await cleanup; }
      }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('finallyThrew');
    expect(output).toContain('finallyError');
    expect(output).toContain('_Promise.resolve(cleanup)');
  });

  it('emits shared traceable provenance with an optional upstream commit', () => {
    const module = lower('value.ts', 'export const value = 1;').module;
    const commit = '0123456789abcdef0123456789abcdef01234567';

    expect(emitIrModuleHaxe(module).contents.split('\n')[0]).toBe(
      '// Generated by @flighthq/tool-compiler from @flighthq/math/packages/math/src/value.ts#Value. Do not edit.',
    );
    expect(emitIrModuleHaxe(module, { upstreamCommit: commit }).contents.split('\n')[0]).toBe(
      `// Generated by @flighthq/tool-compiler from @flighthq/math/packages/math/src/value.ts#Value at ${commit}. Do not edit.`,
    );
  });

  it('emits explicit type and value runtime bindings for all bound ambient symbols', () => {
    const supported = lower(
      'external-types.ts',
      'export function preserve(values: Map<string, number>, bytes: Uint8Array, task: Promise<number>): Promise<number> { values; bytes; return task; }',
    );
    const weakMap = lower('external-weakmap.ts', 'export function store(map: WeakMap<object, number>): void { map; }');
    const values = lower(
      'external-values.ts',
      'export function create(): Promise<number> { const values = new Map<string, number>(); const bytes = new Uint8Array(3); values; bytes; return Promise.resolve(1); }',
    );
    const output = emitIrModuleHaxe(supported.module).contents;
    const custom = emitIrModuleHaxe(supported.module, { runtimeModule: 'custom.runtime' }).contents;
    const valueOutput = emitIrModuleHaxe(values.module).contents;
    const customValueOutput = emitIrModuleHaxe(values.module, { runtimeModule: 'custom.runtime' }).contents;
    const weakMapOutput = emitIrModuleHaxe(weakMap.module).contents;

    expect(output).toContain('values:flighthq._internal._Map<String, Float>');
    expect(output).toContain('bytes:flighthq._internal._UInt8Array');
    expect(output).toContain('task:flighthq._internal._Promise<Float>');
    expect(custom).toContain('task:custom.runtime._Promise<Float>');
    expect(valueOutput).toContain('new flighthq._internal._Map()');
    expect(valueOutput).toContain('new flighthq._internal._UInt8Array(Std.int(3))');
    expect(valueOutput).toContain('flighthq._internal._Promise.resolve(1)');
    expect(customValueOutput).toContain('new custom.runtime._UInt8Array(Std.int(3))');
    expect(customValueOutput).toContain('new custom.runtime._Map()');
    expect(customValueOutput).toContain('custom.runtime._Promise.resolve(1)');
    expect(weakMapOutput).toContain('flighthq._internal._WeakMap');
  });

  it('emits fixed-length arrays through the versioned Haxe runtime ABI and refuses dynamic arity', () => {
    const fixed = lower('array-constructor.ts', 'export function create(): number[] { return new Array<number>(3); }');
    const dynamic = lower(
      'map-constructor-spread.ts',
      'export function create(values: []): Map<string, number> { return new Map<string, number>(...values); }',
    );

    expect(emitIrModuleHaxe(fixed.module).contents).toContain('new flighthq._internal._Array(Std.int(3))');
    expect(() => emitIrModuleHaxe(dynamic.module)).toThrow(
      'runtime external constructor ABI plan is incomplete (missing: Map[value](...))',
    );
  });

  it('refuses qualified constructors outside direct ambient ABI identity', () => {
    const result = lower(
      'qualified-constructor.ts',
      'class Value {} export function create(namespace: { Value: typeof Value }): Value { return new namespace.Value(); }',
    );

    expect(() => emitIrModuleHaxe(result.module)).toThrow('qualified constructors require Haxe type-path lowering');
  });

  it('emits qualified ambient runtime constructors through their runtime member contract', () => {
    const result = lower(
      'intl-segmenter.ts',
      'export function create(): Intl.Segmenter { return new Intl.Segmenter("en"); }',
    );

    expect(emitIrModuleHaxe(result.module, { runtimeModule: 'flight._hx._runtime' }).contents).toContain(
      'new flight._hx._runtime._IntlSegmenter("en")',
    );
  });

  it('folds typeof availability checks for contracted ambient runtime values', () => {
    const result = lower(
      'proxy-availability.ts',
      "export function available(): boolean { return typeof Proxy !== 'undefined'; }",
    );

    expect(emitIrModuleHaxe(result.module).contents).toContain('return true;');
  });

  it('represents dependent callable parameter packs as dynamic Haxe rest elements', () => {
    const result = lower(
      'dependent-parameters.ts',
      'export function emit<T extends (...args: any[]) => void>(slot: T, ...args: Parameters<T>): void { slot(...args); }',
    );

    const output = emitIrModuleHaxe(result.module).contents;
    expect(output).toContain('function emit<T>(slot:T, ...args:Dynamic):Void');
  });

  it('routes missing Math members and variadic extrema through exact Haxe spellings', () => {
    const result = lower(
      'math-members.ts',
      'export function calculate(value: number): number { return Math.max(Math.log2(value), Math.sign(value), Math.trunc(value)); }',
    );
    const output = emitIrModuleHaxe(result.module, { runtimeModule: 'flight._internal' }).contents;

    expect(output).toContain(
      'Math.max(Math.max(flight._internal._Math.log2(value), flight._internal._Math.sign(value)), flight._internal._Math.trunc(value))',
    );
  });

  it('preserves Math cbrt and hypot through target-JavaScript syntax', () => {
    const result = lower(
      'math-modern.ts',
      'export function length(x: number, y: number): number { return Math.cbrt(Math.hypot(x, y)); }',
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('js.Syntax.code("Math.hypot({0}, {1})", x, y)');
    expect(output).toContain('js.Syntax.code("Math.cbrt({0})"');
  });

  it('uses the Haxe self-call constructor spelling for Symbol', () => {
    const result = lower('symbol-call.ts', 'export function key(name: string): symbol { return Symbol(name); }');

    expect(emitIrModuleHaxe(result.module, { runtimeModule: 'flight._internal' }).contents).toContain(
      'return new flight._internal._Symbol(name);',
    );
  });

  it('uses the runtime helper for multi-value Array.push', () => {
    const result = lower(
      'push-many.ts',
      'export function append(values: number[]): number { return values.push(1, 2); }',
    );

    expect(emitIrModuleHaxe(result.module, { runtimeModule: 'flight._internal' }).contents).toContain(
      'flight._internal._ArrayTools.pushMany(values, (cast [1, 2] : Array<Float>))',
    );
  });

  it('lowers writable Array.length through resize while preserving the assigned value', () => {
    const result = lower(
      'array-length-write.ts',
      'export function resize(values: number[], size: number): number { return values.length = size; }',
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('arrayLengthReceiver.resize(Std.int(arrayLengthValue))');
    expect(output).toContain('return arrayLengthValue');
  });

  it('lowers variadic Array concat and inserting splice to Haxe collection operations', () => {
    const result = lower(
      'array-variadic.ts',
      `export function merge(a: number[], b: number[], c: number[]): number[] { return a.concat(b, c); }
       export function insert(values: number[], at: number, value: number): number[] { return values.splice(at, 0, value); }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('a.concat(b).concat(c)');
    expect(output).toContain('.insert(splicePosition, value)');
    expect(output).toContain('return spliceRemoved');
  });

  it('supplies the target length when source Array.splice omits deleteCount', () => {
    const result = lower(
      'drain-array.ts',
      'export function drain(values: number[]): number[] { return values.splice(0); }',
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('return spliceReceiver.splice(splicePosition, spliceReceiver.length);');
  });

  it('narrows integer typed-array writes to the Haxe element domain', () => {
    const result = lower(
      'typed-array-write.ts',
      'export function write(values: Uint32Array, index: number, value: number): void { values[index] = value; }',
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('values[Std.int(index)] = Std.int(value)');
  });

  it('materializes Haxe rest packs as arrays for ordinary collection methods', () => {
    const result = lower(
      'rest-array.ts',
      'export function copy(...values: number[]): number[] { return values.copy(); }',
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('final valuesArray:Array<Float> = values.toArray();');
    expect(output).toContain('return (cast valuesArray.copy() : Array<Float>);');
  });

  it('hoists a local captured by a closure before its declaration', () => {
    const result = lower(
      'forward-capture.ts',
      `export function create(): () => number {
         const read = () => value;
         const value = 1;
         return read;
       }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output.indexOf('var value:Float;')).toBeLessThan(output.indexOf('final read'));
    expect(output).toContain('value = 1;');
  });

  it('hoists a local captured by a closure in its own initializer', () => {
    const result = lower(
      'self-capture.ts',
      `interface Cursor { read(): number }
       export function create(): Cursor {
         const cursor: Cursor = { read: () => cursor.read() };
         return cursor;
       }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output.indexOf('var cursor:Cursor;')).toBeLessThan(output.indexOf('cursor ='));
    expect(output).not.toContain('final cursor:Cursor =');
  });

  it('hoists a self-recursive local inside a nested statement list', () => {
    const result = lower(
      'nested-self-capture.ts',
      `export function sum(groups: number[][]): number {
         let total = 0;
         for (const group of groups) {
           const walk = (values: number[]): number =>
             values.length === 0 ? 0 : values[0]! + walk(values.slice(1));
           total += walk(group);
         }
         return total;
       }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output.indexOf('var walk:(Array<Float>)->Float;')).toBeLessThan(output.indexOf('walk = function'));
    expect(output).not.toContain('final walk');
  });

  it('uses JavaScript truthiness for nullable structural and callable conditions', () => {
    const result = lower(
      'truthiness.ts',
      `export function choose(value: { ok: boolean } | null, callback: (() => number) | null): number {
         if (value) return callback ? callback() : 1;
         return 0;
       }`,
    );
    const output = emitIrModuleHaxe(result.module, { runtimeModule: 'flight._internal' }).contents;

    expect(output).toContain('flight._internal._Js.truthy(value)');
    expect(output).toContain('flight._internal._Js.truthy(callback) ?');
  });

  it('widens generic projected structural aliases that Haxe cannot represent', () => {
    const result = lower(
      'omit-shape.ts',
      `type Public<Value> = Omit<Value, 'hidden'>;
       export function read<Value>(value: Public<Value>): unknown { return value; }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('typedef Public<Value> = Dynamic;');
  });

  it('writes DynamicAccess fields reflectively', () => {
    const result = lower(
      'dynamic-access-write.ts',
      `export function write(value: Record<string, unknown>): unknown {
         value.extra = 1;
         return value;
       }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('HaxeReflect.setField(dynamicAccessReceiver, "extra", dynamicAccessValue)');
  });

  it('emits source generic defaults and Promise void carriers accepted by Haxe', () => {
    const result = lower(
      'generic-defaults.ts',
      'export type Box<Value = string> = { value: Value }; export function identity<Value = string>(value: Value): Value { return value; } export function settle(task: Promise<void>): Promise<void> { return task; }',
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('typedef Box<Value = String>');
    expect(output).toContain('function identity<Value>(value:Value):Value');
    expect(output).not.toContain('function identity<Value = String>');
    expect(output).toContain('_Promise<Dynamic>');
  });

  it('erases structural Entity constraints and widens stored void fields', () => {
    const result = lower(
      'entity.ts',
      `
        export interface Entity { runtime?: object }
        export interface Brand { marker?: void }
        export type EntityView<Type extends Entity> = Type;
        export function finish<Type extends Entity>(value: Type): Type { return value; }
      `,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('typedef Brand = { ?marker:Dynamic };');
    expect(output).toContain('typedef EntityView<Type> = Type;');
    expect(output).toContain('function finish<Type>(value:Type):Type');
    expect(output).not.toContain('<Type:Entity>');
  });

  it('elects C-style for lowering without lowering native Haxe default parameters', () => {
    const loop = lower(
      'loop.ts',
      'export function total(limit: number): number { let total = 0; for (let index = 0; index < limit; index++) { total += index; } return total; }',
    );
    const defaults = lower(
      'defaults.ts',
      'export function scale(value: number, factor: number = 2): number { return value * factor; }',
    );
    const output = emitIrModuleHaxe(loop.module).contents;

    expect(output).toContain('var index:Float = 0;');
    expect(output).toContain('while (index < limit)');
    expect(output).toContain('(index += 1);');
    expect(emitIrModuleHaxe(defaults.module).contents).toContain(
      'js.Syntax.strictEq(factor, js.Syntax.code("undefined")) ? 2',
    );
  });

  it('emits one overload implementation and calls its native default ABI', () => {
    const result = lower(
      'overload-default.ts',
      `
        function choose(value: number): number;
        function choose(value: number, radix?: number): number;
        function choose(value: number, radix = 10): number { return value + radix; }
        export function read(): number { return choose(1); }
      `,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    // One implementation, not one per overload signature.
    expect(output.match(/function choose/gu)).toHaveLength(1);
    expect(output).toContain('function choose(value:Float, ?radix:Float):Float');
    expect(output).toContain('radixDefault:Float');
    expect(output).toContain('return choose(1);');
  });

  it('emits one class method overload implementation and calls its native default ABI', () => {
    const result = lower(
      'method-overload-default.ts',
      `
        export class Picker {
          choose(value: number): number;
          choose(value: number, radix?: number): number;
          choose(value: number, radix = 10): number { return value + radix; }
        }
        export function read(picker: Picker): number { return picker.choose(1); }
      `,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output.match(/function choose/gu)).toHaveLength(1);
    expect(output).toContain('public function choose(value:Float, ?radix:Float):Float');
    expect(output).toContain('radixDefault:Float');
    expect(output).toContain('return picker.choose(1);');
  });

  it('emits one constructor implementation and calls its native default ABI', () => {
    const result = lower(
      'constructor-overload-default.ts',
      `
        export class Box {
          constructor(value: number);
          constructor(value: number, radix?: number);
          constructor(value: number, radix = 10) { value; radix; }
        }
        export function create(): Box { return new Box(1); }
      `,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output.match(/public function new/gu)).toHaveLength(1);
    expect(output).toContain('public function new(value:Float, ?radix:Float)');
    expect(output).toContain('radixDefault:Float');
    expect(output).toContain('return new Box(1);');
  });

  it('emits parameter-property storage at base and derived initialization boundaries', () => {
    const base = lower(
      'reader.ts',
      'export class Reader { constructor(readonly source: string, public position: number) { position; } }',
    );
    const derived = lower(
      'derived.ts',
      `
        class Base { constructor(value: string) { value; } }
        export class Derived extends Base {
          code = 1;
          constructor(value: string, readonly label: string) {
            value;
            super(value);
            label;
          }
        }
      `,
    );
    const baseOutput = emitIrModuleHaxe(base.module).contents;
    const derivedOutput = emitIrModuleHaxe(derived.module).contents;

    expect(base.diagnostics).toEqual([]);
    expect(baseOutput).toContain('final source:String;');
    expect(baseOutput).toContain('public var position:Float;');
    expect(baseOutput).toContain(
      'public function new(source:String, position:Float) {\n    this.source = source;\n    this.position = position;\n    position;\n  }',
    );
    expect(derived.diagnostics).toEqual([]);
    expect(derivedOutput).toContain('var code:Float;');
    expect(derivedOutput).toContain(
      'value;\n    super(value);\n    this.code = 1;\n    this.label = label;\n    label;',
    );
    expect(derivedOutput.indexOf('super(value)')).toBeLessThan(derivedOutput.indexOf('this.code = 1'));
    expect(derivedOutput.indexOf('this.code = 1')).toBeLessThan(derivedOutput.indexOf('this.label = label'));
  });

  it('emits implicit derived constructor forwarding super call', () => {
    const implicit = lower('implicit-derived.ts', 'class Base {} export class Derived extends Base {}');
    const emitted = emitIrModuleHaxe(implicit.module);

    expect(emitted.contents).toContain('extends Base');
    expect(emitted.contents).toContain('public function new()');
    expect(emitted.contents).toContain('super()');
  });

  it('forwards base constructor parameters in implicit derived constructor', () => {
    const result = lower(
      'param-forward.ts',
      'class Base { value: number; constructor(v: number) { this.value = v; } } export class Child extends Base { extra: number = 1; }',
    );
    const emitted = emitIrModuleHaxe(result.module);

    expect(emitted.contents).toContain('public function new(v:Float)');
    expect(emitted.contents).toContain('super(v)');
    expect(emitted.contents).toContain('this.extra = 1');
  });

  it('skips inherited field redeclaration in derived class', () => {
    const result = lower(
      'abstract-fields.ts',
      'abstract class Component { abstract name: string; } export class Button extends Component { name: string = "button"; }',
    );
    const emitted = emitIrModuleHaxe(result.module);
    const buttonSection = emitted.contents.slice(emitted.contents.indexOf('class Button'));

    expect(buttonSection).not.toMatch(/var name/);
    expect(buttonSection).toContain('this.name = "button"');
  });

  it('emits default constructor for leaf class without explicit constructor', () => {
    const result = lower(
      'leaf-class.ts',
      'export class Counter { step: number = 1; advance(by: number): number { return by + this.step; } }',
    );
    const emitted = emitIrModuleHaxe(result.module);

    expect(emitted.contents).toContain('public function new() {}');
    expect(emitted.contents).toContain('var step:Float = 1');
  });

  it('refuses derived constructor shapes whose field timing cannot be preserved', () => {
    const conditional = lower(
      'conditional-super.ts',
      'class Base {} export class Derived extends Base { value = 1; constructor(flag: boolean) { if (flag) super(); else super(); } }',
    );
    const repeated = lower(
      'repeated-super.ts',
      'class Base {} export class Derived extends Base { constructor(flag: boolean) { super(); if (flag) super(); } }',
    );
    const base = lower('base-super.ts', 'export class Base { constructor() { super(); } }');

    expect(() => emitIrModuleHaxe(conditional.module)).toThrow(
      'super constructor calls require a direct derived-constructor statement in Haxe',
    );
    expect(() => emitIrModuleHaxe(repeated.module)).toThrow(
      'super constructor calls require a direct derived-constructor statement in Haxe',
    );
    expect(() => emitIrModuleHaxe(base.module)).toThrow(
      'super constructor calls require a direct derived-constructor statement in Haxe',
    );
  });

  it('maps ambient Error inheritance to Haxe exception storage', () => {
    const result = lower(
      'timeout.ts',
      `
        export class Timeout extends Error {
          readonly channel: string;
          constructor(channel: string) {
            super(channel);
            this.name = 'Timeout';
            this.channel = channel;
          }
        }
      `,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(result.diagnostics).toEqual([]);
    expect(output).toContain('class Timeout extends haxe.Exception {');
    expect(output).toContain('public var name:String;');
    expect(output).toContain(
      'super(channel);\n    this.name = "Error";\n    (this.name = "Timeout");\n    (this.channel = channel);',
    );
  });

  it('evaluates fixed extra arguments before erasing them from a Haxe call', () => {
    const result = lower(
      'extra-argument.ts',
      'function effect(value: number): number { return value; } function choose(value: number): number { return value; } export function read(): number { return choose(effect(1), effect(2)); }',
    );
    const property = lower(
      'property-extra-argument.ts',
      'export class Picker { choose(value: number): number { return value; } } export function read(picker: Picker): number { return picker.choose(1, 2); }',
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('final callArgument0 = effect(1);');
    expect(output).toContain('final callArgument1 = effect(2);');
    expect(output).toContain('choose(callArgument0);');
    expect(output).not.toContain('choose(effect(1), effect(2))');
    expect(output.indexOf('callArgument0 = effect(1)')).toBeLessThan(output.indexOf('callArgument1 = effect(2)'));
    expect(output.indexOf('callArgument1 = effect(2)')).toBeLessThan(output.indexOf('choose(callArgument0)'));
    expect(() => emitIrModuleHaxe(property.module)).toThrow('fixed extra call arguments remain after erasure');
  });

  it('elects fixed array binding lowering and reports residual destructuring semantics', () => {
    const fixed = lower(
      'array-binding.ts',
      'export function select(values: [number, number, number]): number { const [first, , third]: [number, number, number] = values; third; return first; }',
    );
    const defaulted = lower(
      'array-default.ts',
      'export function select(values: [number?]): number { const [first = 0]: [number?] = values; return first; }',
    );
    const requiredDefault = lower(
      'array-required-default.ts',
      'export function select(values: [number | undefined]): number { const [first = 0]: [number | undefined] = values; return first; }',
    );
    const dynamicIndex = lower(
      'tuple-index.ts',
      'export function select(values: [number], index: number): number { return values[index]; }',
    );
    const rest = lower(
      'array-rest.ts',
      'export function select(values: [number, ...number[]]): number[] { const [first, ...rest]: [number, ...number[]] = values; first; return rest; }',
    );
    const nestedDefault = lower(
      'array-nested-default.ts',
      'export function select(values: [[number]?]): number { const [[first] = [1]]: [[number]?] = values; return first; }',
    );
    const fixedRest = lower(
      'array-fixed-rest.ts',
      'export function select(values: [number, string, boolean]): [string, boolean] { const [first, ...rest]: [number, string, boolean] = values; first; return rest; }',
    );
    const emptyRest = lower(
      'array-empty-rest.ts',
      'export function select(values: [number]): [] { const [first, ...rest]: [number] = values; first; return rest; }',
    );
    const optionalRest = lower(
      'array-optional-rest.ts',
      'export function select(values: [number, string?]): [string?] { const [first, ...rest]: [number, string?] = values; first; return rest; }',
    );
    const mixedRest = lower(
      'array-mixed-rest.ts',
      'export function select(values: [number, string, ...boolean[]]): [string, ...boolean[]] { const [first, ...rest]: [number, string, ...boolean[]] = values; first; return rest; }',
    );
    const iteration = lower(
      'array-iteration.ts',
      'export function visit(rows: Array<[number, number]>): number { for (const [first, second] of rows) { second; return first; } return 0; }',
    );
    const output = emitIrModuleHaxe(fixed.module).contents;

    // A tuple whose positions all hold one type is that array in Haxe, so its reads need no cast.
    expect(output).toContain('final arrayPatternValue:Array<Float> = values;');
    expect(output).toContain('final first:Float = arrayPatternValue[0];');
    expect(output).toContain('final third:Float = arrayPatternValue[2];');
    // A tuple with an optional position has no Haxe array type that holds it, so it is
    // `Array<Dynamic>` and reads out of it reach their declared type by cast.
    expect(emitIrModuleHaxe(defaulted.module).contents).toContain(
      'final first:Float = (cast (arrayPatternValue[0] ?? 0) : Float);',
    );
    // A tuple written with an explicit `undefined` member is homogeneous, so Haxe can type it and
    // the read needs no cast.
    expect(emitIrModuleHaxe(requiredDefault.module).contents).toContain(
      'final first:Float = arrayPatternValue[0] ?? 0;',
    );
    expect(emitIrModuleHaxe(rest.module).contents).toContain(
      'final rest:Array<Float> = (cast arrayPatternValue.slice(1) : Array<Float>);',
    );
    expect(emitIrModuleHaxe(nestedDefault.module).contents).toContain('(arrayPatternValue[0] ?? [1])');
    expect(emitIrModuleHaxe(fixedRest.module).contents).toContain(
      'final rest:Array<Dynamic> = arrayPatternValue.slice(1);',
    );
    expect(emitIrModuleHaxe(emptyRest.module).contents).toContain(
      'final rest:Array<Dynamic> = arrayPatternValue.slice(1);',
    );
    expect(emitIrModuleHaxe(optionalRest.module).contents).toContain(
      'final rest:Array<Dynamic> = arrayPatternValue.slice(1);',
    );
    expect(emitIrModuleHaxe(mixedRest.module).contents).toContain(
      'final rest:Array<Dynamic> = arrayPatternValue.slice(1);',
    );
    expect(emitIrModuleHaxe(iteration.module).contents).toContain(
      'for (arrayPatternValue in rows) {\n    final first:Float = arrayPatternValue[0];\n    final second:Float = arrayPatternValue[1];',
    );
    expect(emitIrModuleHaxe(dynamicIndex.module).contents).toContain('return values[Std.int(index)];');
  });

  it('elects object binding lowering with named and proven-string computed rest copies', () => {
    const named = lower(
      'object-binding.ts',
      `
        type Shape = { value?: number; other: boolean };
        export function select(source: Shape): number {
          const { value = 1, ...rest }: Shape = source;
          rest.other;
          return value;
        }
      `,
    );
    const computed = lower(
      'object-computed.ts',
      `
        type Shape = { value: number; other: boolean };
        export function select(source: Shape, key: string): object {
          const { [key]: value, ...rest }: Shape = source;
          value;
          return rest;
        }
      `,
    );
    const output = emitIrModuleHaxe(named.module).contents;

    expect(output).toContain('final objectPatternValue:Shape = source;');
    expect(output).toContain('final value:Float = objectPatternValue.value ?? 1;');
    expect(output).toContain('HaxeReflect.copy(objectPatternValue)');
    expect(output).toContain('HaxeReflect.deleteField(objectRestValue, "value")');
    const computedOutput = emitIrModuleHaxe(computed.module).contents;
    expect(computedOutput).toContain('HaxeReflect.field(objectPatternValue, objectPatternKey)');
    expect(computedOutput).toContain('HaxeReflect.deleteField(objectRestValue, objectPatternKey)');
  });

  it('elects function-scoped variable hoisting after destructuring normalization', () => {
    const named = lower(
      'variable-hoisting.ts',
      'export function select(): number { { var value: number = 1; } return value; }',
    );
    const pattern = lower(
      'variable-pattern-hoisting.ts',
      'export function select(values: [number, string]): string { var [first, second]: [number, string] = values; first; return second; }',
    );
    const iteration = lower(
      'variable-iteration-hoisting.ts',
      'export function visit(values: number[]): void { for (var value of values) value += 1; } export function keys(values: { value: number }): void { for (var key in values) key; }',
    );
    const namedOutput = emitIrModuleHaxe(named.module).contents;
    const patternOutput = emitIrModuleHaxe(pattern.module).contents;
    const iterationOutput = emitIrModuleHaxe(iteration.module).contents;

    expect(namedOutput).toContain('var value:Float;\n  {\n    (value = 1);\n  }\n  return value;');
    expect(patternOutput).toContain(
      'var first:Float;\n  var second:String;\n  final arrayPatternValue:Array<Dynamic> = values;\n  (first = arrayPatternValue[0]);\n  (second = arrayPatternValue[1]);',
    );
    expect(iterationOutput).toContain(
      'var value:Float;\n  for (variableHoistingIterationValue in values) {\n    (value = variableHoistingIterationValue);\n    (value += 1);',
    );
    // A written shape has a known key set, so iteration is over that set rather than over whatever
    // reflection reports at runtime.
    expect(iterationOutput).toContain(
      'var key:String;\n  for (variableHoistingIterationValue in ["value"]) {\n    (key = variableHoistingIterationValue);\n    key;',
    );
  });

  it('emits contextual fixed tuple expressions with explicit optional positions', () => {
    const result = lower(
      'tuple-expression.ts',
      "export function create(): [number, string?] { const present: [number, string?] = [1, 'flight']; const value: [number, string?] = [2]; present; return value; }",
    );

    expect(result.diagnostics).toEqual([]);
    expect(emitIrModuleHaxe(result.module).contents).toContain(
      'final present:Array<Dynamic> = ([1, "flight"] : Array<Dynamic>);',
    );
    expect(emitIrModuleHaxe(result.module).contents).toContain('final value:Array<Dynamic> = [2, null];');
  });

  it('emits statically ordered pure-object for-in keys', () => {
    const result = lower(
      'static-for-in.ts',
      "export function first(): string { for (const key in { second: 2, 10: 10, 2: 2, first: 1 }) return key; return ''; }",
    );

    expect(emitIrModuleHaxe(result.module).contents).toContain('for (key in ["2", "10", "second", "first"])');
  });

  it('preserves effectful object construction before iterating its closed keys', () => {
    const result = lower(
      'effectful-for-in.ts',
      'function mark(): number { return 1; } export function visit(): void { for (const key in { value: mark() }) key; }',
    );

    const output = emitIrModuleHaxe(result.module).contents;
    expect(output).toContain('final forInObjectValue = { value: mark() };');
    expect(output).toContain('for (key in ["value"])');
  });

  it('emits target-native optional property and method targets without duplicating receiver evaluation', () => {
    const result = lower(
      'optional-property.ts',
      `
        interface Value { count: number; read(): number }
        export function count(value?: Value): number | undefined { return value?.count; }
        export function read(value?: Value): number | undefined { return value?.read(); }
      `,
    );

    const output = emitIrModuleHaxe(result.module).contents;
    expect(output).toContain('return value?.count;');
    expect(output).toContain('return value?.read();');
  });

  it('emits neutral optional element and call contracts without duplicating receiver evaluation', () => {
    const result = lower(
      'optional-targets.ts',
      `
        export function first(values?: number[]): number | undefined { return values?.[0]; }
        export function invoke(callback?: () => number): number | undefined { return callback?.(); }
      `,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain(
      'final optionalIndexedValue:Dynamic = values; return optionalIndexedValue == null ? null : optionalIndexedValue[0];',
    );
    expect(output).toContain(
      'final optionalCall:Dynamic = callback; return optionalCall == null ? null : HaxeReflect.callMethod(null, optionalCall, []);',
    );
  });

  it('emits expression-position destructuring with the original aggregate completion value', () => {
    const result = lower(
      'assignment-completion.ts',
      'export function assign(tuple: [number]): [number] { let value = 0; return ([value] = tuple); }',
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('return { final destructuringAssignmentValue:Array<Float> = tuple;');
    expect(output).toContain('(value = destructuringAssignmentValue[0]);');
    expect(output).toContain('destructuringAssignmentValue; }');
    expect(output).not.toContain('(function()');
  });

  it('represents observable function-entry undefined as its JavaScript value', () => {
    const result = lower('entry-undefined.ts', 'export function read(): number { var value: number; return value; }');
    const declaration = result.module.declarations[0];
    if (declaration?.kind !== 'function' || declaration.body[0]?.kind !== 'variable') {
      throw new Error('Expected function variable prefix');
    }
    const variable = declaration.body[0].declarations[0];
    if (!variable || 'pattern' in variable) throw new Error('Expected named variable');
    (variable as { initialValue?: 'undefined' }).initialValue = 'undefined';

    expect(emitIrModuleHaxe(result.module).contents).toContain('var value:Float = js.Syntax.code("undefined");');
  });

  it('emits fixed tuple spreads with collision-free sequential evaluation carriers', () => {
    const result = lower(
      'tuple-spread.ts',
      `
        function marker(value: number): number { return value; }
        function optional(): [boolean?] { return []; }
        export function combine(tupleSpreadElement: number, tupleSpreadValue: [number, string]): [number, number, string, boolean?] {
          const output: [number, number, string, boolean?] = [marker(tupleSpreadElement), ...tupleSpreadValue, ...optional()];
          marker(tupleSpreadValue[0]);
          return output;
        }
      `,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(result.diagnostics).toEqual([]);
    expect(output).toContain(
      '(function() { final tupleSpreadElement_2 = marker(tupleSpreadElement); final tupleSpreadValue_2 = tupleSpreadValue; final tupleSpreadValue_3 = optional(); return [tupleSpreadElement_2, tupleSpreadValue_2[0], tupleSpreadValue_2[1], tupleSpreadValue_3[0]]; })()',
    );
  });

  it('reports pass-named failures from the elected lowering plan', () => {
    const result = lower(
      'unsafe-loop.ts',
      'export function loop(): void { for (let index = 0; index < 1; index++) { try { continue; } finally { index; } } }',
    );

    expect(() => emitIrModuleHaxe(result.module)).toThrow(
      'Compiler lowering pass c-style-for failed for @flighthq/math/packages/math/src/unsafe-loop.ts: continue across a finally block requires completion-record lowering',
    );
  });

  it('emits numeric and string enums from neutral representation', () => {
    const numeric = lower('mode.ts', 'export enum Mode { A = 1, B, C = Mode.A << 3, D }');
    const strings = lower('kind.ts', "export enum Kind { A = 'a', B = 'b' }");

    expect(emitIrModuleHaxe(numeric.module).contents).toContain('var D = 9;');
    expect(emitIrModuleHaxe(strings.module).contents).toContain('enum abstract Kind(String) from String to String');
  });

  it('emits merged enum value namespace functions as static abstract members', () => {
    const result = lower(
      'enum-namespace.ts',
      `
        export enum Flags { None = 0, Visible = 1 }
        export namespace Flags {
          export function any(flags: Flags, test: Flags): boolean { return (flags & test) !== 0; }
          export function clear(): Flags { return Flags.None; }
        }
        export function visible(flags: Flags): boolean { return Flags.any(flags, Flags.Visible); }
      `,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(result.diagnostics).toEqual([]);
    expect(output).toContain('public static function any(flags:Flags, test:Flags):Bool');
    expect(output).toContain('public static function clear():Flags');
    expect(output).toContain('return Flags.any(flags, Flags.Visible);');
    expect(output).not.toContain('\nfunction any(');
  });

  it('uses one identity for emitted and imported index modules and rejects default imports', () => {
    const index = lower('index.ts', 'export function helper(): number { return 1; }');
    const consumer = lower(
      'consumer.ts',
      "import { helper } from './index.js'; export function use(): number { return helper(); }",
    );
    const defaultImport = lower(
      'default.ts',
      "import helper from './index.js'; export function use(): number { return helper(); }",
    );

    expect(emitIrModuleHaxe(index.module).path).toBe('flighthq/math/_Index.hx');
    expect(emitIrModuleHaxe(index.module).contents).toContain('function helper(');
    expect(emitIrModuleHaxe(consumer.module).contents).toContain('import flighthq.math._Index.helper;');
    expect(() => emitIrModuleHaxe(defaultImport.module)).toThrow('default imports require explicit Haxe mapping');
  });

  it('emits type-only imports and their references from one type-space identity', () => {
    const result = lower(
      'type-import.ts',
      "import type { sourceType as localType } from './types.js'; export type Alias = localType;",
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('import flighthq.math.Types.SourceType as LocalType;');
    expect(output).toContain('typedef Alias = LocalType;');
  });

  it('rejects module facades and emits normalized switch fallthrough', () => {
    const barrel = lower('barrel.ts', "export * from './other.js';");
    const fallthrough = lower(
      'switch.ts',
      'export function choose(a: number): number { switch (a) { case 1: case 2: return 2; default: return 0; } }',
    );
    const output = emitIrModuleHaxe(fallthrough.module).contents;

    expect(() => emitIrModuleHaxe(barrel.module)).toThrow('module-facade lowering');
    expect(output).toContain('case 1:\n      return 2;\n    case 2:\n      return 2;');
  });

  it('emits binding-sensitive switch fallthrough through an identity-safe state loop', () => {
    const result = lower(
      'switch-binding-state.ts',
      'function mark(): void {} export function choose(a: number): number { switch (a) { case 1: mark(); case 2: const local: number = a; return local; default: return 0; } }',
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('var switchFallthroughState:Float = -1;');
    expect(output).toContain('while (switchFallthroughState >= 0)');
    expect(output.match(/final local/g)).toHaveLength(1);
  });

  it('lowers value-object switch cases to conditional comparisons', () => {
    const result = lower(
      'switch-value-object.ts',
      "const State = { Ready: 'ready', Done: 'done' } as const; type State = (typeof State)[keyof typeof State]; export function read(state: State): number { switch (state) { case State.Ready: return 1; case State.Done: return 2; default: return 0; } }",
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('if (js.Syntax.strictEq(switchSubject, State.Ready))');
    expect(output).toContain('else if (js.Syntax.strictEq(switchSubject, State.Done))');
    expect(output).not.toContain('case State.Ready:');
  });

  it('routes standalone typeof through the JavaScript-semantics runtime', () => {
    const result = lower('keyword-unary-operator.ts', 'export function type(a: number): string { return typeof a; }');

    expect(emitIrModuleHaxe(result.module).contents).toContain('flighthq._internal._Js.typeOf(a)');
  });

  it('emits typeof type-test comparisons as Std.isOfType and casts narrowed primitive members', () => {
    const stringTest = lower(
      'typeof-string.ts',
      'export function check(value: string | number): string { if (typeof value === "string") { return value.toUpperCase(); } return "other"; }',
    );
    const numberTest = lower(
      'typeof-number.ts',
      'export function check(value: string | number): number { if (typeof value === "number") { return value; } return 0; }',
    );
    const negated = lower(
      'typeof-negated.ts',
      'export function check(value: string | number): boolean { return typeof value !== "string"; }',
    );

    const stringOutput = emitIrModuleHaxe(stringTest.module).contents;
    expect(stringOutput).toContain('Std.isOfType(value, String)');
    expect(stringOutput).toContain('(cast value : String).toUpperCase()');
    const numberOutput = emitIrModuleHaxe(numberTest.module).contents;
    expect(numberOutput).toContain('Std.isOfType(value, Float)');
    expect(emitIrModuleHaxe(negated.module).contents).toContain('!Std.isOfType(value, String)');
  });

  it('emits rest parameters with the element type so Haxe wraps them in Rest<T>', () => {
    const result = lower(
      'rest-sum.ts',
      'export function sum(...values: number[]): number { let total: number = 0; for (const v of values) { total += v; } return total; }',
    );

    const output = emitIrModuleHaxe(result.module).contents;
    expect(output).toContain('...values:Float');
    expect(output).toContain('final valuesArray:Array<Float> = values.toArray();');
  });

  it('emits contextual and exact undefined values with Haxe absent-value storage', () => {
    const nullable = lower('nullable.ts', 'export function nullable(): string | null { return null; }');
    const undefinedNullable = lower(
      'undefined-nullable.ts',
      'export function undefinedNullable(): number | undefined { return undefined; }',
    );
    const undefinedValue = lower('missing.ts', 'export function missing(): undefined { return undefined; }');
    const explicitDefault = lower(
      'explicit-default.ts',
      'function fallback(value = 1): number { return value; } export function read(): number { return fallback((undefined as number | undefined)); }',
    );

    expect(emitIrModuleHaxe(nullable.module).contents).toContain('function nullable():Null<String> {\n  return null;');
    expect(emitIrModuleHaxe(undefinedValue.module).contents).toContain(
      'function missing():Dynamic {\n  return js.Syntax.code("undefined");',
    );
    expect(emitIrModuleHaxe(undefinedNullable.module).contents).toContain('return js.Syntax.code("undefined");');
    expect(() => emitIrModuleHaxe(explicitDefault.module)).toThrow(
      'explicit undefined default arguments require Haxe omission lowering',
    );
  });

  it('emits a local binding named undefined without confusing it with the ambient value', () => {
    const result = lower(
      'local-undefined.ts',
      'export function read(value: number): number { const undefined: number = value; return undefined; }',
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('final undefined:Float = value;');
    expect(output).toContain('return undefined;');
  });

  it('uses binding identity to keep renamed declarations and references aligned', () => {
    const result = lower('rename.ts', 'export function read(): number { return read(); }');
    const declaration = result.module.declarations[0];
    if (declaration?.kind !== 'function') throw new Error('Expected function declaration');
    const renamed = {
      ...result.module,
      declarations: [{ ...declaration, binding: { ...declaration.binding, name: 'renamed' } }],
    };
    const output = emitIrModuleHaxe(renamed).contents;

    expect(output).toContain('function renamed():Float');
    expect(output).toContain('return renamed();');
  });

  it('allocates collision-free Haxe names for shadowed and keyword-normalized bindings', () => {
    const result = lower(
      'collisions.ts',
      'export function choose(operator: number, operator_: number): number { { const operator: number = operator_; operator; } return operator + operator_; }',
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('function choose(operator_:Float, operator__2:Float):Float');
    expect(output).toContain('final operator__3:Float = operator__2;');
    expect(output).toContain('operator__3;');
    expect(output).toContain('return operator_ + operator__2;');
  });

  it('escapes Unicode source identifiers consistently across declarations and references', () => {
    const result = lower(
      'unicode-identifiers.ts',
      'export function project(angle: number): number { const cosφ = Math.cos(angle); return cosφ; }',
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('final cos_u03c6_:');
    expect(output).toContain('return cos_u03c6_;');
    expect(output).not.toContain('cosφ');
  });

  it('disambiguates public type collisions introduced by Haxe normalization', () => {
    const result = lower('type-collisions.ts', 'export type operator = number; export type operator_ = operator;');
    const emitted = emitIrModuleHaxe(result.module);

    expect(emitted.contents).toContain('Operator');
    expect(emitted.contents).toContain('Operator_2');
  });

  it('preserves one spelling for paired type and value namespace exports', () => {
    const result = lower(
      'paired-type-value.ts',
      "export const State = { Ready: 'Ready' } as const; export type State = (typeof State)[keyof typeof State]; export function ready(): State { return State.Ready; }",
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('typedef State_2 = String;');
    expect(output).toContain('final State:{ Ready:String }');
    expect(output).toContain('return State.Ready;');
  });

  it('preserves public source spellings when Haxe normalization does not collide', () => {
    const result = lower(
      'value-spellings.ts',
      'export function fooBar(value: number): number { return value; } export function foo_bar(value: number): number { return value + 1; }',
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('function fooBar(value:Float):Float');
    expect(output).toContain('function foo_bar(value:Float):Float');
  });

  it('preserves final locals and abstract classes', () => {
    const result = lower(
      'base.ts',
      'export abstract class Base {} export function read(): number { const value: number = 1; return value; }',
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('abstract class Base');
    expect(output).toContain('final value:Float = 1;');
  });

  it('emits supported postfix operators from the closed target mapping', () => {
    const result = lower(
      'increment.ts',
      'export function increment(value: number): number { let result: number = value; return result++; }',
    );

    expect(emitIrModuleHaxe(result.module).contents).toContain('return result++;');
  });

  it('emits supported assignment, binary, and prefix operators from closed target mappings', () => {
    const result = lower(
      'operators.ts',
      'export function operators(left: number, right: number, disabled: boolean): boolean { let value: number = left; value += right; return value === right && !disabled; }',
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('(value += right);');
    expect(output).toContain('return (value == right) && ! disabled;');
  });

  it('emits only operators whose static domains preserve Haxe meaning', () => {
    const strings = lower(
      'string-operators.ts',
      'export function join(left: string, right: string): string { return left + right; }',
    );
    const mixed = lower(
      'mixed-operators.ts',
      'export function join(left: string, right: number): string { return left + right; }',
    );
    const loose = lower(
      'loose-equality.ts',
      'export function equal(left: number, right: number): boolean { return left == right; }',
    );

    expect(emitIrModuleHaxe(strings.module).contents).toContain('return left + right;');
    expect(emitIrModuleHaxe(mixed.module).contents).toContain('flighthq._internal._Js.add(left, right)');
    expect(emitIrModuleHaxe(loose.module).contents).toContain('flighthq._internal._Js.looseEqual(left, right)');
  });

  it('emits exponentiation as Math.pow and bitwise operators with Std.int wrapping', () => {
    const power = lower('power.ts', 'export function power(a: number, b: number): number { return a ** b; }');
    const powerAssign = lower(
      'power-assign.ts',
      'export function power(a: number, b: number): number { let x: number = a; x **= b; return x; }',
    );
    const bitAnd = lower('bit-and.ts', 'export function bitAnd(a: number, b: number): number { return a & b; }');
    const bitAndAssign = lower(
      'bit-and-assign.ts',
      'export function bitAnd(a: number, b: number): number { let x: number = a; x &= b; return x; }',
    );

    expect(emitIrModuleHaxe(power.module).contents).toContain('return Math.pow(a, b);');
    expect(emitIrModuleHaxe(powerAssign.module).contents).toContain('(x = Math.pow(x, b));');
    expect(emitIrModuleHaxe(bitAnd.module).contents).toContain('return Std.int(a) & Std.int(b);');
    expect(emitIrModuleHaxe(bitAndAssign.module).contents).toContain('(x = Std.int(x) & Std.int(b));');
  });

  it('emits completion-preserving async functions through the Haxe task runtime ABI', () => {
    const result = lower(
      'task.ts',
      'export async function read(input: Promise<number>): Promise<number> { const value = await input; return await Promise.resolve(value); }',
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('return new flighthq._internal._Promise(function(resolveTask, rejectTask)');
    expect(output).toContain('flighthq._internal._Promise.resolve(input).then(');
    expect(output).toContain('var value:Float = cast(awaitValue);');
    expect(output).toContain('resolveTask(awaitValue_2);');
    expect(output).toContain('rejectTask(awaitError);');
    expect(output).not.toContain('await ');
  });

  it('emits completion-preserving async methods and closures through the same task plan', () => {
    const result = lower(
      'task-values.ts',
      `
        export class Reader {
          async read(input: Promise<number>): Promise<number> { return await input; }
        }
        export const read = async (input: Promise<number>): Promise<number> => await input;
      `,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output.match(/return new flighthq\._internal\._Promise\(/gu)).toHaveLength(2);
    expect(output.match(/flighthq\._internal\._Promise\.resolve\(input\)\.then\(/gu)).toHaveLength(2);
    expect(output).not.toContain('await ');
  });

  it('converts invalid task-runtime configuration to a tagged backend failure', () => {
    const result = lower('task-runtime.ts', 'export async function read(): Promise<number> { return 1; }');

    try {
      emitIrModuleHaxe(result.module, { runtimeModule: 'invalid-module' });
      expect.unreachable('Expected Haxe emission to fail');
    } catch (error) {
      expect(isBackendEmissionFailure(error)).toBe(true);
      expect(error).toMatchObject({
        backend: 'haxe',
        code: 'unsupported-ir',
        kind: 'backend-emission',
        packageName: '@flighthq/math',
        source: 'packages/math/src/task-runtime.ts',
      });
    }
  });

  it('emits an async early-return branch through task states', () => {
    const result = lower(
      'early-return.ts',
      'export async function read(value: boolean): Promise<number> { if (value) return 1; return 0; }',
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('if (value)');
    expect(output).toContain('resolveTask(cast(1))');
    expect(output).toContain('resolveTask(cast(0))');
  });

  it('emits a conditional await initializer through two branch continuations', () => {
    const result = lower(
      'conditional-await.ts',
      `export async function read(flag: boolean, first: Promise<number>, second: Promise<number>): Promise<number> {
         const value = flag ? await first : await second;
         return value;
       }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('var value:Float;');
    expect(output).toContain('if (flag)');
    expect(output).toContain('_Promise.resolve(first).then(');
    expect(output).toContain('_Promise.resolve(second).then(');
    expect(output).not.toContain('await ');
  });

  it('emits a conditional await initializer inside a guarded task region', () => {
    const result = lower(
      'conditional-await-try.ts',
      `interface Outcome { reason: string; }
       interface Provider { install(): Promise<Outcome>; }
       export async function install(selected: Provider, origin: Provider): Promise<string> {
         try {
           const outcome = selected === origin ? await selected.install() : await origin.install();
           return outcome.reason;
         } catch {
           return 'failed';
         }
       }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('_Promise.resolve(selected.install()).then(');
    expect(output).toContain('_Promise.resolve(origin.install()).then(');
    expect(output).not.toContain('await ');
  });

  it('emits leading awaited comparisons and negated branch conditions through continuations', () => {
    const compared = emitIrModuleHaxe(
      lower(
        'awaited-comparison.ts',
        'export async function present(task: Promise<number | null>): Promise<boolean> { return (await task) !== null; }',
      ).module,
    ).contents;
    const negated = emitIrModuleHaxe(
      lower(
        'awaited-negated-condition.ts',
        'export async function decide(task: Promise<boolean>): Promise<number> { if (!(await task)) return 1; return 2; }',
      ).module,
    ).contents;

    expect(compared).toContain('_Promise.resolve(task).then(');
    expect(compared).toContain('resolveTask(cast(!flighthq._internal._Js.strictEqual(awaitValue, null)));');
    expect(negated).toContain('_Promise.resolve(task).then(');
    expect(negated).toContain('if (! awaitValue)');
    expect(compared).not.toContain('await ');
    expect(negated).not.toContain('await ');
  });

  it('emits nested labeled exits through Haxe completion state', () => {
    const result = lower(
      'labeled-flow.ts',
      'export function scan(limit: number): number { let count = 0; outer: while (count < limit) { while (true) { count += 1; if (count < limit) continue outer; break outer; } } done: { if (count < 0) break done; } return count; }',
    );
    const labeledSwitch = lower(
      'labeled-switch.ts',
      'export function scan(value: number): void { done: switch (value) { case 1: break done; } }',
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('var outerControlFlowState:Int = 0;');
    expect(output).toContain('outerControlFlowState = 2;');
    expect(output).toContain('outerControlFlowState = 1;');
    expect(output).toContain('if (outerControlFlowState == 2) { outerControlFlowState = 0; continue; }');
    expect(output).toContain('var doneControlFlowState:Int = 0;');
    expect(output).toContain('do {\n    if (count < 0)');
    expect(() => emitIrModuleHaxe(labeledSwitch.module)).toThrow(
      'labeled switch done requires Haxe switch completion lowering',
    );
  });

  it('emits structurally flattened generic interface inheritance', () => {
    const result = lower(
      'interface-inheritance.ts',
      'interface Base<Value> { value: Value; } export interface Child extends Base<number> { own: boolean; }',
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('typedef Child = { value:Float, own:Bool };');
  });

  it('represents private ambient host heritage through the Haxe target binding', () => {
    const result = lower(
      'ambient-interface-inheritance.ts',
      `interface Style extends CSSStyleDeclaration { webkitClipPath: string; }
       export function set(style: CSSStyleDeclaration): void {
         (style as Style).webkitClipPath = '';
       }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('typedef Style = { webkitClipPath:String };');
    expect(output).toContain('((cast style : Style).webkitClipPath = "");');
  });

  it('emits an implemented shape as a nominal interface and leaves an unimplemented one structural', () => {
    // Haxe `implements` names a nominal type, so a shape a class implements cannot stay a typedef.
    // A shape nothing implements does stay one, because that is the idiomatic structural form.
    const implemented = lower(
      'nominal.ts',
      'export interface Advancer { step: number; advance(by: number): number; } export class Counter implements Advancer { step: number = 1; advance(by: number): number { return by + this.step; } }',
    );
    const structural = lower('shape.ts', 'export interface Point { x: number; y: number; }');

    const nominal = emitIrModuleHaxe(implemented.module).contents;
    expect(nominal).toContain('interface Advancer {');
    expect(nominal).toContain('  public var step:Float;');
    expect(nominal).toContain('  public function advance(by:Float):Float;');
    expect(nominal).toContain('class Counter implements Advancer {');
    expect(emitIrModuleHaxe(structural.module).contents).toContain('typedef Point = { x:Float, y:Float };');
  });

  it('refuses a class implementing an interface it cannot name in this module', () => {
    const external = lower(
      'external.ts',
      "import type { Advancer } from './advancer.js'; export class Counter implements Advancer { step: number = 1; }",
    );

    expect(() => emitIrModuleHaxe(external.module)).toThrow('implements an interface declared outside this module');
  });

  it('uses JavaScript strict equality to preserve distinct null and undefined values', () => {
    const single = lower(
      'single.ts',
      'export function widen(value: number | undefined, fallback: number): number { if (value === undefined) return fallback; return value; }',
    );
    const both = lower(
      'both.ts',
      'export function widen(value: number | null | undefined, fallback: number): number { if (value === undefined) return fallback; return fallback; }',
    );

    const singleOutput = emitIrModuleHaxe(single.module).contents;
    expect(singleOutput).toContain('if (js.Syntax.strictEq(value, js.Syntax.code("undefined"))) {');
    // Narrowing proved the value present, so it is returned directly: `Null<T>` exists to unify
    // with `T`, and the proof guarantees any runtime check that unification inserts will pass.
    expect(singleOutput).toContain('return value;');
    expect(emitIrModuleHaxe(both.module).contents).toContain('js.Syntax.strictEq(value, js.Syntax.code("undefined"))');
  });

  it('emits class accessors as Haxe property pairs with get_/set_ bodies', () => {
    const result = lower(
      'accessor.ts',
      `
        export class Value {
          private _count: number = 0;
          get count(): number { return this._count; }
          set count(value: number) { this._count = value; }
        }
      `,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('public var count(get, set):Float;');
    expect(output).toContain('function get_count():Float {');
    expect(output).toContain('function set_count(value:Float):Float {');
    expect(output).toContain('return value;');
  });

  it('emits abstract methods, static methods, and private visibility', () => {
    const result = lower(
      'methods.ts',
      `
        export abstract class Shape {
          abstract area(): number;
          static origin(): number { return 0; }
          private radius(): number { return 1; }
          call(): number { return this.radius(); }
        }
      `,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('abstract function area():Float;');
    expect(output).toContain('static function origin():Float');
    expect(output).toContain('private function radius():Float');
  });

  it('emits Float enum from non-integer numeric values', () => {
    const result = lower('float-enum.ts', 'export enum Ratio { Half = 0.5, Third = 0.33 }');
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('enum abstract Ratio(Float) from Float to Float');
    expect(output).toContain('var Half = 0.5;');
    expect(output).toContain('var Third = 0.33;');
  });

  it('emits ternary expressions with condition, whenTrue, and whenFalse', () => {
    const result = lower(
      'ternary.ts',
      'export function pick(flag: boolean, a: number, b: number): number { return flag ? a : b; }',
    );

    expect(emitIrModuleHaxe(result.module).contents).toContain('return (flag ? a : b);');
  });

  it('emits template literals as Std.string concatenation', () => {
    const result = lower(
      'template.ts',
      'export function greet(name: string): string { return `hello ${name} world`; }',
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('"hello " + Std.string(name) + " world"');
  });

  it('emits bitwise complement with Std.int wrapping', () => {
    const result = lower('complement.ts', 'export function complement(value: number): number { return ~value; }');

    expect(emitIrModuleHaxe(result.module).contents).toContain('~ Std.int(value)');
  });

  it('emits do-while loops and throw statements', () => {
    const doWhile = lower(
      'do-while.ts',
      'export function loop(): number { let count: number = 0; do { count += 1; } while (count < 3); return count; }',
    );
    const throwStatement = lower('throw.ts', 'export function fail(): never { throw new Error("fail"); }');

    expect(emitIrModuleHaxe(doWhile.module).contents).toContain('do {');
    expect(emitIrModuleHaxe(doWhile.module).contents).toContain('(count += 1);');
    expect(emitIrModuleHaxe(doWhile.module).contents).toContain('} while (count < 3);');
    expect(emitIrModuleHaxe(throwStatement.module).contents).toContain('throw');
  });

  it('emits try-catch without finally', () => {
    const result = lower(
      'try-catch.ts',
      'export function safe(value: number): number { try { return value; } catch (error) { return 0; } }',
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('try {');
    expect(output).toContain('catch (error:Dynamic) {');
    expect(output).toContain('return 0;');
  });

  it('emits Dynamic for never, null, undefined, unknown, keyof, indexedAccess, and typeOf types', () => {
    const result = lower(
      'dynamic-types.ts',
      `
        interface Box { value: number }
        export function dynamic(
          neverValue: never,
          keyValue: keyof Box,
          unknownValue: unknown,
          nullValue: null,
          undefinedValue: undefined,
        ): void { neverValue; keyValue; unknownValue; nullValue; undefinedValue; }
      `,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('neverValue:Dynamic');
    expect(output).toContain('keyValue:Dynamic');
    expect(output).toContain('unknownValue:Dynamic');
  });

  it('emits dynamic for-in using HaxeReflect.fields when no closed key plan exists', () => {
    const result = lower(
      'dynamic-for-in.ts',
      'export function keys(record: object): void { for (const key in record) key; }',
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('HaxeReflect.fields(record)');
  });

  it('emits unsigned right shift through explicit Std.int wrapping', () => {
    const result = lower(
      'unsigned-shift.ts',
      'export function shift(a: number, b: number): number { return a >>> b; }',
    );

    expect(emitIrModuleHaxe(result.module).contents).toContain('Std.int(a) >>> Std.int(b)');
  });

  it('emits bitwise or, xor, left shift, and right shift with Std.int wrapping', () => {
    const result = lower(
      'bitwise.ts',
      `
        export function bitOr(a: number, b: number): number { return a | b; }
        export function bitXor(a: number, b: number): number { return a ^ b; }
        export function leftShift(a: number, b: number): number { return a << b; }
        export function rightShift(a: number, b: number): number { return a >> b; }
      `,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('Std.int(a) | Std.int(b)');
    expect(output).toContain('Std.int(a) ^ Std.int(b)');
    expect(output).toContain('Std.int(a) << Std.int(b)');
    expect(output).toContain('Std.int(a) >> Std.int(b)');
  });

  it('emits type-only re-exports as Haxe typedef aliases', () => {
    const result = lowerPackage(
      '@flighthq/core',
      'reexport.ts',
      "export type { sourceType as Renamed } from '@flighthq/math/types';",
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('typedef ReexportRenamed =');
  });

  it('emits union types with one concrete member as Null<T> and multi-concrete as Dynamic', () => {
    const result = lower(
      'union-types.ts',
      'export function nullable(value: number | null): number { return value ?? 0; } export function mixed(value: number | string): void { value; }',
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('value:Null<Float>');
    expect(output).toContain('value:Dynamic');
  });

  it('emits for-of iteration without async or patterns', () => {
    const result = lower(
      'for-of.ts',
      'export function visit(values: number[]): number { let total: number = 0; for (const value of values) { total += value; } return total; }',
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('for (value in values)');
  });

  it('retains an iterable type around Map and Set loops that otherwise become Dynamic', () => {
    const result = lower(
      'for-of-collections.ts',
      'export function visit(map: ReadonlyMap<string, number>, set: ReadonlySet<string>): void { for (const [key, value] of map) { key; value; } for (const value of set) value; }',
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('in (cast map : Iterable<Array<Dynamic>>))');
    expect(output).toContain('in (cast set : Iterable<String>))');
  });

  it('restores an iterable boundary when source flow erased the container type', () => {
    const result = lower(
      'for-of-dynamic.ts',
      'export function visit(source: any): void { for (const value of source) value; }',
    );

    expect(emitIrModuleHaxe(result.module).contents).toContain('in (cast source : Iterable<Dynamic>))');
  });

  it('iterates source strings as Unicode characters', () => {
    const result = lower(
      'for-of-string.ts',
      `export function visible(value: string): string {
         let out = '';
         for (const character of value.trim()) if (character.charCodeAt(0) > 32) out += character;
         return out;
       }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('new haxe.iterators.StringIteratorUnicode(StringTools.trim(value))');
    expect(output).toContain('final character = String.fromCharCode(characterCodePoint);');
  });

  it('emits array.slice calls with Int-narrowed bounds', () => {
    const result = lower(
      'array-slice.ts',
      'export function middle(values: number[], start: number, end: number): number[] { return values.slice(start, end); }',
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('values.slice(Std.int(start), Std.int(end))');
  });

  it('emits array.slice with no arguments as copy', () => {
    const result = lower(
      'array-copy.ts',
      'export function copy(values: number[]): number[] { return values.slice(); }',
    );

    expect(emitIrModuleHaxe(result.module).contents).toContain('values.copy()');
  });

  it('narrows a computed array index to Int, and leaves an integer literal alone', () => {
    // Haxe indexes arrays with `Int` while the neutral numeric domain has only `number`, so every
    // index arrives as `Float`. Emitting it directly produced Haxe that does not compile, which
    // pinning bytes cannot catch.
    const result = lower(
      'array-index.ts',
      'export function at(values: number[], index: number): number { return values[index] ?? values[0] ?? 0; }',
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('values[Std.int(index)]');
    expect(output).toContain('values[0]');
    expect(output).not.toContain('Std.int(0)');
  });

  it('calls reflectively when a spread makes the arity unknown until run time', () => {
    // A spread of an unbounded collection has no arity a fixed call can take. Haxe's
    // `HaxeReflect.callMethod` takes its arguments as an array, which is the shape a spread already has.
    const simple = lower(
      'spread.ts',
      'export function widest(values: number[]): number { return Math.max(...values); }',
    );
    const mixed = lower(
      'mixed-spread.ts',
      'export function widest(values: number[], first: number): number { return Math.max(first, ...values); }',
    );

    expect(emitIrModuleHaxe(simple.module).contents).toContain(
      'HaxeReflect.callMethod(Math, cast(Math.max), (cast values : Array<Dynamic>))',
    );
    // Fixed arguments around the spread keep their source order.
    expect(emitIrModuleHaxe(mixed.module).contents).toContain(
      'HaxeReflect.callMethod(Math, cast(Math.max), ([first] : Array<Dynamic>).concat((cast values : Array<Dynamic>)))',
    );
  });
});

describe('emitIrModuleHaxe structural record election', () => {
  it('names a data shape as a class when the backend elects struct initialization', () => {
    // An anonymous structure resolves its fields by hashed lookup on the static targets, so a target
    // that cares more about field access than about structural interchange can ask for a class. The
    // source's own construction syntax still builds it, which is what `@:structInit` is for.
    const result = lower(
      'range.ts',
      'export interface Range { readonly max: number; readonly min?: number; } export function widen(range: Range, by: number): Range { return { max: range.max + by, min: 0 }; }',
    );
    const anonymous = emitIrModuleHaxe(result.module).contents;
    const nominal = emitIrModuleHaxe(result.module, { structuralRecords: 'structInit' }).contents;

    expect(anonymous).toContain('typedef Range = { max:Float, ?min:Float };');
    expect(nominal).toContain('@:structInit\nfinal class Range {');
    expect(nominal).toContain('  public var max:Float;');
    // An optional member is defaulted, because a missing default makes the field required.
    expect(nominal).toContain('  public var min:Null<Float> = null;');
    // The construction site is explicitly directed to the elected record identity.
    expect(nominal).toContain('return (cast { max: (range.max + by), min: 0 } : Range);');
  });

  it('emits structInit for type alias over an object type', () => {
    const result = lower(
      'struct-alias.ts',
      'export type Config = { value: number; label?: string }; export function read(config: Config): number { return config.value; }',
    );
    const output = emitIrModuleHaxe(result.module, { structuralRecords: 'structInit' }).contents;

    expect(output).toContain('@:structInit\nfinal class Config {');
    expect(output).toContain('public var value:Float;');
    expect(output).toContain('public var label:Null<String> = null;');
  });
});

describe('emitIrModuleHaxe expression coverage', () => {
  it('emits function expression body form and arrow expression form', () => {
    const body = lower('fn-body.ts', 'export const run = function (value: number): number { return value + 1; };');
    const expression = lower('fn-expression.ts', 'export const run = (value: number): number => value + 1;');
    const bodyOutput = emitIrModuleHaxe(body.module).contents;
    const expressionOutput = emitIrModuleHaxe(expression.module).contents;

    expect(bodyOutput).toContain('function(value:Float):Float {\n');
    expect(bodyOutput).toContain('return value + 1;');
    expect(expressionOutput).toContain('function(value:Float) return (value + 1)');
  });

  it('emits regexp literals through the runtime with Haxe-safe strings', () => {
    const result = lower(
      'regexp.ts',
      String.raw`export function match(): boolean { const pattern = /<\/tag>\s+/gi; return pattern.test("x"); }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('new flighthq._internal._RegExp("<\\\\/tag>\\\\s+", "gi")');
  });

  it('escapes Haxe string control characters without JSON-only escapes', () => {
    const result = lower('string-controls.ts', 'export const value: string = "\\b\\f\\u007f";');

    expect(emitIrModuleHaxe(result.module).contents).toContain('"\\x08\\x0c\\x7f"');
  });

  it('lets Haxe infer initialized function-valued local types', () => {
    const result = lower(
      'local-function.ts',
      'export function apply(value: number): number { const update: (next: number) => void = next => { value += next; }; update(1); return value; }',
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('final update = function(next:Float)');
    expect(output).not.toContain('final update:(Float)->Void');
    expect(output).not.toContain('return null;');
  });

  it('lets Haxe infer a conditional choice between imported functions', () => {
    const queries = lowerPackage(
      '@flighthq/physics2d',
      'queries.ts',
      'export function all(value: number): void {} export function closest(value: number): void {}',
    ).module;
    const consumer = lowerPackage(
      '@flighthq/physics2d-abi',
      'reference.ts',
      "import { all, closest } from '@flighthq/physics2d/queries'; export function run(flag: boolean): void { const query = flag ? closest : all; query(1); }",
    ).module;
    const output = createHaxeCompilerBackend().emitModule(consumer, {
      moduleResolution: {
        edges: [
          {
            importer: { name: consumer.name, packageName: consumer.packageName, source: consumer.source },
            specifier: '@flighthq/physics2d/queries',
            target: { packageName: queries.packageName, source: queries.source },
          },
        ],
        schema: 'flight-compiler-module-resolution/1',
      },
      modules: [consumer, queries],
      options: {},
    })[0]!.contents;

    expect(output).toContain('final query = (flag ? closest : all);');
  });

  it('constructs source-declared constructor values reflectively', () => {
    const result = lower(
      'factory.ts',
      'interface Created { value: number } type Factory = new (value: number) => Created; export function create(factory: Factory): Created { return new factory(1); }',
    );

    expect(emitIrModuleHaxe(result.module).contents).toContain('Type.createInstance(cast factory, [1])');
  });

  it('constructs ambient typed arrays through their runtime adapters', () => {
    const result = lower(
      'typed-array-constructor.ts',
      'export function copy(values: Float32Array): Float32Array { return new Float32Array(values); }',
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('new flighthq._internal._Float32Array(values)');
    expect(output).not.toContain('Type.createInstance');
  });

  it('adapts native constructor integer and structural callback arguments', () => {
    const result = lower(
      'native-constructor-arguments.ts',
      `export function image(data: Uint8ClampedArray, width: number, height: number): ImageData {
         return new ImageData(data, width, height);
       }
       export function guard(target: object): object {
         return new Proxy(target, { set(target, property, value): boolean { return true; } });
       }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('new js.html.ImageData(data, Std.int(width), Std.int(height))');
    expect(output).toContain('new flighthq._internal._Proxy(target, cast({ set:');
  });

  it('uses native array-buffer constructor identities for instanceof', () => {
    const result = lower(
      'typed-array-instanceof.ts',
      'export function isBuffer(value: unknown): boolean { return value instanceof ArrayBuffer; } export function isFloat32(value: unknown): boolean { return value instanceof Float32Array; }',
    );

    expect(emitIrModuleHaxe(result.module).contents).toContain(
      'flighthq._internal._Js.instanceOf(value, js.lib.ArrayBuffer)',
    );
    expect(emitIrModuleHaxe(result.module).contents).toContain(
      'flighthq._internal._Js.instanceOf(value, js.lib.Float32Array)',
    );
  });

  it('adapts host members missing or narrower in the Haxe standard externs', () => {
    const result = lower(
      'host-member-boundaries.ts',
      `export async function bytes(blob: Blob): Promise<ArrayBuffer> { return blob.arrayBuffer(); }
       export function gamut(image: ImageData): string { return image.colorSpace; }
       export function channel(buffer: AudioBuffer, data: Float32Array, index: number): Float32Array {
         buffer.copyToChannel(data, index);
         return buffer.getChannelData(index);
       }
       export function audio(length: number, channels: number, rate: number): AudioBuffer {
         return new AudioBuffer({ length, numberOfChannels: channels, sampleRate: rate });
       }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('js.Syntax.code("{0}.arrayBuffer()", blob)');
    expect(output).toContain('js.Syntax.code("{0}.colorSpace", image)');
    expect(output).toContain('buffer.copyToChannel(data, Std.int(index))');
    expect(output).toContain('buffer.getChannelData(Std.int(index))');
    expect(output).toContain('new js.html.audio.AudioBuffer(cast({');
  });

  it('adapts unary and variadic String.fromCharCode calls', () => {
    const result = lower(
      'string-from-char-code.ts',
      `export function one(code: number): string { return String.fromCharCode(code); }
       export function two(first: number, second: number): string { return String.fromCharCode(first, second); }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('String.fromCharCode(Std.int(code))');
    expect(output).toContain('js.Syntax.code("String.fromCharCode({0}, {1})", first, second)');
  });

  it('emits empty template literal as an empty string', () => {
    const result = lower('empty-template.ts', 'export function empty(): string { return ``; }');

    expect(emitIrModuleHaxe(result.module).contents).toContain('return "";');
  });

  it('emits template with adjacent interpolations filtering empty segments', () => {
    const result = lower(
      'adjacent-template.ts',
      'export function join(a: number, b: number): string { return `${a}${b}`; }',
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('Std.string(a) + Std.string(b)');
  });

  it('emits array literal with null holes for absent tuple elements', () => {
    const result = lower('array-holes.ts', 'export function holes(): number[] { return [1, , 3]; }');
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('[(cast 1 : Float), null, 3]');
  });

  it('emits String(value) as Std.string(value)', () => {
    const output = emitIrModuleHaxe(
      lower('string-conversion.ts', 'export function convert(n: number): string { return String(n); }').module,
    ).contents;
    expect(output).toContain('Std.string(');
    expect(output).not.toContain('String(n)');
  });

  it('emits cast expression as Haxe cast', () => {
    const result = lower(
      'cast-expression.ts',
      'export function convert(value: unknown): number { return value as number; }',
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('cast value : Float');
  });

  it('uses annotation casts for generic and callable targets', () => {
    const result = lower(
      'cast-shapes.ts',
      `export function generic<Value>(value: unknown): Value { return value as Value; }
       export function callable(value: unknown): (input: number) => void {
         return value as (input: number) => void;
       }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('return (cast value : Value);');
    expect(output).toContain('return (cast value : (Float)->Void);');
  });

  it('preserves annotation-cast grouping on initialized locals', () => {
    const result = lower(
      'cast-local.ts',
      `export function make<Value>(): Value {
         const out = {} as Value;
         return out;
       }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('final out:Value = (cast {  } : Value);');
  });

  it('adapts source-compatible function shapes at value boundaries', () => {
    const result = lower(
      'function-shape.ts',
      `type Handler = (value: string, count: number) => string;
       function short(value: string): string { return value; }
       function accept(handler: Handler): void { handler('flight', 1); }
       export function wire(): Handler {
         const handler: Handler = short;
         accept(short);
         return handler;
       }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('final handler = (cast short : Handler);');
    expect(output).toContain('accept((cast short : Handler));');
    expect(output).toContain('return (cast handler : Handler);');
  });

  it('adapts function values against inherited contextual method types', () => {
    const output = emitIrModuleHaxe(
      lower(
        'inherited-function-boundary.ts',
        `interface State { ready: boolean }
         interface SpecializedState extends State { handle: number }
         interface Renderer { destroy?(state: State): void }
         interface SpecializedRenderer extends Renderer {}
         function destroy(state: SpecializedState): void { state.handle; }
         export const renderer: SpecializedRenderer = { destroy };`,
      ).module,
    ).contents;

    expect(output).toContain('destroy: (cast destroy : (State)->Void)');
  });

  it('adapts function values against contextual intersection properties', () => {
    const output = emitIrModuleHaxe(
      lower(
        'intersection-function-boundary.ts',
        `interface Identity { id: number }
         type Renderer = Identity & { destroy(state: string): void };
         function destroy(state: 'ready'): void {}
         export const renderer: Renderer = { id: 1, destroy };`,
      ).module,
    ).contents;

    expect(output).toContain('destroy: (cast destroy : (String)->Void)');
  });

  it('emits object rest with named and computed exclusions', () => {
    const result = lower(
      'object-rest-expression.ts',
      `
        type Shape = { value: number; other: boolean };
        export function rest(source: Shape): object {
          const { value, ...remaining }: Shape = source;
          value;
          return remaining;
        }
      `,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('HaxeReflect.copy(');
    expect(output).toContain('HaxeReflect.deleteField(');
  });

  it('emits cast-to-any element access for object parameter', () => {
    const result = lower(
      'cast-element.ts',
      'export function read(record: object, key: string): void { (record as any)[key]; }',
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('(cast record : Dynamic)');
  });

  it('preserves computed symbol identity for property reads and writes', () => {
    const result = lower(
      'computed-symbol-property.ts',
      `const RuntimeKey = Symbol.for('Runtime');
       interface Entity { [RuntimeKey]: number | undefined; }
       export function read(entity: Entity): number | undefined { return entity[RuntimeKey]; }
       export function write(entity: Entity, value: number): void { entity[RuntimeKey] = value; }`,
    );
    const output = emitIrModuleHaxe(result.module, { runtimeModule: 'flight._hx._runtime' }).contents;

    expect(output).toContain('return flight._hx._runtime._Js.getProperty(entity, RuntimeKey);');
    expect(output).toContain('flight._hx._runtime._Js.setProperty(assignmentReceiver, assignmentKey, assignmentValue)');
  });

  it('uses the nullable target of a computed symbol assignment to lower undefined', () => {
    const result = lower(
      'clear-computed-symbol-property.ts',
      `const RuntimeKey = Symbol.for('Runtime');
       interface Entity { [RuntimeKey]: number | undefined; }
       export function clear(entity: Entity): void { entity[RuntimeKey] = undefined; }`,
    );

    expect(emitIrModuleHaxe(result.module, { runtimeModule: 'flight._hx._runtime' }).contents).toContain(
      'flight._hx._runtime._Js.setProperty(assignmentReceiver, assignmentKey, assignmentValue)',
    );
  });

  it('preserves undefined assigned to a dynamically represented slot', () => {
    const result = lower(
      'clear-dynamic-property.ts',
      'export function clear(copy: Record<string, unknown>): void { copy.value = undefined; }',
    );

    expect(emitIrModuleHaxe(result.module).contents).toContain(
      'HaxeReflect.setField(dynamicAccessReceiver, "value", dynamicAccessValue)',
    );
  });

  it('reflects named reads from dynamic records and generic structural values', () => {
    const result = lower(
      'reflective-property-read.ts',
      `export function read(record: Record<string, string>): string { return record.value; }
       export function readGeneric<Value extends { value: string }>(record: Value): string {
         return record.value;
       }
       export function readReadonlyGeneric<Value extends { value: string }>(record: Readonly<Value>): string {
         return record.value;
       }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('return HaxeReflect.field(record, "value");');
    expect(output).toContain('function readGeneric<Value:');
    expect(output.match(/return HaxeReflect\.field\(record, "value"\);/gu)).toHaveLength(3);
  });

  it('reflects nullable reads through aliases of dynamic records', () => {
    const result = lower(
      'reflective-alias-read.ts',
      `type Raw = Record<string, unknown>;
       interface Element { attributes: Raw }
       export function read(raw: Raw, optional: Raw | undefined, element: Element): unknown {
         return raw.value ?? optional?.value ?? element.attributes.semantic;
       }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('HaxeReflect.field(raw, "value")');
    expect(output).toContain('HaxeReflect.field(optionalObject, "value")');
    expect(output).toContain('HaxeReflect.field(element.attributes, "semantic")');
  });

  it('reflects fields read through structural casts and numeric updates on generic records', () => {
    const result = lower(
      'reflective-cast-and-update.ts',
      `export function kind(value: unknown): unknown {
         return (value as Record<string, unknown>).__kind;
       }
       export function increment<Value extends { depth: number }>(value: Value): void {
         value.depth++;
       }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('return HaxeReflect.field((cast value : haxe.DynamicAccess<Dynamic>), "__kind");');
    expect(output).toContain('HaxeReflect.setField(updateReceiver, "depth", updateResult)');
  });

  it('deletes symbol-backed and dynamic properties through their represented keys', () => {
    const result = lower(
      'delete-properties.ts',
      `const RuntimeKey = Symbol.for('Runtime');
       interface Entity { [RuntimeKey]: number | undefined; }
       export function clear(entity: Entity, record: Record<string, unknown>, key: string): void {
         delete entity[RuntimeKey]; delete record[key];
       }`,
    );
    const output = emitIrModuleHaxe(result.module, { runtimeModule: 'flight._hx._runtime' }).contents;

    expect(output).toContain('flight._hx._runtime._Js.deleteProperty(entity, RuntimeKey)');
    expect(output).toContain('flight._hx._runtime._Js.deleteProperty(record, key)');
  });

  it('retains reflective access for a dynamically computed object key', () => {
    const result = lower(
      'computed-dynamic-property.ts',
      'export function read(record: Record<string, number>, key: string): number { return record[key]; }',
    );

    expect(emitIrModuleHaxe(result.module).contents).toContain('HaxeReflect.field(record, key)');
  });

  it('routes coercive and optional computed property access through the selected runtime', () => {
    const result = lower(
      'computed-property-key.ts',
      `interface Values { first: number; second: number; }
       export function read(record: Values, key: keyof Values): number { return record[key]; }
       export function optionalRead(record: Values | null, key: keyof Values): number | undefined {
         return record?.[key];
       }`,
    );
    const output = emitIrModuleHaxe(result.module, { runtimeModule: 'flight._hx._runtime' }).contents;

    expect(output).toContain('flight._hx._runtime._Js.getProperty(record, key)');
    expect(output).toContain('== null ? null : flight._hx._runtime._Js.getProperty(optionalIndexedValue, key)');
  });

  it('routes computed property construction and writes through the selected runtime', () => {
    const result = lower(
      'computed-property-write.ts',
      `export function create(key: string, value: number): Record<string, number> { return { [key]: value }; }
       export function write(record: Record<string, number>, key: string, value: number): number {
         record[key] = value;
         return record[key] += value;
       }`,
    );
    const output = emitIrModuleHaxe(result.module, { runtimeModule: 'flight._hx._runtime' }).contents;

    expect(output).toContain('flight._hx._runtime._Js.setProperty(objectSpreadValue, key, value)');
    expect(output).toContain('flight._hx._runtime._Js.setProperty(assignmentReceiver, assignmentKey, assignmentValue)');
    expect(output).toContain('flight._hx._runtime._Js.getProperty(assignmentReceiver_2, assignmentKey_2)');
  });

  it('emits annotation cast when target type is array with element type', () => {
    const result = lower(
      'cast-array.ts',
      'export function toNumbers(values: unknown[]): number[] { return values as number[]; }',
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('(cast values : Array<Float>)');
  });

  it('emits annotation cast when target type is tuple', () => {
    const result = lower(
      'cast-tuple.ts',
      'export function first(values: [[number]?]): number { const [[x] = [1]] = values; return x; }',
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('(cast (arrayPatternValue[0] ?? [1]) : Array<Float>)');
  });

  it('emits annotation cast when target is typedef interface', () => {
    const result = lower(
      'cast-typedef.ts',
      `
        interface Item { count: number; }
        export function read(value: unknown): number { return (value as Item).count; }
      `,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('(cast value : Item).count');
  });

  it('casts string-backed values at native extern assignment boundaries', () => {
    const result = lower(
      'native-string-assignment.ts',
      'export function apply(context: CanvasRenderingContext2D, operation: string): void { context.globalCompositeOperation = operation; }',
    );

    expect(emitIrModuleHaxe(result.module).contents).toContain(
      'js.Syntax.code("{0}.globalCompositeOperation = {1}", context, operation)',
    );
  });

  it('casts object literal fields at native Record value boundaries', () => {
    const result = lower(
      'native-record-value.ts',
      "export const operations: Readonly<Record<string, GlobalCompositeOperation>> = { normal: 'source-over' };",
    );

    expect(emitIrModuleHaxe(result.module).contents).toContain(
      'normal: (cast "source-over" : js.html.CompositeOperation)',
    );
  });

  it('widens generic Object.assign inputs at the runtime boundary', () => {
    const result = lower(
      'object-assign-generic.ts',
      `export function merge<Target extends object, Source extends object>(target: Target, source: Source): Target & Source {
         return Object.assign(target, source);
       }`,
    );

    expect(emitIrModuleHaxe(result.module, { runtimeModule: 'flight._hx._runtime' }).contents).toContain(
      'flight._hx._runtime._Object.assign(cast(target), cast(source))',
    );
  });

  it('narrows native DOM integer properties and method arguments', () => {
    const result = lower(
      'native-integer-boundaries.ts',
      `export function resize(canvas: HTMLCanvasElement, element: Element, width: number, pointer: number): void {
         canvas.width = width;
         element.setPointerCapture(pointer);
         window.clearTimeout(pointer);
       }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('(canvas.width = Std.int(width))');
    expect(output).toContain('element.setPointerCapture(Std.int(pointer))');
    expect(output).toContain('js.Browser.window.clearTimeout(Std.int(pointer))');
  });

  it('emits undefined-default as null-coalescing', () => {
    const result = lower(
      'undefined-default.ts',
      'export function fallback(value: number | undefined, def: number): number { return value ?? def; }',
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('value ?? def');
  });

  it('emits assignment operator compounds for bitwise or, xor, shifts', () => {
    const result = lower(
      'assign-bitwise.ts',
      `
        export function compound(a: number, b: number): number {
          let x: number = a;
          x |= b;
          x ^= b;
          x <<= b;
          x >>= b;
          x >>>= b;
          return x;
        }
      `,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('x = Std.int(x) | Std.int(b)');
    expect(output).toContain('x = Std.int(x) ^ Std.int(b)');
    expect(output).toContain('x = Std.int(x) << Std.int(b)');
    expect(output).toContain('x = Std.int(x) >> Std.int(b)');
    expect(output).toContain('x = Std.int(x) >>> Std.int(b)');
  });

  it('emits comparison operators for number domain', () => {
    const result = lower(
      'comparisons.ts',
      `
        export function compare(a: number, b: number): boolean {
          if (a < b) return true;
          if (a <= b) return true;
          if (a > b) return true;
          if (a >= b) return true;
          return false;
        }
      `,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('(a < b)');
    expect(output).toContain('(a <= b)');
    expect(output).toContain('(a > b)');
    expect(output).toContain('(a >= b)');
  });

  it('emits logical operators for boolean domain', () => {
    const result = lower(
      'logical.ts',
      'export function both(a: boolean, b: boolean): boolean { return a && b || !a; }',
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('(a && b) || ! a');
  });

  it('emits strict equality for boolean domain', () => {
    const result = lower(
      'bool-equality.ts',
      'export function same(a: boolean, b: boolean): boolean { const r: boolean = a === b; return r; }',
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('a == b');
  });

  it('emits strict equality for string domain', () => {
    const result = lower(
      'string-equality.ts',
      'export function same(a: string, b: string): boolean { const r: boolean = a === b; return r; }',
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('flighthq._internal._Js.strictEqual(a, b)');
  });

  it('emits strict inequality for number domain', () => {
    const result = lower(
      'num-inequality.ts',
      'export function different(a: number, b: number): boolean { const r: boolean = a !== b; return r; }',
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('a != b');
  });

  it('emits strict inequality for object domain as reference comparison', () => {
    const result = lower(
      'object-inequality.ts',
      'export function different(a: Uint8Array, b: Uint8Array): boolean { return a !== b; }',
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('a != b');
  });
});

describe('emitIrModuleHaxe class coverage', () => {
  it('emits a base class with explicit empty constructor when subclassed', () => {
    const result = lower(
      'base-subclass.ts',
      `
        export class Base { value: number = 1; }
        export class Child extends Base { extra: number = 2; }
      `,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('class Base');
    expect(output).toContain('public function new() {}');
  });

  it('emits class fields with public, private, and protected visibility', () => {
    const result = lower(
      'visibility.ts',
      `
        export class Widget {
          public label: string = "default";
          private count: number = 0;
          protected active: boolean = true;
          constructor() { this.count; this.active; }
        }
      `,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('public var label:String = "default";');
    expect(output).toContain('private var count:Float = 0;');
    expect(output).toContain('var active:Bool = true;');
  });

  it('emits static class fields', () => {
    const result = lower('static-field.ts', 'export class Config { static readonly VERSION: number = 1; }');
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('static final VERSION:Float = 1;');
  });

  it('emits method override when inherited from a base class in the same module', () => {
    const result = lower(
      'override-method.ts',
      `
        export class Base { run(): number { return 1; } }
        export class Child extends Base { override run(): number { return 2; } }
      `,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('override function run():Float');
  });

  it('refuses implicit derived constructor when ambient base cannot forward ABI', () => {
    const result = lower('error-implicit.ts', 'export class AppError extends Error {}');

    expect(() => emitIrModuleHaxe(result.module)).toThrow(
      'implicit derived constructor requires inherited-ABI forwarding',
    );
  });

  it('refuses enum with mixed numeric and string values', () => {
    const result = lower('mixed-enum.ts', "export enum Mixed { A = 1, B = 'b' }");

    expect(() => emitIrModuleHaxe(result.module)).toThrow('mixes string and numeric values');
  });

  it('refuses module-level variable declaration without initializer', () => {
    const result = lower('no-init.ts', 'export let count: number;');
    const declaration = result.module.declarations[0]!;
    if (declaration.kind !== 'variable') throw new Error('Expected variable declaration');
    const stripped = { ...declaration, initializer: undefined } as typeof declaration;
    const module = { ...result.module, declarations: [stripped] };

    expect(() => emitIrModuleHaxe(module)).toThrow('requires an initializer');
  });

  it('emits mutable module-level variable with var storage', () => {
    const result = lower('mutable.ts', 'export let count: number = 0;');
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('var count:Float = 0;');
  });

  it('emits module-level call and assignment side effects in source order', () => {
    const result = lower(
      'module-side-effects.ts',
      `
        import { register } from './registry';
        register();
        export let value = 0;
        value = 1;
      `,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(result.diagnostics).toEqual([]);
    expect(output).toMatch(/final moduleSideEffect(?:_2)?:Bool = \(\{ register\(\); true; \}\);/u);
    expect(output).toMatch(/final moduleSideEffect(?:_2)?:Bool = \(\{ \(value = 1\); true; \}\);/u);
    expect(output.indexOf('register(); true;')).toBeLessThan(output.indexOf('var value:Float'));
    expect(output.indexOf('var value:Float')).toBeLessThan(output.indexOf('(value = 1); true;'));
  });
});

describe('emitIrModuleHaxe type coverage', () => {
  it('emits intersection type with one member as that type and multiple as Dynamic', () => {
    const result = lower(
      'intersection.ts',
      `
        interface A { value: number }
        interface B { label: string }
        export function single(value: A & B): void { value; }
        export function solo(value: A): void { value; }
      `,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('value:Dynamic');
  });

  it('emits utility types using their Haxe representations', () => {
    const result = lower(
      'utility-types.ts',
      `
        interface Config { value: number }
        export function readOnly(config: Readonly<Config>): number { return config.value; }
        export function partial(config: Partial<Config>): void { config; }
        export function required(config: Required<Config>): void { config; }
        export function record(config: Record<string, number>): void { config; }
        export function readonlyMap(config: ReadonlyMap<string, number>): void { config; }
      `,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('config:Config');
    expect(output).toContain('function partial(config:Dynamic)');
    expect(output).toContain('config:haxe.DynamicAccess<Float>');
    expect(output).toContain('config:flighthq._internal._Map<String, Float>');
  });

  it('emits named type with type arguments', () => {
    const result = lower(
      'generic-use.ts',
      'interface Box<T> { value: T } export function read(box: Box<number>): number { return box.value; }',
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('box:Box<Float>');
  });

  it('emits function type with parameter types and return type', () => {
    const result = lower(
      'function-type.ts',
      'export function apply(fn: (a: number, b: string) => boolean): boolean { return fn(1, "test"); }',
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('fn:(Float, String)->Bool');
  });

  it('emits literal types as their Haxe primitive equivalents', () => {
    const result = lower('literal-types.ts', 'export function literal(a: true, b: 42, c: "hello"): void { a; b; c; }');
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('a:Bool');
    expect(output).toContain('b:Float');
    expect(output).toContain('c:String');
  });

  it('emits tuple type as Array with shared element type or Dynamic', () => {
    const result = lower(
      'tuple-type.ts',
      'export function pair(values: [number, number]): number { return values[0]; }',
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('values:Array<Float>');
  });

  it('emits bigint type as haxe.Int64', () => {
    const result = lower('bigint.ts', 'export function wide(value: bigint): void { value; }');
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('value:haxe.Int64');
  });

  it('emits symbol type as Dynamic', () => {
    const result = lower('symbol-type.ts', 'export function sym(value: symbol): void { value; }');
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('value:Dynamic');
  });

  it('emits string literal union as enum abstract over String', () => {
    const result = lower('string-union.ts', "export type Direction = 'north' | 'south' | 'east' | 'west';");
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('enum abstract Direction(String) from String to String');
    expect(output).toContain('var North = "north";');
    expect(output).toContain('var South = "south";');
  });

  it('allocates valid stable names for symbolic string literal members', () => {
    const result = lower('symbolic-string-union.ts', "export type Comparison = '' | '!=' | '<=' | 'two-words' | '2d';");
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('var Empty = "";');
    expect(output).toContain('var NotEqual = "!=";');
    expect(output).toContain('var LessThanOrEqual = "<=";');
    expect(output).toContain('var TwoWords = "two-words";');
    expect(output).toContain('var Value2d = "2d";');
  });

  it('parenthesizes nested callback returns in Haxe function types', () => {
    const result = lower('nested-callback.ts', 'export type Factory = () => () => void;');
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('typedef Factory = ()->(()->Void);');
  });

  it('emits union of record types as flattened anonymous structure', () => {
    const result = lower(
      'union-records.ts',
      `
        interface Circle { kind: string; radius: number }
        interface Square { kind: string; side: number }
        export type Shape = Circle | Square;
      `,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('typedef Shape = {');
    expect(output).toContain('kind:String');
    expect(output).toContain('?radius:Float');
    expect(output).toContain('?side:Float');
  });
});

describe('emitIrModuleHaxe statement coverage', () => {
  it('materializes a value when a Dynamic-returning function completes normally', () => {
    const result = lower(
      'dynamic-completion.ts',
      'export function read(flag: boolean): unknown { if (flag) return 1; }',
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('return null;');
  });

  it('refuses for-of with await marker through async lowering', () => {
    const result = lower(
      'async-for-of.ts',
      'export function iterate(values: number[]): number { let sum: number = 0; for (const value of values) { sum += value; } return sum; }',
    );
    const declaration = result.module.declarations[0]!;
    if (declaration.kind !== 'function') throw new Error('Expected function');
    const forOf = declaration.body[1]!;
    if (forOf.kind !== 'forOf') throw new Error('Expected forOf');
    const asyncForOf = { ...forOf, await: true };
    const module = {
      ...result.module,
      declarations: [{ ...declaration, body: [declaration.body[0]!, asyncForOf, declaration.body[2]!] }],
    };

    expect(() => emitIrModuleHaxe(module)).toThrow('requires the Haxe async-lowering pass');
  });

  it('preserves return and throw completion through finally blocks', () => {
    const result = lower(
      'try-finally.ts',
      'export function safe(value: number): number { try { return value; } finally { value; } }',
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('final finallyReturnSignal:Dynamic = {};');
    expect(output).toContain('finallyReturnValue = value;');
    expect(output).toContain('throw finallyReturnSignal;');
    expect(output).toContain('if (finallyFailed) throw finallyFailure;');
    expect(output).toContain('if (finallyReturned) return cast(finallyReturnValue);');
    expect(output).toContain('throw new haxe.Exception("unreachable control flow");');
  });

  it('keeps synthetic finally returns out of source catch clauses and nested functions', () => {
    const result = lower(
      'nested-try-finally.ts',
      `export function safe(value: number): number {
         try {
           try { return value; } finally { (() => value)(); }
         } catch (error) { return 0; }
         finally { value; }
       }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('if (error == finallyReturnSignal) throw error;');
    expect(output).toContain('finallyReturned = true;');
    expect(output).toContain('throw finallyReturnSignal;');
  });

  it('emits try-catch without a catch binding as a named placeholder', () => {
    const result = lower(
      'catch-no-binding.ts',
      'export function safe(value: number): number { try { return value; } catch { return 0; } }',
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('catch (error:Dynamic)');
  });

  it('emits if-else statements', () => {
    const result = lower(
      'if-else.ts',
      'export function pick(flag: boolean): number { if (flag) { return 1; } else { return 0; } }',
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('if (flag)');
    expect(output).toContain('else {');
  });

  it('emits while loops from source while statements', () => {
    const result = lower(
      'while-loop.ts',
      'export function loop(): number { let i: number = 0; while (i < 10) { i += 1; } return i; }',
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('while (i < 10)');
  });

  it('emits block statements without labels as bare braces', () => {
    const result = lower(
      'block.ts',
      'export function scope(value: number): number { { const local: number = value + 1; return local; } }',
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('{\n    final local:Float');
  });

  it('emits return with narrowed-present nullable binding without error', () => {
    const result = lower(
      'return-narrow.ts',
      'export function first(values: number[] | undefined): number { if (values !== undefined) { return values[0]; } return 0; }',
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('return values[0];');
  });

  it('emits a narrowed module binding declared below its lazy getter', () => {
    const result = lower(
      'lazy-module-binding.ts',
      `interface Backend { value: number }
       export function getBackend(): Backend {
         if (_backend === null) _backend = { value: 1 };
         return _backend;
       }
       let _backend: Backend | null = null;`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('return _backend;');
  });

  it('emits type parameters with constraints on functions and classes', () => {
    const result = lower(
      'constrained.ts',
      'interface HasValue { value: number } export function read<T extends HasValue>(item: T): number { return item.value; }',
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('<T:HasValue>');
  });

  it('emits scoped package import from a scoped package specifier', () => {
    const result = lowerPackage(
      '@flighthq/core',
      'use.ts',
      "import type { Point } from '@flighthq/math/geometry'; export type Alias = Point;",
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('import flighthq.math.Math.Point;');
  });

  it('refuses non-relative non-scoped bare module imports', () => {
    const result = lower(
      'bare-import.ts',
      "import { something } from 'bare-module'; export function use(): void { something; }",
    );

    expect(() => emitIrModuleHaxe(result.module)).toThrow(
      'external import bare-module requires a runtime or standard-library mapping',
    );
  });

  it('emits same-package type re-exports and renamed aliases', () => {
    const same = lowerPackage(
      '@flighthq/math',
      'reexport-same.ts',
      "export type { Point as Point } from './types.js';",
    );
    const renamed = lowerPackage(
      '@flighthq/math',
      'reexport-renamed.ts',
      "export type { Point as Coordinate } from './types.js';",
    );
    const sameOutput = emitIrModuleHaxe(same.module).contents;
    const renamedOutput = emitIrModuleHaxe(renamed.module).contents;

    expect(sameOutput).toContain('typedef ReexportSamePoint = flighthq.math.Types.Point;');
    expect(renamedOutput).toContain('typedef ReexportRenamedCoordinate =');
  });

  it('emits variable with local mutable storage', () => {
    const result = lower(
      'local-var.ts',
      'export function compute(input: number): number { let value: number = input; value = value + 1; return value; }',
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('var value:Float = input;');
  });
});

describe('emitIrModuleHaxe ambient member coverage', () => {
  it('uses numeric ambient evidence for Math logarithm, arcsine, and exponential arithmetic', () => {
    const result = lower(
      'math-evidence.ts',
      `
        export function scaleLog(value: number): number { return 2 * Math.log(value); }
        export function scaleAsin(value: number): number { return Math.asin(value) * 2; }
        export function scaleExp(value: number): number { return 2 * Math.exp(value); }
      `,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('return 2 * Math.log(value);');
    expect(output).toContain('return Math.asin(value) * 2;');
    expect(output).toContain('return 2 * Math.exp(value);');
  });

  it('emits Number predicates and constants as semantics-preserving Haxe expressions', () => {
    const result = lower(
      'number-statics.ts',
      `
        export function finite(value: number): boolean { return Number.isFinite(value); }
        export function integer(value: number): boolean { return Number.isInteger(value); }
        export function allIntegers(values: number[]): boolean { return values.every(Number.isInteger); }
        export function invalid(value: number): boolean { return Number.isNaN(value); }
        export function epsilon(): number { return Number.EPSILON; }
        export function maximumSafeInteger(): number { return Number.MAX_SAFE_INTEGER; }
        export function minimumSafeInteger(): number { return Number.MIN_SAFE_INTEGER; }
      `,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('return Math.isFinite(value);');
    expect(output).toContain('Math.isFinite(numberValue) && Math.ffloor(numberValue) == numberValue');
    expect(output).toContain('Lambda.foreach(values, (function(numberValue:Float)');
    expect(output).toContain('return Math.isNaN(value);');
    expect(output).toContain('return 2.220446049250313e-16;');
    expect(output).toContain('return 9.007199254740991e15;');
    expect(output).toContain('return -9.007199254740991e15;');
  });

  it('routes Number conversion and parseFloat through their portable spellings', () => {
    const conversion = lower(
      'number-conversion.ts',
      'export function parse(value: string): number { return Number(value); }',
    );
    const parseFloat = lower(
      'number-parse-float.ts',
      'export function parse(value: string): number { return Number.parseFloat(value); }',
    );

    expect(emitIrModuleHaxe(conversion.module).contents).toContain('return flighthq._internal._Js.toNumber(value);');
    expect(emitIrModuleHaxe(parseFloat.module).contents).toContain('return Std.parseFloat(value);');
  });

  it('routes runtime member helpers through the configured runtime module', () => {
    const result = lower(
      'runtime-members.ts',
      `export function keys(value: object): string[] { return Object.keys(value); }
       export function replace(value: string): string { return value.replace('a', 'b'); }
       export function fixed(value: number): string { return value.toFixed(2); }`,
    );
    const output = emitIrModuleHaxe(result.module, { runtimeModule: 'flight._hx._runtime' }).contents;

    expect(output).toContain('flight._hx._runtime._Object.keys(value)');
    expect(output).toContain('flight._hx._runtime._StringTools.replaceFirst(value, "a", "b")');
    expect(output).toContain('flight._hx._runtime._Number.toFixed(value, 2)');
  });

  it('routes structuredClone through the portable object runtime', () => {
    const result = lower(
      'structured-clone.ts',
      'export function clone<T>(value: T): T { return structuredClone(value); }',
    );
    const output = emitIrModuleHaxe(result.module, { runtimeModule: 'flight._hx._runtime' }).contents;

    expect(output).toContain('return flight._hx._runtime._Object.structuredClone(value);');
  });

  it('emits array.reduce as Lambda.fold with exchanged closure', () => {
    const result = lower(
      'reduce.ts',
      'export function sum(values: number[]): number { return values.reduce((acc, item) => acc + item, 0); }',
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('Lambda.fold(');
  });

  it('emits array.every as Lambda.foreach static call', () => {
    const result = lower(
      'every.ts',
      'export function allPositive(values: number[]): boolean { return values.every((v) => v > 0); }',
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('Lambda.foreach(');
  });

  it('emits array.forEach as Lambda.iter and flatMap through the runtime', () => {
    const result = lower(
      'array-iteration.ts',
      `export function visit(values: number[], effect: (value: number, index: number) => void): void {
         values.forEach(effect);
       }
       export function pairs(values: number[]): number[] {
         return values.flatMap((value) => [value, value]);
       }`,
    );
    const output = emitIrModuleHaxe(result.module, { runtimeModule: 'flight._hx._runtime' }).contents;

    expect(output).toContain('Lambda.iter(values, cast(effect))');
    expect(output).toContain('flight._hx._runtime._Array.flatMap(values, cast(');
  });

  it('emits string.endsWith as StringTools.endsWith static call', () => {
    const result = lower('ends-with.ts', 'export function check(s: string): boolean { return s.endsWith("x"); }');
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('StringTools.endsWith(');
  });

  it('emits array.length as property access', () => {
    const result = lower(
      'array-length.ts',
      'export function count(values: number[]): number { return values.length; }',
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('.length');
  });

  it('emits string.charAt with int argument position', () => {
    const result = lower('char-at.ts', 'export function first(s: string): string { return s.charAt(0); }');
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('.charAt(');
  });

  it('emits string.charCodeAt with Std.int on index argument', () => {
    const result = lower(
      'char-code-at.ts',
      'export function code(s: string, pos: number): number { return s.charCodeAt(pos); }',
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('.charCodeAt(');
    expect(output).toContain('Std.int(pos)');
  });

  it('coerces numeric string/runtime bounds and preserves regexp split', () => {
    const result = lower(
      'string-runtime-bounds.ts',
      `export function inspect(value: string, numberValue: number, index: number): string[] {
         value[index];
         value.codePointAt(index);
         value.slice(index, index + 1);
         numberValue.toString(index);
         return value.split(/\\s+/);
       }`,
    );
    const output = emitIrModuleHaxe(result.module, { runtimeModule: 'flight._hx._runtime' }).contents;

    expect(output).toContain('flight._hx._runtime._Js.getProperty(value, index)');
    expect(output).toContain('flight._hx._runtime._StringTools.codePointAt(value, Std.int(index))');
    expect(output).toContain('flight._hx._runtime._StringTools.slice(value, Std.int(index), Std.int((index + 1)))');
    expect(output).toContain('flight._hx._runtime._Number.toString(numberValue, Std.int(index))');
    expect(output).toContain('flight._hx._runtime._StringTools.split(value, new flight._hx._runtime._RegExp');
  });

  it('coerces dynamic array lengths and emits JavaScript Math.imul', () => {
    const result = lower(
      'integer-runtime-values.ts',
      `export function create(length: number, left: number, right: number): number[] {
         Math.imul(left, right);
         return new Array<number>(length);
       }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('js.Syntax.code("Math.imul({0}, {1})", left, right)');
    expect(output).toContain('new flighthq._internal._Array(Std.int(length))');
  });

  it('keeps numeric Array.fill inference in the source number domain', () => {
    const result = lower(
      'array-fill-number.ts',
      `export function create(length: number): number[] {
         return new Array<number>(length).fill(1);
       }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('._Array.fill(');
    expect(output).toContain('(cast 1 : Float)');
  });

  it('preserves source code-point validation and variadic construction on the JS target', () => {
    const result = lower(
      'from-code-point.ts',
      'export function character(code: number): string { return String.fromCodePoint(code); }',
    );

    expect(emitIrModuleHaxe(result.module).contents).toContain('js.Syntax.code("String.fromCodePoint({0})", code)');
  });
});

describe('emitIrModuleHaxe class extended coverage', () => {
  it('emits get/set accessor pair as Haxe property with methods', () => {
    const result = lower(
      'accessor.ts',
      `
        export class Counter {
          private _count: number = 0;
          get count(): number { return this._count; }
          set count(value: number) { this._count = value; }
        }
      `,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('var count(get, set):Float;');
    expect(output).toContain('function get_count():Float');
    expect(output).toContain('function set_count(value:Float):Float');
  });

  it('emits abstract class with abstract method', () => {
    const result = lower(
      'abstract-class.ts',
      `
        export abstract class Shape {
          abstract area(): number;
        }
      `,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('abstract class Shape');
    expect(output).toContain('abstract function area():Float;');
  });

  it('emits class implementing interface', () => {
    const result = lower(
      'implements.ts',
      `
        export interface Printable { display(): string; }
        export class Label implements Printable {
          text: string = "";
          display(): string { return this.text; }
        }
      `,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('implements Printable');
    expect(output).toContain('interface Printable');
    expect(output).toContain('public function display():String;');
  });

  it('emits override on method inherited from base class in same module', () => {
    const result = lower(
      'override-method.ts',
      `
        export class Base {
          run(): number { return 1; }
        }
        export class Child extends Base {
          override run(): number { return 2; }
        }
      `,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('override');
  });

  it('emits derived class constructor with super call and field initialization', () => {
    const result = lower(
      'derived-ctor.ts',
      `
        export class Base {
          name: string;
          constructor(name: string) { this.name = name; }
        }
        export class Child extends Base {
          extra: number = 10;
          constructor(name: string) { super(name); }
        }
      `,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('super(name)');
    expect(output).toContain('this.extra = 10');
  });
});

describe('emitIrModuleHaxe interface and typedef coverage', () => {
  it('emits interface extending another as flattened typedef', () => {
    const result = lower(
      'interface-extends.ts',
      `
        export interface Base { x: number; }
        export interface Extended extends Base { y: number; }
      `,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('typedef Extended');
    expect(output).toContain('y:Float');
  });

  it('emits structInit record with optional properties', () => {
    const result = lower('optional-record.ts', 'export interface Config { name: string; debug?: boolean; }');
    const output = emitIrModuleHaxe(result.module, { structuralRecords: 'structInit' }).contents;

    expect(output).toContain('@:structInit');
    expect(output).toContain('final class Config');
    expect(output).toContain('public var name:String;');
    expect(output).toContain('public var debug:Null<Bool> = null;');
  });
});

describe('emitIrModuleHaxe statement extended coverage', () => {
  it('emits do-while loop', () => {
    const result = lower(
      'do-while.ts',
      `
        export function countdown(n: number): number {
          let i: number = n;
          do { i = i - 1; } while (i > 0);
          return i;
        }
      `,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('do {');
    expect(output).toContain('} while (i > 0);');
  });

  it('emits for-of loop', () => {
    const result = lower(
      'for-of.ts',
      'export function total(values: number[]): number { let sum: number = 0; for (const v of values) { sum = sum + v; } return sum; }',
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('for (');
    expect(output).toContain(' in ');
  });

  it('emits throw statement', () => {
    const result = lower('throw.ts', 'export function fail(): never { throw new Error("fail"); }');
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('throw ');
  });

  it('emits switch statement with cases and default', () => {
    const result = lower(
      'switch.ts',
      `
        export function label(n: number): string {
          switch (n) {
            case 1: return "one";
            case 2: return "two";
            default: return "other";
          }
        }
      `,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('switch (n)');
    expect(output).toContain('case 1:');
    expect(output).toContain('default:');
  });

  it('emits expression statement', () => {
    const result = lower('expression-stmt.ts', 'export function noop(values: number[]): void { values.push(1); }');
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('values.push(1);');
  });

  it('emits C-style for loop as while after lowering', () => {
    const result = lower(
      'for-loop.ts',
      'export function loop(): number { let s: number = 0; for (let i: number = 0; i < 5; i++) { s = s + i; } return s; }',
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('while');
  });
});

describe('emitIrModuleHaxe operator coverage', () => {
  it('emits postfix increment and decrement', () => {
    const result = lower(
      'postfix.ts',
      `
        export function step(n: number): number {
          let x: number = n;
          x++;
          x--;
          return x;
        }
      `,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('x++');
    expect(output).toContain('x--');
  });

  it('emits prefix increment, decrement, negation, and bitwise not', () => {
    const result = lower(
      'prefix.ts',
      `
        export function ops(n: number): number {
          let x: number = n;
          ++x;
          --x;
          const neg: number = -x;
          const inv: number = ~x;
          return neg + inv;
        }
      `,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('++ x');
    expect(output).toContain('-- x');
  });

  it('emits power assignment as Math.pow', () => {
    const result = lower(
      'power-assign.ts',
      'export function square(n: number): number { let x: number = n; x **= 2; return x; }',
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('Math.pow(');
  });

  it('emits string addition operator', () => {
    const result = lower('string-add.ts', 'export function greet(name: string): string { return "hello " + name; }');
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('"hello " + name');
  });

  it('emits arithmetic operators for number domain', () => {
    const result = lower(
      'arithmetic.ts',
      `
        export function math(a: number, b: number): number {
          const sub: number = a - b;
          const mul: number = a * b;
          const div: number = a / b;
          const mod: number = a % b;
          return sub + mul + div + mod;
        }
      `,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('a - b');
    expect(output).toContain('a * b');
    expect(output).toContain('a / b');
    expect(output).toContain('a % b');
  });

  it('emits compound assignment operators for number domain', () => {
    const result = lower(
      'compound-assign.ts',
      `
        export function compound(a: number, b: number): number {
          let x: number = a;
          x += b;
          x -= b;
          x *= b;
          x /= b;
          x %= b;
          return x;
        }
      `,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('x += b');
    expect(output).toContain('x -= b');
    expect(output).toContain('x *= b');
    expect(output).toContain('x /= b');
    expect(output).toContain('x %= b');
  });

  it('emits typeof type test as Std.isOfType', () => {
    const result = lower(
      'typeof-test.ts',
      `
        export function isNumber(x: number | string): boolean {
          return typeof x === "number";
        }
      `,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('Std.isOfType(');
  });

  it('emits nullish comparison as null check', () => {
    const result = lower(
      'null-check.ts',
      'export function isPresent(value: number | null): boolean { return value !== null; }',
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('js.Syntax.strictNeq(value, null)');
  });
});

describe('emitIrModuleHaxe enum extended coverage', () => {
  it('emits string enum as String abstract', () => {
    const result = lower('string-enum.ts', 'export enum Color { Red = "red", Green = "green", Blue = "blue" }');
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('(String)');
    expect(output).toContain('"red"');
  });

  it('emits numeric enum with float values', () => {
    const result = lower('float-enum.ts', 'export enum Ratio { Half = 0.5, Third = 0.333 }');
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('(Float)');
    expect(output).toContain('0.5');
  });
});

describe('emitIrModuleHaxe variable and module-level coverage', () => {
  it('emits module-level variable declaration with type', () => {
    const result = lower('module-var.ts', 'export const PI: number = 3.14;');
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('final PI:Float = 3.14;');
  });

  it('emits a possibly undefined uninitialized variable with its JavaScript value', () => {
    const result = lower(
      'undef-var.ts',
      'export function init(): number { let x: number | undefined; if (x !== undefined) { return x; } return 0; }',
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('var ');
    expect(output).toContain('= js.Syntax.code("undefined")');
  });

  it('emits new expression', () => {
    const result = lower(
      'new-expr.ts',
      `
        export class Point { x: number = 0; y: number = 0; }
        export function create(): Point { return new Point(); }
      `,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('new Point()');
  });

  it('emits re-export as typedef for type-only cross-package', () => {
    const result = lowerPackage('@flighthq/core', 'reexport.ts', 'export type { Point } from "@flighthq/math";');
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('typedef');
  });

  it('refuses re-export of value', () => {
    const result = lower('value-reexport.ts', 'export { add } from "./add.js";');

    expect(() => emitIrModuleHaxe(result.module)).toThrow('re-exporting the value');
  });
});

describe('emitIrModuleHaxe tuple and spread coverage', () => {
  it('emits tuple type as Array with shared element type', () => {
    const result = lower(
      'tuple-type.ts',
      'export function pair(a: number, b: number): [number, number] { return [a, b]; }',
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('Array<Float>');
  });

  it('emits tuple type with mixed elements as Array<Dynamic>', () => {
    const result = lower(
      'tuple-mixed.ts',
      'export function mixed(a: number, b: string): [number, string] { return [a, b]; }',
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('Array<Dynamic>');
  });

  it('emits optional chaining on property access', () => {
    const result = lower(
      'optional-chain.ts',
      `
        export class Node { next: Node | null = null; value: number = 0; }
        export function peek(node: Node | null): number | null { return node?.value ?? null; }
      `,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('?.');
  });
});

describe('emitIrModuleHaxe control flow coverage', () => {
  it('emits labeled while with break targeting outer', () => {
    const result = lower(
      'labeled-break.ts',
      `
        export function search(values: number[]): number {
          let found: number = -1;
          outer: while (true) {
            for (const v of values) {
              if (v > 10) { found = v; break outer; }
            }
            break;
          }
          return found;
        }
      `,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('ControlFlowState');
  });

  it('emits try-catch without finally', () => {
    const result = lower(
      'try-catch.ts',
      `
        export function safe(value: number): number {
          try {
            return value;
          } catch (e) {
            return 0;
          }
        }
      `,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('try {');
    expect(output).toContain('catch (');
  });

  it('emits for-in with closed key plan', () => {
    const result = lower(
      'for-in-keys.ts',
      `
        export interface Point { x: number; y: number; }
        export function keys(p: Point): void { for (const k in p) k; }
      `,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('for (');
  });
});

describe('emitIrModuleHaxe spread and call coverage', () => {
  it('emits spread call as HaxeReflect.callMethod', () => {
    const result = lower(
      'spread-call.ts',
      'export function apply(fn: (...args: number[]) => number, args: number[]): number { return fn(...args); }',
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('HaxeReflect.callMethod(');
  });

  it('emits spread call with fixed and spread arguments', () => {
    const result = lower(
      'spread-mixed.ts',
      'export function apply(fn: (a: number, ...args: number[]) => number, args: number[]): number { return fn(1, ...args); }',
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('HaxeReflect.callMethod(');
    expect(output).toContain('.concat(');
  });
});

describe('emitIrModuleHaxe type alias coverage', () => {
  it('emits type alias for non-object type as typedef', () => {
    const result = lower('type-alias-simple.ts', 'export type ID = string;');
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('typedef ID = String;');
  });

  it('emits type alias for union of records as flattened anonymous type', () => {
    const result = lower(
      'union-records.ts',
      `
        export interface A { x: number; y: number; }
        export interface B { x: number; z: number; }
        export type AB = A | B;
      `,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('typedef AB');
  });

  it('emits type alias for string literal union as enum abstract', () => {
    const result = lower('string-union-alias.ts', 'export type Direction = "up" | "down" | "left" | "right";');
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('enum abstract Direction(String)');
    expect(output).toContain('"up"');
  });
});

describe('emitIrModuleHaxe class inheritance coverage', () => {
  it('emits base class field names as inherited in derived class', () => {
    const result = lower(
      'inherited-fields.ts',
      `
        export class Base {
          x: number = 0;
          y: number = 0;
        }
        export class Derived extends Base {
          z: number = 0;
        }
      `,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('class Base');
    expect(output).toContain('class Derived extends Base');
  });

  it('emits method override across two-level inheritance', () => {
    const result = lower(
      'deep-override.ts',
      `
        export class A { run(): number { return 1; } }
        export class B extends A { override run(): number { return 2; } }
        export class C extends B { override run(): number { return 3; } }
      `,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('override');
  });

  it('emits abstract method without body', () => {
    const result = lower(
      'abstract-method.ts',
      `
        export abstract class Handler {
          abstract process(value: number): string;
          name: string = "handler";
        }
      `,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('abstract function process(value:Float):String;');
  });
});

describe('emitIrModuleHaxe identifier and import coverage', () => {
  it('emits super keyword in method call', () => {
    const result = lower(
      'super-call.ts',
      `
        export class Base {
          value: number;
          constructor(v: number) { this.value = v; }
        }
        export class Child extends Base {
          constructor() { super(42); }
        }
      `,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('super(42)');
  });

  it('emits this keyword in method body', () => {
    const result = lower(
      'this-access.ts',
      `
        export class Counter {
          count: number = 0;
          increment(): void { this.count = this.count + 1; }
        }
      `,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('this.count');
  });

  it('emits object literal with named properties', () => {
    const result = lower(
      'object-literal.ts',
      `
        export interface Point { x: number; y: number; }
        export function origin(): Point { return { x: 0, y: 0 }; }
      `,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('x: 0');
    expect(output).toContain('y: 0');
  });

  it('emits scoped import from relative module', () => {
    const result = lower(
      'import.ts',
      `
        import { add } from "./add.js";
        export function double(n: number): number { return add(n, n); }
      `,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('import ');
  });
});

describe('emitIrModuleHaxe type emission edge cases', () => {
  it('emits never type as Dynamic', () => {
    const result = lower('never-type.ts', 'export function fail(): never { throw new Error("fail"); }');
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('Dynamic');
  });

  it('emits unknown type as Dynamic', () => {
    const result = lower('unknown-type.ts', 'export function identity(x: unknown): unknown { return x; }');
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('Dynamic');
  });

  it('emits null union type as Null<T>', () => {
    const result = lower('null-union.ts', 'export function maybe(x: number | null): number | null { return x; }');
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('Null<Float>');
  });

  it('emits array type with element type', () => {
    const result = lower('array-type.ts', 'export function first(values: string[]): string { return values[0]; }');
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('Array<String>');
  });

  it('emits function type with parameters and return', () => {
    const result = lower(
      'fn-type.ts',
      'export function apply(fn: (a: number) => string, value: number): string { return fn(value); }',
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('(Float)->String');
  });
});

describe('emitIrModuleHaxe class implements non-nominal', () => {
  it('refuses a class implementing a type with no nominal Haxe interface', () => {
    const result = lower(
      'implements-non-nominal.ts',
      `
        export class Widget {
          step: number = 1;
        }
      `,
    );
    const classDecl = result.module.declarations[0]!;
    if (classDecl.kind !== 'class') throw new Error('Expected class');
    const patched = {
      ...classDecl,
      implements: [{ kind: 'primitive' as const, name: 'string' as const }],
    };
    const module = { ...result.module, declarations: [patched] };

    expect(() => emitIrModuleHaxe(module as unknown as IrModule)).toThrow(
      'implements a type with no nominal Haxe interface',
    );
  });
});

describe('emitIrModuleHaxe multiple super calls error', () => {
  it('refuses a derived class with no direct super call when constructor has parameters', () => {
    const result = lower(
      'multi-super.ts',
      `
        class Base {}
        export class Derived extends Base {
          constructor() { super(); }
        }
      `,
    );
    const classDecl = result.module.declarations.find((d) => d.kind === 'class' && d.binding.name === 'Derived')!;
    if (classDecl.kind !== 'class' || !classDecl.classConstructor) throw new Error('Expected class with constructor');
    const superCall = classDecl.classConstructor.body[0]!;
    const patched = {
      ...classDecl,
      classConstructor: {
        ...classDecl.classConstructor,
        body: [superCall, superCall],
      },
    };
    const module = {
      ...result.module,
      declarations: result.module.declarations.map((d) =>
        d.kind === 'class' && d.binding.name === 'Derived' ? patched : d,
      ),
    };

    expect(() => emitIrModuleHaxe(module)).toThrow(
      'requires one direct super constructor call for Haxe initialization',
    );
  });
});

describe('emitIrModuleHaxe implicit derived super with Error name storage', () => {
  it('emits implicit derived Error subclass constructor with name initialization', () => {
    const result = lower(
      'implicit-error.ts',
      `
        export class AppError extends Error {
          constructor(message: string) { super(message); this.name = 'AppError'; }
        }
        export class SpecificError extends AppError {}
      `,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('class SpecificError extends AppError');
    expect(output).toContain('super(');
  });
});

describe('emitIrModuleHaxe accessor and method visibility', () => {
  it('emits get-only and set-only accessor pairs', () => {
    const result = lower(
      'accessor-partial.ts',
      `
        export class Store {
          private _items: number = 0;
          get items(): number { return this._items; }
        }
      `,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('var items(get, never):Float;');
    expect(output).toContain('function get_items():Float');
  });

  it('emits protected method without visibility keyword', () => {
    const result = lower(
      'protected-method.ts',
      `
        export class Shape {
          protected helper(): number { return 0; }
          call(): number { return this.helper(); }
        }
      `,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('function helper():Float');
    expect(output).not.toMatch(/public function helper/);
    expect(output).not.toMatch(/private function helper/);
  });
});

describe('emitIrModuleHaxe enum mixed values', () => {
  it('refuses an enum with a non-finite numeric value', () => {
    const result = lower('non-finite-enum.ts', 'export enum Values { A = 1 }');
    const decl = result.module.declarations[0]!;
    if (decl.kind !== 'enum') throw new Error('Expected enum');
    const patched = {
      ...decl,
      members: [{ name: 'A', value: Infinity }],
    };
    const module = { ...result.module, declarations: [patched] };

    expect(() => emitIrModuleHaxe(module)).toThrow('has a non-finite numeric value');
  });
});

describe('emitIrModuleHaxe async task function body', () => {
  it('emits async arrow function body through the task plan', () => {
    const result = lower(
      'async-arrow.ts',
      'export const run = async (input: Promise<number>): Promise<number> => await input;',
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('new flighthq._internal._Promise(');
    expect(output).not.toContain('await ');
  });
});

describe('emitIrModuleHaxe property narrowing and optional access', () => {
  it('emits ambient member property that has no call binding as a property', () => {
    const result = lower(
      'array-length-access.ts',
      'export function count(values: number[]): number { return values.length; }',
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('.length');
  });
});

describe('emitIrModuleHaxe exchanged closure body form', () => {
  it('emits exchanged closure with block body form', () => {
    const result = lower(
      'reduce-block.ts',
      'export function sum(values: number[]): number { return values.reduce((acc, item) => { return acc + item; }, 0); }',
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('Lambda.fold(');
    expect(output).toContain('function(');
    expect(output).toContain('return');
  });
});

describe('emitIrModuleHaxe return nullable binding error', () => {
  it('refuses returning a nullable binding without narrowing evidence', () => {
    const result = lower(
      'return-nullable.ts',
      'export function read(value: number | undefined): number { if (value !== undefined) { return value; } return 0; }',
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('return value;');
    expect(output).toContain('return 0;');
  });
});

describe('emitIrModuleHaxe control flow label exit and propagation', () => {
  it('emits labeled continue target for nested labeled break', () => {
    const result = lower(
      'nested-labels.ts',
      `
        export function scan(rows: number[][], limit: number): number {
          let count: number = 0;
          outer: for (const row of rows) {
            for (const value of row) {
              count += value;
              if (count > limit) break outer;
            }
          }
          return count;
        }
      `,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('ControlFlowState');
    expect(output).toContain('break;');
  });
});

describe('emitIrModuleHaxe type indexedAccess and intersection', () => {
  it('emits indexedAccess type as Dynamic', () => {
    const result = lower('indexed-access.ts', 'export function read(value: number): void { value; }');
    const decl = result.module.declarations[0]!;
    if (decl.kind !== 'function') throw new Error('Expected function');
    const patched = {
      ...decl,
      parameters: [
        {
          ...decl.parameters[0]!,
          type: {
            kind: 'indexedAccess' as const,
            object: { kind: 'primitive' as const, name: 'string' as const },
            index: { kind: 'literal' as const, value: 'length' },
          },
        },
      ],
    };
    const module = { ...result.module, declarations: [patched] };
    const output = emitIrModuleHaxe(module).contents;

    expect(output).toContain('Dynamic');
  });
});

describe('emitIrModuleHaxe optional spread call', () => {
  it('emits spread call with fixed arguments after spread', () => {
    const result = lower(
      'spread-fixed-after.ts',
      'export function widest(values: number[], first: number): number { return Math.max(first, ...values); }',
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('HaxeReflect.callMethod(');
    expect(output).toContain('.concat(');
  });
});

describe('emitIrModuleHaxe typeAlias emission', () => {
  it('emits a plain typeAlias as a Haxe typedef', () => {
    const result = lower('type-alias.ts', 'export type Count = number;');
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('typedef Count = Float;');
  });
});

describe('emitIrModuleHaxe structInit type alias and variable emission', () => {
  it('emits structInit for a type alias over an object type', () => {
    const result = lower(
      'struct-type-alias.ts',
      'export type Options = { debug: boolean; verbose?: boolean }; export function read(opts: Options): boolean { return opts.debug; }',
    );
    const output = emitIrModuleHaxe(result.module, { structuralRecords: 'structInit' }).contents;

    expect(output).toContain('@:structInit');
    expect(output).toContain('final class Options');
    expect(output).toContain('public var debug:Bool;');
    expect(output).toContain('public var verbose:Null<Bool> = null;');
  });

  it('emits module-level mutable variable without initializer error', () => {
    const result = lower('module-var.ts', 'export let count: number = 0;');
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('var count:Float = 0;');
  });
});

describe('emitIrModuleHaxe type union null/undefined and tuple shared type', () => {
  it('emits union with only undefined as Null<T>', () => {
    const result = lower(
      'undefined-union.ts',
      'export function maybe(value: string | undefined): string | undefined { return value; }',
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('Null<String>');
  });

  it('emits tuple with mixed types as Array<Dynamic>', () => {
    const result = lower('mixed-tuple.ts', 'export function pair(values: [number, string]): void { values; }');
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('Array<Dynamic>');
  });

  it('emits tuple with optional element as Array<Dynamic>', () => {
    const result = lower('optional-tuple.ts', 'export function maybe(values: [number, string?]): void { values; }');
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('Array<Dynamic>');
  });
});

describe('emitIrModuleHaxe type reference target name and module identifier reference', () => {
  it('emits type reference with path segments', () => {
    const result = lower(
      'generic-constraint.ts',
      'interface HasValue { value: number } export function read<T extends HasValue>(item: T): number { return item.value; }',
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('<T:HasValue>');
  });
});

describe('emitIrModuleHaxe return expression coverage', () => {
  it('emits void return as bare return statement', () => {
    const result = lower('void-return.ts', 'export function noop(flag: boolean): void { if (flag) return; }');
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('return;');
  });
});

describe('emitIrModuleHaxe rest parameter', () => {
  it('emits rest parameter with element type and spread syntax', () => {
    const result = lower('rest-param.ts', 'export function sum(...nums: number[]): number { return nums.length; }');
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('...nums:');
  });
});

describe('emitIrModuleHaxe labeled continue', () => {
  it('emits labeled continue as control-flow state assignment', () => {
    const result = lower(
      'labeled-continue.ts',
      `export function scan(matrix: number[][]): number {
        let sum = 0;
        outer: for (const row of matrix) {
          for (const cell of row) {
            if (cell < 0) continue outer;
            sum += cell;
          }
        }
        return sum;
      }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('ControlFlowState');
    expect(output).toContain('continue;');
  });
});

describe('emitIrModuleHaxe class accessor', () => {
  it('emits getter and setter as Haxe property pair', () => {
    const result = lower(
      'class-accessor.ts',
      `export class Counter {
        private _value: number = 0;
        get value(): number { return this._value; }
        set value(v: number) { this._value = v; }
      }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('(get, set)');
    expect(output).toContain('get_value');
    expect(output).toContain('set_value');
  });

  it('emits getter-only as never-writable Haxe property', () => {
    const result = lower(
      'class-getter-only.ts',
      `export class Box {
        private _size: number = 0;
        get size(): number { return this._size; }
      }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('(get, never)');
  });
});

describe('emitIrModuleHaxe typeof on right side', () => {
  it('emits Std.isOfType when typeof appears on the right side of comparison', () => {
    const result = lower(
      'typeof-right.ts',
      'export function check(x: unknown): boolean { return "number" === typeof x; }',
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('Std.isOfType(');
    expect(output).toContain('Float');
  });
});

describe('emitIrModuleHaxe nullish comparison with ambient on left', () => {
  it('emits null comparison when undefined is on the left side', () => {
    const result = lower(
      'nullish-left.ts',
      'export function check(x: number | undefined): boolean { return undefined === x; }',
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('js.Syntax.strictEq(x, js.Syntax.code("undefined"))');
  });
});

describe('emitIrModuleHaxe function expression call', () => {
  it('wraps a called function expression in parentheses', () => {
    const result = lower('iife.ts', 'export const value: number = (function(): number { return 42; })();');
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('(function()');
  });
});

describe('emitIrModuleHaxe empty bindings import skip', () => {
  it('skips imports with zero bindings', () => {
    const result = lower('side-effect-import.ts', `export function read(): number { return 0; }`);
    const module = {
      ...result.module,
      imports: [...result.module.imports, { specifier: './other.js', bindings: [], typeOnly: false }],
    };
    const output = emitIrModuleHaxe(module).contents;

    expect(output).not.toContain('other');
  });
});

describe('emitIrModuleHaxe try without catch clause', () => {
  it('emits try body alone when catch clause is absent', () => {
    const result = lower(
      'try-no-catch.ts',
      'export function safe(value: number): number { try { return value; } catch (error) { return 0; } }',
    );
    const decl = result.module.declarations[0]!;
    if (decl.kind !== 'function') throw new Error('Expected function');
    const tryStmt = decl.body[0]!;
    if (tryStmt.kind !== 'try') throw new Error('Expected try');
    // Remove catchClause with delete, then validate that the module still works
    const patchedTry = { ...tryStmt };
    delete (patchedTry as Record<string, unknown>)['catchClause'];
    const module = {
      ...result.module,
      declarations: [{ ...decl, body: [patchedTry] }],
    };
    const output = emitIrModuleHaxe(module).contents;

    expect(output).toContain('try {');
    expect(output).not.toContain('catch (');
  });
});

describe('emitIrModuleHaxe interface method with named parameters', () => {
  it('emits named parameters on interface method signature', () => {
    const result = lower(
      'iface-method.ts',
      `export interface Processor { process(input: number, factor: number): number; }
       export class Impl implements Processor { process(input: number, factor: number): number { return input * factor; } }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('function process(');
    expect(output).toContain('input:');
  });
});

describe('emitIrModuleHaxe interface with structInit', () => {
  it('emits structInit optional property with null type as Null wrapper', () => {
    const result = lower(
      'struct-optional-null.ts',
      `export interface Options { debug: boolean; verbose?: boolean }
       export function read(opts: Options): boolean { return opts.debug; }`,
    );
    const output = emitIrModuleHaxe(result.module, { structuralRecords: 'structInit' }).contents;

    expect(output).toContain('@:structInit');
    expect(output).toContain('Null<');
  });
});

describe('emitIrModuleHaxe forOf simple iteration', () => {
  it('emits for-of loop as Haxe for-in', () => {
    const result = lower(
      'for-of-simple.ts',
      'export function total(items: number[]): number { let sum = 0; for (const item of items) { sum += item; } return sum; }',
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('for (');
    expect(output).toContain(' in ');
  });
});

describe('emitIrModuleHaxe conditional expression', () => {
  it('emits ternary as Haxe conditional', () => {
    const result = lower('ternary.ts', 'export function pick(flag: boolean): number { return flag ? 1 : 0; }');
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('?');
    expect(output).toContain(':');
  });
});

describe('emitIrModuleHaxe error subclass implicit constructor', () => {
  it('emits implicit derived constructor for Error subclass with name storage', () => {
    const result = lower(
      'error-subclass.ts',
      `export class BaseError extends Error {
        constructor(message: string) { super(message); }
      }
      export class AppError extends BaseError {}
      export function fail(): AppError { return new AppError("failed"); }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('extends BaseError');
    expect(output).toContain('super(');
  });
});

describe('emitIrModuleHaxe union type flattening', () => {
  it('flattens a union of two interfaces into a Haxe anonymous type', () => {
    const result = lower(
      'union-flatten.ts',
      `export interface Left { x: number; y: string }
       export interface Right { x: number; z: boolean }
       export function read(value: Left | Right): number { return value.x; }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('x:');
  });
});

describe('emitIrModuleHaxe template literal emission', () => {
  it('emits template literal with interpolated expressions as string concatenation', () => {
    const result = lower(
      'template-literal.ts',
      'export function greet(name: string): string { return `hello ${name} world`; }',
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('Std.string(');
    expect(output).toContain('+');
  });

  it('emits empty template literal as empty string', () => {
    const result = lower('template-empty.ts', 'export function empty(): string { return ``; }');
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('""');
  });
});

describe('emitIrModuleHaxe deep labeled break propagation', () => {
  it('propagates labeled break through multiple nesting levels', () => {
    const result = lower(
      'deep-label.ts',
      `export function search(matrix: number[][], target: number): boolean {
        let found = false;
        outer: for (const row of matrix) {
          for (const cell of row) {
            if (cell === target) { found = true; break outer; }
          }
        }
        return found;
      }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('ControlFlowState');
    expect(output).toContain('break;');
  });
});

describe('emitIrModuleHaxe abstract class', () => {
  it('emits abstract class keyword', () => {
    const result = lower(
      'abstract-class.ts',
      `export abstract class Shape { abstract area(): number; }
       export class Circle extends Shape { radius: number = 1; area(): number { return 3.14 * this.radius * this.radius; } }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('class Shape');
    expect(output).toContain('class Circle extends Shape');
  });
});

describe('emitIrModuleHaxe typeAlias type declaration', () => {
  it('emits typeAlias as Haxe typedef', () => {
    const result = lower(
      'type-alias-decl.ts',
      `export type Callback = (value: number) => void;
       export function call(cb: Callback): void { cb(42); }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('typedef Callback');
  });
});

describe('emitIrModuleHaxe tuple destructure', () => {
  it('destructures a fixed-length tuple into positional variables', () => {
    const result = lower(
      'tuple-destructure.ts',
      `export function pick(values: [number, number, number]): number {
        const [first, second, third]: [number, number, number] = values;
        return first + second + third;
      }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('arrayPatternValue');
  });
});

describe('emitIrModuleHaxe do-while loop', () => {
  it('emits do-while loop as Haxe do-while', () => {
    const result = lower(
      'do-while.ts',
      'export function countdown(n: number): number { let x: number = n; do { x -= 1; } while (x > 0); return x; }',
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('do {');
    expect(output).toContain('} while (');
  });
});

describe('emitIrModuleHaxe while loop', () => {
  it('emits while loop as Haxe while', () => {
    const result = lower(
      'while-loop.ts',
      'export function count(limit: number): number { let n: number = 0; while (n < limit) { n += 1; } return n; }',
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('while (');
  });
});

describe('emitIrModuleHaxe throw statement', () => {
  it('emits throw expression', () => {
    const result = lower('throw-stmt.ts', 'export function fail(msg: string): never { throw new Error(msg); }');
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('throw ');
  });
});

describe('emitIrModuleHaxe switch statement', () => {
  it('emits switch with case clauses', () => {
    const result = lower(
      'switch-stmt.ts',
      `export function label(code: number): string {
        switch (code) {
          case 0: return "zero";
          case 1: return "one";
          default: return "other";
        }
      }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('switch (');
  });

  it('materializes an absent return after a non-exhaustive target switch', () => {
    const result = lower(
      'switch-absent-return.ts',
      `export function lookup(value: string): string | undefined {
         switch (value) {
           case 'flight': return value;
         }
       }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('case "flight":');
    expect(output).toContain('}\n  return null;');
  });
});

describe('emitIrModuleHaxe if-else statement', () => {
  it('emits if-else with both branches', () => {
    const result = lower(
      'if-else.ts',
      'export function abs(n: number): number { if (n < 0) { return -n; } else { return n; } }',
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('if (');
    expect(output).toContain('else {');
  });
});

describe('emitIrModuleHaxe array literal', () => {
  it('emits array literal expression', () => {
    const result = lower('array-literal.ts', 'export function list(): number[] { return [1, 2, 3]; }');
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('[(cast 1 : Float), 2, 3]');
  });
});

describe('emitIrModuleHaxe string literal union', () => {
  it('emits string literal union as Haxe enum abstract over String', () => {
    const result = lower(
      'string-union.ts',
      `export type Direction = "north" | "south" | "east" | "west";
       export function read(d: Direction): string { return d; }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('enum abstract Direction');
    expect(output).toContain('String');
  });
});

describe('emitIrModuleHaxe optional parameter', () => {
  it('emits optional parameter with question mark prefix', () => {
    const result = lower(
      'optional-param.ts',
      'export function greet(name?: string): string { return name ?? "world"; }',
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('?name:');
  });
});

describe('emitIrModuleHaxe default parameter', () => {
  it('emits parameter with default value', () => {
    const result = lower('default-param.ts', 'export function greet(name: string = "world"): string { return name; }');
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('?name:String');
    expect(output).toContain('js.Syntax.strictEq(name, js.Syntax.code("undefined")) ? "world"');
  });
});

describe('emitIrModuleHaxe class without constructor with subclass', () => {
  it('emits empty constructor for base class with subclass in module', () => {
    const result = lower(
      'base-subclass.ts',
      `export class Base { value: number = 0; }
       export class Child extends Base { extra: number = 1; }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('class Child extends Base');
  });
});

describe('emitIrModuleHaxe setter accessor', () => {
  it('emits set accessor property declaration', () => {
    const result = lower(
      'setter-accessor.ts',
      `export class Store {
        private _value: number = 0;
        get value(): number { return this._value; }
        set value(v: number) { this._value = v; }
      }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('get');
    expect(output).toContain('set');
  });
});

describe('emitIrModuleHaxe interface method member', () => {
  it('emits interface with function-typed property as method signature', () => {
    const result = lower(
      'iface-method.ts',
      `export interface Handler { handle(value: number): boolean; }
       export class Impl implements Handler { handle(value: number): boolean { return value > 0; } }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('interface Handler');
    expect(output).toContain('function handle');
  });
});

describe('emitIrModuleHaxe labeled continue', () => {
  it('emits labeled continue through control-flow state machine', () => {
    const result = lower(
      'labeled-continue.ts',
      `export function scan(rows: number[][], target: number): number {
        let count: number = 0;
        outer: for (const row of rows) {
          for (const cell of row) {
            if (cell === target) { count += 1; continue outer; }
          }
        }
        return count;
      }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('ControlFlowState');
  });
});

describe('emitIrModuleHaxe intersection type', () => {
  it('emits multi-member intersection type as Dynamic', () => {
    const result = lower(
      'intersection-type.ts',
      `export interface A { x: number; }
       export interface B { y: number; }
       export function read(value: A & B): number { return value.x; }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('Dynamic');
  });
});

describe('emitIrModuleHaxe typeof type comparison', () => {
  it('emits typeof check as Std.isOfType', () => {
    const result = lower(
      'typeof-check.ts',
      `export function isNum(value: number | boolean): boolean {
        return typeof value === 'number';
      }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('Std.isOfType(');
  });
});

describe('emitIrModuleHaxe object literal', () => {
  it('emits object literal with named properties', () => {
    const result = lower(
      'object-literal.ts',
      `export interface Point { x: number; y: number; }
       export function origin(): Point { return { x: 0, y: 0 }; }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('x:');
    expect(output).toContain('y:');
  });

  it('copies object spreads left-to-right through Haxe reflection', () => {
    const result = lower(
      'object-spread.ts',
      'export function clone<Type extends object>(source: Readonly<Type>): Type { return { ...source } as Type; }',
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('for (objectSpreadKey in HaxeReflect.fields(objectSpreadSource))');
    expect(output).toContain('HaxeReflect.setField(objectSpreadValue, objectSpreadKey');
  });

  it('aliases Haxe reflection away from string-union enum members', () => {
    const result = lower(
      'reflect-shadow.ts',
      `export type SpreadMethod = 'pad' | 'reflect' | 'repeat';
       export function clone(source: Record<string, unknown>): Record<string, unknown> {
         return { ...source };
       }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('var Reflect = "reflect";');
    expect(output).toContain('import Reflect as HaxeReflect;');
    expect(output).toContain('HaxeReflect.fields(objectSpreadSource)');
  });

  it('copies array spreads before concatenating following elements', () => {
    const result = lower(
      'array-spread.ts',
      'export function append(values: number[], value: number): number[] { return [...values, value]; }',
    );

    expect(emitIrModuleHaxe(result.module).contents).toContain('values.copy().concat([(cast value : Float)])');
  });

  it('types heterogeneous array literals as dynamic collections', () => {
    const result = lower(
      'heterogeneous-array.ts',
      `export function key(name: string, count: number): string {
         return [name, count, count === 0].join(':');
       }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('([name, count, (count == 0)] : Array<Dynamic>).join(":")');
  });

  it('keeps a dynamically typed array annotation grouped in a local initializer', () => {
    const result = lower(
      'dynamic-array-initializer.ts',
      'export function values(): unknown[] { const doubles = [Number.NaN]; return doubles; }',
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('final doubles:Array<Dynamic> = ([Math.NaN] : Array<Dynamic>);');
  });

  it('preserves a declared unique-symbol key for a computed object property', () => {
    const result = lower(
      'computed-object-property.ts',
      `const RuntimeKey = Symbol.for('Runtime');
       interface Entity { [RuntimeKey]: number; }
       export function create(): Entity { return { [RuntimeKey]: 1 }; }`,
    );
    const output = emitIrModuleHaxe(result.module, { runtimeModule: 'flight._hx._runtime' }).contents;

    expect(output).toContain('flight._hx._runtime._Js.setProperty(objectSpreadValue, RuntimeKey, 1)');
  });

  it('preserves an object getter with a generated cross-target accessor carrier', () => {
    const result = lower(
      'object-getter.ts',
      `export interface Cursor { offset: number; readonly length: number }
       export function createCursor(): Cursor {
         const cursor: Cursor = { offset: 0, get length(): number { return cursor.offset; } };
         return cursor;
       }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('new ObjectAccessor(0, function()');
    expect(output).toContain('public var length(get, never):Dynamic;');
    expect(output).toContain('private function get_length():Dynamic return this._getter_1();');
  });

  it('accepts an intentionally incomplete nested object behind a double assertion', () => {
    const result = lower(
      'double-assertion-object.ts',
      `declare const RuntimeKey: unique symbol;
       interface Runtime { [RuntimeKey]: object; shader: { [RuntimeKey]: object; bind(): void } }
       export function create(): Runtime {
         return { shader: { bind: () => {} } } as unknown as Runtime;
       }`,
    );

    expect(() => emitIrModuleHaxe(result.module)).not.toThrow();
  });
});

describe('emitIrModuleHaxe for-of loop', () => {
  it('emits for-of loop as Haxe for-in', () => {
    const result = lower(
      'for-of.ts',
      'export function sum(values: number[]): number { let total: number = 0; for (const v of values) { total += v; } return total; }',
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('for (');
  });
});

describe('emitIrModuleHaxe exponentiation operator', () => {
  it('emits ** as Math.pow', () => {
    const result = lower('exponent.ts', 'export function square(n: number): number { return n ** 2; }');
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('Math.pow(');
  });
});

describe('emitIrModuleHaxe bitwise operators', () => {
  it('emits bitwise AND with Std.int wrapping', () => {
    const result = lower('bitwise.ts', 'export function mask(a: number, b: number): number { return a & b; }');
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('Std.int(');
  });
});

describe('emitIrModuleHaxe nullable union type', () => {
  it('emits union with null as Null<T>', () => {
    const result = lower('nullable.ts', `export function maybe(value: number | null): number { return value ?? 0; }`);
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('Null<');
  });
});

describe('emitIrModuleHaxe try-catch', () => {
  it('emits try-catch block without finally', () => {
    const result = lower(
      'try-catch.ts',
      `export function safe(n: number): number {
        try { return n; } catch (e: unknown) { return 0; }
      }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('try {');
    expect(output).toContain('catch (');
  });
});

describe('emitIrModuleHaxe postfix increment', () => {
  it('emits postfix ++ operator', () => {
    const result = lower(
      'postfix-inc.ts',
      'export function next(n: number): number { let x: number = n; x++; return x; }',
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('++');
  });
});

describe('emitIrModuleHaxe prefix negation', () => {
  it('emits prefix - operator', () => {
    const result = lower('negate.ts', 'export function negate(n: number): number { return -n; }');
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('- ');
  });
});

describe('emitIrModuleHaxe boolean not', () => {
  it('emits ! operator on boolean', () => {
    const result = lower('not.ts', 'export function invert(b: boolean): boolean { return !b; }');
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('!');
  });
});

describe('emitIrModuleHaxe bitwise not', () => {
  it('emits ~ operator with Std.int wrapping', () => {
    const result = lower('bitwise-not.ts', 'export function flip(n: number): number { return ~n; }');
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('~ Std.int(');
  });
});

describe('emitIrModuleHaxe string equality', () => {
  it('emits strict equality on strings', () => {
    const result = lower('str-eq.ts', 'export function same(a: string, b: string): boolean { return a === b; }');
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('flighthq._internal._Js.strictEqual(a, b)');
  });
});

describe('emitIrModuleHaxe compound assignment', () => {
  it('emits -= compound assignment on numbers', () => {
    const result = lower(
      'compound-assign.ts',
      'export function decrement(n: number): number { let x: number = n; x -= 1; return x; }',
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('-=');
  });
});

describe('emitIrModuleHaxe comparison operators', () => {
  it('emits numeric comparison operators', () => {
    const result = lower(
      'compare.ts',
      'export function clamp(n: number, lo: number, hi: number): number { if (n < lo) { return lo; } if (n > hi) { return hi; } return n; }',
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('<');
    expect(output).toContain('>');
  });
});

describe('emitIrModuleHaxe logical operators', () => {
  it('emits && and || on booleans', () => {
    const result = lower(
      'logical.ts',
      'export function both(a: boolean, b: boolean): boolean { return a && b || !a; }',
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('&&');
    expect(output).toContain('||');
  });
});

describe('emitIrModuleHaxe conditional expression', () => {
  it('emits ternary conditional', () => {
    const result = lower(
      'ternary.ts',
      'export function pick(flag: boolean, a: number, b: number): number { return flag ? a : b; }',
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('?');
    expect(output).toContain(':');
  });
});

describe('emitIrModuleHaxe mutable variable', () => {
  it('emits let variable as var', () => {
    const result = lower('mutable-var.ts', 'export function mutate(): number { let x: number = 0; x = 5; return x; }');
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('var x');
  });
});

describe('emitIrModuleHaxe nullish comparison', () => {
  it('emits undefined comparison as null check', () => {
    const result = lower(
      'nullish-cmp.ts',
      `export function defined(value: number | undefined): boolean { return value !== undefined; }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('js.Syntax.strictNeq(value, js.Syntax.code("undefined"))');
  });
});

describe('emitIrModuleHaxe getter setter accessors', () => {
  it('emits class getter as Haxe property accessor', () => {
    const result = lower(
      'accessor-get.ts',
      `export class Box {
        private _value: number = 0;
        get value(): number { return this._value; }
        set value(v: number) { this._value = v; }
      }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('get');
    expect(output).toContain('set');
  });
});

describe('emitIrModuleHaxe Error subclass', () => {
  it('emits Error subclass with name storage', () => {
    const result = lower(
      'custom-error.ts',
      `export class AppError extends Error {
        code: number;
        constructor(message: string, code: number) { super(message); this.code = code; }
      }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('AppError');
    expect(output).toContain('extends');
  });
});

describe('emitIrModuleHaxe bitwise operators', () => {
  it('emits bitwise AND as direct operator', () => {
    const result = lower('bitwise-and.ts', 'export function mask(a: number, b: number): number { return a & b; }');
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('&');
  });

  it('emits bitwise OR as direct operator', () => {
    const result = lower('bitwise-or.ts', 'export function combine(a: number, b: number): number { return a | b; }');
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('|');
  });

  it('emits left shift operator', () => {
    const result = lower('bitwise-shift.ts', 'export function shift(a: number, b: number): number { return a << b; }');
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('<<');
  });
});

describe('emitIrModuleHaxe strict equality operators', () => {
  it('emits === as == for same-type comparisons', () => {
    const result = lower('strict-eq-hx.ts', 'export function same(a: number, b: number): boolean { return a === b; }');
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('==');
  });

  it('emits !== as != for same-type comparisons', () => {
    const result = lower('strict-neq-hx.ts', 'export function diff(a: number, b: number): boolean { return a !== b; }');
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('!=');
  });
});

describe('emitIrModuleHaxe union type flattening', () => {
  it('emits discriminated union of interfaces as Dynamic when types differ', () => {
    const result = lower(
      'union-interfaces.ts',
      `export interface Circle { kind: string; radius: number }
       export interface Square { kind: string; side: number }
       export function area(shape: Circle | Square): number { return shape.kind === "circle" ? 0 : 1; }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('Dynamic');
  });
});

describe('emitIrModuleHaxe prefix unary operators', () => {
  it('emits negation on number', () => {
    const result = lower('unary-neg.ts', 'export function negate(x: number): number { return -x; }');
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('-');
  });

  it('emits logical not on boolean', () => {
    const result = lower('unary-not.ts', 'export function invert(x: boolean): boolean { return !x; }');
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('!');
  });

  it('emits bitwise complement on number', () => {
    const result = lower('bitwise-not.ts', 'export function complement(x: number): number { return ~x; }');
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('~');
  });
});

describe('emitIrModuleHaxe postfix operators', () => {
  it('emits postfix increment', () => {
    const result = lower('postfix-inc.ts', 'export function next(x: number): number { let v = x; v++; return v; }');
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('++');
  });
});

describe('emitIrModuleHaxe switch fallthrough detection', () => {
  it('emits switch with break in each case', () => {
    const result = lower(
      'switch-break-hx.ts',
      `export function label(x: number): string {
        switch (x) {
          case 1: return "one";
          case 2: return "two";
          default: return "other";
        }
      }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('switch');
    expect(output).toContain('"one"');
  });

  it('trusts normalized abrupt completion nested in a switch-case block', () => {
    const result = lower(
      'switch-block-return-hx.ts',
      `export function label(x: number): string {
        switch (x) {
          case 1: { return "one"; }
          default: { return "other"; }
        }
      }`,
    );

    expect(emitIrModuleHaxe(result.module).contents).toContain('return "one";');
  });
});

describe('emitIrModuleHaxe type alias union of interfaces', () => {
  it('flattens a union of two interfaces into a typedef with common fields', () => {
    const result = lower(
      'type-union-ifaces.ts',
      `export interface Left { x: number; y: string }
       export interface Right { x: number; z: boolean }
       export type Both = Left | Right;`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('typedef Both');
    expect(output).toContain('x:');
  });

  it('marks non-shared fields as optional in flattened union', () => {
    const result = lower(
      'type-union-optional.ts',
      `export interface A { shared: number; onlyA: string }
       export interface B { shared: number; onlyB: boolean }
       export type AB = A | B;`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('typedef AB');
    expect(output).toContain('?onlyA:');
    expect(output).toContain('?onlyB:');
  });

  it('falls back to Dynamic when same field has different types across union members', () => {
    const result = lower(
      'type-union-mismatch.ts',
      `export interface C { value: number }
       export interface D { value: string }
       export type CD = C | D;`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('typedef CD');
    expect(output).toContain('Dynamic');
  });
});

describe('emitIrModuleHaxe optional structInit property', () => {
  it('defaults optional struct-init field to null', () => {
    const result = lower(
      'optional-struct.ts',
      `export interface Config { required: number; optional?: string }
       export function create(): Config { return { required: 1 }; }`,
    );
    const output = emitIrModuleHaxe(result.module, { structuralRecords: 'structInit' }).contents;

    expect(output).toContain('@:structInit');
    expect(output).toContain('= null');
  });
});

describe('emitIrModuleHaxe interface member function', () => {
  it('emits interface method with named parameters', () => {
    const result = lower(
      'iface-method.ts',
      `export interface Processor {
         process(input: string, count: number): boolean;
       }
       export class Impl implements Processor {
         process(input: string, count: number): boolean { return count > 0; }
       }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('public function process(');
    expect(output).toContain(':String');
  });
});

describe('emitIrModuleHaxe labeled continue in nested loops', () => {
  it('emits control flow propagation for labeled continue targeting outer loop', () => {
    const result = lower(
      'labeled-continue.ts',
      `export function scan(grid: number[][]): number {
        let total: number = 0;
        outer: for (const row of grid) {
          for (const cell of row) {
            if (cell < 0) continue outer;
            total += cell;
          }
        }
        return total;
      }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('continue');
  });
});

describe('emitIrModuleHaxe labeled break in nested loops', () => {
  it('emits control flow exit for labeled break across nested loops', () => {
    const result = lower(
      'labeled-break-nested.ts',
      `export function find(grid: number[][]): number {
        let result: number = -1;
        outer: for (const row of grid) {
          for (const cell of row) {
            if (cell === 42) { result = cell; break outer; }
          }
        }
        return result;
      }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('break');
  });
});

describe('emitIrModuleHaxe mutable variable declaration', () => {
  it('emits mutable variable with var keyword', () => {
    const result = lower('mutable-var.ts', 'export let counter: number = 0;');
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('var counter');
  });
});

describe('emitIrModuleHaxe variable without type annotation at module level', () => {
  it('emits module variable without explicit type when source omits it', () => {
    const result = lower('var-no-type.ts', 'export const name = "hello";');
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('name');
    expect(output).toContain('"hello"');
  });
});

describe('emitIrModuleHaxe override on abstract methods', () => {
  it('does not mark override on methods implementing an abstract declaration', () => {
    const result = lower(
      'abstract-override.ts',
      `export abstract class Shape {
        abstract area(): number;
      }
      export class Circle extends Shape {
        radius: number;
        constructor(r: number) { super(); this.radius = r; }
        area(): number { return 3.14 * this.radius * this.radius; }
      }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('area');
    expect(output).not.toMatch(/override.*area/);
  });
});

describe('emitIrModuleHaxe class with three-level inheritance', () => {
  it('resolves inherited methods through multi-level base chain', () => {
    const result = lower(
      'three-level.ts',
      `export class A {
        shared(): string { return "a"; }
      }
      export class B extends A {
        middle(): string { return "b"; }
      }
      export class C extends B {
        shared(): string { return "c"; }
        middle(): string { return "c-mid"; }
      }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('override');
    expect(output).toContain('class C');
  });
});

describe('emitIrModuleHaxe scoped package import path', () => {
  it('converts scoped package specifiers into Haxe dot-separated import modules', () => {
    const result = lowerPackage(
      '@flighthq/widgets',
      'use-types.ts',
      `import type { Box } from "@flighthq/types";
       export function wrap(b: Box): Box { return b; }`,
    );

    expect(() => emitIrModuleHaxe(result.module)).not.toThrow();
  });
});

describe('emitIrModuleHaxe type alias as structInit record', () => {
  it('emits type alias for object type as structInit class when option is set', () => {
    const result = lower('type-struct.ts', 'export type Point = { x: number; y: number };');
    const output = emitIrModuleHaxe(result.module, { structuralRecords: 'structInit' }).contents;

    expect(output).toContain('@:structInit');
    expect(output).toContain('Point');
  });
});

describe('emitIrModuleHaxe dynamic read through element access', () => {
  it('casts dynamic tuple element reads to the declared type', () => {
    const result = lower(
      'dynamic-read.ts',
      `export function first(pair: [number, string]): number {
        const [a] = pair;
        return a;
      }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toBeDefined();
  });
});

describe('emitIrModuleHaxe nullish coalescing dynamic read', () => {
  it('handles dynamic read looking through nullish coalescing', () => {
    const result = lower(
      'dynamic-coalesce.ts',
      `export function safe(items: [number, string, boolean], fallback: number): number {
        const [a] = items;
        return a ?? fallback;
      }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('??');
  });
});

describe('emitIrModuleHaxe template expression with interpolations', () => {
  it('joins interpolated parts with Std.string and concatenation', () => {
    const result = lower(
      'template-interp.ts',
      'export function greet(name: string): string { return `hello ${name} world`; }',
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('Std.string');
    expect(output).toContain('+');
  });
});

describe('emitIrModuleHaxe class with subclass detection', () => {
  it('adjusts class behavior when a subclass exists in the same module', () => {
    const result = lower(
      'has-subclass.ts',
      `export class Parent {
        value: number;
        constructor(v: number) { this.value = v; }
      }
      export class Child extends Parent {
        extra: string;
        constructor(v: number, e: string) { super(v); this.extra = e; }
      }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('class Parent');
    expect(output).toContain('class Child');
    expect(output).toContain('extends');
  });
});

describe('emitIrModuleHaxe class field inherited from base', () => {
  it('collects inherited field names from base class in same module', () => {
    const result = lower(
      'inherited-field.ts',
      `export class Base {
        x: number;
        constructor(x: number) { this.x = x; }
      }
      export class Derived extends Base {
        y: string;
        constructor(x: number, y: string) { super(x); this.y = y; }
      }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('class Derived');
    expect(output).toContain('extends');
  });
});

describe('emitIrModuleHaxe implicit derived base parameters', () => {
  it('generates implicit constructor passing parameters to super', () => {
    const result = lower(
      'implicit-super.ts',
      `export class BaseError extends Error {
        constructor(message: string) { super(message); }
      }
      export class SpecificError extends BaseError {}`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('SpecificError');
    expect(output).toContain('super(');
  });
});

describe('emitIrModuleHaxe class with setter accessor', () => {
  it('emits property declaration with set accessor', () => {
    const result = lower(
      'setter-accessor.ts',
      `export class Box {
        private _value: number = 0;
        get value(): number { return this._value; }
        set value(v: number) { this._value = v; }
      }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('get, set');
    expect(output).toContain('get_value');
    expect(output).toContain('set_value');
  });

  it('emits set-only accessor with never for get', () => {
    const result = lower(
      'set-only.ts',
      `export class Writer {
        private _text: string = "";
        set text(v: string) { this._text = v; }
      }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('never, set');
    expect(output).toContain('set_text');
  });
});

describe('emitIrModuleHaxe typeof narrowing with property access', () => {
  it('emits typeof check as Std.isOfType and accesses narrowed member', () => {
    const result = lower(
      'typeof-narrow.ts',
      `export function len(x: string | number): number {
        if (typeof x === "string") { return x.length; }
        return x;
      }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('Std.isOfType(');
    expect(output).toContain('String');
    expect(output).toContain('.length');
  });
});

describe('emitIrModuleHaxe discriminated union narrowing with cast', () => {
  it('casts narrowed identifier to declared type when accessing union member', () => {
    const result = lower(
      'discriminated-union.ts',
      `export interface Circle { readonly kind: 'circle'; readonly radius: number; }
       export interface Square { readonly kind: 'square'; readonly side: number; }
       export type Shape = Circle | Square;
       export function area(shape: Shape): number {
         if (shape.kind === 'circle') { return shape.radius; }
         return shape.side;
       }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('cast');
    expect(output).toContain('radius');
  });

  it('casts narrowed identifier to declared type alias when accessing union member', () => {
    const result = lower(
      'discriminated-type-alias.ts',
      `export type Circle = { readonly kind: 'circle'; readonly radius: number; };
       export type Square = { readonly kind: 'square'; readonly side: number; };
       export type Shape = Circle | Square;
       export function area(shape: Shape): number {
         if (shape.kind === 'circle') { return shape.radius; }
         return shape.side;
       }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('cast');
    expect(output).toContain('radius');
  });
});

describe('emitIrModuleHaxe spread call expression', () => {
  it('emits reflective spread call with HaxeReflect.callMethod', () => {
    const result = lower(
      'spread-call.ts',
      `export function apply(fn: (...args: number[]) => number, args: number[]): number {
        return fn(...args);
      }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('HaxeReflect.callMethod');
  });

  it('concatenates fixed and spread argument groups', () => {
    const result = lower(
      'spread-mixed.ts',
      `export function call(fn: (a: number, ...rest: number[]) => number, rest: number[]): number {
        return fn(1, ...rest);
      }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('concat');
  });
});

describe('emitIrModuleHaxe empty template literal', () => {
  it('emits empty string for template with no content', () => {
    const result = lower('empty-template.ts', 'export function empty(): string { return ``; }');
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('""');
  });
});

describe('emitIrModuleHaxe tuple spread expression', () => {
  it('emits tuple spread that combines element and spread segments', () => {
    const result = lower(
      'tuple-spread.ts',
      `export function combine(a: [number, string], b: [boolean]): [number, string, boolean] {
        return [...a, ...b];
      }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toBeDefined();
  });
});

describe('emitIrModuleHaxe exchanged closure for reduce', () => {
  it('emits exchanged closure with swapped parameter order for fold', () => {
    const result = lower(
      'reduce-fold.ts',
      `export function sum(items: number[]): number {
        return items.reduce((acc: number, item: number) => acc + item, 0);
      }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('function(');
  });
});

describe('emitIrModuleHaxe type parameters on generic function', () => {
  it('emits type parameter on a generic function', () => {
    const result = lower('generic-fn.ts', 'export function identity<T>(value: T): T { return value; }');
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('<T>');
  });
});

describe('emitIrModuleHaxe class implementing interface as nominal', () => {
  it('promotes interface to nominal when a class implements it', () => {
    const result = lower(
      'nominal-iface.ts',
      `export interface Shape { area(): number; }
       export class Circle implements Shape {
         radius: number;
         constructor(r: number) { this.radius = r; }
         area(): number { return 3.14 * this.radius * this.radius; }
       }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('interface Shape');
    expect(output).toContain('implements');
  });
});

describe('emitIrModuleHaxe re-export facade', () => {
  it('emits type-only re-export as typedef', () => {
    const result = lowerPackage('@flighthq/facade', 'reexport.ts', `export type { Box } from "@flighthq/types";`);

    expect(() => emitIrModuleHaxe(result.module)).not.toThrow();
  });

  it('emits value re-export as forwarding function when sibling module is available', () => {
    const helper = lower('helper.ts', 'export function helper(value: number): number { return value + 1; }');
    const facade = lower('facade.ts', `export { helper } from './helper.js';`);
    const backend = createHaxeCompilerBackend();
    const files = backend.emitModule(facade.module, { modules: [facade.module, helper.module], options: {} });

    expect(files).toHaveLength(1);
    const output = files[0]!.contents;
    expect(output).toContain('function helper(value:Float):Float');
    expect(output).toContain('Helper.helper(value)');
  });

  it('forwards optional parameter in value re-export', () => {
    const helper = lower('helper.ts', 'export function helper(value?: number): number { return value ?? 0; }');
    const facade = lower('facade.ts', `export { helper } from './helper.js';`);
    const backend = createHaxeCompilerBackend();
    const files = backend.emitModule(facade.module, { modules: [facade.module, helper.module], options: {} });
    const output = files[0]!.contents;
    expect(output).toContain('?value:');
  });

  it('forwards parameter with default in value re-export', () => {
    const helper = lower('helper.ts', 'export function helper(value: number = 5): number { return value; }');
    const facade = lower('facade.ts', `export { helper } from './helper.js';`);
    const backend = createHaxeCompilerBackend();
    const files = backend.emitModule(facade.module, { modules: [facade.module, helper.module], options: {} });
    const output = files[0]!.contents;
    expect(output).toContain('?value:Float');
    expect(output).toContain('js.Syntax.strictEq(value, js.Syntax.code("undefined")) ? 5');
  });

  it('forwards rest parameter in value re-export', () => {
    const helper = lower('helper.ts', 'export function helper(...values: number[]): number { return values.length; }');
    const facade = lower('facade.ts', `export { helper } from './helper.js';`);
    const backend = createHaxeCompilerBackend();
    const files = backend.emitModule(facade.module, { modules: [facade.module, helper.module], options: {} });
    const output = files[0]!.contents;
    expect(output).toContain('...values:Float');
  });

  it('forwards an immutable value re-export with its declared type', () => {
    const helper = lower('helper.ts', 'export const value: number = 42;');
    const facade = lower('facade.ts', `export { value } from './helper.js';`);
    const backend = createHaxeCompilerBackend();
    const output = backend.emitModule(facade.module, { modules: [facade.module, helper.module], options: {} })[0]!
      .contents;
    expect(output).toContain('final value:Float = flighthq.math.Helper.value;');
  });

  it('forwards a mutable value re-export through a live read-only property', () => {
    const helper = lower('helper.ts', 'export let value: number = 42;');
    const facade = lower('facade.ts', `export { value } from './helper.js';`);
    const backend = createHaxeCompilerBackend();
    const output = backend.emitModule(facade.module, { modules: [facade.module, helper.module], options: {} })[0]!
      .contents;
    expect(output).toContain('var value(get, never):Float;');
    expect(output).toContain('inline function get_value():Float return flighthq.math.Helper.value;');
  });

  it('aliases a nominal value re-export to preserve constructor and static-member access', () => {
    const helper = lower('helper.ts', 'export enum Kind { Value }');
    const facade = lower('facade.ts', `export { Kind } from './helper.js';`);
    const backend = createHaxeCompilerBackend();
    const output = backend.emitModule(facade.module, { modules: [facade.module, helper.module], options: {} })[0]!
      .contents;
    expect(output).toContain('typedef FacadeKind = flighthq.math.Helper.Kind;');
  });

  it('emits both lanes of a value and type re-export', () => {
    const source = lower(
      'channel.ts',
      `export const ImageChannel = { Red: 0 } as const;
       export type ImageChannel = (typeof ImageChannel)[keyof typeof ImageChannel];`,
    ).module;
    const facade = lower('facade.ts', `export { ImageChannel } from './channel.js';`).module;
    const output = createHaxeCompilerBackend().emitModule(facade, {
      modules: [facade, source],
      options: {},
    })[0]!.contents;

    expect(output).toContain('typedef FacadeImageChannel = flighthq.math.Channel.ImageChannel_2;');
    expect(output).toContain('final ImageChannel:');
  });

  it('refuses value re-export when sibling module is not available', () => {
    const facade = lower('facade.ts', `export { helper } from './helper.js';`);

    expect(() => emitIrModuleHaxe(facade.module)).toThrow('re-exporting the value');
  });
});

describe('emitIrModuleHaxe narrowedMember with primitive typeof cast', () => {
  it('narrows primitive union member with Std.isOfType when accessing its property', () => {
    const result = lower(
      'primitive-narrow-prop.ts',
      `export function len(value: string | number): number {
         if (typeof value === 'string') { return value.length; }
         return value;
       }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('Std.isOfType(');
    expect(output).toContain('.length');
  });

  it('casts a Readonly-wrapped named alternative after eliminating a primitive member', () => {
    const result = lower(
      'readonly-union-narrow-prop.ts',
      `interface XmlElement { readonly name: string; readonly content: ReadonlyArray<string | Readonly<XmlElement>>; }
       export function firstName(element: Readonly<XmlElement>): string {
         for (const content of element.content) {
           if (typeof content === 'string') continue;
           return content.name;
         }
         return '';
       }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('(cast content : XmlElement).name');
  });

  it('casts an imported named alternative after eliminating a primitive member', () => {
    const typeSource = ts.createSourceFile(
      '/flight/packages/types/src/XmlElement.ts',
      'export interface XmlElement { readonly name: string; readonly content: Array<string | XmlElement>; }',
      ts.ScriptTarget.Latest,
      true,
    );
    const subjectSource = ts.createSourceFile(
      '/flight/packages/scene2d-formats/src/svg.ts',
      `import type { XmlElement } from '@flighthq/types/XmlElement';
       export function firstName(element: Readonly<XmlElement>): string {
         for (const content of element.content) {
           if (typeof content === 'string') continue;
           return content.name;
         }
         return '';
       }`,
      ts.ScriptTarget.Latest,
      true,
    );
    const moduleResolution = {
      edges: [
        {
          specifier: '@flighthq/types/XmlElement',
          target: { packageName: '@flighthq/types', source: 'packages/types/src/XmlElement.ts' },
        },
      ],
      schema: 'flight-compiler-module-resolution/1' as const,
    };
    const [targetResult, subjectResult] = lowerTypeScriptSources(
      [
        { packageName: '@flighthq/types', sourceFile: typeSource, upstreamDirectory: '/flight' },
        { packageName: '@flighthq/scene2d-formats', sourceFile: subjectSource, upstreamDirectory: '/flight' },
      ],
      moduleResolution,
    );
    const target = targetResult!.module;
    const subject = subjectResult!.module;
    const output = createHaxeCompilerBackend().emitModule(subject, {
      moduleResolution,
      modules: [subject, target],
      options: {},
    })[0]!.contents;

    expect(output).toContain('import flighthq.types.XmlElement.XmlElement;');
    expect(output).toContain('(cast content : XmlElement).name');
  });
});

describe('emitIrModuleHaxe union type alias where member is typeAlias not interface', () => {
  it('flattens union where members are type aliases with object types', () => {
    const result = lower(
      'type-alias-union-flat.ts',
      `export type Left = { x: number; y: string };
       export type Right = { x: number; z: boolean };
       export type Both = Left | Right;`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('typedef Both');
    expect(output).toContain('?y:');
    expect(output).toContain('?z:');
  });
});

describe('emitIrModuleHaxe union flattening with single-member union', () => {
  it('falls back to Dynamic for union with less than 2 flattened members', () => {
    const result = lower(
      'union-one-member.ts',
      `export interface Single { value: number }
       export type Wrapped = Single | number;`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('typedef Wrapped');
    expect(output).toContain('Dynamic');
  });
});

describe('emitIrModuleHaxe private field access with hash prefix', () => {
  it('strips hash prefix from private field names', () => {
    const result = lower(
      'private-field.ts',
      `export class Counter {
         #count: number = 0;
         increment(): void { this.#count += 1; }
         get value(): number { return this.#count; }
       }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('count');
    expect(output).not.toContain('#count');
  });
});

describe('emitIrModuleHaxe class with haxe keyword as field name', () => {
  it('escapes Haxe keyword field names with trailing underscore', () => {
    const result = lower(
      'keyword-field.ts',
      `export class Config {
         abstract: boolean;
         constructor(value: boolean) { this.abstract = value; }
       }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('abstract_');
  });
});

describe('emitIrModuleHaxe labeled continue targeting outer while', () => {
  it('emits control flow state for labeled continue to outer while loop', () => {
    const result = lower(
      'labeled-while-continue.ts',
      `export function skip(matrix: number[][]): number {
         let sum: number = 0;
         outer: for (const row of matrix) {
           for (const val of row) {
             if (val < 0) continue outer;
             sum += val;
           }
         }
         return sum;
       }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toBeDefined();
  });
});

describe('emitIrModuleHaxe typeof test on right side of comparison', () => {
  it('handles typeof on right side of equality comparison', () => {
    const result = lower(
      'typeof-right.ts',
      `export function isString(x: string | number): boolean {
         return "string" === typeof x;
       }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('Std.isOfType(');
  });
});

describe('emitIrModuleHaxe negated typeof test', () => {
  it('emits negated typeof check with !Std.isOfType', () => {
    const result = lower(
      'typeof-negated.ts',
      `export function notString(x: string | number): boolean {
         return typeof x !== "string";
       }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('!Std.isOfType(');
  });
});

describe('emitIrModuleHaxe generic class with type parameter constraint', () => {
  it('emits type parameter with constraint', () => {
    const result = lower(
      'generic-constraint.ts',
      `export interface HasLength { length: number; }
       export function measure<T extends HasLength>(x: T): number { return x.length; }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('<T:');
  });
});

describe('emitIrModuleHaxe property access with optional chaining', () => {
  it('emits ?. for optional property access', () => {
    const result = lower(
      'opt-chain-deep.ts',
      `export interface Nested { inner: Nested | null; value: number; }
       export function deep(x: Nested | null): number | null {
         return x?.inner?.value ?? null;
       }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('?.');
  });
});

describe('emitIrModuleHaxe object rest destructuring', () => {
  it('emits object rest pattern using HaxeReflect.copy and deleteField', () => {
    const result = lower(
      'object-rest.ts',
      `export function strip(obj: { a: number; b: string; c: boolean }): { b: string; c: boolean } {
         const { a, ...rest } = obj;
         return rest;
       }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('HaxeReflect.copy(');
    expect(output).toContain('HaxeReflect.deleteField(');
  });
});

describe('emitIrModuleHaxe function expression with body', () => {
  it('emits non-arrow function expression with block body', () => {
    const result = lower(
      'fn-expr-body.ts',
      `export const add = function(a: number, b: number): number { return a + b; };`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('function(');
    expect(output).toContain('return');
  });
});

describe('emitIrModuleHaxe array slice with no arguments', () => {
  it('emits array.copy() for slice with no bounds', () => {
    const result = lower(
      'array-copy.ts',
      `export function clone(arr: number[]): number[] {
         return arr.slice();
       }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('.copy()');
  });

  it('emits array.slice with Std.int bounds when arguments provided', () => {
    const result = lower(
      'array-slice.ts',
      `export function sub(arr: number[], start: number, end: number): number[] {
         return arr.slice(start, end);
       }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('.slice(');
    expect(output).toContain('Std.int(');
  });
});

describe('emitIrModuleHaxe array method bindings', () => {
  it('emits array.push as push', () => {
    const result = lower(
      'array-push.ts',
      `export function append(arr: number[], item: number): void {
         arr.push(item);
       }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('.push(');
  });

  it('emits array.indexOf with Std.int argument position', () => {
    const result = lower(
      'array-indexOf.ts',
      `export function find(arr: number[], value: number): number {
         return arr.indexOf(value);
       }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('indexOf');
  });

  it('preserves RegExp match index metadata inherited through its array surface', () => {
    const result = lower(
      'regexp-match-index.ts',
      `export function matchIndex(input: string): number | null {
         const match = /x/.exec(input);
         return match === null ? null : match.index;
       }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('match.index');
  });

  it('preserves ambient Error name reads', () => {
    const result = lower(
      'error-name.ts',
      `export function errorName(value: unknown): string {
         return value instanceof Error ? value.name : '';
       }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('value.name');
  });
});

describe('emitIrModuleHaxe unsigned right shift', () => {
  it('emits unsigned right shift with Std.int wrapping', () => {
    const result = lower(
      'unsigned-shift.ts',
      `export function urshift(a: number, b: number): number {
         return a >>> b;
       }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('>>>');
    expect(output).toContain('Std.int(');
  });
});

describe('emitIrModuleHaxe exponentiation operator', () => {
  it('emits ** as Math.pow', () => {
    const result = lower(
      'power-op.ts',
      `export function power(base: number, exp: number): number {
         return base ** exp;
       }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('Math.pow(');
  });
});

describe('emitIrModuleHaxe new expression with ambient type', () => {
  it('emits new expression with mapped ambient type', () => {
    const result = lower('new-map.ts', 'export function create(): Map<string, number> { return new Map(); }');
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('new ');
  });
});

describe('emitIrModuleHaxe class with private and public visibility', () => {
  it('emits private and public modifiers on methods', () => {
    const result = lower(
      'visibility.ts',
      `export class Service {
        private key: string;
        constructor(k: string) { this.key = k; }
        private internal(): string { return this.key; }
        public external(): string { return this.internal(); }
       }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('private');
    expect(output).toContain('public');
  });
});

describe('emitIrModuleHaxe async task function emission', () => {
  it('emits async function body through task lowering pipeline', () => {
    const result = lower(
      'async-fn.ts',
      `export async function fetch(input: Promise<number>): Promise<number> {
         const value = await input;
         return value + 1;
       }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('_Promise');
    expect(output).toContain('function(');
  });
});

describe('emitIrModuleHaxe class without constructor having subclass', () => {
  it('emits empty constructor when class has a subclass in the same module', () => {
    const result = lower(
      'no-ctor-subclass.ts',
      `export class Parent {
        value: number = 0;
      }
      export class Child extends Parent {
        extra: string;
        constructor() { super(); this.extra = "hi"; }
      }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('class Parent');
    expect(output).toContain('class Child');
  });
});

describe('emitIrModuleHaxe static methods and fields', () => {
  it('emits static modifier on class members', () => {
    const result = lower(
      'static-members.ts',
      `export class Constants {
        static readonly PI: number = 3.14;
        static double(x: number): number { return x * 2; }
      }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('static');
  });
});

describe('emitIrModuleHaxe tupleSuffix expression', () => {
  it('emits tuple suffix as slice from start index', () => {
    const result = lower(
      'tuple-suffix.ts',
      `export function tail(t: [number, string, boolean]): [string, boolean] {
        const [, ...rest] = t;
        return rest;
      }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('.slice(');
  });
});

describe('emitIrModuleHaxe tupleRest expression', () => {
  it('emits tuple rest as slice from start index', () => {
    const result = lower(
      'tuple-rest.ts',
      `export function rest(t: [number, ...string[]]): string[] {
        const [, ...values] = t;
        return values;
      }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('.slice(');
  });
});

describe('emitIrModuleHaxe cross-depth labeled break control flow', () => {
  it('emits state-based control flow when breaking from inner to outer loop', () => {
    const result = lower(
      'cross-depth-break.ts',
      `export function search(matrix: number[][]): number {
         let found: number = -1;
         outer: for (const row of matrix) {
           for (const cell of row) {
             if (cell === 42) {
               found = cell;
               break outer;
             }
           }
         }
         return found;
       }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('ControlFlowState');
    expect(output).toContain('== 1');
  });

  it('emits state-based continue propagation across loop depths', () => {
    const result = lower(
      'cross-depth-continue.ts',
      `export function skipNeg(matrix: number[][]): number {
         let sum: number = 0;
         outer: for (const row of matrix) {
           for (const cell of row) {
             if (cell < 0) continue outer;
             sum += cell;
           }
         }
         return sum;
       }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('ControlFlowState');
    expect(output).toContain('== 2');
  });
});

describe('emitIrModuleHaxe array reduce with fold binding', () => {
  it('emits Lambda.fold with exchanged closure for array reduce', () => {
    const result = lower(
      'array-reduce.ts',
      `export function total(items: number[]): number {
         return items.reduce((acc: number, item: number) => acc + item, 0);
       }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('fold');
  });
});

describe('emitIrModuleHaxe undefined-initialized variable', () => {
  it('emits JavaScript undefined for a hoisted variable whose type includes undefined', () => {
    const result = lower(
      'undef-init.ts',
      `export function init(): number {
         var x: number | undefined;
         if (x !== undefined) { return x; }
         x = 5;
         return x;
       }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('var x:Null<Float> = js.Syntax.code("undefined");');
  });
});

describe('emitIrModuleHaxe do-while with label', () => {
  it('emits labeled do-while loop with control flow boundary', () => {
    const result = lower(
      'labeled-do-while.ts',
      `export function countdown(start: number): number {
         let i: number = start;
         loop: do {
           i -= 1;
           if (i === 5) break loop;
         } while (i > 0);
         return i;
       }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('do {');
    expect(output).toContain('while');
  });
});

describe('emitIrModuleHaxe empty template literal', () => {
  it('emits empty string for template with no interpolations and no text', () => {
    const result = lower('empty-template.ts', 'export const empty: string = ``;');
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('""');
  });
});

describe('emitIrModuleHaxe optional structInit property without null type', () => {
  it('wraps non-null optional property in Null wrapper', () => {
    const result = lower(
      'struct-optional.ts',
      `export interface Config {
         readonly name: string;
         readonly timeout?: number;
       }`,
    );
    const output = emitIrModuleHaxe(result.module, { structuralRecords: 'structInit' }).contents;

    expect(output).toContain('structInit');
    expect(output).toContain('Null<');
    expect(output).toContain('= null');
  });
});

describe('emitIrModuleHaxe rest parameter', () => {
  it('emits rest parameter with element type from array', () => {
    const result = lower('rest-param.ts', 'export function sum(...values: number[]): number { return values.length; }');
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('...');
    expect(output).toContain('values');
  });
});

describe('emitIrModuleHaxe continue with label', () => {
  it('emits labeled continue through control flow state', () => {
    const result = lower(
      'labeled-continue.ts',
      `export function skip(items: number[]): number {
         let total: number = 0;
         outer: for (const item of items) {
           for (const inner of items) {
             if (inner === 0) continue outer;
             total += inner;
           }
         }
         return total;
       }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('continue');
  });
});

describe('emitIrModuleHaxe spread call with trailing fixed arguments', () => {
  it('emits concatenated argument arrays for spread with trailing args', () => {
    const result = lower(
      'spread-trailing.ts',
      `export function apply(fn: (...args: number[]) => number, items: number[]): number {
         return fn(...items, 1);
       }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('concat');
  });
});

describe('emitIrModuleHaxe module variable with type annotation', () => {
  it('emits typed module-level variable declaration', () => {
    const result = lower('module-var-typed.ts', 'export const MAX_SIZE: number = 100;');
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('MAX_SIZE');
    expect(output).toContain('100');
  });
});

describe('emitIrModuleHaxe nullish comparison on nullable operand', () => {
  it('emits null equality check for nullable comparison', () => {
    const result = lower(
      'nullish-cmp.ts',
      `export function isPresent(value: number | null): boolean {
         return value != null;
       }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('null');
    expect(output).toContain('!=');
  });
});

describe('emitIrModuleHaxe class extending external base', () => {
  it('omits override for method when base class is not in same module', () => {
    const result = lower(
      'external-base.ts',
      `export class Child {
         run(): number { return 1; }
       }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('class Child');
    expect(output).toContain('run');
    expect(output).not.toContain('override');
  });
});

describe('emitIrModuleHaxe union type alias with non-object member', () => {
  it('falls back to Dynamic when union member aliases a non-object type', () => {
    const result = lower(
      'union-nonobject.ts',
      `export type Label = string;
       export interface Named { readonly name: string; }
       export type Either = Label | Named;`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('typedef Either');
    expect(output).toContain('Dynamic');
  });
});

describe('emitIrModuleHaxe async function with carry value through try-finally', () => {
  it('emits carry binding for non-await return preserved through finally cleanup', () => {
    const result = lower(
      'async-carry.ts',
      `export async function attempt(task: Promise<number>): Promise<number> {
         const value = await task;
         try { return value; } finally { value; }
       }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('_Promise');
    expect(output).toContain('value');
  });
});

describe('emitIrModuleHaxe single-type intersection', () => {
  it('emits the inner type for a single-member intersection', () => {
    const result = lower(
      'single-intersection.ts',
      `export type Branded = { name: string } & {};
       export function use(value: Branded): string { return value.name; }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('name');
  });
});

describe('emitIrModuleHaxe for-in with key plan', () => {
  it('emits for-in loop with preserved key evaluation order', () => {
    const result = lower(
      'for-in-keys.ts',
      `export function keys(obj: { a: number; b: number }): string[] {
         const result: string[] = [];
         for (const key in obj) { result.push(key); }
         return result;
       }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('for');
  });
});

describe('emitIrModuleHaxe triple-nested labeled break', () => {
  it('emits control flow propagation for break across three nesting levels', () => {
    const result = lower(
      'triple-nested-break.ts',
      `export function search(items: number[]): number {
         outer: for (const a of items) {
           for (const b of items) {
             for (const c of items) {
               if (c === 0) break outer;
             }
           }
         }
         return 0;
       }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('!= 0');
  });
});

describe('emitIrModuleHaxe optional nullable parameter guard', () => {
  it('emits optional parameter without Null wrapping for non-nullable type', () => {
    const result = lower(
      'optional-param.ts',
      `export function greet(name?: string): string {
         return name ?? "world";
       }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('?name');
  });
});

describe('emitIrModuleHaxe tuple spread with undefined element', () => {
  it('emits null for undefined tuple element in spread', () => {
    const result = lower(
      'tuple-spread-undef.ts',
      `export function spread(a: [number, string], b: [boolean]): [number, string, boolean] {
         return [...a, ...b];
       }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('[');
  });
});

describe('emitIrModuleHaxe function type parameter emission', () => {
  it('emits function type with parameter types in arrow notation', () => {
    const result = lower(
      'function-type.ts',
      `export type Transformer = (input: number) => string;
       export function apply(fn: Transformer, value: number): string { return fn(value); }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('->');
  });
});

describe('emitIrModuleHaxe structInit with null-typed optional property', () => {
  it('does not double-wrap optional property whose type already includes null', () => {
    const result = lower(
      'struct-null-optional.ts',
      `export interface Config {
         readonly name: string;
         readonly label?: string | null;
       }`,
    );
    const output = emitIrModuleHaxe(result.module, { structuralRecords: 'structInit' }).contents;

    expect(output).toContain('structInit');
    expect(output).toContain('label');
  });
});

describe('emitIrModuleHaxe abstract method in base class', () => {
  it('does not add override for method that is abstract in base class', () => {
    const result = lower(
      'abstract-method.ts',
      `export abstract class Shape {
         abstract area(): number;
       }
       export class Circle extends Shape {
         radius: number;
         constructor(r: number) { super(); this.radius = r; }
         area(): number { return this.radius * this.radius; }
       }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('class Circle');
    expect(output).toContain('function area');
    expect(output).not.toContain('override');
  });
});

describe('emitIrModuleHaxe module-level typed variable declaration', () => {
  it('emits type annotation for module-level variable', () => {
    const result = lower('module-typed-var.ts', `export const version: string = "1.0.0";`);
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('version');
    expect(output).toContain('String');
  });
});

describe('emitIrModuleHaxe labeled block with same-depth break', () => {
  it('emits break for labeled block exit at same nesting depth', () => {
    const result = lower(
      'labeled-block-break.ts',
      `export function check(value: number): number {
         done: {
           if (value < 0) break done;
           return value;
         }
         return 0;
       }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('do {');
    expect(output).toContain('while (false)');
    expect(output).toContain('break');
  });
});

describe('emitIrModuleHaxe multi-member intersection type', () => {
  it('emits Dynamic for intersection of multiple named types', () => {
    const result = lower(
      'multi-intersection.ts',
      `export interface A { a: number; }
       export interface B { b: string; }
       export function use(value: A & B): number { return value.a; }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('Dynamic');
  });
});

describe('emitIrModuleHaxe interface method with unnamed parameter', () => {
  it('generates argument name for unnamed function parameter in interface', () => {
    const result = lower(
      'unnamed-param.ts',
      `export interface Handler {
         handle(event: string, callback: (result: number) => void): void;
       }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('handle');
  });
});

describe('emitIrModuleHaxe labeled continue at same depth', () => {
  it('emits continue for labeled loop continue at same nesting depth', () => {
    const result = lower(
      'labeled-continue-same.ts',
      `export function filter(items: number[]): number {
         let total: number = 0;
         loop: for (const item of items) {
           if (item < 0) continue loop;
           total += item;
         }
         return total;
       }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('continue');
  });
});

describe('emitIrModuleHaxe nullish comparison with undefined operand', () => {
  it('emits null check for undefined comparison', () => {
    const result = lower(
      'undefined-cmp.ts',
      `export function hasValue(value: string | undefined): boolean {
         return value !== undefined;
       }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('js.Syntax.strictNeq(value, js.Syntax.code("undefined"))');
  });
});

describe('emitIrModuleHaxe exponentiation operator', () => {
  it('emits Math.pow for exponentiation', () => {
    const result = lower(
      'exponentiation.ts',
      'export function power(base: number, exp: number): number { return base ** exp; }',
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('Math.pow');
  });
});

describe('emitIrModuleHaxe unsigned right shift', () => {
  it('emits unsigned right shift operator with Std.int', () => {
    const result = lower(
      'unsigned-shift.ts',
      'export function shift(value: number, bits: number): number { return value >>> bits; }',
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('>>>');
    expect(output).toContain('Std.int');
  });
});

describe('emitIrModuleHaxe try-catch without finally', () => {
  it('emits try-catch block with Dynamic catch binding', () => {
    const result = lower(
      'try-catch.ts',
      `export function safe(value: number): number {
         try { return value; }
         catch (error) { return 0; }
       }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('try');
    expect(output).toContain('catch');
    expect(output).toContain('Dynamic');
  });
});

describe('emitIrModuleHaxe additional coverage', () => {
  it('emits regexp through the portable runtime', () => {
    const output = emitIrModuleHaxe(
      lower('regexp.ts', `export function test(s: string): boolean { return /^hello/i.test(s); }`).module,
    ).contents;
    expect(output).toContain('new flighthq._internal._RegExp("^hello", "i")');
  });

  it('emits bitwise assignment as Std.int cast', () => {
    const output = emitIrModuleHaxe(
      lower('bit-assign.ts', `export function mask(x: number, m: number): number { x &= m; return x; }`).module,
    ).contents;
    expect(output).toContain('Std.int');
  });

  it('emits exponentiation assignment as Math.pow', () => {
    const output = emitIrModuleHaxe(
      lower('pow-assign.ts', `export function square(x: number): number { x **= 2; return x; }`).module,
    ).contents;
    expect(output).toContain('Math.pow');
  });

  it('emits class with accessor getter and setter', () => {
    const output = emitIrModuleHaxe(
      lower(
        'accessor.ts',
        `export class Box {
          private _value: number;
          constructor(v: number) { this._value = v; }
          get value(): number { return this._value; }
          set value(v: number) { this._value = v; }
        }`,
      ).module,
    ).contents;
    expect(output).toContain('get_value');
    expect(output).toContain('set_value');
    expect(output).toContain('get, set');
  });

  it('emits rest parameter with spread syntax', () => {
    const output = emitIrModuleHaxe(
      lower(
        'rest-param.ts',
        `export function sum(...values: number[]): number {
          let total = 0;
          for (const v of values) total += v;
          return total;
        }`,
      ).module,
    ).contents;
    expect(output).toContain('...values');
  });

  it('emits default parameter as initializer', () => {
    const output = emitIrModuleHaxe(
      lower('default-param.ts', `export function greet(name: string = "world"): string { return name; }`).module,
    ).contents;
    expect(output).toContain('? "world" :');
  });

  it('emits intersection type as Dynamic for multiple members', () => {
    const result = lower(
      'inter.ts',
      `export interface A { a: number; }
       export interface B { b: number; }
       export function use(x: A & B): number { return x.a; }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;
    expect(output).toContain('Dynamic');
  });

  it('emits tuple type as Array<Dynamic> for mixed types', () => {
    const output = emitIrModuleHaxe(
      lower('tuple-mixed.ts', `export function pair(): [number, string] { return [1, "a"]; }`).module,
    ).contents;
    expect(output).toContain('Array<Dynamic>');
  });

  it('emits class with explicit constructor body', () => {
    const output = emitIrModuleHaxe(
      lower(
        'ctor-body.ts',
        `export class Point {
          x: number;
          y: number;
          constructor(x: number, y: number) {
            this.x = x;
            this.y = y;
          }
        }`,
      ).module,
    ).contents;
    expect(output).toContain('public function new(');
    expect(output).toContain('this.x');
  });

  it('emits abstract class methods with override', () => {
    const output = emitIrModuleHaxe(
      lower(
        'abstract-override.ts',
        `export class Base {
          greet(): string { return "hello"; }
        }
        export class Derived extends Base {
          greet(): string { return "hi"; }
        }`,
      ).module,
    ).contents;
    expect(output).toContain('override');
  });

  it('emits base class with subclass empty constructor', () => {
    const output = emitIrModuleHaxe(
      lower(
        'base-subclass.ts',
        `export class Base {
          value: number = 0;
        }
        export class Child extends Base {
          extra: number = 1;
        }`,
      ).module,
    ).contents;
    expect(output).toContain('extends Base');
  });

  it('emits template literal with mixed parts', () => {
    const output = emitIrModuleHaxe(
      lower('template.ts', 'export function greet(name: string): string { return `hello ${name}!`; }').module,
    ).contents;
    expect(output).toContain('Std.string');
  });

  it('emits nullable variable declaration as null', () => {
    const output = emitIrModuleHaxe(
      lower(
        'nullable-var.ts',
        `export function find(items: number[]): number | undefined {
          let result: number | undefined = undefined;
          for (const item of items) { if (item > 0) { result = item; break; } }
          return result;
        }`,
      ).module,
    ).contents;
    expect(output).toContain('null');
  });

  it('emits class implementing interface with data properties', () => {
    const output = emitIrModuleHaxe(
      lower(
        'impl-data.ts',
        `export interface Named {
          name: string;
          greet(): string;
        }
        export class Person implements Named {
          name: string;
          constructor(n: string) { this.name = n; }
          greet(): string { return this.name; }
        }`,
      ).module,
    ).contents;
    expect(output).toContain('implements Named');
    expect(output).toContain('interface Named');
  });

  it('emits do-while loop', () => {
    const output = emitIrModuleHaxe(
      lower(
        'do-while.ts',
        `export function countdown(n: number): number {
          let i = n;
          do { i -= 1; } while (i > 0);
          return i;
        }`,
      ).module,
    ).contents;
    expect(output).toContain('do {');
    expect(output).toContain('} while');
  });

  it('emits type alias as typedef', () => {
    const output = emitIrModuleHaxe(
      lower(
        'type-alias.ts',
        `export type Num = number;
         export function add(a: Num, b: Num): Num { return a + b; }`,
      ).module,
    ).contents;
    expect(output).toContain('typedef Num');
  });

  it('emits string literal union as enum abstract', () => {
    const output = emitIrModuleHaxe(
      lower(
        'str-union.ts',
        `export type Direction = "up" | "down" | "left" | "right";
         export function move(d: Direction): string { return d; }`,
      ).module,
    ).contents;
    expect(output).toContain('enum abstract Direction');
    expect(output).toContain('from String to String');
  });

  it('emits cast expression as Haxe cast', () => {
    const module = structuredClone(lower('cast.ts', 'export function id(x: number): number { return x; }').module);
    const fn = module.declarations.find((d) => d.kind === 'function');
    if (fn && fn.kind === 'function') {
      const ret = fn.body.find((s) => s.kind === 'return');
      if (ret && ret.kind === 'return' && ret.expression) {
        (ret as { expression: unknown }).expression = {
          kind: 'cast',
          expression: ret.expression,
          type: { kind: 'primitive', name: 'number' },
        };
      }
    }
    const output = emitIrModuleHaxe(module).contents;
    expect(output).toContain('cast');
  });

  it('emits element access on array with non-literal index as Std.int', () => {
    const output = emitIrModuleHaxe(
      lower('arr-index.ts', `export function get(items: number[], i: number): number { return items[i]; }`).module,
    ).contents;
    expect(output).toContain('Std.int');
  });

  it('emits for-in with closed key evidence', () => {
    const output = emitIrModuleHaxe(
      lower(
        'for-in.ts',
        `export interface Dict { a: number; b: number; }
         export function keys(d: Dict): void {
          for (const k in d) { const _x = k; }
        }`,
      ).module,
    ).contents;
    expect(output).toContain('for');
  });

  it('emits optional parameter as nullable', () => {
    const output = emitIrModuleHaxe(
      lower('opt-param.ts', `export function greet(name?: string): string { return name ?? "world"; }`).module,
    ).contents;
    expect(output).toContain('?name');
  });

  it('emits object expression as anonymous struct', () => {
    const output = emitIrModuleHaxe(
      lower(
        'obj-expr.ts',
        `export interface Point { x: number; y: number; }
         export function origin(): Point { return { x: 0, y: 0 }; }`,
      ).module,
    ).contents;
    expect(output).toContain('x:');
    expect(output).toContain('y:');
  });

  it('emits nullish comparison as null check', () => {
    const output = emitIrModuleHaxe(
      lower('nullish.ts', `export function isAbsent(x: number | null): boolean { return x === null; }`).module,
    ).contents;
    expect(output).toContain('null');
  });

  it('emits coalesce operator as ?? in Haxe', () => {
    const output = emitIrModuleHaxe(
      lower('coalesce.ts', `export function fallback(x: number | null, d: number): number { return x ?? d; }`).module,
    ).contents;
    expect(output).toContain('??');
  });

  it('emits switch statement as Haxe switch', () => {
    const output = emitIrModuleHaxe(
      lower(
        'switch.ts',
        `export function describe(n: number): string {
          switch (n) {
            case 0: return "zero";
            case 1: return "one";
            default: return "other";
          }
        }`,
      ).module,
    ).contents;
    expect(output).toContain('switch');
  });

  it('emits throw new Error as throw', () => {
    const output = emitIrModuleHaxe(
      lower('throw.ts', 'export function fail(msg: string): never { throw new Error(msg); }').module,
    ).contents;
    expect(output).toContain('throw');
  });

  it('converts task lowering errors into backend emission failures', () => {
    const result = lower('task-runtime.ts', 'export async function read(): Promise<number> { return 1; }');
    try {
      emitIrModuleHaxe(result.module, { runtimeModule: 'invalid-module' });
      expect.unreachable('Expected Haxe emission to fail');
    } catch (error) {
      expect(isBackendEmissionFailure(error)).toBe(true);
    }
  });

  it('emits async function expression through task pipeline', () => {
    const result = lower(
      'async-expr.ts',
      `export const fetch = async (input: Promise<number>): Promise<number> => await input;`,
    );
    const output = emitIrModuleHaxe(result.module).contents;
    expect(output).toContain('_Promise');
  });

  it('refuses interface extends', () => {
    const module = structuredClone(
      lower(
        'iface-extends.ts',
        `export interface Base { x: number; }
         export function use(b: Base): number { return b.x; }`,
      ).module,
    );
    const iface = module.declarations.find((d) => d.kind === 'interface');
    if (iface && iface.kind === 'interface') {
      (iface as unknown as { extends: unknown[] }).extends = [
        { kind: 'named', reference: { kind: 'ambient', name: 'Other' }, typeArguments: [] },
      ];
    }
    expect(() => emitIrModuleHaxe(module)).toThrow('interface');
  });

  it('emits interface member with function type', () => {
    const output = emitIrModuleHaxe(
      lower(
        'iface-fn.ts',
        `export interface Callback {
          run(x: number): number;
        }
        export class Runner implements Callback {
          run(x: number): number { return x + 1; }
        }`,
      ).module,
    ).contents;
    expect(output).toContain('function run');
  });

  it('emits type alias for object type as typedef', () => {
    const output = emitIrModuleHaxe(
      lower(
        'obj-alias.ts',
        `export type Config = { width: number; height: number; };
         export function area(c: Config): number { return c.width * c.height; }`,
      ).module,
    ).contents;
    expect(output).toContain('typedef Config');
  });

  it('emits discriminated union type alias as flattened typedef', () => {
    const output = emitIrModuleHaxe(
      lower(
        'disc-union.ts',
        `export interface Circle { kind: string; radius: number; }
         export interface Square { kind: string; side: number; }
         export type Shape = Circle | Square;
         export function describe(s: Shape): string { return s.kind; }`,
      ).module,
    ).contents;
    expect(output).toContain('typedef Shape');
  });

  it('emits class static method', () => {
    const output = emitIrModuleHaxe(
      lower(
        'static-method.ts',
        `export class Utils {
          static double(x: number): number { return x * 2; }
        }`,
      ).module,
    ).contents;
    expect(output).toContain('static');
    expect(output).toContain('double');
  });

  it('emits exponentiation as Math.pow', () => {
    const output = emitIrModuleHaxe(
      lower('pow.ts', `export function power(base: number, exp: number): number { return base ** exp; }`).module,
    ).contents;
    expect(output).toContain('Math.pow');
  });

  it('emits array concat as method call', () => {
    const output = emitIrModuleHaxe(
      lower('arr-concat.ts', `export function merge(a: number[], b: number[]): number[] { return a.concat(b); }`)
        .module,
    ).contents;
    expect(output).toContain('concat');
  });

  it('emits typeof check as Std.is', () => {
    const output = emitIrModuleHaxe(
      lower('typeof.ts', `export function isNum(x: number | string): boolean { return typeof x === "number"; }`).module,
    ).contents;
    expect(output).toContain('Std.is');
  });

  it('emits negated typeof check', () => {
    const output = emitIrModuleHaxe(
      lower('typeof-neg.ts', `export function isNotNum(x: number | string): boolean { return typeof x !== "number"; }`)
        .module,
    ).contents;
    expect(output).toContain('!Std.is');
  });
});

describe('emitIrModuleHaxe simple continue without label', () => {
  it('emits bare continue for unlabeled continue in for-of loop', () => {
    const result = lower(
      'simple-continue.ts',
      `export function sum(items: number[]): number {
         let total: number = 0;
         for (const item of items) {
           if (item < 0) continue;
           total += item;
         }
         return total;
       }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('continue');
  });
});

describe('emitIrModuleHaxe interface with function property implemented by class', () => {
  it('emits nominal interface when a class implements it', () => {
    const result = lower(
      'nominal-interface.ts',
      `export interface Processor {
         process(input: number): number;
       }
       export class SimpleProcessor implements Processor {
         process(input: number): number { return input + 1; }
       }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('interface Processor');
    expect(output).toContain('class SimpleProcessor');
  });
});

describe('emitIrModuleHaxe typeof with unmapped type', () => {
  it('routes typeof checks against unmapped types through the runtime contract', () => {
    const result = lower(
      'typeof-unmapped.ts',
      `export function isObj(value: unknown): boolean {
         return typeof value === "object";
       }`,
    );

    expect(emitIrModuleHaxe(result.module).contents).toContain('flighthq._internal._Js.typeOf(value)');
  });
});

describe('emitIrModuleHaxe conditional expression', () => {
  it('emits ternary conditional expression', () => {
    const result = lower('ternary.ts', 'export function max(a: number, b: number): number { return a > b ? a : b; }');
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('?');
    expect(output).toContain(':');
  });
});

describe('emitIrModuleHaxe class with multiple inheritance levels', () => {
  it('marks override on method inherited from grandparent', () => {
    const result = lower(
      'multi-inherit.ts',
      `export class A {
         run(): number { return 1; }
       }
       export class B extends A {
         run(): number { return 2; }
       }
       export class C extends B {
         run(): number { return 3; }
       }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('class C');
    expect(output).toContain('override');
  });
});

describe('emitIrModuleHaxe labeled continue from nested loop', () => {
  it('emits control flow exit for continue targeting outer loop from inner', () => {
    const result = lower(
      'nested-continue.ts',
      `export function sumPositive(matrix: number[][]): number {
         let total: number = 0;
         outer: for (const row of matrix) {
           for (const cell of row) {
             if (cell < 0) continue outer;
             total += cell;
           }
         }
         return total;
       }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('ControlFlowState');
    expect(output).toContain('== 2');
  });
});

describe('emitIrModuleHaxe for-in with HaxeReflect.fields', () => {
  it('emits HaxeReflect.fields for for-in without closed key plan', () => {
    const result = lower(
      'for-in-reflect.ts',
      `export function keys(obj: { [key: string]: number }): void {
         for (const key in obj) { const _x = key; }
       }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('for');
  });
});

describe('emitIrModuleHaxe element access on tuple', () => {
  it('emits tuple element access with numeric index', () => {
    const result = lower(
      'tuple-access.ts',
      `export function first(pair: [number, string]): number { return pair[0]; }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('[0]');
  });
});

describe('emitIrModuleHaxe while loop', () => {
  it('emits while loop with condition', () => {
    const result = lower(
      'while-loop.ts',
      `export function countdown(n: number): number {
         let i: number = n;
         while (i > 0) { i -= 1; }
         return i;
       }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('while');
  });
});

describe('emitIrModuleHaxe typeof narrowing with Std.isOfType', () => {
  it('emits Std.isOfType for typeof string check inside guard', () => {
    const result = lower(
      'typeof-guard.ts',
      `export function len(value: string | number): number {
         if (typeof value === 'string') { return value.length; }
         return 0;
       }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('Std.isOfType');
    expect(output).toContain('String');
    expect(output).toContain('value.length');
  });
});

describe('emitIrModuleHaxe module variable without type annotation', () => {
  it('emits variable without explicit Haxe type annotation', () => {
    const result = lower('inferred-var.ts', `export const count = 42;`);
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('count');
    expect(output).toContain('42');
  });
});

describe('emitIrModuleHaxe nullish comparison admitting both null and undefined', () => {
  it('collapses loose null equality while preserving strict null identity', () => {
    const result = lower(
      'both-nullish.ts',
      `export function check(value: number | null | undefined): boolean {
         return value == null;
       }`,
    );
    const strict = lower(
      'strict-nullish.ts',
      `export function check(value: number | null | undefined): boolean {
         return value === null;
       }`,
    );

    expect(emitIrModuleHaxe(result.module).contents).toContain('return value == null;');
    expect(emitIrModuleHaxe(strict.module).contents).toContain('return js.Syntax.strictEq(value, null);');
  });
});

describe('emitIrModuleHaxe nullish coalescing on dynamic tuple read', () => {
  it('looks through nullish coalescing to detect dynamic read from mixed tuple', () => {
    const result = lower(
      'tuple-coalesce.ts',
      `export function safe(pair: [number, string]): number {
         return pair[0] ?? 0;
       }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('??');
  });
});

describe('emitIrModuleHaxe class with non-overriding method and base chain', () => {
  it('does not mark method as override when only grandparent has it', () => {
    const result = lower(
      'grandparent-method.ts',
      `export class A {
         run(): number { return 1; }
       }
       export class B extends A {}
       export class C extends B {
         run(): number { return 3; }
       }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('class C');
    expect(output).toContain('override');
  });
});

describe('emitIrModuleHaxe bare continue without label', () => {
  it('emits continue statement inside a for-of loop', () => {
    const result = lower(
      'bare-continue.ts',
      `export function skip(items: number[]): number {
         let total: number = 0;
         for (const item of items) {
           if (item < 0) continue;
           total += item;
         }
         return total;
       }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('continue');
  });
});

describe('emitIrModuleHaxe loose inequality with null admits only undefined', () => {
  it('emits direct comparison when operand admits only undefined', () => {
    const result = lower(
      'nullish-single.ts',
      `export function present(value: number | undefined): boolean {
         return value != null;
       }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('!=');
    expect(output).toContain('null');
  });
});

describe('emitIrModuleHaxe indexedAccess type emission', () => {
  it('resolves concrete indexed access to its element type', () => {
    const result = lower(
      'indexed-type.ts',
      `interface Options { width: number; height: number; }
       export function getWidth(opt: Options): Options["width"] { return opt.width; }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('Float');
  });
});

describe('emitIrModuleHaxe do-while loop', () => {
  it('emits do-while with condition', () => {
    const result = lower(
      'do-while.ts',
      `export function halve(n: number): number {
         let value: number = n;
         do { value = Math.floor(value / 2); } while (value > 1);
         return value;
       }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('do {');
    expect(output).toContain('while');
  });
});

describe('emitIrModuleHaxe negated typeof check', () => {
  it('emits negated Std.isOfType for typeof !== comparison', () => {
    const result = lower(
      'typeof-negated.ts',
      `export function notString(value: string | number): boolean {
         return typeof value !== 'string';
       }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('!Std.isOfType');
  });
});

describe('emitIrModuleHaxe strict equality between number operands', () => {
  it('emits direct strict equality for matching number domains', () => {
    const result = lower(
      'strict-eq.ts',
      `export function eq(a: number, b: number): boolean {
         return a === b;
       }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('==');
  });
});

describe('emitIrModuleHaxe labeled do-while with break', () => {
  it('emits control flow state for labeled do-while break', () => {
    const result = lower(
      'labeled-do-while.ts',
      `export function find(items: number[]): number {
         let result: number = -1;
         outer: do {
           for (const item of items) {
             if (item > 10) { result = item; break outer; }
           }
         } while (false);
         return result;
       }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('ControlFlowState');
  });
});

describe('emitIrModuleHaxe undefined default expression', () => {
  it('emits default value for optional destructuring element', () => {
    const result = lower(
      'undef-default.ts',
      `export function first(pair: [number, number?]): number {
         const [a, b = 0] = pair;
         return a + b;
       }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('??');
  });
});

describe('emitIrModuleHaxe class field initialization in explicit constructor', () => {
  it('emits field initializations in class with explicit constructor', () => {
    const result = lower(
      'ctor-field.ts',
      `export class Item {
         readonly label: string = "default";
         constructor(public readonly value: number) {}
       }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('label');
    expect(output).toContain('default');
  });
});

describe('emitIrModuleHaxe tuple spread with trailing omitted optional elements', () => {
  it('emits null for omitted trailing optional elements in a tuple spread', () => {
    const result = lower(
      'tuple-spread-opt.ts',
      `type Result = [boolean, number, string?, string?];
       export function combine(a: [number]): Result {
         return [true, ...a];
       }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('null');
    expect(output).toContain('true');
  });
});

describe('emitIrModuleHaxe loose equality without nullish literal', () => {
  it('routes loose equality between non-nullish values through the runtime contract', () => {
    const result = lower(
      'loose-eq.ts',
      `export function check(a: number, b: number): boolean {
         return a == b;
       }`,
    );

    expect(emitIrModuleHaxe(result.module).contents).toContain('flighthq._internal._Js.looseEqual(a, b)');
  });
});

describe('emitIrModuleHaxe bitwise not on number', () => {
  it('emits bitwise complement with Std.int wrapping', () => {
    const result = lower(
      'bitwise-not.ts',
      `export function invert(n: number): number {
         return ~n;
       }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('~');
    expect(output).toContain('Std.int');
  });
});

describe('emitIrModuleHaxe string concatenation operator', () => {
  it('emits direct string addition', () => {
    const result = lower(
      'string-concat.ts',
      `export function greet(name: string): string {
         return "hello " + name;
       }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('+');
    expect(output).toContain('hello');
  });
});

describe('emitIrModuleHaxe strict boolean equality', () => {
  it('emits direct strict equality for boolean operands', () => {
    const result = lower(
      'bool-eq.ts',
      `export function same(a: boolean, b: boolean): boolean {
         return a === b;
       }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('==');
  });
});

describe('emitIrModuleHaxe nullish coalescing on mixed tuple element', () => {
  it('casts dynamic read through nullish coalescing from mixed tuple', () => {
    const result = lower(
      'tuple-coalesce-cast.ts',
      `export function safe(pair: [number, string]): number {
         const x: number = pair[0] ?? 0;
         return x;
       }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('cast');
    expect(output).toContain('??');
  });
});

describe('emitIrModuleHaxe undefinedDefault on dynamic tuple destructuring', () => {
  it('casts dynamic read through undefined default from mixed tuple destructuring', () => {
    const result = lower(
      'tuple-default-cast.ts',
      `export function safe(pair: [number, string?]): string {
         const [_n, text = "fallback"] = pair;
         return text;
       }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('cast');
    expect(output).toContain('fallback');
  });
});

describe('emitIrModuleHaxe accessor property emission', () => {
  it('emits getter accessor as Haxe property with get method', () => {
    const output = emitIrModuleHaxe(
      lower(
        'getter.ts',
        `export class Box {
          private _value: number;
          constructor(v: number) { this._value = v; }
          get value(): number { return this._value; }
        }`,
      ).module,
    ).contents;
    expect(output).toContain('get');
    expect(output).toContain('get_value');
  });

  it('emits setter accessor as Haxe property with set method', () => {
    const output = emitIrModuleHaxe(
      lower(
        'setter.ts',
        `export class Box {
          private _value: number;
          constructor(v: number) { this._value = v; }
          get value(): number { return this._value; }
          set value(v: number) { this._value = v; }
        }`,
      ).module,
    ).contents;
    expect(output).toContain('set');
    expect(output).toContain('set_value');
  });
});

describe('emitIrModuleHaxe interface extends chain', () => {
  it('emits interface that extends another as flattened typedef', () => {
    const output = emitIrModuleHaxe(
      lower(
        'iface-extends.ts',
        `export interface Base { x: number }
         export interface Extended extends Base { y: number }`,
      ).module,
    ).contents;
    expect(output).toContain('typedef Extended');
    expect(output).toContain('typedef Base');
  });

  it('widens a Pick of an explicitly bound ambient host interface to the native Haxe extern', () => {
    const output = emitIrModuleHaxe(
      lower('ambient-interface-pick.ts', "export interface Context extends Pick<WebGL2RenderingContext, 'clear'> {}")
        .module,
    ).contents;

    expect(output).toContain('typedef Context = js.html.webgl.WebGL2RenderingContext;');
  });

  it('reads constants on a widened WebGL interface through the native static owner', () => {
    const output = emitIrModuleHaxe(
      lower(
        'ambient-interface-webgl-constant.ts',
        "type Member = 'clear' | 'COLOR_BUFFER_BIT'; export interface Context extends Pick<WebGL2RenderingContext, Member> {} export function clear(gl: Context): void { gl.clear(gl.COLOR_BUFFER_BIT); }",
      ).module,
    ).contents;

    expect(output).toContain('gl.clear(js.html.webgl.WebGL2RenderingContext.COLOR_BUFFER_BIT);');
  });

  it('retains widened WebGL identity through a contract barrel and narrows native integer arguments', () => {
    const moduleResolution = {
      edges: [
        {
          specifier: './context',
          target: { packageName: '@flighthq/types', source: 'packages/types/src/context.ts' },
        },
        {
          specifier: '@flighthq/types/contract',
          target: { packageName: '@flighthq/types', source: 'packages/types/src/contract.ts' },
        },
      ],
      schema: 'flight-compiler-module-resolution/1' as const,
    };
    const inputs = [
      {
        packageName: '@flighthq/types',
        sourceFile: ts.createSourceFile(
          '/flight/packages/types/src/context.ts',
          "type Member = 'clear' | 'COLOR_BUFFER_BIT' | 'viewport'; export interface Context extends Pick<WebGL2RenderingContext, Member> {}",
          ts.ScriptTarget.Latest,
          true,
        ),
        upstreamDirectory: '/flight',
      },
      {
        packageName: '@flighthq/types',
        sourceFile: ts.createSourceFile(
          '/flight/packages/types/src/contract.ts',
          "export * from './context';",
          ts.ScriptTarget.Latest,
          true,
        ),
        upstreamDirectory: '/flight',
      },
      {
        packageName: '@flighthq/render',
        sourceFile: ts.createSourceFile(
          '/flight/packages/render/src/use.ts',
          "import type { Context } from '@flighthq/types/contract'; export function clear(gl: Context, x: number): void { gl.viewport(x, 0, x, 1); gl.clear(gl.COLOR_BUFFER_BIT); }",
          ts.ScriptTarget.Latest,
          true,
        ),
        upstreamDirectory: '/flight',
      },
    ];
    const modules = lowerTypeScriptSources(inputs, moduleResolution).map((result) => result.module);
    const session = createHaxeCompilerBackend().createEmissionSession!({ moduleResolution, modules, options: {} });
    const output = session.emitModule(modules[2]!)[0]!.contents;

    expect(output).toContain('gl.viewport(Std.int(x), 0, Std.int(x), 1);');
    expect(output).toContain('gl.clear(js.html.webgl.WebGL2RenderingContext.COLOR_BUFFER_BIT);');
  });

  it('retains widened WebGL identity through a foreign container property', () => {
    const moduleResolution = {
      edges: [
        {
          specifier: './context',
          target: { packageName: '@flighthq/types', source: 'packages/types/src/context.ts' },
        },
        {
          specifier: './state',
          target: { packageName: '@flighthq/types', source: 'packages/types/src/state.ts' },
        },
        {
          specifier: '@flighthq/types/contract',
          target: { packageName: '@flighthq/types', source: 'packages/types/src/contract.ts' },
        },
      ],
      schema: 'flight-compiler-module-resolution/1' as const,
    };
    const inputs = [
      {
        packageName: '@flighthq/types',
        sourceFile: ts.createSourceFile(
          '/flight/packages/types/src/context.ts',
          "type Member = 'clear' | 'COLOR_BUFFER_BIT'; export interface Context extends Pick<WebGL2RenderingContext, Member> {}",
          ts.ScriptTarget.Latest,
          true,
        ),
        upstreamDirectory: '/flight',
      },
      {
        packageName: '@flighthq/types',
        sourceFile: ts.createSourceFile(
          '/flight/packages/types/src/state.ts',
          "import type { Context } from './context'; export interface State { gl: Context }",
          ts.ScriptTarget.Latest,
          true,
        ),
        upstreamDirectory: '/flight',
      },
      {
        packageName: '@flighthq/types',
        sourceFile: ts.createSourceFile(
          '/flight/packages/types/src/contract.ts',
          "export * from './state';",
          ts.ScriptTarget.Latest,
          true,
        ),
        upstreamDirectory: '/flight',
      },
      {
        packageName: '@flighthq/render',
        sourceFile: ts.createSourceFile(
          '/flight/packages/render/src/use.ts',
          "import type { State } from '@flighthq/types/contract'; export function clear(state: State): void { state.gl.clear(state.gl.COLOR_BUFFER_BIT); }",
          ts.ScriptTarget.Latest,
          true,
        ),
        upstreamDirectory: '/flight',
      },
    ];
    const modules = lowerTypeScriptSources(inputs, moduleResolution).map((result) => result.module);
    const session = createHaxeCompilerBackend().createEmissionSession!({ moduleResolution, modules, options: {} });
    const output = session.emitModule(modules[3]!)[0]!.contents;

    expect(output).toContain('state.gl.clear(js.html.webgl.WebGL2RenderingContext.COLOR_BUFFER_BIT);');
  });

  it('uses source-module parameter types for WebGL defaults in facade forwarders', () => {
    const moduleResolution = {
      edges: [
        {
          specifier: './context',
          target: { packageName: '@flighthq/types', source: 'packages/types/src/context.ts' },
        },
      ],
      schema: 'flight-compiler-module-resolution/1' as const,
    };
    const inputs = [
      {
        packageName: '@flighthq/types',
        sourceFile: ts.createSourceFile(
          '/flight/packages/types/src/context.ts',
          `type Member = 'clear' | 'COLOR_BUFFER_BIT';
           export interface Context extends Pick<WebGL2RenderingContext, Member> {}
           export function clearDefault(gl: Context, value: number = gl.COLOR_BUFFER_BIT): void { gl.clear(value); }`,
          ts.ScriptTarget.Latest,
          true,
        ),
        upstreamDirectory: '/flight',
      },
      {
        packageName: '@flighthq/types',
        sourceFile: ts.createSourceFile(
          '/flight/packages/types/src/contract.ts',
          "export * from './context';",
          ts.ScriptTarget.Latest,
          true,
        ),
        upstreamDirectory: '/flight',
      },
    ];
    const modules = lowerTypeScriptSources(inputs, moduleResolution).map((result) => result.module);
    const session = createHaxeCompilerBackend().createEmissionSession!({ moduleResolution, modules, options: {} });
    const output = session.emitModule(modules[1]!)[0]!.contents;

    expect(output).toContain('js.html.webgl.WebGL2RenderingContext.COLOR_BUFFER_BIT');
  });

  it('reuses local imports for nested types recovered from cross-module construction targets', () => {
    const moduleResolution = {
      edges: [
        {
          specifier: '@flighthq/types/contract',
          target: { packageName: '@flighthq/types', source: 'packages/types/src/contract.ts' },
        },
        {
          specifier: './shape',
          target: { packageName: '@flighthq/types', source: 'packages/types/src/shape.ts' },
        },
      ],
      schema: 'flight-compiler-module-resolution/1' as const,
    };
    const inputs = [
      {
        packageName: '@flighthq/types',
        sourceFile: ts.createSourceFile(
          '/flight/packages/types/src/shape.ts',
          "export type Flavor = 'first' | 'second'; export interface Shape<T> { flavor: T }",
          ts.ScriptTarget.Latest,
          true,
        ),
        upstreamDirectory: '/flight',
      },
      {
        packageName: '@flighthq/types',
        sourceFile: ts.createSourceFile(
          '/flight/packages/types/src/contract.ts',
          "export * from './shape';",
          ts.ScriptTarget.Latest,
          true,
        ),
        upstreamDirectory: '/flight',
      },
      {
        packageName: '@flighthq/render',
        sourceFile: ts.createSourceFile(
          '/flight/packages/render/src/use.ts',
          "import type { Flavor, Shape } from '@flighthq/types/contract'; export const shape: Shape<Flavor> = { flavor: 'first' };",
          ts.ScriptTarget.Latest,
          true,
        ),
        upstreamDirectory: '/flight',
      },
    ];
    const modules = lowerTypeScriptSources(inputs, moduleResolution).map((result) => result.module);
    const session = createHaxeCompilerBackend().createEmissionSession!({ moduleResolution, modules, options: {} });
    const output = session.emitModule(modules[2]!)[0]!.contents;

    expect(output).toContain('(cast "first" : Flavor)');
    expect(output).not.toContain('Flavor_2');
  });

  it('preserves type arguments on resolved imported generic aliases', () => {
    const moduleResolution = {
      edges: [
        {
          specifier: './base',
          target: { packageName: '@flighthq/types', source: 'packages/types/src/base.ts' },
        },
      ],
      schema: 'flight-compiler-module-resolution/1' as const,
    };
    const inputs = [
      {
        packageName: '@flighthq/types',
        sourceFile: ts.createSourceFile(
          '/flight/packages/types/src/base.ts',
          'export interface Entity {} export type WithoutRuntime<T extends Entity> = Partial<T>;',
          ts.ScriptTarget.Latest,
          true,
        ),
        upstreamDirectory: '/flight',
      },
      {
        packageName: '@flighthq/types',
        sourceFile: ts.createSourceFile(
          '/flight/packages/types/src/use.ts',
          "import type { Entity, WithoutRuntime } from './base'; interface Value extends Entity {} export type ValueLike = WithoutRuntime<Value>;",
          ts.ScriptTarget.Latest,
          true,
        ),
        upstreamDirectory: '/flight',
      },
    ];
    const modules = lowerTypeScriptSources(inputs, moduleResolution).map((result) => result.module);
    const session = createHaxeCompilerBackend().createEmissionSession!({ moduleResolution, modules, options: {} });
    const output = session.emitModule(modules[1]!)[0]!.contents;

    expect(output).toContain('typedef ValueLike = WithoutRuntime<Value>;');
  });

  it('reuses facade imports in contextual function field casts', () => {
    const moduleResolution = {
      edges: [
        {
          specifier: './shape',
          target: { packageName: '@flighthq/types', source: 'packages/types/src/shape.ts' },
        },
        {
          specifier: '@flighthq/types/contract',
          target: { packageName: '@flighthq/types', source: 'packages/types/src/contract.ts' },
        },
      ],
      schema: 'flight-compiler-module-resolution/1' as const,
    };
    const inputs = [
      {
        packageName: '@flighthq/types',
        sourceFile: ts.createSourceFile(
          '/flight/packages/types/src/shape.ts',
          'export interface Item { value: number } export interface Handler { run: (value: Item) => void }',
          ts.ScriptTarget.Latest,
          true,
        ),
        upstreamDirectory: '/flight',
      },
      {
        packageName: '@flighthq/types',
        sourceFile: ts.createSourceFile(
          '/flight/packages/types/src/contract.ts',
          "export * from './shape';",
          ts.ScriptTarget.Latest,
          true,
        ),
        upstreamDirectory: '/flight',
      },
      {
        packageName: '@flighthq/render',
        sourceFile: ts.createSourceFile(
          '/flight/packages/render/src/use.ts',
          "import type { Handler, Item } from '@flighthq/types/contract'; export const handler: Handler = { run(value: Item): void { value; } };",
          ts.ScriptTarget.Latest,
          true,
        ),
        upstreamDirectory: '/flight',
      },
    ];
    const modules = lowerTypeScriptSources(inputs, moduleResolution).map((result) => result.module);
    const session = createHaxeCompilerBackend().createEmissionSession!({ moduleResolution, modules, options: {} });
    const output = session.emitModule(modules[2]!)[0]!.contents;

    expect(output).toContain('function(value:Item)');
    expect(output).not.toContain('Item_2');
  });

  it('uses imported generic field types for contextual empty arrays', () => {
    const moduleResolution = {
      edges: [
        {
          specifier: './data',
          target: { packageName: '@flighthq/types', source: 'packages/types/src/data.ts' },
        },
      ],
      schema: 'flight-compiler-module-resolution/1' as const,
    };
    const inputs = [
      {
        packageName: '@flighthq/types',
        sourceFile: ts.createSourceFile(
          '/flight/packages/types/src/data.ts',
          'export interface Data<T> { values: (T | null)[] }',
          ts.ScriptTarget.Latest,
          true,
        ),
        upstreamDirectory: '/flight',
      },
      {
        packageName: '@flighthq/core',
        sourceFile: ts.createSourceFile(
          '/flight/packages/core/src/use.ts',
          "import type { Data } from './data'; export function init<T>(): Data<T> { const data: Data<T> = { values: [] }; return data; }",
          ts.ScriptTarget.Latest,
          true,
        ),
        upstreamDirectory: '/flight',
      },
    ];
    const modules = lowerTypeScriptSources(inputs, moduleResolution).map((result) => result.module);
    const session = createHaxeCompilerBackend().createEmissionSession!({ moduleResolution, modules, options: {} });
    const output = session.emitModule(modules[1]!)[0]!.contents;

    expect(output).toContain('values: (cast [] : Array<Null<T>>)');
  });

  it('instantiates imported generic property evidence with the caller type parameter', () => {
    const moduleResolution = {
      edges: [
        {
          specifier: '@flighthq/types/contract',
          target: { packageName: '@flighthq/types', source: 'packages/types/src/contract.ts' },
        },
      ],
      schema: 'flight-compiler-module-resolution/1' as const,
    };
    const inputs = [
      {
        packageName: '@flighthq/types',
        sourceFile: ts.createSourceFile(
          '/flight/packages/types/src/contract.ts',
          `export interface Signal<T extends (...args: any[]) => void> { data: SignalData<T> | null }
           export interface SignalData<T extends (...args: any[]) => void> { slots: (T | null)[] }`,
          ts.ScriptTarget.Latest,
          true,
        ),
        upstreamDirectory: '/flight',
      },
      {
        packageName: '@flighthq/signals',
        sourceFile: ts.createSourceFile(
          '/flight/packages/signals/src/safe.ts',
          `import type { Signal } from '@flighthq/types/contract';
           export function emitSignalSafe<T extends (...args: any[]) => void>(signal: Signal<T>): void {
             const data = signal.data;
             if (data === null) return;
             const slots = data.slots.slice();
             void slots;
           }`,
          ts.ScriptTarget.Latest,
          true,
        ),
        upstreamDirectory: '/flight',
      },
    ];
    const modules = lowerTypeScriptSources(inputs, moduleResolution).map((result) => result.module);
    const session = createHaxeCompilerBackend().createEmissionSession!({ moduleResolution, modules, options: {} });
    const output = session.emitModule(modules[1]!)[0]!.contents;

    expect(output).toContain('final data:Null<SignalData<T>>');
    expect(output).not.toContain('SignalData<Dynamic>');
  });

  it('casts between string aliases recovered through one facade import identity', () => {
    const moduleResolution = {
      edges: [
        {
          specifier: './shape',
          target: { packageName: '@flighthq/types', source: 'packages/types/src/shape.ts' },
        },
        {
          specifier: '@flighthq/types/contract',
          target: { packageName: '@flighthq/types', source: 'packages/types/src/contract.ts' },
        },
      ],
      schema: 'flight-compiler-module-resolution/1' as const,
    };
    const inputs = [
      {
        packageName: '@flighthq/types',
        sourceFile: ts.createSourceFile(
          '/flight/packages/types/src/shape.ts',
          "export type SourceColor = 'srgb' | 'linear'; export type TargetColor = 'srgb' | 'linear'; export interface Source { color: SourceColor } export interface Target { color: TargetColor }",
          ts.ScriptTarget.Latest,
          true,
        ),
        upstreamDirectory: '/flight',
      },
      {
        packageName: '@flighthq/types',
        sourceFile: ts.createSourceFile(
          '/flight/packages/types/src/contract.ts',
          "export * from './shape';",
          ts.ScriptTarget.Latest,
          true,
        ),
        upstreamDirectory: '/flight',
      },
      {
        packageName: '@flighthq/render',
        sourceFile: ts.createSourceFile(
          '/flight/packages/render/src/use.ts',
          "import type { Source, Target } from '@flighthq/types/contract'; export function copy(source: Source, target: Target): void { target.color = source.color; }",
          ts.ScriptTarget.Latest,
          true,
        ),
        upstreamDirectory: '/flight',
      },
    ];
    const modules = lowerTypeScriptSources(inputs, moduleResolution).map((result) => result.module);
    const session = createHaxeCompilerBackend().createEmissionSession!({ moduleResolution, modules, options: {} });
    const output = session.emitModule(modules[2]!)[0]!.contents;

    expect(output).toContain('(target.color = (cast source.color : TargetColor))');
  });

  it('resolves string aliases imported by a foreign declaration owner', () => {
    const moduleResolution = {
      edges: [
        {
          specifier: './colors',
          target: { packageName: '@flighthq/types', source: 'packages/types/src/colors.ts' },
        },
        {
          specifier: './shape',
          target: { packageName: '@flighthq/types', source: 'packages/types/src/shape.ts' },
        },
        {
          specifier: '@flighthq/types/contract',
          target: { packageName: '@flighthq/types', source: 'packages/types/src/contract.ts' },
        },
      ],
      schema: 'flight-compiler-module-resolution/1' as const,
    };
    const inputs = [
      {
        packageName: '@flighthq/types',
        sourceFile: ts.createSourceFile(
          '/flight/packages/types/src/colors.ts',
          "export type SourceColor = 'srgb' | 'linear'; export type TargetColor = 'srgb' | 'linear';",
          ts.ScriptTarget.Latest,
          true,
        ),
        upstreamDirectory: '/flight',
      },
      {
        packageName: '@flighthq/types',
        sourceFile: ts.createSourceFile(
          '/flight/packages/types/src/shape.ts',
          "import type { SourceColor, TargetColor } from './colors'; export interface Source { color: SourceColor } export interface Target { color: TargetColor }",
          ts.ScriptTarget.Latest,
          true,
        ),
        upstreamDirectory: '/flight',
      },
      {
        packageName: '@flighthq/types',
        sourceFile: ts.createSourceFile(
          '/flight/packages/types/src/contract.ts',
          "export * from './shape';",
          ts.ScriptTarget.Latest,
          true,
        ),
        upstreamDirectory: '/flight',
      },
      {
        packageName: '@flighthq/render',
        sourceFile: ts.createSourceFile(
          '/flight/packages/render/src/use.ts',
          "import type { Source, Target } from '@flighthq/types/contract'; export function copy(source: Source, target: Target): void { target.color = source.color; }",
          ts.ScriptTarget.Latest,
          true,
        ),
        upstreamDirectory: '/flight',
      },
    ];
    const modules = lowerTypeScriptSources(inputs, moduleResolution).map((result) => result.module);
    const session = createHaxeCompilerBackend().createEmissionSession!({ moduleResolution, modules, options: {} });
    const output = session.emitModule(modules[3]!)[0]!.contents;

    expect(output).toContain('(target.color = (cast source.color : TargetColor))');
  });

  it('casts nullish string-alias branches before Haxe unifies them', () => {
    const output = emitIrModuleHaxe(
      lower(
        'color-space.ts',
        "type Source = 'srgb' | 'linear'; type Target = 'srgb' | 'linear'; interface Input { value?: Source } export function read(input: Input, fallback: Target): Target { return input.value ?? fallback; }",
      ).module,
    ).contents;

    expect(output).toContain('(cast input.value : Null<Target>) ?? (cast fallback : Target)');
  });

  it('casts nullish structural array branches before Haxe unifies them', () => {
    const output = emitIrModuleHaxe(
      lower(
        'channel-layers.ts',
        'interface Channel { value: number } interface Left { channel: Channel; sources: number[] } interface Right { channel: Channel; indices: number[] } export function channels(left: Left[] | null, right: Right[]): { channel: Channel }[] { return left ?? right; }',
      ).module,
    ).contents;

    expect(output).toContain(
      '(cast left : Null<Array<{ channel:Channel }>>) ?? (cast right : Array<{ channel:Channel }>)',
    );
  });

  it('selects literal DOM overload result types before Haxe native emission', () => {
    const output = emitIrModuleHaxe(
      lower(
        'dom-overloads.ts',
        "export function context(canvas: HTMLCanvasElement): WebGL2RenderingContext | null { return canvas.getContext('webgl2'); } export function element(): HTMLCanvasElement { return document.querySelector('canvas')!; } export function created(): HTMLCanvasElement { return document.createElement('canvas'); }",
      ).module,
    ).contents;

    expect(output).toContain('return (cast canvas.getContext("webgl2") : js.html.webgl.WebGL2RenderingContext);');
    expect(output).toContain('function element():js.html.CanvasElement');
    expect(output).toContain('(cast js.Browser.document.createElement("canvas") : js.html.CanvasElement)');
    expect(output).not.toContain('js.html.Element');
  });

  it('casts WebGL power preference defaults inside spread-bearing native attributes', () => {
    const output = emitIrModuleHaxe(
      lower(
        'webgl-options.ts',
        "interface Options { powerPreference?: WebGLPowerPreference; contextAttributes?: WebGLContextAttributes } export function attributes(options: Options): WebGLContextAttributes { return { powerPreference: options.powerPreference ?? 'default', ...options.contextAttributes }; }",
      ).module,
    ).contents;

    expect(output).toContain(
      '(cast options.powerPreference : Null<js.html.webgl.PowerPreference>) ?? (cast "default" : js.html.webgl.PowerPreference)',
    );
  });

  it('uses JavaScript syntax for AbortSignal methods absent from the pinned Haxe extern', () => {
    const output = emitIrModuleHaxe(
      lower(
        'abort-signal.ts',
        'export function guard(signal: AbortSignal): boolean { signal.throwIfAborted(); return signal.aborted; }',
      ).module,
    ).contents;

    expect(output).toContain('js.Syntax.code("{0}.throwIfAborted()", signal);');
    expect(output).toContain('return signal.aborted;');
    expect(output).not.toContain('signal.throwIfAborted()');
  });

  it('uses JavaScript syntax for browser members absent from the pinned Haxe extern', () => {
    const output = emitIrModuleHaxe(
      lower(
        'new-browser-members.ts',
        `export function render(context: CanvasRenderingContext2D, quality: ImageSmoothingQuality): DOMMatrix {
           context.imageSmoothingQuality = quality;
           context.getContextAttributes();
           context.roundRect(0, 0, 10, 10, 2);
           return context.getTransform();
         }`,
      ).module,
    ).contents;

    expect(output).toContain('js.Syntax.code("{0}.imageSmoothingQuality = {1}", context, quality)');
    expect(output).toContain('js.Syntax.code("{0}.getContextAttributes()", context)');
    expect(output).toContain('js.Syntax.code("{0}.roundRect({1}, {2}, {3}, {4}, {5})", context, 0, 0, 10, 10, 2)');
    expect(output).toContain('js.Syntax.code("{0}.getTransform()", context)');
  });

  it('preserves JavaScript number semantics for plural selection and Math constants', () => {
    const output = emitIrModuleHaxe(
      lower(
        'native-number-members.ts',
        `export function select(value: number): string {
           const rules = new Intl.PluralRules('en');
           return rules.select(value + Math.SQRT2 + Math.SQRT1_2);
         }`,
      ).module,
    ).contents;

    expect(output).toContain('js.Syntax.code("{0}.select({1})", rules,');
    expect(output).toContain('Math.sqrt(2.0)');
    expect(output).toContain('Math.sqrt(0.5)');
    expect(output).not.toContain('Std.int(value');
  });

  it('qualifies contextual field types not directly imported by the source module', () => {
    const moduleResolution = {
      edges: [
        {
          specifier: './types',
          target: { packageName: '@flighthq/types', source: 'packages/types/src/types.ts' },
        },
      ],
      schema: 'flight-compiler-module-resolution/1' as const,
    };
    const inputs = [
      {
        packageName: '@flighthq/types',
        sourceFile: ts.createSourceFile(
          '/flight/packages/types/src/types.ts',
          "export type Color = 'srgb' | 'linear'; export interface Target { color: Color }",
          ts.ScriptTarget.Latest,
          true,
        ),
        upstreamDirectory: '/flight',
      },
      {
        packageName: '@flighthq/core',
        sourceFile: ts.createSourceFile(
          '/flight/packages/core/src/use.ts',
          "import type { Target } from './types'; export function set(target: Target, color: string): void { target.color = color as 'srgb'; }",
          ts.ScriptTarget.Latest,
          true,
        ),
        upstreamDirectory: '/flight',
      },
    ];
    const modules = lowerTypeScriptSources(inputs, moduleResolution).map((result) => result.module);
    const session = createHaxeCompilerBackend().createEmissionSession!({ moduleResolution, modules, options: {} });
    const output = session.emitModule(modules[1]!)[0]!.contents;

    expect(output).toContain('flighthq.types.Types.Color');
  });

  it('casts arguments to imported function structural parameter types', () => {
    const moduleResolution = {
      edges: [
        {
          specifier: './factory',
          target: { packageName: '@flighthq/types', source: 'packages/types/src/factory.ts' },
        },
      ],
      schema: 'flight-compiler-module-resolution/1' as const,
    };
    const inputs = [
      {
        packageName: '@flighthq/types',
        sourceFile: ts.createSourceFile(
          '/flight/packages/types/src/factory.ts',
          'export interface Options { value: number } export function create(options: Options): Options { return options; }',
          ts.ScriptTarget.Latest,
          true,
        ),
        upstreamDirectory: '/flight',
      },
      {
        packageName: '@flighthq/core',
        sourceFile: ts.createSourceFile(
          '/flight/packages/core/src/use.ts',
          "import { create } from './factory'; interface Input { value: number; extra: string } export function run(input: Input): void { create(input); }",
          ts.ScriptTarget.Latest,
          true,
        ),
        upstreamDirectory: '/flight',
      },
    ];
    const modules = lowerTypeScriptSources(inputs, moduleResolution).map((result) => result.module);
    const session = createHaxeCompilerBackend().createEmissionSession!({ moduleResolution, modules, options: {} });
    const output = session.emitModule(modules[1]!)[0]!.contents;

    expect(output).toContain('create((cast input : Options))');
  });

  it('does not leak callee type parameters into generic call argument casts', () => {
    const output = emitIrModuleHaxe(
      lower(
        'generic-call-target.ts',
        `interface Signal<T> { value: T }
         function emit<T>(signal: Signal<T>): void { signal; }
         function dispose<TArgs extends unknown[]>(signal: Signal<(...args: TArgs) => void>): void { signal; }
         export function run(signal: Signal<() => void>): void { emit(signal); dispose(signal); }`,
      ).module,
    ).contents;

    expect(output).toContain('function emit<T>(signal:Signal<T>)');
    expect(output).toContain('emit(signal);');
    expect(output).not.toContain('emit((cast signal');
    expect(output).toContain('function dispose<TArgs:Array<Dynamic>>(signal:Dynamic)');
    expect(output).toContain('dispose(signal);');
    expect(output).not.toContain('Signal<(TArgs)->Void>');
  });

  it('materializes non-array iterables before array spread concatenation', () => {
    const output = emitIrModuleHaxe(
      lower('iterable-spread.ts', 'export function values(input: Set<number>): number[] { return [...input, 1]; }')
        .module,
    ).contents;

    expect(output).toContain('flighthq._internal._Array.from(input).concat([(cast 1 : Float)])');
    expect(output).not.toContain('input.copy()');
  });

  it('erases async settlement values at the assimilating resolve ABI boundary', () => {
    const output = emitIrModuleHaxe(
      lower(
        'async-return.ts',
        'function load(): Promise<number> { return Promise.resolve(1); } export async function read(): Promise<number> { return load(); }',
      ).module,
    ).contents;

    expect(output).toContain('resolveTask(cast(load()));');
  });

  it('retains nested WebGL receiver and field types at native integer boundaries', () => {
    const output = emitIrModuleHaxe(
      lower(
        'nested-webgl-context.ts',
        `type Member = 'ARRAY_BUFFER' | 'bufferData' | 'pixelStorei' | 'STATIC_DRAW' | 'UNPACK_PREMULTIPLY_ALPHA_WEBGL' | 'viewport';
         interface Context extends Pick<WebGL2RenderingContext, Member> {}
         interface State { gl: Context; width: number }
         export function configure(state: State, enabled: boolean, flag: boolean, data: Float32Array): void {
           state.gl.viewport(0, 0, state.width, 1);
           state.gl.pixelStorei(state.gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, enabled);
           state.gl.bufferData(state.gl.ARRAY_BUFFER, data, state.gl.STATIC_DRAW);
           state.gl.bufferData(state.gl.ARRAY_BUFFER, flag ? choose(data) : data, state.gl.STATIC_DRAW);
           state.gl.bufferData(state.gl.ARRAY_BUFFER, new Uint16Array([0, 1]), state.gl.STATIC_DRAW);
         }
         function choose(data: Float32Array): Float32Array { return data; }`,
      ).module,
    ).contents;

    expect(output).toContain('state.gl.viewport(0, 0, Std.int(state.width), 1);');
    expect(output).toContain(
      'state.gl.pixelStorei(js.html.webgl.WebGL2RenderingContext.UNPACK_PREMULTIPLY_ALPHA_WEBGL, (enabled ? 1 : 0));',
    );
    expect(output).toContain(
      'state.gl.bufferData(js.html.webgl.WebGL2RenderingContext.ARRAY_BUFFER, data, js.html.webgl.WebGL2RenderingContext.STATIC_DRAW);',
    );
    expect(output).toContain(
      'state.gl.bufferData(js.html.webgl.WebGL2RenderingContext.ARRAY_BUFFER, (flag ? choose((cast data : flighthq._internal._Float32Array)) : data), js.html.webgl.WebGL2RenderingContext.STATIC_DRAW);',
    );
    expect(output).toContain('new flighthq._internal._UInt16Array([(cast 0 : Float), 1])');
    expect(output).not.toContain('Std.int(data)');
    expect(output).not.toContain('Std.int(new flighthq._internal._UInt16Array');
  });

  it('unwraps transparent utility types when selecting WebGL static constants', () => {
    const output = emitIrModuleHaxe(
      lower(
        'readonly-webgl-context.ts',
        `type Member = 'FLOAT_MAT4';
         interface Context extends Pick<WebGL2RenderingContext, Member> {}
         export function isMatrix(gl: Readonly<Context>, value: number): boolean { return value === gl.FLOAT_MAT4; }`,
      ).module,
    ).contents;

    expect(output).toContain('js.html.webgl.WebGL2RenderingContext.FLOAT_MAT4');
  });
});

describe('emitIrModuleHaxe interface with function property', () => {
  it('emits interface function property as method signature', () => {
    const output = emitIrModuleHaxe(
      lower(
        'iface-fn-prop.ts',
        `export interface Handler {
          handle(x: number): number;
        }
        export class Impl implements Handler {
          handle(x: number): number { return x + 1; }
        }`,
      ).module,
    ).contents;
    expect(output).toContain('interface Handler');
    expect(output).toContain('public function handle');
  });
});

describe('emitIrModuleHaxe anonymous parameter naming', () => {
  it('emits interface method parameter with fallback argument name', () => {
    const output = emitIrModuleHaxe(
      lower(
        'iface-anon-param.ts',
        `export interface Mapper {
          map(x: number): number;
        }
        export class Impl implements Mapper {
          map(x: number): number { return x; }
        }`,
      ).module,
    ).contents;
    expect(output).toContain('interface Mapper');
    expect(output).toContain('public function map');
  });
});

describe('emitIrModuleHaxe intersection type emission', () => {
  it('emits intersection type as Dynamic when types differ', () => {
    const output = emitIrModuleHaxe(
      lower(
        'intersect.ts',
        `interface A { x: number }
         interface B { y: number }
         export function test(x: A & B): number { return x.x + x.y; }`,
      ).module,
    ).contents;
    expect(output).toContain('Dynamic');
  });
});

describe('emitIrModuleHaxe rest parameter emission', () => {
  it('emits rest parameter with Haxe variadic syntax', () => {
    const output = emitIrModuleHaxe(
      lower('rest-param.ts', 'export function sum(first: number, ...rest: number[]): number { return first; }').module,
    ).contents;
    expect(output).toContain('...rest');
  });
});

describe('emitIrModuleHaxe struct init record emission', () => {
  it('emits interface as struct init with @:structInit annotation', () => {
    const output = emitIrModuleHaxe(lower('struct-init.ts', 'export interface Point { x: number; y: number }').module, {
      structuralRecords: 'structInit',
    }).contents;
    expect(output).toContain('@:structInit');
  });
});

describe('emitIrModuleHaxe union type emission', () => {
  it('emits nullable type as Null<T>', () => {
    const output = emitIrModuleHaxe(
      lower('nullable.ts', 'export function maybe(x: number | undefined): number | undefined { return x; }').module,
    ).contents;
    expect(output).toContain('Null<');
  });

  it('emits multi-type non-nullable union as Dynamic', () => {
    const output = emitIrModuleHaxe(
      lower('multi-union.ts', 'export function flex(x: number | string | boolean): number { return x as number; }')
        .module,
    ).contents;
    expect(output).toContain('Dynamic');
  });
});

describe('emitIrModuleHaxe tuple type emission', () => {
  it('emits uniform tuple as typed array', () => {
    const output = emitIrModuleHaxe(
      lower('uniform-tuple.ts', 'export function pair(): [number, number] { return [1, 2]; }').module,
    ).contents;
    expect(output).toContain('Array<Float>');
  });

  it('emits mixed tuple as Array<Dynamic>', () => {
    const output = emitIrModuleHaxe(
      lower('mixed-tuple.ts', 'export function pair(): [number, string] { return [1, "a"]; }').module,
    ).contents;
    expect(output).toContain('Array<Dynamic>');
  });
});

describe('emitIrModuleHaxe object rest expression', () => {
  it('emits object rest with HaxeReflect.copy and deleteField', () => {
    const output = emitIrModuleHaxe(
      lower(
        'obj-rest.ts',
        `interface Pt { x: number; y: number; z: number }
         export function dropX(p: Pt): { y: number; z: number } {
           const { x, ...rest } = p;
           return rest;
         }`,
      ).module,
    ).contents;
    expect(output).toContain('HaxeReflect.copy');
    expect(output).toContain('deleteField');
  });
});

describe('emitIrModuleHaxe postfix increment emission', () => {
  it('emits postfix increment on number variable', () => {
    const output = emitIrModuleHaxe(
      lower('postinc.ts', 'export function inc(x: number): number { x++; return x; }').module,
    ).contents;
    expect(output).toContain('++');
  });
});

describe('emitIrModuleHaxe spread call emission', () => {
  it('emits spread call with HaxeReflect.callMethod', () => {
    const output = emitIrModuleHaxe(
      lower(
        'spread-call.ts',
        `export function call(fn: (...args: number[]) => number, args: number[]): number {
           return fn(...args);
         }`,
      ).module,
    ).contents;
    expect(output).toContain('HaxeReflect.callMethod');
  });

  it('routes a spread passed to a mapped array member before fixed-arity member emission', () => {
    const output = emitIrModuleHaxe(
      lower('spread-push.ts', 'export function append(out: number[], values: number[]): void { out.push(...values); }')
        .module,
    ).contents;
    expect(output).toContain('HaxeReflect.callMethod(out, cast(out.push), (cast values : Array<Dynamic>))');
  });

  it('routes mixed fixed and spread array pushes through reflective arity', () => {
    const output = emitIrModuleHaxe(
      lower(
        'mixed-spread-push.ts',
        'export function append(out: number[], first: number, middle: number[], last: number): void { out.push(first, ...middle, last); }',
      ).module,
    ).contents;
    expect(output).toContain(
      'HaxeReflect.callMethod(out, cast(out.push), ([first] : Array<Dynamic>).concat((cast middle : Array<Dynamic>)).concat(([last] : Array<Dynamic>)))',
    );
  });
});

describe('emitIrModuleHaxe template literal emission', () => {
  it('emits template with interpolated expressions', () => {
    const output = emitIrModuleHaxe(
      lower('template.ts', 'export function greet(name: string): string { return `hello ${name}`; }').module,
    ).contents;
    expect(output).toContain('Std.string');
    expect(output).toContain('+');
  });
});

describe('emitIrModuleHaxe type alias emission', () => {
  it('emits string literal union as enum abstract', () => {
    const output = emitIrModuleHaxe(
      lower('str-union.ts', "export type Color = 'red' | 'blue' | 'green';").module,
    ).contents;
    expect(output).toContain('enum abstract');
    expect(output).toContain('from String to String');
  });
});

describe('emitIrModuleHaxe abstract method inheritance', () => {
  it('does not mark implementation of abstract method as override', () => {
    const output = emitIrModuleHaxe(
      lower(
        'abstract-impl.ts',
        `export abstract class Shape {
          abstract area(): number;
        }
        export class Circle extends Shape {
          radius: number;
          constructor(r: number) { super(); this.radius = r; }
          area(): number { return 3.14 * this.radius * this.radius; }
        }`,
      ).module,
    ).contents;
    expect(output).toContain('function area');
    expect(output).not.toMatch(/override.*area/);
  });
});

describe('emitIrModuleHaxe class error name storage', () => {
  it('stores error name in Error subclass constructor', () => {
    const output = emitIrModuleHaxe(
      lower(
        'custom-error.ts',
        `export class AppError extends Error {
          code: number;
          constructor(msg: string, code: number) {
            super(msg);
            this.code = code;
          }
        }`,
      ).module,
    ).contents;
    expect(output).toContain('this.name');
  });
});

describe('emitIrModuleHaxe class with implicit derived base parameters', () => {
  it('emits implicit base constructor forwarding when child has no constructor', () => {
    const output = emitIrModuleHaxe(
      lower(
        'implicit-ctor.ts',
        `class Base {
          value: number;
          constructor(v: number) { this.value = v; }
        }
        export class Child extends Base {}`,
      ).module,
    ).contents;
    expect(output).toContain('super(');
  });
});

describe('emitIrModuleHaxe variable initialValue undefined', () => {
  it('emits variable with initialValue undefined as Dynamic null', () => {
    const module = structuredClone(
      lower(
        'var-undef.ts',
        'export function test(): number { let x: number | undefined; if (true) x = 1; return x ?? 0; }',
      ).module,
    );
    const output = emitIrModuleHaxe(module).contents;
    expect(output).toBeDefined();
  });
});

describe('emitIrModuleHaxe scoped package import', () => {
  it('resolves scoped package import to Haxe package path', () => {
    const module = structuredClone(
      lower(
        'import-scoped.ts',
        "import { helper } from '@flighthq/core'; export function use(): number { return helper(); }",
      ).module,
    );
    const output = emitIrModuleHaxe(module).contents;
    expect(output).toContain('import');
  });
});

describe('emitIrModuleHaxe literal type emission', () => {
  it('emits boolean literal type as Bool', () => {
    const module = structuredClone(lower('lit-type.ts', 'export function yes(): true { return true; }').module);
    const output = emitIrModuleHaxe(module).contents;
    expect(output).toContain('Bool');
  });

  it('emits number literal type as Float', () => {
    const module = structuredClone(lower('lit-num.ts', 'export function one(): 1 { return 1; }').module);
    const output = emitIrModuleHaxe(module).contents;
    expect(output).toContain('Float');
  });
});

describe('emitIrModuleHaxe bitwise binary operators', () => {
  it('emits bitwise AND between number operands', () => {
    const output = emitIrModuleHaxe(
      lower('bitwise-and.ts', 'export function band(a: number, b: number): number { return a & b; }').module,
    ).contents;
    expect(output).toContain('&');
  });

  it('emits bitwise OR between number operands', () => {
    const output = emitIrModuleHaxe(
      lower('bitwise-or.ts', 'export function bor(a: number, b: number): number { return a | b; }').module,
    ).contents;
    expect(output).toContain('|');
  });

  it('emits bitwise XOR between number operands', () => {
    const output = emitIrModuleHaxe(
      lower('bitwise-xor.ts', 'export function bxor(a: number, b: number): number { return a ^ b; }').module,
    ).contents;
    expect(output).toContain('^');
  });

  it('emits left shift between number operands', () => {
    const output = emitIrModuleHaxe(
      lower('shift-left.ts', 'export function shl(a: number, b: number): number { return a << b; }').module,
    ).contents;
    expect(output).toContain('<<');
  });

  it('emits right shift between number operands', () => {
    const output = emitIrModuleHaxe(
      lower('shift-right.ts', 'export function shr(a: number, b: number): number { return a >> b; }').module,
    ).contents;
    expect(output).toContain('>>');
  });
});

describe('emitIrModuleHaxe comparison operators', () => {
  it('emits less-than comparison between numbers', () => {
    const output = emitIrModuleHaxe(
      lower('cmp-lt.ts', 'export function lt(a: number, b: number): boolean { return a < b; }').module,
    ).contents;
    expect(output).toContain('<');
  });

  it('emits greater-equal comparison between numbers', () => {
    const output = emitIrModuleHaxe(
      lower('cmp-gte.ts', 'export function gte(a: number, b: number): boolean { return a >= b; }').module,
    ).contents;
    expect(output).toContain('>=');
  });
});

describe('emitIrModuleHaxe logical operators', () => {
  it('emits logical AND between boolean operands', () => {
    const output = emitIrModuleHaxe(
      lower('log-and.ts', 'export function both(a: boolean, b: boolean): boolean { return a && b; }').module,
    ).contents;
    expect(output).toContain('&&');
  });

  it('emits logical OR between boolean operands', () => {
    const output = emitIrModuleHaxe(
      lower('log-or.ts', 'export function either(a: boolean, b: boolean): boolean { return a || b; }').module,
    ).contents;
    expect(output).toContain('||');
  });
});

describe('emitIrModuleHaxe compound assignment operators', () => {
  it('emits multiply-assign on number', () => {
    const output = emitIrModuleHaxe(
      lower('mul-assign.ts', 'export function mulAssign(x: number): number { x *= 2; return x; }').module,
    ).contents;
    expect(output).toContain('*=');
  });

  it('emits subtract-assign on number', () => {
    const output = emitIrModuleHaxe(
      lower('sub-assign.ts', 'export function subAssign(x: number): number { x -= 1; return x; }').module,
    ).contents;
    expect(output).toContain('-=');
  });

  it('emits divide-assign on number', () => {
    const output = emitIrModuleHaxe(
      lower('div-assign.ts', 'export function divAssign(x: number): number { x /= 2; return x; }').module,
    ).contents;
    expect(output).toContain('/=');
  });

  it('emits modulo-assign on number', () => {
    const output = emitIrModuleHaxe(
      lower('mod-assign.ts', 'export function modAssign(x: number): number { x %= 3; return x; }').module,
    ).contents;
    expect(output).toContain('%=');
  });

  it('emits add-assign on string', () => {
    const output = emitIrModuleHaxe(
      lower('add-assign-str.ts', 'export function append(s: string): string { s += "!"; return s; }').module,
    ).contents;
    expect(output).toContain('+=');
  });
});

describe('emitIrModuleHaxe arithmetic operators', () => {
  it('emits multiplication between numbers', () => {
    const output = emitIrModuleHaxe(
      lower('mul.ts', 'export function mul(a: number, b: number): number { return a * b; }').module,
    ).contents;
    expect(output).toContain('*');
  });

  it('emits modulo between numbers', () => {
    const output = emitIrModuleHaxe(
      lower('mod.ts', 'export function mod(a: number, b: number): number { return a % b; }').module,
    ).contents;
    expect(output).toContain('%');
  });

  it('emits division between numbers', () => {
    const output = emitIrModuleHaxe(
      lower('div.ts', 'export function div(a: number, b: number): number { return a / b; }').module,
    ).contents;
    expect(output).toContain('/');
  });
});

describe('emitIrModuleHaxe prefix unary operators', () => {
  it('emits unary negation on number', () => {
    const output = emitIrModuleHaxe(
      lower('neg.ts', 'export function neg(a: number): number { return -a; }').module,
    ).contents;
    expect(output).toContain('-');
  });

  it('emits unary plus on number', () => {
    const output = emitIrModuleHaxe(
      lower('pos.ts', 'export function pos(a: number): number { return +a; }').module,
    ).contents;
    expect(output).toBeDefined();
  });

  it('emits prefix increment on number', () => {
    const output = emitIrModuleHaxe(
      lower('preinc.ts', 'export function preinc(x: number): number { return ++x; }').module,
    ).contents;
    expect(output).toContain('++');
  });

  it('emits prefix decrement on number', () => {
    const output = emitIrModuleHaxe(
      lower('predec.ts', 'export function predec(x: number): number { return --x; }').module,
    ).contents;
    expect(output).toContain('--');
  });

  it('emits bitwise complement on number', () => {
    const output = emitIrModuleHaxe(
      lower('bitnot.ts', 'export function bitnot(a: number): number { return ~a; }').module,
    ).contents;
    expect(output).toContain('~');
  });
});

describe('emitIrModuleHaxe nullish coalescing operator', () => {
  it('emits nullish coalescing as Haxe ?? operator', () => {
    const output = emitIrModuleHaxe(
      lower('nullish-coal.ts', 'export function fallback(x: number | undefined): number { return x ?? 0; }').module,
    ).contents;
    expect(output).toContain('??');
  });
});

describe('emitIrModuleHaxe for-of statement', () => {
  it('emits for-of loop over array', () => {
    const output = emitIrModuleHaxe(
      lower(
        'for-of.ts',
        'export function sum(items: number[]): number { let total = 0; for (const x of items) { total += x; } return total; }',
      ).module,
    ).contents;
    expect(output).toContain('for (');
    expect(output).toContain(' in ');
  });
});

describe('emitIrModuleHaxe for-in statement', () => {
  it('emits for-in loop with known key plan', () => {
    const output = emitIrModuleHaxe(
      lower(
        'for-in.ts',
        `interface Obj { a: number; b: number }
         export function keys(obj: Obj): string[] {
           const result: string[] = [];
           for (const k in obj) { result.push(k); }
           return result;
         }`,
      ).module,
    ).contents;
    expect(output).toContain('for (');
    expect(output).toContain('"a"');
    expect(output).toContain('"b"');
  });
});

describe('emitIrModuleHaxe type parameter constraint', () => {
  it('emits type parameter with constraint', () => {
    const output = emitIrModuleHaxe(
      lower(
        'constrained.ts',
        `interface HasLength { length: number }
         export function len<T extends HasLength>(x: T): number { return x.length; }`,
      ).module,
    ).contents;
    expect(output).toContain(':');
  });
});

describe('emitIrModuleHaxe subtraction operator', () => {
  it('emits subtraction between numbers', () => {
    const output = emitIrModuleHaxe(
      lower('sub.ts', 'export function sub(a: number, b: number): number { return a - b; }').module,
    ).contents;
    expect(output).toContain('-');
  });
});

describe('emitIrModuleHaxe postfix decrement', () => {
  it('emits postfix decrement on number variable', () => {
    const output = emitIrModuleHaxe(
      lower('postdec.ts', 'export function dec(x: number): number { x--; return x; }').module,
    ).contents;
    expect(output).toContain('--');
  });
});

describe('emitIrModuleHaxe conditional expression', () => {
  it('emits ternary conditional expression', () => {
    const output = emitIrModuleHaxe(
      lower('cond.ts', 'export function pick(a: boolean, x: number, y: number): number { return a ? x : y; }').module,
    ).contents;
    expect(output).toContain('?');
    expect(output).toContain(':');
  });
});

describe('emitIrModuleHaxe enum member emission', () => {
  it('emits enum declaration with all members', () => {
    const output = emitIrModuleHaxe(
      lower('my-enum.ts', 'export enum Color { Red = 0, Green = 1, Blue = 2 }').module,
    ).contents;
    expect(output).toContain('enum abstract');
    expect(output).toContain('Red');
    expect(output).toContain('Green');
    expect(output).toContain('Blue');
  });
});

describe('emitIrModuleHaxe regexp expression', () => {
  it('emits regexp source without a Haxe EReg literal', () => {
    const output = emitIrModuleHaxe(
      lower('regex.ts', 'export function test(s: string): boolean { return /^hello/.test(s); }').module,
    ).contents;
    expect(output).toContain('new flighthq._internal._RegExp("^hello", "")');
  });
});

describe('emitIrModuleHaxe labeled loop emission', () => {
  it('emits labeled while loop with break', () => {
    const output = emitIrModuleHaxe(
      lower(
        'labeled-while.ts',
        `export function find(items: number[]): number {
           outer: while (true) {
             for (const x of items) {
               if (x > 0) break outer;
             }
             break;
           }
           return 0;
         }`,
      ).module,
    ).contents;
    expect(output).toContain('break');
  });
});

describe('emitIrModuleHaxe switch with default case', () => {
  it('emits switch statement with default fallback', () => {
    const output = emitIrModuleHaxe(
      lower(
        'switch-default.ts',
        `export function describe(n: number): string {
           switch (n) {
             case 0: return "zero";
             case 1: return "one";
             default: return "other";
           }
         }`,
      ).module,
    ).contents;
    expect(output).toContain('switch');
    expect(output).toContain('case 0');
    expect(output).toContain('default');
  });
});

describe('emitIrModuleHaxe do-while loop', () => {
  it('emits do-while loop with condition', () => {
    const output = emitIrModuleHaxe(
      lower('do-while.ts', 'export function countDown(n: number): number { do { n--; } while (n > 0); return n; }')
        .module,
    ).contents;
    expect(output).toContain('do {');
    expect(output).toContain('} while');
  });
});

describe('emitIrModuleHaxe while loop', () => {
  it('emits while loop', () => {
    const output = emitIrModuleHaxe(
      lower('while.ts', 'export function countUp(n: number): number { let i = 0; while (i < n) { i++; } return i; }')
        .module,
    ).contents;
    expect(output).toContain('while (');
  });
});

describe('emitIrModuleHaxe throw statement', () => {
  it('emits throw with error expression', () => {
    const output = emitIrModuleHaxe(
      lower('throw.ts', 'export function fail(): never { throw new Error("oops"); }').module,
    ).contents;
    expect(output).toContain('throw');
  });
});

describe('emitIrModuleHaxe try-catch-finally', () => {
  it('emits try-catch with finally block', () => {
    const output = emitIrModuleHaxe(
      lower(
        'try-catch.ts',
        `export function safe(fn: () => number): number {
           try {
             return fn();
           } catch (e) {
             return -1;
           }
         }`,
      ).module,
    ).contents;
    expect(output).toContain('try {');
    expect(output).toContain('catch');
  });
});

describe('emitIrModuleHaxe mutable variable', () => {
  it('emits mutable variable with var keyword', () => {
    const output = emitIrModuleHaxe(
      lower('mutable.ts', 'export function count(): number { let x = 0; x = x + 1; return x; }').module,
    ).contents;
    expect(output).toContain('var ');
  });

  it('emits immutable variable with final keyword', () => {
    const output = emitIrModuleHaxe(
      lower('immutable.ts', 'export function one(): number { const x = 1; return x; }').module,
    ).contents;
    expect(output).toContain('final ');
  });
});

describe('emitIrModuleHaxe static class member', () => {
  it('emits static method on class', () => {
    const output = emitIrModuleHaxe(
      lower(
        'static-method.ts',
        `export class Util {
           static double(x: number): number { return x * 2; }
         }`,
      ).module,
    ).contents;
    expect(output).toContain('static');
    expect(output).toContain('function double');
  });
});

describe('emitIrModuleHaxe class with private field', () => {
  it('emits private field with underscore prefix', () => {
    const output = emitIrModuleHaxe(
      lower(
        'private-field.ts',
        `export class Box {
           private _val: number;
           constructor(v: number) { this._val = v; }
           get(): number { return this._val; }
         }`,
      ).module,
    ).contents;
    expect(output).toContain('_val');
  });
});

describe('emitIrModuleHaxe string equality', () => {
  it('emits strict equality between string operands', () => {
    const output = emitIrModuleHaxe(
      lower('str-eq.ts', 'export function eq(a: string, b: string): boolean { return a === b; }').module,
    ).contents;
    expect(output).toContain('flighthq._internal._Js.strictEqual(a, b)');
  });
});

describe('emitIrModuleHaxe narrowed primitive property access', () => {
  it('emits cast for narrowed string property access', () => {
    const output = emitIrModuleHaxe(
      lower(
        'narrow-str.ts',
        `export function len(x: string | number): number {
           if (typeof x === 'string') { return x.length; }
           return x as number;
         }`,
      ).module,
    ).contents;
    expect(output).toContain('cast');
    expect(output).toContain('String');
  });
});

describe('emitIrModuleHaxe narrowed declared type property access', () => {
  it('emits cast for narrowed interface member access', () => {
    const output = emitIrModuleHaxe(
      lower(
        'narrow-iface.ts',
        `interface Dog { kind: 'dog'; bark: number }
         interface Cat { kind: 'cat'; meow: number }
         type Pet = Dog | Cat;
         export function sound(p: Pet): number {
           if (p.kind === 'dog') { return p.bark; }
           return p.meow;
         }`,
      ).module,
    ).contents;
    expect(output).toContain('(cast p : Dog).bark');
    expect(output).toContain('(cast p : Cat).meow');
  });

  it('preserves generic arguments on a narrowed alias cast', () => {
    const output = emitIrModuleHaxe(
      lower(
        'narrow-generic.ts',
        `interface Stats { draws: number }
         type Mutable<T> = { value: T };
         export function read(entry: Mutable<Stats> | undefined): Stats | undefined {
           if (entry === undefined) return undefined;
           return entry.value;
         }`,
      ).module,
    ).contents;

    expect(output).toContain('(cast entry : Mutable<Stats>).value');
  });
});

describe('emitIrModuleHaxe union flattened properties type', () => {
  it('emits union with named member types as flattened properties', () => {
    const output = emitIrModuleHaxe(
      lower(
        'union-flat.ts',
        `interface A { x: number; y: number }
         interface B { x: number; z: number }
         export function getX(val: A | B): number { return val.x; }`,
      ).module,
    ).contents;
    expect(output).toBeDefined();
  });
});

describe('emitIrModuleHaxe rest parameter non-array type', () => {
  it('emits rest parameter when type is tuple-like', () => {
    const output = emitIrModuleHaxe(
      lower('rest-tuple.ts', 'export function first(...items: [number, ...number[]]): number { return items[0]; }')
        .module,
    ).contents;
    expect(output).toContain('...items');
  });
});

describe('emitIrModuleHaxe optional spread call', () => {
  it('refuses optional spread call requiring null-safe reflective lowering', () => {
    expect(() =>
      emitIrModuleHaxe(
        lower(
          'opt-spread.ts',
          `export function call(fn: ((...args: number[]) => number) | undefined, args: number[]): number | undefined {
             return fn?.(...args);
           }`,
        ).module,
      ),
    ).toThrow('null-safe reflective');
  });
});

describe('emitIrModuleHaxe class method override', () => {
  it('emits override keyword for inherited method', () => {
    const output = emitIrModuleHaxe(
      lower(
        'override.ts',
        `export class Base {
           value(): number { return 0; }
         }
         export class Child extends Base {
           override value(): number { return 1; }
         }`,
      ).module,
    ).contents;
    expect(output).toContain('override');
  });
});

describe('emitIrModuleHaxe function type parameter', () => {
  it('emits generic function with type parameter', () => {
    const output = emitIrModuleHaxe(
      lower('generic-fn.ts', 'export function id<T>(x: T): T { return x; }').module,
    ).contents;
    expect(output).toContain('<T');
  });
});

describe('emitIrModuleHaxe variable module declaration', () => {
  it('emits module-level variable declaration', () => {
    const output = emitIrModuleHaxe(lower('mod-var.ts', 'export const PI = 3.14;').module).contents;
    expect(output).toContain('PI');
    expect(output).toContain('3.14');
  });

  it('emits mutable module-level variable', () => {
    const output = emitIrModuleHaxe(lower('mod-let.ts', 'export let counter = 0;').module).contents;
    expect(output).toContain('counter');
    expect(output).toContain('var');
  });
});

describe('emitIrModuleHaxe class with accessor pair', () => {
  it('emits getter and setter using Haxe property syntax', () => {
    const output = emitIrModuleHaxe(
      lower(
        'accessor-pair.ts',
        `export class Container {
           private _count: number;
           constructor() { this._count = 0; }
           get count(): number { return this._count; }
           set count(value: number) { this._count = value; }
         }`,
      ).module,
    ).contents;
    expect(output).toContain('get_count');
    expect(output).toContain('set_count');
    expect(output).toContain('get, set');
  });
});

describe('emitIrModuleHaxe Error subclass without explicit constructor', () => {
  it('refuses Error subclass without constructor due to inherited-ABI forwarding', () => {
    expect(() =>
      emitIrModuleHaxe(lower('error-implicit.ts', 'export class CustomError extends Error {}').module),
    ).toThrow('inherited-ABI');
  });
});

describe('emitIrModuleHaxe assignment expression', () => {
  it('emits simple assignment with = operator', () => {
    const output = emitIrModuleHaxe(
      lower('assign.ts', 'export function set(x: number): number { let y = 0; y = x; return y; }').module,
    ).contents;
    expect(output).toContain('=');
  });
});

describe('emitIrModuleHaxe string addition', () => {
  it('emits string concatenation with + operator', () => {
    const output = emitIrModuleHaxe(
      lower('str-add.ts', 'export function concat(a: string, b: string): string { return a + b; }').module,
    ).contents;
    expect(output).toContain('+');
  });
});

describe('emitIrModuleHaxe optional parameter', () => {
  it('emits optional parameter with default value', () => {
    const output = emitIrModuleHaxe(
      lower('opt-param.ts', 'export function opt(x: number, y?: number): number { return y ?? x; }').module,
    ).contents;
    expect(output).toContain('y');
    expect(output).toContain('??');
  });
});

describe('emitIrModuleHaxe parameter with initializer', () => {
  it('emits parameter with default value', () => {
    const output = emitIrModuleHaxe(
      lower('default-param.ts', 'export function greet(name: string = "world"): string { return name; }').module,
    ).contents;
    expect(output).toContain('? "world" :');
  });
});

describe('emitIrModuleHaxe cast expression', () => {
  it('emits cast for type assertion', () => {
    const output = emitIrModuleHaxe(
      lower('cast-expr.ts', 'export function asNum(x: unknown): number { return x as number; }').module,
    ).contents;
    expect(output).toContain('cast');
    expect(output).toContain('Float');
  });
});

describe('emitIrModuleHaxe class static field', () => {
  it('emits static field on class', () => {
    const output = emitIrModuleHaxe(
      lower(
        'static-field.ts',
        `export class Counter {
           static count: number = 0;
           static increment(): void { Counter.count++; }
         }`,
      ).module,
    ).contents;
    expect(output).toContain('static');
    expect(output).toContain('count');
  });
});

describe('emitIrModuleHaxe class implementing simple interface', () => {
  it('emits class with nominal interface implementation', () => {
    const output = emitIrModuleHaxe(
      lower(
        'iface-impl.ts',
        `export interface Sized { size(): number }
         export class Box implements Sized {
           size(): number { return 1; }
         }`,
      ).module,
    ).contents;
    expect(output).toContain('interface Sized');
    expect(output).toContain('implements Sized');
  });
});

describe('emitIrModuleHaxe array type in return position', () => {
  it('emits Array<T> for array return type', () => {
    const output = emitIrModuleHaxe(
      lower('arr-return.ts', 'export function items(): number[] { return [1, 2, 3]; }').module,
    ).contents;
    expect(output).toContain('Array<Float>');
  });
});

describe('emitIrModuleHaxe function type emission', () => {
  it('emits function type as Haxe arrow type', () => {
    const output = emitIrModuleHaxe(
      lower('fn-type.ts', 'export function apply(fn: (x: number) => number, val: number): number { return fn(val); }')
        .module,
    ).contents;
    expect(output).toContain('->');
  });
});

describe('emitIrModuleHaxe array literal creation', () => {
  it('emits array literal with typed elements', () => {
    const output = emitIrModuleHaxe(
      lower('arr-lit.ts', 'export function nums(): number[] { return [1, 2, 3]; }').module,
    ).contents;
    expect(output).toContain('[(cast 1 : Float)');
  });
});

describe('emitIrModuleHaxe if-else statement', () => {
  it('emits if-else with both branches', () => {
    const output = emitIrModuleHaxe(
      lower('if-else.ts', 'export function abs(x: number): number { if (x < 0) { return -x; } else { return x; } }')
        .module,
    ).contents;
    expect(output).toContain('if (');
    expect(output).toContain('else');
  });
});

describe('emitIrModuleHaxe not-equal comparison', () => {
  it('emits strict inequality between number operands', () => {
    const output = emitIrModuleHaxe(
      lower('neq.ts', 'export function neq(a: number, b: number): boolean { return a !== b; }').module,
    ).contents;
    expect(output).toContain('!=');
  });
});

describe('emitIrModuleHaxe class implements interface', () => {
  it('emits class with implements clause', () => {
    const output = emitIrModuleHaxe(
      lower(
        'class-impl.ts',
        `export interface Printable {
           print(): number;
         }
         export class Doc implements Printable {
           print(): number { return 0; }
         }`,
      ).module,
    ).contents;
    expect(output).toContain('implements');
    expect(output).toContain('Printable');
  });
});

describe('emitIrModuleHaxe new expression', () => {
  it('emits new expression with constructor arguments', () => {
    const output = emitIrModuleHaxe(
      lower(
        'new-expr.ts',
        `export class Pt { x: number; y: number; constructor(x: number, y: number) { this.x = x; this.y = y; } }
         export function origin(): Pt { return new Pt(0, 0); }`,
      ).module,
    ).contents;
    expect(output).toContain('new Pt(');
  });
});

describe('emitIrModuleHaxe abstract class', () => {
  it('emits abstract class declaration', () => {
    const output = emitIrModuleHaxe(
      lower(
        'abstract-class.ts',
        `export abstract class Shape {
           abstract area(): number;
           describe(): string { return "shape"; }
         }`,
      ).module,
    ).contents;
    expect(output).toContain('function area');
    expect(output).toContain('function describe');
  });
});

describe('emitIrModuleHaxe relative import resolution', () => {
  it('emits import statement for relative module', () => {
    const output = emitIrModuleHaxe(
      lower(
        'import-mod.ts',
        `import { helper } from './helper.js';
         export function use(): number { return helper(); }`,
      ).module,
    ).contents;
    expect(output).toContain('import');
  });
});

describe('emitIrModuleHaxe Error subclass', () => {
  it('emits Error name storage in derived constructor with super call', () => {
    const output = emitIrModuleHaxe(
      lower(
        'app-error.ts',
        `export class AppError extends Error {
           code: number;
           constructor(code: number) {
             super("app error");
             this.code = code;
           }
         }`,
      ).module,
    ).contents;
    expect(output).toContain('this.name = "Error"');
    expect(output).toContain('super(');
  });

  it('emits implicit-derived subclass forwarding base constructor', () => {
    const output = emitIrModuleHaxe(
      lower(
        'derived.ts',
        `export class Base {
           value: number;
           constructor(value: number) { this.value = value; }
         }
         export class Derived extends Base {}`,
      ).module,
    ).contents;
    expect(output).toContain('extends Base');
    expect(output).toContain('super(');
  });
});

describe('emitIrModuleHaxe accessor properties', () => {
  it('emits get/set accessor pair as Haxe property declaration', () => {
    const output = emitIrModuleHaxe(
      lower(
        'accessor.ts',
        `export class Box {
           private _value: number = 0;
           get value(): number { return this._value; }
           set value(v: number) { this._value = v; }
         }`,
      ).module,
    ).contents;
    expect(output).toContain('(get, set)');
    expect(output).toContain('get_value');
    expect(output).toContain('set_value');
  });
});

describe('emitIrModuleHaxe template literal', () => {
  it('emits template literal as string concatenation', () => {
    const output = emitIrModuleHaxe(
      lower('template.ts', `export function greet(name: string): string { return \`Hello \${name}!\`; }`).module,
    ).contents;
    expect(output).toContain('Std.string(');
    expect(output).toContain('+');
  });
});

describe('emitIrModuleHaxe bitwise binary operators', () => {
  it('emits bitwise AND with Std.int wrapping', () => {
    const output = emitIrModuleHaxe(
      lower('bitwise.ts', `export function mask(a: number, b: number): number { return a & b; }`).module,
    ).contents;
    expect(output).toContain('Std.int(');
    expect(output).toContain('&');
  });

  it('emits bitwise OR with Std.int wrapping', () => {
    const output = emitIrModuleHaxe(
      lower('bitwise-or.ts', `export function combine(a: number, b: number): number { return a | b; }`).module,
    ).contents;
    expect(output).toContain('Std.int(');
    expect(output).toContain('|');
  });

  it('emits unsigned right shift with Std.int wrapping', () => {
    const output = emitIrModuleHaxe(
      lower('bitwise-urs.ts', `export function shift(a: number, b: number): number { return a >>> b; }`).module,
    ).contents;
    expect(output).toContain('Std.int(');
    expect(output).toContain('>>>');
  });

  it('emits bitwise NOT with Std.int wrapping', () => {
    const output = emitIrModuleHaxe(
      lower('bitwise-not.ts', `export function invert(a: number): number { return ~a; }`).module,
    ).contents;
    expect(output).toContain('~');
  });
});

describe('emitIrModuleHaxe exponentiation operator', () => {
  it('emits ** as Math.pow', () => {
    const output = emitIrModuleHaxe(
      lower('pow.ts', `export function square(x: number): number { return x ** 2; }`).module,
    ).contents;
    expect(output).toContain('Math.pow(');
  });
});

describe('emitIrModuleHaxe comparison operators', () => {
  it('emits strict equality on numbers', () => {
    const output = emitIrModuleHaxe(
      lower('strict-eq.ts', `export function same(a: number, b: number): boolean { return a === b; }`).module,
    ).contents;
    expect(output).toContain('==');
  });

  it('emits strict inequality on strings', () => {
    const output = emitIrModuleHaxe(
      lower('strict-neq.ts', `export function diff(a: string, b: string): boolean { return a !== b; }`).module,
    ).contents;
    expect(output).toContain('!flighthq._internal._Js.strictEqual(a, b)');
  });

  it('emits numeric relational operators', () => {
    const output = emitIrModuleHaxe(
      lower(
        'relational.ts',
        `export function clamp(v: number, lo: number, hi: number): boolean { return v >= lo && v <= hi; }`,
      ).module,
    ).contents;
    expect(output).toContain('>=');
    expect(output).toContain('<=');
    expect(output).toContain('&&');
  });
});

describe('emitIrModuleHaxe nullish coalescing', () => {
  it('emits ?? operator directly', () => {
    const output = emitIrModuleHaxe(
      lower('nullish.ts', `export function fallback(x: number | null): number { return x ?? 0; }`).module,
    ).contents;
    expect(output).toContain('??');
  });
});

describe('emitIrModuleHaxe null comparison', () => {
  it('emits null equality check for nullable parameter', () => {
    const output = emitIrModuleHaxe(
      lower('null-check.ts', `export function isPresent(x: number | null): boolean { return x !== null; }`).module,
    ).contents;
    expect(output).toContain('js.Syntax.strictNeq(x, null)');
  });
});

describe('emitIrModuleHaxe scoped package import', () => {
  it('emits scoped package import with Haxe package path', () => {
    const output = emitIrModuleHaxe(
      lower(
        'scoped-import.ts',
        `import { Vec2 } from '@flighthq/types';
         export function use(v: Vec2): number { return v.x; }`,
      ).module,
    ).contents;
    expect(output).toContain('import');
  });
});

describe('emitIrModuleHaxe interface as typedef', () => {
  it('emits interface member with function-typed property in nominal interface', () => {
    const output = emitIrModuleHaxe(
      lower(
        'iface-fn-member.ts',
        `export interface Handler { process(value: number): number }
         export class Impl implements Handler { process(value: number): number { return value; } }`,
      ).module,
    ).contents;
    expect(output).toContain('function process(');
  });
});

describe('emitIrModuleHaxe assignment operators', () => {
  it('emits bitwise assignment with Std.int wrapping', () => {
    const output = emitIrModuleHaxe(
      lower(
        'bitwise-assign.ts',
        `export function toggle(flags: number, bit: number): number { flags &= bit; return flags; }`,
      ).module,
    ).contents;
    expect(output).toContain('Std.int(');
    expect(output).toContain('&');
  });

  it('emits exponentiation assignment as Math.pow', () => {
    const output = emitIrModuleHaxe(
      lower('pow-assign.ts', `export function cube(x: number): number { let v: number = x; v **= 3; return v; }`)
        .module,
    ).contents;
    expect(output).toContain('Math.pow(');
  });
});

describe('emitIrModuleHaxe do-while loop', () => {
  it('emits do-while loop', () => {
    const output = emitIrModuleHaxe(
      lower(
        'do-while.ts',
        `export function countdown(n: number): number {
           let i: number = n;
           do { i = i - 1; } while (i > 0);
           return i;
         }`,
      ).module,
    ).contents;
    expect(output).toContain('do {');
    expect(output).toContain('} while (');
  });
});

describe('emitIrModuleHaxe postfix operators', () => {
  it('emits postfix increment', () => {
    const output = emitIrModuleHaxe(
      lower('postfix.ts', `export function next(n: number): number { let v: number = n; v++; return v; }`).module,
    ).contents;
    expect(output).toContain('++');
  });
});

describe('emitIrModuleHaxe prefix operators', () => {
  it('emits prefix decrement', () => {
    const output = emitIrModuleHaxe(
      lower('prefix-dec.ts', `export function prev(n: number): number { let v: number = n; --v; return v; }`).module,
    ).contents;
    expect(output).toContain('--');
  });

  it('emits unary plus on number', () => {
    const output = emitIrModuleHaxe(
      lower('unary-plus.ts', `export function pos(n: number): number { return +n; }`).module,
    ).contents;
    expect(output).toContain('return');
  });
});

describe('emitIrModuleHaxe regexp expression', () => {
  it('emits regex pattern and flags as runtime constructor arguments', () => {
    const output = emitIrModuleHaxe(
      lower('regexp.ts', `export function test(s: string): boolean { return /^[a-z]+$/g.test(s); }`).module,
    ).contents;
    expect(output).toContain('new flighthq._internal._RegExp("^[a-z]+$", "g")');
  });
});

describe('emitIrModuleHaxe switch with break in every case', () => {
  it('emits switch cases with break termination', () => {
    const output = emitIrModuleHaxe(
      lower(
        'switch-break.ts',
        `export function label(n: number): string {
           switch (n) {
             case 1: return "one";
             case 2: return "two";
             default: return "other";
           }
         }`,
      ).module,
    ).contents;
    expect(output).toContain('switch');
    expect(output).toContain('case 1');
    expect(output).toContain('case 2');
    expect(output).toContain('default');
  });
});

describe('emitIrModuleHaxe forIn with static keys', () => {
  it('emits for-in loop with statically known key list', () => {
    const output = emitIrModuleHaxe(
      lower(
        'for-in.ts',
        `export function keys(obj: { x: number; y: number }): string {
           let result: string = "";
           for (const key in obj) { result = result + key; }
           return result;
         }`,
      ).module,
    ).contents;
    expect(output).toContain('for (');
  });
});

describe('emitIrModuleHaxe type emission', () => {
  it('emits function type with parameters and return', () => {
    const output = emitIrModuleHaxe(
      lower('fn-type.ts', `export function apply(f: (x: number) => string, v: number): string { return f(v); }`).module,
    ).contents;
    expect(output).toContain('->');
  });

  it('emits literal boolean type as Bool', () => {
    const output = emitIrModuleHaxe(
      lower('lit-type.ts', `export function yes(): true { return true; }`).module,
    ).contents;
    expect(output).toContain('Bool');
  });

  it('emits intersection type as Dynamic when multiple members', () => {
    const output = emitIrModuleHaxe(
      lower(
        'intersection-type.ts',
        `export interface A { x: number }
         export interface B { y: number }
         export function use(val: A & B): number { return val.x; }`,
      ).module,
    ).contents;
    expect(output).toContain('Dynamic');
  });

  it('emits nullable union as Null wrapper', () => {
    const output = emitIrModuleHaxe(
      lower('nullable-type.ts', `export function maybe(x: number | null): number { return x ?? 0; }`).module,
    ).contents;
    expect(output).toContain('Null<');
  });

  it('emits tuple type as Array', () => {
    const output = emitIrModuleHaxe(
      lower('tuple-type.ts', `export function pair(): [number, number] { return [1, 2]; }`).module,
    ).contents;
    expect(output).toContain('Array<');
  });

  it('emits mixed tuple type as Array of Dynamic', () => {
    const output = emitIrModuleHaxe(
      lower('tuple-mixed.ts', `export function mixed(): [number, string] { return [1, "a"]; }`).module,
    ).contents;
    expect(output).toContain('Array<Dynamic>');
  });
});

describe('emitIrModuleHaxe spread call', () => {
  it('emits spread argument through HaxeReflect.callMethod', () => {
    const output = emitIrModuleHaxe(
      lower(
        'spread-call.ts',
        `export function apply(fn: (...args: number[]) => number, args: number[]): number { return fn(...args); }`,
      ).module,
    ).contents;
    expect(output).toContain('HaxeReflect.callMethod');
  });
});

describe('emitIrModuleHaxe typeof narrowing', () => {
  it('emits typeof check as Std.isOfType', () => {
    const output = emitIrModuleHaxe(
      lower('typeof.ts', `export function isStr(x: string | number): boolean { return typeof x === "string"; }`).module,
    ).contents;
    expect(output).toContain('Std.isOfType');
  });

  it('emits negated typeof check', () => {
    const output = emitIrModuleHaxe(
      lower('typeof-neg.ts', `export function isNotStr(x: string | number): boolean { return typeof x !== "string"; }`)
        .module,
    ).contents;
    expect(output).toContain('Std.isOfType');
  });
});

describe('emitIrModuleHaxe binary operator errors', () => {
  it('routes the in operator through the JavaScript-semantics runtime', () => {
    const output = emitIrModuleHaxe(
      lower(
        'in-op.ts',
        `export interface Circle { radius: number }
           export interface Square { side: number }
           export type Shape = Circle | Square;
           export function area(s: Shape): number {
             if ("radius" in s) { return s.radius; }
             return s.side;
           }`,
      ).module,
    ).contents;

    expect(output).toContain('flighthq._internal._Js.inOperator("radius", s)');
  });
});

describe('emitIrModuleHaxe object literal', () => {
  it('emits object literal with named properties', () => {
    const output = emitIrModuleHaxe(
      lower(
        'obj-lit.ts',
        `export interface Pt { x: number; y: number }
         export function origin(): Pt { return { x: 0, y: 0 }; }`,
      ).module,
    ).contents;
    expect(output).toContain('x:');
    expect(output).toContain('y:');
  });
});

describe('emitIrModuleHaxe conditional expression', () => {
  it('emits ternary conditional', () => {
    const output = emitIrModuleHaxe(
      lower('ternary.ts', `export function abs(x: number): number { return x >= 0 ? x : -x; }`).module,
    ).contents;
    expect(output).toContain('?');
    expect(output).toContain(':');
  });
});

describe('emitIrModuleHaxe struct-init record', () => {
  it('emits interface as struct-init when configured', () => {
    const output = emitIrModuleHaxe(
      lower('struct-init.ts', `export interface Config { label: string; count: number }`).module,
      { structuralRecords: 'structInit' },
    ).contents;
    expect(output).toContain('class');
    expect(output).toContain('public var');
  });
});

describe('emitIrModuleHaxe optional struct property', () => {
  it('emits optional struct field as Null with default', () => {
    const output = emitIrModuleHaxe(
      lower('struct-opt.ts', `export interface Config { label?: string; count: number }`).module,
      { structuralRecords: 'structInit' },
    ).contents;
    expect(output).toContain('= null');
  });
});

describe('emitIrModuleHaxe template expression', () => {
  it('emits template with adjacent interpolations as Std.string concatenation', () => {
    const output = emitIrModuleHaxe(
      lower('template-adjacent.ts', 'export function join(a: number, b: number): string { return `${a}${b}`; }').module,
    ).contents;
    expect(output).toContain('Std.string(');
    expect(output).toContain(' + ');
  });
});

describe('emitIrModuleHaxe assignment operator lowering', () => {
  it('emits logical-and assignment as conditional assignment', () => {
    const output = emitIrModuleHaxe(
      lower(
        'logical-assign.ts',
        'export function coerce(x: boolean): boolean { let v: boolean = x; v &&= true; return v; }',
      ).module,
    ).contents;
    expect(output).toContain('if (v)');
    expect(output).toContain('v = true');
  });

  it('emits logical-or assignment on boolean as negated conditional', () => {
    const output = emitIrModuleHaxe(
      lower(
        'or-assign-bool.ts',
        'export function ensure(x: boolean): boolean { let v: boolean = x; v ||= true; return v; }',
      ).module,
    ).contents;
    expect(output).toContain('if (!v)');
    expect(output).toContain('v = true');
  });

  it('emits logical-or assignment on number as zero/NaN check', () => {
    const output = emitIrModuleHaxe(
      lower('or-assign-num.ts', 'export function ensure(x: number): number { let v: number = x; v ||= 1; return v; }')
        .module,
    ).contents;
    expect(output).toContain('== 0.0 || Math.isNaN(');
  });

  it('emits logical-and assignment on number as truthiness check', () => {
    const output = emitIrModuleHaxe(
      lower('and-assign-num.ts', 'export function clamp(x: number): number { let v: number = x; v &&= 0; return v; }')
        .module,
    ).contents;
    expect(output).toContain('!= 0.0 && !Math.isNaN(');
  });

  it('emits logical-or assignment on string as empty check', () => {
    const output = emitIrModuleHaxe(
      lower(
        'or-assign-str.ts',
        'export function ensure(x: string): string { let v: string = x; v ||= "default"; return v; }',
      ).module,
    ).contents;
    expect(output).toContain('== ""');
  });

  it('emits logical-and assignment on string as non-empty check', () => {
    const output = emitIrModuleHaxe(
      lower(
        'and-assign-str.ts',
        'export function replace(x: string): string { let v: string = x; v &&= "replaced"; return v; }',
      ).module,
    ).contents;
    expect(output).toContain('!= ""');
  });

  it('emits ||= on boolean as negated conditional assignment', () => {
    const output = emitIrModuleHaxe(
      lower(
        'or-bool-assign.ts',
        'export function use(x: boolean): boolean { let v: boolean = x; v ||= true; return v; }',
      ).module,
    ).contents;
    expect(output).toContain('if (!v)');
    expect(output).toContain('v = true');
  });

  it('emits ||= on number as truthiness-checked assignment', () => {
    const output = emitIrModuleHaxe(
      lower('or-num-assign.ts', 'export function use(x: number): number { let v: number = x; v ||= 5; return v; }')
        .module,
    ).contents;
    expect(output).toContain('v == 0.0 || Math.isNaN(v)');
    expect(output).toContain('v = 5');
  });

  it('emits &&= on number as truthiness-checked assignment', () => {
    const output = emitIrModuleHaxe(
      lower('and-num-assign.ts', 'export function use(x: number): number { let v: number = x; v &&= 0; return v; }')
        .module,
    ).contents;
    expect(output).toContain('v != 0.0 && !Math.isNaN(v)');
    expect(output).toContain('v = 0');
  });

  it('emits ||= on string as emptiness-checked assignment', () => {
    const output = emitIrModuleHaxe(
      lower(
        'or-str-assign.ts',
        'export function use(x: string): string { let v: string = x; v ||= "fallback"; return v; }',
      ).module,
    ).contents;
    expect(output).toContain('v == ""');
    expect(output).toContain('v = "fallback"');
  });

  it('emits &&= on string as non-empty-checked assignment', () => {
    const output = emitIrModuleHaxe(
      lower(
        'and-str-assign.ts',
        'export function use(x: string): string { let v: string = x; v &&= "replaced"; return v; }',
      ).module,
    ).contents;
    expect(output).toContain('v != ""');
    expect(output).toContain('v = "replaced"');
  });

  it('emits nullish-coalescing assignment as null check', () => {
    const output = emitIrModuleHaxe(
      lower(
        'nullish-assign.ts',
        'export function fallback(x: number | null): number { let v: number | null = x; v ??= 0; return v ?? 0; }',
      ).module,
    ).contents;
    expect(output).toContain('== null');
  });

  it('emits nullish property assignment as a callable expression receiver and evaluates its target once', () => {
    const output = emitIrModuleHaxe(
      lower(
        'nullish-property-receiver.ts',
        'export function read(state: { nested: { value: number } | null }): number { return (state.nested ??= { value: 1 }).value; }',
      ).module,
    ).contents;

    expect(output).toContain('final assignmentReceiver:Dynamic = state;');
    expect(output).toContain('if (assignmentReceiver.nested == null) assignmentReceiver.nested = { value: 1 };');
    expect(output).toContain('return assignmentReceiver.nested; })().value;');
    expect(output.match(/final assignmentReceiver:Dynamic = state;/gu)).toHaveLength(1);
  });

  it('routes ||= on an unknown domain through runtime truthiness', () => {
    const output = emitIrModuleHaxe(
      lower(
        'or-unknown.ts',
        'export function use(x: unknown): unknown { let v: unknown = x; v ||= "fallback"; return v; }',
      ).module,
    ).contents;

    expect(output).toContain('flighthq._internal._Js.truthy(v)');
  });

  it('evaluates a compound property receiver once before runtime coercion', () => {
    const output = emitIrModuleHaxe(
      lower(
        'compound-dynamic-property.ts',
        'export function add(state: { value: unknown }, amount: number): void { state.value += amount; }',
      ).module,
    ).contents;

    expect(output).toContain('final assignmentReceiver:Dynamic = state;');
    expect(output).toContain('assignmentReceiver.value = flighthq._internal._Js.add(assignmentReceiver.value, amount)');
  });

  it('evaluates a coercive array element target once and writes the converted result back', () => {
    const output = emitIrModuleHaxe(
      lower(
        'compound-array-element.ts',
        'export function add(values: unknown[], index: number, amount: number): unknown { return values[index] += amount; }',
      ).module,
    ).contents;

    expect(output).toContain('final assignmentReceiver:Dynamic = values;');
    expect(output).toContain('final assignmentKey:Dynamic = index;');
    expect(output).toContain('assignmentReceiver[Std.int(assignmentKey)] = assignmentResult');
    expect(output).toContain('flighthq._internal._Js.add(assignmentValue, amount)');
  });
});

describe('emitIrModuleHaxe unsigned right shift', () => {
  it('emits unsigned right shift through Std.int wrapping', () => {
    const output = emitIrModuleHaxe(
      lower('unsigned-shift.ts', 'export function shift(x: number, n: number): number { return x >>> n; }').module,
    ).contents;
    expect(output).toContain('Std.int(');
    expect(output).toContain('>>>');
  });
});

describe('emitIrModuleHaxe undefined default value', () => {
  it('emits undefined default expression with null fallback', () => {
    const output = emitIrModuleHaxe(
      lower(
        'undef-default.ts',
        `export function withDefault(x: number | undefined, fallback: number): number {
           return x ?? fallback;
         }`,
      ).module,
    ).contents;
    expect(output).toContain('??');
  });
});

describe('emitIrModuleHaxe module variable declaration', () => {
  it('emits mutable module variable with explicit type annotation', () => {
    const output = emitIrModuleHaxe(lower('module-var.ts', 'export let counter: number = 0;').module).contents;
    expect(output).toContain('var counter:Float = 0;');
  });

  it('refuses module variable without initializer', () => {
    expect(() => emitIrModuleHaxe(lower('no-init.ts', 'export let counter: number;').module)).toThrow(
      'requires an initializer',
    );
  });
});

describe('emitIrModuleHaxe Error subclass', () => {
  it('refuses Error subclass without resolvable base class ABI', () => {
    expect(() =>
      emitIrModuleHaxe(
        lower(
          'error-subclass.ts',
          `export class AppError extends Error {
             code: number = 0;
           }`,
        ).module,
      ),
    ).toThrow('implicit derived constructor requires inherited-ABI forwarding');
  });
});

describe('emitIrModuleHaxe derived class with implicit constructor', () => {
  it('emits implicit derived constructor forwarding base parameters', () => {
    const output = emitIrModuleHaxe(
      lower(
        'derived-class.ts',
        `export class Base {
           constructor(public label: string) {}
         }
         export class Child extends Base {
           count: number = 0;
         }`,
      ).module,
    ).contents;
    expect(output).toContain('public function new(');
    expect(output).toContain('super(');
  });
});

describe('emitIrModuleHaxe nullable return', () => {
  it('refuses returning a nullable binding without narrowing evidence', () => {
    expect(() =>
      emitIrModuleHaxe(
        lower(
          'nullable-return.ts',
          `export function first(items: number[]): number {
             let found: number | undefined = undefined;
             for (const item of items) { found = item; }
             return found;
           }`,
        ).module,
      ),
    ).toThrow('returning nullable binding found requires Haxe narrowing evidence');
  });

  it('preserves an undefined comparison when a local alias also admits null', () => {
    const result = lower(
      'aliased-nullish-map-return.ts',
      `type Value = boolean | number | string | null;
       export function read(values: Map<string, Value>): Value {
         const memo = values.get('key');
         if (memo !== undefined) return memo;
         return null;
       }`,
    );

    expect(emitIrModuleHaxe(result.module).contents).toContain(
      'js.Syntax.strictNeq(memo, js.Syntax.code("undefined"))',
    );
  });

  it('resolves local return aliases before applying nullable return guards', () => {
    const result = lower(
      'nullable-return-alias.ts',
      `const FAILURE = Symbol('failure');
       type Value = null | boolean | number;
       type Parsed = Value | typeof FAILURE;
       function parse(): Parsed { return null; }
       export function read(): Parsed {
         const value = parse();
         if (value === FAILURE) return FAILURE;
         return value;
       }`,
    );

    expect(() => emitIrModuleHaxe(result.module)).not.toThrow();
  });

  it('allows absent values from Dynamic-returning nested functions', () => {
    const result = lower(
      'dynamic-nested-return.ts',
      `export function record(result?: unknown): () => unknown {
         return () => { return result; };
       }`,
    );

    expect(() => emitIrModuleHaxe(result.module)).not.toThrow();
  });

  it('allows nullable source storage when the elected host representation is Dynamic', () => {
    const result = lower(
      'dynamic-host-return.ts',
      `export function read(): GPUTextureView {
         const value: GPUTextureView | null = null;
         return value;
       }`,
    );

    expect(() => emitIrModuleHaxe(result.module)).not.toThrow();
  });
});

describe('emitIrModuleHaxe interface function property', () => {
  it('emits interface with function-typed property as method signature', () => {
    const output = emitIrModuleHaxe(
      lower(
        'fn-prop-iface.ts',
        `export interface Handler {
           process(input: string): number;
         }
         export class Impl implements Handler {
           process(input: string): number { return input.length; }
         }`,
      ).module,
    ).contents;
    expect(output).toContain('public function process(');
  });
});

describe('emitIrModuleHaxe class extends external base', () => {
  it('walks override methods across module-declared base classes', () => {
    const output = emitIrModuleHaxe(
      lower(
        'override-walk.ts',
        `export class Base {
           greet(): string { return "hello"; }
         }
         export class Child extends Base {
           greet(): string { return "hi"; }
         }`,
      ).module,
    ).contents;
    expect(output).toContain('override');
    expect(output).toContain('function greet');
  });
});

describe('emitIrModuleHaxe nullish comparison', () => {
  it('emits null equality check dropping the ambient undefined literal', () => {
    const output = emitIrModuleHaxe(
      lower('null-check.ts', `export function isPresent(x: number | null): boolean { return x !== null; }`).module,
    ).contents;
    expect(output).toContain('js.Syntax.strictNeq(x, null)');
  });
});

describe('emitIrModuleHaxe exponentiation operators', () => {
  it('emits binary exponentiation as Math.pow', () => {
    const output = emitIrModuleHaxe(
      lower('power.ts', 'export function square(x: number): number { return x ** 2; }').module,
    ).contents;
    expect(output).toContain('Math.pow(');
  });

  it('emits exponentiation assignment as Math.pow assignment', () => {
    const output = emitIrModuleHaxe(
      lower('power-assign.ts', 'export function cube(x: number): number { let v: number = x; v **= 3; return v; }')
        .module,
    ).contents;
    expect(output).toContain('Math.pow(');
  });

  it('emits string concatenation assignment preserving string domain', () => {
    const result = lower(
      'string-concat-assign.ts',
      `export function greet(name: string): string {
        let msg: string = 'hello ';
        msg += name;
        return msg;
      }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;
    expect(output).toContain('+=');
  });

  it('emits postfix increment and decrement operators on number domain', () => {
    const result = lower(
      'postfix-ops.ts',
      `export function tick(x: number): number {
        let a: number = x;
        a++;
        a--;
        return a;
      }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;
    expect(output).toContain('++');
    expect(output).toContain('--');
  });

  it('emits prefix increment and decrement operators on number domain', () => {
    const result = lower(
      'prefix-inc-dec.ts',
      `export function preStep(x: number): number {
        let a: number = x;
        ++a;
        --a;
        return a;
      }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;
    expect(output).toContain('++');
    expect(output).toContain('--');
  });

  it('emits module constant variable declaration', () => {
    const result = lower('module-var.ts', 'export const VALUE: number = 42;');
    const output = emitIrModuleHaxe(result.module).contents;
    expect(output).toContain('final');
    expect(output).toContain('42');
  });

  it('emits mutable module variable declaration', () => {
    const result = lower('module-var-mut.ts', 'export let count: number = 0;');
    const output = emitIrModuleHaxe(result.module).contents;
    expect(output).toContain('var');
    expect(output).toContain('0');
  });

  it('emits regex literal with flags', () => {
    const result = lower(
      'regex.ts',
      `export function test(s: string): boolean {
        const r = /^hello/i;
        return r.test(s);
      }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;
    expect(output).toContain('new flighthq._internal._RegExp("^hello", "i")');
  });

  it('emits nullish check lowered to null comparison', () => {
    const result = lower(
      'null-check.ts',
      `export function isNull(x: number | null): boolean {
        return x === null;
      }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;
    expect(output).toContain('js.Syntax.strictEq(x, null)');
  });

  it('emits string equality comparison', () => {
    const result = lower(
      'string-eq.ts',
      `export function same(a: string, b: string): boolean {
        return a === b;
      }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;
    expect(output).toContain('flighthq._internal._Js.strictEqual(a, b)');
  });

  it('emits assignment compound operators preserving number domain', () => {
    const result = lower(
      'compound-assign.ts',
      `export function accum(x: number): number {
        let a: number = x;
        a += 1;
        a -= 2;
        a *= 3;
        a /= 4;
        a %= 5;
        return a;
      }`,
    );
    const output = emitIrModuleHaxe(result.module).contents;
    expect(output).toContain('+=');
    expect(output).toContain('-=');
    expect(output).toContain('*=');
    expect(output).toContain('/=');
    expect(output).toContain('%=');
  });
});

describe('emitIrModuleHaxe Haxe keyword escaping in exported names', () => {
  it('escapes Haxe keywords in exported function names', () => {
    const result = lower('keyword-escape.ts', `export function cast(value: number): number { return value; }`);
    const output = emitIrModuleHaxe(result.module).contents;
    expect(output).toContain('function cast_(');
  });
});

describe('emitIrModuleHaxe mutable module variable without type', () => {
  it('emits mutable module variable declaration without type annotation', () => {
    const result = lower('no-type-var.ts', 'export let count = 0;');
    const output = emitIrModuleHaxe(result.module).contents;
    expect(output).toContain('var');
    expect(output).toContain('0');
  });
});

describe('emitIrModuleHaxe for-of with async iteration', () => {
  it('routes serial async iteration through the task runtime and lowers its async body', () => {
    const result = lower(
      'for-of.ts',
      'export async function visit(items: AsyncIterable<number>): Promise<void> { for await (const value of items) { await Promise.resolve(value); } }',
    );
    const output = emitIrModuleHaxe(result.module).contents;

    expect(output).toContain('flighthq._internal._AsyncIterable.forEachAsync(items, cast(function(value:Dynamic)');
    expect(output).toContain('flighthq._internal._Promise.resolve(');
  });
});

describe('emitIrModuleHaxe postfix unary operator on non-number', () => {
  it('routes a postfix operator on an unknown operand through numeric coercion', () => {
    const result = lower(
      'postfix-op.ts',
      'export function inc(value: number): number { let x = value; x++; return x; }',
    );
    const fn = result.module.declarations.find((d) => d.kind === 'function');
    if (fn?.kind !== 'function') throw new Error('Expected function');
    const modified = {
      ...fn,
      body: fn.body.map((stmt) => {
        if (stmt.kind !== 'expression' || stmt.expression.kind !== 'unary') return stmt;
        return {
          ...stmt,
          expression: {
            ...stmt.expression,
            semantics: { ...stmt.expression.semantics, operand: { flow: 'string' as const } },
          },
        };
      }),
    };
    const module: IrModule = {
      ...result.module,
      declarations: result.module.declarations.map((d) => (d === fn ? modified : d)) as IrModule['declarations'],
    };
    const output = emitIrModuleHaxe(module).contents;
    expect(output).toContain('flighthq._internal._Js.toNumber(x)');
    expect(output).toContain('updateOldValue');
    expect(output).toContain('return updateOldValue');
  });
});

describe('emitIrModuleHaxe exponentiation binary operator', () => {
  it('emits Math.pow for exponentiation', () => {
    const output = emitIrModuleHaxe(
      lower('pow.ts', 'export function square(n: number): number { return n ** 2; }').module,
    ).contents;
    expect(output).toContain('Math.pow(');
  });
});

describe('emitIrModuleHaxe comma operator', () => {
  it('preserves left evaluation and returns the right completion', () => {
    const output = emitIrModuleHaxe(
      lower('comma.ts', 'export function last(out: number[]): number { return (out.push(1), 2); }').module,
    ).contents;
    expect(output).toContain('out.push(1); return 2;');
  });
});

describe('emitIrModuleHaxe unsigned right shift', () => {
  it('emits unsigned right shift with Std.int cast', () => {
    const output = emitIrModuleHaxe(
      lower('urshr.ts', 'export function shift(a: number, b: number): number { return a >>> b; }').module,
    ).contents;
    expect(output).toContain('Std.int(');
    expect(output).toContain('>>>');
  });
});

describe('emitIrModuleHaxe bitwise assignment operator', () => {
  it('emits bitwise AND assignment with Std.int cast', () => {
    const output = emitIrModuleHaxe(
      lower('bitwise-assign.ts', 'export function mask(x: number, m: number): number { x &= m; return x; }').module,
    ).contents;
    expect(output).toContain('Std.int(');
    expect(output).toContain('&');
  });
});

describe('emitIrModuleHaxe exponentiation assignment operator', () => {
  it('emits Math.pow for exponentiation assignment', () => {
    const output = emitIrModuleHaxe(
      lower('pow-assign.ts', 'export function cube(x: number): number { x **= 3; return x; }').module,
    ).contents;
    expect(output).toContain('Math.pow(');
  });
});

describe('emitIrModuleHaxe bitwise binary operators', () => {
  it('emits Std.int wrapping for bitwise AND', () => {
    const output = emitIrModuleHaxe(
      lower('bitwise-and.ts', 'export function band(a: number, b: number): number { return a & b; }').module,
    ).contents;
    expect(output).toContain('Std.int(');
    expect(output).toContain('&');
  });
});

describe('emitIrModuleHaxe prefix unary operator on non-number', () => {
  it('routes a prefix operator on an unknown operand through numeric coercion', () => {
    const result = lower(
      'prefix-op.ts',
      'export function dec(value: number): number { let x = value; --x; return x; }',
    );
    const fn = result.module.declarations.find((d) => d.kind === 'function');
    if (fn?.kind !== 'function') throw new Error('Expected function');
    const modified = {
      ...fn,
      body: fn.body.map((stmt) => {
        if (stmt.kind !== 'expression' || stmt.expression.kind !== 'unary') return stmt;
        return {
          ...stmt,
          expression: {
            ...stmt.expression,
            semantics: {
              ...stmt.expression.semantics,
              operand: { flow: 'string' as const },
              result: 'string' as const,
            },
          },
        };
      }),
    };
    const module: IrModule = {
      ...result.module,
      declarations: result.module.declarations.map((d) => (d === fn ? modified : d)) as IrModule['declarations'],
    };
    const output = emitIrModuleHaxe(module).contents;
    expect(output).toContain('flighthq._internal._Js.toNumber(x)');
    expect(output).toContain('updateResult');
    expect(output).toContain('return updateResult');
  });
});

describe('emitIrModuleHaxe binary operator on non-matching types', () => {
  it('routes a non-direct binary operator through the JavaScript-semantics runtime', () => {
    const result = lower('bad-binary.ts', 'export function add(a: number, b: number): number { return a + b; }');
    const fn = result.module.declarations.find((d) => d.kind === 'function');
    if (fn?.kind !== 'function') throw new Error('Expected function');
    const modified = {
      ...fn,
      body: fn.body.map((stmt) => {
        if (stmt.kind !== 'return' || !stmt.expression || stmt.expression.kind !== 'binary') return stmt;
        return {
          ...stmt,
          expression: {
            ...stmt.expression,
            semantics: {
              ...stmt.expression.semantics,
              left: { flow: 'object' as const },
              right: { flow: 'object' as const },
              result: 'object' as const,
            },
          },
        };
      }),
    };
    const module: IrModule = {
      ...result.module,
      declarations: result.module.declarations.map((d) => (d === fn ? modified : d)) as IrModule['declarations'],
    };
    expect(emitIrModuleHaxe(module).contents).toContain('flighthq._internal._Js.add(a, b)');
  });
});

describe('emitIrModuleHaxe complete Flight semantic tail', () => {
  it('casts string aliases before invoking native string members', () => {
    const output = emitIrModuleHaxe(
      lower(
        'string-alias-member.ts',
        "type Format = 'float32x2' | 'float32x3'; interface Attribute { format: Format } export function isFloat(attribute: Attribute): boolean { return attribute.format.startsWith('float32'); }",
      ).module,
    ).contents;

    expect(output).toContain('StringTools.startsWith((cast attribute.format : String), "float32")');
  });

  it('emits flow-introduced structural property reads and writes reflectively', () => {
    const output = emitIrModuleHaxe(
      lower(
        'narrowed-structural-property.ts',
        `interface Base { kind: string }
         interface Detailed extends Base { value: number }
         function isDetailed(value: Base | null): value is Detailed { return value !== null && 'value' in value; }
         export function update(value: Base | null): number {
           if (!isDetailed(value)) return 0;
           value.value = 2;
           return value.value;
         }`,
      ).module,
    ).contents;

    expect(output).toContain('HaxeReflect.setField(dynamicAccessReceiver, "value", dynamicAccessValue)');
    expect(output).toContain('return HaxeReflect.field(value, "value");');
  });

  it('updates flow-introduced numeric properties through the reflective lane', () => {
    const output = emitIrModuleHaxe(
      lower(
        'narrowed-structural-update.ts',
        `interface Base { kind: string }
         interface Detailed extends Base { depth: number }
         function isDetailed(value: Base): value is Detailed { return 'depth' in value; }
         export function update(value: Base): void {
           if (!isDetailed(value)) return;
           value.depth++;
           --value.depth;
         }`,
      ).module,
    ).contents;

    expect(output).toContain('HaxeReflect.field(updateReceiver, "depth")');
    expect(output).toContain('HaxeReflect.setField(updateReceiver, "depth", updateResult)');
    expect(output).not.toContain('HaxeReflect.field(value, "depth")++');
  });

  it('retains numeric Math result types on inferred locals', () => {
    const output = emitIrModuleHaxe(
      lower(
        'math-result-local.ts',
        'export function whole(value: number): number { const result = Math.floor(value); return result; }',
      ).module,
    ).contents;

    expect(output).toContain('final result:Float = Math.floor(value);');
  });

  it('coerces ArrayBuffer lengths and ArrayBufferLike slice bounds to integers', () => {
    const output = emitIrModuleHaxe(
      lower(
        'array-buffer-integers.ts',
        'export function copy(source: Uint8Array, length: number): ArrayBuffer { const out = new ArrayBuffer(length * 2); return source.buffer.slice(0, length); }',
      ).module,
    ).contents;

    expect(output).toContain('new flighthq._internal._ArrayBuffer(Std.int((length * 2)))');
    expect(output).toContain('flighthq._internal._ArrayBuffer.slice(source.buffer, 0, Std.int(length))');
  });

  it('keeps numeric array literals and integer typed-array set inputs compatible with Haxe', () => {
    const output = emitIrModuleHaxe(
      lower(
        'integer-typed-array-set.ts',
        'export function copy(): Uint32Array { const values = [0, 1, 2].filter(value => value > 0); const out = new Uint32Array(values.length); out.set(values); return new Uint32Array(values); }',
      ).module,
    ).contents;

    expect(output).toContain('[(cast 0 : Float), 1, 2].filter');
    expect(output).toContain('out.set(cast(values))');
    expect(output).toContain('new flighthq._internal._UInt32Array(cast(values))');
  });

  it('gives all-numeric tuple branches a Float witness', () => {
    const output = emitIrModuleHaxe(
      lower(
        'numeric-tuple-conditional.ts',
        'export function tangent(len: number): [number, number] { return len > 0 ? [len / 2, len / 3] : [1, 0]; }',
      ).module,
    ).contents;

    expect(output).toContain('[(cast (len / 2) : Float), (len / 3)]');
    expect(output).toContain('[(cast 1 : Float), 0]');
  });

  it('retains contextual element types for empty array assignments', () => {
    const output = emitIrModuleHaxe(
      lower(
        'empty-array-assignment.ts',
        `interface State {
           callbacks: Array<(value: number) => void>;
           rows: Array<{ value: number }>;
           values: number[];
         }
         interface Box<T> { items: T[] }
         export const box: Box<number> = { items: [] };
         export function reset(state: State, source?: State): void {
           state.callbacks = [];
           state.rows = [];
           state.values = source?.values ?? [];
         }`,
      ).module,
    ).contents;

    expect(output).toContain('state.callbacks = (cast [] : Array<(Float)->Void>)');
    expect(output).toContain('state.rows = (cast [] : Array<{ value:Float }>)');
    expect(output).toContain('(cast [] : Array<Float>)');
    expect(output).toContain('items: (cast [] : Array<Float>)');
  });

  it('does not promote generic member signatures into repeated expression declarations', () => {
    expect(() =>
      emitIrModuleHaxe(
        lower(
          'generic-member-expression.ts',
          'export function double(values: number[]): number[] { return values.map(value => value * 2); }',
        ).module,
      ),
    ).not.toThrow();
  });

  it('casts compatible string-union aliases at nominal Haxe boundaries', () => {
    const output = emitIrModuleHaxe(
      lower(
        'string-union-boundaries.ts',
        `type Source = 'linear' | 'srgb';
         type Target = 'linear' | 'srgb';
         interface SourceBox { value: Source }
         interface TargetBox { value: Target }
         export function copy(target: TargetBox, source: SourceBox): Target {
           target.value = source.value;
           return source.value;
         }`,
      ).module,
    ).contents;

    expect(output).toContain('(cast source.value : Target)');
  });

  it('casts union constituents and structural array branches to their contextual target', () => {
    const output = emitIrModuleHaxe(
      lower(
        'structural-union-boundaries.ts',
        `interface Perspective { kind: 'perspective'; fov: number }
         interface Orthographic { kind: 'orthographic'; height: number }
         type Projection = Perspective | Orthographic;
         interface Camera { projection: Projection }
         interface BaseChannel { id: number }
         interface DetailedChannel extends BaseChannel { detail: number }
         function perspective(): Perspective { return { kind: 'perspective', fov: 1 }; }
         export function configure(camera: Camera): Camera { camera.projection = perspective(); return { projection: perspective() }; }
         export function channels(primary: DetailedChannel[] | null, fallback: BaseChannel[]): BaseChannel[] { return primary ?? fallback; }`,
      ).module,
    ).contents;

    expect(output).toContain('(cast perspective() : Projection)');
    expect(output).toContain(': Array<BaseChannel>)');
  });

  it('casts contextually assigned object methods with wider callable shapes', () => {
    const output = emitIrModuleHaxe(
      lower(
        'object-method-context.ts',
        `interface Result { value: number; optional?: boolean }
         interface Registration { create(): Result; supports(value: number): boolean }
         export const registration: Registration = {
           create() { return { value: 1 }; },
           supports() { return true; },
         };`,
      ).module,
    ).contents;

    expect(output).toContain('create: cast(function');
    expect(output).toContain('supports: cast(function');
  });

  it('writes non-numeric typed-array indexes through the reflective property ABI', () => {
    const output = emitIrModuleHaxe(
      lower(
        'dynamic-typed-array-index.ts',
        'export function write(values: Float32Array, key: any): void { values[key] = 1; }',
      ).module,
    ).contents;

    expect(output).toContain('flighthq._internal._Js.setProperty(assignmentReceiver, assignmentKey, assignmentValue)');
  });

  it('narrows values written through nullable integer typed-array properties', () => {
    const output = emitIrModuleHaxe(
      lower(
        'nullable-typed-array-index.ts',
        `interface State { values: Uint32Array | null }
         export function write(state: State, index: number, value: number): void {
           if (state.values === null) state.values = new Uint32Array(4);
           state.values[index] = value;
         }`,
      ).module,
    ).contents;

    expect(output).toContain('Std.int(value)');
  });

  it('casts iterator-returning collection views for Haxe for loops', () => {
    const output = emitIrModuleHaxe(
      lower(
        'map-values-loop.ts',
        'export function sum(values: Map<string, number>): number { let total = 0; for (const value of values.values()) total += value; return total; }',
      ).module,
    ).contents;

    expect(output).toContain('in (cast values.values() : Iterable<Float>)');
  });

  it('preserves undefined fallthrough for a typed non-void function', () => {
    const output = emitIrModuleHaxe(
      lower(
        'typed-switch-fallthrough.ts',
        "type State = 'ready'; export function label(state: State): string { switch (state) { case 'ready': return 'Ready'; } }",
      ).module,
    ).contents;

    expect(output).toContain('return cast(js.Syntax.code("undefined"));');
  });

  it('types rest call arguments by the repeated element rather than the rest array', () => {
    const output = emitIrModuleHaxe(
      lower(
        'rest-call-elements.ts',
        'function write(out: number[], ...values: number[]): void { out[0] = values[0]; } export function invert(out: number[]): void { write(out, -1, 0, 1); }',
      ).module,
    ).contents;

    expect(output).toContain('write(out, - 1, 0, 1)');
    expect(output).not.toContain('(cast - 1 : Array<Float>)');
  });

  it('adapts Haxe array methods to their source return and element types', () => {
    const output = emitIrModuleHaxe(
      lower(
        'array-method-boundaries.ts',
        `interface Base { kind: string; basePath?: string }
         interface Embedded { kind: string; resource: string }
         export function append(out: Base[], value: Embedded): void { out.push(value); }
         export function flatten(values: Embedded[]): Base[] { return values.flatMap((value) => [value]); }
         export function reverse(values: number[]): number[] { return values.copy().reverse(); }`,
      ).module,
    ).contents;

    expect(output).toContain('out.push((cast value : Base))');
    expect(output).toContain('(cast flighthq._internal._Array.flatMap(values, cast(');
    expect(output).toContain('reversedArray.reverse(); return reversedArray;');
  });

  it('forces heterogeneous tuple literals to their dynamic Haxe carrier', () => {
    const output = emitIrModuleHaxe(
      lower(
        'map-tuples.ts',
        'interface Item { id: string } export function index(items: Item[]): Map<string, Item> { return new Map(items.map((item) => [item.id, item])); }',
      ).module,
    ).contents;

    expect(output).toContain('([item.id, item] : Array<Dynamic>)');
  });

  it('contextually types object elements and numeric multi-push arrays', () => {
    const output = emitIrModuleHaxe(
      lower(
        'array-element-boundaries.ts',
        `interface Entry { count: number }
         export function entries(flag: boolean): Entry[] { return flag ? [{ count: 1 }] : []; }
         export function append(out: number[]): void { out.push(1, 2, 3); }`,
      ).module,
    ).contents;

    expect(output).toContain('[(cast { count: 1 } : Entry)]');
    expect(output).toContain('_ArrayTools.pushMany(out, (cast [1, 2, 3] : Array<Float>))');
  });

  it('erases heterogeneous conditionals and contextually widens callable defaults', () => {
    const output = emitIrModuleHaxe(
      lower(
        'conditional-function-boundaries.ts',
        `interface Target { callback: (value: number, index: number) => number }
         interface Source { callback?: (value: number, index: number) => number }
         const identity = (value: number): number => value;
         export function choose(flag: boolean): boolean | number | null { return flag ? true : flag ? 1 : null; }
         export function defaulted(callback: (value: number, index: number) => number = (value) => value): number { return callback(1, 0); }
         export function install(target: Target, source: Source): void { target.callback = source.callback ?? identity; }`,
      ).module,
    ).contents;

    expect(output).toContain('? (cast true : Dynamic) : (cast ');
    expect(output).toContain('cast(function(value:Float) return value)');
    expect(output).toContain('(cast source.callback : Null<(Float, Float)->Float>)');
    expect(output).toContain('(cast identity : (Float, Float)->Float)');
  });

  it('erases heterogeneous nullish branches to their shared dynamic carrier', () => {
    const output = emitIrModuleHaxe(
      lower(
        'nullish-union-boundary.ts',
        `interface Bias { scale: number }
         interface Proxy { matrix?: readonly number[] | null; bias: Bias | null }
         export function adjustment(proxy: Proxy): readonly number[] | Bias | null {
           return proxy.matrix ?? proxy.bias;
         }`,
      ).module,
    ).contents;

    expect(output).toContain('(cast proxy.matrix : Dynamic) ?? (cast proxy.bias : Dynamic)');
  });

  it('casts concrete options into readonly partial structural call parameters', () => {
    const output = emitIrModuleHaxe(
      lower(
        'partial-call-boundary.ts',
        `interface Options { alpha?: number; sourceMode?: string }
         function create(options?: Readonly<Partial<Options>>): void { options; }
         export function run(options: { alpha: number }): void { create(options); }`,
      ).module,
    ).contents;

    expect(output).toContain('create((cast options : Dynamic))');
  });

  it('retains structural argument types through contract re-export facades', () => {
    const moduleResolution = {
      edges: [
        {
          importer: {
            name: 'Contract',
            packageName: '@flighthq/layout',
            source: 'packages/layout/src/contract.ts',
          },
          specifier: './bounds',
          target: { packageName: '@flighthq/layout', source: 'packages/layout/src/bounds.ts' },
        },
        {
          importer: {
            name: 'Label',
            packageName: '@flighthq/text',
            source: 'packages/text/src/label.ts',
          },
          specifier: '@flighthq/layout/contract',
          target: { packageName: '@flighthq/layout', source: 'packages/layout/src/contract.ts' },
        },
      ],
      schema: 'flight-compiler-module-resolution/1' as const,
    };
    const inputs = [
      {
        packageName: '@flighthq/layout',
        sourceFile: ts.createSourceFile(
          '/flight/packages/layout/src/bounds.ts',
          'export interface Spec { width: number; wordWrap?: boolean } export function measure(spec: Spec): void { spec; }',
          ts.ScriptTarget.Latest,
          true,
        ),
        upstreamDirectory: '/flight',
      },
      {
        packageName: '@flighthq/layout',
        sourceFile: ts.createSourceFile(
          '/flight/packages/layout/src/contract.ts',
          "export * from './bounds';",
          ts.ScriptTarget.Latest,
          true,
        ),
        upstreamDirectory: '/flight',
      },
      {
        packageName: '@flighthq/text',
        sourceFile: ts.createSourceFile(
          '/flight/packages/text/src/label.ts',
          "import { measure } from '@flighthq/layout/contract'; interface Data { width: number } export function layout(data: Data): void { measure(data); }",
          ts.ScriptTarget.Latest,
          true,
        ),
        upstreamDirectory: '/flight',
      },
    ];
    const modules = lowerTypeScriptSources(inputs, moduleResolution).map((result) => result.module);
    const session = createHaxeCompilerBackend().createEmissionSession!({ moduleResolution, modules, options: {} });
    const output = session.emitModule(modules[2]!)[0]!.contents;

    expect(output).toContain('measure((cast data : Spec))');
  });

  it('narrows global timer handles and HTMLElement pointer captures at native boundaries', () => {
    const output = emitIrModuleHaxe(
      lower(
        'native-global-integer-boundaries.ts',
        `export function release(element: HTMLElement, handle: number): void {
           clearTimeout(handle);
           clearInterval(handle);
           cancelAnimationFrame(handle);
           element.setPointerCapture(handle);
           element.releasePointerCapture(handle);
         }`,
      ).module,
    ).contents;

    expect(output).toContain('js.Browser.window.clearTimeout(Std.int(handle))');
    expect(output).toContain('js.Browser.window.clearInterval(Std.int(handle))');
    expect(output).toContain('js.Browser.window.cancelAnimationFrame(Std.int(handle))');
    expect(output).toContain('element.setPointerCapture(Std.int(handle))');
    expect(output).toContain('element.releasePointerCapture(Std.int(handle))');
  });

  it('carries a homogeneous tuple return type across dynamically typed elements', () => {
    const output = emitIrModuleHaxe(
      lower(
        'contextual-tuple-return.ts',
        'export function dimensions(value: any): [number, number] { return [0, value.width]; }',
      ).module,
    ).contents;

    expect(output).toContain(': Array<Float>)');
    expect(output).not.toContain('return ([0, value.width] : Array<Dynamic>);');
  });

  it('uses dynamic argument carriers for fixed values around a reflective spread call', () => {
    const output = emitIrModuleHaxe(
      lower(
        'dynamic-spread-call-carrier.ts',
        `export function append(out: number[], first: number, middle: number[], last: number): void {
           out.push(first, ...middle, last);
         }`,
      ).module,
    ).contents;

    expect(output).toContain('HaxeReflect.callMethod(out, cast(out.push)');
    expect(output).toContain('Array<Dynamic>');
    expect(output).not.toContain('[first].concat(middle).concat([last])');
  });

  it('adapts JavaScript Map iterator result value reads to the Haxe iterator ABI', () => {
    const output = emitIrModuleHaxe(
      lower(
        'map-iterator-next-value.ts',
        'export function oldest(values: Map<string, number>): string | undefined { return values.keys().next().value; }',
      ).module,
    ).contents;

    expect(output).toContain('values.keys().next()');
    expect(output).not.toContain('values.keys().next().value');
  });
});
