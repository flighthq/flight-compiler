import ts from 'typescript';

import { lowerTypeScriptSource } from '../../compiler-semantic/src/index.js';
import type { IrExpression, IrModule } from '../../compiler-types/src/index.js';
import { createCompilerLoweringPassExtraArgumentErasure } from './compilerExtraArgumentErasureLowering.js';
import { lowerIrModuleWithCompilerPasses } from './compilerLoweringPass.js';

describe('createCompilerLoweringPassExtraArgumentErasure', () => {
  it('preserves left-to-right argument evaluation inside each conditional or repeated expression context', () => {
    const module = lower(`
      function effect(value: number): number { return value; }
      function choose(value: number): number { return value; }
      export function read(flag: boolean, cached: number | undefined): number {
        while (choose(effect(1), effect(2)) < 0) { break; }
        return flag ? choose(effect(3), effect(4)) : cached ?? choose(effect(5), effect(6));
      }
      export default choose(effect(7), effect(8));
    `);
    const before = structuredClone(module);
    const output = lowerIrModuleWithCompilerPasses(module, [createCompilerLoweringPassExtraArgumentErasure()], {
      verificationDepth: 'idempotence',
    });
    const read = output.declarations.find(
      (declaration) => declaration.kind === 'function' && declaration.binding.name === 'read',
    );
    if (read?.kind !== 'function') throw new Error('Expected read function');
    const loop = read.body[0];
    const returned = read.body[1];
    const exported = output.exports.find((item) => item.kind === 'default');
    if (
      loop?.kind !== 'while' ||
      loop.condition.kind !== 'binary' ||
      returned?.kind !== 'return' ||
      returned.expression?.kind !== 'conditional' ||
      returned.expression.whenFalse.kind !== 'binary' ||
      exported?.kind !== 'default'
    ) {
      throw new Error('Expected nested extra-argument fixtures');
    }
    const carriers = [
      loop.condition.left,
      returned.expression.whenTrue,
      returned.expression.whenFalse.right,
      exported.expression,
    ];

    carriers.forEach((carrier) => expectIrCallExpressionStatementValueCarrier(carrier));
    expect(module).toEqual(before);
    expect(output).toEqual(lowerIrModuleWithCompilerPasses(module, [createCompilerLoweringPassExtraArgumentErasure()]));
  });

  it('uses semantic carrier identities while removing only arguments beyond the implementation ABI', () => {
    const module = lower(`
      function effect(value: number): number { return value; }
      function choose(value: number): number { return value; }
      export function read(): number { return choose(effect(1), effect(2)); }
    `);
    const output = lowerIrModuleWithCompilerPasses(module, [createCompilerLoweringPassExtraArgumentErasure()]);
    const read = output.declarations.find(
      (declaration) => declaration.kind === 'function' && declaration.binding.name === 'read',
    );
    const wrapper = read?.kind === 'function' && read.body[0]?.kind === 'return' ? read.body[0].expression : undefined;
    if (wrapper?.kind !== 'call' || wrapper.callee.kind !== 'function') {
      throw new Error('Expected statement-value carrier');
    }
    const variables = wrapper.callee.body.slice(0, -1);
    const completion = wrapper.callee.body.at(-1);

    expect(variables).toMatchObject([
      { declarations: [{ binding: { name: 'callArgument0' }, initializer: { kind: 'call' } }], kind: 'variable' },
      { declarations: [{ binding: { name: 'callArgument1' }, initializer: { kind: 'call' } }], kind: 'variable' },
    ]);
    expect(completion).toMatchObject({
      expression: {
        arguments: [{ reference: { binding: { name: 'callArgument0' }, kind: 'binding' } }],
        kind: 'call',
        semantics: { signature: { parameterCount: 1, providedArgumentCount: 1 } },
      },
      kind: 'return',
    });
    const identities = variables.flatMap((statement) =>
      statement.kind === 'variable'
        ? statement.declarations.flatMap((variable) => ('binding' in variable ? [variable.binding.id] : []))
        : [],
    );
    expect(new Set(identities).size).toBe(2);
    expect(identities.every((identity) => identity.includes('call-argument'))).toBe(true);
  });

  it('refuses fixed extra calls without safe direct-call erasure evidence', () => {
    const module = lower(`
      export class Picker { choose(value: number): number { return value; } }
      export function read(picker: Picker): number { return picker.choose(1, 2); }
    `);

    expect(() => lowerIrModuleWithCompilerPasses(module, [createCompilerLoweringPassExtraArgumentErasure()])).toThrow(
      'fixed extra call arguments remain after erasure',
    );
  });
});

function expectIrCallExpressionStatementValueCarrier(expression: Readonly<IrExpression>): void {
  if (expression.kind !== 'call' || expression.callee.kind !== 'function') {
    throw new Error('Expected statement-value call');
  }
  expect(expression.arguments).toEqual([]);
  expect(expression.semantics).toEqual({
    statementValue: { asyncContext: 'inherit', completion: 'finalReturn', thisBinding: 'lexical' },
  });
  expect(expression.callee.body.slice(0, -1)).toHaveLength(2);
  expect(expression.callee.body.at(-1)?.kind).toBe('return');
}

function lower(source: string): IrModule {
  return lowerTypeScriptSource(
    ts.createSourceFile('/flight/packages/lowering/src/value.ts', source, ts.ScriptTarget.Latest, true),
    { packageName: '@flighthq/lowering', upstreamDirectory: '/flight' },
  ).module;
}
