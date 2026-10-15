import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import type {
  CompilerModuleResolutionPlan,
  IrExpression,
  IrFunctionDeclaration,
} from '../../compiler-types/src/index.js';
import { lowerTypeScriptSources } from './typeScriptSemanticLowering.js';

function lowerFunctions(source: string): readonly Readonly<IrFunctionDeclaration>[] {
  const moduleResolution: CompilerModuleResolutionPlan = {
    edges: [{ specifier: './body', target: { packageName: '@flighthq/net', source: 'packages/net/src/body.ts' } }],
    schema: 'flight-compiler-module-resolution/1',
  };
  const input = (file: string, text: string) => ({
    packageName: '@flighthq/net',
    sourceFile: ts.createSourceFile(`/flight/packages/net/src/${file}`, text, ts.ScriptTarget.Latest, true),
    upstreamDirectory: '/flight',
  });
  const results = lowerTypeScriptSources(
    [
      input(
        'body.ts',
        `export type Body = string | ArrayBuffer | ArrayBufferView | null;
         export interface Request { body?: Body; alternate?: Body }
         export interface Envelope { request?: Request }
         export type OtherBody = string | null;
         export interface OtherRequest { body?: OtherBody }`,
      ),
      input('consumer.ts', `import type { Body, Envelope, OtherRequest, Request } from './body';\n${source}`),
    ],
    moduleResolution,
  );
  expect(results.flatMap((result) => result.diagnostics)).toEqual([]);
  const consumer = results.find((result) => result.module.source.endsWith('consumer.ts'))!;
  return consumer.module.declarations.filter(
    (declaration): declaration is IrFunctionDeclaration => declaration.kind === 'function',
  );
}

function binaryProperty(
  expression: Readonly<IrExpression> | undefined,
): Readonly<Extract<IrExpression, { kind: 'property' }>> {
  if (expression?.kind !== 'binary' || expression.left.kind !== 'property') {
    throw new TypeError('Expected a binary expression with a property operand');
  }
  return expression.left;
}

describe('nested nullable property flow evidence', () => {
  it('attaches narrowing only to the exact guarded declaration path', () => {
    const [exact, unrelated, otherDeclaration] = lowerFunctions(`
      export function exact(request: Request): boolean {
        return request.body !== undefined && request.body !== null;
      }
      export function unrelated(first: Request, second: Request): boolean {
        return first.body !== undefined && second.body !== null && first.alternate !== null;
      }
      export function otherDeclaration(first: Request, other: OtherRequest): boolean {
        return first.body !== undefined && other.body !== null;
      }
    `);
    if (!exact || !unrelated || !otherDeclaration) throw new TypeError('Expected functions');
    const exactReturn = exact.body[0];
    const exactAnd = exactReturn?.kind === 'return' ? exactReturn.expression : undefined;
    const exactRight = exactAnd?.kind === 'binary' ? binaryProperty(exactAnd.right) : undefined;
    const unrelatedReturn = unrelated.body[0];
    const unrelatedAnd = unrelatedReturn?.kind === 'return' ? unrelatedReturn.expression : undefined;
    const outerLeft =
      unrelatedAnd?.kind === 'binary' && unrelatedAnd.left.kind === 'binary' ? unrelatedAnd.left : undefined;
    const secondBody = outerLeft?.kind === 'binary' ? binaryProperty(outerLeft.right) : undefined;
    const alternate = unrelatedAnd?.kind === 'binary' ? binaryProperty(unrelatedAnd.right) : undefined;
    const otherReturn = otherDeclaration.body[0];
    const otherAnd = otherReturn?.kind === 'return' ? otherReturn.expression : undefined;
    const otherBody = otherAnd?.kind === 'binary' ? binaryProperty(otherAnd.right) : undefined;

    expect(exactRight).toMatchObject({
      name: 'body',
      narrowedType: { kind: 'named', reference: { binding: { name: 'Body' } } },
    });
    expect(exactRight?.object).toMatchObject({
      kind: 'identifier',
      reference: { binding: exact.parameters[0]?.binding },
    });
    for (const property of [secondBody, alternate, otherBody]) {
      expect(property).not.toHaveProperty('narrowedType');
      expect(property).not.toHaveProperty('presence');
    }
    expect(otherBody?.object).toMatchObject({
      kind: 'identifier',
      reference: { binding: otherDeclaration.parameters[1]?.binding },
    });
  });

  it('clears a property proof across mutation and keeps optional-chain identity separate', () => {
    const [mutated, chained] = lowerFunctions(`
      export function mutated(request: Request, replacement: Body | undefined): boolean {
        if (request.body === undefined) return false;
        request.body = replacement;
        return request.body !== null;
      }
      export function chained(envelope: Envelope): boolean {
        return envelope.request?.body !== null;
      }
    `);
    if (!mutated || !chained) throw new TypeError('Expected functions');
    const mutatedReturn = mutated.body[2];
    const mutatedProperty = mutatedReturn?.kind === 'return' ? binaryProperty(mutatedReturn.expression) : undefined;
    const chainedReturn = chained.body[0];
    const chainedProperty = chainedReturn?.kind === 'return' ? binaryProperty(chainedReturn.expression) : undefined;

    expect(mutatedProperty).not.toHaveProperty('narrowedType');
    expect(mutatedProperty).not.toHaveProperty('presence');
    expect(chainedProperty).toMatchObject({
      name: 'body',
      optional: true,
      optionalChain: { shortCircuit: 'nullish' },
    });
  });
});
