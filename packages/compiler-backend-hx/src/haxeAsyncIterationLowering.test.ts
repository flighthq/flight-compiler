import ts from 'typescript';

import { analyzeIrModuleTraversal } from '../../compiler-ir-traversal/src/index.js';
import { lowerTypeScriptSource } from '../../compiler-semantic/src/index.js';
import { createCompilerLoweringPassAsyncIterationHaxe } from './haxeAsyncIterationLowering.js';

describe('createCompilerLoweringPassAsyncIterationHaxe', () => {
  it('lowers a serial await loop to the runtime callback protocol idempotently', () => {
    const sourceFile = ts.createSourceFile(
      '/flight/packages/core/src/visit.ts',
      'export async function visit(items: AsyncIterable<number>): Promise<void> { for await (const value of items) { await Promise.resolve(value); } }',
      ts.ScriptTarget.Latest,
      true,
    );
    const result = lowerTypeScriptSource(sourceFile, {
      packageName: '@flighthq/core',
      upstreamDirectory: '/flight',
    });
    const snapshot = structuredClone(result.module);
    const pass = createCompilerLoweringPassAsyncIterationHaxe();
    const lowered = pass.lowerIrModule(result.module);
    let runtimeCalls = 0;
    let residualAwaitLoops = 0;
    analyzeIrModuleTraversal(lowered, {
      expression(expression) {
        if (
          expression.kind === 'call' &&
          expression.callee.kind === 'property' &&
          expression.callee.name === 'forEachAsync'
        ) {
          runtimeCalls += 1;
        }
      },
      statement(statement) {
        if (statement.kind === 'forOf' && statement.await) residualAwaitLoops += 1;
      },
    });

    expect(result.diagnostics).toEqual([]);
    expect(runtimeCalls).toBe(1);
    expect(residualAwaitLoops).toBe(0);
    expect(pass.verifyIrModule(lowered)).toEqual({ kind: 'valid' });
    expect(pass.lowerIrModule(lowered)).toEqual(lowered);
    expect(result.module).toEqual(snapshot);
  });
});
