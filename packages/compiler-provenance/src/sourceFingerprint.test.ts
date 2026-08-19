import ts from 'typescript';

import { fingerprintSourceText, fingerprintTypeScriptNode, normalizeTypeScriptNode } from './index.js';

describe('compiler provenance', () => {
  it('fingerprints raw text with an explicit SHA-256 identity', () => {
    expect(fingerprintSourceText('export const value = 1;')).toBe(
      'sha256:fcbcb7aece718d280178457c2c5a3bfb8e8743b8331374c29a50397f38d511e4',
    );
    expect(fingerprintSourceText('value')).not.toBe(fingerprintSourceText('value '));
  });

  it('normalizes formatting, comments, source paths, and line endings', () => {
    const compact = declaration('/first.ts', 'export const value={count:1};');
    const formatted = declaration(
      '/second.ts',
      '/** documentation */\r\n// source comment\r\nexport  const value = {\r\n  count: 1 // member comment\r\n};',
    );

    expect(normalizeTypeScriptNode(compact.node, compact.source)).toBe(
      normalizeTypeScriptNode(formatted.node, formatted.source),
    );
    expect(fingerprintTypeScriptNode(compact.node, compact.source)).toBe(
      fingerprintTypeScriptNode(formatted.node, formatted.source),
    );
    expect(normalizeTypeScriptNode(compact.node, compact.source)).toMatch(
      /^flight-typescript-node\/1;typescript=5\.9\.3:/u,
    );
    expect(normalizeTypeScriptNode(formatted.node, formatted.source)).not.toContain('comment');
  });

  it('preserves semantic whitespace inside literals and regular expressions', () => {
    const singleSpace = declaration('/single.ts', 'export const value = "a b";');
    const doubleSpace = declaration('/double.ts', 'export const value = "a  b";');
    const regexpSingle = declaration('/regexp-single.ts', 'export const value = /a b/;');
    const regexpDouble = declaration('/regexp-double.ts', 'export const value = /a  b/;');

    expect(normalizeTypeScriptNode(doubleSpace.node, doubleSpace.source)).toContain('a  b');
    expect(fingerprintTypeScriptNode(singleSpace.node, singleSpace.source)).not.toBe(
      fingerprintTypeScriptNode(doubleSpace.node, doubleSpace.source),
    );
    expect(fingerprintTypeScriptNode(regexpSingle.node, regexpSingle.source)).not.toBe(
      fingerprintTypeScriptNode(regexpDouble.node, regexpDouble.source),
    );
  });

  it('normalizes equivalent literal spelling and template line endings', () => {
    const singleQuoted = declaration('/single-quoted.ts', "export const value = 'same';");
    const doubleQuoted = declaration('/double-quoted.ts', 'export const value = "same";');
    const templateLf = declaration('/template-lf.ts', 'export const value = `one\ntwo`;');
    const templateCrLf = declaration('/template-crlf.ts', 'export const value = `one\r\ntwo`;');

    expect(fingerprintTypeScriptNode(singleQuoted.node, singleQuoted.source)).toBe(
      fingerprintTypeScriptNode(doubleQuoted.node, doubleQuoted.source),
    );
    expect(fingerprintTypeScriptNode(templateLf.node, templateLf.source)).toBe(
      fingerprintTypeScriptNode(templateCrLf.node, templateCrLf.source),
    );
  });
});

function declaration(fileName: string, contents: string): { node: ts.Statement; source: ts.SourceFile } {
  const source = ts.createSourceFile(fileName, contents, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const node = source.statements[0];
  if (!node) throw new Error('Expected a declaration fixture');
  return { node, source };
}
