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
  it('reads a closed key set out of a written shape, and refuses shapes that are not closed', () => {
    // A value whose type lists its properties has a known key set even when the value is a parameter
    // rather than a literal. An index signature, an optional property, or a heritage clause each mean
    // a key the declaration does not list.
    expect(
      planFor(
        'interface Shape { first: number; second: number } declare const values: Shape; for (const key in values) key;',
      ),
    ).toEqual({
      evaluation: 'alreadyEvaluated',
      keys: ['first', 'second'],
      kind: 'closedRecord',
    });
    expect(planFor('declare const values: { only: number }; for (const key in values) key;')).toEqual({
      evaluation: 'alreadyEvaluated',
      keys: ['only'],
      kind: 'closedRecord',
    });
    expect(
      planFor('interface Open { [key: string]: number } declare const values: Open; for (const key in values) key;'),
    ).toBeUndefined();
    expect(
      planFor('interface Partial { first?: number } declare const values: Partial; for (const key in values) key;'),
    ).toBeUndefined();
    expect(
      planFor(
        'interface Base { first: number } interface Derived extends Base { second: number } declare const values: Derived; for (const key in values) key;',
      ),
    ).toBeUndefined();
  });

  it('returns undefined when an object literal contains a computed property name', () => {
    expect(planFor('for (const key in { ["computed"]: 1 }) key;')).toBeUndefined();
  });

  it('unwraps parenthesized expressions in the declared-shape path', () => {
    expect(planFor('declare const values: { only: number }; for (const key in (values)) key;')).toEqual({
      evaluation: 'alreadyEvaluated',
      keys: ['only'],
      kind: 'closedRecord',
    });
  });

  it('enters and exits the closed-record parenthesized unwrap without proving closure', () => {
    expect(planFor('const values = { first: 1 }; for (const key in (values)) key;')).toBeUndefined();
  });

  it('refuses a non-identifier expression in both the closed-record and declared-shape paths', () => {
    expect(
      planFor('declare const obj: { values: { key: number } }; for (const key in obj.values) key;'),
    ).toBeUndefined();
  });

  it('refuses when the symbol declaration is neither a parameter nor a variable', () => {
    expect(planFor('function values() {} for (const key in values) key;')).toBeUndefined();
  });

  it('reads keys from a parameter with a closed type annotation', () => {
    const { checker, source } = createProgram(
      'function iterate(values: { first: number; second: number }) { for (const key in values) key; }',
    );
    const fn = source.statements[0];
    if (!fn || !ts.isFunctionDeclaration(fn)) throw new Error('Expected function declaration');
    const loop = fn.body?.statements[0];
    if (!loop || !ts.isForInStatement(loop)) throw new Error('Expected for-in statement');
    expect(getTypeScriptForInKeyEvidence(loop.expression, checker, source, getPropertyName)).toEqual({
      evaluation: 'alreadyEvaluated',
      keys: ['first', 'second'],
      kind: 'closedRecord',
    });
  });

  it('refuses an empty interface and a generic type reference for the declared-shape path', () => {
    expect(planFor('interface Empty {} declare const values: Empty; for (const key in values) key;')).toBeUndefined();
    expect(
      planFor('interface Box<T> { value: T } declare const values: Box<number>; for (const key in values) key;'),
    ).toBeUndefined();
  });

  it('resolves a type alias to its underlying shape members', () => {
    expect(
      planFor(
        'type Shape = { first: number; second: number }; declare const values: Shape; for (const key in values) key;',
      ),
    ).toEqual({
      evaluation: 'alreadyEvaluated',
      keys: ['first', 'second'],
      kind: 'closedRecord',
    });
  });

  it('refuses a type reference that resolves to neither an interface nor a type alias', () => {
    expect(
      planFor('class Values { first = 1 } declare const values: Values; for (const key in values) key;'),
    ).toBeUndefined();
  });

  it('refuses a closed record whose initializer is not an object literal or has computed keys', () => {
    expect(
      planFor(
        'declare function makeRecord(): { key: number }; const values = makeRecord(); for (const key in values) key;',
      ),
    ).toBeUndefined();
  });

  it('detects delete, increment, decrement, and method-call mutations as escapes on a const record', () => {
    expect(planFor('const values = { first: 1 }; delete values.first; for (const key in values) key;')).toBeUndefined();
    expect(planFor('const values = { count: 1 }; values.count++; for (const key in values) key;')).toBeUndefined();
    expect(planFor('const values = { count: 1 }; --values.count; for (const key in values) key;')).toBeUndefined();
    expect(
      planFor('const values = { method: function() { return 1; } }; values.method(); for (const key in values) key;'),
    ).toBeUndefined();
  });

  it('refuses a generic type alias in the declared-shape path', () => {
    expect(
      planFor('type Box<T> = { value: T }; declare const values: Box<number>; for (const key in values) key;'),
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

function planFor(text: string) {
  const { checker, source } = createProgram(text);
  const loop = source.statements.at(-1);
  if (!loop || !ts.isForInStatement(loop)) throw new Error('Expected the fixture to end in a for-in statement');
  return getTypeScriptForInKeyEvidence(loop.expression, checker, source, getPropertyName);
}

function getPropertyName(name: ts.PropertyName): string {
  if (ts.isComputedPropertyName(name)) throw new Error('Computed property is not supported by this fixture');
  return name.text;
}
