import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import type {
  CompilerModuleResolutionPlan,
  CompilerRuntimeExternalSymbolBinding,
  CompilerRuntimeExternalSymbolBindingPlan,
  IrExpression,
  TypeScriptLoweringResult,
} from '../../compiler-types/src/index.js';
import { lowerTypeScriptSource, lowerTypeScriptSources } from './typeScriptSemanticLowering.js';

function createEvidence(
  bindings: readonly CompilerRuntimeExternalSymbolBinding[],
): CompilerRuntimeExternalSymbolBindingPlan {
  return { bindings, contract: 'flight-runtime-contract/2' };
}

function createNativeEvidence(sourceName: string, space: 'type' | 'value' = 'type') {
  return { externalSymbol: { sourceName, space }, kind: 'native' as const };
}

function getReturnedExpression(result: Readonly<TypeScriptLoweringResult>): Readonly<IrExpression> {
  const declaration = result.module.declarations.find(
    (candidate) => candidate.kind === 'function' && candidate.binding.name === 'read',
  );
  const statement = declaration?.kind === 'function' ? declaration.body[0] : undefined;
  if (statement?.kind !== 'return' || !statement.expression) throw new Error('Expected read to return an expression');
  return statement.expression;
}

function lower(source: string, profileTypeNameEvidence?: CompilerRuntimeExternalSymbolBindingPlan) {
  const sourceFile = ts.createSourceFile('/flight/packages/net/src/read.ts', source, ts.ScriptTarget.Latest, true);
  return lowerTypeScriptSource(sourceFile, {
    packageName: '@flighthq/net',
    ...(profileTypeNameEvidence ? { profileTypeNameEvidence } : {}),
    upstreamDirectory: '/flight',
  });
}

function getReturnedPropertyType(source: string, evidence?: CompilerRuntimeExternalSymbolBindingPlan) {
  const result = lower(source, evidence);
  const expression = getReturnedExpression(result);
  if (expression.kind !== 'property') throw new Error('Expected read to return a property');
  expect(result.diagnostics).toEqual([]);
  return expression.type;
}

const response = (type: string) =>
  `export interface NetResponse { readonly body: string | ${type} | null }
   export function read(response: NetResponse) { return response.body; }`;

describe('TypeScript profile type-name evidence', () => {
  it('resolves a direct or source-aliased ambient spelling through one exact bound type identity', () => {
    const evidence = createEvidence([
      createNativeEvidence('Blob', 'value'),
      createNativeEvidence('File'),
      createNativeEvidence('Blob'),
    ]);
    const reversed = createEvidence([...evidence.bindings].reverse());
    const direct = getReturnedPropertyType(response('Blob'), evidence);
    const aliasSource = `type BinaryPayload = Blob; ${response('BinaryPayload')}`;
    const aliased = getReturnedPropertyType(aliasSource, reversed);

    expect(direct).toEqual(getReturnedPropertyType(response('Blob'), reversed));
    expect(
      direct?.kind === 'union' &&
        direct.types.some(
          (member) =>
            member.kind === 'named' && member.reference.kind === 'ambient' && member.reference.name === 'Blob',
        ),
    ).toBe(true);
    expect(aliased).toEqual(getReturnedPropertyType(aliasSource));
    expect(JSON.stringify(aliased)).toContain('"kind":"binding"');
    expect(JSON.stringify(aliased)).toContain('"name":"BinaryPayload"');
  });

  it('carries profile evidence through dependent type arguments', () => {
    const source = response('Promise<Blob>');
    const represented = getReturnedPropertyType(source, createEvidence([createNativeEvidence('Blob')]));

    const promise =
      represented?.kind === 'union'
        ? represented.types.find(
            (member) =>
              member.kind === 'named' && member.reference.kind === 'ambient' && member.reference.name === 'Promise',
          )
        : undefined;
    expect(promise).toMatchObject({
      kind: 'named',
      reference: { kind: 'ambient', name: 'Promise' },
      typeArguments: [{ kind: 'named', reference: { kind: 'ambient', name: 'Blob' } }],
    });
    expect(getReturnedPropertyType(source)).toBeUndefined();
  });

  it('preserves profile identity through a source alias and facade re-export', () => {
    const contracts = ts.createSourceFile(
      '/flight/packages/types/src/contracts.ts',
      `export type BinaryPayload = Blob;
       export interface NetResponse { readonly body: string | BinaryPayload | null }`,
      ts.ScriptTarget.Latest,
      true,
    );
    const facade = ts.createSourceFile(
      '/flight/packages/types/src/index.ts',
      `export type { NetResponse } from './contracts.js';`,
      ts.ScriptTarget.Latest,
      true,
    );
    const consumer = ts.createSourceFile(
      '/flight/packages/loader/src/read.ts',
      `import type { NetResponse } from '@flighthq/types';
       export function read(response: NetResponse) { return response.body; }`,
      ts.ScriptTarget.Latest,
      true,
    );
    const sources = [
      { packageName: '@flighthq/types', sourceFile: contracts, upstreamDirectory: '/flight' },
      { packageName: '@flighthq/types', sourceFile: facade, upstreamDirectory: '/flight' },
      { packageName: '@flighthq/loader', sourceFile: consumer, upstreamDirectory: '/flight' },
    ];
    const moduleResolution: CompilerModuleResolutionPlan = {
      edges: [
        {
          specifier: './contracts.js',
          target: { packageName: '@flighthq/types', source: 'packages/types/src/contracts.ts' },
        },
        {
          specifier: '@flighthq/types',
          target: { packageName: '@flighthq/types', source: 'packages/types/src/index.ts' },
        },
      ],
      schema: 'flight-compiler-module-resolution/1',
    };
    const withEvidence = lowerTypeScriptSources(sources, moduleResolution, {
      profileTypeNameEvidence: createEvidence([createNativeEvidence('Blob')]),
    });
    const withoutEvidence = lowerTypeScriptSources(sources, moduleResolution);
    const represented = getReturnedExpression(withEvidence[2]!);
    const absent = getReturnedExpression(withoutEvidence[2]!);
    const alias = withEvidence[0]!.module.declarations.find(
      (declaration) => declaration.kind === 'typeAlias' && declaration.binding.name === 'BinaryPayload',
    );

    expect(withEvidence.flatMap((result) => result.diagnostics)).toEqual([]);
    expect(alias).toMatchObject({
      kind: 'typeAlias',
      type: { kind: 'named', reference: { kind: 'ambient', name: 'Blob' } },
    });
    expect(represented).toEqual(absent);
    expect(represented).toMatchObject({ kind: 'property', type: { kind: 'union' } });
    expect(JSON.stringify(represented)).toContain('"kind":"binding"');
    expect(JSON.stringify(represented)).toContain('"name":"BinaryPayload"');
  });

  it('keeps missing, ambiguous, value-space, and non-profile names unrepresented', () => {
    const source = response('Blob');

    expect(getReturnedPropertyType(source)).toBeUndefined();
    expect(getReturnedPropertyType(source, createEvidence([createNativeEvidence('Blob', 'value')]))).toBeUndefined();
    expect(
      getReturnedPropertyType(source, createEvidence([createNativeEvidence('Blob'), createNativeEvidence('Blob')])),
    ).toBeUndefined();
    expect(getReturnedPropertyType(response('File'), createEvidence([createNativeEvidence('Blob')]))).toBeUndefined();
  });

  it('does not reinterpret a project declaration that conflicts with a profile source name', () => {
    const source = `interface Blob { readonly id: number }
      ${response('Blob')}`;
    const withoutEvidence = getReturnedPropertyType(source);
    const withEvidence = getReturnedPropertyType(source, createEvidence([createNativeEvidence('Blob')]));

    expect(withEvidence).toEqual(withoutEvidence);
    expect(JSON.stringify(withEvidence)).not.toContain('"kind":"ambient","name":"Blob"');
  });
});
