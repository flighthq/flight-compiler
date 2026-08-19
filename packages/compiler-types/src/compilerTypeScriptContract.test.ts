import ts from 'typescript';

import type { RuntimeExportDecision, TypeScriptProject } from './compilerTypeScriptContract.js';

describe('compiler TypeScript contracts', () => {
  it('preserve compiler API identities without wrapping the TypeScript program model', () => {
    const source = ts.createSourceFile('/value.ts', 'export const value = 1;', ts.ScriptTarget.Latest, true);
    const host = ts.createCompilerHost({});
    host.getSourceFile = (fileName) => (fileName === source.fileName ? source : undefined);
    host.fileExists = (fileName) => fileName === source.fileName;
    host.readFile = (fileName) => (fileName === source.fileName ? source.text : undefined);
    const program = ts.createProgram([source.fileName], { noLib: true }, host);
    const project: TypeScriptProject = {
      checker: program.getTypeChecker(),
      options: program.getCompilerOptions(),
      program,
    };
    const statement = source.statements[0];
    if (!statement || !ts.isVariableStatement(statement)) throw new Error('Expected variable statement fixture');
    const declaration = statement.declarationList.declarations[0];
    if (!declaration) throw new Error('Expected variable declaration fixture');
    const decision: RuntimeExportDecision = { declaration, runtime: true };

    expect(project.program).toBe(program);
    expect(project.checker).toBe(program.getTypeChecker());
    expect(decision).toMatchObject({ runtime: true });
  });
});
