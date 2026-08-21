import ts from 'typescript';

import { getTypeScriptForInKeyEvidence } from './compilerTypeScriptForInKeyEvidence.js';

describe('getTypeScriptForInKeyEvidence', () => {
  it('orders literal keys and distinguishes elided from preserved evaluation', () => {
    const { checker, source } = createProgram(
      'declare function mark(): number; for (const key in { second: 2, 10: 1, 2: 1, first: mark() }) key;',
    );
    const loop = source.statements[1];
    if (!loop || !ts.isForInStatement(loop)) throw new Error('Expected for-in statement');

    expect(getTypeScriptForInKeyEvidence(loop.expression, checker, source, getPropertyName)).toEqual({
      evaluation: 'preserve',
      keys: ['2', '10', 'second', 'first'],
      kind: 'objectLiteral',
    });
  });

  it('proves a const record closed across property reads but not mutation or escape', () => {
    const closed = createProgram(
      'const values = { first: 1 }; values.first; values["first"]; for (const key in values) key;',
    );
    const escaped = createProgram(
      'declare function consume(value: unknown): void; const values = { first: 1 }; consume(values); for (const key in values) key;',
    );
    const mutated = createProgram('const values = { first: 1 }; values.first = 2; for (const key in values) key;');
    const closedLoop = closed.source.statements[3];
    const escapedLoop = escaped.source.statements[3];
    const mutatedLoop = mutated.source.statements[2];
    if (
      !closedLoop ||
      !ts.isForInStatement(closedLoop) ||
      !escapedLoop ||
      !ts.isForInStatement(escapedLoop) ||
      !mutatedLoop ||
      !ts.isForInStatement(mutatedLoop)
    ) {
      throw new Error('Expected for-in statements');
    }

    expect(
      getTypeScriptForInKeyEvidence(closedLoop.expression, closed.checker, closed.source, getPropertyName),
    ).toEqual({
      evaluation: 'alreadyEvaluated',
      keys: ['first'],
      kind: 'closedRecord',
    });
    expect(
      getTypeScriptForInKeyEvidence(escapedLoop.expression, escaped.checker, escaped.source, getPropertyName),
    ).toBeUndefined();
    expect(
      getTypeScriptForInKeyEvidence(mutatedLoop.expression, mutated.checker, mutated.source, getPropertyName),
    ).toBeUndefined();
  });
});

function createProgram(text: string): Readonly<{ checker: ts.TypeChecker; source: ts.SourceFile }> {
  const fileName = '/source.ts';
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const host: ts.CompilerHost = {
    fileExists: (candidate) => candidate === fileName,
    getCanonicalFileName: (candidate) => candidate,
    getCurrentDirectory: () => '/',
    getDefaultLibFileName: () => '/lib.d.ts',
    getNewLine: () => '\n',
    getSourceFile: (candidate) => (candidate === fileName ? source : undefined),
    readFile: () => undefined,
    useCaseSensitiveFileNames: () => true,
    writeFile: () => undefined,
  };
  const program = ts.createProgram([fileName], { noLib: true, strict: true }, host);
  return { checker: program.getTypeChecker(), source };
}

function getPropertyName(name: ts.PropertyName): string {
  if (ts.isComputedPropertyName(name)) throw new Error('Computed property is not supported by this fixture');
  return name.text;
}
