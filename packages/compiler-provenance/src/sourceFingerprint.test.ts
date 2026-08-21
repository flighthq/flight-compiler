import ts from 'typescript';

import {
  fingerprintSourceText,
  fingerprintTypeScriptNode,
  isCompilerSourceFingerprint,
  normalizeTypeScriptNode,
} from './sourceFingerprint.js';

describe('fingerprintSourceText', () => {
  it('uses an explicit deterministic SHA-256 identity for empty, ASCII, and Unicode text', () => {
    expect(fingerprintSourceText('export const value = 1;')).toBe(
      'sha256:fcbcb7aece718d280178457c2c5a3bfb8e8743b8331374c29a50397f38d511e4',
    );
    expect(fingerprintSourceText('')).toBe('sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(fingerprintSourceText('café')).toBe(fingerprintSourceText('café'));
    expect(fingerprintSourceText('café')).not.toBe(fingerprintSourceText('cafe'));
  });

  it('preserves raw text distinctions', () => {
    expect(fingerprintSourceText('value')).not.toBe(fingerprintSourceText('value '));
    expect(fingerprintSourceText('one\ntwo')).not.toBe(fingerprintSourceText('one\r\ntwo'));
  });
});

describe('fingerprintTypeScriptNode', () => {
  it('pins the canonical named-kind schema to an exact SHA-256 identity', () => {
    const fixture = declaration('/value.ts', 'export const value = 1;');

    expect(fingerprintTypeScriptNode(fixture.node, fixture.source)).toBe(
      'sha256:612dffd48e306ba30331f6176171a9001ef4371cc5b649617b778ba28eea3934',
    );
  });

  it('shares fingerprints for structurally equivalent nodes independent of source path and formatting', () => {
    const compact = declaration('/first.ts', 'export const value={count:1};');
    const formatted = declaration(
      '/second.ts',
      '/** documentation */\r\n// source comment\r\nexport  const value = {\r\n  count: 1 // member comment\r\n};',
    );

    expect(fingerprintTypeScriptNode(compact.node, compact.source)).toBe(
      fingerprintTypeScriptNode(formatted.node, formatted.source),
    );
  });

  it('separates meaningfully distinct near-neighbor nodes', () => {
    const singleSpace = declaration('/single.ts', 'export const value = "a b";');
    const doubleSpace = declaration('/double.ts', 'export const value = "a  b";');
    const regexpSingle = declaration('/regexp-single.ts', 'export const value = /a b/;');
    const regexpDouble = declaration('/regexp-double.ts', 'export const value = /a  b/;');

    expect(fingerprintTypeScriptNode(singleSpace.node, singleSpace.source)).not.toBe(
      fingerprintTypeScriptNode(doubleSpace.node, doubleSpace.source),
    );
    expect(fingerprintTypeScriptNode(regexpSingle.node, regexpSingle.source)).not.toBe(
      fingerprintTypeScriptNode(regexpDouble.node, regexpDouble.source),
    );
  });
});

describe('isCompilerSourceFingerprint', () => {
  it('accepts exact lowercase SHA-256 identities and rejects malformed or differently encoded values', () => {
    const valid = fingerprintSourceText('');

    expect(isCompilerSourceFingerprint(valid)).toBe(true);
    expect(isCompilerSourceFingerprint(`sha256:${'0'.repeat(64)}`)).toBe(true);
    expect(isCompilerSourceFingerprint(undefined)).toBe(false);
    expect(isCompilerSourceFingerprint('')).toBe(false);
    expect(isCompilerSourceFingerprint('sha256:')).toBe(false);
    expect(isCompilerSourceFingerprint(`sha256:${'0'.repeat(63)}`)).toBe(false);
    expect(isCompilerSourceFingerprint(`sha256:${'0'.repeat(65)}`)).toBe(false);
    expect(isCompilerSourceFingerprint(`sha256:${'A'.repeat(64)}`)).toBe(false);
    expect(isCompilerSourceFingerprint(`sha256:${'g'.repeat(64)}`)).toBe(false);
    expect(isCompilerSourceFingerprint(`sha512:${'0'.repeat(64)}`)).toBe(false);
  });
});

describe('normalizeTypeScriptNode', () => {
  it('declares a canonical named-kind schema independent of TypeScript patch identity, comments, and paths', () => {
    const compact = declaration('/first.ts', 'export const value={count:1};');
    const formatted = declaration(
      '/second.ts',
      '/** documentation */\r\n// source comment\r\nexport  const value = {\r\n  count: 1 // member comment\r\n};',
    );
    const normalized = normalizeTypeScriptNode(compact.node, compact.source);

    expect(normalized).toBe(normalizeTypeScriptNode(formatted.node, formatted.source));
    expect(normalized).toMatch(/^flight-typescript-node\/2;VariableStatement\[/u);
    expect(normalized).toContain('Identifier:5:value');
    expect(normalized).not.toContain('FirstStatement');
    expect(normalized).not.toContain('typescript=');
    expect(normalized).not.toContain('/first.ts');
    expect(normalizeTypeScriptNode(formatted.node, formatted.source)).not.toContain('comment');
  });

  it('normalizes equivalent literal spelling and template line endings', () => {
    const singleQuoted = declaration('/single-quoted.ts', "export const value = 'same';");
    const doubleQuoted = declaration('/double-quoted.ts', 'export const value = "same";');
    const templateLf = declaration('/template-lf.ts', 'export const value = `one\ntwo`;');
    const templateCrLf = declaration('/template-crlf.ts', 'export const value = `one\r\ntwo`;');

    expect(normalizeTypeScriptNode(singleQuoted.node, singleQuoted.source)).toBe(
      normalizeTypeScriptNode(doubleQuoted.node, doubleQuoted.source),
    );
    expect(normalizeTypeScriptNode(templateLf.node, templateLf.source)).toBe(
      normalizeTypeScriptNode(templateCrLf.node, templateCrLf.source),
    );
  });

  it('canonicalizes TypeScript compatibility aliases and refuses unknown syntax kinds', () => {
    const source = ts.createSourceFile(
      '/attribute.ts',
      'import value from "./value.json" with { type: "json" };',
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const imported = source.statements[0];
    if (!imported) throw new Error('Expected import declaration fixture');
    const normalized = normalizeTypeScriptNode(imported, source);
    const unknownNode = { kind: -1 } as unknown as ts.Node;

    expect(normalized).toContain('ImportAttributes[');
    expect(normalized).not.toContain('AssertClause');
    expect(() => normalizeTypeScriptNode(unknownNode, source)).toThrow('syntax kind -1 has no canonical name');
  });

  it('preserves semantic whitespace inside literals and regular expressions', () => {
    const literal = declaration('/literal.ts', 'export const value = "a  b";');
    const regexp = declaration('/regexp.ts', 'export const value = /a  b/;');

    expect(normalizeTypeScriptNode(literal.node, literal.source)).toContain('a  b');
    expect(normalizeTypeScriptNode(regexp.node, regexp.source)).toContain('a  b');
  });

  it('falls back to source text when a leaf exposes a non-string text property', () => {
    const fixture = declaration('/value.ts', 'export const value = 1;');
    if (!ts.isVariableStatement(fixture.node)) throw new Error('Expected a variable statement fixture');
    const name = fixture.node.declarationList.declarations[0]?.name;
    if (!name || !ts.isIdentifier(name)) throw new Error('Expected an identifier fixture');
    Object.defineProperty(name, 'text', { value: 42 });

    const normalized = normalizeTypeScriptNode(fixture.node, fixture.source);

    expect(normalized).toContain('Identifier:5:value');
    expect(normalized).not.toContain('Identifier:undefined:42');
  });
});

function declaration(fileName: string, contents: string): { node: ts.Statement; source: ts.SourceFile } {
  const source = ts.createSourceFile(fileName, contents, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const node = source.statements[0];
  if (!node) throw new Error('Expected a declaration fixture');
  return { node, source };
}
