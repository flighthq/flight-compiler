import ts from 'typescript';

import {
  createTypeScriptSyntacticAliasSubstitutions,
  createTypeScriptSyntacticDeclarationSubstitutions,
  getTypeScriptSyntacticExpressionTypeEvidence,
  getTypeScriptSyntacticTypeSubstitution,
} from './compilerTypeScriptSyntacticTypeEvidence.js';

describe('getTypeScriptSyntacticExpressionTypeEvidence', () => {
  it('unwraps syntax-only wrappers and preserves written declaration evidence', () => {
    const { checker, source } = createProgram(
      'type Values = readonly number[]; const values: Values = [1]; (values satisfies Values)!;',
    );
    const statement = source.statements[2];
    if (!statement || !ts.isExpressionStatement(statement)) throw new Error('Expected expression statement');

    const evidence = getTypeScriptSyntacticExpressionTypeEvidence(statement.expression, checker);

    expect(evidence?.getText(source)).toBe('Values');
  });

  it('does not invent evidence for an unannotated literal', () => {
    const { checker, source } = createProgram('const values = [1]; values;');
    const statement = source.statements[1];
    if (!statement || !ts.isExpressionStatement(statement)) throw new Error('Expected expression statement');

    expect(getTypeScriptSyntacticExpressionTypeEvidence(statement.expression, checker)).toBeUndefined();
  });
});

it('reads the awaited type out of a written Promise type argument', () => {
  // The analysis checker has no library types, so `Promise<number>` never resolves and the checker
  // calls the awaited value unknown. The type argument is written in the source, which is evidence.
  const { checker, source } = createProgram('declare const task: Promise<number>; await task;');
  const statement = source.statements[1];
  if (!statement || !ts.isExpressionStatement(statement)) throw new Error('Expected expression statement');

  expect(getTypeScriptSyntacticExpressionTypeEvidence(statement.expression, checker)?.getText(source)).toBe('number');
});

it('follows an inferred const to its initializer, and stops at a self-referential one', () => {
  const { checker, source } = createProgram('declare const task: Promise<string>; const value = await task; value;');
  const statement = source.statements[2];
  if (!statement || !ts.isExpressionStatement(statement)) throw new Error('Expected expression statement');

  expect(getTypeScriptSyntacticExpressionTypeEvidence(statement.expression, checker)?.getText(source)).toBe('string');

  const cyclic = createProgram('const loop = loop; loop;');
  const cyclicStatement = cyclic.source.statements[1];
  if (!cyclicStatement || !ts.isExpressionStatement(cyclicStatement)) throw new Error('Expected statement');

  expect(getTypeScriptSyntacticExpressionTypeEvidence(cyclicStatement.expression, cyclic.checker)).toBeUndefined();
});

it('claims nothing for an await of something that is not a written task type', () => {
  const { checker, source } = createProgram('declare const value: number; await value;');
  const statement = source.statements[1];
  if (!statement || !ts.isExpressionStatement(statement)) throw new Error('Expected expression statement');

  expect(getTypeScriptSyntacticExpressionTypeEvidence(statement.expression, checker)).toBeUndefined();
});

describe('createTypeScriptSyntacticAliasSubstitutions', () => {
  it('binds written arguments and trailing defaults by symbol identity', () => {
    const { checker, source } = createProgram(
      'type Pair<Left, Right = string> = [Left, Right]; type Value = Pair<number>;',
    );
    const declaration = source.statements[0];
    const use = source.statements[1];
    if (
      !declaration ||
      !ts.isTypeAliasDeclaration(declaration) ||
      !use ||
      !ts.isTypeAliasDeclaration(use) ||
      !ts.isTypeReferenceNode(use.type)
    ) {
      throw new Error('Expected alias declarations');
    }

    const substitutions = createTypeScriptSyntacticAliasSubstitutions(use.type, declaration, checker, new Map());

    expect([...substitutions!.values()].map((type) => type.getText(source))).toEqual(['number', 'string']);
  });

  it('refuses a reference whose arity exceeds the alias declaration', () => {
    const { checker, source } = createProgram('type Box<Value> = Value; type Invalid = Box<number, string>;');
    const declaration = source.statements[0];
    const use = source.statements[1];
    if (
      !declaration ||
      !ts.isTypeAliasDeclaration(declaration) ||
      !use ||
      !ts.isTypeAliasDeclaration(use) ||
      !ts.isTypeReferenceNode(use.type)
    ) {
      throw new Error('Expected alias declarations');
    }

    expect(createTypeScriptSyntacticAliasSubstitutions(use.type, declaration, checker, new Map())).toBeUndefined();
  });
});

describe('createTypeScriptSyntacticDeclarationSubstitutions', () => {
  it('binds generic interface arguments without consulting flow types', () => {
    const { checker, source } = createProgram('interface Box<Value> { value: Value } type Result = Box<number>;');
    const declaration = source.statements[0];
    const use = source.statements[1];
    if (
      !declaration ||
      !ts.isInterfaceDeclaration(declaration) ||
      !use ||
      !ts.isTypeAliasDeclaration(use) ||
      !ts.isTypeReferenceNode(use.type)
    ) {
      throw new Error('Expected interface and alias');
    }

    const substitutions = createTypeScriptSyntacticDeclarationSubstitutions(use.type, declaration, checker, new Map());

    expect([...substitutions!.values()].map((type) => type.getText(source))).toEqual(['number']);
  });
});

describe('getTypeScriptSyntacticTypeSubstitution', () => {
  it('resolves only a bare type-parameter reference', () => {
    const { checker, source } = createProgram('type Box<Value> = [Value, Box<Value>];');
    const declaration = source.statements[0];
    if (!declaration || !ts.isTypeAliasDeclaration(declaration) || !ts.isTupleTypeNode(declaration.type)) {
      throw new Error('Expected tuple alias');
    }
    const parameter = declaration.typeParameters?.[0];
    const bare = declaration.type.elements[0];
    const applied = declaration.type.elements[1];
    const symbol = parameter && checker.getSymbolAtLocation(parameter.name);
    if (!parameter || !symbol || !bare || !applied) throw new Error('Expected alias parts');
    const replacement = ts.factory.createKeywordTypeNode(ts.SyntaxKind.NumberKeyword);
    const substitutions = new Map([[symbol, replacement]]);

    expect(getTypeScriptSyntacticTypeSubstitution(bare, checker, substitutions)).toBe(replacement);
    expect(getTypeScriptSyntacticTypeSubstitution(applied, checker, substitutions)).toBe(applied);
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
