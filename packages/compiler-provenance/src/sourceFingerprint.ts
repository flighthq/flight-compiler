import { createHash } from 'node:crypto';

import ts from 'typescript';

import { compareTextCodeUnits } from '../../compiler-canonical-form/src/index.js';
import type { CompilerSourceFingerprint } from '../../compiler-types/src/index.js';

const typeScriptNodeFingerprints = new WeakMap<ts.Node, CompilerSourceFingerprint>();
let typeScriptSyntaxKindNames: ReadonlyMap<ts.SyntaxKind, string> | undefined;

export function fingerprintSourceText(value: string): CompilerSourceFingerprint {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

export function fingerprintTypeScriptNode(node: ts.Node, sourceFile: ts.SourceFile): CompilerSourceFingerprint {
  const cached = typeScriptNodeFingerprints.get(node);
  if (cached) return cached;
  const fingerprint = fingerprintSourceText(normalizeTypeScriptNode(node, sourceFile));
  typeScriptNodeFingerprints.set(node, fingerprint);
  return fingerprint;
}

export function isCompilerSourceFingerprint(value: unknown): value is CompilerSourceFingerprint {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/u.test(value);
}

export function normalizeTypeScriptNode(node: ts.Node, sourceFile: ts.SourceFile): string {
  return `flight-typescript-node/2;${serializeTypeScriptNode(node, sourceFile, getTypeScriptSyntaxKindNames())}`;
}

function getTypeScriptSyntaxKindNames(): ReadonlyMap<ts.SyntaxKind, string> {
  typeScriptSyntaxKindNames ??= createTypeScriptSyntaxKindNames();
  return typeScriptSyntaxKindNames;
}

function createTypeScriptSyntaxKindNames(): ReadonlyMap<ts.SyntaxKind, string> {
  const names = new Map<ts.SyntaxKind, string>();
  for (const [name, value] of Object.entries(ts.SyntaxKind)) {
    if (typeof value !== 'number' || /^(?:Count|First|Last)/u.test(name)) continue;
    const canonicalName = normalizeTypeScriptSyntaxKindName(name);
    const existing = names.get(value);
    if (existing === undefined || compareTextCodeUnits(canonicalName, existing) < 0) names.set(value, canonicalName);
  }
  return names;
}

function normalizeTypeScriptSyntaxKindName(name: string): string {
  switch (name) {
    case 'AssertClause':
      return 'ImportAttributes';
    case 'AssertEntry':
      return 'ImportAttribute';
    case 'JSDoc':
      return 'JSDocComment';
    default:
      return name;
  }
}

function serializeTypeScriptNode(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  syntaxKindNames: ReadonlyMap<ts.SyntaxKind, string>,
): string {
  const kindName = syntaxKindNames.get(node.kind);
  if (!kindName) throw new Error(`TypeScript syntax kind ${String(node.kind)} has no canonical name`);
  const children = node.getChildren(sourceFile).filter((child) => child.kind !== ts.SyntaxKind.JSDocComment);
  if (children.length === 0) {
    const text = 'text' in node && typeof node.text === 'string' ? node.text : node.getText(sourceFile);
    return `${kindName}:${String(text.length)}:${text}`;
  }
  return `${kindName}[${children
    .map((child) => serializeTypeScriptNode(child, sourceFile, syntaxKindNames))
    .join(',')}]`;
}
