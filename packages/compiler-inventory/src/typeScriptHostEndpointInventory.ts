import path from 'node:path';

import ts from 'typescript';

import { compareTextCodeUnits, normalizePathPortable } from '../../compiler-canonical-form/src/index.js';
import type {
  AnalyzeTypeScriptHostEndpointsOptions,
  CompilerHostEndpointInventory,
  CompilerHostEndpointOperation,
  CompilerHostEndpointRecord,
  CompilerSourceLocation,
  FlightPackageManifest,
} from '../../compiler-types/src/index.js';
import { createCompilerInventoryFailure } from './compilerInventoryFailure.js';

interface HostEndpointUse {
  endpoint: string;
  operation: CompilerHostEndpointOperation;
  receiver: string;
  site: CompilerSourceLocation;
}

interface TypeScriptHostEndpointAccess {
  access: ts.ElementAccessExpression | ts.PropertyAccessExpression;
  endpoint: string;
  name: ts.Node;
}

export function analyzeTypeScriptHostEndpoints(
  options: Readonly<AnalyzeTypeScriptHostEndpointsOptions>,
): CompilerHostEndpointInventory {
  const upstreamDirectory = path.resolve(options.upstreamDirectory);
  const manifests = [...options.manifests].sort((left, right) => compareTextCodeUnits(left.name, right.name));
  const uses: HostEndpointUse[] = [];
  for (const sourceFile of options.project.program.getSourceFiles()) {
    const manifest = getSourceFileManifest(sourceFile, manifests, upstreamDirectory);
    if (!manifest || !isProductionTypeScriptSource(sourceFile.fileName)) continue;
    visitTypeScriptNode(sourceFile, (node) => {
      const endpoint = getTypeScriptHostEndpointAccess(node);
      if (!endpoint) return;
      const receiverNode = endpoint.access.expression;
      const receiver = options.resolveReceiver(
        options.project.checker.getTypeAtLocation(receiverNode),
        options.project.checker,
      );
      if (receiver === undefined) return;
      const position = sourceFile.getLineAndCharacterOfPosition(endpoint.name.getStart(sourceFile));
      const source = getPortableRelativePath(sourceFile.fileName, upstreamDirectory);
      if (receiver.trim() === '') {
        throw createCompilerInventoryFailure(
          'invalid-host-endpoint-receiver',
          `${source}:${String(position.line + 1)}:${String(position.character + 1)}`,
          `Host endpoint receiver identity is empty for ${source}`,
        );
      }
      uses.push({
        endpoint: endpoint.endpoint,
        operation: getTypeScriptHostEndpointOperation(endpoint.access),
        receiver,
        site: {
          column: position.character + 1,
          line: position.line + 1,
          packageName: manifest.name,
          source,
        },
      });
    });
  }

  const endpoints = groupHostEndpointUses(uses);
  return {
    endpoints,
    schema: 'flight-compiler-host-endpoints/1',
    summary: {
      endpoints: endpoints.length,
      uses: endpoints.reduce((total, endpoint) => total + endpoint.sites.length, 0),
    },
  };
}

function compareHostEndpointRecords(
  left: Readonly<CompilerHostEndpointRecord>,
  right: Readonly<CompilerHostEndpointRecord>,
): number {
  return (
    compareTextCodeUnits(left.receiver, right.receiver) ||
    compareTextCodeUnits(left.endpoint, right.endpoint) ||
    compareTextCodeUnits(left.operation, right.operation)
  );
}

function compareSourceLocations(
  left: Readonly<CompilerSourceLocation>,
  right: Readonly<CompilerSourceLocation>,
): number {
  return (
    compareTextCodeUnits(left.packageName, right.packageName) ||
    compareTextCodeUnits(left.source, right.source) ||
    left.line - right.line ||
    left.column - right.column
  );
}

function getPortableRelativePath(file: string, upstreamDirectory: string): string {
  return normalizePathPortable(path.relative(upstreamDirectory, path.resolve(file)));
}

function getSourceFileManifest(
  sourceFile: Readonly<ts.SourceFile>,
  manifests: readonly Readonly<FlightPackageManifest>[],
  upstreamDirectory: string,
): Readonly<FlightPackageManifest> | undefined {
  const sourcePath = path.resolve(sourceFile.fileName);
  return manifests.find((manifest) => {
    const packageDirectory = path.resolve(upstreamDirectory, manifest.directory);
    const relative = path.relative(packageDirectory, sourcePath);
    return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  });
}

function getTypeScriptHostEndpointAccess(node: ts.Node): TypeScriptHostEndpointAccess | undefined {
  if (ts.isPropertyAccessExpression(node)) {
    return { access: node, endpoint: node.name.text, name: node.name };
  }
  if (
    ts.isElementAccessExpression(node) &&
    node.argumentExpression &&
    (ts.isStringLiteral(node.argumentExpression) || ts.isNoSubstitutionTemplateLiteral(node.argumentExpression))
  ) {
    return { access: node, endpoint: node.argumentExpression.text, name: node.argumentExpression };
  }
  return undefined;
}

function getTypeScriptHostEndpointOperation(
  node: ts.ElementAccessExpression | ts.PropertyAccessExpression,
): CompilerHostEndpointOperation {
  const { expression, parent } = getTypeScriptAccessContainer(node);
  if (ts.isCallExpression(parent) && parent.expression === expression) return 'call';
  if (ts.isNewExpression(parent) && parent.expression === expression) return 'construct';
  if (ts.isDeleteExpression(parent) && parent.expression === expression) return 'write';
  if (
    (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) &&
    (parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken)
  ) {
    return 'readWrite';
  }
  if (
    ts.isBinaryExpression(parent) &&
    parent.left === expression &&
    isTypeScriptAssignmentOperator(parent.operatorToken.kind)
  ) {
    return parent.operatorToken.kind === ts.SyntaxKind.EqualsToken ? 'write' : 'readWrite';
  }
  return 'read';
}

function getTypeScriptAccessContainer(node: ts.Expression): { expression: ts.Expression; parent: ts.Node } {
  let current: ts.Expression = node;
  while (
    current.parent &&
    (ts.isParenthesizedExpression(current.parent) ||
      ts.isAsExpression(current.parent) ||
      ts.isNonNullExpression(current.parent) ||
      ts.isSatisfiesExpression(current.parent) ||
      ts.isTypeAssertionExpression(current.parent))
  ) {
    current = current.parent;
  }
  return { expression: current, parent: current.parent };
}

function groupHostEndpointUses(uses: readonly Readonly<HostEndpointUse>[]): CompilerHostEndpointRecord[] {
  const records = new Map<
    string,
    { record: Omit<CompilerHostEndpointRecord, 'sites'>; sites: CompilerSourceLocation[] }
  >();
  for (const use of uses) {
    const identity = JSON.stringify([use.receiver, use.endpoint, use.operation]);
    const existing = records.get(identity) ?? {
      record: { endpoint: use.endpoint, operation: use.operation, receiver: use.receiver },
      sites: [],
    };
    existing.sites.push(use.site);
    records.set(identity, existing);
  }
  return [...records.values()]
    .map(({ record, sites }) => ({ ...record, sites: sites.sort(compareSourceLocations) }))
    .sort(compareHostEndpointRecords);
}

function isProductionTypeScriptSource(file: string): boolean {
  return /\.tsx?$/u.test(file) && !/\.(?:test|spec)\.tsx?$/u.test(file) && !file.endsWith('.d.ts');
}

function isTypeScriptAssignmentOperator(kind: ts.SyntaxKind): kind is ts.AssignmentOperator {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
}

function visitTypeScriptNode(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  node.forEachChild((child) => visitTypeScriptNode(child, visit));
}
