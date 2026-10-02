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
        add(node, 'mixed-absence', subject, renderMixedAbsencePropertyMessage(node, subject));
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

function getAnchorLayoutMixedAbsencePropertyMessage(node: ts.PropertySignature, subject: string): string | undefined {
  const name = getNodeName(node.name);
  if (
    ts.isInterfaceDeclaration(node.parent) &&
    node.parent.name.text === 'AnchorLayoutItemStyle' &&
    normalizePathPortable(node.getSourceFile().fileName).endsWith('/packages/types/src/Layout.ts') &&
    isOptionalNullableNumberProperty(node) &&
    (name === 'bottom' ||
      name === 'height' ||
      name === 'left' ||
      name === 'right' ||
      name === 'top' ||
      name === 'width')
  ) {
    return `${subject} gives the anchor constraint ${name} both an omitted state and explicit null, but current Flight gives them one inactive meaning. AnchorLayoutItemStyle is a sparse caller- or document-authored input shape, not a reusable internal state cell: Flight has no production AnchorLayout tree builder, its Rive importer emits only FlexLayoutKind or GridLayoutKind, and the anchor tests construct sparse object literals that omit inactive constraints. createFlightDocumentLayoutBindings carries a document tree by identity into the inert live binding. The text reader maps a missing or null whole style to the required-nullable LayoutNode.itemStyle slot, but copies every own field of a present mapping; the writer omits only a null whole style, and writeFlightDocumentLayoutBindings recursively clones a present mapping, so generic document transport preserves explicit-null keys without giving them anchor semantics. The layout core has no style clone, mutator, reset, or disposer: resolveLayoutTree reads the caller-owned tree and changes only the output buffer and LayoutState failure fields. The anchor validator accepts null and undefined through isOptionalNumber, and anchorLayoutResolver normalizes left, right, top, and bottom with ?? null. When opposing pins do not determine an axis, its width and height expressions each use ?? intrinsicSizes, so either absence spelling selects the same natural-size fallback before placement uses a pin or alignment. Make all six bottom, height, left, right, top, and width members optional number inputs; keep the enclosing LayoutNode.itemStyle required nullable, with null as its no-style sentinel. If a serialized or public compatibility input must continue accepting explicit null, keep that boundary shape separate and normalize it once into the optional-number layout style; if explicit clear must differ from omission, name a closed constraint-state union and handle it separately. Do not whitelist the redundant input spelling. The compiler will not choose or collapse an absence sentinel, infer a numeric default because zero is a real pin or size, collapse a present value, mutate or clone a layout tree, rewrite document transport or an input boundary, add disposal work, or add side storage.`;
  }
  return undefined;
}

function getScene3DRenderProxyMixedAbsencePropertyMessage(
  node: ts.PropertySignature,
  subject: string,
): string | undefined {
  const name = getNodeName(node.name);
  const isExactSlot =
    (name === 'colorMatrix' && isOptionalNullableReadonlyNumberArrayProperty(node)) ||
    (name === 'colorScaleBias' && isOptionalNullableReadonlyNamedTypeProperty(node, 'ColorScaleBias')) ||
    ((name === 'instanceColors' ||
      name === 'instanceMatrices' ||
      name === 'jointMatrices' ||
      name === 'normalMatrices') &&
      isOptionalNullableReadonlyNamedTypeProperty(node, 'Float32Array'));
  if (
    ts.isInterfaceDeclaration(node.parent) &&
    node.parent.name.text === 'Scene3DRenderProxy' &&
    normalizePathPortable(node.getSourceFile().fileName).endsWith('/packages/types/src/Scene3DRenderProxy.ts') &&
    isExactSlot
  ) {
    return `${subject} gives the reused per-draw proxy slot ${name} both an omitted state and explicit null, but current Flight has one inactive state for each of these six slots. Production owns three module-local scratch records and never clones them: the GL and WebGPU forward proxies are exposed only for one renderer draw call, while the WebGPU shadow proxy is passed only to writeWgpuDrawUniform once per caster; renderer contracts forbid retaining them. Both forward producers assign colorMatrix, colorScaleBias, jointMatrices, and normalMatrices to a value or null on every regular draw. Their instanced phases assign the color slots and instanceMatrices, clear both skin palettes, then clear instanceCount and instanceMatrices afterward; GL also assigns and clears its separate instanceColors, while WebGPU packs instance colors beside matrices in one buffer and never reads instanceColors. The WebGPU shadow producer assigns jointMatrices to a palette or null for every caster and currently leaves the other five optional slots omitted; bind-group selection consumes that same local palette, while writeWgpuDrawUniform reads only the nullish color slots from this group. GL drawGlMeshSubset checks every consumed color, skin, matrix, and color-instance slot with != null; WebGPU drawWgpuMeshSubset normalizes the two skin palettes with ?? null and explicitly accepts null or undefined instanceMatrices, while writeWgpuDrawUniform uses nullish color checks. Neither backend distinguishes omission from null. Make all six colorMatrix, colorScaleBias, instanceColors, instanceMatrices, jointMatrices, and normalMatrices slots required nullable fields on the internal Scene3DRenderProxy scratch contract, initialize all six to null in all three scratch records, preserve the authoritative per-draw writes and post-instancing clears, and keep each existing buffer owner rather than copying it. If compatibility callers must omit a slot, give that input a separate shape and normalize it once before the scratch record reaches a renderer. Do not whitelist the redundant live-storage spelling. The compiler will not choose or collapse an absence sentinel, infer a palette or color default, synthesize presence bits, retain stale state, clone a proxy, copy or materialize a buffer, rewrite draw ordering or shader selection, or add side storage.`;
  }
  return undefined;
}

function getMeshDeformationMixedAbsencePropertyMessage(
  node: ts.PropertySignature,
  subject: string,
): string | undefined {
  if (!ts.isInterfaceDeclaration(node.parent) || !isFlightTypesSource(node, 'Mesh.ts')) return undefined;
  const owner = node.parent.name.text;
  const name = getNodeName(node.name);
  if (owner === 'Mesh' && name === 'morph' && isOptionalNullableExactNamedTypeProperty(node, 'MeshMorph')) {
    return `${subject} gives the live mesh morph slot both omission and explicit null, but current Flight has one no-morph state. createMesh omits morph, and buildDocumentNode assigns the exact Scene3DDocument MeshMorph owner only when present. cloneMesh first detaches geometry whenever either deformer is present, then for a present morph shares its immutable targets, copies its mutable weight array, and assigns no value for either absent spelling; no production mutator or disposer writes null or undefined afterward. prepareScene3DMorph drives updateMeshMorph, which returns for a nullish slot before capturing a bind pose or blending vertices; Weights animation, getMeshDeformer, updateMeshSkin's composed-deformation refresh, and the GL deform guard also use nullish checks. GL and WebGPU draw or upload the geometry those passes update rather than interpreting morph, so no consumer observes which absence spelling reached the mesh. Make Mesh.morph an optional non-null MeshMorph field and use omission or undefined as its sole inactive state, preserving the clone's target sharing, weight copy, and detached geometry. If a public or serialized input must still accept null, give it a separate shape and normalize once before constructing the live mesh. Do not whitelist the redundant live-storage spelling. The compiler will not choose or collapse an absence sentinel, infer or create a morph or bind pose, run animation or deformation, detach or clone geometry, copy targets or weights, change composition order or upload behavior, reinterpret or cast the MeshMorph owner, or add side storage.`;
  }
  if (owner === 'Mesh' && name === 'skin' && isOptionalNullableExactNamedTypeProperty(node, 'Skin')) {
    return `${subject} gives the live mesh skin slot both omission and explicit null, but current Flight has one rigid state. createMesh omits skin, and applyDocumentSkins assigns an exact resolved Skin only when a document mesh names a valid skin. cloneMesh detaches geometry whenever either deformer is present, shares the exact present Skin and its Skeleton3D owner, and assigns no value for either absent spelling; no production mutator or disposer writes null or undefined afterward. updateMeshSkin and prepareMeshSkinning return for a nullish slot before computing palettes, capturing bind poses, or posing bounds; getMeshDeformer and shared render preparation use the same one-state test. GL forward and shadow paths require skin != null before reading its palettes, while the WebGPU skin adapter returns false for skin == null, so neither backend distinguishes null from undefined. Make Mesh.skin an optional non-null Skin field and use omission or undefined as its sole rigid state, preserving the clone's shared Skin identity and detached geometry. A future skin-removal lifecycle must clear this mesh's node-owned deformedLocalBounds explicitly without conflating it with geometry-owned bind-pose caches, rather than adding a second field-level absence spelling. If a public or serialized input must still accept null, give it a separate shape and normalize once before constructing the live mesh. Do not whitelist the redundant live-storage spelling. The compiler will not choose or collapse an absence sentinel, infer or create a skin, skeleton, palette, or bind pose, run skinning, detach or clone geometry, copy or materialize the Skin owner, clear related runtime caches, change shader selection, reinterpret or cast the owner, or add side storage.`;
  }
  if (
    owner === 'MeshDeformRuntime' &&
    name === 'deformedLocalBounds' &&
    isOptionalNullableExactNamedTypeProperty(node, 'Aabb')
  ) {
    return `${subject} gives the mesh node runtime's posed local-bounds cache both omission and explicit null, but current Flight has one not-prepared state. createNode3DRuntime omits the slot for every createMesh call, and cloneMesh constructs a fresh node runtime without copying the source's pose-dependent bounds even when it shares a Skin. prepareMeshSkinning is the sole writer: after a present skin computes its palette and captures its bind pose, it allocates and stores one Aabb when the slot is nullish and updates that exact box on later prepared frames; updateMeshSkin and morph-only preparation instead update real geometry vertices and never write or clear this node-runtime cache. Shared render culling warns for a present skin with nullish bounds, then uses deformedLocalBounds ?? ensureMeshGeometryBounds before both GL and WebGPU draws. Picking uses a nullish presence check before falling back to geometry world bounds, and the GL deform guard uses the same check; no teardown or lifecycle path writes null. Make MeshDeformRuntime.deformedLocalBounds an optional non-null Aabb field and use omission or undefined as its sole not-prepared state, preserving node ownership, the clone's fresh cache, and the producer's same-box reuse. If a future skin-removal or runtime-reset path must clear the cache, delete or set that one optional state without clearing a geometry-owned bind pose merely to represent missing node bounds; if an external runtime snapshot accepts null, normalize it before admitting it to the live runtime. Do not whitelist the redundant live-storage spelling. The compiler will not choose or collapse an absence sentinel, infer bounds or run skinning, allocate, update, clear, copy, or materialize an Aabb, copy a source mesh's posed cache, change culling or picking fallback, redirect the cache to geometry scope, reinterpret or cast it, or add side storage.`;
  }
  return undefined;
}

function getScene3DDocumentMeshMixedAbsencePropertyMessage(
  node: ts.PropertySignature,
  subject: string,
): string | undefined {
  if (
    !ts.isInterfaceDeclaration(node.parent) ||
    node.parent.name.text !== 'Scene3DDocumentMesh' ||
    !isFlightTypesSource(node, 'Scene3DDocument.ts') ||
    getNodeName(node.name) !== 'morph' ||
    !isOptionalNullableNamedTypeProperty(node, 'MeshMorph')
  ) {
    return undefined;
  }
  return `${subject} gives the format-neutral document mesh's inline morph data both omission and explicit null, but current Flight has one no-morph document state. The glTF, COLLADA, and MD2 producers attach morph only after building a non-null MeshMorph; AWD, MD5, OBJ, 3DS, and ordinary COLLADA geometry entries omit the field. COLLADA's material-override clone reconstructs geometry, materials, name, and skin before resolveColladaSkins assigns a successfully decoded morph, so it introduces no null meaning. appendGltfWeightsChannels uses a nullish check before reading targets, while createScene3DFromDocument and createScene3DsFromDocument use buildDocumentNode, which assigns the exact present MeshMorph owner to each live mesh that references the document entry; neither path distinguishes null from omission or clones the document value. Scene3DDocument currently has no clone or export/serialization path; cloneMesh is a downstream live-entity operation that separately shares immutable targets and copies mutable weights only when morph is present. Make Scene3DDocumentMesh.morph an optional non-null MeshMorph field and use omission or undefined as the sole no-morph document state, preserving each producer's conditional assignment and each consumer's exact-owner behavior. If a future wire or compatibility input accepts explicit null, keep that input shape separate and normalize it once before constructing the document entry; if it needs omitted and explicit-null to differ, replace them with one named closed state and handle every arm. Do not whitelist the redundant document spelling. The compiler will not choose or collapse an absence sentinel, decode or infer a morph, attach animation channels, clone or serialize a document, copy or materialize morph targets or weights, change sharing across document nodes or assembled scenes, reinterpret or cast the MeshMorph owner, or add side storage.`;
}

function getSkeleton3DNamesMixedAbsencePropertyMessage(
  node: ts.PropertySignature,
  subject: string,
): string | undefined {
  if (
    !ts.isInterfaceDeclaration(node.parent) ||
    node.parent.name.text !== 'Skeleton3D' ||
    !isFlightTypesSource(node, 'Skeleton3D.ts') ||
    getNodeName(node.name) !== 'names' ||
    !isOptionalNullableReadonlyStringArrayProperty(node)
  ) {
    return undefined;
  }
  return `${subject} gives the live skeleton's index-aligned joint-name table both omission and explicit null, but current Flight has one unnamed-skeleton state. createSkeleton3D normalizes an omitted or null names argument with ?? null and initializeSkeleton3D stores that result, so its produced Skeleton3D always has null or the exact supplied readonly string array. applyDocumentSkins is the only other production builder: every format importer reaches it through Scene3DDocument assembly, it resolves each skin joint index, records joint.name ?? '' at the same index, preserves the full array with empty-string placeholders when any joint is named, and otherwise stores null. cloneSkeleton3D and cloneSkeleton3DJointHierarchy currently preserve a structurally supplied undefined separately, but for a present table both allocate an independent array while preserving every aligned string; no live producer gives that undefined branch a meaning. disposeSkeleton3D clears names to null. equalsSkeleton3D normalizes both absent spellings with ?? null before comparing present arrays element by element, getSkeleton3DJointIndexByName returns -1 for either spelling before using indexOf, and getSkeleton3DJointWorldMatrixByName delegates through that lookup; palette computation, skinning, and rendering never read names. Make Skeleton3D.names a required readonly string[] | null field, keep createSkeleton3D's construction-boundary normalization and both real builders' null assignments, narrow initializeSkeleton3D and the document-local field initializer to that required-nullable type, and simplify both clones to preserve null or copy the present array. A present empty array and the importer's empty-string placeholders remain present index-aligned tables and must not be replaced with null. If structural or compatibility inputs allow omission, give them a separate shape and normalize once before constructing the live skeleton. Do not whitelist the redundant live-storage spelling. The compiler will not choose or collapse an absence sentinel, infer names from joint nodes or a source format, align, pad, truncate, search, compare, clone, or clear the table, change joint identity or order, route strings through Any, reinterpret or cast them, or add side storage.`;
}

function getSkeleton2DImportMixedAbsencePropertyMessage(
  node: ts.PropertySignature,
  subject: string,
): string | undefined {
  if (
    !ts.isInterfaceDeclaration(node.parent) ||
    node.parent.name.text !== 'Skeleton2DImportAnimation' ||
    !isFlightTypesSource(node, 'Skeleton2DImport.ts') ||
    getNodeName(node.name) !== 'drawOrder' ||
    !isOptionalNullableExactNamedTypeProperty(node, 'Skeleton2DDrawOrderTimeline')
  ) {
    return undefined;
  }
  return `${subject} gives the deferred draw-order timeline both omission and explicit null, but current Flight has one no-draw-order state. The Spine JSON and binary animation importers now always assign drawOrder: parseSpineDrawOrderTimeline and readSpineBinaryDrawOrderTimeline return a fresh Skeleton2DDrawOrderTimeline only after retaining at least one resolved whole-ordering frame; when no frame survives missing or empty input, a rig without slots, reader exhaustion, or invalid-frame drops, they return null. DragonBones recognizes zOrder as unsupported, reports its Skip crumb, and is the sole production producer that omits drawOrder; that omission has no distinct consumer meaning. The source comment saying parsers do not emit the property is therefore stale. The timeline remains beside the imported clip because its display nodes and NodeOrderList do not exist at parse time. No production code reads Skeleton2DImportAnimation.drawOrder directly, and there is no import-record clone or serializer. cloneSkeleton2D copies only the setup rig, applyAnimationClipToSkeleton2D consumes only the clip, and cloneAnimationClip copies only channels, tracks, and events. createSkeleton2DDrawOrderChannel is the explicit later boundary: it takes a present timeline, returns null for zero keyframes or a zero or fractional slot width, and createAnimationTrack retains the exact times and orderings arrays as its track buffers. Once a caller adds that channel and registers the draw-order binder, applyAnimationClipToSkeleton2D samples it and the binder rebuilds the caller's NodeOrderList without mutating the timeline or either skeleton; cloning that augmented clip later deep-copies both track buffers. Make Skeleton2DImportAnimation.drawOrder a required Skeleton2DDrawOrderTimeline | null field, keep both Spine producers' exact timeline-or-null assignments, and make DragonBones plus every future producer write null when no deferred timeline exists. Preserve the importer invariant that a present timeline has at least one resolved whole frame; do not introduce an empty timeline as a third no-draw-order sentinel, and keep createSkeleton2DDrawOrderChannel's defensive rejection for external structural input. An empty Skeleton2DImport.animations array independently means a setup-pose-only import and must not be conflated with an animation whose drawOrder is null. If compatibility inputs allow omission, give them a separate shape and normalize once before constructing the public import record. Haxe currently exposes @:optional Null<Skeleton2DDrawOrderTimeline>; the required-nullable rewrite needs only Null<Skeleton2DDrawOrderTimeline>, without a second presence bit or Any carrier. Do not whitelist the redundant import-result spelling. The compiler will not choose or collapse an absence sentinel, decode or resolve draw-order frames, fabricate an empty timeline, append or register a channel, apply or rebuild node order, clone or mutate timeline buffers, clone or serialize an import record, reinterpret or cast the timeline, or add side storage.`;
}

function getSkeleton2DMixedAbsencePropertyMessage(node: ts.PropertySignature, subject: string): string | undefined {
  if (
    !ts.isInterfaceDeclaration(node.parent) ||
    node.parent.name.text !== 'Skeleton2D' ||
    !isFlightTypesSource(node, 'Skeleton2D.ts')
  ) {
    return undefined;
  }
  const name = getNodeName(node.name);
  if (name === 'skins' && isOptionalNullableNamedArrayProperty(node, 'AttachmentSkin2D')) {
    return `${subject} gives the retained Skeleton2D wardrobe list both omission and explicit null, but current Flight has one no-wardrobe state. createSkeleton2D always initializes skins to null. The Spine JSON, Spine binary, and DragonBones importers leave that null intact when parsing produces no top-level skins and overwrite it only with a non-empty AttachmentSkin2D array; a retained skin may itself have an empty attachments array. Rive's pure-bone skeleton likewise retains null. initializeSkeleton2D stores the exact argument, and cloneSkeleton2D shares the exact skins array owner rather than copying it, including a structurally supplied empty array. disposeSkeleton2D clears bones and slots but leaves skins retained. getSkeleton2DSkin returns null for either undefined or null before searching a present array; setSkeleton2DSkin instead consumes its explicit skin argument and writes skeleton.slots without reading skeleton.skins. Equality, validation, setup reset, animation, deformation, path solving, and built-in rendering do not read the wardrobe collection. Make Skeleton2D.skins a required AttachmentSkin2D[] | null field, keep createSkeleton2D's null initializer, narrow initializeSkeleton2D's parameter to the same required-nullable type, and retain each importer's non-empty assignment, disposal behavior, and the clone's shared array identity. A present empty array remains a present collection whose lookup returns null and must not be substituted for absence or fabricated in place of null. If structural or compatibility inputs allow omission, give them a separate shape and normalize once before initializing the live skeleton. Haxe currently exposes @:optional Null<Array<AttachmentSkin2D>>, while C++ exposes variant<Array<Ref<AttachmentSkin2D>>, Null, Undefined>; the required-nullable rewrite removes @:optional and the Undefined alternative while retaining the nullable exact array without Any. Do not whitelist the redundant live-storage spelling. The compiler will not choose or collapse an absence sentinel, infer or parse a wardrobe, apply a skin, clear retained skins during disposal, substitute an empty array, copy or materialize the skin collection or its attachment owners, route elements through Any, reinterpret or cast the collection, or add side storage.`;
  }
  if (name === 'slots' && isOptionalNullableNamedArrayProperty(node, 'Slot2D')) {
    return `${subject} gives the live Skeleton2D slot and draw-order list both omission and explicit null, but current Flight has one no-slots state. createSkeleton2D defaults slots to null; the Spine JSON, Spine binary, and DragonBones importers pass their parsed Slot2D array even when it is empty, while Rive's pure-bone skeleton keeps the default null. initializeSkeleton2D stores the exact value. cloneSkeleton2D preserves either absence spelling, but a present array becomes a new array of new shallow-copied Slot2D records, including a fresh empty array; each record still shares its nested attachment and deform owners until a later write replaces a cell. disposeSkeleton2D clears the whole slots collection to null. setSkeleton2DSkin, slot animation, deform animation, and path-attachment resolution all return for either absence spelling before indexing. setSkeleton2DSkin mutates whichever skeleton argument it receives, while slot and deform animation mutate the pose's cloned slot records; an attachment-animation clear or setSkeleton2DSlotDeform clear writes null to an individual record without clearing the collection. Equality, validation, and setup reset ignore slots. No built-in renderer enumerates Skeleton2D.slots: the attachment vertex and deformation helpers receive an explicit attachment and bone index, leaving display assembly to the caller. Make Skeleton2D.slots a required Slot2D[] | null field, narrow createSkeleton2D and initializeSkeleton2D to that type, preserve null as the pure-rig and disposed sentinel, and simplify the clone and consumers to the single null check while retaining their present-array allocation and mutation behavior. A present empty array remains an authored slot list and must not be replaced with null or fabricated in place of it. If structural or compatibility inputs allow omission, give them a separate shape and normalize once before initializing the live skeleton. Haxe currently exposes @:optional Null<Array<Slot2D>>, while C++ exposes variant<Array<Ref<Slot2D>>, Null, Undefined>; the required-nullable rewrite removes @:optional and the Undefined alternative while retaining the nullable exact array without Any. Do not whitelist the redundant live-storage spelling. The compiler will not choose or collapse an absence sentinel, infer or parse slots, apply a skin or animation, clear an attachment or deform, solve a path constraint, render or assemble display nodes, substitute an empty array, change the clone's shallow owner boundaries, copy or materialize slot or attachment owners beyond the authored clone, route elements through Any, reinterpret or cast the collection, or add side storage.`;
  }
  return undefined;
}

function getSlot2DMixedAbsencePropertyMessage(node: ts.PropertySignature, subject: string): string | undefined {
  if (
    !ts.isInterfaceDeclaration(node.parent) ||
    node.parent.name.text !== 'Slot2D' ||
    !isFlightTypesSource(node, 'Slot2D.ts')
  ) {
    return undefined;
  }
  const name = getNodeName(node.name);
  if (name === 'attachment' && isOptionalNullableNamedTypeProperty(node, 'Attachment2D')) {
    return `${subject} gives the live Slot2D attachment cell both omission and explicit null, but current Flight has one empty-slot state. The Spine JSON and binary importers construct every slot with attachment: null before setup-skin resolution, while DragonBones constructs it with a resolved Attachment2D or null. Setup-skin resolution, setSkeleton2DSkin, and attachment animation later overwrite that same cell with an attachment or null, and cloneSkeleton2D copies the cell unchanged. resolveSkeleton2DPathAttachment rejects undefined and null identically, while getSkeleton2DSlotDeformOffsets compares slot.attachment ?? null with the deform's authored attachment, so neither consumer observes which empty spelling arrived. Make Slot2D.attachment a required Attachment2D | null field and initialize every construction path to null when nothing is shown. If structural or compatibility inputs allow omission, give them a separate shape and normalize once before constructing the live slot. The compiler will not whitelist a redundant absence spelling, choose or collapse a sentinel, infer or resolve an attachment, apply a skin or animation, clear or retain a deform, copy or materialize an attachment owner, reinterpret or cast it, or add side storage.`;
  }
  if (name === 'deform' && isOptionalNullableNamedTypeProperty(node, 'Skeleton2DSlotDeform')) {
    return `${subject} gives the live Slot2D deform cell both a never-written undefined state and an explicit null clear, but current Flight has one no-deform state. The format importers construct slots without deform and cloneSkeleton2D copies that spelling unchanged. setSkeleton2DSlotDeform writes null when clearing, otherwise reuses a present same-sized record or installs one new Skeleton2DSlotDeform. getSkeleton2DSlotDeformOffsets returns null for both absence spellings and exposes offsets only when the record's attachment is the exact owner the slot currently shows; attachment swaps intentionally leave the record in place for that identity check. Make Slot2D.deform a required Skeleton2DSlotDeform | null field, initialize every slot construction path to null, and retain the explicit-null clear and identity-gated read. If structural or compatibility inputs allow omission, give them a separate shape and normalize once before constructing the live slot. The compiler will not whitelist a redundant absence spelling, choose or collapse a sentinel, infer offsets or their attachment, run or clear a deform, change buffer reuse, copy or materialize deformation storage, reinterpret or cast it, or add side storage.`;
  }
  if (name === 'name' && isOptionalNullableStringProperty(node)) {
    return `${subject} gives the Slot2D authored-name cell both omission and explicit null, but current Flight has one unnamed state. The Spine JSON and DragonBones importers normalize a non-string slot name to null, the binary reader returns string | null, and all three construct every Slot2D with that value. Spine's skin, animation, and draw-order resolution paths call indexOfSpineSlot with a string and match only slots whose name is that exact string, so null and omission are equally unnamed; cloneSkeleton2D copies the stored name unchanged. Make Slot2D.name a required string | null field and initialize every construction path to null when no authored name exists. If structural or compatibility inputs allow omission, give them a separate shape and normalize once before constructing the live slot. If omitted, unnamed, and named must differ, replace the absence spellings with one named closed state and handle every arm explicitly. The compiler will not whitelist a redundant absence spelling, choose or collapse a sentinel, infer a name from the bone, attachment, kind, or position, rewrite name lookup, copy or materialize a slot, reinterpret or cast the string, or add side storage.`;
  }
  return undefined;
}

function getSkeleton2DSlotAnimationTargetMixedAbsencePropertyMessage(
  node: ts.PropertySignature,
  subject: string,
): string | undefined {
  if (
    !ts.isInterfaceDeclaration(node.parent) ||
    node.parent.name.text !== 'Skeleton2DSlotAnimationTarget' ||
    !isFlightTypesSource(node, 'Skeleton2DSlotAnimationTarget.ts') ||
    getNodeName(node.name) !== 'attachments' ||
    !isOptionalNullableReadonlyNullableNamedArrayProperty(node, 'Attachment2D')
  ) {
    return undefined;
  }
  return `${subject} gives the live slot-animation target's attachment lookup table both omission and explicit null, but every library construction path materializes the field and has one no-table state. createSkeleton2DSlotAnimationTarget defaults attachments to null and delegates to initializeSkeleton2DSlotAnimationTarget, which always assigns the exact argument; colour targets therefore store null, while attachment targets produced by all three format importers receive a present table. The Spine JSON and binary importers resolve names once against the setup skin, deduplicate exact Attachment2D owners, and encode a missing name or unresolved attachment as track index -1 rather than as an absent table. DragonBones preserves its positional display list, including null holes for unsupported displays, then gives each target a sliced table and maps a negative, out-of-range, or null display index to -1. cloneAnimationClip deep-copies each numeric track but reuses the exact opaque targetRef, so it also shares the target and table; no production path later replaces, clears, or mutates attachments. bindSkeleton2DSlotAttachment returns for either undefined or null without changing the current slot. With a present table and a nonempty track, however, a sampled -1 or out-of-range index, an empty table, or an in-range null entry writes null to slot.attachment, while an in-range owner installs that exact attachment. Make Skeleton2DSlotAnimationTarget.attachments a required readonly (Attachment2D | null)[] | null field, retain null as the sole no-table and inert-channel sentinel, and preserve the exact supplied table in the initializer and through clip cloning. A present empty table and every positional null entry remain present lookup data that can clear a sampled slot; they must not be normalized to null, filtered, reindexed, or replaced with another table. If a structural or compatibility input permits omission, give it a separate shape and normalize once to null before constructing the live target; if no table and an explicit disabled channel must differ, replace them with one named closed state and handle every arm. Do not whitelist the redundant live-storage spelling. The C++ backend can already preserve the current null, undefined, exact readonly-array, and nullable-element alternatives; that representation support does not choose the source contract's redundant no-table sentinel. The compiler will not choose or collapse an absence sentinel, infer or resolve an attachment, synthesize or clear a slot value, change Step sampling or setup-skin resolution, allocate, copy, filter, reindex, or mutate the table, clone or materialize an Attachment2D owner, route elements through Any, reinterpret or cast the table, or add side storage.`;
}

function getMeshGeometryOptionsMixedAbsencePropertyMessage(
  node: ts.PropertySignature,
  subject: string,
): string | undefined {
  if (
    !ts.isInterfaceDeclaration(node.parent) ||
    node.parent.name.text !== 'MeshGeometryOptions' ||
    getNodeName(node.name) !== 'indices' ||
    !isFlightTypesSource(node, 'MeshGeometryOptions.ts') ||
    !isOptionalNullableReadonlyArrayBufferViewUnionProperty(node, ['Uint16Array', 'Uint32Array'])
  ) {
    return undefined;
  }
  return `${subject} gives createMeshGeometry's construction-only index input both omission and explicit null, but the factory tests options.indices by truthiness and initializes the required MeshGeometry.indices field to null when no index collection is supplied. A present Uint16Array or Uint32Array, including an empty typed array, enters promoteIndices and is copied into a fresh typed array of the authored or vertex-count-required width; omission, explicit undefined, and null all produce the same non-indexed geometry instead. Production callers either omit indices, pass undefined after normalizing a nullable stored field, or pass a present typed array; no construction caller uses explicit null to request a distinct operation. Make MeshGeometryOptions.indices optional Readonly<Uint16Array<ArrayBuffer>> | Readonly<Uint32Array<ArrayBuffer>> without null, while keeping MeshGeometry.indices required nullable because mesh index operations and GL and WebGPU uploads use null as the live sequential/non-indexed state and later mutators may install or clear an index buffer. Preserve createMeshGeometry's authored promotion and copy, including the present-empty-array case. If an external compatibility boundary accepts explicit null, normalize it once to omission before calling createMeshGeometry; if a future update API must distinguish unchanged, cleared, and supplied indices, give it a separate named closed update state. Do not whitelist the redundant construction spelling. The compiler will preserve every authored state and typed-array element domain but will not choose or collapse an absence sentinel, infer an index buffer, substitute an empty collection, merge the Uint16Array and Uint32Array owners, allocate or copy backing storage beyond the authored promoteIndices path, route elements through Any, reinterpret or cast a collection, or add side storage.`;
}

function getMeshGeometryFromAttributesOptionsMixedAbsencePropertyMessage(
  node: ts.PropertySignature,
  subject: string,
): string | undefined {
  if (
    !ts.isInterfaceDeclaration(node.parent) ||
    node.parent.name.text !== 'MeshGeometryFromAttributesOptions' ||
    !isFlightTypesSource(node, 'MeshGeometryFromAttributesOptions.ts')
  ) {
    return undefined;
  }
  const field = getNodeName(node.name);
  const isIndices =
    field === 'indices' &&
    isOptionalNullableNamedAndReadonlyNumberArrayUnionProperty(node, ['Uint16Array', 'Uint32Array']);
  const isAttribute = (field === 'normals' || field === 'uvs') && isOptionalNullableReadonlyNumberArrayProperty(node);
  if (!isIndices && !isAttribute) return undefined;
  const effect = isIndices
    ? 'For indices, a present readonly array, Uint16Array, or Uint32Array is copied element by element into a fresh Uint16Array or Uint32Array selected from the vertex count; absence leaves the local indexArray undefined, and createMeshGeometry then normalizes that construction input into the required-null MeshGeometry.indices storage slot for non-indexed geometry.'
    : field === 'normals'
      ? 'For normals, a present readonly array is copied into the canonical normal channels, while absence leaves those channels for computeMeshGeometryNormals to derive from the faces.'
      : 'For uvs, a present readonly array is copied into the canonical UV channels, while absence leaves their freshly allocated Float32Array cells at zero before tangent computation.';
  return `${subject} gives the construction-only mesh attribute input ${field} both omission and explicit null, but createMeshGeometryFromAttributes has one not-supplied state. It is the sole production consumer: it normalizes normals and uvs with ?? null and tests indices by truthiness, so null and undefined take the same path. ${effect} Repository call sites either omit each optional field or supply its collection; this fresh-geometry factory has no update or clear operation for explicit null to express. Make indices optional readonly number[] | Uint16Array | Uint32Array and make normals and uvs optional readonly number[], removing null from all three input fields while retaining positions as required. Preserve the current owner-specific reads and authored copy or computation paths, and keep MeshGeometry.indices required nullable at the stored geometry boundary. Do not replace an absent field with an empty collection: an empty present collection still enters the supplied-data path and is not the same input. If a compatibility boundary must accept explicit null, normalize it once into this optional non-null construction shape before calling the factory; if omission and an intentional clear later become distinct, introduce a separate named closed update contract. Do not whitelist the redundant construction spelling. The compiler will preserve every authored state and collection owner but will not choose or collapse an absence sentinel, infer generated normals or zero UVs, substitute an empty collection, merge the array and typed-array owners, allocate or copy backing storage beyond the authored factory, route elements through Any, reinterpret or cast a collection, or add side storage.`;
}

function getAttachmentPointStorageMixedAbsencePropertyMessage(
  node: ts.PropertySignature,
  subject: string,
): string | undefined {
  if (!ts.isInterfaceDeclaration(node.parent) || !interfaceExtendsType(node.parent, 'Attachment2D')) {
    return undefined;
  }
  const field = getNodeName(node.name);
  if (field !== 'skin' && field !== 'vertices') return undefined;
  const skin = getInterfaceProperty(node.parent, 'skin');
  const vertices = getInterfaceProperty(node.parent, 'vertices');
  if (
    !isOptionalNullableNamedTypeProperty(skin, 'Skin2D') ||
    !isOptionalNullableNamedTypeProperty(vertices, 'Float32Array')
  ) {
    return undefined;
  }
  return `${subject} makes ${field} one optional-null half of the attachment's paired point storage. The represented contract has two present owners: Skin2D influences in weighted mode or a Float32Array of local points in rigid mode; rejected or empty input may carry neither. Import initializers assign both fields, and skinSkeleton2DAttachmentPoints treats undefined exactly like null before selecting the existing owner. Make both skin and vertices required nullable fields on each concrete Attachment2D and initialize both on every construction path, preserving the exact Skin2D and Float32Array owners. If callers must distinguish not initialized from weighted, rigid, or unavailable storage, replace the independent fields with a named closed state whose arms carry those owners explicitly. The compiler will not infer a mode from whichever optional field happened to be written, choose or collapse an absence sentinel, reconstruct points from influences, allocate or copy either owner, route elements through Any, reinterpret or cast storage, or add side storage.`;
}

function getBoundingBoxAttachment2DMixedAbsencePropertyMessage(
  node: ts.PropertySignature,
  subject: string,
): string | undefined {
  if (
    !ts.isInterfaceDeclaration(node.parent) ||
    node.parent.name.text !== 'BoundingBoxAttachment2D' ||
    !interfaceExtendsType(node.parent, 'Attachment2D') ||
    !isFlightTypesSource(node, 'BoundingBoxAttachment2D.ts')
  ) {
    return undefined;
  }
  const field = getNodeName(node.name);
  if (field !== 'skin' && field !== 'vertices') return undefined;
  const skin = getInterfaceProperty(node.parent, 'skin');
  const vertices = getInterfaceProperty(node.parent, 'vertices');
  if (
    !isOptionalNullableNamedTypeProperty(skin, 'Skin2D') ||
    !isOptionalNullableNamedTypeProperty(vertices, 'Float32Array')
  ) {
    return undefined;
  }
  return `${subject} gives BoundingBoxAttachment2D.${field} both omission and explicit null, but the bounding-box point contract gives those spellings one absence meaning. Current format parsers do not construct BoundingBoxAttachment2D: Spine JSON reports the attachment unsupported and returns null, Spine binary consumes and skips its vertex payload before returning null, and DragonBones reports any non-image, non-mesh display unsupported. The repository's only concrete constructor, a focused test helper, assigns both fields: skin null with a Float32Array for rigid points, a Skin2D with vertices null for weighted points, and null for both on an empty box. computeSkeleton2DBoundingBoxAttachmentVertices passes the pair unchanged to skinSkeleton2DAttachmentPoints: a present skin selects weighted deformation and ignores vertices; otherwise present vertices select rigid deformation, while null and undefined vertices both cause no coordinate writes and leave the caller's output unchanged. explainSkeleton2DDeformLength uses the same weighted-first dispatch and treats nullish vertices as zero addressed offsets. Make BoundingBoxAttachment2D.skin a required Skin2D | null field and BoundingBoxAttachment2D.vertices a required Float32Array | null field, initialize both on every future construction path, and keep unsupported import paths returning null rather than synthesizing an attachment. If external structural inputs must allow omission, give them a separate shape and normalize once before constructing the stored box. If weighted, rigid, empty, and not-yet-initialized must become distinct, replace the pair with one named closed storage state and handle every arm explicitly. Do not whitelist either redundant absence spelling. The compiler will not choose or collapse an absence sentinel, begin importing an unsupported attachment, decode skipped vertices, infer or change the deformation mode, fabricate a Skin2D or vertex buffer, resize or clear the output, rewrite pointCount, allocate or copy either owner, route elements through Any, reinterpret or cast storage, or add side storage.`;
}

function getClippingAttachment2DMixedAbsencePropertyMessage(
  node: ts.PropertySignature,
  subject: string,
): string | undefined {
  if (
    !ts.isInterfaceDeclaration(node.parent) ||
    node.parent.name.text !== 'ClippingAttachment2D' ||
    !interfaceExtendsType(node.parent, 'Attachment2D') ||
    !isFlightTypesSource(node, 'ClippingAttachment2D.ts')
  ) {
    return undefined;
  }
  const field = getNodeName(node.name);
  if (field !== 'skin' && field !== 'vertices') return undefined;
  const skin = getInterfaceProperty(node.parent, 'skin');
  const vertices = getInterfaceProperty(node.parent, 'vertices');
  if (
    !isOptionalNullableNamedTypeProperty(skin, 'Skin2D') ||
    !isOptionalNullableNamedTypeProperty(vertices, 'Float32Array')
  ) {
    return undefined;
  }
  return `${subject} gives ClippingAttachment2D.${field} both omission and explicit null, but the clipping-polygon point contract gives those spellings one absence meaning. Current format parsers do not construct ClippingAttachment2D: Spine JSON reports the attachment unsupported and returns null, Spine binary consumes its end-slot and vertex payload before returning null, and DragonBones reports any non-image, non-mesh display unsupported. The repository's only concrete constructor, a focused test helper, assigns skin null and always writes vertices, using a Float32Array for a rigid polygon or null for an empty clip; no current producer builds a weighted clip. computeSkeleton2DClippingAttachmentVertices passes the pair unchanged to skinSkeleton2DAttachmentPoints: a present skin would select weighted deformation and ignore vertices; otherwise present vertices select rigid deformation, while null and undefined vertices both cause no coordinate writes and leave the caller's output unchanged. getSkeleton2DClippingAttachmentSlotRange reads only endSlotIndex and never observes either point-storage absence spelling. explainSkeleton2DDeformLength uses the same weighted-first point dispatch and treats nullish vertices as zero addressed offsets. Make ClippingAttachment2D.skin a required Skin2D | null field and ClippingAttachment2D.vertices a required Float32Array | null field, initialize both on every future construction path, and keep unsupported import paths returning null rather than synthesizing an attachment. If external structural inputs must allow omission, give them a separate shape and normalize once before constructing the stored clip. If weighted, rigid, empty, and not-yet-initialized must become distinct, replace the pair with one named closed storage state and handle every arm explicitly. Do not whitelist either redundant absence spelling. The compiler will not choose or collapse an absence sentinel, begin importing an unsupported attachment, decode skipped vertices, infer or change the deformation mode, fabricate a Skin2D or vertex buffer, apply a clip or build a ClipRegion, consult or rewrite endSlotIndex, resize or clear the output, rewrite pointCount, allocate or copy either owner, route elements through Any, reinterpret or cast storage, or add side storage.`;
}

function getMeshAttachment2DMixedAbsencePropertyMessage(
  node: ts.PropertySignature,
  subject: string,
): string | undefined {
  if (
    !ts.isInterfaceDeclaration(node.parent) ||
    node.parent.name.text !== 'MeshAttachment2D' ||
    !interfaceExtendsType(node.parent, 'Attachment2D') ||
    !isFlightTypesSource(node, 'MeshAttachment2D.ts')
  ) {
    return undefined;
  }
  const field = getNodeName(node.name);
  if (field !== 'skin' && field !== 'vertices') return undefined;
  const skin = getInterfaceProperty(node.parent, 'skin');
  const vertices = getInterfaceProperty(node.parent, 'vertices');
  if (
    !isOptionalNullableNamedTypeProperty(skin, 'Skin2D') ||
    !isOptionalNullableNamedTypeProperty(vertices, 'Float32Array')
  ) {
    return undefined;
  }
  return `${subject} gives MeshAttachment2D.${field} both omission and explicit null, but imported mesh records give those spellings one absence meaning. The Spine JSON, Spine binary, and DragonBones mesh paths all call initializeMeshAttachment2D, which writes both fields: rigid meshes use skin null with a Float32Array of local vertices, weighted meshes use a Skin2D with vertices null, and rejected empty Spine binary meshes use null for both. deformSkeleton2DMeshAttachment passes the pair unchanged to skinSkeleton2DAttachmentPoints: a present skin selects weighted deformation and ignores vertices; otherwise present vertices select rigid deformation, while null and undefined vertices both cause no coordinate writes. explainSkeleton2DDeformLength uses the same weighted-first dispatch and treats nullish vertices as zero addressed offsets. Make MeshAttachment2D.skin a required Skin2D | null field and MeshAttachment2D.vertices a required Float32Array | null field, retain both assignments in every importer and constructor, and preserve the rejected-empty null pair. If external structural inputs must allow omission, give them a separate shape and normalize once before constructing the stored mesh. If weighted, rigid, rejected-empty, and not-yet-initialized must become distinct, replace the pair with one named closed storage state and handle every arm explicitly. Do not whitelist either redundant absence spelling. The compiler will not choose or collapse an absence sentinel, infer or change the deformation mode, fabricate a Skin2D or vertex buffer, recover rejected mesh data, rewrite triangles, uvs, or vertexCount, allocate or copy either owner, route elements through Any, reinterpret or cast storage, or add side storage.`;
}

function getPathAttachment2DMixedAbsencePropertyMessage(
  node: ts.PropertySignature,
  subject: string,
): string | undefined {
  if (
    !ts.isInterfaceDeclaration(node.parent) ||
    node.parent.name.text !== 'PathAttachment2D' ||
    !interfaceExtendsType(node.parent, 'Attachment2D') ||
    !isFlightTypesSource(node, 'PathAttachment2D.ts')
  ) {
    return undefined;
  }
  const field = getNodeName(node.name);
  if (field !== 'skin' && field !== 'vertices') return undefined;
  const skin = getInterfaceProperty(node.parent, 'skin');
  const vertices = getInterfaceProperty(node.parent, 'vertices');
  if (
    !isOptionalNullableNamedTypeProperty(skin, 'Skin2D') ||
    !isOptionalNullableNamedTypeProperty(vertices, 'Float32Array')
  ) {
    return undefined;
  }
  return `${subject} gives PathAttachment2D.${field} both omission and explicit null, but the path deformation contract gives those spellings one absence meaning at this storage boundary. deformSkeleton2DPathAttachment passes skin and vertices unchanged to skinSkeleton2DAttachmentPoints: a present Skin2D selects weighted deformation and ignores vertices; otherwise a present Float32Array supplies rigid local points, while a nullish vertices value causes no coordinate writes. explainSkeleton2DDeformLength makes the same dispatch and treats null and undefined vertices as zero addressed offsets. Current production code has no PathAttachment2D constructor or importer; every concrete repository test constructor assigns both fields, including null for the inactive owner and for an empty rigid path. Make PathAttachment2D.skin a required Skin2D | null field and PathAttachment2D.vertices a required Float32Array | null field, initialize both on every future construction path, and retain the current weighted-first dispatch. If weighted, rigid, empty, and not-yet-initialized must become distinct, replace the pair with one named closed storage state and handle every arm explicitly. Do not whitelist either redundant absence spelling. The compiler will not choose or collapse an absence sentinel, infer or change the deformation mode, fabricate a Skin2D or vertex buffer, rewrite commands or pointCount, allocate or copy either owner, route elements through Any, reinterpret or cast storage, or add side storage.`;
}

function interfaceExtendsType(node: ts.InterfaceDeclaration, name: string): boolean {
  return (
    node.heritageClauses?.some(
      (clause) =>
        clause.token === ts.SyntaxKind.ExtendsKeyword &&
        clause.types.some((type) => getNodeName(type.expression) === name),
    ) ?? false
  );
}

function getInterfaceProperty(node: ts.InterfaceDeclaration, name: string): ts.PropertySignature | undefined {
  return node.members.find(
    (member): member is ts.PropertySignature => ts.isPropertySignature(member) && getNodeName(member.name) === name,
  );
}

function isOptionalNullableNamedTypeProperty(node: ts.PropertySignature | undefined, name: string): boolean {
  if (!node?.type || node.questionToken === undefined || !hasNullType(node.type)) return false;
  const present = getMixedAbsencePresentTypes(node.type);
  if (present.length !== 1) return false;
  let type = present[0]!;
  while (ts.isParenthesizedTypeNode(type)) type = type.type;
  return ts.isTypeReferenceNode(type) && getNodeName(type.typeName) === name;
}

function isOptionalNullableExactNamedTypeProperty(node: ts.PropertySignature, name: string): boolean {
  if (!node.type || node.questionToken === undefined || !hasNullType(node.type)) return false;
  const present = getMixedAbsencePresentTypes(node.type);
  if (present.length !== 1) return false;
  let type = present[0]!;
  while (ts.isParenthesizedTypeNode(type)) type = type.type;
  return ts.isTypeReferenceNode(type) && type.typeArguments === undefined && getNodeName(type.typeName) === name;
}

function isOptionalNullableNamedArrayProperty(node: ts.PropertySignature, name: string): boolean {
  if (!node.type || node.questionToken === undefined || !hasNullType(node.type)) return false;
  const present = getMixedAbsencePresentTypes(node.type);
  if (present.length !== 1) return false;
  let type = present[0]!;
  while (ts.isParenthesizedTypeNode(type)) type = type.type;
  if (!ts.isArrayTypeNode(type)) return false;
  let element = type.elementType;
  while (ts.isParenthesizedTypeNode(element)) element = element.type;
  return (
    ts.isTypeReferenceNode(element) && element.typeArguments === undefined && getNodeName(element.typeName) === name
  );
}

function isOptionalNullableNumberProperty(node: ts.PropertySignature): boolean {
  if (!node.type || node.questionToken === undefined || !hasNullType(node.type)) return false;
  const present = getMixedAbsencePresentTypes(node.type);
  if (present.length !== 1) return false;
  let type = present[0]!;
  while (ts.isParenthesizedTypeNode(type)) type = type.type;
  return type.kind === ts.SyntaxKind.NumberKeyword;
}

function isOptionalNullableFunctionProperty(node: ts.PropertySignature): boolean {
  if (!node.type || node.questionToken === undefined || !hasNullType(node.type)) return false;
  const present = getMixedAbsencePresentTypes(node.type);
  if (present.length !== 1) return false;
  let type = present[0]!;
  while (ts.isParenthesizedTypeNode(type)) type = type.type;
  return ts.isFunctionTypeNode(type);
}

function isOptionalNullableReadonlyNumberArrayProperty(node: ts.PropertySignature): boolean {
  if (!node.type || node.questionToken === undefined || !hasNullType(node.type)) return false;
  const present = getMixedAbsencePresentTypes(node.type);
  if (present.length !== 1) return false;
  let type = present[0]!;
  while (ts.isParenthesizedTypeNode(type)) type = type.type;
  return (
    ts.isTypeOperatorNode(type) &&
    type.operator === ts.SyntaxKind.ReadonlyKeyword &&
    ts.isArrayTypeNode(type.type) &&
    type.type.elementType.kind === ts.SyntaxKind.NumberKeyword
  );
}

function isOptionalNullableReadonlyStringArrayProperty(node: ts.PropertySignature): boolean {
  if (!node.type || node.questionToken === undefined || !hasNullType(node.type)) return false;
  const present = getMixedAbsencePresentTypes(node.type);
  if (present.length !== 1) return false;
  let type = present[0]!;
  while (ts.isParenthesizedTypeNode(type)) type = type.type;
  return (
    ts.isTypeOperatorNode(type) &&
    type.operator === ts.SyntaxKind.ReadonlyKeyword &&
    ts.isArrayTypeNode(type.type) &&
    type.type.elementType.kind === ts.SyntaxKind.StringKeyword
  );
}

function isOptionalNullableReadonlyNullableNamedArrayProperty(node: ts.PropertySignature, name: string): boolean {
  if (!node.type || node.questionToken === undefined || !hasNullType(node.type)) return false;
  const present = getMixedAbsencePresentTypes(node.type);
  if (present.length !== 1) return false;
  let type = present[0]!;
  while (ts.isParenthesizedTypeNode(type)) type = type.type;
  if (
    !ts.isTypeOperatorNode(type) ||
    type.operator !== ts.SyntaxKind.ReadonlyKeyword ||
    !ts.isArrayTypeNode(type.type)
  ) {
    return false;
  }
  let element = type.type.elementType;
  while (ts.isParenthesizedTypeNode(element)) element = element.type;
  if (!ts.isUnionTypeNode(element) || !hasNullType(element)) return false;
  const elementPresent = getMixedAbsencePresentTypes(element);
  if (elementPresent.length !== 1) return false;
  let owner = elementPresent[0]!;
  while (ts.isParenthesizedTypeNode(owner)) owner = owner.type;
  return ts.isTypeReferenceNode(owner) && owner.typeArguments === undefined && getNodeName(owner.typeName) === name;
}

function isOptionalNullableNamedAndReadonlyNumberArrayUnionProperty(
  node: ts.PropertySignature,
  expectedNames: readonly string[],
): boolean {
  if (!node.type || node.questionToken === undefined || !hasNullType(node.type)) return false;
  const present = getMixedAbsencePresentTypes(node.type);
  if (present.length !== expectedNames.length + 1) return false;
  const names = new Set<string>();
  let hasReadonlyNumberArray = false;
  for (let type of present) {
    while (ts.isParenthesizedTypeNode(type)) type = type.type;
    if (ts.isTypeReferenceNode(type) && type.typeArguments === undefined) {
      const name = getNodeName(type.typeName);
      if (name === undefined || names.has(name)) return false;
      names.add(name);
      continue;
    }
    if (
      ts.isTypeOperatorNode(type) &&
      type.operator === ts.SyntaxKind.ReadonlyKeyword &&
      ts.isArrayTypeNode(type.type) &&
      type.type.elementType.kind === ts.SyntaxKind.NumberKeyword &&
      !hasReadonlyNumberArray
    ) {
      hasReadonlyNumberArray = true;
      continue;
    }
    return false;
  }
  return (
    hasReadonlyNumberArray && names.size === expectedNames.length && expectedNames.every((name) => names.has(name))
  );
}

function isOptionalNullableReadonlyArrayBufferViewUnionProperty(
  node: ts.PropertySignature,
  expectedNames: readonly string[],
): boolean {
  if (!node.type || node.questionToken === undefined || !hasNullType(node.type)) return false;
  const present = getMixedAbsencePresentTypes(node.type);
  if (present.length !== expectedNames.length) return false;
  const names = new Set<string>();
  for (let type of present) {
    while (ts.isParenthesizedTypeNode(type)) type = type.type;
    if (
      !ts.isTypeReferenceNode(type) ||
      getNodeName(type.typeName) !== 'Readonly' ||
      type.typeArguments?.length !== 1
    ) {
      return false;
    }
    let view = type.typeArguments[0]!;
    while (ts.isParenthesizedTypeNode(view)) view = view.type;
    if (!ts.isTypeReferenceNode(view) || view.typeArguments?.length !== 1) return false;
    const name = getNodeName(view.typeName);
    if (name === undefined || names.has(name)) return false;
    let buffer = view.typeArguments[0]!;
    while (ts.isParenthesizedTypeNode(buffer)) buffer = buffer.type;
    if (
      !ts.isTypeReferenceNode(buffer) ||
      buffer.typeArguments !== undefined ||
      getNodeName(buffer.typeName) !== 'ArrayBuffer'
    ) {
      return false;
    }
    names.add(name);
  }
  return names.size === expectedNames.length && expectedNames.every((name) => names.has(name));
}

function isOptionalNullableObjectWeakMapProperty(node: ts.PropertySignature): boolean {
  if (!node.type || node.questionToken === undefined || !hasNullType(node.type)) return false;
  const present = getMixedAbsencePresentTypes(node.type);
  if (present.length !== 1) return false;
  let type = present[0]!;
  while (ts.isParenthesizedTypeNode(type)) type = type.type;
  return (
    ts.isTypeReferenceNode(type) &&
    getNodeName(type.typeName) === 'WeakMap' &&
    type.typeArguments?.length === 2 &&
    type.typeArguments.every((argument) => argument.kind === ts.SyntaxKind.ObjectKeyword)
  );
}

function isOptionalNullableReadonlyNamedTypeProperty(node: ts.PropertySignature, name: string): boolean {
  if (!node.type || node.questionToken === undefined || !hasNullType(node.type)) return false;
  const present = getMixedAbsencePresentTypes(node.type);
  if (present.length !== 1) return false;
  let type = present[0]!;
  while (ts.isParenthesizedTypeNode(type)) type = type.type;
  if (!ts.isTypeReferenceNode(type) || getNodeName(type.typeName) !== 'Readonly') return false;
  const argument = type.typeArguments?.[0];
  return (
    type.typeArguments?.length === 1 &&
    argument !== undefined &&
    ts.isTypeReferenceNode(argument) &&
    getNodeName(argument.typeName) === name
  );
}

function isOptionalNullableStringProperty(node: ts.PropertySignature): boolean {
  if (!node.type || node.questionToken === undefined || !hasNullType(node.type)) return false;
  const present = getMixedAbsencePresentTypes(node.type);
  if (present.length !== 1) return false;
  let type = present[0]!;
  while (ts.isParenthesizedTypeNode(type)) type = type.type;
  return type.kind === ts.SyntaxKind.StringKeyword;
}

function isRequiredNullableUndefinedNumberProperty(node: ts.PropertySignature): boolean {
  if (!node.type || node.questionToken !== undefined || !hasNullType(node.type) || !hasUndefinedType(node.type)) {
    return false;
  }
  const present = getMixedAbsencePresentTypes(node.type);
  if (present.length !== 1) return false;
  let type = present[0]!;
  while (ts.isParenthesizedTypeNode(type)) type = type.type;
  return type.kind === ts.SyntaxKind.NumberKeyword;
}

function getAuthoredNameMixedAbsencePropertyMessage(node: ts.PropertySignature, subject: string): string | undefined {
  if (
    !ts.isInterfaceDeclaration(node.parent) ||
    getNodeName(node.name) !== 'name' ||
    !isOptionalNullableStringProperty(node)
  ) {
    return undefined;
  }
  const owner = node.parent.name.text;
  if (owner === 'Attachment2D' && isFlightTypesSource(node, 'Attachment2D.ts')) {
    return `${subject} gives the open Attachment2D family's authored-name metadata both omission and explicit null, but current Flight has one unnamed attachment state. Spine JSON passes each supported region or mesh attachment's string skin-entry key to its concrete initializer; Spine binary stores its optional name reference ?? the skin-entry key and therefore passes string | null; DragonBones normalizes a non-string display.name to null. Every built-in RegionAttachment2D and MeshAttachment2D initializer assigns out.name. No production consumer reads Attachment2D.name: Spine setup and animation lookup use the separate SkinAttachment2D.name plus slotIndex, DragonBones animation uses positional display tables, and deformation and rendering dispatch on kind and concrete data. cloneSkeleton2D shares the exact attachment owners through skins and slots rather than cloning or rewriting their name cells. Make Attachment2D.name a required string | null field, preserve every imported string, initialize null for unnamed built-in and custom concrete attachments, and keep the open kind family unchanged. If external structural inputs must allow omission, give them a separate shape and normalize once before constructing the live attachment. If omitted, unnamed, and named metadata must differ in a future contract, replace the two absence spellings with one named closed state and handle every arm explicitly. Do not whitelist the redundant live-storage spelling. The compiler will preserve every authored string and attachment owner but will not choose or collapse an absence sentinel, infer a name from the skin-entry key, slot, kind, atlas path, or display position, rewrite setup or animation lookup, clone or materialize an attachment, route the name through Any, reinterpret or cast the string, or add side storage.`;
  }
  if (owner === 'Material' && isFlightTypesSource(node, 'Material.ts')) {
    return `${subject} gives the live Material authored-name cell both omission and explicit null, but sanctioned construction has one anonymous state and always materializes the cell. createMaterial calls initializeMaterial, which assigns name = null, and createSurfaceMaterial plus every built-in surface-material constructor delegate to that path. materializeDocumentMaterial either retains an importer-created Material entity or overlays a structural MaterialLike onto createMaterial(source.kind), so an omitted convenience-input name still becomes null on the live owner. Importers then replace that cell with exact source metadata: glTF uses material.name ?? null; AWD and 3DS normalize an empty name to null; OBJ, MD2, and MD5 assign their authored handles; and glTF promotion handlers copy the exact prior string or null. cloneMaterial and copyMaterial copy the enumerable name cell without transformation, while equalsMaterial compares own-key sets and exact values; keeping the cell required ensures copyMaterial writes null instead of leaving a stale destination name and makes every live clone structurally comparable. findScene3DMaterialByName is the only semantic name lookup and matches only an exact present string; renderers and reference-identity batching do not inspect the metadata. Make Material.name a required string | null field and keep initializeMaterial's null assignment. If MaterialLike structural literals must omit the name, give that convenience input a separate optional-non-null shape and continue normalizing it through createMaterial before it becomes a live Material. Do not whitelist the redundant missing-cell spelling: representation support does not make an absent own key equal to an explicit null cell under Object.keys. If omitted, anonymous, and named must become distinct live states, replace the two absence spellings with one named closed state and update clone, copy, equality, import, and lookup together. The compiler will preserve every authored string, null, and Material owner but will not choose or collapse an absence sentinel, infer a name from kind, texture path, or document position, rewrite clone, equality, serialization, lookup, rendering, or batching, copy or materialize a replacement owner, route the name through Any, reinterpret or cast the string, or add side storage.`;
  }
  if (owner !== 'Bone2D' || !isFlightTypesSource(node, 'Bone2D.ts')) return undefined;
  return `${subject} gives the live Bone2D authored-name cell both omission and explicit null, but no production path gives a missing live cell distinct behavior and every built-in producer materializes it. Spine JSON normalizes a non-string raw name to null and its malformed-entry placeholder explicitly stores null; Spine binary stores the string | null returned by readSpineBinaryString; and DragonBones normalizes a non-string name to null on every retained bone. Rive instead stores readRiveText's '' fallback, which is a present string rather than another absence spelling and must remain distinct. createSkeleton2D accepts and retains the exact caller-owned Bone2D array without cloning or normalizing its records. cloneSkeleton2D allocates a fresh record with object spread for every bone, preserving the exact name value and also preserving a structurally supplied missing cell; no production mutator later assigns, clears, or deletes name. resetSkeleton2DToSetup copies only animated transform fields, and disposeSkeleton2D drops the entire bone array rather than clearing individual names. Spine parent, slot, and animation resolution compare exact strings; DragonBones inserts only string names into its parent, slot, and animation lookup maps; and getSkeleton2DBoneIndexByName returns the first exact string match or -1. Null and undefined are therefore equally unmatchable, while '' remains a queryable present name and duplicate-name resolution keeps each consumer's existing order. After import, animation targets, slots, skinning, constraints, pose propagation, and rendering address bones by index and never read name; equalsSkeleton2D likewise compares transform and hierarchy data but deliberately ignores name metadata. Make Bone2D.name a required string | null field and keep every importer, placeholder, and live test builder's explicit assignment, including Rive's present empty string. Preserve createSkeleton2D's exact-array retention and the clone's fresh-record behavior. If a convenience or compatibility input must allow omission, give it a separate optional non-null name?: string shape and normalize once to name ?? null while constructing Bone2D records before calling createSkeleton2D; do not silently mutate or copy the live array at that boundary. If omitted, unnamed, and named must differ in a future live contract, replace them with one named closed state and update import, clone, and every lookup together. Do not whitelist the redundant live-storage spelling. The C++ backend can preserve the current null, undefined, and string alternatives and the required-nullable rewrite; that representation support does not choose the source contract's redundant missing-cell sentinel. The compiler will not choose or collapse an absence sentinel, normalize a present empty string, infer a name from hierarchy or position, change duplicate-name or first-match behavior, rewrite importer or runtime lookup, make equality name-sensitive, mutate caller-owned bones, allocate or copy the live bone array, clone or materialize a bone beyond the authored clone, route the name through Any, reinterpret or cast the string, or add side storage.`;
}

function getBitmapTextOptionsMixedAbsencePropertyMessage(
  node: ts.PropertySignature,
  subject: string,
): string | undefined {
  const name = getNodeName(node.name);
  if (
    ts.isInterfaceDeclaration(node.parent) &&
    node.parent.name.text === 'BitmapTextOptions' &&
    normalizePathPortable(node.getSourceFile().fileName).endsWith('/packages/types/src/BitmapText.ts') &&
    isOptionalNullableNumberProperty(node) &&
    (name === 'maxLines' || name === 'wrapWidth')
  ) {
    return `${subject} gives the construction-only BitmapText option ${name} both omission and explicit null, but BitmapTextOptions has one production consumer and one not-supplied meaning. createBitmapText allocates fresh BitmapTextData through createBitmapTextData and initializeBitmapTextData, which materialize required maxLines and wrapWidth cells as null; applyBitmapTextOptions then overwrites each cell only when its option is not undefined, so omission retains null and explicit null writes the same disabled value. Later mutation does not reuse BitmapTextOptions: setBitmapTextMaxLines and setBitmapTextWrapWidth accept number | null and assign the required nullable live cells directly. updateBitmapText's layoutBitmapTextLines treats null maxLines as unlimited and null wrapWidth as no word wrapping; appendEllipsis trims the last visible line only against a present wrapWidth; and layoutBitmapTextPages uses a present wrapWidth as the alignment reference and requires it for justification. Make maxLines and wrapWidth optional number fields in BitmapTextOptions, using omission as their sole construction-time absence, while keeping BitmapTextData and both dedicated setters required nullable so callers can disable an installed limit or width. Zero remains a present limit or width and must not become a default or absence sentinel. If an external compatibility boundary accepts explicit null, keep that boundary shape separate and normalize it once before createBitmapText; if a future patch input must distinguish unchanged, disabled, and numeric values, give it a separate named closed update state and handle every arm. Do not whitelist the redundant construction spelling. The compiler will preserve every authored number and live null but will not choose or collapse an absence sentinel, infer or clamp a numeric value, rewrite existing BitmapTextData, call a setter, re-layout text, change wrapping, truncation, ellipsis, alignment, or justification, or add side storage.`;
  }
  return undefined;
}

function getCapacitorPositionCoordsMixedAbsencePropertyMessage(
  node: ts.PropertySignature,
  subject: string,
): string | undefined {
  if (
    !ts.isInterfaceDeclaration(node.parent) ||
    node.parent.name.text !== 'CapacitorPositionCoords' ||
    getNodeName(node.name) !== 'altitudeAccuracy' ||
    !isFlightTypesSource(node, 'CapacitorApi.ts') ||
    !isRequiredNullableUndefinedNumberProperty(node)
  ) {
    return undefined;
  }
  return `${subject} gives the Capacitor geolocation provider coordinate altitudeAccuracy both explicit null and explicit undefined, but this is a result cell rather than a construction option or update patch. CapacitorApi is the dependency-free structural mirror passed to registerCapacitorBackends; CapacitorGeolocationPlugin.getCurrentPosition and the successful CapacitorGeolocationPlugin.watchPosition callback are the only raw coordinate ingress paths. initializeCapacitorGeolocationBackend routes getCurrentPosition, getCurrentPositionResult, and every non-null watch result through toGeolocationPosition, which evaluates coords.altitudeAccuracy ?? 0 into required numeric GeolocationPosition.altitudeAccuracy; no other production code reads the raw Capacitor coordinate. initializeGeolocationPosition materializes the canonical cell as zero, and the web provider's mapWebPosition applies the same nullish-to-zero normalization, so provider null and undefined already have one unavailable meaning while a present zero remains a real reported accuracy. Make CapacitorPositionCoords.altitudeAccuracy a required number | null field, matching the required-nullable altitude, heading, and speed cells on the same provider result, and keep GeolocationPosition.altitudeAccuracy required numeric. When the official plugin result can carry undefined, aggregate a geolocation wrapper that translates undefined to null in both getCurrentPosition results and watchPosition callbacks before passing CapacitorApi to registerCapacitorBackends; do not cast the plugin or make this required result cell optional. If a raw compatibility boundary must retain both provider sentinels, keep its shape separate and normalize it once before constructing CapacitorPosition, or use a named closed provider state if the two meanings genuinely differ. Do not whitelist the redundant provider spelling. The compiler will preserve every reported number, including zero, but will not choose or collapse an absence sentinel, infer or synthesize an accuracy, select a numeric fallback, wrap a plugin, rewrite current-position or watch delivery, mutate canonical coordinate storage, reinterpret or cast the value, or add side storage.`;
}

function getCreateTextureOptionsResourceMixedAbsencePropertyMessage(
  node: ts.PropertySignature,
  subject: string,
): string | undefined {
  if (
    subject !== 'type:CreateTextureOptions/property:resource' ||
    !isFlightTypesSource(node, 'CreateTextureOptions.ts') ||
    !isOptionalNullableNamedTypeProperty(node, 'ImageResourceReference')
  ) {
    return undefined;
  }
  return `${subject} gives the create-only texture resource subscription both omission and explicit null, but its production ingress has only present-owner and no-owner cases. The scene-format createEmbeddedTextureRef and createExternalTextureRef helpers create or reuse an exact ImageResourceReference and pass it as resource; the glTF texture resolver does the same after rejecting a missing image reference; direct decoded, render, video, and blank texture construction omits resource; and SWF's deliberately late image pairing writes the finished reference's subscriber list instead of using this creation option. createTexture and createTexture2D each pass opts?.resource to attachTextureToResource: the two-dimensional branch returns through createTexture2D so it attaches there exactly once, while the other dimensions reach the shared attachment once. attachTextureToResource uses resource != null to skip both absence spellings and (resource.textures ??= []).push(texture) to normalize a present owner's optional subscriber list before retaining the exact new texture. Texture has no resource field and no later association update or detach operation. Scene 2D loading reads reference.textures and fans one resolved source out to every subscriber; scene 3D discovery iterates resource.textures ?? [], reverse-lookups ownership with includes, and groups those subscribers for resolution and retry. Declare CreateTextureOptions.resource as optional ImageResourceReference without null so omission is the sole no-owner input, while retaining the exact resource when present; requiring ImageResourceReference | null would force unrelated constructors to manufacture null without adding a runtime state. Keep ImageResourceReference.textures as its independently normalized subscriber list, and do not turn this option into persistent Texture storage. If a future update input must distinguish unchanged, detach, and attach, give it a separate named closed association state and handle every arm explicitly. Do not whitelist the redundant creation spelling. The compiler will preserve the exact supplied owner but will not choose or collapse an absence sentinel, attach or detach a texture, infer a resource from its source, allocate or mutate the resource subscriber list, copy or materialize either owner, rewrite dimension dispatch, reinterpret or cast the association, or add side storage.`;
}

function getParseCodecOptionMixedAbsencePropertyMessage(
  node: ts.PropertySignature,
  subject: string,
): string | undefined {
  if (!ts.isInterfaceDeclaration(node.parent)) return undefined;
  const owner = node.parent.name.text;
  const isAwd2 = owner === 'Awd2ParseOptions' && isFlightTypesSource(node, 'Awd2ParseOptions.ts');
  const isSwf = owner === 'SwfParseOptions' && isFlightTypesSource(node, 'SwfParseOptions.ts');
  if (!isAwd2 && !isSwf) return undefined;
  const field = getNodeName(node.name);
  if (field !== 'deflate' && field !== 'lzma') return undefined;
  const deflate = getInterfaceProperty(node.parent, 'deflate');
  const lzma = getInterfaceProperty(node.parent, 'lzma');
  if (
    deflate === undefined ||
    lzma === undefined ||
    !isOptionalNullableReadonlyNamedTypeProperty(deflate, 'HostDecompressDeflateCapability') ||
    !isOptionalNullableReadonlyNamedTypeProperty(lzma, 'HostDecompressLzmaCapability')
  ) {
    return undefined;
  }
  return `${subject} gives the ${isAwd2 ? 'AWD2' : 'SWF'} parser codec capability ${field} both omission and explicit null, but the parser boundaries already normalize both codec inputs exactly once: parseAwd2 calls rehydrateAwd2Body(input, options.deflate ?? null, options.lzma ?? null, diagnostics), while readSwfFile calls uncompressSwfSource(source, options.deflate ?? null, options.lzma ?? null, diagnostics). Each downstream parameter is required Readonly<HostDecompressDeflateCapability> | null or Readonly<HostDecompressLzmaCapability> | null, so either input absence spelling becomes the same unavailable-codec state while a present capability owner passes unchanged and is invoked only for its matching compression kind. Declare deflate?: Readonly<HostDecompressDeflateCapability> and lzma?: Readonly<HostDecompressLzmaCapability> on both Awd2ParseOptions and SwfParseOptions, retain the ?? null normalization at those consuming boundaries, and keep the required-nullable downstream parameters. If omission and an explicit disabled codec must differ, replace the property with one named closed codec-input state and resolve every arm before parsing. The compiler will not choose or collapse an absence sentinel, infer a codec from the file header, invoke a decompressor, report or suppress an unread-input diagnostic, replace or copy a capability owner, route decompressed bytes through Any, reinterpret or cast a capability, or add side storage.`;
}

function getTreeViewControllerInitialSelectionMixedAbsencePropertyMessage(
  node: ts.PropertySignature,
  subject: string,
): string | undefined {
  if (
    !ts.isInterfaceDeclaration(node.parent) ||
    node.parent.name.text !== 'TreeViewControllerOptions' ||
    getNodeName(node.name) !== 'selectedItem' ||
    !isFlightTypesSource(node, 'TreeViewController.ts') ||
    !isOptionalNullableNamedTypeProperty(node, 'TreeViewControllerItem')
  ) {
    return undefined;
  }
  return `${subject} gives the one-shot TreeViewController initial selection both omission and explicit null, but createTreeViewController consumes the options only while building one controller. It first flattens options.items into the runtime items array and parent map, then writes selectedItem: options.selectedItem ?? null into required Readonly<TreeViewControllerItem> | null runtime storage, so both absence spellings create the same unselected state while a present initial item is retained by identity without a membership check or an onSelect emission. The controller entity exposes that state only through its EntityRuntimeKey-owned runtime. getTreeViewControllerSelectedItem returns the exact required nullable cell. setTreeViewControllerSelectedItem is the distinct live update boundary: it accepts Readonly<TreeViewControllerItem> | null, maps a foreign item to null through runtime.parents.has, ignores unchanged or disposed controllers, and otherwise stores the exact member and emits onSelect with that same nullable value. Item clicks select through the setter; ArrowUp/ArrowDown select from the visible flattened items; ArrowRight/ArrowLeft expand, descend, collapse, select a parent, or clear; and Enter emits onActivate only for a present selection. Selection never drives item visibility or styling: expansion state alone feeds updateTreeViewControllerVisibility. disposeTreeViewController clears selectedItem to null while tearing down the runtime and does not emit a final selection change. Make TreeViewControllerOptions.selectedItem an optional TreeViewControllerItem without null so omission is the sole construction-time unselected state; requiring TreeViewControllerItem | null would force every unselected tree to manufacture null without adding a behavior. Keep the runtime field, live setter parameter, getter result, and TreeViewControllerSignals.onSelect payload required nullable so callers can clear and observe live selection. If an external compatibility boundary accepts explicit null, normalize it once to omission before construction. If a future update patch must distinguish unchanged, clear, and select, give it a separate named closed selection state and handle every arm explicitly. Do not whitelist the redundant construction spelling. The compiler will preserve the exact present item and live null but will not choose or collapse an absence sentinel, select or validate an initial item, emit a selection or activation signal, infer an item from roots or visibility, copy or materialize the item owner, rewrite controller disposal, navigation, expansion, or visuals, reinterpret or cast the selection, or add side storage.`;
}

function getInteractionManagerOptionsMixedAbsencePropertyMessage(
  node: ts.PropertySignature,
  subject: string,
): string | undefined {
  if (
    !ts.isInterfaceDeclaration(node.parent) ||
    node.parent.name.text !== 'InteractionManagerOptions' ||
    !normalizePathPortable(node.getSourceFile().fileName).endsWith('/packages/types/src/InteractionManager.ts')
  ) {
    return undefined;
  }
  const name = getNodeName(node.name);
  const owner = name === 'cursorBackend' ? 'CursorBackend' : name === 'spatialIndex' ? 'SpatialIndex2D' : undefined;
  if (owner === undefined || !isOptionalNullableNamedTypeProperty(node, owner)) return undefined;
  return `${subject} gives the InteractionManager construction option ${name} both omission and explicit null, but createInteractionManager passes its options once into initializeInteractionManager for a fresh manager, where out.cursorBackend = options.cursorBackend ?? null and out.spatialIndex = options.spatialIndex ?? null normalize either spelling to the same disabled service. Runtime consumers such as applyInteractionCursor, findInteractionTarget, and refreshInteractionSpatialIndex then test the required nullable fields against null. Keep the InteractionManager cursorBackend and spatialIndex fields required nullable so installed services can be cleared explicitly, but make both fields optional non-null in InteractionManagerOptions so omission is the sole construction-time absence. If the options shape later becomes a mutation patch, define a named closed update state whose unchanged, disabled, and installed cases are explicit. The compiler will not choose or collapse an absence sentinel, construct a cursor backend or spatial index, rewrite the manager, change service-owner identity, or add side storage.`;
}

function getMorphShapeGradientEndpointMixedAbsencePropertyMessage(
  node: ts.PropertySignature,
  subject: string,
): string | undefined {
  if (
    !ts.isInterfaceDeclaration(node.parent) ||
    node.parent.name.text !== 'MorphShapeGradientEndpoint' ||
    getNodeName(node.name) !== 'matrix' ||
    !isFlightTypesSource(node, 'MorphShape.ts') ||
    !isOptionalNullableReadonlyNamedTypeProperty(node, 'Matrix')
  ) {
    return undefined;
  }
  return `${subject} gives the construction-only morph-gradient endpoint matrix both omission and explicit null, but current Flight has one no-matrix authoring state. readSwfMorphFillStyle is the only production endpoint builder: it always assigns both matrix fields from readSwfMorphMatrix, which returns a concrete Matrix even for an encoded identity matrix; repository shape callers otherwise omit matrix or supply a present owner, and no producer writes null. explainMorphShapeGradientEndpoints and getMorphShapeGradientEndpointIssue inspect only stop arrays. appendMorphShapeBeginGradientFill and appendMorphShapeLineGradientStyle both route to appendMorphShapeGradientPaint, the sole endpoint-matrix reader, which evaluates start.matrix ?? null and end.matrix ?? null. When both normalized sources are absent, createSampledMatrix produces a null command matrix and MorphShapeGradientPaintBinding.startMatrix and endMatrix are both null. When either source is present, the absent side uses identityMatrix, both required binding fields receive independent clones, and createSampledMatrix creates the separate mutable command clone; a present identity matrix remains an authored value and retains this matrix-bearing binding. Initial append sampling, initializeMorphShapeData, sampleMorphShapePaintBindings, and setMorphShapeProgress all reach sampleMorphShapePaintBinding, which interpolates only when the command matrix and both binding matrices are non-null. clearShapeCommands and copyShapeCommands discard paint bindings with the command stream, and renderers observe the sampled command rather than either endpoint spelling. Declare MorphShapeGradientEndpoint.matrix as optional Readonly<Matrix> without null so omission is the sole authoring-time absence, while keeping the binding's startMatrix and endMatrix fields required Readonly<Matrix> | null as resolved paired sampling state. If an external compatibility input accepts explicit null, give it a separate shape and normalize once before calling a morph-gradient appender. If authoring later distinguishes an inherited matrix from an explicitly disabled matrix, replace the property with one named closed endpoint state and resolve every arm before constructing the binding. Do not whitelist the redundant authoring spelling. The compiler will preserve every authored Matrix owner and resolved null but will not choose or collapse an absence sentinel, treat a present identity matrix as absent, infer the paired endpoint, select or synthesize identityMatrix, clone or materialize a Matrix, rewrite paint sampling, binding storage, command clearing, or renderer input, reinterpret or cast the value, or add side storage.`;
}

function getNormalizedStringOptionMixedAbsencePropertyMessage(
  node: ts.PropertySignature,
  subject: string,
): string | undefined {
  if (!ts.isInterfaceDeclaration(node.parent) || !isOptionalNullableStringProperty(node)) return undefined;
  const field = getNodeName(node.name);
  const owner = node.parent.name.text;
  if (isFlightTypesSource(node, 'GltfExtension.ts') && owner === 'GltfImportOptions' && field === 'basePath') {
    return `${subject} gives the construction-only glTF base-path input both omission and explicit null, but current parsing has one no-base input state. createScene3DFromGlb, createScene3DFromGltf, createScene3DsFromGlb, createScene3DsFromGltf, parseGlb, and parseGltf all accept GltfImportOptions and converge on buildGltfDocument without retaining or mutating the options. buildGltfDocument passes them to buildGltfImageResourceReference for every image, and only the external non-data URI branch reads basePath: options?.basePath ?? null goes to createExternalImageResourceReference, while data URIs and bufferView images never consult it. loadScene3DDocumentFromGlbUrl and loadScene3DDocumentFromGltfUrl derive a string or null with getScene3DDocumentBasePathFromUrl and currently include that value in fresh parser options; the JSON loader separately uses the same derived value to fetch external buffers before parsing. Make GltfImportOptions.basePath an optional string, and have the URL loaders omit it when the derived path is null, so omission is the sole parser-input absence while an empty string remains a present authored path. Keep ExternalImageResourceReference.basePath a required string | null cell: initializeExternalImageResourceReference materializes the exact normalized value, and resolveImageResourceUri later leaves a relative URI unchanged for null, joins it against a present path, and preserves absolute URIs. If a compatibility entry point accepts explicit null, keep that raw input separate and normalize it to omission before a glTF parser; if a future update API must distinguish unchanged, cleared, and supplied paths, give it a named closed update state. Do not whitelist the redundant construction spelling. The compiler will preserve every present path and ExternalImageResourceReference owner but will not choose or collapse an absence sentinel, derive or join a path, fetch a buffer or image, rewrite parser or loader options, mutate resource storage, replace an empty string, reinterpret or cast a path, or add side storage.`;
  }
  let guidance:
    | {
        readonly destination: string;
        readonly normalization: string;
        readonly presentMeaning: string;
        readonly whitelistGuidance?: string;
      }
    | undefined;
  if (
    isFlightTypesSource(node, 'Scene2DResources.ts') &&
    owner === 'Scene2DDocumentLoadOptions' &&
    field === 'mimeType'
  ) {
    guidance = {
      destination: 'Scene2DDocumentImportContext.mimeType',
      normalization:
        'loadScene2DDocumentFromUrl writes mimeType: options?.mimeType ?? null into the required nullable Scene2DDocumentImportContext; createScene2DDocumentFromBytes then passes that context unchanged to each registry matcher and the selected importer, while the Lottie, SVG, and SWF matchers compare only their exact MIME strings before falling back to byte sniffing',
      presentMeaning: 'MIME hint',
      whitelistGuidance:
        "Do not whitelist the redundant explicit-null MIME hint: representation support does not replace the source's single normalized input state.",
    };
  } else if (
    isFlightTypesSource(node, 'TextInputEditingOptions.ts') &&
    owner === 'ReplaceTextInputOptions' &&
    field === 'mergeKind'
  ) {
    guidance = {
      destination: 'recordTextInputEdit mergeKind and TextInputHistoryEntry.mergeKind',
      normalization:
        'replaceTextInputRange passes options?.mergeKind ?? null to recordTextInputEdit, whose required nullable parameter is stored in TextInputHistoryEntry and compared with null before coalescing',
      presentMeaning: 'merge tag',
    };
  }
  if (field === undefined || guidance === undefined) return undefined;
  const whitelistGuidance = guidance.whitelistGuidance === undefined ? '' : ` ${guidance.whitelistGuidance}`;
  return `${subject} gives the normalized string input ${owner}.${field} both omission and explicit null, but ${guidance.normalization}. That ?? null boundary makes the two absence spellings identical while an empty string remains a present ${guidance.presentMeaning}. Keep ${guidance.destination} required nullable, but declare ${owner}.${field} as an optional string so omission is the sole input-side absence.${whitelistGuidance} If the input later becomes an update patch where omission means unchanged and null means clear, replace the property with one named closed input state and handle each arm explicitly. The compiler will not choose or collapse an absence sentinel, replace a present empty string with null or a default, synthesize a replacement ${guidance.presentMeaning}, rewrite the caller or downstream storage, reinterpret or cast the value, or add side storage.`;
}

function getScene2DAudioLoadContextMixedAbsencePropertyMessage(
  node: ts.PropertySignature,
  subject: string,
): string | undefined {
  if (
    !ts.isInterfaceDeclaration(node.parent) ||
    node.parent.name.text !== 'LoadScene2DAudioResourcesOptions' ||
    getNodeName(node.name) !== 'context' ||
    !isFlightTypesSource(node, 'Scene2DResources.ts') ||
    !isOptionalNullableNamedTypeProperty(node, 'AudioContext')
  ) {
    return undefined;
  }
  return `${subject} gives the one-shot Scene2D audio load's platform decoder context both omission and explicit null, but loadScene2DAudioResources immediately evaluates options?.context ?? null and passes that required AudioContext | null unchanged to resolveAudioResourceReference for every selected reference. External references resolve only through the fetch seam and never inspect the context. Embedded references first try a registered MIME decoder; decodeAudioResourceBytes calls AudioContext.decodeAudioData only when no registered decoder handled the bytes and returns null when the normalized context is null. Thus omitted and explicit-null options both disable only the platform decode fallback, while a present AudioContext owner is borrowed unchanged for this operation and never retained. Declare LoadScene2DAudioResourcesOptions.context as optional AudioContext without null, and keep the required nullable resolver and decoder parameters plus the ?? null normalization at the load boundary. Do not whitelist the redundant explicit-null context spelling: representation support does not replace the source's single normalized decoder input state. If omission and an explicit platform-decoder disable must differ, replace the property with one named closed context-input state and resolve every arm before loading. The compiler will not choose or collapse an absence sentinel, construct, resume, or close an AudioContext, select or invoke a decoder or fetcher, copy or materialize the host context owner, rewrite reference state or load results, reinterpret or cast the context, or add side storage.`;
}

function getSceneConstructionOwnerOptionMixedAbsencePropertyMessage(
  node: ts.PropertySignature,
  subject: string,
): string | undefined {
  if (!ts.isInterfaceDeclaration(node.parent)) return undefined;
  const source = normalizePathPortable(node.getSourceFile().fileName);
  const name = getNodeName(node.name);
  if (
    source.endsWith('/packages/types/src/Camera3DOptions.ts') &&
    node.parent.name.text === 'Camera3DOptions' &&
    name === 'nearClipPlane' &&
    isOptionalNullableNamedTypeProperty(node, 'Plane')
  ) {
    return `${subject} gives the Camera3D construction owner nearClipPlane both omission and explicit null, but createCamera3D passes its options once to initializeCamera3D for a fresh camera, where out.nearClipPlane = opts.nearClipPlane ?? null normalizes either spelling to the same disabled clipping state. The only downstream consumers are getCamera3DViewProjectionMatrix4, which applies the plane only when present, and reflectCamera3DByPlane, which copies the live required nullable field directly. Keep Camera3D.nearClipPlane required nullable so runtime code can install or clear a plane, but make Camera3DOptions.nearClipPlane an optional Plane without null so omission is the sole construction-time absence. Do not whitelist the redundant explicit-null construction spelling: representation support does not replace the source's one-shot option normalization. If the options shape later becomes a mutation patch, define a named closed update state whose unchanged, disabled, and present-plane cases are explicit. The compiler will not choose or collapse an absence sentinel, infer or construct a Plane, rewrite or reflect the camera, copy or materialize the plane owner, or add side storage.`;
  }
  if (
    source.endsWith('/packages/types/src/EnvironmentOptions.ts') &&
    node.parent.name.text === 'EnvironmentOptions' &&
    name === 'environment' &&
    isOptionalNullableNamedTypeProperty(node, 'Texture')
  ) {
    return `${subject} gives the one-shot Environment radiance-cube input both omission and explicit null, but production has only no-cube and present-cube construction cases. createEnvironment allocates a fresh Environment and passes its options once to initializeEnvironment, where out.environment = options?.environment ?? null normalizes no options, an omitted property, and explicit null to the same required live null; callers that set only enabled or intensity omit environment, while scene providers pass an exact cube Texture. Environment owns the canonical mutable Texture | null storage cell but borrows the Texture identity: runtime code can install or clear the cube after construction, and cloneEnvironment creates a new Environment wrapper while sharing the source's exact GPU-backed Texture rather than cloning it. The only direct readers of the live field are ensureGlEnvironmentSourceCube and ensureWgpuEnvironmentSourceCube. The GL provider returns null and destroys a stale cached cube when the field is null, non-cube, or incomplete, otherwise keying derived GPU state by the exact Texture identity and revisions. When no cached view exists, the WebGPU provider likewise returns null before allocation for an unavailable or invalid cube and stores only a derived GPU texture/view on the scene runtime; destroyWgpuScene3DIbl is that cache's explicit invalidation and teardown seam. GL and WebGPU skybox draws and IBL bakes compose those providers and no-op on their null result; generic light analysis reads Environment kind, enabled, and intensity but never invents a cube. Make EnvironmentOptions.environment an optional Texture without null so omission is the sole construction-time absence and no-cube input, and keep Environment.environment required nullable for live install/clear state. Adapt cloneEnvironment to omit the option when source.environment is null and pass the existing Texture unchanged when present; do not make the live field optional or deep-copy the resource. If an external compatibility boundary accepts explicit null, normalize it once to omission before construction. If a future mutation patch must distinguish unchanged, clear, and install, give it a separate named closed update state and handle every arm explicitly. Do not whitelist the redundant construction spelling. The compiler will preserve the exact supplied Texture and live null but will not choose or collapse an absence sentinel, infer or construct a Texture, rewrite or clone the Environment, allocate, invalidate, or destroy a GPU cache, copy or materialize the texture owner, alter skybox or IBL dispatch, reinterpret or cast the input, or add side storage.`;
  }
  return undefined;
}

function getCanvasBlendModeApplicationMixedAbsencePropertyMessage(
  node: ts.PropertySignature,
  subject: string,
): string | undefined {
  if (
    !ts.isInterfaceDeclaration(node.parent) ||
    node.parent.name.text !== 'CanvasRenderRegistries' ||
    getNodeName(node.name) !== 'blendModeApplication' ||
    !isFlightTypesSource(node, 'CanvasRenderState.ts') ||
    !isOptionalNullableFunctionProperty(node)
  ) {
    return undefined;
  }
  return `${subject} gives the Canvas pipeline's blend-mode application policy both omission and explicit null, but current producers have one no-policy state: allocateEmptyCanvasRenderRegistries leaves the property omitted, while defaultScene2DCanvasRenderRegistries supplies the exact applyCanvasBlendMode function, and no producer writes null. createCanvasRenderState snapshots registries.blendModeApplication ?? null into the required nullable CanvasRenderState.applyBlendMode hook, so either input absence spelling becomes the same passthrough state. Canvas draw paths optional-call that live hook, and enableCanvasBlendMode may install applyCanvasBlendMode later; keep CanvasRenderState.applyBlendMode required nullable for that live state. Make CanvasRenderRegistries.blendModeApplication an optional non-null function with its existing CanvasRenderState and BlendMode | null parameters. Preserve the exact present function owner, the default pipeline assignment, the empty-registry omission, the one-time ?? null normalization, and the runtime registry copies; no production consumer observes an omitted-versus-null registry spelling after construction. If an external compatibility boundary accepts explicit null, normalize it once to omission before constructing the pipeline; if a future registry update API must distinguish unchanged, disabled, and installed policy, give it a separate named closed update state. Do not whitelist the redundant registry spelling. The compiler will preserve every authored state and callback signature but will not choose or collapse an absence sentinel, infer or install blend support, call or bind the policy, re-parameterize the callback, rewrite draw dispatch or compositing state, route the function through Any, reinterpret or cast it, or add side storage.`;
}

function getRenderProxyColorMatrixMixedAbsencePropertyMessage(
  node: ts.PropertySignature,
  subject: string,
): string | undefined {
  if (
    !ts.isInterfaceDeclaration(node.parent) ||
    node.parent.name.text !== 'RenderProxy' ||
    getNodeName(node.name) !== 'colorMatrix' ||
    !normalizePathPortable(node.getSourceFile().fileName).endsWith('/packages/types/src/RenderProxy.ts') ||
    !isOptionalNullableReadonlyNumberArrayProperty(node)
  ) {
    return undefined;
  }
  return `${subject} gives the reusable RenderProxy colorMatrix slot both omission and explicit null, but the represented 2D render contract has one inactive state: initializeRenderProxy assigns out.colorMatrix = null, and updateRenderProxyColorScaleBias overwrites it with a resolved matrix or null whenever color adjustment accumulation runs. GL and WebGPU 2D consumers use nullish selection or comparison before batching and shader selection. Make RenderProxy.colorMatrix a required readonly number[] | null field alongside required colorScaleBias, preserve the initializer and per-update clear, and narrow resolveInheritedColorMatrix's previous parameter from readonly number[] | null | undefined to readonly number[] | null so its reuse branch no longer carries an unreachable undefined case. If a proxy lifecycle must distinguish not initialized from no matrix, name a closed color-adjustment state and handle every state explicitly. The compiler will not choose or collapse an absence sentinel, synthesize or multiply a color matrix, rewrite batching or shader selection, allocate or copy matrix storage, or add side storage.`;
}

function getColorAdjustmentFeatureMixedAbsencePropertyMessage(
  node: ts.PropertySignature,
  subject: string,
): string | undefined {
  if (!ts.isInterfaceDeclaration(node.parent) || getNodeName(node.name) !== 'colorAdjustmentFeature') {
    return undefined;
  }
  const owner = node.parent.name.text;
  const source = normalizePathPortable(node.getSourceFile().fileName);
  const isGlRegistry = owner === 'GlRenderRegistries' && source.endsWith('/packages/types/src/GlRenderState.ts');
  const isGlOptions =
    owner === 'GlRenderStateOptions' && source.endsWith('/packages/types/src/GlRenderStateOptions.ts');
  const isWgpuRegistry = owner === 'WgpuRenderRegistries' && source.endsWith('/packages/types/src/WgpuRenderState.ts');
  const isWgpuOptions =
    owner === 'WgpuRenderStateOptions' && source.endsWith('/packages/types/src/WgpuRenderStateOptions.ts');
  if (!isGlRegistry && !isGlOptions && !isWgpuRegistry && !isWgpuOptions) return undefined;
  const isGl = isGlRegistry || isGlOptions;
  const feature = isGl ? 'GlColorAdjustmentMaterialFeature' : 'WgpuColorAdjustmentMaterialFeature';
  if (!isOptionalNullableNamedTypeProperty(node, feature)) return undefined;
  const backend = isGl ? 'GL' : 'WebGPU';
  const options = isGl ? 'GlRenderStateOptions' : 'WgpuRenderStateOptions';
  const registries = isGl ? 'GlRenderRegistries' : 'WgpuRenderRegistries';
  const build = isGl ? 'buildGlRenderRegistries' : 'buildWgpuRenderRegistries';
  const get = isGl ? 'getGlColorAdjustmentMaterialFeature' : 'getWgpuColorAdjustmentMaterialFeature';
  const register = isGl ? 'registerGlColorAdjustmentMaterialFeature' : 'registerWgpuColorAdjustmentMaterialFeature';
  const role = isGlRegistry || isWgpuRegistry ? 'live registry slot' : 'construction option';
  return `${subject} gives the ${backend} color-adjustment material feature ${role} both omission and explicit null, but the represented opt-in feature contract has one disabled state. ${build} constructs a fresh registry and currently copies options.colorAdjustmentFeature only when it is not undefined, while ${get} returns registries.colorAdjustmentFeature ?? null, so omitted and explicit-null options and either registry absence spelling all resolve to the same unavailable feature. ${register} later overwrites that exact live registry slot with the backend feature singleton, and no path restores undefined. Declare ${options}.colorAdjustmentFeature as optional ${feature} without null, make ${registries}.colorAdjustmentFeature a required ${feature} | null field, and have ${build} assign registries.colorAdjustmentFeature = options.colorAdjustmentFeature ?? null so the construction boundary normalizes once while a present feature owner passes unchanged. Keep colorAdjustmentFeatureGuard separate: it is diagnostic policy and never enables rendering behavior. If disabled, registered, and another lifecycle state must differ, replace the absence spellings with one named closed feature-registration state and handle every arm explicitly. The compiler will not choose or collapse an absence sentinel, import or register a color-adjustment feature, enable color adjustments, select or execute shader behavior, copy or materialize the feature owner, change its backend-specific contract or diagnostic guard, reinterpret or cast the feature, or add side storage.`;
}

function getCompressedTexturePolicyOptionMixedAbsencePropertyMessage(
  node: ts.PropertySignature,
  subject: string,
): string | undefined {
  if (!ts.isInterfaceDeclaration(node.parent)) return undefined;
  const owner = node.parent.name.text;
  const source = normalizePathPortable(node.getSourceFile().fileName);
  const isGl = owner === 'GlRenderStateOptions' && source.endsWith('/packages/types/src/GlRenderStateOptions.ts');
  const isWgpu = owner === 'WgpuRenderStateOptions' && source.endsWith('/packages/types/src/WgpuRenderStateOptions.ts');
  if (!isGl && !isWgpu) return undefined;
  const field = getNodeName(node.name);
  if (field !== 'compressedTextureDecoder' && field !== 'compressedTextureUpload') return undefined;
  const backendPrefix = isGl ? 'Gl' : 'Wgpu';
  const capability = `${backendPrefix}CompressedTexture${field === 'compressedTextureDecoder' ? 'Decoder' : 'Uploader'}`;
  if (!isOptionalNullableNamedTypeProperty(node, capability)) return undefined;
  const backend = isGl ? 'GL' : 'WebGPU';
  const build = isGl ? 'buildGlRenderRegistries' : 'buildWgpuRenderRegistries';
  const options = `${backendPrefix}RenderStateOptions`;
  const registries = `${backendPrefix}RenderRegistries`;
  const registerDecoder = `register${backendPrefix}CompressedTextureDecoder`;
  const registerUpload = `register${backendPrefix}CompressedTextureUpload`;
  const role = field === 'compressedTextureDecoder' ? 'RGBA fallback decoder' : 'container uploader';
  return `${subject} gives the ${backend} compressed-texture ${role} construction option both omission and explicit null, but the represented fresh-state contract has one disabled input state. ${build} assigns registries.compressedTextureDecoder = options.compressedTextureDecoder ?? null and registries.compressedTextureUpload = options.compressedTextureUpload ?? null into required nullable live registry slots, so either option absence spelling constructs the same disabled policy while a present ${capability} owner passes unchanged. The draw bridge checks uploadEntry == null before the compressed path and passes decoderEntry ?? null into the uploader; ${registerDecoder} later writes the exact decoder or null, while ${registerUpload} installs the backend uploader when called without its optional clear argument and writes null when explicitly clearing it. Declare ${options}.compressedTextureDecoder as optional ${backendPrefix}CompressedTextureDecoder and ${options}.compressedTextureUpload as optional ${backendPrefix}CompressedTextureUploader, both without null; keep ${registries} fields required nullable and retain the registrars' nullable live-update contracts. If a future options merger must distinguish an omitted unchanged policy from an explicit clear, give that merger a named closed policy-update state and resolve it before ${build}. The compiler will not choose or collapse an absence sentinel, install or clear a compressed-texture policy, invoke a decoder or uploader, infer format or device support, allocate decoded pixels or a texture, copy or materialize either capability owner, change the GL or WebGPU callable contract, reinterpret or cast a capability, or add side storage.`;
}

function getScene3DDiagnosticGuardMixedAbsencePropertyMessage(
  node: ts.PropertySignature,
  subject: string,
): string | undefined {
  if (!ts.isInterfaceDeclaration(node.parent) || !isOptionalNullableFunctionProperty(node)) return undefined;
  const owner = node.parent.name.text;
  const field = getNodeName(node.name);
  const isGlGuard =
    isFlightTypesSource(node, 'GlScene3DRuntime.ts') &&
    owner === 'GlScene3DRuntime' &&
    (field === 'colorSpaceGuard' ||
      field === 'customShaderGuard' ||
      field === 'deformGuard' ||
      field === 'forwardLightSelectionGuard' ||
      field === 'pbrExtensionGuard');
  const isWgpuGuard =
    isFlightTypesSource(node, 'WgpuScene3DRuntime.ts') &&
    owner === 'WgpuScene3DRuntime' &&
    (field === 'customShaderGuard' || field === 'forwardLightSelectionGuard');
  if (!isGlGuard && !isWgpuGuard) return undefined;
  if (isGlGuard && field !== undefined) {
    const flow = getGlScene3DDiagnosticGuardFlow(field);
    return `${subject} gives the opt-in GL Scene3D diagnostic guard slot ${field} both omission and explicit null, but the represented per-state runtime has one disabled state. ${flow} getGlScene3DRuntime creates one runtime per GlRenderState; it currently omits colorSpaceGuard, customShaderGuard, deformGuard, and forwardLightSelectionGuard while assigning pbrExtensionGuard: null. Every enable function overwrites its exact slot with a diagnostic closure and no path clears a guard back to either absence spelling. The pbrExtensionGuard initializer is already semantically required: areGlPbrExtensionGuardsEnabled uses !== null, so an omitted undefined slot would incorrectly report enabled even though the optional call would skip it. Make all five guard slots required fields with their exact callable type | null and initialize all five to null in the runtime object literal. Null initialization neither imports nor installs a diagnostic implementation, so the separately imported enable modules and their logging dependencies remain shakeable. The C++ backend can preserve the current null and undefined tags and project the sole exact callable alternative for these assignments, probes, optional calls, and the guarded local call; that target capability does not choose the source contract's disabled sentinel. If disabled and not-yet-configured must differ, replace the absence spellings with one named closed guard state and handle every arm explicitly. The compiler will not choose or collapse an absence sentinel, import or install a diagnostic guard, invoke or synthesize a callback, widen its callable signature, change the render-state or runtime owner, or add side storage.`;
  }
  if (isWgpuGuard && field !== undefined) {
    const flow = getWgpuScene3DDiagnosticGuardFlow(field);
    return `${subject} gives the opt-in WebGPU Scene3D diagnostic guard slot ${field} both omission and explicit null, but the represented per-state runtime has one disabled state. ${flow} getWgpuScene3DRuntime creates one runtime per WgpuRenderState and already initializes both customShaderGuard and forwardLightSelectionGuard to null. Each enable function overwrites its exact slot with one diagnostic closure, and no path clears or replaces either installed guard. Make both guard slots required fields with their exact callable type | null, preserving the two existing null initializers and every assignment, probe, and optional call. Null initialization neither imports nor installs a diagnostic implementation, so the separately imported enable modules and their logging dependencies remain shakeable. The C++ backend can preserve the current null and undefined tags and project the sole exact callable alternative for these assignments, comparisons, and optional calls; that target capability does not choose the source contract's disabled sentinel. If disabled and not-yet-configured must differ, replace the absence spellings with one named closed guard state and handle every arm explicitly. The compiler will not choose or collapse an absence sentinel, import or install a diagnostic guard, invoke or synthesize a callback, widen its callable signature, change the render-state or runtime owner, or add side storage.`;
  }
  return undefined;
}

function getGlScene3DDiagnosticGuardFlow(field: string): string {
  switch (field) {
    case 'colorSpaceGuard':
      return 'areGlScene3DColorSpaceGuardsEnabled uses != null, and renderGlScene3D optional-calls the guard only when a direct canvas draw has no render-target color-space declaration.';
    case 'customShaderGuard':
      return 'areGlScene3DCustomShaderGuardsEnabled uses != null, and customShaderGlMeshMaterialRenderer optional-calls the guard after resolving the exact bound program and shader key.';
    case 'deformGuard':
      return 'areGlScene3DDeformGuardsEnabled uses != null, and renderGlScene3D snapshots the slot once, checks != null, and calls the same closure for each visible mesh.';
    case 'forwardLightSelectionGuard':
      return 'areGlScene3DForwardLightSelectionGuardsEnabled uses != null, and renderGlScene3D optional-calls the guard only when punctual lights exceed the forward limit without a prepared per-object selection list.';
    case 'pbrExtensionGuard':
      return 'areGlPbrExtensionGuardsEnabled uses !== null, and extendedPbrGlMeshMaterialRenderer optional-calls the guard only when extension contribution resolution fails.';
    default:
      return '';
  }
}

function getWgpuScene3DDiagnosticGuardFlow(field: string): string {
  switch (field) {
    case 'customShaderGuard':
      return 'areWgpuScene3DCustomShaderGuardsEnabled uses != null, runWgpuCustomShaderGuards returns on == null when invoked directly, and customShaderWgpuMeshMaterialRenderer optional-calls the guard only after it has an active pass, a usable material and shader key, and the resolved WGSL source.';
    case 'forwardLightSelectionGuard':
      return 'areWgpuScene3DForwardLightSelectionGuardsEnabled uses != null, and drawWgpuScene3D optional-calls the guard only when no matching prepared forward-light list exists and the input has excess punctual lights.';
    default:
      return '';
  }
}

function getGlContextRuntimeMixedAbsencePropertyMessage(
  node: ts.PropertySignature,
  subject: string,
): string | undefined {
  if (
    !ts.isInterfaceDeclaration(node.parent) ||
    node.parent.name.text !== 'GlContextRuntime' ||
    !isFlightTypesSource(node, 'GlContextRuntime.ts')
  ) {
    return undefined;
  }
  const field = getNodeName(node.name);
  if (field === 'anisotropyExt' && isOptionalNullableNamedTypeProperty(node, 'EXT_texture_filter_anisotropic')) {
    return `${subject} encodes a real three-state context capability with an optional nullable field: undefined means unqueried, null means queried and unsupported, and an EXT_texture_filter_anisotropic owner means supported. initializeGlContextState omits anisotropyExt and maxAnisotropy; the first sampler-bearing applyGlTextureSampler call reaches ensureGlAnisotropyExt, which queries only when anisotropyExt === undefined, stores the exact extension or null, and stores the reported maximum or 1. Later texture binds return the cached extension without querying again, and the supported path clamps the requested level with maxAnisotropy ?? 1 before texParameterf. GlContextRuntime is constructed once per GlContextState, every GlRenderState created from that state retains the same context owner, and no production clone copies this cache. Preserve all three meanings but make them explicit: replace anisotropyExt and maxAnisotropy with one required GlAnisotropyCapability closed state whose arms are unqueried, unsupported, and supported with the exact extension plus maximum; initialize unqueried, transition once on the first anisotropic sampler bind, and issue texParameterf only from the supported arm. If compatibility code observes the two legacy fields, normalize it at a separate boundary rather than admitting duplicate absence tags to the live context. Do not whitelist the mixed-absence spelling. The compiler will not query a GL extension or hardware limit, choose or collapse a cache state, fabricate an extension owner, infer a maximum, rewrite sampler timing or texture parameters, clone the context, or add side storage.`;
  }
  if (field === 'sceneMeshUploadCache' && isOptionalNullableObjectWeakMapProperty(node)) {
    return `${subject} gives the context-owned Scene3D mesh upload cache both omission and explicit null, but current Flight has one not-yet-allocated state. initializeGlContextState creates the sole GlContextRuntime and currently omits this slot. getGlScene3DRuntime reads stateRuntime.context.sceneMeshUploadCache with == null, allocates and stores one WeakMap when absent, and gives each per-GlRenderState scene runtime that exact context-tier owner; every GlRenderState created from the same GlContextState shares it, and no production clone copies it. ensureGlMeshUpload then reads and writes that WeakMap by MeshGeometry identity, preserving each GlMeshUpload owner across render states; destroyGlScene3DRuntime cannot enumerate the weak cache, so geometry teardown or GL context loss remains the resource lifetime boundary. Make sceneMeshUploadCache a required WeakMap<object, object> | null field, initialize it to null in initializeGlContextState, and retain the single lazy allocation plus exact shared map reference. If a public compatibility input may omit the field, keep that input shape separate and normalize it before constructing the context runtime. Do not whitelist the redundant live-storage spelling. The compiler will not choose or collapse an absence sentinel, allocate or clone a WeakMap, copy or materialize a mesh upload, change geometry identity or teardown, redirect the cache to render-state scope, erase keys or values through Any, or add side storage.`;
  }
  return undefined;
}

function getWgpuDeviceRuntimeMixedAbsencePropertyMessage(
  node: ts.PropertySignature,
  subject: string,
): string | undefined {
  if (
    !ts.isInterfaceDeclaration(node.parent) ||
    node.parent.name.text !== 'WgpuDeviceRuntime' ||
    !isFlightTypesSource(node, 'WgpuDeviceRuntime.ts') ||
    getNodeName(node.name) !== 'sceneMeshUploadCache' ||
    !isOptionalNullableObjectWeakMapProperty(node)
  ) {
    return undefined;
  }
  return `${subject} gives the device-owned Scene3D mesh upload cache both omission and explicit null, but current Flight has one not-yet-allocated state. createMinimalDeviceRuntime is the sole WgpuDeviceRuntime constructor and currently omits this slot; createWgpuDeviceState attaches that exact runtime to the device entity. createWgpuRenderStateRuntimeInternal increments its reference count and stores the same owner on each render state's context, so presentation, direct offscreen, and source-derived offscreen states built from one WgpuDeviceState share the cache, and no production clone copies it. getWgpuScene3DRuntime reads stateRuntime.context.sceneMeshUploadCache with == null, allocates and stores one WeakMap when absent, and gives each per-state scene runtime that exact device-tier owner. ensureWgpuMeshUpload reads and writes the map by MeshGeometry identity, reuses a matching version, destroys and replaces stale GPU buffers, and mirrors the new WgpuMeshUpload on MeshGeometryRuntime. destroyWgpuRenderState frees state-owned resources and decrements the shared device reference; it neither clears nor iterates this WeakMap, so the cache retains device-tier lifetime. Make sceneMeshUploadCache a required WeakMap<object, object> | null field, initialize it to null in createMinimalDeviceRuntime, and retain the single lazy allocation plus exact shared map reference. If a public compatibility input may omit the field, keep that input shape separate and normalize it before constructing the device runtime. Do not whitelist the redundant live-storage spelling. The compiler will not choose or collapse an absence sentinel, allocate or clone a WeakMap, create, destroy, copy, or materialize a mesh upload or GPU buffer, change geometry identity or versioning, redirect the cache to render-state scope, erase keys or values through Any, or add side storage.`;
}

function getGlRenderPassTrackingMixedAbsencePropertyMessage(
  node: ts.PropertySignature,
  subject: string,
): string | undefined {
  if (
    !ts.isInterfaceDeclaration(node.parent) ||
    node.parent.name.text !== 'GlRenderStateRuntime' ||
    !isFlightTypesSource(node, 'GlRenderState.ts')
  ) {
    return undefined;
  }
  const field = getNodeName(node.name);
  const isTarget = field === 'currentRenderTarget' && isOptionalNullableNamedTypeProperty(node, 'GlRenderTarget');
  const isScissor = field === 'currentScissorRect' && isOptionalNullableNamedTypeProperty(node, 'GlScissorRect');
  if (!isTarget && !isScissor) return undefined;
  return `${subject} gives the active GL render-pass tracking slot ${field} both omission and explicit null, but the represented runtime has one outside-pass or inactive state. createGlRenderStateRuntime already assigns currentRenderTarget = null, while createGlRenderState, invalidateGlRenderStateCache, and the GL test helper assign currentScissorRect = null. beginGlRenderPass writes the exact GlRenderTarget and computed active scissor together; captureGlPassState normalizes both slots with ?? null, restoreGlPassState assigns the saved values directly, and the foreign-renderer push and pop bracket preserves the exact slot values. Target consumers use optional access, == null, or ?? null before color-space, resolve, and end-pass work, while the clip and resolve paths normalize or directly replace currentScissorRect before applying GL scissor state. Make currentRenderTarget a required GlRenderTarget | null field and currentScissorRect a required GlScissorRect | null field, initialize both in createGlRenderStateRuntime so every runtime construction path receives the complete contract, and preserve the direct pass and foreign-renderer bracket assignments; the analogous WebGPU pass-state slots are already required nullable. Do not whitelist the redundant pass-slot spelling: representation support does not replace the source's single constructed inactive state. If a lifecycle must distinguish an uninitialized runtime from a constructed runtime outside a pass, model that as a closed runtime or pass state rather than as a second field-level absence sentinel. The compiler will not choose or collapse an absence sentinel, infer a render target or scissor rectangle, bind or clear a framebuffer, alter the pass or clip stack, copy or materialize a target or rectangle, or add side storage.`;
}

function getGlRenderRuntimeInactiveSlotMixedAbsencePropertyMessage(
  node: ts.PropertySignature,
  subject: string,
): string | undefined {
  if (
    !ts.isInterfaceDeclaration(node.parent) ||
    node.parent.name.text !== 'GlRenderStateRuntime' ||
    !isFlightTypesSource(node, 'GlRenderState.ts')
  ) {
    return undefined;
  }
  const field = getNodeName(node.name);
  if (field === 'flushPendingDraws' && isOptionalNullableFunctionProperty(node)) {
    return `${subject} gives the lazily installed GL pending-draw seam both omission and explicit null, but the represented runtime has one uninstalled state. createGlRenderState and the GL test helper initialize flushPendingDraws to null, while createGlRenderStateRuntime is the exported construction path that still omits it. prepareGlQuadBatchWrite installs the exact flushGlQuadBatchWriter callback before it can queue a batch, and pushGlRenderState optional-calls the slot before capturing context-wide state for a foreign renderer, so null and undefined perform the same no-flush action. Make flushPendingDraws a required ((state: GlRenderState) => void) | null field, initialize it to null in createGlRenderStateRuntime, and preserve the lazy scene2d-gl assignment and nullish call. Initializing the header-owned slot does not import or install scene2d-gl, so applications that never use its quad writer retain no implementation. Do not whitelist the redundant uninstalled spelling: representation support does not replace the source's single callback-seam state. If uninstalled and deliberately disabled must differ, replace the sentinels with a named closed seam state and handle every arm explicitly. The compiler will not choose or collapse an absence sentinel, import or install a batch writer, invoke or synthesize a flush callback, reorder a flush around GL state capture, widen its callable signature, or add side storage.`;
  }
  if (field === 'glRenderTextureGuard' && isOptionalNullableNamedTypeProperty(node, 'GlRenderTextureGuard')) {
    return `${subject} gives the opt-in GL render-texture diagnostic guard both omission and explicit null, but the represented runtime has one disabled state. createGlRenderStateRuntime currently omits the slot; setGlRenderTextureGuard overwrites it with the exact guard or null, enableGlRenderTextureGuards installs the warning guard through that setter, and render-texture notification optional-calls the slot. Make glRenderTextureGuard a required GlRenderTextureGuard | null field and initialize it to null in createGlRenderStateRuntime, retaining the nullable setter and optional call. Null initialization does not import or install the diagnostic module, so its logger and warning implementation remain shakeable. Do not whitelist the redundant disabled spelling: representation support does not replace the source's single guard state. If disabled and not-yet-configured must differ, replace the sentinels with a named closed guard state and handle every arm explicitly. The compiler will not choose or collapse an absence sentinel, import or install a diagnostic guard, invoke or synthesize a callback, widen its callable signature, change render-texture publication, or add side storage.`;
  }
  if (
    field === 'quadBatchWriterUniformColorScaleBias' &&
    isOptionalNullableNamedAndReadonlyNumberArrayUnionProperty(node, ['ColorScaleBias', 'TintMaterialData'])
  ) {
    return `${subject} gives the GL quad batch's uniform color-adjustment scratch slot both omission and explicit null, but its mode field is the authority and the represented scratch value has one empty state. registerGlColorAdjustmentMaterialFeature initializes the mode on opt-in; recordGlColorAdjustment normalizes an absent mode to NONE and the uniform slot with ?? null, writes the exact ColorScaleBias, TintMaterialData, or readonly number[] owner only when the first adjusted instance selects UNIFORM mode, and promotes that owner when later values diverge. flushGlColorAdjustmentMaterialFeature returns before reading the slot in NONE mode, otherwise normalizes it with ?? null and clears it to null after capture. Make quadBatchWriterUniformColorScaleBias a required ColorScaleBias | TintMaterialData | readonly number[] | null field and initialize it to null in createGlRenderStateRuntime; preserve the mode as the state-machine discriminant and the null clear after flush. Initializing a null header-owned scratch slot does not register the color-adjustment feature or retain its shader implementation. Do not whitelist the redundant empty spelling: representation support does not replace the mode-owned fold state. If empty, uniform, and promoted storage need a stronger invariant, model the batch fold as one named closed state whose uniform arm owns the exact adjustment value. The compiler will not choose or collapse an absence sentinel, infer a fold mode or identity adjustment, register the feature, compile or bind a shader, copy or materialize adjustment data, reinterpret or cast an owner, or add side storage.`;
  }
  return undefined;
}

function getWgpuRenderRuntimeMixedAbsencePropertyMessage(
  node: ts.PropertySignature,
  subject: string,
): string | undefined {
  if (
    !ts.isInterfaceDeclaration(node.parent) ||
    node.parent.name.text !== 'WgpuRenderStateRuntime' ||
    !isFlightTypesSource(node, 'WgpuRenderState.ts')
  ) {
    return undefined;
  }
  const field = getNodeName(node.name);
  if (field === 'wgpuRenderTextureGuard' && isOptionalNullableNamedTypeProperty(node, 'WgpuRenderTextureGuard')) {
    return `${subject} gives the opt-in WebGPU render-texture diagnostic guard both omission and explicit null, but the represented runtime has one disabled state. createWgpuRenderStateRuntimeInternal currently omits the slot; createWgpuOffscreenRenderState copies the source runtime's exact guard value, setWgpuRenderTextureGuard overwrites it with the exact guard or null, and render-texture notification optional-calls it. Make wgpuRenderTextureGuard a required WgpuRenderTextureGuard | null field, initialize it to null in createWgpuRenderStateRuntimeInternal, and retain the derived-state copy, nullable setter, and optional call. Null initialization imports or installs no callback and changes no render-texture publication behavior. If disabled and not-yet-configured must differ, replace the sentinels with one named closed guard state and handle every arm explicitly. The compiler will not choose or collapse an absence sentinel, import or install a diagnostic guard, invoke or synthesize a callback, widen its callable signature, change derived-state policy inheritance or render-texture publication, or add side storage.`;
  }
  if (
    field === 'quadBatchWriterUniformColorScaleBias' &&
    isOptionalNullableNamedAndReadonlyNumberArrayUnionProperty(node, ['ColorScaleBias', 'TintMaterialData'])
  ) {
    return `${subject} gives the WebGPU quad batch's uniform color-adjustment scratch slot both omission and explicit null, but quadBatchWriterColorScaleBiasMode is the authority and the represented scratch value has one empty state. createWgpuRenderStateRuntimeInternal omits the slot, while registerWgpuColorAdjustmentMaterialFeature initializes only the mode. recordWgpuColorAdjustment normalizes an absent mode to NONE, writes the exact ColorScaleBias, TintMaterialData, or readonly number[] owner only when the first adjusted instance selects UNIFORM mode, reads it through ?? null while comparing later instances, and otherwise promotes directly without requiring a stored uniform. resolveWgpuColorAdjustmentFlush returns before reading it in NONE mode, uses the mode proof before its non-null read in UNIFORM mode, and clears it to null after every non-empty flush. Make quadBatchWriterUniformColorScaleBias a required ColorScaleBias | TintMaterialData | readonly number[] | null field and initialize it to null in createWgpuRenderStateRuntimeInternal; preserve the mode as the state-machine discriminant and the null clear after flush. Initializing this header-owned scratch slot does not register the feature, import its scene2d-wgpu implementation, allocate storage, or retain its shader modules. If empty, uniform, and promoted storage need a stronger invariant, model the fold as one named closed state whose uniform arm owns the exact adjustment value. The compiler will not choose or collapse an absence sentinel, infer a fold mode or identity adjustment, register the feature, compile or bind a shader, copy or materialize adjustment data, reinterpret or cast an owner, or add side storage.`;
  }
  if (field === 'sceneMeshUploadCache' && isOptionalNullableObjectWeakMapProperty(node)) {
    return `${subject} declares an optional-null state-local scene mesh upload cache, but no producer or consumer reads or writes this WgpuRenderStateRuntime field. getWgpuScene3DRuntime instead reads and lazily initializes stateRuntime.context.sceneMeshUploadCache on WgpuDeviceRuntime with == null, and every derived render state shares that same device-tier context; the analogous GL accessor likewise uses its context-tier slot rather than a render-state-runtime duplicate. Remove sceneMeshUploadCache from WgpuRenderStateRuntime. Keep the separately declared WgpuDeviceRuntime slot and its lazy WeakMap allocation as the single device-tier owner. If a future state-local cache is required, give it a distinct name, owner, initialization path, teardown policy, and consumers rather than shadowing the device cache. A compiler representation for null, undefined, or WeakMap does not make an unread duplicate field meaningful. The compiler will not choose or collapse an absence sentinel, infer which ownership tier was intended, redirect a field access to context, allocate or share a WeakMap, rewrite derived-state lifetime, erase object keys or values through Any, or add side storage.`;
  }
  return undefined;
}

function getGlMeshProgramUniformLocationMixedAbsencePropertyMessage(
  node: ts.PropertySignature,
  subject: string,
): string | undefined {
  if (
    !ts.isInterfaceDeclaration(node.parent) ||
    node.parent.name.text !== 'GlMeshProgram' ||
    !isFlightTypesSource(node, 'GlMeshProgram.ts') ||
    !isOptionalNullableNamedTypeProperty(node, 'WebGLUniformLocation')
  ) {
    return undefined;
  }
  const field = getNodeName(node.name);
  if (field === 'locJointTexture' || field === 'locJointNormalTexture') {
    const consumer =
      field === 'locJointTexture'
        ? 'bindGlMeshSkinPalette requires locJointTexture != null together with jointMatrices before it uploads and binds the pose palette; the skinned shadow path likewise passes locJointTexture ?? null to uniform1i'
        : 'bindGlMeshSkinPalette independently requires locJointNormalTexture != null together with normalMatrices before it uploads and binds the normal palette; the shadow path never consumes this slot';
    return `${subject} gives the construction-time skin-sampler location ${field} both omission and explicit null, but the represented program has one unusable state. The Classic, Debug, Matcap, PBR, Shaded, Toon, Unlit, and Wireframe factories plus compileShadowDepthSkinnedProgram assign both joint sampler lookups, including null for a variant without the uniform; compileGlCustomShaderProgram, compileShadowDepthProgram, and compileShadowDepthInstancedProgram omit both slots, and no later path resolves either one. ${consumer}. Make locJointTexture and locJointNormalTexture required WebGLUniformLocation | null fields, retain each exact getUniformLocation result, and initialize both to null in the three factories that currently omit them. If factory provenance must differ from a linked program that lacks the sampler, replace the pair with one named closed skin-program capability and handle every arm explicitly. Do not whitelist either field or treat backend tag support as resolution: every factory can construct the same required-nullable source carrier without changing GL behavior. The C++ backend can preserve the current null and undefined tags and the exact WebGLUniformLocation alternative, but that representation support does not make the duplicate unusable sentinel a source contract. The compiler will not choose or collapse an absence sentinel, query or bind a GL uniform, infer whether a program supports skinning, coordinate the pose and normal samplers, reinterpret or cast a location, or add side storage.`;
  }

  const colorMatrixFields: readonly string[] = [
    'locColorMatrix0',
    'locColorMatrix1',
    'locColorMatrix2',
    'locColorMatrix3',
    'locColorMatrixOffset',
  ];
  let producerAndConsumer: string | undefined;
  let rewrite: string | undefined;
  if (field !== undefined && colorMatrixFields.includes(field)) {
    producerAndConsumer =
      'Every program factory omits all five color-matrix slots. On the first draw carrying colorMatrix, drawGlMeshSubset tests locColorMatrix0 for undefined and queries all five locations together; null locColorMatrix0 suppresses the group, while a present locColorMatrix0 causes the other four locations to be read under the shader-family all-or-none invariant';
    rewrite =
      'one named GlColorMatrixUniformCache whose unresolved and absent arms carry no locations and whose present arm carries all five locations, constructed as present only when the entire lookup group is present';
  } else if (field === 'locColorScale' || field === 'locColorBias') {
    producerAndConsumer =
      'Every program factory omits both color scale/bias slots. On the first draw carrying colorScaleBias, drawGlMeshSubset tests locColorScale for undefined, queries and caches locColorScale and locColorBias together, and uploads only when both locations are present';
    rewrite =
      'one named GlColorScaleBiasUniformCache whose unresolved and absent arms carry no locations and whose present arm carries both locations';
  } else if (field === 'locObjectAlpha' || field === 'locAlphaIsCoverage') {
    producerAndConsumer = `Every program factory omits ${field}. uploadGlMeshDrawAlpha resolves the object-alpha and alpha-coverage slots independently: it queries ${field} only while undefined, caches the exact null or location result, and skips only this upload after null`;
    rewrite = `a named GlUniformLocationCache for ${field} with unresolved, absent, and present-location arms`;
  } else if (field === 'locInstancePalette') {
    producerAndConsumer =
      'Forward program factories omit locInstancePalette, while compileShadowDepthInstancedProgram eagerly stores its exact lookup result. bindGlInstancePalette queries only an omitted undefined slot, caches null or the location, and skips the sampler upload after null';
    rewrite =
      'a named GlUniformLocationCache for locInstancePalette with unresolved, absent, and present-location arms, allowing the shadow factory to construct either resolved arm directly';
  } else if (field === 'locInstanceColorPalette') {
    producerAndConsumer =
      'Every program factory omits locInstanceColorPalette. bindGlInstanceColorPalette queries it only while undefined, caches null or the location, and skips the sampler upload after null';
    rewrite =
      'a named GlUniformLocationCache for locInstanceColorPalette with unresolved, absent, and present-location arms';
  } else if (field === 'locUvTransform') {
    producerAndConsumer =
      'Every program factory omits locUvTransform. bindGlUvTransform queries it only while undefined, caches null or the location, and skips the matrix upload after null; a null texture is a separate per-bind no-op and does not change the cache';
    rewrite = 'a named GlUniformLocationCache for locUvTransform with unresolved, absent, and present-location arms';
  }
  if (producerAndConsumer === undefined || rewrite === undefined) return undefined;
  return `${subject} gives the lazy GL uniform-location cache ${field} three observed states: undefined means unresolved, null means getUniformLocation already proved the linked program omits the uniform, and WebGLUniformLocation means present. ${producerAndConsumer}. Preserve that query-once contract by replacing the optional-null field with ${rewrite} and handling every arm explicitly. Do not collapse undefined to null, which would skip the first query, or null to undefined, which would repeat the query on later draws or binds. Do not whitelist the mixed spelling or treat backend tag support as a source model: the three states are semantically real and require the named cache arms above. The C++ backend already represents all three tags, exact location assignment, and strict undefined/null probes without Any, casts, or side storage, so no compiler lowering change is warranted; representation support does not replace the source's named cache state. The compiler will preserve authored states but will not query GL, choose or collapse a sentinel, infer or synthesize a location, coordinate related cache fields, reinterpret or cast a location, or add side storage.`;
}

function getFlightDocumentNodeInteractiveMetadataMixedAbsencePropertyMessage(
  node: ts.PropertySignature,
  subject: string,
): string | undefined {
  if (
    !ts.isInterfaceDeclaration(node.parent) ||
    node.parent.name.text !== 'FlightDocumentNode' ||
    !normalizePathPortable(node.getSourceFile().fileName).endsWith('/packages/types/src/FlightDocument.ts')
  ) {
    return undefined;
  }
  const field = getNodeName(node.name);
  if (field !== 'interactiveStates' && field !== 'transition') return undefined;
  const interactiveStates = getInterfaceProperty(node.parent, 'interactiveStates');
  const transition = getInterfaceProperty(node.parent, 'transition');
  if (
    !isOptionalNullableNamedTypeProperty(interactiveStates, 'FlightDocumentInteractiveStates') ||
    !isOptionalNullableNamedTypeProperty(transition, 'FlightDocumentInteractiveStateTransitionDescriptor')
  ) {
    return undefined;
  }
  return `${subject} gives the persisted FlightDocument node interaction slot ${field} both omission and explicit null, but the represented contract has one inactive state and transition is invalid without interactiveStates. flightDocumentText.readNode initializes both slots to null, normalizes omitted text keys to those values, rejects a transition without interactiveStates, and returns { children, fields, interactiveStates, kind, transition }. readInteractiveStateBindingMetadata returns the same required nullable pair, and the 2D and 3D scene writers assign both fields from it. Formatting, refusal, and 2D and 3D materialization collapse undefined and null with == null, != null, or ?? null; no production consumer assigns distinct behavior to omission. Make interactiveStates and transition required nullable fields on FlightDocumentNode, retain the parser and scene writers' explicit null initialization, and make every manual construction or transformation deliberately preserve or clear both fields. If callers need to distinguish absent input syntax from disabled interaction, use a separate raw input shape or one named closed metadata state before constructing the persisted node. Do not whitelist either redundant absence spelling. The compiler can preserve the authored tags and exact metadata owners, but it will not choose or collapse an absence sentinel, infer a transition from interactive states, decide whether a transformation preserves or clears metadata, clone or materialize either metadata owner, route it through Any, reinterpret or cast it, or add side storage.`;
}

function getAnimationPlayerSignalMixedAbsencePropertyMessage(
  node: ts.PropertySignature,
  subject: string,
): string | undefined {
  if (
    !ts.isInterfaceDeclaration(node.parent) ||
    node.parent.name.text !== 'AnimationPlayer' ||
    !isFlightTypesSource(node, 'AnimationPlayer.ts') ||
    node.questionToken === undefined
  ) {
    return undefined;
  }
  const field = getNodeName(node.name);
  if (field !== 'onEvent' && field !== 'onFinished' && field !== 'onLooped') return undefined;
  const owner = node.type ? getMixedAbsenceGenericCallableOwner(node.type) : undefined;
  if (!owner || getNodeName(owner.typeName) !== 'Signal') return undefined;
  const flow = getAnimationPlayerSignalFlow(field);
  const ownerType = owner.getText(node.getSourceFile());
  return `${subject} gives the opt-in AnimationPlayer signal ${field} both omission and explicit null, but the represented player has one signal-free state. cloneAnimationPlayer and initializeAnimationPlayer assign onEvent, onFinished, and onLooped to null; createAnimationPlayer delegates to that initializer, so both library construction paths choose the same sentinel. The optional create and initialize options contain only loop, loopMode, playing, repeatCount, speed, and time; they never accept signal slots, and no production construction bypasses the initializer or clone's null assignments. Optionality belongs to construction inputs, not the live player signal state. enableAnimationPlayerSignals checks each slot with == null, installs its exact Signal owner only when absent, is idempotent, and no path clears an enabled slot. ${flow} Make all three slots required fields with their exact callable-bearing Signal type | null, retain the explicit null assignments in the clone and initializer, and keep the nullish guards at emission. Null initialization remains allocation-free: the library creates the three Signal owners only in enableAnimationPlayerSignals. The C++ backend can already preserve the current null and undefined tags, the exact ${ownerType} value alternative, assignments, and nullish guards; that representation support does not choose the source contract's redundant disabled sentinel. If an external compatibility input must still accept omitted signal slots, keep that boundary shape separate and normalize it to null before constructing an AnimationPlayer; if omission and explicit disable must differ, replace them with one named closed signal state and handle every arm explicitly. Do not whitelist the redundant live-state spelling: the callback owners are exact and the library already chooses null. The compiler will not choose or collapse an absence sentinel, allocate or clone a Signal owner, connect or emit a listener, re-parameterize the callback, route it through Any, reinterpret or cast it, or add side storage.`;
}

function getAnimationPlayerSignalFlow(field: 'onEvent' | 'onFinished' | 'onLooped'): string {
  switch (field) {
    case 'onEvent':
      return 'emitAnimationPlayerEvents snapshots onEvent for each traversal segment, returns when it is == null, and otherwise emits only the clip markers crossed in that segment.';
    case 'onFinished':
      return 'emitAnimationPlayerFinished checks onFinished with != null and emits it when non-looping playback reaches an endpoint or a finite repeat budget is exhausted.';
    case 'onLooped':
      return 'emitAnimationPlayerLooped checks onLooped with != null and emits it once after an advance performs at least one permitted repeat wrap or ping-pong bounce without exhausting the budget.';
  }
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

function renderMixedAbsencePropertyMessage(node: ts.PropertySignature, subject: string): string {
  const anchorLayout = getAnchorLayoutMixedAbsencePropertyMessage(node, subject);
  if (anchorLayout) return anchorLayout;
  const scene3DRenderProxy = getScene3DRenderProxyMixedAbsencePropertyMessage(node, subject);
  if (scene3DRenderProxy) return scene3DRenderProxy;
  const meshDeformation = getMeshDeformationMixedAbsencePropertyMessage(node, subject);
  if (meshDeformation) return meshDeformation;
  const scene3DDocumentMesh = getScene3DDocumentMeshMixedAbsencePropertyMessage(node, subject);
  if (scene3DDocumentMesh) return scene3DDocumentMesh;
  const skeleton3DNames = getSkeleton3DNamesMixedAbsencePropertyMessage(node, subject);
  if (skeleton3DNames) return skeleton3DNames;
  const skeleton2DImport = getSkeleton2DImportMixedAbsencePropertyMessage(node, subject);
  if (skeleton2DImport) return skeleton2DImport;
  const skeleton2D = getSkeleton2DMixedAbsencePropertyMessage(node, subject);
  if (skeleton2D) return skeleton2D;
  const slot2D = getSlot2DMixedAbsencePropertyMessage(node, subject);
  if (slot2D) return slot2D;
  const skeleton2DSlotAnimationTarget = getSkeleton2DSlotAnimationTargetMixedAbsencePropertyMessage(node, subject);
  if (skeleton2DSlotAnimationTarget) return skeleton2DSlotAnimationTarget;
  const meshGeometryOptions = getMeshGeometryOptionsMixedAbsencePropertyMessage(node, subject);
  if (meshGeometryOptions) return meshGeometryOptions;
  const meshGeometryFromAttributesOptions = getMeshGeometryFromAttributesOptionsMixedAbsencePropertyMessage(
    node,
    subject,
  );
  if (meshGeometryFromAttributesOptions) return meshGeometryFromAttributesOptions;
  const boundingBoxAttachment2D = getBoundingBoxAttachment2DMixedAbsencePropertyMessage(node, subject);
  if (boundingBoxAttachment2D) return boundingBoxAttachment2D;
  const clippingAttachment2D = getClippingAttachment2DMixedAbsencePropertyMessage(node, subject);
  if (clippingAttachment2D) return clippingAttachment2D;
  const meshAttachment2D = getMeshAttachment2DMixedAbsencePropertyMessage(node, subject);
  if (meshAttachment2D) return meshAttachment2D;
  const pathAttachment2D = getPathAttachment2DMixedAbsencePropertyMessage(node, subject);
  if (pathAttachment2D) return pathAttachment2D;
  const attachmentPointStorage = getAttachmentPointStorageMixedAbsencePropertyMessage(node, subject);
  if (attachmentPointStorage) return attachmentPointStorage;
  const authoredName = getAuthoredNameMixedAbsencePropertyMessage(node, subject);
  if (authoredName) return authoredName;
  const bitmapTextOptions = getBitmapTextOptionsMixedAbsencePropertyMessage(node, subject);
  if (bitmapTextOptions) return bitmapTextOptions;
  const capacitorPositionCoords = getCapacitorPositionCoordsMixedAbsencePropertyMessage(node, subject);
  if (capacitorPositionCoords) return capacitorPositionCoords;
  const createTextureOptionsResource = getCreateTextureOptionsResourceMixedAbsencePropertyMessage(node, subject);
  if (createTextureOptionsResource) return createTextureOptionsResource;
  const parseCodecOption = getParseCodecOptionMixedAbsencePropertyMessage(node, subject);
  if (parseCodecOption) return parseCodecOption;
  const treeViewControllerInitialSelection = getTreeViewControllerInitialSelectionMixedAbsencePropertyMessage(
    node,
    subject,
  );
  if (treeViewControllerInitialSelection) return treeViewControllerInitialSelection;
  const interactionManagerOptions = getInteractionManagerOptionsMixedAbsencePropertyMessage(node, subject);
  if (interactionManagerOptions) return interactionManagerOptions;
  const morphShapeGradientEndpoint = getMorphShapeGradientEndpointMixedAbsencePropertyMessage(node, subject);
  if (morphShapeGradientEndpoint) return morphShapeGradientEndpoint;
  const normalizedStringOption = getNormalizedStringOptionMixedAbsencePropertyMessage(node, subject);
  if (normalizedStringOption) return normalizedStringOption;
  const scene2DAudioLoadContext = getScene2DAudioLoadContextMixedAbsencePropertyMessage(node, subject);
  if (scene2DAudioLoadContext) return scene2DAudioLoadContext;
  const sceneConstructionOwner = getSceneConstructionOwnerOptionMixedAbsencePropertyMessage(node, subject);
  if (sceneConstructionOwner) return sceneConstructionOwner;
  const canvasBlendModeApplication = getCanvasBlendModeApplicationMixedAbsencePropertyMessage(node, subject);
  if (canvasBlendModeApplication) return canvasBlendModeApplication;
  const renderProxyColorMatrix = getRenderProxyColorMatrixMixedAbsencePropertyMessage(node, subject);
  if (renderProxyColorMatrix) return renderProxyColorMatrix;
  const colorAdjustmentFeature = getColorAdjustmentFeatureMixedAbsencePropertyMessage(node, subject);
  if (colorAdjustmentFeature) return colorAdjustmentFeature;
  const compressedTexturePolicyOption = getCompressedTexturePolicyOptionMixedAbsencePropertyMessage(node, subject);
  if (compressedTexturePolicyOption) return compressedTexturePolicyOption;
  const scene3DDiagnosticGuard = getScene3DDiagnosticGuardMixedAbsencePropertyMessage(node, subject);
  if (scene3DDiagnosticGuard) return scene3DDiagnosticGuard;
  const glMeshProgramUniformLocation = getGlMeshProgramUniformLocationMixedAbsencePropertyMessage(node, subject);
  if (glMeshProgramUniformLocation) return glMeshProgramUniformLocation;
  const glContextRuntime = getGlContextRuntimeMixedAbsencePropertyMessage(node, subject);
  if (glContextRuntime) return glContextRuntime;
  const wgpuDeviceRuntime = getWgpuDeviceRuntimeMixedAbsencePropertyMessage(node, subject);
  if (wgpuDeviceRuntime) return wgpuDeviceRuntime;
  const glRenderPassTracking = getGlRenderPassTrackingMixedAbsencePropertyMessage(node, subject);
  if (glRenderPassTracking) return glRenderPassTracking;
  const glRenderRuntimeInactiveSlot = getGlRenderRuntimeInactiveSlotMixedAbsencePropertyMessage(node, subject);
  if (glRenderRuntimeInactiveSlot) return glRenderRuntimeInactiveSlot;
  const wgpuRenderRuntime = getWgpuRenderRuntimeMixedAbsencePropertyMessage(node, subject);
  if (wgpuRenderRuntime) return wgpuRenderRuntime;
  const flightDocumentNodeInteraction = getFlightDocumentNodeInteractiveMetadataMixedAbsencePropertyMessage(
    node,
    subject,
  );
  if (flightDocumentNodeInteraction) return flightDocumentNodeInteraction;
  const animationPlayerSignal = getAnimationPlayerSignalMixedAbsencePropertyMessage(node, subject);
  if (animationPlayerSignal) return animationPlayerSignal;
  const callableOwner = node.type ? getMixedAbsenceGenericCallableOwner(node.type) : undefined;
  if (callableOwner) {
    const ownerType = callableOwner.getText(node.getSourceFile());
    const undefinedState = node.questionToken ? 'an implicit undefined state' : 'an explicit undefined state';
    return `${subject} gives the generic callable owner ${ownerType} both ${undefinedState} and an explicit null state. A present owner retains its exact callable type argument; neither absence state owns a callable. If undefined and null both mean that the callback facility is not enabled, declare the property as a required ${ownerType} | null, initialize it to null in every construction path, and retain the nullish guard at reads. If omission is the sole absence contract, remove null instead; if the two states differ, replace the two absence states with a named discriminated state. The compiler will preserve all authored states, but will not choose or collapse an absence sentinel, allocate or clone a callable owner, re-parameterize its callable argument, route it through Any, reinterpret or cast it, or add side storage.`;
  }
  const collectionInputs = getMixedAbsenceCollectionOptionTypes(node);
  if (collectionInputs) {
    const collectionType = collectionInputs.map((type) => type.getText(node.getSourceFile())).join(' | ');
    return `${subject} gives the optional collection input ${collectionType} both omission and explicit null, but neither absence state carries elements or a collection owner. If callers and consumers treat both as not supplied, keep the property optional and remove null, retaining each present array or typed-array owner and its element domain; normalize once at the consuming boundary only when downstream storage requires null. If null means an intentional clear distinct from omission, name a closed discriminated input state and handle it explicitly. Do not substitute an empty collection: a present empty collection is still a supplied value. The compiler will preserve all authored states, but will not choose or collapse an absence sentinel, infer an empty collection, merge distinct typed-array owners, allocate or copy backing storage, route elements through Any, reinterpret or cast a collection, or add side storage.`;
  }
  return `${subject} combines an optional property with null; choose one absence representation or make all three states explicit.`;
}

function getMixedAbsenceGenericCallableOwner(node: ts.TypeNode): ts.TypeReferenceNode | undefined {
  const present = getMixedAbsencePresentTypes(node);
  if (present.length !== 1) return undefined;
  let owner = present[0]!;
  while (ts.isParenthesizedTypeNode(owner)) owner = owner.type;
  if (!ts.isTypeReferenceNode(owner) || !owner.typeArguments?.length) return undefined;
  return owner.typeArguments.some((argument) => {
    while (ts.isParenthesizedTypeNode(argument)) argument = argument.type;
    return ts.isFunctionTypeNode(argument);
  })
    ? owner
    : undefined;
}

function getMixedAbsenceCollectionOptionTypes(node: ts.PropertySignature): readonly ts.TypeNode[] | undefined {
  if (
    node.questionToken === undefined ||
    !node.type ||
    !ts.isInterfaceDeclaration(node.parent) ||
    !node.parent.name.text.endsWith('Options')
  ) {
    return undefined;
  }
  const present = getMixedAbsencePresentTypes(node.type);
  return present.length > 0 && present.every(isTypeScriptCollectionType) ? present : undefined;
}

function getMixedAbsencePresentTypes(node: ts.TypeNode): readonly ts.TypeNode[] {
  while (ts.isParenthesizedTypeNode(node)) node = node.type;
  const members = ts.isUnionTypeNode(node) ? node.types : [node];
  return members.filter((member) => {
    while (ts.isParenthesizedTypeNode(member)) member = member.type;
    return (
      member.kind !== ts.SyntaxKind.UndefinedKeyword &&
      !(ts.isLiteralTypeNode(member) && member.literal.kind === ts.SyntaxKind.NullKeyword)
    );
  });
}

function isTypeScriptCollectionType(node: ts.TypeNode): boolean {
  while (ts.isParenthesizedTypeNode(node)) node = node.type;
  if (ts.isTypeOperatorNode(node) && node.operator === ts.SyntaxKind.ReadonlyKeyword) {
    return isTypeScriptCollectionType(node.type);
  }
  if (ts.isArrayTypeNode(node)) return true;
  if (!ts.isTypeReferenceNode(node)) return false;
  const name = getNodeName(node.typeName);
  if (name === 'Readonly' && node.typeArguments?.length === 1) {
    return isTypeScriptCollectionType(node.typeArguments[0]!);
  }
  return (
    name === 'Array' ||
    name === 'ReadonlyArray' ||
    name === 'BigInt64Array' ||
    name === 'BigUint64Array' ||
    name === 'Float32Array' ||
    name === 'Float64Array' ||
    name === 'Int8Array' ||
    name === 'Int16Array' ||
    name === 'Int32Array' ||
    name === 'Uint8Array' ||
    name === 'Uint8ClampedArray' ||
    name === 'Uint16Array' ||
    name === 'Uint32Array'
  );
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

function getEntityRuntimeStripDoubleAssertionGuidance(
  node: ts.AsExpression | ts.TypeAssertion,
  subject: string,
  bridge: 'any' | 'never' | 'unknown',
): string | undefined {
  if (
    subject !== 'function:stripEntityRuntime' ||
    bridge !== 'unknown' ||
    !normalizePathPortable(node.getSourceFile().fileName).endsWith('/packages/entity/src/clone.ts') ||
    !isNamedGenericTypeReference(getTypeAssertionType(node), 'EntityWithoutRuntime', 'Type')
  ) {
    return undefined;
  }
  let inner: ts.Expression = node.expression;
  while (ts.isParenthesizedExpression(inner)) inner = inner.expression;
  if (!isTypeAssertion(inner) || getTypeAssertionType(inner).kind !== ts.SyntaxKind.UnknownKeyword) return undefined;
  let retained: ts.Expression = inner.expression;
  while (ts.isParenthesizedExpression(retained)) retained = retained.expression;
  if (!ts.isIdentifier(retained) || retained.text !== 'copy') return undefined;
  if (!ts.isReturnStatement(node.parent) || node.parent.expression !== node) return undefined;
  const body = node.parent.parent;
  if (!ts.isBlock(body) || !ts.isFunctionDeclaration(body.parent) || body.parent.name?.text !== 'stripEntityRuntime') {
    return undefined;
  }
  if (!isNamedGenericTypeReference(body.parent.type, 'EntityWithoutRuntime', 'Type')) return undefined;
  const copy = getVariableDeclaration(body, 'copy');
  if (!copy?.initializer || !ts.isAsExpression(copy.initializer)) return undefined;
  if (!isPropertyKeyUnknownRecord(copy.initializer.type)) return undefined;
  const clone = copy.initializer.expression;
  if (
    !ts.isObjectLiteralExpression(clone) ||
    clone.properties.length !== 1 ||
    !ts.isSpreadAssignment(clone.properties[0]!) ||
    !ts.isIdentifier(clone.properties[0]!.expression) ||
    clone.properties[0]!.expression.text !== 'source'
  ) {
    return undefined;
  }
  if (!body.statements.some(isEntityRuntimeKeyDeleteFromCopy)) return undefined;
  return `${subject} uses ${bridge} only to project the fresh { ...source } clone after delete copy[EntityRuntimeKey] into EntityWithoutRuntime<Type>. The spread creates a new generic Type row owner, Record<PropertyKey, unknown> supplies the symbol-keyed mutation view, and deleting the declared EntityRuntimeKey removes the sole cell excluded by EntityWithoutRuntime<Type>; every other Type cell stays on the same copy owner with its exact representation. Express this as one named generic entity-runtime strip operation, or return the compiler-proven Omit projection directly, so the source no longer needs a double assertion. This proof is limited to the fresh clone, the PropertyKey record view, the exact runtime-key deletion, and the matching EntityWithoutRuntime<Type> result; an arbitrary owner, key, or Omit assertion is not representation evidence. A reviewed source-portability exception is not justified for a general double assertion. The compiler may clone the generic row once, clear its runtime slot, and preserve that clone as the projected result, but will not route it through Any, cast or reinterpret the source owner, copy or materialize a second replacement, or add side storage.`;
}

function getEntityGuardProxyDoubleAssertionGuidance(
  node: ts.AsExpression | ts.TypeAssertion,
  subject: string,
  bridge: 'any' | 'never' | 'unknown',
): string | undefined {
  const guardedEntity = subject === 'function:createGuardedEntity/function:set';
  const guardedRuntime = subject === 'function:createGuardedEntityRuntime/function:set';
  if (
    bridge !== 'unknown' ||
    (!guardedEntity && !guardedRuntime) ||
    !normalizePathPortable(node.getSourceFile().fileName).endsWith('/packages/entity/src/guards.ts') ||
    !isPropertyKeyUnknownRecord(getTypeAssertionType(node))
  ) {
    return undefined;
  }
  let inner: ts.Expression = node.expression;
  while (ts.isParenthesizedExpression(inner)) inner = inner.expression;
  if (!isTypeAssertion(inner) || getTypeAssertionType(inner).kind !== ts.SyntaxKind.UnknownKeyword) return undefined;
  let retained: ts.Expression = inner.expression;
  while (ts.isParenthesizedExpression(retained)) retained = retained.expression;
  if (!ts.isIdentifier(retained) || retained.text !== 'target') return undefined;
  let targetView: ts.Expression = node;
  while (ts.isParenthesizedExpression(targetView.parent) && targetView.parent.expression === targetView) {
    targetView = targetView.parent;
  }
  const access = targetView.parent;
  if (
    !ts.isElementAccessExpression(access) ||
    access.expression !== targetView ||
    !ts.isIdentifier(access.argumentExpression) ||
    access.argumentExpression.text !== 'prop'
  ) {
    return undefined;
  }
  const assignment = access.parent;
  if (
    !ts.isBinaryExpression(assignment) ||
    assignment.left !== access ||
    assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
    !ts.isIdentifier(assignment.right) ||
    assignment.right.text !== 'value'
  ) {
    return undefined;
  }
  const statement = assignment.parent;
  if (!ts.isExpressionStatement(statement) || statement.expression !== assignment || !ts.isBlock(statement.parent)) {
    return undefined;
  }
  const block = statement.parent;
  const statementIndex = block.statements.indexOf(statement);
  const observation = block.statements[statementIndex - 1];
  const success = block.statements[statementIndex + 1];
  if (
    statementIndex < 0 ||
    !observation ||
    !isEntityGuardSlotObservation(observation, guardedEntity) ||
    !success ||
    !ts.isReturnStatement(success) ||
    success.expression?.kind !== ts.SyntaxKind.TrueKeyword
  ) {
    return undefined;
  }
  const owner = guardedEntity ? 'generic Type & Entity' : 'EntityRuntime';
  const observedSlot = guardedEntity ? 'EntityRuntimeKey runtime slot' : 'binding slot';
  return `${subject} uses a double assertion through unknown only to forward the Proxy set trap's PropertyKey and unknown value onto the same ${owner} target after observing the ${observedSlot}. This is an open interception protocol over a retained typed owner, not evidence that the owner is mutable Record<PropertyKey, unknown> storage: that record view erases the declared types of every known cell, while a finite-key rewrite would stop the proxy from forwarding ordinary entity writes. Replace the asserted element assignment with Reflect.set(target, prop, value) and return its boolean result, or route it through one named proxy-write forwarder with the same target, key, value, receiver, setter/prototype, and success semantics. If the guard deliberately promises every forwarded write succeeds, make that invariant explicit in the forwarder rather than discarding a false result with return true. The compiler will preserve the exact target owner, trap ordering, observed slot, and forwarded value identity, but will not reinterpret or cast the owner as a Record, route declared cells through Any, assume the unknown value satisfies an arbitrary known property, copy or materialize the target, suppress the forwarding result, or add side storage.`;
}

function isEntityGuardSlotObservation(statement: ts.Statement, guardedEntity: boolean): boolean {
  if (!ts.isIfStatement(statement)) return false;
  const conditions: ts.Expression[] = [statement.expression];
  for (let index = 0; index < conditions.length; index += 1) {
    const condition = conditions[index]!;
    if (ts.isBinaryExpression(condition) && condition.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
      conditions.push(condition.left, condition.right);
      continue;
    }
    if (
      !ts.isBinaryExpression(condition) ||
      condition.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken ||
      !ts.isIdentifier(condition.left) ||
      condition.left.text !== 'prop'
    ) {
      continue;
    }
    if (guardedEntity && ts.isIdentifier(condition.right) && condition.right.text === 'EntityRuntimeKey') return true;
    if (!guardedEntity && ts.isStringLiteral(condition.right) && condition.right.text === 'binding') return true;
  }
  return false;
}

function isNamedGenericTypeReference(node: ts.TypeNode | undefined, name: string, argumentName: string): boolean {
  if (!node || !ts.isTypeReferenceNode(node) || getNodeName(node.typeName) !== name) return false;
  const argument = node.typeArguments?.[0];
  return (
    node.typeArguments?.length === 1 &&
    argument !== undefined &&
    ts.isTypeReferenceNode(argument) &&
    getNodeName(argument.typeName) === argumentName
  );
}

function isPropertyKeyUnknownRecord(node: ts.TypeNode): boolean {
  if (!ts.isTypeReferenceNode(node) || getNodeName(node.typeName) !== 'Record') return false;
  const [key, value] = node.typeArguments ?? [];
  return (
    node.typeArguments?.length === 2 &&
    key !== undefined &&
    ts.isTypeReferenceNode(key) &&
    getNodeName(key.typeName) === 'PropertyKey' &&
    value?.kind === ts.SyntaxKind.UnknownKeyword
  );
}

function getVariableDeclaration(body: ts.Block, name: string): ts.VariableDeclaration | undefined {
  for (const statement of body.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name) return declaration;
    }
  }
  return undefined;
}

function isEntityRuntimeKeyDeleteFromCopy(statement: ts.Statement): boolean {
  if (!ts.isExpressionStatement(statement) || !ts.isDeleteExpression(statement.expression)) return false;
  const target = statement.expression.expression;
  return (
    ts.isElementAccessExpression(target) &&
    ts.isIdentifier(target.expression) &&
    target.expression.text === 'copy' &&
    ts.isIdentifier(target.argumentExpression) &&
    target.argumentExpression.text === 'EntityRuntimeKey'
  );
}

function getNodeBoundsParentDoubleAssertionGuidance(
  node: ts.AsExpression | ts.TypeAssertion,
  subject: string,
  bridge: 'any' | 'never' | 'unknown',
): string | undefined {
  if (
    bridge !== 'unknown' ||
    (subject !== 'function:getNodeHeight' && subject !== 'function:getNodeWidth') ||
    !normalizePathPortable(node.getSourceFile().fileName).endsWith('/packages/node/src/boundsRectangle.ts')
  ) {
    return undefined;
  }
  const target = getTypeAssertionType(node);
  if (!hasNullType(target) || hasUndefinedType(target)) return undefined;
  const present = getMixedAbsencePresentTypes(target);
  if (present.length !== 1 || !isNamedGenericTypeReference(present[0], 'Spatial2DNode', 'Traits')) {
    return undefined;
  }
  let inner: ts.Expression = node.expression;
  while (ts.isParenthesizedExpression(inner)) inner = inner.expression;
  if (!isTypeAssertion(inner) || getTypeAssertionType(inner).kind !== ts.SyntaxKind.UnknownKeyword) return undefined;
  let retained: ts.Expression = inner.expression;
  while (ts.isParenthesizedExpression(retained)) retained = retained.expression;
  if (
    !ts.isCallExpression(retained) ||
    !ts.isIdentifier(retained.expression) ||
    retained.expression.text !== 'getNodeParent' ||
    retained.arguments.length !== 1 ||
    !ts.isIdentifier(retained.arguments[0]!) ||
    retained.arguments[0]!.text !== 'source'
  ) {
    return undefined;
  }
  if (
    !ts.isCallExpression(node.parent) ||
    !ts.isIdentifier(node.parent.expression) ||
    node.parent.expression.text !== 'computeNodeBoundsRectangle' ||
    node.parent.arguments[2] !== node
  ) {
    return undefined;
  }
  return `${subject} uses a double assertion through unknown to claim that getNodeParent(source), whose declared result is NodeOf<Traits> | null, also carries the Spatial2DNode<Traits> bounds and transform capabilities required as computeNodeBoundsRectangle's target coordinate space. The current Spatial2DNode alias appends HasBoundsRectangle and HasTransform2D outside Traits, while these getters quantify only Traits extends object, so the shared Traits parameter does not prove that a parent returned by the node runtime owns either capability. The concrete Node2D family already names Node2DRuntime and Node2DTraits, and Node2DTraits includes both spatial capabilities; the generic alias and getter signatures are the boundary that discards that family proof. getNodeHeight and getNodeWidth deliberately measure the parent-space axis-aligned box for GUI sizing, resize, orientation extent, and scroll limits, and setNodeHeight and setNodeWidth are its inverse; substituting null or source would select source-local space instead. Put the spatial capabilities inside the family contract: define or constrain Traits to a named HasBoundsRectangle & HasTransform2D base, accept the matching NodeOf<Traits> spatial owner, and pass getNodeParent(source) directly once NodeRuntime<Traits>.parent retains that proof. If the hierarchy genuinely permits a non-spatial parent, use a typed spatial predicate and choose null or another explicit coordinate space when it fails. Do not whitelist the missing family proof or change the coordinate space to avoid the assertion. The compiler will preserve the exact parent owner and null sentinel, but will not infer intersection members that the generic parameter omits, reinterpret or cast the parent, copy or materialize a replacement node, synthesize bounds or transform state, or add side storage.`;
}

interface RuntimeFactoryDoubleAssertionGuidance {
  readonly baseRuntimeType: string;
  readonly fallbackDescription: string;
  readonly fallbackFactory: string;
  readonly genericType: string;
  readonly invocation: string;
  readonly repair: string;
  readonly targetFactoryType: string;
}

function renderRuntimeFactoryDoubleAssertionGuidance(
  subject: string,
  guidance: RuntimeFactoryDoubleAssertionGuidance,
): string {
  return `${subject} uses a double assertion through unknown to treat the ${guidance.fallbackDescription} as ${guidance.targetFactoryType}. ${guidance.genericType} is a caller-selected subtype constrained only by ${guidance.baseRuntimeType}, while ${guidance.fallbackFactory} produces the base ${guidance.baseRuntimeType}; the fallback cannot promise subtype-only fields or initialization, and the assertion also hides the factories' distinct optional input contracts even though ${guidance.invocation}. ${guidance.repair} Alternatively, name a zero-argument NodeRuntimeAllocator<${guidance.baseRuntimeType}> seam that accepts subtype-producing allocators covariantly. If callers must observe ${guidance.genericType}, expose that relation in the constructed node result instead of inventing it on the default branch. The compiler will preserve the exact produced runtime owner and its declared generic relation, but will not infer subtype members, reinterpret or cast a factory, call a factory with a synthetic seed, copy or materialize a runtime, or add side storage.`;
}

function getNodeRuntimeFactoryDoubleAssertionGuidance(
  node: ts.AsExpression | ts.TypeAssertion,
  subject: string,
  bridge: 'any' | 'never' | 'unknown',
): string | undefined {
  if (bridge !== 'unknown') return undefined;
  const source = normalizePathPortable(node.getSourceFile().fileName);
  const target = getTypeAssertionType(node);
  const isInitializeNode =
    subject === 'function:initializeNode' &&
    source.endsWith('/packages/node/src/node.ts') &&
    isNamedGenericTypeReference(target, 'NodeRuntimeFactory', 'Runtime');
  const isCreateNode2D =
    subject === 'function:createNode2D' &&
    source.endsWith('/packages/scene2d/src/displayObject.ts') &&
    isNamedGenericTypeReference(target, 'NodeRuntimeFactory', 'R');
  if (!isInitializeNode && !isCreateNode2D) return undefined;

  const fallbackFactory = isInitializeNode ? 'createNodeRuntime' : 'createNode2DRuntime';
  const selectedFactory = isInitializeNode ? 'createNodeRuntimeFactory' : 'createNode2DRuntimeFactory';
  let inner: ts.Expression = node.expression;
  while (ts.isParenthesizedExpression(inner)) inner = inner.expression;
  if (!isTypeAssertion(inner) || getTypeAssertionType(inner).kind !== ts.SyntaxKind.UnknownKeyword) return undefined;
  let retained: ts.Expression = inner.expression;
  while (ts.isParenthesizedExpression(retained)) retained = retained.expression;
  if (!ts.isIdentifier(retained) || retained.text !== fallbackFactory) return undefined;
  let selected: ts.Expression = node;
  while (ts.isParenthesizedExpression(selected.parent) && selected.parent.expression === selected) {
    selected = selected.parent;
  }
  const selection = selected.parent;
  if (
    !ts.isBinaryExpression(selection) ||
    selection.operatorToken.kind !== ts.SyntaxKind.QuestionQuestionToken ||
    selection.right !== selected ||
    !ts.isIdentifier(selection.left) ||
    selection.left.text !== selectedFactory
  ) {
    return undefined;
  }

  if (isInitializeNode) {
    const declaration = selection.parent;
    if (
      !ts.isVariableDeclaration(declaration) ||
      declaration.initializer !== selection ||
      !ts.isIdentifier(declaration.name) ||
      declaration.name.text !== 'runtimeFactory'
    ) {
      return undefined;
    }
    return renderRuntimeFactoryDoubleAssertionGuidance(subject, {
      baseRuntimeType: 'NodeRuntime<Traits>',
      fallbackDescription: 'generic createNodeRuntime fallback',
      fallbackFactory,
      genericType: 'Runtime',
      invocation: 'initializeNode invokes the selected factory with no argument',
      repair:
        'createNode forwards this optional factory unchanged, while initializeNode is also the shared layer used by the exact 2D and 3D runtime factories; no caller passes a seed. Branch before the call: invoke createNodeRuntimeFactory() when it is present, otherwise invoke createNodeRuntime<Traits>(), then store the resulting exact runtime owner through Node<Traits>[EntityRuntimeKey], whose declared base slot accepts either result. Do not whitelist the erased subtype promise: createNode returns Node<Traits> & Traits and exposes no Runtime relation that could make the fallback claim observable or true.',
      targetFactoryType: 'NodeRuntimeFactory<Runtime>',
    });
  }

  const call = selection.parent;
  if (
    !ts.isCallExpression(call) ||
    !ts.isIdentifier(call.expression) ||
    call.expression.text !== 'initializeNode' ||
    call.arguments.length !== 5 ||
    call.arguments[4] !== selection
  ) {
    return undefined;
  }
  return renderRuntimeFactoryDoubleAssertionGuidance(subject, {
    baseRuntimeType: 'Node2DRuntime',
    fallbackDescription: 'base createNode2DRuntime fallback',
    fallbackFactory,
    genericType: 'R',
    invocation: 'createNode2D forwards the selected factory to initializeNode, which invokes it with no argument',
    repair:
      'Select a zero-argument allocator before initializeNode: use () => createNode2DRuntimeFactory() when it is present and createNode2DRuntime otherwise, then pass that exact NodeRuntimeAllocator<Node2DRuntime>. Because createNode2D returns Node2D rather than a result exposing R, remove the caller-selected R parameter unless the public result is changed to carry that relation.',
    targetFactoryType: 'NodeRuntimeFactory<R>',
  });
}

function getTextureCubeFacesDoubleAssertionGuidance(
  node: ts.AsExpression | ts.TypeAssertion,
  subject: string,
  bridge: 'any' | 'never' | 'unknown',
): string | undefined {
  if (bridge !== 'unknown') return undefined;
  const sourceFile = node.getSourceFile();
  const source = normalizePathPortable(sourceFile.fileName);
  let inner: ts.Expression = node.expression;
  while (ts.isParenthesizedExpression(inner)) inner = inner.expression;
  if (!isTypeAssertion(inner) || getTypeAssertionType(inner).kind !== ts.SyntaxKind.UnknownKeyword) return undefined;
  let retained: ts.Expression = inner.expression;
  while (ts.isParenthesizedExpression(retained)) retained = retained.expression;
  const target = getTypeAssertionType(node);
  if (
    source.endsWith('/packages/texture/src/texture.ts') &&
    ts.isTypeReferenceNode(target) &&
    getNodeName(target.typeName) === 'TextureSourceCubeFaces' &&
    target.typeArguments === undefined
  ) {
    if (
      (subject === 'function:cloneTexture' || subject === 'function:copyTexture') &&
      isSourceTextureFacesSlice(retained)
    ) {
      return `${subject} uses a double assertion through unknown to claim that source.sources.slice() is the fixed six-slot TextureSourceCubeFaces carrier. slice allocates one fresh array and preserves element order, but its array return type does not prove the +X, -X, +Y, -Y, +Z, and -Z extent. Construct the clone as an explicit six-element tuple with one indexed read for each declared face, or route through a named cloneTextureSourceCubeFaces helper that returns that exact tuple, retaining every TextureSource identity and null sentinel. The compiler may allocate one new six-slot carrier, but will not infer tuple length from slice, reinterpret or cast an array, collapse null into a missing face, copy or materialize a TextureSource owner, or add side storage.`;
    }
    if (subject === 'function:createTexture' && isOptionalTextureFacesSliceWithSixNullFallback(retained)) {
      return `${subject} uses a double assertion through unknown to claim that opts.sources?.slice() ?? [null, null, null, null, null, null] is the fixed six-slot TextureSourceCubeFaces carrier. The fallback literal has the required extent, and a present opts.sources already has that declared extent, but optional chaining plus slice widens the combined expression to an ordinary array and the assertion does not restore the proof. Branch once: clone a present value through a named six-face tuple helper, otherwise construct the explicit six-null tuple, preserving every supplied TextureSource identity, canonical face order, and null sentinel. The compiler may allocate one new six-slot carrier, but will not infer tuple length across slice and ??, reinterpret or cast an array, replace a supplied face list with the fallback, copy or materialize a TextureSource owner, or add side storage.`;
    }
    return undefined;
  }
  if (
    source.endsWith('/packages/texture/src/cubeTexture.ts') &&
    subject === 'function:setCubeTextureFace' &&
    isNullableTextureSourceArrayType(target) &&
    ts.isIdentifier(retained) &&
    retained.text === 'sources' &&
    isTextureFaceIndexedAssignment(node)
  ) {
    return `${subject} uses a double assertion through unknown to widen the exact readonly six-slot TextureSourceCubeFaces carrier sources into a mutable unbounded (TextureSource | null)[] for the faceIndex write. That bridge grants writability and discards the fixed extent without proving either capability. Give CubeTexture a named mutable six-slot face-storage carrier while exposing a readonly six-face view at input and read boundaries, narrow faceIndex to the closed 0 | 1 | 2 | 3 | 4 | 5 domain or dispatch those cases, and update the selected slot on that same storage owner. The compiler will preserve the six face slots and each TextureSource identity, but will not cast away readonly, widen bounded tuple storage, accept an out-of-range index, copy or materialize the face array or a TextureSource owner, or add side storage.`;
  }
  return undefined;
}

function isSourceTextureFacesSlice(node: ts.Expression): boolean {
  if (!ts.isCallExpression(node) || node.arguments.length !== 0 || !ts.isPropertyAccessExpression(node.expression)) {
    return false;
  }
  const slice = node.expression;
  return (
    slice.name.text === 'slice' &&
    ts.isPropertyAccessExpression(slice.expression) &&
    ts.isIdentifier(slice.expression.expression) &&
    slice.expression.expression.text === 'source' &&
    slice.expression.name.text === 'sources'
  );
}

function isOptionalTextureFacesSliceWithSixNullFallback(node: ts.Expression): boolean {
  if (!ts.isBinaryExpression(node) || node.operatorToken.kind !== ts.SyntaxKind.QuestionQuestionToken) return false;
  const fallback = node.right;
  if (
    !ts.isArrayLiteralExpression(fallback) ||
    fallback.elements.length !== 6 ||
    fallback.elements.some((element) => element.kind !== ts.SyntaxKind.NullKeyword)
  ) {
    return false;
  }
  const left = node.left;
  if (!ts.isCallExpression(left) || left.arguments.length !== 0 || !ts.isPropertyAccessChain(left.expression)) {
    return false;
  }
  const slice = left.expression;
  if (slice.name.text !== 'slice' || slice.questionDotToken === undefined) return false;
  const faces = slice.expression;
  return (
    ts.isPropertyAccessExpression(faces) &&
    ts.isIdentifier(faces.expression) &&
    faces.expression.text === 'opts' &&
    faces.name.text === 'sources'
  );
}

function isNullableTextureSourceArrayType(node: ts.TypeNode): boolean {
  if (!ts.isArrayTypeNode(node)) return false;
  let element = node.elementType;
  while (ts.isParenthesizedTypeNode(element)) element = element.type;
  if (!ts.isUnionTypeNode(element) || element.types.length !== 2) return false;
  return (
    element.types.some(
      (type) => ts.isTypeReferenceNode(type) && getNodeName(type.typeName) === 'TextureSource' && !type.typeArguments,
    ) && element.types.some((type) => hasNullType(type))
  );
}

function isTextureFaceIndexedAssignment(node: ts.AsExpression | ts.TypeAssertion): boolean {
  let current: ts.Expression = node;
  while (ts.isParenthesizedExpression(current.parent) && current.parent.expression === current)
    current = current.parent;
  const indexed = current.parent;
  if (
    !ts.isElementAccessExpression(indexed) ||
    indexed.expression !== current ||
    !ts.isIdentifier(indexed.argumentExpression) ||
    indexed.argumentExpression.text !== 'faceIndex'
  ) {
    return false;
  }
  const assignment = indexed.parent;
  return (
    ts.isBinaryExpression(assignment) &&
    assignment.left === indexed &&
    assignment.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    ts.isIdentifier(assignment.right) &&
    assignment.right.text === 'source'
  );
}

function getMaterialDoubleAssertionGuidance(
  node: ts.AsExpression | ts.TypeAssertion,
  subject: string,
  bridge: 'any' | 'never' | 'unknown',
): string | undefined {
  const sourceFile = node.getSourceFile();
  if (!normalizePathPortable(sourceFile.fileName).endsWith('/packages/materials/src/material.ts')) {
    return undefined;
  }
  const target = getTypeAssertionType(node);
  if (
    !ts.isTypeReferenceNode(target) ||
    getNodeName(target.typeName) !== 'Record' ||
    target.typeArguments?.length !== 2 ||
    target.typeArguments[0]?.kind !== ts.SyntaxKind.StringKeyword ||
    target.typeArguments[1]?.kind !== ts.SyntaxKind.UnknownKeyword
  ) {
    return undefined;
  }
  let inner: ts.Expression = node.expression;
  while (ts.isParenthesizedExpression(inner)) inner = inner.expression;
  if (!isTypeAssertion(inner)) return undefined;
  let retainedExpression: ts.Expression = inner.expression;
  while (ts.isParenthesizedExpression(retainedExpression)) retainedExpression = retainedExpression.expression;
  const retainedSlot = retainedExpression.getText(sourceFile);
  if (retainedSlot === 'dst') {
    return `${subject} uses a double assertion through ${bridge} to name the concrete ${retainedSlot} Material owner as writable Record<string, unknown> storage, but those carriers are not representation-equivalent and the owner-preserving NamedProperties view is deliberately read-only. Material is an open kind family, so this site has no finite declared member set the compiler can dispatch. Route copying through a per-kind typed material copier and factory that retain and construct the exact concrete Material owner, or add an owner-preserving checked NamedProperties::set(String, Any) target-runtime contract that mutates an existing declared cell. The compiler will not reinterpret or cast the owner, copy into replacement storage, materialize a replacement owner, or add side storage.`;
  }
  if (retainedSlot === 'a' || retainedSlot === 'b' || retainedSlot === 'src') {
    const role = retainedSlot === 'src' ? 'copy source' : 'equality operand';
    return `${subject} uses a double assertion through ${bridge} to name the ${retainedSlot} ${role} as Record<string, unknown>, but the value remains its exact concrete Material owner rather than becoming keyed Record storage. A portable read can retain that owner behind a read-only NamedProperties view for Object.keys, Object.hasOwn, and computed value reads; no Record is constructed. Prefer a named material-reflection helper or a per-kind typed ${retainedSlot === 'src' ? 'copy' : 'equality'} operation, and record a reviewed source-portability exception only if this open-family reflective read is the intended boundary. The compiler may lower the owner-preserving read view, but will not cast the owner, copy or materialize a Record, or add side storage.`;
  }
  return undefined;
}

function getGltfMaterialExtensionDoubleAssertionGuidance(
  node: ts.AsExpression | ts.TypeAssertion,
  subject: string,
  bridge: 'any' | 'never' | 'unknown',
): string | undefined {
  const sourceFile = node.getSourceFile();
  if (!normalizePathPortable(sourceFile.fileName).endsWith('/packages/scene3d-formats/src/gltfMaterialExtension.ts')) {
    return undefined;
  }
  const target = getTypeAssertionType(node);
  if (!ts.isTypeReferenceNode(target)) return undefined;
  const targetName = getNodeName(target.typeName);
  let inner: ts.Expression = node.expression;
  while (ts.isParenthesizedExpression(inner)) inner = inner.expression;
  if (!isTypeAssertion(inner)) return undefined;
  let retainedExpression: ts.Expression = inner.expression;
  while (ts.isParenthesizedExpression(retainedExpression)) retainedExpression = retainedExpression.expression;
  const retainedSlot = retainedExpression.getText(sourceFile);
  if (targetName === 'MaterialLike' && retainedSlot === 'promoted') {
    return `${subject} uses a double assertion through ${bridge} to store the exact promoted ExtendedPbrMaterial owner as MaterialLike, but MaterialLike is EntityWithoutRuntime<Material>: removing the runtime key is identity-preserving and therefore retains the base Material owner rather than the promoted concrete owner. Flight's emitted Material and ExtendedPbrMaterial interfaces are independent owner carriers, so they are not representation-equivalent even though TypeScript accepts the structural view. Give Scene3DDocument.materials a closed union of EntityWithoutRuntime for each supported concrete material owner, then store promoted directly in its ExtendedPbrMaterial arm. The compiler will preserve an exact or representation-equivalent carrier, but will not reinterpret or cast the owner, copy or materialize a replacement material, or add side storage.`;
  }
  if (
    (targetName !== 'ExtendedPbrMaterial' && targetName !== 'StandardPbrMaterial') ||
    (retainedSlot !== 'existing' && retainedSlot !== 'material')
  ) {
    return undefined;
  }
  const access = retainedSlot === 'material' ? 'read' : targetName === 'ExtendedPbrMaterial' ? 'update' : 'promotion';
  return `${subject} uses a double assertion through ${bridge} to recover ${targetName} for the ${access} from ${retainedSlot}, but the Scene3DDocument.materials slot retains only MaterialLike's EntityWithoutRuntime<Material> base owner. The preceding kind comparison checks a shared open registry string; it does not prove that the retained Material owner is the independent ${targetName} owner or supply that owner's declared cells. Give the document slot a closed union of EntityWithoutRuntime for the supported concrete material owners so the kind discriminant narrows to the exact ${targetName} carrier, or use an owner-preserving checked registry recovery that validates that concrete owner. The compiler will preserve an exact or representation-equivalent carrier, but will not reinterpret or cast the base owner, copy or materialize a replacement material, or add side storage.`;
}

function getAwd2MaterialHandlerDoubleAssertionGuidance(
  node: ts.AsExpression | ts.TypeAssertion,
  subject: string,
  bridge: 'any' | 'never' | 'unknown',
): string | undefined {
  const sourceFile = node.getSourceFile();
  if (!normalizePathPortable(sourceFile.fileName).endsWith('/packages/scene3d-formats/src/awd2MaterialHandler.ts')) {
    return undefined;
  }
  const target = getTypeAssertionType(node);
  if (!ts.isTypeReferenceNode(target)) return undefined;
  const targetName = getNodeName(target.typeName);
  let inner: ts.Expression = node.expression;
  while (ts.isParenthesizedExpression(inner)) inner = inner.expression;
  if (!isTypeAssertion(inner)) return undefined;
  let retainedExpression: ts.Expression = inner.expression;
  while (ts.isParenthesizedExpression(retainedExpression)) retainedExpression = retainedExpression.expression;
  const retainedSlot = retainedExpression.getText(sourceFile);
  if (
    targetName === 'Material' &&
    ts.isCallExpression(retainedExpression) &&
    ts.isIdentifier(retainedExpression.expression) &&
    retainedExpression.expression.text === 'createShadedMaterial'
  ) {
    return `${subject} uses a double assertion through ${bridge} to replace the exact ShadedMaterial owner returned by createShadedMaterial with the base Material owner. Flight emits those interfaces as independent reference owners, so inherited TypeScript structure does not make their carriers representation-equivalent. Keep the factory result as ShadedMaterial and use its declared SurfaceMaterial trailer and Material name fields directly. The compiler will preserve the exact ShadedMaterial carrier, but will not reinterpret or cast it as Material, copy or materialize a replacement owner, or add side storage.`;
  }
  if (targetName === 'SurfaceMaterial' && retainedSlot === 'material') {
    return `${subject} uses a double assertion through ${bridge} to recover SurfaceMaterial from material after the local binding has already retained only the base Material owner. The earlier createShadedMaterial call does not travel through that base-typed owner, and Material declares no alphaMode or other SurfaceMaterial trailer cells. Keep material as the exact ShadedMaterial factory result and assign alphaMode directly on that owner. The compiler will not reinterpret or cast the base owner, copy or materialize a replacement surface material, or add side storage.`;
  }
  if (targetName === 'MaterialLike' && retainedSlot === 'material') {
    return `${subject} uses a double assertion through ${bridge} from Material to MaterialLike, but MaterialLike is EntityWithoutRuntime<Material>, an identity-preserving view of that same Material owner. This bridge is representation-equivalent and can remain a carrier no-op, but it cannot restore the ShadedMaterial owner erased by the earlier assertion. Remove the redundant assertion; for an end-to-end portable import, retain ShadedMaterial from createShadedMaterial and store it in a concrete EntityWithoutRuntime<ShadedMaterial> arm of the document material union. The compiler will preserve the same represented Material carrier here, but will not use that equivalence to cast back to ShadedMaterial, copy or materialize a replacement, or add side storage.`;
  }
  return undefined;
}

function getSignalCallableDoubleAssertionGuidance(
  node: ts.AsExpression | ts.TypeAssertion,
  subject: string,
  bridge: 'any' | 'never' | 'unknown',
): string | undefined {
  const sourceFile = node.getSourceFile();
  const source = normalizePathPortable(sourceFile.fileName);
  const signalModule = ['connection.ts', 'safe.ts', 'signal.ts', 'slot.ts'].find((file) =>
    source.endsWith(`/packages/signals/src/${file}`),
  );
  if (!signalModule) return undefined;
  const target = getTypeAssertionType(node);
  if (!ts.isTypeReferenceNode(target) || getNodeName(target.typeName) !== 'T') return undefined;
  let inner: ts.Expression = node.expression;
  while (ts.isParenthesizedExpression(inner)) inner = inner.expression;
  if (!isTypeAssertion(inner)) return undefined;
  let implementation: ts.Expression = inner.expression;
  while (ts.isParenthesizedExpression(implementation)) implementation = implementation.expression;
  if (ts.isIdentifier(implementation) && implementation.text === 'nullSignalEmit') {
    if (signalModule === 'signal.ts') {
      return `${subject} uses a double assertion through ${bridge} to install the represented zero-argument nullSignalEmit implementation while initializing the EntityConstruction<Signal<T>> owner. The bridge is not representation equivalence: each T instantiation may require a different emitted parameter signature. Preserve that exact entity-under-construction owner and construct only its emit callable through the checked callable-signature binding contract, which deliberately ignores T's instantiated arguments for this no-op implementation. Prefer a named Signal argument-tuple/dispatch type and an exact typed no-op factory so the source no longer needs this assertion. The compiler may bind this represented callable implementation to T, but will not route it through Any, cast between callable carriers, copy or materialize the entity under construction, or add side storage; a non-callable or genuinely erased source must be refused.`;
    }
    if (signalModule === 'safe.ts') {
      return `${subject} uses a double assertion through ${bridge} to restore the represented zero-argument nullSignalEmit implementation after safe dispatch empties a signal. The bridge is not representation equivalence: each T instantiation may require a different emitted parameter signature. Preserve the exact Signal<T> and SignalData<T> owners, the safe-dispatch snapshots and every stored T slot, and construct only the emit callable through the checked callable-signature binding contract, which deliberately ignores T's instantiated arguments for this no-op implementation. Prefer a named Signal argument-tuple/dispatch type and an exact typed no-op factory so the source no longer needs this assertion. The compiler may bind this represented callable implementation to T, but will not route it through Any, cast between callable carriers, copy or materialize the signal/data owners, or add side storage; a non-callable or genuinely erased source must be refused.`;
    }
    if (signalModule !== 'slot.ts') return undefined;
    const lifecycle =
      subject === 'function:clearSignal'
        ? 'clearSignal replaces emit and data immediately; if an old dispatch is still running, its captured data finishes independently and the signal.data === data guard prevents its later compaction from stealing the explicit clear.'
        : subject === 'function:disconnectSignal'
          ? 'disconnectSignal reaches this reset only outside dispatch after splicing the matching slot plus its priority and repeat cells and observing that no slots remain; during dispatch it tombstones slots and defers the reset.'
          : subject === 'function:compactSignalData'
            ? 'compactSignalData is the deferred outermost-dispatch path: it preserves live slot identities while compacting the parallel slot, priority, and repeat arrays, truncates them together, and resets the signal only when no live slot remains and signal.data still names this captured data owner.'
            : 'The no-op replacement preserves the signal owner and removes its active dispatch state.';
    return `${subject} uses a double assertion through ${bridge} to install the represented zero-argument nullSignalEmit implementation in the open callable type parameter T. The bridge is not representation equivalence: T may be a callable subtype with extra structure, and each instantiation may require a different emitted parameter signature. ${lifecycle} The exact Signal<T> owner and SignalData<T> owner remain in place. SignalData<T> owns the parallel slots, priorities, and repeat arrays plus cancellation and nested-dispatch state; no signal, data owner, or slot callable is cloned. emitSignalSafe alone snapshots those three arrays so mutation during safe dispatch cannot move its cursor, and that snapshot retains the same slot function identities. Direct signal.emit calls and emitSignal both consume the installed callable with Parameters<T>, while connection, tracked-wrapper, throttle, and scope paths depend on exact slot identity for removal. Define one named SignalDispatch<T> = (...args: Parameters<T>) => void as the stored callable domain for Signal.emit, SignalData.slots, SignalConnection.slot, and connect/disconnect operations. Then createNullSignalDispatch<T>() can return (..._args: Parameters<T>) => void, and makeDispatch can return the same SignalDispatch<T> while forwarding its exact tuple; those named operations remove all four slot.ts double assertions without weakening any owner or clone contract. That assertion-free shape is valid source and semantic IR, but current C++ storage emission cannot resolve Parameters<T> for an open callable type, so no named operation alone makes this cluster end-to-end portable until a sound backend representation or a closed dispatch signature is provided. Do not whitelist these bridges or keep arbitrary callable-subtype T as the stored dispatch domain. The compiler may bind a represented callable implementation to an open signature, but will not route it through Any, cast between callable carriers, copy or materialize the Signal, data, or slots, invent callable-subtype members, or add side storage; a non-callable or genuinely erased source must be refused.`;
  }
  if (ts.isArrowFunction(implementation) || ts.isFunctionExpression(implementation)) {
    if (signalModule === 'connection.ts' && getEnclosingVariableName(node) === 'trackedSlot') {
      return `${subject} uses a double assertion through ${bridge} to name the represented trackedSlot closure as the open callable type parameter T. Its Parameters<T> rest tuple preserves the invocation signature, but the assertion itself does not prove the open carrier. Preserve the captured SignalConnection<T> and exact T slot, including the connection, once, and slot capture identities, and construct only the wrapper callable through the checked callable-signature binding contract so invocation uses T's instantiated parameter list. Prefer a named Signal argument tuple and express the tracked wrapper in that exact dispatch type so the source no longer needs this assertion. The compiler may bind this represented closure implementation to T, but will not route it through Any, reinterpret or cast a callable owner, copy or materialize the connection or slot owners, or add side storage; a non-callable or genuinely erased source must be refused.`;
    }
    if (signalModule !== 'slot.ts') return undefined;
    return `${subject} uses a double assertion through ${bridge} to name the newly created dispatch implementation as the open callable type parameter T after its rest arguments were declared as any[]. makeDispatch captures the exact Signal<T> and newly installed SignalData<T> owners. Each call clears cancellation, increments nested-dispatch depth, walks the live slots in priority order, forwards the one exact argument tuple, tombstones once slots without shifting the active cursor, stops on cancellation, and lets only the outermost exit compact or detach that same data owner. Direct signal.emit calls and emitSignal consume this callable; emitSignalSafe is separate and snapshots only the parallel slot, priority, and repeat arrays while preserving the same slot function identities. There is no Signal or SignalData clone. T may be a callable subtype with extra structure, so a plain closure cannot soundly claim arbitrary T. Define one named SignalDispatch<T> = (...args: Parameters<T>) => void as the stored callable domain for Signal.emit, SignalData.slots, SignalConnection.slot, and connect/disconnect operations. Declare this closure as (...args: Parameters<T>) => void and return SignalDispatch<T>; pair it with createNullSignalDispatch<T>() returning the same normalized type. Those named operations remove all four slot.ts double assertions—the makeDispatch assertion and the three no-op assertions—without weakening owner, mutation, or clone semantics. That assertion-free shape is valid source and semantic IR, but current C++ storage emission cannot resolve Parameters<T> for an open callable type, so no named operation alone makes this cluster end-to-end portable until a sound backend representation or a closed dispatch signature is provided. Do not whitelist these bridges or keep arbitrary callable-subtype T as the stored dispatch domain. The compiler may bind a represented function implementation to an open signature, but will not route it through Any, reinterpret or cast a callable owner, copy or materialize the signal, data, or slot owners, invent callable-subtype members, or add side storage; a non-callable or genuinely erased source must be refused.`;
  }
  return undefined;
}

function getGenericOwnerArgumentDoubleAssertionGuidance(
  node: ts.AsExpression | ts.TypeAssertion,
  subject: string,
  bridge: 'any' | 'never' | 'unknown',
): string | undefined {
  const target = getTypeAssertionType(node);
  if (!ts.isTypeReferenceNode(target) || !target.typeArguments?.length) return undefined;
  let inner: ts.Expression = node.expression;
  while (ts.isParenthesizedExpression(inner)) inner = inner.expression;
  if (!isTypeAssertion(inner)) return undefined;
  let retained: ts.Expression = inner.expression;
  while (ts.isParenthesizedExpression(retained)) retained = retained.expression;
  if (!ts.isIdentifier(retained)) return undefined;
  let body: ts.Block | undefined;
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (!ts.isFunctionLike(current) || !('body' in current)) continue;
    body = current.body && ts.isBlock(current.body) ? current.body : undefined;
    break;
  }
  const declaration = body ? getVariableDeclaration(body, retained.text) : undefined;
  const source = declaration?.type;
  if (
    !source ||
    !ts.isTypeReferenceNode(source) ||
    getNodeName(source.typeName) !== getNodeName(target.typeName) ||
    !source.typeArguments?.length ||
    source.typeArguments.length !== target.typeArguments.length
  ) {
    return undefined;
  }
  const sourceArguments = source.typeArguments.map((argument) => argument.getText(node.getSourceFile()));
  const targetArguments = target.typeArguments.map((argument) => argument.getText(node.getSourceFile()));
  if (sourceArguments.every((argument, index) => argument === targetArguments[index])) return undefined;
  const sourceType = source.getText(node.getSourceFile());
  const targetType = target.getText(node.getSourceFile());
  if (
    subject === 'function:connectSignalTracked' &&
    normalizePathPortable(node.getSourceFile().fileName).endsWith('/packages/signals/src/connection.ts') &&
    retained.text === 'connection' &&
    sourceType === 'SignalConnection<T>' &&
    targetType === 'SignalConnection<(...args: any[]) => void>'
  ) {
    return `${subject} uses a double assertion through ${bridge} to push the represented ${sourceType} owner into SignalScope.connections as ${targetType}. Sharing the generic declaration name does not make those instantiations representation-equivalent: T determines the signal and slot cells bound to this concrete connection. For the current bulk-disconnect scope contract, change the retained element contract to a named zero-argument disconnect operation, push a closure that captures this exact connection and calls disconnectSignalConnection(connection), and have disconnectSignalScope drain and invoke those operations; preserve connection as ${sourceType} for the return and individual-handle operations. If callers must retain heterogeneous handles rather than one closed operation, declare an explicit type-erased handle and target-runtime contract instead. The compiler will not treat type-parameter variance as representation equivalence, reinterpret or cast the owner, copy or materialize a replacement, or add side storage.`;
  }
  return `${subject} uses a double assertion through ${bridge} to re-parameterize the represented ${sourceType} owner as ${targetType}. Sharing the generic declaration name does not make those instantiations representation-equivalent: their type arguments determine the member and callable cells bound to each concrete owner. Preserve ${retained.text} as ${sourceType}. If heterogeneous storage needs only one closed operation, store an operation closure that captures this exact owner; otherwise declare an explicit type-erased handle and target-runtime contract instead of widening the generic owner. The compiler will preserve an unchanged generic instantiation, but will not treat type-parameter variance as representation equivalence, reinterpret or cast the owner, copy or materialize a replacement, or add side storage.`;
}

function getNodeInteractiveStateBindingDoubleAssertionGuidance(
  node: ts.AsExpression | ts.TypeAssertion,
  subject: string,
  bridge: 'any' | 'never' | 'unknown',
): string | undefined {
  const sourceFile = node.getSourceFile();
  const source = normalizePathPortable(sourceFile.fileName);
  if (!source.endsWith('/packages/interaction/src/nodeInteractiveStateBinding.ts')) return undefined;
  const target = getTypeAssertionType(node);
  if (!ts.isTypeReferenceNode(target)) return undefined;
  const targetName = getNodeName(target.typeName);
  let inner: ts.Expression = node.expression;
  while (ts.isParenthesizedExpression(inner)) inner = inner.expression;
  if (!isTypeAssertion(inner)) return undefined;
  let retainedExpression: ts.Expression = inner.expression;
  while (ts.isParenthesizedExpression(retainedExpression)) retainedExpression = retainedExpression.expression;
  const retainedSlot = retainedExpression.getText(sourceFile);
  if (targetName === 'NodeInteractiveStateBinding' && ts.isObjectLiteralExpression(retainedExpression)) {
    return `${subject} uses a double assertion through ${bridge} to claim that the fresh ${retainedSlot} literal is the branded NodeInteractiveStateBinding owner; its EntityRuntimeKey field does not prove that the literal shares the concrete Entity owner and binding facet tag represented by NodeInteractiveStateBinding. Construct the binding through the entity API that owns and initializes its runtime slot, and retain that exact binding type through accessors. If this construction is intentionally JavaScript-only, record a reviewed source-portability exception for this exact boundary. The compiler will preserve an already proven NodeInteractiveStateBinding carrier, but will not reinterpret this literal, cast it, copy or materialize a replacement owner, or add side storage.`;
  }
  if (targetName !== 'Record' || target.typeArguments?.length !== 2) return undefined;
  const key = target.typeArguments[0]!;
  const value = target.typeArguments[1]!;
  const finiteInteractiveKey =
    ts.isTypeReferenceNode(key) && getNodeName(key.typeName) === 'NodeInteractiveStateProperty';
  const openStringKey = key.kind === ts.SyntaxKind.StringKeyword;
  const unknownValue = value.kind === ts.SyntaxKind.UnknownKeyword;
  const transitionValue =
    ts.isTypeReferenceNode(value) && getNodeName(value.typeName) === 'NodeInteractiveStateTransitionValue';
  if ((finiteInteractiveKey || openStringKey) && unknownValue) {
    const keyDomain = finiteInteractiveKey ? 'the closed NodeInteractiveStateProperty key union' : 'a string key';
    return `${subject} uses a double assertion through ${bridge} to name ${retainedSlot} as Record storage for a read through ${keyDomain}, but the concrete Node owner beneath the assertion is not a Record and must retain its identity. A portable read may use an owner-preserving named-property view that reads the existing declared fields without constructing keyed storage; preferably accept a named Node2D/interactive capability and dispatch the finite property union to those fields. If this dynamic read is intentionally JavaScript-only, record a reviewed source-portability exception for this exact boundary. The compiler may lower the checked read view while retaining ${retainedSlot}, but will not cast the owner, copy or materialize a Record, or add side storage.`;
  }
  if (finiteInteractiveKey && transitionValue) {
    return `${subject} uses a double assertion through ${bridge} to name ${retainedSlot} as writable Record<NodeInteractiveStateProperty, NodeInteractiveStateTransitionValue> storage, but the concrete Node owner beneath the assertion is not representation-equivalent to that keyed carrier and a read-only named-property view cannot supply writes. Accept a named Node2D/interactive target that declares alpha, scaleX, scaleY, visible, x, and y, then dispatch the closed property union to those fields with the matching boolean or number value. If the open-object write is intentionally JavaScript-only, record a reviewed source-portability exception for this exact boundary. The compiler will not reinterpret or cast the owner, copy or materialize replacement keyed storage, or add side storage.`;
  }
  return undefined;
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
  const tiledJson = getTiledJsonOpaqueValueGuidance(node, subject, kinds);
  if (tiledJson) return tiledJson;
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
  const appLoopHandle = getAppLoopOpaqueFrameHandleGuidance(node, subject, kinds);
  if (appLoopHandle) return appLoopHandle;
  const nodeRuntimeSlot = getNodeRuntimeSlotOpaqueWriteGuidance(node, subject, kinds);
  if (nodeRuntimeSlot) return nodeRuntimeSlot;
  const commandValue = getCommandPropertyInputOpaqueValueGuidance(node, subject, kinds);
  if (commandValue) return commandValue;
  const materializationTraits = getSceneDocumentMaterializationOpaqueTraitsGuidance(node, subject, kinds);
  if (materializationTraits) return materializationTraits;
  const animationValue = getAnimationOpaqueValueGuidance(node, subject, kinds);
  if (animationValue) return animationValue;
  const flightContract = getFlightTypesOpaquePropertyGuidance(node, subject, kinds);
  if (flightContract) return flightContract;
  const shadingModifier = getShadingBuiltInModifierOpaqueMapGuidance(node, subject, kinds);
  if (shadingModifier) return shadingModifier;
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
  return `${subject} preserves an optional unknown error while constructing the public Tray creation result; ${flow} The value crosses createTrayIcon unchanged, is not inspected or serialized, and is not retained in TrayRuntime, so it remains genuinely provider-opaque rather than a recoverable portable domain. If portable consumers need machine-readable failure data, normalize at the catch or host-provider boundary into one named closed TrayErrorPayload shared by TrayCreateProviderResult, TrayCreateResult, these construction helpers, and consumers. If arbitrary caught or provider-supplied data is intentionally returned only as an unexamined diagnostic, record a reviewed source-portability exception for this exact property. The compiler will not infer Error, stringify the value, choose a target-specific Any carrier, insert a cast, or copy or materialize the payload.`;
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
    return `${subject} erases a stable binding identity even though the current producer and consumer roles are portable and exact. createAnimationChannel and initializeAnimationChannel accept any value and retain it; cloneAnimationClip reuses the exact reference; blend trees, crossfades, state machines, and layer stacks use it as a Map or Set identity key; and sampling passes the channel unchanged. Domain applicators then assert that same value to Node2DAnimationTarget, Scene3DAnimationTarget, MorphShapeAnimationTarget, Skeleton2DAnimationTarget, or format-local Lottie and Rive callback shapes. The skeleton path additionally reads kind and dispatches through an open binder registry before each binder casts the payload it owns. Scene3D document persistence already avoids serializing this live reference: it stores node index plus path and rebuilds a binding only after nodes exist. Replace unknown with an open named AnimationTargetRef entity containing a readonly string kind, and use it for AnimationChannel.targetRef, createAnimationChannel and initializeAnimationChannel, every core Map and Set key, sample visitor, and binder parameter. Keep the registry extensible rather than inventing a closed union: each scene, skeleton, morph, format, or vendor domain allocates a stable AnimationTargetRef with a namespaced kind and stores its concrete node/path, shape, bone/slot, or callback record in a domain-private typed WeakMap keyed by that ref. Its applicator resolves the ref through that map and skips null instead of asserting or shape-probing; an open skeleton binder resolves only the refs created by its paired producer. Reuse the same ref wherever clips must correspond by identity, and keep document serialization in its existing index/path form. Do not whitelist the erased property: the core requires reference identity and interpreting consumers recover structured state from it, so this is neither an unexamined payload nor an unsupported provider handle. The compiler can preserve the AnimationTargetRef entity identity and string kind, but it will not infer a target union from casts or registry entries, choose a target-specific Any carrier, retain or insert a cast, allocate or populate the domain maps, copy or materialize a target or ref, or replace reference equality with structural equality.`;
  }
  if (
    isFlightTypesSource(node, 'AnimationClipEvent.ts') &&
    subject === 'interface:AnimationClipEvent/property:payload'
  ) {
    return `${subject} leaves public clip-marker storage and delivery without an exact value domain. createAnimationClipEvent and initializeAnimationClipEvent accept any value, default undefined to null, and store the supplied payload unchanged. createAnimationClip sorts a copied event array but retains each supplied event; cloneAnimationClip allocates new markers while reusing the exact payload reference; and AnimationPlayer emits each retained event unchanged through onEvent. The animation core reads only name and time and no persistence path serializes payload, but identity-only pass-through still requires every target to represent the public constructor parameter, entity property, clip array, and signal payload. The only production non-default producer is the Lottie importer, which creates { duration: number }; there is no production onEvent listener, while animation tests use null, numbers, and a plain record and observe that record's shared reference. Define a recursive named closed AnimationClipEventPayload domain of boolean, number, string, null, readonly arrays, and readonly string-keyed records, and use it for the property plus both event constructors, with null as the sole no-payload value. This covers every current producer and preserves the existing shared reference flow without inventing finite name-discriminated arms for arbitrary Lottie comments and application event names. Normalize application payloads before event construction; when an event must identify a live application object, carry a stable string handle in the closed payload and resolve it through application-owned typed storage in the listener. Do not whitelist this public retained and emitted domain. The compiler will not infer a schema from event names or listeners, choose a target-specific Any carrier, retain or insert a cast, stringify a payload, allocate or consult an application handle registry, copy or materialize the payload, or change event sorting or emission.`;
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
    isFlightTypesSource(node, 'FlightDocumentNodeSchema.ts') &&
    subject === 'type:FlightDocumentResourceLookup' &&
    isReadonlyUnknownRecord(node.type)
  ) {
    return `${subject} is the transient identity map between the open resource-resolver registry and the open node-schema registry. Each registered resolver creates its own live resource value, materialization records that value under the authored key, and registered node factories receive the same lookup and own every interpretation; the scene-document core neither inspects nor serializes a resolved value, and writers receive an empty lookup. This is a genuinely registry-owned opaque resource boundary. Record a reviewed source-portability exception for this exact alias while node schemas own all narrowing and no resolved value enters document fields, results, or portable persistence. If portable code must inspect resources, introduce a named closed tagged FlightDocumentResource handle domain shared by resolvers and node schemas while keeping native resource owners private. The compiler will not infer a union from registered kinds, choose a target-specific Any carrier, insert a cast, or copy or materialize a live resource.`;
  }
  if (
    (isFlightTypesSource(node, 'AppWindow.ts') || isFlightTypesSource(node, 'ApplicationWindow.ts')) &&
    subject === 'type:NativeWindowHandle' &&
    node.type.kind === ts.SyntaxKind.UnknownKeyword
  ) {
    return `${subject} erases the caller-supplied native owner at the public existing-window adoption boundary. No built-in production call site invokes exported attachWindow, so external callers are the only raw-handle producers and the facade forwards their exact value to the selected provider. In the finding's AppWindow.ts revision, HostWindowAttachCapability.attach consumes the handle and the facade retains only its paired HostWindowLifecycleCapability after successful attachment. Current Flight renamed the source to ApplicationWindow.ts but still defines the alias as unknown: HasWindowAttach requires one unified WindowBackend with attach and close, and the facade retains only that backend after success. Neither facade stores, returns, clones, or serializes the handle or native owner. The web, Electron, and Tauri backends use isWebWindow, isElectronBrowserWindow, and isTauriWindow to cast the value to Partial provider interfaces and recognize different method sets. Each then retains the exact Window, ElectronBrowserWindow, or TauriWindow in provider-private application-to-owner records plus a reverse exact-owner or Electron window-id lookup, records attachment ownership and listeners, rejects duplicate owners, detaches maps and listeners on close, and closes the native owner only for Flight ownership. Subsequent backend commands retrieve that same owner for focus, bounds, position, size, visibility, and other native reads or mutations, while native listeners mirror user-driven state into the ApplicationWindow; no path copies or replaces the owner. Their built-in open paths already construct or obtain exact provider values and call typed helpers without using the erased alias. Use the reference-shaped target-token contract already implemented by InputTargetHandle, FullscreenTargetHandle, and WindowResizeTargetHandle: define NativeWindowHandle as Entity & { readonly __brand: 'NativeWindowHandle' }, then add provider-specific create/initialize pairs such as createWebNativeWindowHandle, createElectronNativeWindowHandle, and createTauriNativeWindowHandle. Each pair allocates and brands a token and records token to exact native owner in a provider-private WeakMap; provider test resets clear that map. Make HostWindowAttachCapability.attach in the finding revision, current WindowBackend.attach, and both attachWindow facades accept only the token. Have each backend resolve it from its own map, return false for an unknown or foreign token, and call its existing exact typed attach helper; keep built-in open paths, ownership, duplicate-owner rejection, listener cleanup, close behavior, retained exact owners, and reverse lookups unchanged, and remove the three structural predicates and their casts. Lower-level native providers use the same provider-owned token-to-pointer, integer, or object table in their host runtime. Current generated C++ lowers the erased alias to flight::Any, while the analogous branded target handles lower to ReferenceEnabled structs passed as flight::Ref, so the corrected ABI carries one reference-shaped NativeWindowHandle and needs no Any alternative or new compiler runtime binding. Do not whitelist either exact erased alias. The compiler will not infer one union from DOM, Electron, Tauri, or integer owners, choose a target-specific Any carrier, retain or insert a cast, inspect provider methods, copy or materialize the native window, allocate or brand a token, add provider storage, or change attachment ownership, lifetime, mutation, lookup, or close behavior.`;
  }
  if (
    isFlightTypesSource(node, 'Surface.ts') &&
    subject === 'type:NativeSurfaceHandle' &&
    node.type.kind === ts.SyntaxKind.UnknownKeyword
  ) {
    return `${subject} erases a host-owned drawable across public capability returns and surface-adoption parameters rather than confining it to one provider. HostCanvasCapability.create, HostGlCapability.create, and HostWgpuCapability.create return the alias, while createCanvasSurfaceFromNativeHandle, createGlSurfaceFromNativeHandle, and createWgpuSurfaceFromNativeHandle accept it. allocateSurface stores the exact value once in required package-private SurfaceRuntime.handle, getSurfaceHandle returns it unchanged, and portable rendering layers otherwise pass the Surface entity. The web provider is the only concrete production implementation in the finding's source revision: allocateWebSurfaceCanvas produces a fresh HTMLCanvasElement, createWebSurfaceFromElement adopts an HTMLElement, and the canvas, GL, WGPU, display, resize, and presentation adapters retrieve the same value and narrow it to HTMLCanvasElement or HTMLElement. Tests demonstrate that erasure admits string, object, integer, and null storage, while lower-level SDL, EGL, WebGPU, or integer providers enter only through the capability contracts. Because unknown absorbs null, each advertised NativeSurfaceHandle | null allocation result fails to distinguish its null failure sentinel even though all three create paths branch on null. Use the reference-shaped target-token contract already implemented by InputTargetHandle, FullscreenTargetHandle, WindowResizeTargetHandle, and NativeWindowHandle: define NativeSurfaceHandle as Entity & { readonly __brand: 'NativeSurfaceHandle' }. Add provider-specific create/initialize pairs such as createWebNativeSurfaceHandle and initializeWebNativeSurfaceHandle that allocate and brand a token and record token to exact HTMLElement in a provider-private WeakMap; provider test resets clear that map. Have allocateWebSurfaceCanvas return a token registered to its new canvas, have createWebSurfaceFromElement register its caller-owned element before allocateSurface, and make getWebSurfaceCanvasHandle and getWebSurfaceElementHandle resolve the token before their existing element-kind checks. Keep SurfaceRuntime.handle as the required token retained for exactly the Surface lifetime, keep allocateSurface and getSurfaceHandle forwarding that exact token without inspection, and let the branded domain make null an unambiguous allocation-failure sentinel rather than an accepted drawable. Unknown or foreign tokens resolve to null so the existing acquire, append, display, resize, and context-failure behavior stays unchanged. Native providers use the same provider-owned token-to-pointer, object, or integer table; the caller still owns an adopted native drawable, capability-created drawables keep their existing ownership, and release/context cleanup stays provider-owned. The generated ABI therefore carries one reference-shaped NativeSurfaceHandle and needs no Any alternative or new compiler runtime binding. Do not whitelist the erased alias. The compiler will not infer one union from DOM, SDL, EGL, WebGPU, or integer owners, choose a target-specific Any carrier, retain or insert a cast, inspect element kinds, copy or materialize the native drawable, allocate or brand a token, add provider storage, or change surface ownership, lifetime, acquisition, presentation, resize, or release behavior.`;
  }
  if (
    isFlightTypesSource(node, 'Net.ts') &&
    subject === 'type:NetResponseBody' &&
    isNetResponseBodyOpaqueUnion(node.type)
  ) {
    return `${subject} uses unknown for the JSON arm, which absorbs the sibling string, ArrayBuffer, Blob, and null arms and makes the public response body effectively unknown even though current producers have closed outcomes. createWebNetBackend is the only production NetBackend: without progress, _readNetResponseBody delegates to Response.text, json, arrayBuffer, or blob; with progress, it assembles one ArrayBuffer and _decodeNetBuffer returns that owner, creates a Blob, decodes text, or calls JSON.parse. Both JSON paths return null on a thrown decoder, while transport failure constructs status 0 with body null; non-2xx HTTP responses still retain their decoded body. sendNetRequest delegates the exact request and returns the exact provider response, including through its optional guard wrapper, and no Flight cache or serializer retains or rewrites the body. explainNetResponse reads only status and null; loadText checks string; loadBytes and audio loading check ArrayBuffer; and scene-document loading composes loadText or loadBytes for its text and binary formats. No built-in production consumer requests json or blob, so those closed values cross directly to public callers and injected native NetBackend implementations. Define recursive closed NetJsonValue and NetJsonObject types for boolean, number, string, null, readonly arrays, and readonly string-keyed objects, and replace only the unknown arm of NetResponseBody with NetJsonValue. Validate both web JSON decoder results through one shared boundary before NetResponse construction, and require every injected backend to return the same closed domain; add explicit named arms rather than widening the alias if richer formats are later supported. A successful JSON null currently shares the decode-failure sentinel and explainNetResponse reports it as decode-failure, so preserve null in NetJsonValue and replace the body-only sentinel test with a named closed decoded-versus-unavailable body state; do not silently exclude valid JSON null. Do not whitelist the public transport domain. The compiler will preserve each declared body owner and JSON value but will not treat unknown as JSON, infer or enforce responseType correlation, validate parsed data, decide the JSON-null sentinel policy, choose a target-specific Any carrier, invoke a decoder, insert a cast, copy or materialize the response body, or add side storage.`;
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
  return `${subject} unnecessarily erases a browser-owned MediaStream at a neutral host capability boundary. In the affected source, createWebVideoResourceFromMediaStream is the only production caller and already receives a MediaStream; webHostVideo is the only production attachStream implementation, while the Electron, Tauri, Capacitor, Node, and other native hosts neither implement the method nor consume its argument. The web implementation creates one HTMLVideoElement, asserts the unknown value to the DOM MediaProvider accepted by srcObject, assigns the exact stream, and returns the element as HostImageSource. VideoResource retains only that element, object-URL ownership, and ownsElement flag, never the stream; owned-element teardown clears srcObject and releases the decoder without stopping the caller-owned tracks. The source domain is therefore exactly MediaStream at this web-only entry, not an open cross-host token or a request for unknown or Any representation. A browser-capable target can bind MediaStream as an exact external host type through its target profile; native hosts without stream attachment need no adapter or alternative. Remove attachStream from HostVideoCapability and its provider rather than inventing a HostVideoStreamHandle. Replace the capability with VideoCapabilityBackend exposing canPlayType plus optional createVideoElement, and make createVideoResourceFromMediaStream accept Readonly<VideoCapabilityBackend> and MediaStream directly. Have that function request the element, return null when unavailable, assign element.srcObject = stream, and construct an owned VideoResource from the element. Current Flight already applies this typed rewrite in VideoCapabilityBackend.ts, videoResourceFrom.ts, and videoResource.ts: HostVideo.ts and attachStream are gone, and no native stream adapter or erased compiler carrier is needed. Do not whitelist the obsolete unknown parameter. The compiler will not assume MediaStream for every host capability, choose a target-specific Any carrier, retain the erased provider method, synthesize a missing external binding, insert or preserve the MediaProvider cast, copy or materialize the live stream or element, stop its tracks, or add side storage.`;
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

function getSceneDocumentMaterializationOpaqueTraitsGuidance(
  node: ts.PropertySignature,
  subject: string,
  kinds: ReadonlySet<OpaqueTypeKind>,
): string | undefined {
  if (
    !hasOnlyUnknown(kinds) ||
    getNodeName(node.name) !== 'traits' ||
    getEnclosingVariableName(node) !== 'runtime' ||
    !isReadonlyOptionalUnknownTraitsProbe(node)
  ) {
    return undefined;
  }
  const source = normalizePathPortable(node.getSourceFile().fileName);
  if (source.endsWith('/packages/scene-document/src/sceneDocumentScene2DMaterialization.ts')) {
    if (subject === 'function:adoptDocumentRoot2D/property:traits') {
      return `${subject} is a locally erased view of the node returned by FlightDocumentNodeSchema.createNode, after raw document fields and resolved resources have already crossed the registered factory boundary. The declared Node runtime owns a named optional traits key, and createNode2DRuntime writes Node2DTraitsKey. Guard that the candidate has an allocated runtime, then use the typed isNode2D predicate or getNodeRuntime(root).traits comparison before installing it as the scene root. A reviewed exception is not justified because unknown is introduced only by this structural assertion, not by a provider-owned payload. The compiler will not choose a target-specific Any carrier, preserve or replace the assertion with a cast, or copy or materialize the candidate node.`;
    }
    if (subject === 'function:checkRootKindDimension/property:traits') {
      return `${subject} is a locally erased view of the probe returned by FlightDocumentNodeSchema.createNode. The probe's declared Node runtime already carries the named optional traits-key contract; the dimension check needs only the closed Node2DTraitsKey or Node3DTraitsKey identity selected by dimension. Guard that the probe has an allocated runtime, then use typed node predicates or getNodeRuntime(probe).traits for that comparison. A reviewed exception is not justified because no raw document or provider value remains in this property: unknown is created by the assertion itself. The compiler will not choose a target-specific Any carrier, preserve or replace the assertion with a cast, or copy or materialize the probe node.`;
    }
    return undefined;
  }
  if (source.endsWith('/packages/scene-document/src/sceneDocumentScene3DMaterialization.ts')) {
    if (subject === 'function:adoptDocumentRoot3D/property:traits') {
      return `${subject} is a locally erased view of the node returned by FlightDocumentNodeSchema.createNode, after raw document fields and resolved resources have already crossed the registered factory boundary. The declared Node runtime owns a named optional traits key, and createNode3DRuntime writes Node3DTraitsKey. Guard that the candidate has an allocated runtime, then use a typed isNode3D predicate backed by getNodeRuntime(root).traits before installing it as the scene root. A reviewed exception is not justified because unknown is introduced only by this structural assertion, not by a provider-owned payload. The compiler will not choose a target-specific Any carrier, preserve or replace the assertion with a cast, or copy or materialize the candidate node.`;
    }
    if (subject === 'function:checkRootKindDimension3D/property:traits') {
      return `${subject} is a locally erased view of the probe returned by FlightDocumentNodeSchema.createNode. The probe's declared Node runtime already carries the named optional traits-key contract, and this check needs only the closed Node3DTraitsKey identity. Guard that the probe has an allocated runtime, then use a typed isNode3D predicate backed by getNodeRuntime(probe).traits. A reviewed exception is not justified because no raw document or provider value remains in this property: unknown is created by the assertion itself. The compiler will not choose a target-specific Any carrier, preserve or replace the assertion with a cast, or copy or materialize the probe node.`;
    }
  }
  return undefined;
}

function isReadonlyOptionalUnknownTraitsProbe(node: ts.PropertySignature): boolean {
  const parent = node.parent;
  if (!ts.isTypeLiteralNode(parent) || parent.members.length !== 1 || node.questionToken === undefined) return false;
  if (node.type?.kind !== ts.SyntaxKind.UnknownKeyword) return false;
  const readonlyType = parent.parent;
  if (
    !ts.isTypeReferenceNode(readonlyType) ||
    getNodeName(readonlyType.typeName) !== 'Readonly' ||
    readonlyType.typeArguments?.length !== 1 ||
    readonlyType.typeArguments[0] !== parent
  ) {
    return false;
  }
  const union = readonlyType.parent;
  return (
    ts.isUnionTypeNode(union) &&
    union.types.length === 2 &&
    union.types.includes(readonlyType) &&
    union.types.some((type) => type.kind === ts.SyntaxKind.UndefinedKeyword)
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
  return `${subject} gives structured log records an open value domain even though every sink and LogSignals receive the raw LogEntry. Memory and buffered sinks can retain data before registered kind serializers and redaction run inside the JSON formatter, while text and custom formatters need the same declared values directly. Define a recursive named closed LogFieldValue domain covering portable scalars, arrays, and string-keyed records plus a LogFields record alias; make LogData string | LogFields and use LogFields for context fields, span fields, serializer results, serializeLogError, and formatter and redaction helpers. Registered kind serializers are formatter-only transforms over record values already inside LogFieldValue: type their inputs and outputs as LogFields, and do not use them to admit live objects. Normalize any live object producer into the closed domain before LogEntry construction. Do not whitelist the transport domain: the compiler will not infer a schema from logger call sites, invoke late serializers, stringify arbitrary fields, choose a target-specific Any carrier, insert a cast, or copy or materialize the record.`;
}

function getFlightTypesOpaquePropertyGuidance(
  node: ts.PropertySignature,
  subject: string,
  kinds: ReadonlySet<OpaqueTypeKind>,
): string | undefined {
  if (!hasOnlyUnknown(kinds)) return undefined;
  if (
    isFlightTypesSource(node, 'AsepriteSchema.ts') &&
    subject === 'interface:AsepriteMeta/property:slices' &&
    node.questionToken !== undefined &&
    isUnknownArrayType(node.type)
  ) {
    return `${subject} gives the public Aseprite slice payload an opaque element domain. The unchecked JSON.parse assertions in parseAsepriteSpritesheet and parseAsepriteSpritesheetDocument are the current input producers: the first conversion ignores slices, but the document parser returns the exact AsepriteDocument and therefore exposes every slice to callers before any guard or normalizer. serializeAsepriteSpritesheet accepts that document as existing metadata, but dataToMeta currently omits slices from its reconstructed output; that lossy serialization is not ingress validation and does not close the returned domain. Replace unknown[] with named closed AsepritePoint, AsepriteSliceKey, and AsepriteSlice schemas: each slice has a name, optional color, and keys; each key has a frame and bounds plus optional center and pivot. Use AsepriteRect for bounds and center, AsepritePoint for pivot, and AsepriteSlice[] for slices. Validate or normalize JSON.parse before either parser constructs or returns AsepriteDocument. Preserve that closed slice type through serialization if authored slices are meant to round-trip, or explicitly document and test their omission if serialization is deliberately lossy. Do not whitelist this property: it crosses a public return boundary before validation. The compiler will not infer the Aseprite schema from JSON, choose a target-specific Any carrier, insert a cast, copy or materialize the slice payload, preserve it during serialization, or decide to drop it.`;
  }
  if (
    isFlightTypesSource(node, 'Assets.ts') &&
    subject === 'interface:AssetEntry/property:value' &&
    node.questionToken === undefined &&
    node.type?.kind === ts.SyntaxKind.UnknownKeyword
  ) {
    return `${subject} erases the decoded resource produced by the AssetLoaderAdapter selected for the entry's descriptor type. registerAssetLoader casts AssetLoaderAdapter<T> to AssetLoaderAdapter<unknown>, so the runtime loses the adapter/value relation before acquireAsset stores the result. acquireAsset<T> and getAsset<T> then let each caller choose an unrelated T and recover it with assertions, while release and library disposal rediscover an adapter from the descriptor and pass it the erased value. AssetType is an open string and no production code outside the assets package currently registers or acquires a value, so neither call sites nor the registry provide a finite domain the compiler can prove. Define one closed AssetHandle entity containing readonly id and type, have each adapter keep its decoded resources in adapter-private typed storage keyed by a freshly allocated handle, and make the non-generic AssetLoaderAdapter load and dispose that handle. Change AssetEntry.value to AssetHandle | null and loadPromise to Promise<AssetHandle> | null, with null as the not-resident value; make acquireAsset and getAsset return AssetHandle and AssetHandle | null, remove their caller-selected type parameters and assertions, remove registerAssetLoader's generic cast, and use AssetHandle promises in group loading. A concrete adapter may expose a typed accessor that validates its handle and returns its private resource; the asset core never stores or recovers that resource. Do not merely parameterize AssetEntry<T>: the single entries map still combines independently typed adapters and ids without preserving their relation. Do not whitelist the erased value. The compiler will not infer a value type from AssetType or generic call sites, choose a target-specific Any carrier, retain or insert a cast, copy or materialize the decoded resource, invoke an adapter accessor, or add side storage to the asset core.`;
  }
  if (
    isFlightTypesSource(node, 'GuiDialog.ts') &&
    subject === 'interface:GuiDialogCloseResult/property:value' &&
    node.questionToken !== undefined &&
    node.type?.kind === ts.SyntaxKind.UnknownKeyword
  ) {
    return `${subject} exposes an optional unknown payload on the public dialog-close signal even though the repository's close results form concrete reason arms. The built-in backdrop producer closes the active entry as dismissed with no value. Other repository closes cover accepted with the numeric value 7 plus accepted and cancelled without a value; no cancelled or dismissed producer attaches a payload, and no production listener interprets one. closeGuiDialog validates only that result.entryId names the active entry, rejects disposed, empty, or mismatched closes without emission, then removes the entry, updates visibility, focus, and queue signals, and synchronously emits the exact result object through onClose without inspecting, retaining, serializing, or copying value. Identity transport does not make unknown a portable public domain: every generated target must still represent the closeGuiDialog parameter and GuiDialogSignals.onClose payload. Replace GuiDialogCloseResult with reason-discriminated arms and define a recursive closed GuiDialogCloseValue of boolean, number, string, null, readonly GuiDialogCloseValue arrays, and readonly string-keyed GuiDialogCloseValue records. The accepted arm may keep value optional because accepted-without-value is real; the cancelled and dismissed arm must have no value property. This preserves the exact present closed value and lets listeners narrow reason before reading it, while null remains an intentional accepted payload rather than a missing property. Normalize application data into GuiDialogCloseValue before calling closeGuiDialog. When a dialog must return an identity-bearing application object, send a stable string handle in the closed value and resolve it through application-owned typed storage after onClose; do not move that registry or opaque object into the GUI core. Do not whitelist the public signal domain. The compiler will not infer a schema from entryId, reason, or listeners, choose a target-specific Any carrier, insert or retain a cast, stringify an application object, allocate or consult a handle registry, change close ordering or emission, copy or materialize the payload, or add side storage.`;
  }
  if (
    isFlightTypesSource(node, 'WgpuScene3DRuntime.ts') &&
    subject === 'interface:WgpuScene3DRuntime/property:skinningAdapter' &&
    node.questionToken === undefined &&
    isUnknownOrNull(node.type)
  ) {
    return `${subject} erases a contract that is already closed. getWgpuScene3DRuntime creates one runtime per WgpuRenderState and initializes skinningAdapter to null; registerWgpuGpuSkinning is the sole non-null producer and overwrites it with the module-level WGPU_SKINNING_ADAPTER singleton, which is declared as WgpuSkinningAdapter. No path clears or substitutes another value. getWgpuSkinningAdapter plus four direct mesh-upload, mesh-selection, draw-bind-group, and pipeline-layout reads immediately cast the slot back to WgpuSkinningAdapter | null. The accessor then supplies the same named type to Classic, PBR, Shaded, Toon, and Unlit shader construction plus both shadow paths. Type the runtime property directly as WgpuSkinningAdapter | null with a type-only import and remove all five casts while preserving the null checks and owner identity. The adjacent shaded-material cache values are genuinely backend-private unknowns, but that rationale does not apply to this slot because WgpuSkinningAdapter is already a public closed interface in @flighthq/types. The C++ backend can carry its nullable interface reference without an Any carrier or identity-changing conversion. A reviewed exception is not justified. The compiler will not choose a target-specific Any carrier, retain or insert a cast, infer or install a skinning adapter, invoke an adapter method, or copy or materialize the adapter.`;
  }
  if (
    isFlightTypesSource(node, 'Log.ts') &&
    isReadonlyUnknownRecord(node.type) &&
    node.questionToken === undefined &&
    !node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ReadonlyKeyword)
  ) {
    const owner =
      subject === 'interface:LogContext/property:fields'
        ? 'context'
        : subject === 'interface:LogSpan/property:fields'
          ? 'span'
          : undefined;
    if (owner === undefined) return undefined;
    const constructor = owner === 'context' ? 'createLogContext and createChildLogContext' : 'createLogSpan';
    const retention =
      owner === 'context'
        ? 'The context retains those fields and every logWith path merges them into LogData before LogEntry emission.'
        : 'The active-span stack retains those fields and every enabled log path merges them into LogData before LogEntry emission.';
    return `${subject} gives the bound log ${owner} a second open field-value domain. ${retention} Memory or buffered sinks and LogSignals can then retain or observe the values before JSON serializers or redaction run. Type fields as the same LogFields alias backed by the recursive named closed LogFieldValue domain as LogData, make ${constructor} accept that type, and normalize live object fields at their callers before constructing the ${owner}. Do not whitelist the merged transport domain: the compiler will not infer values from field names, invoke late serializers, stringify arbitrary fields, choose a target-specific Any carrier, insert a cast, or copy or materialize the record.`;
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
    return `${subject} is a heterogeneous command-property slot: ${source}, and the matching set-property binding writes it back on ${field === 'after' ? 'initial execute and redo' : 'undo'} without inspecting, coercing, cloning, or serializing it. executeCommand invokes the binding before any history retention; absent a merge it pushes the exact live command reference into CommandHistory.entries. getCommandHistoryEntries exposes those same references, transactions keep or wrap them in CompositeCommand, and clear or trim only removes array entries. Merge is the sole transformation: only equal ordered target and property identities coalesce, preserving the first command's before owner and the newest command's after owner. Every repository construction site for the generic set-property builtin is a test over numeric x or y; there is no non-test caller from which to derive a supported property set. The unbounded string key can name any NodeAny field, including live entity or collection values, so those numeric tests do not establish a finite domain or restore the missing relation between target, property, before, and after. There is also no command serializer, parser, persistent history store, or command codec. The Command contract already acknowledges that its live NodeAny target prevents disk persistence, so a recursive JSON-shaped value union would neither make this command serializable nor repair that type relation. Remove CommandPropertyEntry, SetNodePropertyCommand, SetNodePropertyCommandKind, createSetNodePropertyCommand, createSetNodePropertyCommandBatch, both initializeSetNodePropertyCommand functions, the set-property binding, and the dynamic readNodeProperty/writeNodeProperty helpers; unregister that default binding and update its tests. For each property edit that is actually needed, declare a command-kind-specific data interface whose target and before/after fields use the exact declared property types, capture those named members directly in its constructor, and write them directly in its matching binding. Compose heterogeneous batches from those typed commands with CompositeCommand; if one gesture needs coalescing, implement it inside the matching typed binding while retaining the original before and newest after values. If persistent command histories are added later, give each surviving command kind a separate validated serialized form with a stable node key or path and exact portable fields, then resolve that form into its live typed command at the persistence boundary; do not serialize NodeAny references or reuse an open runtime slot as a codec. Do not replace unknown with a guessed scalar or recursive value union and do not whitelist the open slots. The compiler will not infer a property-indexed union from string keys or numeric tests, choose a target-specific Any carrier, retain the dynamic assertions, insert a cast, invent a stable node identity or command codec, serialize a live node or property value, copy or materialize the value, change command ordering or dispatch, or implement merge, undo, or redo behavior.`;
  }
  if (
    isFlightTypesSource(node, 'Notification.ts') &&
    node.questionToken !== undefined &&
    node.type?.kind === ts.SyntaxKind.UnknownKeyword
  ) {
    const isReadonly = node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ReadonlyKeyword) ?? false;
    if (subject === 'interface:NotificationRequest/property:data' && !isReadonly) {
      return `${subject} is caller-authored public request state, not an unexamined provider token. showNotification and scheduleNotification pass the exact request to NotificationDeliveryBackend or NotificationSchedulingBackend without inspecting, validating, or cloning data. The web-page and service-worker adapters each construct a fresh WebNotificationOptions object but assign request.data unchanged; only the injected Notification constructor or service-worker registration then performs the browser's native structured clone. Electron, Tauri, and Capacitor instead enumerate the request and reject every defined data field before native construction, including scheduled delivery; Capacitor pending-list reconstruction omits data. initializeScheduledNotificationResource retains the exact accepted request owner, but the built-in scheduler reaches it only after that rejection, and public Notification resources and events never expose data. Define one recursive closed NotificationData portable profile of boolean, number, string, null, readonly NotificationData arrays, and readonly string-keyed NotificationData records; use it on NotificationRequest.data and WebNotificationOptions.data. Keep the outer field optional, preserve null as a present scalar, and validate any untyped application or serialization ingress before constructing the request. Add explicit named arms later if Flight deliberately supports richer structured-clone categories rather than equating the browser's open clone algorithm with a portable source domain. Do not whitelist the open request boundary. The compiler will preserve each declared scalar, array, record, and null but will not infer or validate a structured-clone profile, choose a target-specific Any carrier, clone at the browser boundary, reject a non-web request, insert a cast, copy or materialize the payload, or add side storage.`;
    }
    if (subject === 'interface:WebNotificationOptions/property:data' && !isReadonly) {
      return `${subject} is an injected web-facade input with no independent value domain. toWebNotificationOptions and toServiceWorkerNotificationOptions are its only Flight producers: both allocate a fresh options record and assign the exact NotificationRequest.data owner without inspecting, normalizing, or cloning it. The only consumers are the injected page Notification constructor and service-worker registration.showNotification, where the browser may structured-clone a present value. Type this optional field with the same recursive closed NotificationData scalar, readonly-array, and readonly string-record profile as NotificationRequest.data; perform validation at any untyped request ingress rather than widening this internal transport back to unknown. Preserve null as a present payload and omission as no supplied data. Do not whitelist the duplicate open bridge. The compiler will preserve the declared NotificationData value but will not infer or validate the browser's structured-clone algorithm, choose a target-specific Any carrier, invoke either native notification API, clone the payload, insert a cast, copy or materialize the payload, or add side storage.`;
    }
    if (subject === 'interface:WebServiceWorkerNotificationInstance/property:data' && isReadonly) {
      return `${subject} declares browser-owned structured-clone data that no Flight production path reads, stores, or returns. Service-worker active-list reconciliation reads only native.tag and includes only tags already mapped to Flight Notification resources; closeOne filters by tag and invokes native.close. Notification events enter through WebServiceWorkerNotificationEvent with only notificationTag, actionId, and type, while the public Notification resource exposes only id, tag, and title. The web-page native-instance facade already omits data. Remove data from WebServiceWorkerNotificationInstance and stop populating it in the fake service-worker provider; a browser object may still have extra native fields without adding them to Flight's injected capability contract. If a real consumer is added, validate the browser-owned value at that ingress into the recursive closed NotificationData profile before returning or retaining it. Do not whitelist an unused open member. The compiler will not infer or validate the browser's structured-clone domain, choose a target-specific Any carrier, read or retain a native payload, change tag reconciliation or close behavior, insert a cast, copy or materialize the payload, or add side storage.`;
    }
  }
  return undefined;
}

function getAppLoopOpaqueFrameHandleGuidance(
  node: ts.PropertySignature,
  subject: string,
  kinds: ReadonlySet<OpaqueTypeKind>,
): string | undefined {
  if (
    subject !== 'interface:LoopState/property:frameHandle' ||
    !hasOnlyUnknown(kinds) ||
    node.questionToken !== undefined ||
    node.type?.kind !== ts.SyntaxKind.UnknownKeyword ||
    !normalizePathPortable(node.getSourceFile().fileName).endsWith('/packages/app/src/appLoop.ts')
  ) {
    return undefined;
  }
  return `${subject} redundantly erases the numeric animation-frame handle already shared by every provider boundary. Every scheduling path in startAppLoop assigns backend.requestFrame(tick) to frameHandle and immediately replaces the kLoop cleanup with a closure that passes the current handle only to backend.cancelFrame on the same retained capability. Pause, frame-rate throttling, normal rescheduling, and initial scheduling all preserve that pairing; no application consumer otherwise reads, clones, serializes, exposes, or persists the value. The concrete domain is not provider-opaque: webHostLoop returns the browser requestAnimationFrame number, the Haxe binding targets js.Browser.window.requestAnimationFrame and narrows cancellation to Int, and flight-cpp's sdl-app profile declares callResultType double for flight::host_sdl::request_animation_frame, whose AnimationFrameHandle alias is double. Define AppLoopFrameHandle = number in HostAppLoop.ts and use it for requestFrame and cancelFrame. Prefer removing frameHandle from LoopState: at each of the four scheduling sites capture the returned AppLoopFrameHandle directly in the newly installed cleanup closure, eliminating createLoopState's null as unknown sentinel and keeping cancellation paired to that exact request. If storage remains, type it AppLoopFrameHandle | null, initialize it with null without an assertion, and narrow before cancellation. Remove webHostLoop's handle as number cast; the global and native external bindings already represent the numeric domain. Do not whitelist this redundant erasure or route it through a target Any carrier: representation is already closed. The compiler will not infer number from a web cast or downstream binding profile, rewrite the capability and LoopState, capture the scheduled value, remove the sentinel or cast, or change cleanup replacement and cancellation behavior.`;
}

function getCommandPropertyInputOpaqueValueGuidance(
  node: ts.PropertySignature,
  subject: string,
  kinds: ReadonlySet<OpaqueTypeKind>,
): string | undefined {
  if (
    subject !== 'function:createSetNodePropertyCommandBatch/parameter:entries/property:value' ||
    !hasOnlyUnknown(kinds) ||
    getNodeName(node.name) !== 'value' ||
    node.questionToken !== undefined ||
    node.type?.kind !== ts.SyntaxKind.UnknownKeyword ||
    !normalizePathPortable(node.getSourceFile().fileName).endsWith('/packages/command/src/command.ts')
  ) {
    return undefined;
  }
  return `${subject} is the caller-provided after-side of a heterogeneous node-property command. createSetNodePropertyCommandBatch retains each value unchanged as CommandPropertyEntry.after while readNodeProperty captures the matching before value from the same target and property. CommandHistory stores that plain command; merging preserves the original before and newest after only when target and property identity match; execute and redo write after back to that property, while undo writes before. No command-core consumer inspects, coerces, serializes, or interprets either value. Relative to generic command history this is genuinely opaque identity transport, so record a reviewed source-portability exception for this exact parameter property while values return only to their originating node property and do not enter portable persistence or cross-property interpretation. If portable histories support a bounded property set, replace unknown with one named closed CommandPropertyValue domain or property-discriminated entry arms shared by the single and batch constructors, CommandPropertyEntry.before and after, the reader and writer, merging, and every consumer. This exception records value erasure only: it does not prove indexed storage on NodeAny or justify the double assertions in readNodeProperty and writeNodeProperty; use a typed property-access capability or an owner with a declared index signature for that separate boundary. The compiler will not infer a property-indexed union, choose a target-specific Any carrier, retain or insert a cast, copy or materialize the value, serialize it, or change its identity.`;
}

function getNodeRuntimeSlotOpaqueWriteGuidance(
  node: ts.PropertySignature,
  subject: string,
  kinds: ReadonlySet<OpaqueTypeKind>,
): string | undefined {
  if (
    subject !== 'function:initializeNode/property:computed' ||
    !hasOnlyUnknown(kinds) ||
    node.questionToken === undefined ||
    node.type?.kind !== ts.SyntaxKind.UnknownKeyword ||
    !ts.isComputedPropertyName(node.name) ||
    !ts.isIdentifier(node.name.expression) ||
    node.name.expression.text !== 'EntityRuntimeKey' ||
    !normalizePathPortable(node.getSourceFile().fileName).endsWith('/packages/node/src/node.ts')
  ) {
    return undefined;
  }
  const view = node.parent;
  if (!ts.isTypeLiteralNode(view) || view.members.length !== 1) return undefined;
  const assertion = view.parent;
  if (
    !ts.isAsExpression(assertion) ||
    assertion.type !== view ||
    !ts.isIdentifier(assertion.expression) ||
    assertion.expression.text !== 'node'
  ) {
    return undefined;
  }
  let assertedUse: ts.Expression = assertion;
  while (ts.isParenthesizedExpression(assertedUse.parent) && assertedUse.parent.expression === assertedUse) {
    assertedUse = assertedUse.parent;
  }
  const access = assertedUse.parent;
  if (
    !ts.isElementAccessExpression(access) ||
    access.expression !== assertedUse ||
    !ts.isIdentifier(access.argumentExpression) ||
    access.argumentExpression.text !== 'EntityRuntimeKey'
  ) {
    return undefined;
  }
  const assignment = access.parent;
  if (
    !ts.isBinaryExpression(assignment) ||
    assignment.left !== access ||
    assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
    !ts.isCallExpression(assignment.right) ||
    !ts.isIdentifier(assignment.right.expression) ||
    assignment.right.expression.text !== 'runtimeFactory' ||
    assignment.right.arguments.length !== 0
  ) {
    return undefined;
  }
  return `${subject} erases the computed EntityRuntimeKey cell to optional unknown only for the direct runtimeFactory() write into the existing node owner. That local asserted view discards the exact writable relation already retained by EntityConstruction<Node<Traits>>: the mapped construction type removes readonly without changing Node<Traits>[EntityRuntimeKey] from NodeRuntime<Traits> | undefined. Runtime extends NodeRuntime<Traits>, so the selected NodeRuntimeFactory<Runtime> produces a value accepted by that base slot, and allocateEntity<Node<Traits> & Traits>() created this same owner. createNode passes that owner and optional factory into initializeNode; initializeNode fills the runtime and public node cells, and finishEntity returns the same owner without copying or replacing its runtime. getNodeRuntime reads the same slot, and hierarchy, signal, disposal, interaction, and scene paths consume the retained NodeRuntime cells. Replace the unknown view with a direct typed node[EntityRuntimeKey] = runtimeFactory() assignment or one named generic runtime-slot setter whose owner, value, and return types preserve that relation. If generic mapped-type or intersection inference rejects the direct write, repair that relation in semantic lowering rather than weakening the source carrier to unknown. Resolve separately the neighboring unchecked default-factory assertion and createNodeRuntime's base-owner assertion: closing this value domain does not prove either claim. Do not whitelist the opaque view: no provider payload crosses this boundary, and the declared computed slot already supplies the closed value domain. The compiler will preserve the exact node owner, computed slot, and runtime subtype, but will not choose a target-specific Any carrier, retain or insert a cast, copy or materialize the node or runtime, validate either separate assertion, or add side storage.`;
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
    !isFlightTypesSource(node, 'HostAppLoop.ts') ||
    !hasExactHostAppLoopHandleMethodSignature(node, subject)
  ) {
    return undefined;
  }
  if (subject === 'interface:HostAppLoopCapability/method:requestFrame.return') {
    return `${subject} erases an exact numeric animation-frame handle, not a provider-owned opaque token. webHostLoop is the sole TypeScript production provider: requestFrame forwards the (time: number) => void callback to browser requestAnimationFrame and returns its number unchanged, while now uses the same browser high-resolution millisecond clock. Haxe binds requestAnimationFrame to js.Browser.window.requestAnimationFrame. The native flight-cpp sdl-app profile binds it to flight::host_sdl::request_animation_frame with callResultType double; that runtime defines AnimationFrameHandle = double, issues finite numeric IDs, and pumps the same double timestamp callback. startAppLoop assigns each result to private LoopState on its paused, throttled, ordinary, and initial scheduling paths, then its cleanup passes the value only to cancelFrame; no path clones, serializes, exposes, or persists it. Export AppLoopFrameHandle = number from HostAppLoop.ts, return it from requestFrame, accept it in cancelFrame, and use it or a directly captured local in appLoop.ts. The existing Haxe and C++ external bindings already represent that source number, so no new host external type, branded entity, or Any carrier is needed. Do not whitelist the erased return. The compiler will not infer number from a web implementation or downstream binding profile, preserve callback-to-handle correlation implicitly, rewrite private storage, remove its sentinel, or change scheduling and cancellation behavior.`;
  }
  if (subject === 'interface:HostAppLoopCapability/method:cancelFrame.parameter:handle') {
    return `${subject} erases the same exact numeric animation-frame handle returned by requestFrame. startAppLoop's paused, throttled, ordinary, and initial scheduling paths store each result only until the matching kLoop cleanup passes it unchanged to cancelFrame on the same retained capability; no other application consumer reads, clones, serializes, exposes, or persists it. webHostLoop currently recovers number with handle as number before browser cancelAnimationFrame. Haxe binds that global to js.Browser.window.cancelAnimationFrame and narrows its numeric argument to Int, while flight-cpp's sdl-app profile binds it to flight::host_sdl::cancel_animation_frame, which accepts AnimationFrameHandle = double from the paired request binding's double result. Export AppLoopFrameHandle = number from HostAppLoop.ts and use it for both methods and any private storage, then pass handle directly in webHostLoop. Prefer capturing each scheduled handle in its installed cleanup and removing LoopState.frameHandle; otherwise store AppLoopFrameHandle | null and narrow its initialization state explicitly. The existing Haxe and C++ external bindings already represent the source number, so no new host external type, branded entity, or Any carrier is needed. Do not whitelist the erased parameter. The compiler will not infer number from the web cast or downstream binding profile, retain or remove that cast, rewrite private storage, or change handle identity and cancellation behavior.`;
  }
  return undefined;
}

function hasExactHostAppLoopHandleMethodSignature(node: ts.MethodSignature, subject: string): boolean {
  if (node.questionToken !== undefined || !node.type || node.parameters.length !== 1) return false;
  if (subject === 'interface:HostAppLoopCapability/method:cancelFrame.parameter:handle') {
    return (
      node.parameters[0]?.type?.kind === ts.SyntaxKind.UnknownKeyword && node.type.kind === ts.SyntaxKind.VoidKeyword
    );
  }
  if (subject !== 'interface:HostAppLoopCapability/method:requestFrame.return') return false;
  const callback = node.parameters[0]?.type;
  return (
    node.type.kind === ts.SyntaxKind.UnknownKeyword &&
    callback !== undefined &&
    ts.isFunctionTypeNode(callback) &&
    callback.parameters.length === 1 &&
    callback.parameters[0]?.type?.kind === ts.SyntaxKind.NumberKeyword &&
    callback.type.kind === ts.SyntaxKind.VoidKeyword
  );
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

function isUnknownArrayType(node: ts.TypeNode | undefined): boolean {
  return Boolean(node && ts.isArrayTypeNode(node) && node.elementType.kind === ts.SyntaxKind.UnknownKeyword);
}

function isUnknownOrNull(node: ts.TypeNode | undefined): boolean {
  if (!node || !ts.isUnionTypeNode(node) || node.types.length !== 2) return false;
  return (
    node.types.some((type) => type.kind === ts.SyntaxKind.UnknownKeyword) &&
    node.types.some((type) => hasNullType(type))
  );
}

function isStringOrReadonlyUnknownRecord(node: ts.TypeNode): boolean {
  if (!ts.isUnionTypeNode(node) || node.types.length !== 2) return false;
  return (
    node.types.some((type) => type.kind === ts.SyntaxKind.StringKeyword) &&
    node.types.some((type) => isReadonlyUnknownRecord(type))
  );
}

function isUnknownRecord(node: ts.TypeNode | undefined): boolean {
  if (!node || !ts.isTypeReferenceNode(node) || getNodeName(node.typeName) !== 'Record') return false;
  if (node.typeArguments?.length !== 2) return false;
  const [key, value] = node.typeArguments;
  return key?.kind === ts.SyntaxKind.StringKeyword && value?.kind === ts.SyntaxKind.UnknownKeyword;
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
  return `${subject} preserves an optional unknown diagnostic for the Tray ${outcome} result; ${flow} These specialized Tray.ts sites are runtime error payloads; the unrelated unknown fallback in TrayFacetFor is type-only capability erasure, not a stored value. The built-in Electron, Tauri, and wrapper catch paths construct an own error property even when JavaScript throws null or undefined, while a custom Host capability may omit the property. createTrayIcon observes that provider presence and then materializes a new failure Entity with its own error cell, writing undefined when the provider omitted it; invokeUpdate and invokeRead either return a provider result unchanged or create an own caught-error result. Other operations likewise return the exact payload or embed it in a destroy-failure entry. No result importer, clone, or serializer exists, and errors are not copied into provider records or long-lived TrayRuntime state: only the in-flight destroy result is reachable through destroyPromise, whose runtime pointer is cleared in finally. Production code branches on outcome, returns or forwards the result, or discards a later queued animation failure; none inspects error to recover portable structure. Public callers can observe both own-property presence and the exact arbitrary payload, so omission, own undefined, null, Error instances, arrays, strings, and objects must not be collapsed. The current sources therefore prove these diagnostics are genuinely provider-opaque and do not prove Error or one named closed TrayErrorPayload. If that diagnostic-only contract is intentional, keep optional unknown and record a reviewed source-portability exception for this exact field. If portable consumers need machine-readable failures, first define a closed payload and normalize every catch and Host producer into it, choosing optionality or a null sentinel explicitly rather than inferring either from current values. Do not add a compiler whitelist for the Tray fields. A target backend can already represent and forward the erased payload, so representation is not the gap; unguarded member access across a Tray result union is a separate source-narrowing issue. The compiler can lower the current guarded presence test and exact value forwarding, but it will not infer Error, stringify the value, define a portable payload domain, insert a cast, collapse or invent an absence sentinel, clone or serialize a result, or copy or materialize the payload.`;
}

function getTrayOpaqueErrorFlow(subject: string): string | undefined {
  switch (subject) {
    case 'type:TrayCreateProviderResult/arm:outcome=runtime-api-unavailable/property:error':
      return 'The arm is a reserved capability outcome with no built-in Electron or Tauri producer; a custom provider may omit the diagnostic or supply any payload, and createTrayIcon forwards it without narrowing.';
    case 'type:TrayCreateProviderResult/arm:outcome=invalid-icon/property:error':
    case 'type:TrayImageUpdateResult/arm:outcome=invalid-icon/property:error':
    case 'type:TrayPressedImageUpdateResult/arm:outcome=invalid-icon/property:error':
      return 'Electron image decoding catches arbitrary thrown payloads and also creates an Error for an empty decoded image; the public create, update, or animation wrappers preserve the exact value, so that one concrete Error path does not narrow the arm.';
    case 'type:TrayCreateProviderResult/arm:outcome=tray-create-failed/property:error':
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

function getShadingBuiltInModifierOpaqueMapGuidance(
  node: ts.PropertySignature,
  subject: string,
  kinds: ReadonlySet<OpaqueTypeKind>,
): string | undefined {
  if (
    subject !== 'function:getDefineSignature/property:map' ||
    !hasOnlyUnknown(kinds) ||
    getNodeName(node.name) !== 'map' ||
    node.questionToken === undefined ||
    node.type?.kind !== ts.SyntaxKind.UnknownKeyword ||
    !normalizePathPortable(node.getSourceFile().fileName).endsWith(
      '/packages/shading/src/registerBuiltInModifiers.ts',
    ) ||
    !ts.isTypeLiteralNode(node.parent) ||
    node.parent.members.length !== 1
  ) {
    return undefined;
  }
  const assertion = node.parent.parent;
  if (!isTypeAssertion(assertion) || getTypeAssertionType(assertion) !== node.parent) return undefined;
  let source = assertion.expression;
  while (ts.isParenthesizedExpression(source)) source = source.expression;
  if (!ts.isIdentifier(source) || source.text !== 'modifier') return undefined;
  return `${subject} exposes unknown only for the Dissolve built-in's detection-only map-presence probe. registerBuiltInModifiers binds dissolveModifierDefinition under DissolveModifierKind; getModifierDefineKey resolves that definition with the same base modifier's kind and invokes its generic callback with the same Modifier reference. createDissolveModifier is the built-in producer and writes the named DissolveModifier.map only when a Texture is supplied, but the open ModifierRegistry also accepts third-party definitions and its kind key alone does not recover a concrete structural owner. This callback asks only whether map is undefined, reduces that evidence to the closed 'm' or empty signature, and never inspects, returns, retains, serializes, or forwards the opaque value. Record a reviewed source-portability exception for this exact property while the probe remains presence-only and no map value crosses the callback boundary. If the callback must consume map or any other Dissolve field, make modifier-definition registration and lookup kind-coupled, validate and recover Readonly<DissolveModifier> before dispatch, and preserve its closed Texture | undefined field through the callback. A registry tag or key is not that validation. The compiler will not infer Texture from the kind, choose a target-specific Any carrier, retain or insert a cast, copy or materialize the modifier or map, or bypass owner validation.`;
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

function getTiledJsonOpaqueValueGuidance(
  node: ts.TypeAliasDeclaration,
  subject: string,
  kinds: ReadonlySet<OpaqueTypeKind>,
): string | undefined {
  if (
    subject !== 'type:JsonObject' ||
    !hasOnlyUnknown(kinds) ||
    !isUnknownRecord(node.type) ||
    !normalizePathPortable(node.getSourceFile().fileName).endsWith('/packages/tilemap-formats/src/tiledJsonParse.ts')
  ) {
    return undefined;
  }
  return `${subject} aliases unknown values only at the untrusted Tiled TMJ/TSJ JSON ingress. parseJson is the sole producer: JSON.parse yields an erased value, and isJsonObject admits only a non-array object before the record crosses parser-helper boundaries. Every current member consumer then guards or normalizes the raw value: arrayField and objectField re-establish object structure; boolField, numField, strField, numOrString, and the enum normalizers produce closed scalars or defaults; layer data becomes a Uint32Array; and coercePropertyValue produces the closed TiledProperty scalar domain. Only typed TiledMap and TiledTileset values or fixed diagnostic details leave the parser. A reviewed source-portability exception for this exact alias is justified only while parseJson remains the sole producer, every raw member stays behind those guards and normalizers, and no JsonObject or unknown member is returned, retained, serialized, or placed in a diagnostic. If raw JSON must cross that boundary, declare recursive named closed TiledJsonValue and TiledJsonObject domains and validate the parsed root before transporting it. The compiler will not assume that unknown contains only JSON values, choose a target-specific Any carrier, insert a cast, copy or materialize the parsed JSON, or bypass the existing validation path.`;
}

function getLottieOpaquePayloadGuidance(
  node: ts.PropertySignature,
  subject: string,
  kinds: ReadonlySet<OpaqueTypeKind>,
): string | undefined {
  if (
    kinds.size !== 1 ||
    !kinds.has('unknown') ||
    !normalizePathPortable(node.getSourceFile().fileName).endsWith('/packages/types/src/LottieDocument.ts')
  ) {
    return undefined;
  }
  if (subject === 'interface:LottieDocument/property:chars') {
    return `${subject} declares unknown elements for the Lottie character-data array document.chars. createScene2DFromLottieDocument accepts a JSON string or a caller-owned shallow Readonly<LottieDocument>; parseLottieDocument returns the object unchanged, while the JSON.parse result is only cast without validating or cloning its members. JSON input limits those elements to JSON values, but caller-owned elements can be arbitrary JavaScript values, so neither ingress proves a smaller character schema. isValidLottieDocument checks only fr, ip, op, w, h, and layers. The source document is temporarily reachable through LottieImportContext during the synchronous import, but the importer never reads document.chars, mutates or copies it, places it in a diagnostic, serializes it, or includes it in the returned LottieDocumentImportResult. Its presence, omission, and payload identity cannot affect the imported result, so this is unused input baggage, not a runtime value domain that a portable target must transport. Remove chars from the portable LottieDocument projection; structural JSON parsing will still ignore the extra raw key. If glyph import is implemented, define a named closed LottieCharacterData domain with distinct shape and precomposition arms, then validate or normalize both ingress paths before retaining or consuming chars. Do not whitelist this unused erased field or map it to a target Any carrier: representation is not the gap. The compiler will not erase an unsupported declared member, infer a character schema from JSON, validate JSON.parse, clone or freeze caller-owned arrays, or decide when glyph import exists.`;
  }
  const textPayload =
    subject === 'interface:LottieTextData/property:a'
      ? { domain: 'text-animator array', exposure: 'unknown elements' }
      : subject === 'interface:LottieTextData/property:m'
        ? { domain: 'LottieTextData.m payload', exposure: 'an unknown value' }
        : subject === 'interface:LottieTextData/property:p'
          ? { domain: 'LottieTextData.p payload', exposure: 'an unknown value' }
          : undefined;
  if (!textPayload) return undefined;
  const property = getNodeName(node.name);
  return `${subject} declares ${textPayload.exposure} for the Lottie ${textPayload.domain}. The JSON-string and caller-owned-object ingress paths do not validate nested text data: parsed input can state any JSON value, while caller-owned unknowns can carry arbitrary JavaScript values. isValidLottieDocument does not inspect layer.t. Although the declaration comment claims the data is retained and diagnosed, appendLottieText is the only production consumer of LottieTextData: it reads only d.k[0].s and never reads or diagnoses ${property}. The source graph is reachable only through the synchronous import context; the importer does not copy ${property} into a node, track, diagnostic, or result, so its presence, omission, and payload identity cannot affect the imported result. This is unused input baggage, not a runtime value domain that a portable target must transport. Remove ${property} from the portable LottieTextData projection; structural JSON parsing will still ignore the extra raw key. If this feature is implemented, give ${property} its own named closed payload and validate or normalize both ingress paths before retaining or interpreting it; do not merge LottieTextData.a, .m, and .p into one carrier. Do not whitelist this unused erased field or map it to a target Any carrier: representation is not the gap. The compiler will not erase an unsupported declared member, infer an animator schema from JSON, validate JSON.parse, clone or freeze caller-owned arrays, or decide when text animation exists.`;
}

function renderUncheckedDoubleAssertionMessage(
  node: ts.AsExpression | ts.TypeAssertion,
  subject: string,
  bridge: 'any' | 'never' | 'unknown',
): string {
  const entityRuntimeStrip = getEntityRuntimeStripDoubleAssertionGuidance(node, subject, bridge);
  if (entityRuntimeStrip) return entityRuntimeStrip;
  const entityGuardProxy = getEntityGuardProxyDoubleAssertionGuidance(node, subject, bridge);
  if (entityGuardProxy) return entityGuardProxy;
  const nodeBoundsParent = getNodeBoundsParentDoubleAssertionGuidance(node, subject, bridge);
  if (nodeBoundsParent) return nodeBoundsParent;
  const nodeRuntimeFactory = getNodeRuntimeFactoryDoubleAssertionGuidance(node, subject, bridge);
  if (nodeRuntimeFactory) return nodeRuntimeFactory;
  const textureCubeFaces = getTextureCubeFacesDoubleAssertionGuidance(node, subject, bridge);
  if (textureCubeFaces) return textureCubeFaces;
  const material = getMaterialDoubleAssertionGuidance(node, subject, bridge);
  if (material) return material;
  const gltfMaterialExtension = getGltfMaterialExtensionDoubleAssertionGuidance(node, subject, bridge);
  if (gltfMaterialExtension) return gltfMaterialExtension;
  const awd2MaterialHandler = getAwd2MaterialHandlerDoubleAssertionGuidance(node, subject, bridge);
  if (awd2MaterialHandler) return awd2MaterialHandler;
  const signalCallable = getSignalCallableDoubleAssertionGuidance(node, subject, bridge);
  if (signalCallable) return signalCallable;
  const genericOwnerArgument = getGenericOwnerArgumentDoubleAssertionGuidance(node, subject, bridge);
  if (genericOwnerArgument) return genericOwnerArgument;
  const nodeInteractiveStateBinding = getNodeInteractiveStateBindingDoubleAssertionGuidance(node, subject, bridge);
  if (nodeInteractiveStateBinding) return nodeInteractiveStateBinding;
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
