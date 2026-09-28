import path from 'node:path';

import ts from 'typescript';

import { compareTextCodeUnits, normalizePathPortable } from '../../compiler-canonical-form/src/index.js';
import { fingerprintTypeScriptNode } from '../../compiler-provenance/src/index.js';
import type {
  CompilerModuleIdentity,
  CompilerSourcePortabilityAcceptedException,
  CompilerSourcePortabilityAnalysisOptions,
  CompilerSourcePortabilityExceptionRecord,
  CompilerSourcePortabilityFinding,
  CompilerSourcePortabilityReport,
  CompilerSourcePortabilityRule,
  TypeScriptPackageGraphSource,
} from '../../compiler-types/src/index.js';

interface SourcePortabilityCandidate {
  readonly message: string;
  readonly module: CompilerModuleIdentity;
  readonly node: ts.Node;
  readonly rule: CompilerSourcePortabilityRule;
  readonly sourceFile: ts.SourceFile;
  readonly subject: string;
}

type OpaqueTypeKind = 'any' | 'unknown';

export function analyzeTypeScriptSourcePortability(
  sources: readonly Readonly<TypeScriptPackageGraphSource>[],
  options: Readonly<CompilerSourcePortabilityAnalysisOptions> = {},
): CompilerSourcePortabilityReport {
  const candidates = sources
    .filter((source) => isTypeScriptSourcePortabilityInput(source.sourceFile))
    .flatMap(analyzeTypeScriptSourcePortabilityInput)
    .sort(compareSourcePortabilityCandidates);
  const identities = new Map<string, number>();
  const analyzed = candidates.map((candidate) => {
    const fingerprint = fingerprintTypeScriptNode(candidate.node, candidate.sourceFile);
    const identityBase = JSON.stringify([
      candidate.module.packageName,
      candidate.module.source,
      candidate.rule,
      candidate.subject,
      fingerprint,
    ]);
    const occurrence = identities.get(identityBase) ?? 0;
    identities.set(identityBase, occurrence + 1);
    const start = candidate.node.getStart(candidate.sourceFile);
    const location = candidate.sourceFile.getLineAndCharacterOfPosition(start);
    return {
      column: location.character + 1,
      fingerprint,
      identity: `flight-compiler-source-portability-finding/1:${identityBase}:${String(occurrence)}`,
      line: location.line + 1,
      message: candidate.message,
      module: candidate.module,
      rule: candidate.rule,
      subject: candidate.subject,
    } satisfies CompilerSourcePortabilityFinding;
  });
  const exceptionReasons = createSourcePortabilityExceptionReasons(analyzed, options);
  const acceptedExceptions: CompilerSourcePortabilityAcceptedException[] = [];
  const findings: CompilerSourcePortabilityFinding[] = [];
  for (const finding of analyzed) {
    const reason = exceptionReasons.get(finding.identity);
    if (reason === undefined) findings.push(finding);
    else acceptedExceptions.push({ finding, reason });
  }
  return { acceptedExceptions, findings, schema: 'flight-compiler-source-portability/1' };
}

function analyzeTypeScriptSourcePortabilityInput(
  input: Readonly<TypeScriptPackageGraphSource>,
): SourcePortabilityCandidate[] {
  const sourceFile = input.sourceFile;
  const module = createSourcePortabilityModuleIdentity(input);
  const candidates: SourcePortabilityCandidate[] = [];
  const add = (node: ts.Node, rule: CompilerSourcePortabilityRule, subject: string, message: string): void => {
    candidates.push({ message, module, node, rule, sourceFile, subject });
  };
  const visit = (node: ts.Node): void => {
    const assertionBridge = getUncheckedDoubleAssertionBridge(node);
    if (assertionBridge !== undefined && isTypeAssertion(node)) {
      const bridge = renderAssertionBridge(assertionBridge);
      const subject = getSourcePortabilitySubject(node);
      add(node, 'unchecked-double-assertion', subject, renderUncheckedDoubleAssertionMessage(node, subject, bridge));
    }
    if (ts.isPropertySignature(node) && node.type) {
      const subject = getSourcePortabilitySubject(node);
      const opaque = getOpaqueTypeKinds(node.type);
      if (opaque.size > 0) {
        add(node.type, 'opaque-value-domain', subject, renderOpaquePropertyValueDomainMessage(node, subject, opaque));
      }
      if (hasNullType(node.type) && (node.questionToken !== undefined || hasUndefinedType(node.type))) {
        add(
          node,
          'mixed-absence',
          subject,
          `${subject} combines an optional property with null; choose one absence representation or make all three states explicit.`,
        );
      }
    } else if (ts.isMethodSignature(node)) {
      const subject = getSourcePortabilitySubject(node);
      for (const [index, parameter] of node.parameters.entries()) {
        if (!parameter.type) continue;
        const opaque = getOpaqueTypeKinds(parameter.type);
        if (opaque.size === 0) continue;
        const parameterSubject = `${subject}.parameter:${getNodeName(parameter.name) ?? String(index + 1)}`;
        add(
          parameter.type,
          'opaque-value-domain',
          parameterSubject,
          renderOpaqueValueDomainMessage(parameterSubject, 'exposes', opaque),
        );
      }
      if (node.type) {
        const opaque = getOpaqueTypeKinds(node.type);
        if (opaque.size > 0) {
          const returnSubject = `${subject}.return`;
          add(
            node.type,
            'opaque-value-domain',
            returnSubject,
            renderOpaqueValueDomainMessage(returnSubject, 'exposes', opaque),
          );
        }
      }
    } else if (ts.isTypeAliasDeclaration(node) && !ts.isTypeLiteralNode(node.type)) {
      const opaque = getOpaqueTypeKinds(node.type);
      if (opaque.size > 0) {
        const subject = getSourcePortabilitySubject(node);
        add(node.type, 'opaque-value-domain', subject, renderOpaqueValueDomainMessage(subject, 'aliases', opaque));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return candidates;
}

function compareSourcePortabilityCandidates(
  left: Readonly<SourcePortabilityCandidate>,
  right: Readonly<SourcePortabilityCandidate>,
): number {
  return (
    compareTextCodeUnits(left.module.packageName, right.module.packageName) ||
    compareTextCodeUnits(left.module.source, right.module.source) ||
    compareTextCodeUnits(left.rule, right.rule) ||
    compareTextCodeUnits(left.subject, right.subject) ||
    left.node.getStart(left.sourceFile) - right.node.getStart(right.sourceFile) ||
    compareTextCodeUnits(left.message, right.message)
  );
}

function createSourcePortabilityModuleIdentity(input: Readonly<TypeScriptPackageGraphSource>): CompilerModuleIdentity {
  const relative = path.relative(path.resolve(input.upstreamDirectory), path.resolve(input.sourceFile.fileName));
  if (relative === '' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new TypeError(`Source is outside upstream checkout: ${input.sourceFile.fileName}`);
  }
  const source = normalizePathPortable(relative);
  const basename = path.posix.basename(source).replace(/\.tsx?$/u, '');
  return {
    name: basename === 'index' ? 'Index' : `${basename.slice(0, 1).toUpperCase()}${basename.slice(1)}`,
    packageName: input.packageName,
    source,
  };
}

function createSourcePortabilityExceptionReasons(
  findings: readonly Readonly<CompilerSourcePortabilityFinding>[],
  options: Readonly<CompilerSourcePortabilityAnalysisOptions>,
): ReadonlyMap<string, string> {
  const policy = options.exceptionPolicy;
  if (policy === undefined) return new Map();
  if (policy.schema !== 'flight-compiler-source-portability-exceptions/1') {
    throw new TypeError(`Unsupported source portability exception policy ${policy.schema}`);
  }
  const findingsByIdentity = new Map(findings.map((finding) => [finding.identity, finding] as const));
  const reasons = new Map<string, string>();
  for (const exception of [...policy.exceptions].sort(compareSourcePortabilityExceptions)) {
    const identity = exception.findingIdentity.normalize('NFC');
    const reason = exception.reason.normalize('NFC').trim();
    const finding = findingsByIdentity.get(identity);
    if (!finding) throw new TypeError(`Stale source portability exception ${identity}`);
    if (reason.length === 0) throw new TypeError(`Source portability exception ${identity} has no reason`);
    if (exception.rule !== finding.rule) {
      throw new TypeError(
        `Source portability exception ${identity} names ${exception.rule} but the finding uses ${finding.rule}`,
      );
    }
    const previous = reasons.get(identity);
    if (previous !== undefined) throw new TypeError(`Duplicate source portability exception ${identity}`);
    reasons.set(identity, reason);
  }
  return reasons;
}

function compareSourcePortabilityExceptions(
  left: Readonly<CompilerSourcePortabilityExceptionRecord>,
  right: Readonly<CompilerSourcePortabilityExceptionRecord>,
): number {
  return (
    compareTextCodeUnits(left.findingIdentity, right.findingIdentity) ||
    compareTextCodeUnits(left.rule, right.rule) ||
    compareTextCodeUnits(left.reason, right.reason)
  );
}

function getNodeName(node: ts.Node | undefined): string | undefined {
  if (!node) return undefined;
  if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) {
    return node.text;
  }
  return undefined;
}

function getOpaqueTypeKinds(node: ts.TypeNode): ReadonlySet<OpaqueTypeKind> {
  if (node.kind === ts.SyntaxKind.AnyKeyword) return new Set(['any']);
  if (node.kind === ts.SyntaxKind.UnknownKeyword) return new Set(['unknown']);
  if (ts.isParenthesizedTypeNode(node)) return getOpaqueTypeKinds(node.type);
  if (ts.isArrayTypeNode(node)) return getOpaqueTypeKinds(node.elementType);
  if (ts.isUnionTypeNode(node)) {
    return new Set(node.types.flatMap((type) => [...getOpaqueTypeKinds(type)]));
  }
  if (ts.isTypeReferenceNode(node)) {
    const reference = getNodeName(node.typeName);
    if (reference !== 'Record' && reference !== 'Readonly') return new Set();
    return new Set((node.typeArguments ?? []).flatMap((type) => [...getOpaqueTypeKinds(type)]));
  }
  return new Set();
}

function getSourcePortabilitySubject(node: ts.Node): string {
  const parts: string[] = [];
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (ts.isParameter(current)) {
      parts.push(`parameter:${getNodeName(current.name) ?? 'binding'}`);
    } else if (ts.isPropertySignature(current) || ts.isMethodSignature(current)) {
      parts.push(`${ts.isMethodSignature(current) ? 'method' : 'property'}:${getNodeName(current.name) ?? 'computed'}`);
    } else if (ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current)) {
      parts.push(`function:${getNodeName(current.name) ?? 'anonymous'}`);
    } else if (ts.isTypeLiteralNode(current)) {
      const discriminant = getTypeLiteralDiscriminant(current);
      if (discriminant !== undefined) parts.push(`arm:${discriminant}`);
    } else if (ts.isInterfaceDeclaration(current)) {
      parts.push(`interface:${current.name.text}`);
    } else if (ts.isTypeAliasDeclaration(current)) {
      parts.push(`type:${current.name.text}`);
    }
  }
  return parts.reverse().join('/') || 'module';
}

function getTypeLiteralDiscriminant(node: ts.TypeLiteralNode): string | undefined {
  for (const member of node.members) {
    if (!ts.isPropertySignature(member) || member.questionToken || !member.type || !ts.isLiteralTypeNode(member.type)) {
      continue;
    }
    const name = getNodeName(member.name);
    if (name === undefined) continue;
    const literal = member.type.literal;
    const value =
      ts.isStringLiteral(literal) || ts.isNumericLiteral(literal)
        ? literal.text
        : literal.kind === ts.SyntaxKind.TrueKeyword
          ? 'true'
          : literal.kind === ts.SyntaxKind.FalseKeyword
            ? 'false'
            : undefined;
    if (value !== undefined) return `${name}=${value}`;
  }
  return undefined;
}

function getTypeAssertionType(node: ts.AsExpression | ts.TypeAssertion): ts.TypeNode {
  return node.type;
}

function hasNullType(node: ts.TypeNode): boolean {
  if (ts.isLiteralTypeNode(node) && node.literal.kind === ts.SyntaxKind.NullKeyword) return true;
  if (ts.isParenthesizedTypeNode(node)) return hasNullType(node.type);
  return ts.isUnionTypeNode(node) && node.types.some(hasNullType);
}

function hasUndefinedType(node: ts.TypeNode): boolean {
  if (node.kind === ts.SyntaxKind.UndefinedKeyword) return true;
  if (ts.isParenthesizedTypeNode(node)) return hasUndefinedType(node.type);
  return ts.isUnionTypeNode(node) && node.types.some(hasUndefinedType);
}

function isTypeAssertion(node: ts.Node): node is ts.AsExpression | ts.TypeAssertion {
  return ts.isAsExpression(node) || ts.isTypeAssertionExpression(node);
}

function isTypeScriptIndexSignatureView(node: ts.TypeNode): boolean {
  if (ts.isParenthesizedTypeNode(node)) return isTypeScriptIndexSignatureView(node.type);
  if (ts.isTypeLiteralNode(node)) return node.members.some(ts.isIndexSignatureDeclaration);
  if (!ts.isTypeReferenceNode(node)) return false;
  const reference = getNodeName(node.typeName);
  if (reference === 'Record') return node.typeArguments?.length === 2;
  return reference === 'Readonly' && node.typeArguments?.length === 1
    ? isTypeScriptIndexSignatureView(node.typeArguments[0]!)
    : false;
}

function isTypeScriptMutableIndexSignatureView(node: ts.TypeNode): boolean {
  if (ts.isParenthesizedTypeNode(node)) return isTypeScriptMutableIndexSignatureView(node.type);
  if (ts.isTypeLiteralNode(node)) {
    return node.members.some(
      (member) =>
        ts.isIndexSignatureDeclaration(member) &&
        !member.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ReadonlyKeyword),
    );
  }
  if (!ts.isTypeReferenceNode(node)) return false;
  const reference = getNodeName(node.typeName);
  if (reference === 'Record') return node.typeArguments?.length === 2;
  return false;
}

function isTypeScriptSourcePortabilityInput(sourceFile: ts.SourceFile): boolean {
  if (sourceFile.isDeclarationFile) return false;
  const portable = normalizePathPortable(sourceFile.fileName);
  if (/\.(?:test|spec|generated|gen)\.tsx?$/u.test(portable)) return false;
  if (/(?:^|\/)(?:__tests__|tests?|__generated__|generated)(?:\/|$)/u.test(portable)) return false;
  return !/^\s*(?:\/\/|\/\*)\s*@generated\b/u.test(sourceFile.text);
}

function getUncheckedDoubleAssertionBridge(node: ts.Node): ts.TypeNode | undefined {
  if (!isTypeAssertion(node)) return undefined;
  let inner: ts.Expression = node.expression;
  while (ts.isParenthesizedExpression(inner)) inner = inner.expression;
  if (!isTypeAssertion(inner)) return undefined;
  const bridge = getTypeAssertionType(inner);
  return bridge.kind === ts.SyntaxKind.AnyKeyword ||
    bridge.kind === ts.SyntaxKind.NeverKeyword ||
    bridge.kind === ts.SyntaxKind.UnknownKeyword
    ? bridge
    : undefined;
}

function renderAssertionBridge(node: ts.TypeNode): 'any' | 'never' | 'unknown' {
  if (node.kind === ts.SyntaxKind.AnyKeyword) return 'any';
  if (node.kind === ts.SyntaxKind.NeverKeyword) return 'never';
  return 'unknown';
}

function renderOpaqueValueDomainMessage(
  subject: string,
  relationship: 'aliases' | 'exposes',
  kinds: ReadonlySet<OpaqueTypeKind>,
): string {
  return `${subject} ${relationship} ${renderOpaqueTypeKinds(kinds)}; no exact runtime value domain can be recovered from that annotation or its downstream uses. Replace it with a named closed value type shared by the boundary, its storage, and its consumers; when intentional erasure is the contract, record a reviewed source-portability exception instead.`;
}

function renderOpaqueTypeKinds(kinds: ReadonlySet<OpaqueTypeKind>): string {
  return [...kinds].sort(compareTextCodeUnits).join(' or ');
}

function renderOpaquePropertyValueDomainMessage(
  node: ts.PropertySignature,
  subject: string,
  kinds: ReadonlySet<OpaqueTypeKind>,
): string {
  if (getNodeName(node.name) !== 'error' || kinds.size !== 1 || !kinds.has('unknown')) {
    return renderOpaqueValueDomainMessage(subject, 'exposes', kinds);
  }
  const presence = node.questionToken ? 'an optional error payload' : 'an error payload';
  return `${subject} exposes unknown as ${presence}; JavaScript permits throwing values of any type, so neither the annotation nor its downstream uses prove one portable runtime representation. Normalize every producer at the catch or provider boundary into a named closed error payload shared by the result arms, storage, and consumers, using fields with explicit portable value types. If preserving arbitrary thrown values is intentional, record a reviewed source-portability exception for that boundary. The compiler will not infer Error, stringify the value, or choose a target-specific Any carrier.`;
}

function renderUncheckedDoubleAssertionMessage(
  node: ts.AsExpression | ts.TypeAssertion,
  subject: string,
  bridge: 'any' | 'never' | 'unknown',
): string {
  if (isTypeScriptMutableIndexSignatureView(getTypeAssertionType(node))) {
    return `${subject} uses a double assertion through ${bridge} to claim mutable index-signature storage; the bridge neither proves nor creates writable dynamic cells on the source owner. For an intentionally open key or extension domain, declare a mutable string index signature on the base/output type and construct every value in that carrier; a registry of keys or roles does not recover cells on an owner that lacks them. If the keys are closed, replace the dynamic writes with a finite union of declared members. A reviewed exception can record the source contract but cannot supply that storage; copying or materializing a Record, or adding side storage, would change object identity.`;
  }
  if (isTypeScriptIndexSignatureView(getTypeAssertionType(node))) {
    return `${subject} uses a double assertion through ${bridge} to claim an index-signature view; the bridge neither checks that the source has indexed storage nor preserves an exact runtime carrier for computed access. Accept a declared Record or index-signature type at this boundary, or replace the dynamic key with checked access over a closed key/value domain; an assertion cannot create that storage.`;
  }
  return `${subject} uses a double assertion through ${bridge}; replace it with a checked conversion or a narrower source type.`;
}
