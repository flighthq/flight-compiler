import ts from 'typescript';

import { lowerTypeScriptSource } from '../../compiler-semantic/src/index.js';
import type { IrExpression, IrModule } from '../../compiler-types/src/index.js';
import { collectIrModulesRuntimeExternalConstructorInvocations } from './compilerRuntimeExternalConstructorReachability.js';

describe('collectIrModulesRuntimeExternalConstructorInvocations', () => {
  it('collects normalized direct ambient constructors by fixed or dynamic argument count', () => {
    const first = lower(
      'first.ts',
      'export function create(values: [number]): void { new Uint8Array(); new Uint8Array(3); new Map(); new Map(...values); }',
    );
    const second = lower('second.ts', 'export function create(): void { new Uint8Array(3); }');
    const reverse = lower(
      'reverse.ts',
      'export function create(values: [number]): void { new Map(...values); new Map(); }',
    );

    expect(collectIrModulesRuntimeExternalConstructorInvocations([second, first])).toEqual([
      { externalSymbol: { sourceName: 'Map', space: 'value' }, providedArgumentCount: 0 },
      { externalSymbol: { sourceName: 'Map', space: 'value' }, providedArgumentCount: 'dynamic' },
      { externalSymbol: { sourceName: 'Uint8Array', space: 'value' }, providedArgumentCount: 0 },
      { externalSymbol: { sourceName: 'Uint8Array', space: 'value' }, providedArgumentCount: 1 },
    ]);
    expect(collectIrModulesRuntimeExternalConstructorInvocations([reverse])).toEqual([
      { externalSymbol: { sourceName: 'Map', space: 'value' }, providedArgumentCount: 0 },
      { externalSymbol: { sourceName: 'Map', space: 'value' }, providedArgumentCount: 'dynamic' },
    ]);
  });

  it('collects qualified ambient namespace constructors while ignoring bound constructors', () => {
    const module = lower(
      'bound.ts',
      "class Local {} export function create(namespace: { Value: typeof Local }): void { new Local(); new namespace.Value(); new Intl.Collator('en'); }",
    );

    expect(collectIrModulesRuntimeExternalConstructorInvocations([module])).toEqual([
      { externalSymbol: { sourceName: 'Intl.Collator', space: 'value' }, providedArgumentCount: 1 },
    ]);
  });

  it('normalizes ambient source identity and does not mutate caller-owned modules', () => {
    const module = lower('normalized.ts', 'export function create(): void { new Map(); }');
    const declaration = module.declarations.find((item) => item.kind === 'function');
    const statement = declaration?.kind === 'function' ? declaration.body[0] : undefined;
    const expression = statement?.kind === 'expression' ? statement.expression : undefined;
    if (expression?.kind !== 'new' || expression.callee.kind !== 'identifier') {
      throw new Error('Expected ambient constructor');
    }
    (expression.callee as { reference: unknown }).reference = { kind: 'ambient', name: 'Ma\u0301p' };
    const snapshot = structuredClone(module);

    expect(collectIrModulesRuntimeExternalConstructorInvocations([module])).toEqual([
      { externalSymbol: { sourceName: 'Máp', space: 'value' }, providedArgumentCount: 0 },
    ]);
    expect(module).toEqual(snapshot);
  });

  it('collects hand-authored dynamic constructor evidence from the expression shape', () => {
    const module = lower('empty.ts', '');
    const dynamicConstructor = {
      arguments: [{ expression: { kind: 'literal', value: 1 }, kind: 'spread' }],
      callee: { kind: 'identifier', reference: { kind: 'ambient', name: 'External' } },
      kind: 'new',
      semantics: {},
      typeArguments: [],
    } satisfies IrExpression;
    const subject = {
      ...module,
      exports: [{ expression: dynamicConstructor, kind: 'default' }],
    } satisfies IrModule;

    expect(collectIrModulesRuntimeExternalConstructorInvocations([subject])).toEqual([
      { externalSymbol: { sourceName: 'External', space: 'value' }, providedArgumentCount: 'dynamic' },
    ]);
  });
});

function lower(file: string, source: string): IrModule {
  return lowerTypeScriptSource(
    ts.createSourceFile(`/flight/packages/runtime/src/${file}`, source, ts.ScriptTarget.Latest, true),
    { packageName: '@flighthq/runtime', upstreamDirectory: '/flight' },
  ).module;
}
