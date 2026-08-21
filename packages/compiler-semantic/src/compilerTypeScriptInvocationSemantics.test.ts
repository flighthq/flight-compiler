import ts from 'typescript';

import { getTypeScriptInvocationSignatureResolution } from './compilerTypeScriptInvocationSemantics.js';

describe('getTypeScriptInvocationSignatureResolution', () => {
  it('returns the resolved declaration for an implementation call', () => {
    const { checker, invocation, source } = createInvocationProgram(
      'function choose(value: number): number { return value; } choose(1);',
    );
    const declaration = source.statements[0];
    if (!declaration || !ts.isFunctionDeclaration(declaration)) throw new Error('Expected function declaration');

    expect(getTypeScriptInvocationSignatureResolution(invocation, checker)).toEqual({
      implementation: declaration,
      resolved: declaration,
    });
  });

  it('pairs a resolved function overload with its implementation and stable overload index', () => {
    const { checker, invocation, source } = createInvocationProgram(
      [
        'function choose(value: string): string;',
        'function choose(value: number): number;',
        'function choose(value: string | number): string | number { return value; }',
        'choose(1);',
      ].join('\n'),
    );
    const resolved = source.statements[1];
    const implementation = source.statements[2];
    if (
      !resolved ||
      !ts.isFunctionDeclaration(resolved) ||
      !implementation ||
      !ts.isFunctionDeclaration(implementation)
    ) {
      throw new Error('Expected overload declarations');
    }

    expect(getTypeScriptInvocationSignatureResolution(invocation, checker)).toEqual({
      implementation,
      overloadIndex: 1,
      resolved,
    });
  });

  it('pairs a resolved constructor overload with its implementation', () => {
    const { checker, invocation, source } = createInvocationProgram(
      [
        'class Value {',
        '  constructor(value: string);',
        '  constructor(value: number);',
        '  constructor(value: string | number) {}',
        '}',
        'new Value(1);',
      ].join('\n'),
    );
    const declaration = source.statements[0];
    if (!declaration || !ts.isClassDeclaration(declaration)) throw new Error('Expected class declaration');
    const resolved = declaration.members[1];
    const implementation = declaration.members[2];
    if (
      !resolved ||
      !ts.isConstructorDeclaration(resolved) ||
      !implementation ||
      !ts.isConstructorDeclaration(implementation)
    ) {
      throw new Error('Expected constructor overload declarations');
    }

    expect(getTypeScriptInvocationSignatureResolution(invocation, checker)).toEqual({
      implementation,
      overloadIndex: 1,
      resolved,
    });
  });

  it('pairs a resolved class method overload with its implementation', () => {
    const { checker, invocation, source } = createInvocationProgram(
      [
        'class Value {',
        '  choose(value: string): string;',
        '  choose(value: number): number;',
        '  choose(value: string | number): string | number { return value; }',
        '}',
        'new Value().choose(1);',
      ].join('\n'),
    );
    const declaration = source.statements[0];
    if (!declaration || !ts.isClassDeclaration(declaration)) throw new Error('Expected class declaration');
    const resolved = declaration.members[1];
    const implementation = declaration.members[2];
    if (!resolved || !ts.isMethodDeclaration(resolved) || !implementation || !ts.isMethodDeclaration(implementation)) {
      throw new Error('Expected method overload declarations');
    }

    expect(getTypeScriptInvocationSignatureResolution(invocation, checker)).toEqual({
      implementation,
      overloadIndex: 1,
      resolved,
    });
  });

  it('retains an interface method overload when no implementation exists', () => {
    const { checker, invocation, source } = createInvocationProgram(
      [
        'interface Value {',
        '  choose(value: string): string;',
        '  choose(value: number): number;',
        '}',
        'declare const value: Value;',
        'value.choose(1);',
      ].join('\n'),
    );
    const declaration = source.statements[0];
    if (!declaration || !ts.isInterfaceDeclaration(declaration)) throw new Error('Expected interface declaration');
    const resolved = declaration.members[1];
    if (!resolved || !ts.isMethodSignature(resolved)) throw new Error('Expected interface method overload');

    expect(getTypeScriptInvocationSignatureResolution(invocation, checker)).toEqual({
      implementation: resolved,
      resolved,
    });
  });

  it('retains a declaration-only overload when no implementation exists', () => {
    const { checker, invocation, source } = createInvocationProgram(
      'declare function choose(value: number): number; choose(1);',
    );
    const declaration = source.statements[0];
    if (!declaration || !ts.isFunctionDeclaration(declaration)) throw new Error('Expected function declaration');

    expect(getTypeScriptInvocationSignatureResolution(invocation, checker)).toEqual({
      implementation: declaration,
      resolved: declaration,
    });
  });

  it('returns undefined when the checker cannot resolve an invocation', () => {
    const { checker, invocation } = createInvocationProgram('missing(1);');

    expect(getTypeScriptInvocationSignatureResolution(invocation, checker)).toBeUndefined();
  });
});

function createInvocationProgram(
  text: string,
): Readonly<{ checker: ts.TypeChecker; invocation: ts.CallExpression | ts.NewExpression; source: ts.SourceFile }> {
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
  const statement = source.statements.at(-1);
  if (!statement || !ts.isExpressionStatement(statement)) throw new Error('Expected invocation statement');
  const invocation = statement.expression;
  if (!ts.isCallExpression(invocation) && !ts.isNewExpression(invocation)) {
    throw new Error('Expected call or new expression');
  }
  return { checker: program.getTypeChecker(), invocation, source };
}
