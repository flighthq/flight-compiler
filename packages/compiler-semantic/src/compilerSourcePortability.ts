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
          renderOpaqueMethodValueDomainMessage(node, parameter.type, parameterSubject, opaque),
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
            renderOpaqueMethodValueDomainMessage(node, node.type, returnSubject, opaque),
          );
        }
      }
    } else if (ts.isTypeAliasDeclaration(node) && !ts.isTypeLiteralNode(node.type)) {
      const opaque = getOpaqueTypeKinds(node.type);
      if (opaque.size > 0) {
        const subject = getSourcePortabilitySubject(node);
        add(node.type, 'opaque-value-domain', subject, renderOpaqueTypeAliasValueDomainMessage(node, subject, opaque));
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

function getUncheckedDoubleAssertionObjectLiteralTarget(node: ts.AsExpression | ts.TypeAssertion): string | undefined {
  const target = getTypeAssertionType(node);
  if (!ts.isTypeReferenceNode(target)) return undefined;
  const targetName = getNodeName(target.typeName);
  if (targetName === undefined) return undefined;
  let inner: ts.Expression = node.expression;
  while (ts.isParenthesizedExpression(inner)) inner = inner.expression;
  if (!isTypeAssertion(inner)) return undefined;
  let source: ts.Expression = inner.expression;
  while (ts.isParenthesizedExpression(source)) source = source.expression;
  return ts.isObjectLiteralExpression(source) ? targetName : undefined;
}

function getSwfNodeDoubleAssertionGuidance(
  node: ts.AsExpression | ts.TypeAssertion,
  subject: string,
  bridge: 'any' | 'never' | 'unknown',
): string | undefined {
  const source = normalizePathPortable(node.getSourceFile().fileName);
  if (!source.endsWith('/packages/swf/src/swfNode.ts') && !source.endsWith('/packages/swf/src/swfDocument.ts')) {
    return undefined;
  }
  const target = getTypeAssertionType(node);
  if (!ts.isTypeReferenceNode(target)) return undefined;
  const targetName = getNodeName(target.typeName);
  const fields =
    targetName === 'SwfMorphBoundsData'
      ? 'authoredBounds, morphEndBounds, and morphStartBounds'
      : targetName === 'SwfAuthoredBoundsData' || targetName === 'SwfShapeNodeData'
        ? 'authoredBounds'
        : undefined;
  if (fields === undefined) return undefined;
  let inner: ts.Expression = node.expression;
  while (ts.isParenthesizedExpression(inner)) inner = inner.expression;
  if (!isTypeAssertion(inner)) return undefined;
  let retainedExpression: ts.Expression = inner.expression;
  while (ts.isParenthesizedExpression(retainedExpression)) retainedExpression = retainedExpression.expression;
  const retainedSlot = retainedExpression.getText(node.getSourceFile());
  const retainedOwner =
    targetName === 'SwfMorphBoundsData' || (targetName === 'SwfAuthoredBoundsData' && retainedSlot === 'shape.data')
      ? 'MorphShapeData'
      : targetName === 'SwfShapeNodeData'
        ? 'ShapeData'
        : 'Node2DData';
  return `${subject} uses a double assertion through ${bridge} to add ${fields} to the already-constructed ${retainedSlot} owner declared as ${retainedOwner}, then treat it as ${targetName}; erasing the type spelling does not create those cells or prove that the retained owner ever had them. Declare ${fields} on the exact portable data type retained by ${retainedSlot}, make the creator construct that concrete owner before a base-typed slot stores it, and keep that type through every accessor that mutates or reads the fields. If this open-object mutation is intentionally JavaScript-only, a reviewed source-portability exception can document that boundary but cannot supply storage on another target. The compiler will not reinterpret the owner, copy or materialize replacement data, or add side storage.`;
}

function getPhysics3DWorldDoubleAssertionGuidance(
  node: ts.AsExpression | ts.TypeAssertion,
  subject: string,
  bridge: 'any' | 'never' | 'unknown',
): string | undefined {
  const source = normalizePathPortable(node.getSourceFile().fileName);
  if (!source.endsWith('/packages/physics3d/src/world.ts')) return undefined;
  const target = getTypeAssertionType(node);
  const targetName = ts.isTypeReferenceNode(target) ? getNodeName(target.typeName) : undefined;
  const legacyView =
    targetName === 'SerializedPhysics3DWorld'
      ? {
          difference:
            'it changes required index and jointEvents cells into optional storage and asks solver for the removed constraintByPair cell',
          owner: 'Physics3DWorld',
          view: targetName,
        }
      : targetName === 'SerializedPhysics3DSolverConfig'
        ? {
            difference: 'it changes the required maxCcdRotationSubsteps number into optional storage',
            owner: 'Physics3DSolverConfig',
            view: targetName,
          }
        : targetName === 'SerializedPhysics3DBody'
          ? {
              difference: 'it changes the required colliders array into optional storage',
              owner: 'RigidBody3D',
              view: targetName,
            }
          : targetName === 'SerializedPhysics3DContact'
            ? {
                difference: 'it changes the required colliderA and colliderB numbers into optional storage',
                owner: 'Physics3DContact',
                view: targetName,
              }
            : isPhysics3DSerializedVersionProbe(target)
              ? {
                  difference: 'it changes the required numeric version cell into optional unknown storage',
                  owner: 'Physics3DWorld',
                  view: '{ version?: unknown }',
                }
              : undefined;
  if (legacyView === undefined) return undefined;
  let inner: ts.Expression = node.expression;
  while (ts.isParenthesizedExpression(inner)) inner = inner.expression;
  if (!isTypeAssertion(inner)) return undefined;
  let retainedExpression: ts.Expression = inner.expression;
  while (ts.isParenthesizedExpression(retainedExpression)) retainedExpression = retainedExpression.expression;
  const retainedSlot = retainedExpression.getText(node.getSourceFile());
  return `${subject} uses a double assertion through ${bridge} to reinterpret the already-constructed ${retainedSlot} owner declared as ${legacyView.owner} as the legacy ${legacyView.view} view; that view is not representation-equivalent to the retained carrier because ${legacyView.difference}. Keep reconstructed input in a named versioned serialized DTO at the format boundary, validate and default its optional fields before admitting it to ${legacyView.owner}, and construct and retain the current ${legacyView.owner} with its declared layout. If in-place JavaScript migration must preserve the raw object's identity, declare one stable serialized storage owner with those optional cells from construction and keep that exact type throughout migration, then record a reviewed source-portability exception for the JavaScript-only boundary. The compiler will preserve an already proven representation-equivalent owner, but will not reinterpret this carrier, cast it, copy or materialize a replacement, or add side storage.`;
}

function isPhysics3DSerializedVersionProbe(node: ts.TypeNode): boolean {
  if (!ts.isTypeLiteralNode(node) || node.members.length !== 1) return false;
  const member = node.members[0];
  return Boolean(
    member &&
    ts.isPropertySignature(member) &&
    getNodeName(member.name) === 'version' &&
    member.questionToken !== undefined &&
    member.type?.kind === ts.SyntaxKind.UnknownKeyword,
  );
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

function renderOpaqueTypeAliasValueDomainMessage(
  node: ts.TypeAliasDeclaration,
  subject: string,
  kinds: ReadonlySet<OpaqueTypeKind>,
): string {
  const residualFlightType = getResidualFlightTypeAliasOpaqueValueGuidance(node, subject, kinds);
  if (residualFlightType) return residualFlightType;
  const logData = getFlightLogOpaqueValueGuidance(node, subject, kinds);
  if (logData) return logData;
  const pixiInput = getPixiParseOpaqueValueGuidance(node, subject, kinds);
  return pixiInput ?? renderOpaqueValueDomainMessage(subject, 'aliases', kinds);
}

function renderOpaqueMethodValueDomainMessage(
  node: ts.MethodSignature,
  type: ts.TypeNode,
  subject: string,
  kinds: ReadonlySet<OpaqueTypeKind>,
): string {
  const appLoopHandle = getHostAppLoopOpaqueHandleGuidance(node, type, subject, kinds);
  if (appLoopHandle) return appLoopHandle;
  const videoStream = getHostVideoOpaqueStreamGuidance(node, type, subject, kinds);
  return videoStream ?? renderOpaqueValueDomainMessage(subject, 'exposes', kinds);
}

function renderOpaquePropertyValueDomainMessage(
  node: ts.PropertySignature,
  subject: string,
  kinds: ReadonlySet<OpaqueTypeKind>,
): string {
  const animationValue = getAnimationOpaqueValueGuidance(node, subject, kinds);
  if (animationValue) return animationValue;
  const flightContract = getFlightTypesOpaquePropertyGuidance(node, subject, kinds);
  if (flightContract) return flightContract;
  const spineDrawOrder = getSpineDrawOrderOpaqueValueGuidance(node, subject, kinds);
  if (spineDrawOrder) return spineDrawOrder;
  const pixiInput = getPixiParseOpaqueValueGuidance(node, subject, kinds);
  if (pixiInput) return pixiInput;
  const textureAtlasDetection = getTextureAtlasDetectionOpaqueValueGuidance(node, subject, kinds);
  if (textureAtlasDetection) return textureAtlasDetection;
  const lottiePayload = getLottieOpaquePayloadGuidance(node, subject, kinds);
  if (lottiePayload) return lottiePayload;
  const trayWrapperError = getTrayWrapperOpaqueErrorGuidance(node, subject, kinds);
  if (trayWrapperError) return trayWrapperError;
  const trayError = getTrayOpaqueErrorGuidance(node, subject, kinds);
  if (trayError) return trayError;
  if (getNodeName(node.name) !== 'error' || kinds.size !== 1 || !kinds.has('unknown')) {
    return renderOpaqueValueDomainMessage(subject, 'exposes', kinds);
  }
  const presence = node.questionToken ? 'an optional error payload' : 'an error payload';
  return `${subject} exposes unknown as ${presence}; JavaScript permits throwing values of any type, so neither the annotation nor its downstream uses prove one portable runtime representation. Normalize every producer at the catch or provider boundary into a named closed error payload shared by the result arms, storage, and consumers, using fields with explicit portable value types. If preserving arbitrary thrown values is intentional, record a reviewed source-portability exception for that boundary. The compiler will not infer Error, stringify the value, or choose a target-specific Any carrier.`;
}

function getTrayWrapperOpaqueErrorGuidance(
  node: ts.PropertySignature,
  subject: string,
  kinds: ReadonlySet<OpaqueTypeKind>,
): string | undefined {
  if (
    !hasOnlyUnknown(kinds) ||
    getNodeName(node.name) !== 'error' ||
    node.questionToken === undefined ||
    node.type?.kind !== ts.SyntaxKind.UnknownKeyword ||
    !normalizePathPortable(node.getSourceFile().fileName).endsWith('/packages/tray/src/tray.ts')
  ) {
    return undefined;
  }
  const flow = getTrayWrapperOpaqueErrorFlow(node, subject);
  if (flow === undefined) return undefined;
  return `${subject} preserves an optional unknown error while constructing the public Tray creation result; ${flow} The value crosses createTrayIcon unchanged, is not inspected or serialized, and is not retained in TrayRuntime, so it remains genuinely provider-opaque rather than a recoverable portable domain. If portable consumers need machine-readable failure data, normalize at the catch or host-provider boundary into one named closed TrayErrorPayload shared by TrayCreateCapabilityResult, TrayCreateResult, these construction helpers, and consumers. If arbitrary caught or provider-supplied data is intentionally returned only as an unexamined diagnostic, record a reviewed source-portability exception for this exact property. The compiler will not infer Error, stringify the value, choose a target-specific Any carrier, insert a cast, or copy or materialize the payload.`;
}

function getTrayWrapperOpaqueErrorFlow(node: ts.PropertySignature, subject: string): string | undefined {
  if (!ts.isTypeLiteralNode(node.parent)) return undefined;
  const outcome = node.parent.members.find(
    (member): member is ts.PropertySignature =>
      ts.isPropertySignature(member) && getNodeName(member.name) === 'outcome' && member.questionToken === undefined,
  )?.type;
  switch (subject) {
    case 'function:createTrayIcon/arm:outcome=tray-create-failed/property:error':
      if (!isStringLiteralType(outcome, 'tray-create-failed')) return undefined;
      return 'createTrayIcon catches an arbitrary rejection, passes that same value to initializeTrayCreateFailedResult, and immediately returns the finished result.';
    case 'function:initializeTrayCreateFailedResult/parameter:out/arm:outcome=tray-create-failed/property:error':
      if (!isStringLiteralType(outcome, 'tray-create-failed')) return undefined;
      return 'initializeTrayCreateFailedResult assigns the catch argument directly to the tray-create-failed result and has no other production or consumption path.';
    case 'function:initializeTrayCreateProviderFailureResult/parameter:out/property:error':
      if (outcome?.kind !== ts.SyntaxKind.StringKeyword) return undefined;
      return 'createTrayIcon reads the optional error from a non-created host capability result, passes it to initializeTrayCreateProviderFailureResult, and returns the finished wrapper without narrowing.';
    default:
      return undefined;
  }
}

function isStringLiteralType(node: ts.TypeNode | undefined, value: string): boolean {
  return (
    node !== undefined && ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal) && node.literal.text === value
  );
}

function getAnimationOpaqueValueGuidance(
  node: ts.PropertySignature,
  subject: string,
  kinds: ReadonlySet<OpaqueTypeKind>,
): string | undefined {
  if (!hasOnlyUnknown(kinds) || node.questionToken !== undefined || node.type?.kind !== ts.SyntaxKind.UnknownKeyword) {
    return undefined;
  }
  if (isFlightTypesSource(node, 'AnimationChannel.ts') && subject === 'interface:AnimationChannel/property:targetRef') {
    return `${subject} is the animation core's domain-owned target reference. Channel construction and cloning retain the same reference; crossfade and layer composition use identity equality only, and sampling passes the channel unchanged to scene, skeleton, tween, or vendor binders that own validation and interpretation. The core neither serializes nor dereferences the target, so this is a genuinely domain-opaque extensibility contract. Record a reviewed source-portability exception for this exact property only while those invariants hold and every interpreting binder owns its narrowing. If targets must enter portable persistence or cross-domain transport, normalize them at createAnimationChannel into one named closed tagged AnimationTargetRef domain shared by producers and binders. The compiler will not infer a union from downstream casts or registry entries, choose a target-specific Any carrier, insert a cast, or copy or materialize the target reference.`;
  }
  if (
    isFlightTypesSource(node, 'AnimationClipEvent.ts') &&
    subject === 'interface:AnimationClipEvent/property:payload'
  ) {
    return `${subject} is an application-owned clip-marker payload. createAnimationClipEvent stores the supplied value unchanged, cloneAnimationClip carries the same payload reference into the cloned marker, and AnimationPlayer emits the whole event unchanged; the animation core reads only name and time. The payload is retained by the clip but remains genuinely domain-opaque and is never serialized or interpreted by the core. Record a reviewed source-portability exception for this exact property while payload meaning stays exclusively with event producers and listeners. If clips or marker payloads enter portable persistence or shared interpretation, normalize at createAnimationClipEvent into a named closed AnimationClipEventPayload domain or name-discriminated event arms. The compiler will not infer a schema from event names or listeners, choose a target-specific Any carrier, insert a cast, or copy or materialize the payload.`;
  }
  return undefined;
}

function getResidualFlightTypeAliasOpaqueValueGuidance(
  node: ts.TypeAliasDeclaration,
  subject: string,
  kinds: ReadonlySet<OpaqueTypeKind>,
): string | undefined {
  if (!hasOnlyUnknown(kinds)) return undefined;
  if (
    isFlightTypesSource(node, 'AppWindow.ts') &&
    subject === 'type:NativeWindowHandle' &&
    node.type.kind === ts.SyntaxKind.UnknownKeyword
  ) {
    return `${subject} is a host-owned native window identity. attachWindow forwards it directly to the selected provider; the web, Electron, and Tauri providers validate their own required surface before retaining the native object only in provider-private maps, while AppWindow stores no handle. This is a genuinely provider-opaque identity boundary. Record a reviewed source-portability exception for this exact alias while provider validation dominates every use and the handle never enters portable results, serialization, or application state. If portable code needs window identity, expose a separate named closed attachment key through a provider adapter and keep the native owner private. The compiler will not infer one representation from DOM, Electron, Tauri, or integer providers, choose a target-specific Any carrier, insert a cast, or copy or materialize the native window.`;
  }
  if (
    isFlightTypesSource(node, 'Surface.ts') &&
    subject === 'type:NativeSurfaceHandle' &&
    node.type.kind === ts.SyntaxKind.UnknownKeyword
  ) {
    return `${subject} is the drawable identity owned by the allocating host. Surface construction retains it for the surface lifetime only in package-private SurfaceRuntime; portable layers pass the Surface entity, while web and rendering providers retrieve and narrow the handle to their own canvas, element, or native drawable type. This retained value is nevertheless genuinely provider-opaque, not portable surface data. Record a reviewed source-portability exception for this exact alias while only the allocating provider reads it and no handle enters public results or serialization. If portable code needs drawable identity, expose a separate named closed surface key through a provider adapter and keep the native owner private. The compiler will not infer one representation from DOM, SDL, EGL, WebGPU, or integer providers, choose a target-specific Any carrier, insert a cast, or copy or materialize the drawable.`;
  }
  if (
    isFlightTypesSource(node, 'Net.ts') &&
    subject === 'type:NetResponseBody' &&
    isNetResponseBodyOpaqueUnion(node.type)
  ) {
    return `${subject} includes unknown for the JSON response arm, but that arm crosses the public NetResponse boundary and is returned to callers alongside text, ArrayBuffer, Blob, and null; it is not a provider token or an unexamined diagnostic. Both web decoder paths produce it from JSON.parse or Response.json, and native providers share the same contract. Declare a recursive named closed NetJsonValue domain for JSON primitives, arrays, and string-keyed objects, include it in NetResponseBody, and validate or normalize every host JSON decoder before NetResponse construction. The compiler will not treat unknown as only JSON, infer the responseType correlation, choose a target-specific Any carrier, insert a cast, or copy or materialize the response body.`;
  }
  return undefined;
}

function getHostVideoOpaqueStreamGuidance(
  node: ts.MethodSignature,
  type: ts.TypeNode,
  subject: string,
  kinds: ReadonlySet<OpaqueTypeKind>,
): string | undefined {
  if (
    !hasOnlyUnknown(kinds) ||
    type.kind !== ts.SyntaxKind.UnknownKeyword ||
    !isFlightTypesSource(node, 'HostVideo.ts') ||
    subject !== 'interface:HostVideoCapability/method:attachStream.parameter:stream' ||
    node.questionToken === undefined ||
    node.parameters.length !== 1 ||
    !isHostImageSourceOrNull(node.type)
  ) {
    return undefined;
  }
  return `${subject} is the browser provider's live media-stream input. createWebVideoResourceFromMediaStream is the only production caller and passes a MediaStream directly; the web provider immediately installs it as the video element's srcObject and returns the HostImageSource, so portable VideoResource state retains the element rather than the stream. This is a genuinely provider-opaque input boundary. Record a reviewed source-portability exception for this exact parameter while attachment remains provider-local and the stream is never serialized or stored in portable state. If cross-host stream attachment becomes a portable feature, introduce a named closed HostVideoStreamHandle entity through provider adapters and keep each native stream private. The compiler will not assume MediaStream for every host, choose a target-specific Any carrier, insert a cast, or copy or materialize the live stream.`;
}

function isHostImageSourceOrNull(node: ts.TypeNode | undefined): boolean {
  if (!node || !ts.isUnionTypeNode(node) || node.types.length !== 2) return false;
  return (
    node.types.some((type) => isNamedTypeReference(type, 'HostImageSource')) &&
    node.types.some((type) => hasNullType(type))
  );
}

function isNamedTypeReference(node: ts.TypeNode, name: string): boolean {
  return ts.isTypeReferenceNode(node) && getNodeName(node.typeName) === name && (node.typeArguments?.length ?? 0) === 0;
}

function isNetResponseBodyOpaqueUnion(node: ts.TypeNode): boolean {
  if (!ts.isUnionTypeNode(node) || node.types.length !== 5) return false;
  return (
    node.types.some((type) => type.kind === ts.SyntaxKind.StringKeyword) &&
    node.types.some((type) => type.kind === ts.SyntaxKind.UnknownKeyword) &&
    node.types.some((type) => isNamedTypeReference(type, 'ArrayBuffer')) &&
    node.types.some((type) => isNamedTypeReference(type, 'Blob')) &&
    node.types.some((type) => hasNullType(type))
  );
}

function getFlightLogOpaqueValueGuidance(
  node: ts.TypeAliasDeclaration,
  subject: string,
  kinds: ReadonlySet<OpaqueTypeKind>,
): string | undefined {
  if (
    subject !== 'type:LogData' ||
    !hasOnlyUnknown(kinds) ||
    !isFlightTypesSource(node, 'Log.ts') ||
    !isStringOrReadonlyUnknownRecord(node.type)
  ) {
    return undefined;
  }
  return `${subject} gives structured log records an open unknown value domain. Log producers pass those records through span and context merging into memory or buffered sinks, registered kind serializers and redaction, and JSON or text formatters; the values therefore cross capture and transport boundaries rather than remaining unexamined tokens. Normalize each producer before LogEntry construction to one named closed LogFieldValue domain shared by LogData, context and span fields, serializers, and sinks. A reviewed source-portability exception for this exact alias is justified only for a deliberately JavaScript-only diagnostic boundary whose values never enter portable storage or transport. The compiler will not infer a schema from logger call sites, stringify arbitrary fields, choose a target-specific Any carrier, insert a cast, or copy or materialize the record.`;
}

function getFlightTypesOpaquePropertyGuidance(
  node: ts.PropertySignature,
  subject: string,
  kinds: ReadonlySet<OpaqueTypeKind>,
): string | undefined {
  if (!hasOnlyUnknown(kinds)) return undefined;
  if (isFlightTypesSource(node, 'Log.ts') && isReadonlyUnknownRecord(node.type) && node.questionToken === undefined) {
    const owner =
      subject === 'interface:LogContext/property:fields'
        ? 'context'
        : subject === 'interface:LogSpan/property:fields'
          ? 'span'
          : undefined;
    if (owner === undefined) return undefined;
    return `${subject} gives the bound log ${owner} an open unknown field-value domain. The log package merges these fields into LogData before LogEntry emission, after which memory and buffered sinks may retain them and serializers, redaction, and formatters may inspect or serialize them. Normalize fields at createLog${owner === 'context' ? 'Context/createChildLogContext' : 'Span'} before they enter the ${owner}, using the same named closed LogFieldValue domain as LogData and every sink. A reviewed source-portability exception for this exact property is justified only for a deliberately JavaScript-only diagnostic boundary whose values never enter portable storage or transport. The compiler will not infer values from field names, stringify arbitrary fields, choose a target-specific Any carrier, insert a cast, or copy or materialize the record.`;
  }
  if (
    isFlightTypesSource(node, 'Command.ts') &&
    node.questionToken === undefined &&
    node.type?.kind === ts.SyntaxKind.UnknownKeyword &&
    (subject === 'interface:CommandPropertyEntry/property:after' ||
      subject === 'interface:CommandPropertyEntry/property:before')
  ) {
    const field = subject.endsWith(':after') ? 'after' : 'before';
    const source =
      field === 'after'
        ? 'createSetNodePropertyCommand and its batch variant capture the caller-supplied value'
        : 'the command constructors read the current node property';
    return `${subject} is a heterogeneous command-property slot: ${source}, merge preserves it, and the matching binding writes it back on ${field === 'after' ? 'execute or redo' : 'undo'} without inspecting or coercing it. Relative to generic history this value is genuinely opaque, not an inferred portable value domain. If portable command histories support a bounded property set, normalize both captures at the command-constructor boundary into one named closed CommandPropertyValue domain shared by entry storage and the node reader/writer. If arbitrary property values are intentionally transported only back to their originating node property, record a reviewed source-portability exception for this exact property. The compiler will not infer a property-indexed union, choose a target-specific Any carrier, insert a cast, or copy or materialize the value.`;
  }
  if (
    isFlightTypesSource(node, 'Notification.ts') &&
    node.questionToken !== undefined &&
    node.type?.kind === ts.SyntaxKind.UnknownKeyword
  ) {
    if (subject === 'interface:NotificationRequest/property:data') {
      return `${subject} carries caller-supplied Web Notification structured-clone data. The web page and service-worker adapters forward the same value through WebNotificationOptions.data to the native API without inspection, while a ScheduledNotification can retain its request. If this field participates in portable notification state, normalize it at the request producer into one named closed NotificationData domain shared by requests, schedules, and adapters. If it is intentionally an unexamined browser-provider payload, keep it at that provider boundary and record a reviewed source-portability exception for this exact property. The compiler will not infer the structured-clone subset, choose a target-specific Any carrier, insert a cast, or copy or materialize the payload.`;
    }
    if (subject === 'interface:WebNotificationOptions/property:data') {
      return `${subject} is the browser-provider leg of NotificationRequest.data: both web adapters forward the caller's value unchanged into the native notification options, and no Flight consumer inspects it. If portable code owns the data, normalize it at the NotificationRequest producer into one named closed NotificationData domain and carry that type through these options. If the value remains an unexamined browser structured-clone payload, record a reviewed source-portability exception for this exact property. The compiler will not infer the browser's structured-clone domain, choose a target-specific Any carrier, insert a cast, or copy or materialize the payload.`;
    }
    if (subject === 'interface:WebServiceWorkerNotificationInstance/property:data') {
      return `${subject} exposes browser-owned structured-clone data on a native service-worker notification, but the active-list adapter reads only tag identity and never returns, stores, or inspects data. For that unexamined provider contract, record a reviewed source-portability exception for this exact property. If a consumer begins transporting the value, normalize it at ingress into a named closed NotificationData domain before portable storage or results. The compiler will not infer the browser's structured-clone domain, choose a target-specific Any carrier, insert a cast, or copy or materialize the payload.`;
    }
  }
  return undefined;
}

function getHostAppLoopOpaqueHandleGuidance(
  node: ts.MethodSignature,
  type: ts.TypeNode,
  subject: string,
  kinds: ReadonlySet<OpaqueTypeKind>,
): string | undefined {
  if (
    !hasOnlyUnknown(kinds) ||
    type.kind !== ts.SyntaxKind.UnknownKeyword ||
    !isFlightTypesSource(node, 'HostAppLoop.ts')
  ) {
    return undefined;
  }
  if (subject === 'interface:HostAppLoopCapability/method:requestFrame.return') {
    return `${subject} is a provider-issued cancellation token. startAppLoop stores it only in private LoopState and returns the same token to HostAppLoopCapability.cancelFrame; no consumer inspects, coerces, persists, or exposes it. This paired identity transport is genuinely opaque, so record a reviewed source-portability exception for this exact return boundary while that invariant holds. If handles must cross a portable result or storage boundary, define one named closed AppLoopFrameHandle domain shared by requestFrame, LoopState, cancelFrame, and every provider. The compiler will not assume the web provider's numeric handle, choose a target-specific Any carrier, insert a cast, or copy or materialize the token.`;
  }
  if (subject === 'interface:HostAppLoopCapability/method:cancelFrame.parameter:handle') {
    return `${subject} accepts only the provider-issued token previously returned by requestFrame. startAppLoop passes that token back unchanged from private LoopState, and cancelFrame is the sole semantic consumer; portable code never examines the token. This paired identity transport is genuinely opaque, so record a reviewed source-portability exception for this exact parameter boundary while that invariant holds. If handles must cross a portable result or storage boundary, define one named closed AppLoopFrameHandle domain shared by requestFrame, LoopState, cancelFrame, and every provider. The compiler will not assume the web provider's numeric handle, choose a target-specific Any carrier, insert a cast, or copy or materialize the token.`;
  }
  return undefined;
}

function hasOnlyUnknown(kinds: ReadonlySet<OpaqueTypeKind>): boolean {
  return kinds.size === 1 && kinds.has('unknown');
}

function isFlightTypesSource(node: ts.Node, basename: string): boolean {
  return normalizePathPortable(node.getSourceFile().fileName).endsWith(`/packages/types/src/${basename}`);
}

function isReadonlyUnknownRecord(node: ts.TypeNode | undefined): boolean {
  if (!node || !ts.isTypeReferenceNode(node) || getNodeName(node.typeName) !== 'Readonly') return false;
  const inner = node.typeArguments?.[0];
  if (!inner || !ts.isTypeReferenceNode(inner) || getNodeName(inner.typeName) !== 'Record') return false;
  const [key, value] = inner.typeArguments ?? [];
  return key?.kind === ts.SyntaxKind.StringKeyword && value?.kind === ts.SyntaxKind.UnknownKeyword;
}

function isStringOrReadonlyUnknownRecord(node: ts.TypeNode): boolean {
  if (!ts.isUnionTypeNode(node) || node.types.length !== 2) return false;
  return (
    node.types.some((type) => type.kind === ts.SyntaxKind.StringKeyword) &&
    node.types.some((type) => isReadonlyUnknownRecord(type))
  );
}

function getTrayOpaqueErrorGuidance(
  node: ts.PropertySignature,
  subject: string,
  kinds: ReadonlySet<OpaqueTypeKind>,
): string | undefined {
  if (
    kinds.size !== 1 ||
    !kinds.has('unknown') ||
    getNodeName(node.name) !== 'error' ||
    node.questionToken === undefined ||
    node.type?.kind !== ts.SyntaxKind.UnknownKeyword ||
    !normalizePathPortable(node.getSourceFile().fileName).endsWith('/packages/types/src/Tray.ts')
  ) {
    return undefined;
  }
  const flow = getTrayOpaqueErrorFlow(subject);
  if (flow === undefined) return undefined;
  const outcome = getDiscriminatedOutcomeFromSubject(subject) ?? 'native-resource destruction failure';
  return `${subject} preserves an optional unknown error for the Tray ${outcome} result; ${flow} The payload crosses the public Tray result boundary unchanged. No consumer inspects it to recover a runtime domain, and it is neither a detection-only probe nor a normalized value: it is genuinely opaque. If portable consumers need machine-readable failure data, normalize every producer before result construction into one named closed TrayErrorPayload shared by capabilities, wrapper results, storage, and consumers. If arbitrary provider-thrown data is intentionally returned only as an unexamined host diagnostic, record a reviewed source-portability exception for this exact property. The compiler will not infer Error, stringify the value, choose a target-specific Any carrier, insert a cast, or copy or materialize the payload.`;
}

function getTrayOpaqueErrorFlow(subject: string): string | undefined {
  switch (subject) {
    case 'type:TrayCreateCapabilityResult/arm:outcome=runtime-api-unavailable/property:error':
      return 'The arm is a reserved capability outcome, and createTrayIcon forwards any provider-supplied payload without narrowing.';
    case 'type:TrayCreateCapabilityResult/arm:outcome=invalid-icon/property:error':
    case 'type:TrayImageUpdateResult/arm:outcome=invalid-icon/property:error':
    case 'type:TrayPressedImageUpdateResult/arm:outcome=invalid-icon/property:error':
      return 'Electron image decoder failures are caught as thrown payloads, and the public create, update, or animation wrappers preserve the same payload without narrowing.';
    case 'type:TrayCreateCapabilityResult/arm:outcome=tray-create-failed/property:error':
      return 'Electron and Tauri lifecycle creation or cancellation cleanup, plus createTrayIcon itself, can catch arbitrary thrown values and preserve the same payload in the entity result.';
    case 'interface:TrayDestroyFailure/property:error':
      return 'Electron and Tauri native cleanup failures, or a rejected lifecycle destroy, are aggregated as failure entries without payload normalization.';
    case 'type:TrayImageUpdateResult/arm:outcome=image-update-failed/property:error':
    case 'type:TrayPressedImageUpdateResult/arm:outcome=pressed-image-update-failed/property:error':
      return 'Native image setters and the generic update wrapper can catch arbitrary thrown values, and image animation propagates the resulting failure arm unchanged.';
    case 'type:TrayDoubleClickPolicyUpdateResult/arm:outcome=double-click-policy-update-failed/property:error':
    case 'type:TrayTemplateImageUpdateResult/arm:outcome=template-image-update-failed/property:error':
    case 'type:TrayTitleUpdateResult/arm:outcome=title-update-failed/property:error':
    case 'type:TrayTooltipUpdateResult/arm:outcome=tooltip-update-failed/property:error':
      return 'A native setter or the generic update wrapper catches an arbitrary thrown value and returns it without narrowing.';
    case 'type:TrayMenuUpdateResult/arm:outcome=menu-build-failed/property:error':
      return 'Electron and Tauri menu construction catches arbitrary thrown values and returns the same payload without narrowing.';
    case 'type:TrayMenuUpdateResult/arm:outcome=menu-install-failed/property:error':
      return 'Menu installation is deliberately heterogeneous: producers return caught values, explicit Error instances, or an array of cleanup failures, and no consumer narrows them.';
    case 'type:TrayBoundsResult/arm:outcome=bounds-read-failed/property:error':
    case 'type:TrayTitleReadResult/arm:outcome=title-read-failed/property:error':
    case 'type:TrayTooltipReadResult/arm:outcome=tooltip-read-failed/property:error':
      return 'The host read capability or invokeRead can return or catch an arbitrary failure payload, which the public read wrapper preserves without normalization.';
    case 'type:TrayBalloonDisplayResult/arm:outcome=balloon-display-failed/property:error':
    case 'type:TrayBalloonRemoveResult/arm:outcome=balloon-remove-failed/property:error':
    case 'type:TrayPopupMenuResult/arm:outcome=popup-failed/property:error':
      return 'The native Tray surface operation or invokeUpdate catches an arbitrary thrown value and returns it without narrowing.';
    case 'type:TrayEventAttachResult/arm:outcome=subscription-failed/property:error':
    case 'type:TrayReleaseResult/arm:outcome=release-failed/property:error':
      return 'Signal subscription or release catches an arbitrary thrown value and exposes it directly in the lifecycle result.';
    default:
      return undefined;
  }
}

function getDiscriminatedOutcomeFromSubject(subject: string): string | undefined {
  const marker = '/arm:outcome=';
  const start = subject.indexOf(marker);
  if (start < 0) return undefined;
  const valueStart = start + marker.length;
  const end = subject.indexOf('/', valueStart);
  return subject.slice(valueStart, end < 0 ? undefined : end);
}

function getSpineDrawOrderOpaqueValueGuidance(
  node: ts.PropertySignature,
  subject: string,
  kinds: ReadonlySet<OpaqueTypeKind>,
): string | undefined {
  if (
    kinds.size !== 1 ||
    !kinds.has('unknown') ||
    !normalizePathPortable(node.getSourceFile().fileName).endsWith('/packages/skeleton2d-formats/src/spineParse.ts')
  ) {
    return undefined;
  }
  const field = getNodeName(node.name);
  const owner = getEnclosingVariableName(node);
  const rewriteRefusal =
    'The compiler will not choose a target-specific Any carrier, insert a cast, copy or materialize the parsed JSON, or bypass the validation path.';
  if (subject === 'function:parseSpineDrawOrderTimeline/property:offsets' && owner === 'entry' && field === 'offsets') {
    return `${subject} exposes unknown for the Spine draw-order frame offsets; resolveSpineDrawOrder requires an array, validates every move object and slot name, defaults each numeric offset, and produces only a closed ordering of slot indices for portable Skeleton2DDrawOrderTimeline storage. This is not a detection-only or diagnostic-only probe. A reviewed source-portability exception for this exact property is justified only while the resolver dominates every storage path. If raw offsets can be returned, retained, or stored before resolution, declare named closed Spine draw-order frame and move schemas. ${rewriteRefusal}`;
  }
  if (subject === 'function:parseSpineDrawOrderTimeline/property:time' && owner === 'entry' && field === 'time') {
    return `${subject} exposes unknown for the Spine draw-order frame time; numberOr accepts a number or the closed default before that value enters the timeline times array or an unresolved-frame diagnostic detail. This is not a detection-only or diagnostic-only probe because the normalized number reaches portable Skeleton2DDrawOrderTimeline storage on successful frames. A reviewed source-portability exception for this exact property is justified only while numberOr dominates every consumer. If raw time can reach a result or diagnostic before validation, declare it in a named closed Spine draw-order frame schema. ${rewriteRefusal}`;
  }
  if (subject === 'function:resolveSpineDrawOrder/property:offset' && owner === 'move' && field === 'offset') {
    return `${subject} exposes unknown for the Spine draw-order move offset; numberOr accepts a number or the closed default before the move enters the ordering resolver, and only resolved slot indices reach portable Skeleton2DDrawOrderTimeline storage. This is not a detection-only or diagnostic-only probe. A reviewed source-portability exception for this exact property is justified only while numberOr and the resolver dominate every storage path. If a raw offset can reach the resolver output or asset storage before validation, declare it in a named closed Spine draw-order move schema. ${rewriteRefusal}`;
  }
  if (subject === 'function:resolveSpineDrawOrder/property:slot' && owner === 'move' && field === 'slot') {
    return `${subject} exposes unknown for the Spine draw-order move slot; the consumer accepts only a string whose name resolves to a setup slot, rejects the whole frame otherwise, and passes only the closed slotIndex number into the ordering resolver and portable Skeleton2DDrawOrderTimeline storage. This is not a detection-only or diagnostic-only probe. A reviewed source-portability exception for this exact property is justified only while the string guard, name lookup, and resolver dominate every storage path. If a raw slot value can cross that boundary, declare it in a named closed Spine draw-order move schema. ${rewriteRefusal}`;
  }
  return undefined;
}

function getPixiParseOpaqueValueGuidance(
  node: ts.PropertySignature | ts.TypeAliasDeclaration,
  subject: string,
  kinds: ReadonlySet<OpaqueTypeKind>,
): string | undefined {
  if (
    kinds.size !== 1 ||
    !kinds.has('unknown') ||
    !normalizePathPortable(node.getSourceFile().fileName).endsWith('/packages/particles-formats/src/pixiParse.ts')
  ) {
    return undefined;
  }
  const rewriteRefusal =
    'The compiler will not choose a target-specific Any carrier, insert a cast, copy or materialize the parsed JSON, or bypass the normalizer.';
  if (ts.isTypeAliasDeclaration(node)) {
    if (subject !== 'type:PixiRaw') return undefined;
    return `${subject} aliases unknown values for the open-key, untrusted Pixi JSON object; those raw values cross parser helper boundaries, but every current consumer either tests presence, reduces a guarded value to diagnostic evidence, or normalizes it to a closed value before portable asset storage. A reviewed source-portability exception for this exact alias is justified only while no raw member is returned or retained. If any raw member begins entering a result, diagnostic payload, or ParticleEmitterConfig storage, replace the open record with a named closed Pixi input schema covering that member and its supported alternatives. ${rewriteRefusal}`;
  }
  const field = getNodeName(node.name);
  const owner = getEnclosingVariableName(node);
  if (
    (subject === 'function:collectPixiDiagnostics/property:x' ||
      subject === 'function:collectPixiDiagnostics/property:y') &&
    owner === 'accel' &&
    (field === 'x' || field === 'y')
  ) {
    return `${subject} exposes unknown for the detection-only acceleration.${field} probe; rn accepts only a finite number or its closed default, and the consumer uses the result solely for a nonzero check that emits a fixed diagnostic, so no input value enters diagnostic or ParticleEmitterConfig storage. Record a reviewed source-portability exception for this exact property only while that remains the whole contract. If acceleration.${field} begins entering a result or portable asset field, declare a named closed Pixi acceleration schema before transporting it. ${rewriteRefusal}`;
  }
  if (subject.startsWith('function:rawToConfig/property:')) {
    const storedProbe = getPixiRawToConfigStoredProbe(owner, field);
    if (storedProbe) {
      return `${subject} exposes unknown for Pixi ${storedProbe.input}; ${storedProbe.normalization}, and only ${storedProbe.output} enters portable ParticleEmitterConfig storage. A reviewed source-portability exception for this exact property is justified only while this normalization dominates every storage path. If the raw value can reach storage before that validation and defaulting, declare ${storedProbe.schema}. ${rewriteRefusal}`;
    }
  }
  if (subject === 'function:readColor/property:value' && owner === 'valueObj' && field === 'value') {
    return `${subject} exposes unknown for the Pixi color start/end wrapper value; readColor accepts it only after a string guard, parses the selected hex text into finite numeric channels or defaults, and only the resulting RGB numbers enter portable ParticleEmitterConfig storage. A reviewed source-portability exception for this exact property is justified only while this normalization dominates every storage path. If the wrapper value can reach storage before string validation and channel conversion, declare a named closed Pixi color-value schema. ${rewriteRefusal}`;
  }
  if (
    subject === `function:readStartEnd/property:${field ?? ''}` &&
    owner === 'o' &&
    (field === 'start' || field === 'end')
  ) {
    return `${subject} exposes unknown for the Pixi start/end range member; readStartEnd accepts a direct number or delegates to a guarded wrapper, then rn admits only a finite number or the closed default, and only that number enters portable ParticleEmitterConfig storage for speed, scale, or alpha. A reviewed source-portability exception for this exact property is justified only while this normalization dominates every storage path. If the range member can reach storage before finite-number validation and defaulting, declare a named closed Pixi start/end value schema. ${rewriteRefusal}`;
  }
  const rangeEnd = owner === 'startObj' ? 'start' : owner === 'endObj' ? 'end' : undefined;
  if (subject === 'function:readStartEnd/property:value' && field === 'value' && rangeEnd !== undefined) {
    return `${subject} exposes unknown for the nested ${rangeEnd} wrapper in a Pixi start/end range; readStartEnd accepts it only after a number guard, then rn admits only a finite number or the closed default, and only that number enters portable ParticleEmitterConfig storage for speed, scale, or alpha. A reviewed source-portability exception for this exact property is justified only while this normalization dominates every storage path. If the wrapper value can reach storage before finite-number validation and defaulting, declare a named closed Pixi start/end wrapper schema. ${rewriteRefusal}`;
  }
  return undefined;
}

function getPixiRawToConfigStoredProbe(
  owner: string | undefined,
  field: string | undefined,
): Readonly<{ input: string; normalization: string; output: string; schema: string }> | undefined {
  if (owner === 'life' && (field === 'min' || field === 'max')) {
    return {
      input: `lifetime.${field}`,
      normalization: 'rn admits only a finite number or the closed default',
      output: `the closed lifetime${field === 'min' ? 'Min' : 'Max'} number`,
      schema: 'a named closed Pixi lifetime schema',
    };
  }
  if (owner === 'colorObj' && (field === 'start' || field === 'end')) {
    return {
      input: `color.${field}`,
      normalization:
        'readColor accepts a string or guarded value wrapper and converts it to finite RGB channels or defaults',
      output: `the closed color${field === 'start' ? 'Start' : 'End'} channel numbers`,
      schema: 'a named closed Pixi color endpoint schema',
    };
  }
  if (owner === 'angleObj' && (field === 'min' || field === 'max')) {
    return {
      input: `angle.${field}`,
      normalization: 'rn admits only a finite number or the closed default before the angle arithmetic',
      output: 'closed direction and spread numbers',
      schema: 'a named closed Pixi angle schema',
    };
  }
  if (owner === 'spawnRect' && (field === 'w' || field === 'h')) {
    return {
      input: `spawnRect.${field}`,
      normalization: 'rn admits only a finite number or the closed default',
      output: `the closed emitter${field === 'w' ? 'Width' : 'Height'} number`,
      schema: 'a named closed Pixi rectangle schema',
    };
  }
  if (owner === 'spawnCircle' && field === 'r') {
    return {
      input: 'spawnCircle.r',
      normalization: 'rn admits only a finite number or the closed default',
      output: 'the closed emitterRadius number',
      schema: 'a named closed Pixi circle schema',
    };
  }
  return undefined;
}

function getEnclosingVariableName(node: ts.Node): string | undefined {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isVariableDeclaration(current)) return getNodeName(current.name);
    if (ts.isFunctionLike(current)) return undefined;
  }
  return undefined;
}

function getTextureAtlasDetectionOpaqueValueGuidance(
  node: ts.PropertySignature,
  subject: string,
  kinds: ReadonlySet<OpaqueTypeKind>,
): string | undefined {
  if (
    kinds.size !== 1 ||
    !kinds.has('unknown') ||
    !normalizePathPortable(node.getSourceFile().fileName).endsWith(
      '/packages/textureatlas-formats/src/textureAtlasDetect.ts',
    )
  ) {
    return undefined;
  }
  if (subject === 'function:readJsonAtlasKind/property:frames') {
    return `${subject} exposes unknown at the parsed-JSON recognition boundary; this detector only requires frames to be present, then inspects one frame behind array/object guards to obtain boolean format evidence, and never stores or passes the opaque value to an atlas parser. For that detection-only contract, record a reviewed source-portability exception for this exact property and preserve the guards. If frames begin crossing the detector boundary, declare a named closed detector document and frame schema before transporting them. The compiler will not reconstruct the Aseprite or TexturePacker schema, choose a target-specific Any carrier, insert a cast, or copy or materialize the parsed JSON.`;
  }
  if (subject === 'function:readJsonAtlasKind/property:meta') {
    return `${subject} exposes unknown at the parsed-JSON recognition boundary; this detector passes meta only to a guarded app probe and never stores or passes the opaque value to an atlas parser. For that detection-only contract, record a reviewed source-portability exception for this exact property and preserve the guards, including the object and string checks. If meta begins crossing the detector boundary, declare a named closed detector document and metadata schema before transporting it. The compiler will not reconstruct the Aseprite or TexturePacker schema, choose a target-specific Any carrier, insert a cast, or copy or materialize the parsed JSON.`;
  }
  if (subject === 'function:hasFrameDuration/property:duration') {
    return `${subject} exposes unknown only while probing an untrusted frame for the Aseprite duration discriminator; the detector accepts it only after object and number guards and immediately reduces it to boolean format evidence. For that detection-only contract, record a reviewed source-portability exception for this exact property and preserve the guards. If duration itself begins crossing the detector boundary, declare it in a named closed frame-probe schema. The compiler will not infer an atlas schema from the runtime check, choose a target-specific Any carrier, insert a cast, or copy or materialize the parsed JSON.`;
  }
  if (subject === 'function:readMetaApp/property:app') {
    return `${subject} exposes unknown only while probing untrusted metadata for the format-producer string; the detector accepts it only after object and string guards and returns a closed string rather than the opaque value. For that detection-only contract, record a reviewed source-portability exception for this exact property and preserve the guards. If app begins crossing the detector boundary without validation, declare it in a named closed metadata-probe schema. The compiler will not infer an atlas schema from the runtime check, choose a target-specific Any carrier, insert a cast, or copy or materialize the parsed JSON.`;
  }
  return undefined;
}

function getLottieOpaquePayloadGuidance(
  node: ts.PropertySignature,
  subject: string,
  kinds: ReadonlySet<OpaqueTypeKind>,
): string | undefined {
  if (
    kinds.size !== 1 ||
    !kinds.has('unknown') ||
    path.posix.basename(normalizePathPortable(node.getSourceFile().fileName)) !== 'LottieDocument.ts'
  ) {
    return undefined;
  }
  if (subject === 'interface:LottieDocument/property:chars') {
    return `${subject} exposes unknown elements for the Lottie character-data array; the format gives every entry character and font metrics plus a character-data alternative for shapes or a precomposition, but this declaration names none of those runtime alternatives. Declare a named closed Lottie character payload and distinct shapes/precomposition arms for the supported subset before portable storage or consumption. If raw character JSON is intentionally retained only at an unexamined input boundary, record a reviewed source-portability exception for this exact property and keep the erased payload outside portable runtime storage. The compiler will not reconstruct the schema from JSON or choose a target-specific Any carrier.`;
  }
  const textPayload =
    subject === 'interface:LottieTextData/property:a'
      ? { domain: 'text-range array', exposure: 'unknown elements' }
      : subject === 'interface:LottieTextData/property:m'
        ? { domain: 'text-alignment options', exposure: 'an unknown value' }
        : subject === 'interface:LottieTextData/property:p'
          ? { domain: 'text follow-path options', exposure: 'an unknown value' }
          : undefined;
  if (!textPayload) return undefined;
  return `${subject} exposes ${textPayload.exposure} for the Lottie ${textPayload.domain}; that field has its own schema and is not interchangeable with the other text animator payloads. Declare a distinct named closed payload for the supported fields before portable storage or interpretation. If the importer intentionally retains this unsupported data only as unexamined input JSON, record a reviewed source-portability exception for this exact property and keep the erased payload outside portable runtime storage. The compiler will not merge LottieTextData.a, .m, and .p into one opaque carrier or choose a target-specific Any carrier.`;
}

function renderUncheckedDoubleAssertionMessage(
  node: ts.AsExpression | ts.TypeAssertion,
  subject: string,
  bridge: 'any' | 'never' | 'unknown',
): string {
  const physics3DWorld = getPhysics3DWorldDoubleAssertionGuidance(node, subject, bridge);
  if (physics3DWorld) return physics3DWorld;
  const swfNode = getSwfNodeDoubleAssertionGuidance(node, subject, bridge);
  if (swfNode) return swfNode;
  if (isTypeScriptMutableIndexSignatureView(getTypeAssertionType(node))) {
    return `${subject} uses a double assertion through ${bridge} to claim mutable index-signature storage; the bridge neither proves nor creates writable dynamic cells on the source owner. For an intentionally open key or extension domain, declare a mutable string index signature on the base/output type and construct every value in that carrier; a registry of keys or roles does not recover cells on an owner that lacks them. If the keys are closed, replace the dynamic writes with a finite union of declared members. A reviewed exception can record the source contract but cannot supply that storage; copying or materializing a Record, or adding side storage, would change object identity.`;
  }
  if (isTypeScriptIndexSignatureView(getTypeAssertionType(node))) {
    return `${subject} uses a double assertion through ${bridge} to claim an index-signature view; the bridge neither checks that the source has indexed storage nor preserves an exact runtime carrier for computed access. Accept a declared Record or index-signature type at this boundary, or replace the dynamic key with checked access over a closed key/value domain; an assertion cannot create that storage.`;
  }
  const objectLiteralTarget = getUncheckedDoubleAssertionObjectLiteralTarget(node);
  if (objectLiteralTarget !== undefined) {
    return `${subject} uses a double assertion through ${bridge} to claim that a fresh object literal is ${objectLiteralTarget}; the bridge checks neither the target's required surface nor any host identity, prototype, or native capability that ${objectLiteralTarget} represents. Keep the mock in a named structural fake type covering the members it actually implements and inject it through an explicit host/test adapter. If this partial object is deliberately a JavaScript-only stand-in for ${objectLiteralTarget}, record a reviewed source-portability exception for this exact boundary. The compiler will preserve an already proven ${objectLiteralTarget} carrier, but will not reinterpret this literal, copy it, materialize a replacement owner, or invent native identity.`;
  }
  return `${subject} uses a double assertion through ${bridge}; replace it with a checked conversion or a narrower source type.`;
}
