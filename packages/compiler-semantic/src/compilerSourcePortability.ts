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
    return `${subject} gives the anchor constraint ${name} both an omitted state and explicit null, but current Flight gives them one inactive meaning. In-memory construction sites omit inactive constraints; the generic FlightDocument read, write, and clone paths may preserve an explicit null inside itemStyle without attaching anchor-specific meaning. isOptionalNumber accepts both null and undefined, and anchorLayoutResolver normalizes left, right, top, and bottom with ?? null. When opposing pins do not determine an axis, its width and height expressions each use ?? intrinsicSizes, so either absence spelling selects the same natural-size fallback before placement uses a pin or alignment. Make all six bottom, height, left, right, top, and width constraints optional number fields and reserve null for the enclosing LayoutNode.itemStyle no-style sentinel. If a serialized or public compatibility input must continue accepting explicit null, keep that boundary shape separate and normalize it once into the optional-number layout style; if explicit clear must differ from omission, name a closed constraint-state union and handle it separately. The compiler will not whitelist a redundant spelling. It will not preserve a redundant third sentinel in target storage, infer a numeric default because zero is a real pin or size, collapse a present value, rewrite an input boundary, or add side storage.`;
  }
  return undefined;
}

function getScene3DRenderProxyMixedAbsencePropertyMessage(
  node: ts.PropertySignature,
  subject: string,
): string | undefined {
  const name = getNodeName(node.name);
  if (
    ts.isInterfaceDeclaration(node.parent) &&
    node.parent.name.text === 'Scene3DRenderProxy' &&
    normalizePathPortable(node.getSourceFile().fileName).endsWith('/packages/types/src/Scene3DRenderProxy.ts') &&
    (name === 'colorMatrix' ||
      name === 'colorScaleBias' ||
      name === 'instanceColors' ||
      name === 'instanceMatrices' ||
      name === 'jointMatrices' ||
      name === 'normalMatrices')
  ) {
    return `${subject} gives the reused per-draw proxy slot ${name} both an omitted state and explicit null, but the current renderers have one inactive state. GL and WebGPU overwrite colorMatrix, colorScaleBias, jointMatrices, and normalMatrices with a value or null on every draw, and each writes instanceMatrices for an instanced draw before clearing it to null afterward. GL likewise writes and clears its separate instanceColors slot; WebGPU instead packs instance colors beside matrices in one instance buffer and never reads that slot. Shader preparation treats null and undefined identically with nullish checks before binding or uploading. Make all six colorMatrix, colorScaleBias, instanceColors, instanceMatrices, jointMatrices, and normalMatrices slots required nullable fields on the internal Scene3DRenderProxy scratch record, initialize all six to null, and overwrite or clear every backend-owned slot before each draw so a reused proxy cannot retain prior-draw state. If compatibility inputs may omit a slot, normalize them once at the boundary into that required internal record. The compiler will not choose between two equivalent absence sentinels, infer a palette or color default, synthesize presence bits, retain stale state, copy or materialize a buffer, or add side storage.`;
  }
  return undefined;
}

function getMeshDeformationMixedAbsencePropertyMessage(
  node: ts.PropertySignature,
  subject: string,
): string | undefined {
  const name = getNodeName(node.name);
  if (
    ts.isInterfaceDeclaration(node.parent) &&
    normalizePathPortable(node.getSourceFile().fileName).endsWith('/packages/types/src/Mesh.ts') &&
    ((node.parent.name.text === 'Mesh' && (name === 'morph' || name === 'skin')) ||
      (node.parent.name.text === 'MeshDeformRuntime' && name === 'deformedLocalBounds'))
  ) {
    if (name === 'morph') {
      return `${subject} gives the mesh deformation slot morph both an omitted state and explicit null, but current Flight has one no-morph state. createMesh omits morph, while cloneMesh and scene-document import assign it only when a MeshMorph is present. updateMeshMorph, getMeshDeformer, animation routing, and the GL deform guard all use nullish checks; GL and WebGPU draw the geometry that preparation updates, so neither backend observes which absence spelling reached the mesh. Make morph an optional non-null MeshMorph field and use omission or undefined as its sole inactive state. If a public or serialized input must still accept null, normalize it once at the construction boundary. The compiler will not preserve a redundant null sentinel, infer or create a morph, rewrite or clone the mesh or its geometry, copy or materialize deformation storage, or add side storage.`;
    }
    if (name === 'skin') {
      return `${subject} gives the mesh deformation slot skin both an omitted state and explicit null, but current Flight has one rigid state. createMesh omits skin, while cloneMesh and scene-document import assign it only when a Skin is present. updateMeshSkin and prepareMeshSkinning return on a nullish skin, GL forward and shadow draws require skin != null, and the WebGPU skin adapter returns false for skin == null; no producer or consumer distinguishes null from undefined. Make skin an optional non-null Skin field and use omission or undefined as its sole inactive state. If a public or serialized input must still accept null, normalize it once at the construction boundary. The compiler will not preserve a redundant null sentinel, infer or create a skin or palette, rewrite or clone the mesh, copy or materialize deformation storage, or add side storage.`;
    }
    return `${subject} gives the mesh deformation slot deformedLocalBounds both an omitted state and explicit null, but current Flight has one uncached state. prepareMeshSkinning is its producer: it allocates and stores one Aabb when the slot is nullish, updates that same box thereafter, and never writes null. Shared culling before GL or WebGPU draws falls back with ?? to geometry bounds, picking uses a nullish presence check, and the GL deform guard treats both absence spellings alike. Make deformedLocalBounds an optional non-null Aabb field and use omission or undefined as its sole uncached state. If an external runtime snapshot must still accept null, normalize it once before admitting it to MeshDeformRuntime. The compiler will not preserve a redundant null sentinel, infer bounds or run skinning, rewrite or clone the mesh, copy or materialize deformation storage, or add side storage.`;
  }
  return undefined;
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
    return `${subject} gives the retained Skeleton2D wardrobe list both omission and explicit null, but current Flight has one no-wardrobe state. createSkeleton2D always initializes skins to null. The Spine JSON, Spine binary, and DragonBones importers leave that null intact when parsing produces no skins and overwrite it only with a non-empty AttachmentSkin2D array; Rive's pure-bone skeleton likewise retains null. initializeSkeleton2D stores the exact argument, and cloneSkeleton2D preserves the exact skins array owner rather than copying it. getSkeleton2DSkin returns null for either undefined or null before searching a present array, and no other production consumer reads the collection. Make Skeleton2D.skins a required AttachmentSkin2D[] | null field, keep createSkeleton2D's null initializer, narrow initializeSkeleton2D's parameter to the same required-nullable type, and retain each importer's non-empty assignment plus the clone's shared array identity. A present empty array remains a present collection and must not be substituted for either absence spelling. If structural or compatibility inputs allow omission, give them a separate shape and normalize once before initializing the live skeleton. The C++ backend can retain the current null, undefined, and exact array alternatives and can represent the required-nullable rewrite without Any; that carrier support does not give the second absence spelling a source meaning. The compiler will not whitelist a redundant absence spelling, choose or collapse a sentinel, infer or parse a wardrobe, apply a skin, substitute an empty array, copy or materialize the skin collection or its attachment owners, reinterpret or cast it, or add side storage.`;
  }
  if (name === 'slots' && isOptionalNullableNamedArrayProperty(node, 'Slot2D')) {
    return `${subject} gives the live Skeleton2D slot and draw-order list both omission and explicit null, but current Flight has one no-slots state. createSkeleton2D defaults slots to null; the Spine JSON, Spine binary, and DragonBones importers pass their parsed Slot2D array, including an empty array, while Rive's pure-bone skeleton keeps the default null. initializeSkeleton2D stores that exact value, cloneSkeleton2D allocates new records for a present slot array while preserving either absence spelling, and disposeSkeleton2D explicitly clears the cell to null. setSkeleton2DSkin, slot animation, deform animation, and path-attachment resolution all return for both undefined and null before indexing a present array. Make Skeleton2D.slots a required Slot2D[] | null field, narrow createSkeleton2D and initializeSkeleton2D to that type, preserve null as the pure-rig and disposed sentinel, and simplify the clone and consumers to the single null check while retaining their present-array behavior. A present empty array remains an authored slot list and must not be replaced with null. If structural or compatibility inputs allow omission, give them a separate shape and normalize once before initializing the live skeleton. The C++ backend can retain the current null, undefined, and exact array alternatives and can represent the required-nullable rewrite without Any; that carrier support does not give the second absence spelling a source meaning. The compiler will not whitelist a redundant absence spelling, choose or collapse a sentinel, infer or parse slots, apply a skin or animation, solve a path constraint, substitute an empty array, copy or materialize slot or attachment owners beyond the authored clone, reinterpret or cast them, or add side storage.`;
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

function isOptionalNullableNamedTypeUnionProperty(node: ts.PropertySignature, names: readonly string[]): boolean {
  if (!node.type || node.questionToken === undefined || !hasNullType(node.type)) return false;
  const presentNames = getMixedAbsencePresentTypes(node.type).map((member) => {
    while (ts.isParenthesizedTypeNode(member)) member = member.type;
    return ts.isTypeReferenceNode(member) && member.typeArguments === undefined
      ? getNodeName(member.typeName)
      : undefined;
  });
  return presentNames.length === names.length && names.every((name) => presentNames.includes(name));
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
  const isAuthoredName =
    (owner === 'Attachment2D' && isFlightTypesSource(node, 'Attachment2D.ts')) ||
    (owner === 'Bone2D' && isFlightTypesSource(node, 'Bone2D.ts')) ||
    (owner === 'Material' && isFlightTypesSource(node, 'Material.ts'));
  if (!isAuthoredName) return undefined;
  return `${subject} gives the internal ${owner} authored-name slot both omission and explicit null, but the represented records have one anonymous state: Spine and DragonBones parsers write a string or null for every attachment and bone they construct, initializeMaterial writes null before material importers optionally replace it, and the bone, attachment, and material lookup paths recognize only exact present strings. Make Attachment2D.name, Bone2D.name, and Material.name required string | null fields and initialize every construction path to null when no authored name exists. If structural convenience inputs must allow omission, give those inputs separate shapes and normalize them once before constructing the internal record. If omitted, anonymous, and named are genuinely distinct states, replace the two absence spellings with one named closed state and handle every arm explicitly. The compiler will not choose or collapse an absence sentinel, infer a name from kind or position, rewrite name lookup, clone or materialize an owner, reinterpret or cast the string, or add side storage.`;
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
    (name === 'maxLines' || name === 'wrapWidth')
  ) {
    return `${subject} gives the BitmapText construction option ${name} both omission and explicit null, but createBitmapText applies this option only to fresh BitmapTextData: initializeBitmapTextData has already defaulted maxLines and wrapWidth to null, and applyBitmapTextOptions writes each field only when it is not undefined, so either absence spelling produces the same stored disabled state. Keep BitmapTextData and the dedicated setters required nullable, but make maxLines and wrapWidth optional number fields in BitmapTextOptions so omission is the sole construction-time absence. If the same input shape later becomes a mutation patch, define a named closed update state whose unchanged, disabled, and numeric cases are explicit. The compiler will not choose or collapse an absence sentinel, infer a numeric default because zero is a present limit or width, rewrite existing BitmapTextData, call a setter, or add side storage.`;
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
  return `${subject} gives the Capacitor geolocation provider coordinate altitudeAccuracy both explicit null and explicit undefined, but host-capacitor's toGeoPosition evaluates coords.altitudeAccuracy ?? 0 into required numeric GeoPosition.altitudeAccuracy. Both absence sentinels therefore become the same zero fallback at provider ingress, while a present zero remains a real reported accuracy. Keep GeoPosition.altitudeAccuracy a required number and retain one explicit nullish normalization at the adapter boundary, but give CapacitorPositionCoords.altitudeAccuracy exactly one provider-side absence representation: use required number | null when the provider guarantees the field with null for unavailable data, or optional number without null when omission is its contract. If null and omission carry different provider meanings, model a named closed provider state and normalize each arm deliberately before constructing GeoPosition. The compiler will not choose or collapse an absence sentinel, infer which provider contract applies, replace a present zero, select or synthesize a numeric fallback, rewrite the host adapter or canonical coordinate storage, reinterpret or cast the value, or add side storage.`;
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
  return `${subject} gives the create-only texture resource association both omission and explicit null, but createTexture and createTexture2D each pass opts?.resource to attachTextureToResource, whose resource != null guard skips both absence spellings and pushes the texture only for a present ImageResourceReference owner. The two-dimensional return path performs that attachment in createTexture2D instead of falling through to the shared createTexture call, so a present resource receives the texture exactly once. Declare CreateTextureOptions.resource as optional ImageResourceReference without null so omission is the sole no-association input, while retaining the exact resource owner when present. If the options shape later becomes an update patch where omission means unchanged and null means detach, replace the property with one named closed association state and handle every arm explicitly. The compiler will not choose or collapse an absence sentinel, attach or detach a texture, infer a resource from its source, allocate or mutate the resource texture list, copy or materialize either owner, rewrite dimension dispatch, reinterpret or cast the association, or add side storage.`;
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
  return `${subject} gives the one-shot TreeViewController initial selection both omission and explicit null, but createTreeViewController writes selectedItem: options.selectedItem ?? null into required Readonly<TreeViewControllerItem> | null runtime storage, so both absence spellings create the same unselected state while a present item owner is retained unchanged. The live setter accepts an item or null, normalizes a foreign item to null, and emits only after a real selection change; disposal clears the runtime field to null and the getter returns that required nullable state. Declare TreeViewControllerOptions.selectedItem as optional TreeViewControllerItem without null so omission is the sole construction-time unselected state, while keeping the runtime field, setter parameter, and getter result required nullable. If the options shape later becomes an update patch where omission means unchanged and null means clear, replace the property with one named closed selection state and handle every arm explicitly. The compiler will not choose or collapse an absence sentinel, select or validate an item, emit a selection signal, infer an item from the roots, copy or materialize the item owner, rewrite controller disposal or navigation, reinterpret or cast the selection, or add side storage.`;
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
  return `${subject} gives the paired morph-gradient endpoint matrix both omission and explicit null, but appendMorphShapeGradientPaint evaluates start.matrix ?? null and end.matrix ?? null before creating its binding. When either endpoint supplies a matrix, an absent side uses identityMatrix and both resolved matrices are cloned; when neither supplies one, MorphShapeGradientPaintBinding.startMatrix and endMatrix are both null. The two input absence spellings are therefore identical, while a present identity matrix is still an authored matrix value. Keep the binding's startMatrix and endMatrix fields required Readonly<Matrix> | null as resolved sampling state, but declare MorphShapeGradientEndpoint.matrix as optional Readonly<Matrix> without null so omission is the sole authoring-time absence. If authoring later distinguishes an inherited matrix from an explicitly disabled matrix, replace the property with one named closed endpoint state and resolve every arm before constructing the binding. The compiler will not choose or collapse an absence sentinel, treat a present identity matrix as absent, infer the paired endpoint, select or synthesize identityMatrix, clone or materialize a Matrix, rewrite paint sampling or binding storage, reinterpret or cast the value, or add side storage.`;
}

function getNormalizedStringOptionMixedAbsencePropertyMessage(
  node: ts.PropertySignature,
  subject: string,
): string | undefined {
  if (!ts.isInterfaceDeclaration(node.parent) || !isOptionalNullableStringProperty(node)) return undefined;
  const field = getNodeName(node.name);
  const owner = node.parent.name.text;
  let guidance:
    | {
        readonly destination: string;
        readonly normalization: string;
        readonly presentMeaning: string;
      }
    | undefined;
  if (isFlightTypesSource(node, 'GltfExtension.ts') && owner === 'GltfImportOptions' && field === 'basePath') {
    guidance = {
      destination: 'ImageResourceReference.basePath',
      normalization:
        'buildGltfImageResourceReference passes options?.basePath ?? null to createExternalImageResourceReference, whose basePath stays required nullable through external URI resolution',
      presentMeaning: 'base path',
    };
  } else if (
    isFlightTypesSource(node, 'Scene2DResources.ts') &&
    owner === 'Scene2DDocumentLoadOptions' &&
    field === 'mimeType'
  ) {
    guidance = {
      destination: 'Scene2DDocumentImportContext.mimeType',
      normalization:
        'loadScene2DDocumentFromUrl writes mimeType: options?.mimeType ?? null into the required nullable Scene2DDocumentImportContext; createScene2DDocumentFromBytes then passes that context unchanged to each registry matcher and the selected importer, while the Lottie, SVG, and SWF matchers compare only their exact MIME strings before falling back to byte sniffing',
      presentMeaning: 'MIME hint',
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
  return `${subject} gives the normalized string input ${owner}.${field} both omission and explicit null, but ${guidance.normalization}. That ?? null boundary makes the two absence spellings identical while an empty string remains a present ${guidance.presentMeaning}. Keep ${guidance.destination} required nullable, but declare ${owner}.${field} as an optional string so omission is the sole input-side absence. If the input later becomes an update patch where omission means unchanged and null means clear, replace the property with one named closed input state and handle each arm explicitly. The compiler will not choose or collapse an absence sentinel, replace a present empty string with null or a default, synthesize a replacement ${guidance.presentMeaning}, rewrite the caller or downstream storage, reinterpret or cast the value, or add side storage.`;
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
  return `${subject} gives the one-shot Scene2D audio load's platform decoder context both omission and explicit null, but loadScene2DAudioResources immediately evaluates options?.context ?? null and passes that required AudioContext | null unchanged to resolveAudioResourceReference for every selected reference. External references resolve only through the fetch seam and never inspect the context. Embedded references first try a registered MIME decoder; decodeAudioResourceBytes calls AudioContext.decodeAudioData only when no registered decoder handled the bytes and returns null when the normalized context is null. Thus omitted and explicit-null options both disable only the platform decode fallback, while a present AudioContext owner is borrowed unchanged for this operation and never retained. Declare LoadScene2DAudioResourcesOptions.context as optional AudioContext without null, and keep the required nullable resolver and decoder parameters plus the ?? null normalization at the load boundary. If omission and an explicit platform-decoder disable must differ, replace the property with one named closed context-input state and resolve every arm before loading. The compiler will not whitelist a redundant absence spelling, choose or collapse a sentinel, construct, resume, or close an AudioContext, select or invoke a decoder or fetcher, copy or materialize the host context owner, rewrite reference state or load results, reinterpret or cast the context, or add side storage.`;
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
    return `${subject} gives the Camera3D construction owner nearClipPlane both omission and explicit null, but createCamera3D passes its options once to initializeCamera3D for a fresh camera, where out.nearClipPlane = opts.nearClipPlane ?? null normalizes either spelling to the same disabled clipping state. getCamera3DViewProjectionMatrix4 applies the plane only when present, while reflectCamera3DByPlane copies the live required nullable field directly. Keep Camera3D.nearClipPlane required nullable so runtime code can install or clear a plane, but make Camera3DOptions.nearClipPlane an optional Plane without null so omission is the sole construction-time absence. If the options shape later becomes a mutation patch, define a named closed update state whose unchanged, disabled, and present-plane cases are explicit. The compiler will not choose or collapse an absence sentinel, infer or construct a Plane, rewrite or reflect the camera, copy or materialize the plane owner, or add side storage.`;
  }
  if (
    source.endsWith('/packages/types/src/EnvironmentOptions.ts') &&
    node.parent.name.text === 'EnvironmentOptions' &&
    name === 'environment' &&
    isOptionalNullableNamedTypeProperty(node, 'Texture')
  ) {
    return `${subject} gives the Environment construction owner environment both omission and explicit null, but createEnvironment passes its options once to initializeEnvironment for a fresh entity, where out.environment = options?.environment ?? null normalizes either spelling to the same disabled radiance state. GL and WebGPU environment-cube consumers test the required nullable field against null before using the exact Texture owner. Keep Environment.environment required nullable so runtime code can install or clear a texture, but make EnvironmentOptions.environment an optional Texture without null so omission is the sole construction-time absence; cloneEnvironment must omit the option when source.environment is null and pass the existing owner unchanged when present. If the options shape later becomes a mutation patch, define a named closed update state whose unchanged, disabled, and present-texture cases are explicit. The compiler will not choose or collapse an absence sentinel, infer or construct a Texture, rewrite or clone the environment, copy or materialize the texture owner, or add side storage.`;
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
  const isTarget =
    field === 'currentRenderTarget' &&
    isOptionalNullableNamedTypeUnionProperty(node, ['GlCubeRenderTarget', 'GlRenderTarget']);
  const isScissor = field === 'currentScissorRect' && isOptionalNullableNamedTypeProperty(node, 'GlScissorRect');
  if (!isTarget && !isScissor) return undefined;
  return `${subject} gives the active GL render-pass tracking slot ${field} both omission and explicit null, but the represented runtime has one outside-pass or inactive state. createGlRenderStateRuntime already assigns runtime.currentRenderTarget = null; _createGlRenderStateFromContext and test helpers assign runtime.currentScissorRect = null, while saveGlPassState normalizes both slots with ?? null and restoreGlPassState, GL state brackets, and cube-face passes save and restore them directly. beginGlRenderPass writes the current target and active scissor together, invalidateGlRenderStateCache clears the tracked scissor to null, and consumers use == null or ?? null before target and scissor work. Make currentRenderTarget a required GlCubeRenderTarget | GlRenderTarget | null field and currentScissorRect a required GlScissorRect | null field, initialize both in createGlRenderStateRuntime so every exported construction path receives the complete contract, and preserve the direct pass save and restore assignments; the analogous Canvas and WebGPU pass-state slots are already required nullable. If a lifecycle must distinguish an uninitialized runtime from a constructed runtime outside a pass, model that as a closed runtime or pass state rather than as a second field-level absence sentinel. The compiler will not choose or collapse an absence sentinel, infer a render target or scissor rectangle, bind or clear a framebuffer, alter the pass or clip stack, copy or materialize a target or rectangle, or add side storage.`;
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
    return `${subject} gives the lazily installed GL pending-draw seam both omission and explicit null, but the represented runtime has one uninstalled state. _createGlRenderStateFromContext and the GL test helpers initialize flushPendingDraws to null, while createGlRenderStateRuntime is the exported construction path that still omits it. prepareGlQuadBatchWrite installs the exact flushGlQuadBatchWriter callback before it can queue a batch; beginGlCubeRenderFace and pushGlRenderState optional-call the slot before handing GL state to another owner, so null and undefined perform the same no-flush action. Make flushPendingDraws a required ((state: GlRenderState) => void) | null field, initialize it to null in createGlRenderStateRuntime, and preserve the lazy scene2d-gl assignment and nullish calls. Initializing the header-owned slot does not import or install scene2d-gl, so applications that never use its quad writer retain no implementation. If uninstalled and deliberately disabled must differ, replace the sentinels with a named closed seam state and handle every arm explicitly. The compiler will not choose or collapse an absence sentinel, import or install a batch writer, invoke or synthesize a flush callback, reorder a flush around GL state capture, widen its callable signature, or add side storage.`;
  }
  if (field === 'glRenderTextureGuard' && isOptionalNullableNamedTypeProperty(node, 'GlRenderTextureGuard')) {
    return `${subject} gives the opt-in GL render-texture diagnostic guard both omission and explicit null, but the represented runtime has one disabled state. createGlRenderStateRuntime currently omits the slot; setGlRenderTextureGuard overwrites it with the exact guard or null, enableGlRenderTextureGuards installs the warning guard through that setter, and render-texture notification optional-calls the slot. Make glRenderTextureGuard a required GlRenderTextureGuard | null field and initialize it to null in createGlRenderStateRuntime, retaining the nullable setter and optional call. Null initialization does not import or install the diagnostic module, so its logger and warning implementation remain shakeable. If disabled and not-yet-configured must differ, replace the sentinels with a named closed guard state and handle every arm explicitly. The compiler will not choose or collapse an absence sentinel, import or install a diagnostic guard, invoke or synthesize a callback, widen its callable signature, change render-texture publication, or add side storage.`;
  }
  if (
    field === 'quadBatchWriterUniformColorScaleBias' &&
    isOptionalNullableNamedAndReadonlyNumberArrayUnionProperty(node, ['ColorScaleBias', 'TintMaterialData'])
  ) {
    return `${subject} gives the GL quad batch's uniform color-adjustment scratch slot both omission and explicit null, but its mode field is the authority and the represented scratch value has one empty state. registerGlColorAdjustmentMaterialFeature initializes the mode on opt-in; recordGlColorAdjustment normalizes an absent mode to NONE and the uniform slot with ?? null, writes the exact ColorScaleBias, TintMaterialData, or readonly number[] owner only when the first adjusted instance selects UNIFORM mode, and promotes that owner when later values diverge. flushGlColorAdjustmentMaterialFeature returns before reading the slot in NONE mode, otherwise normalizes it with ?? null and clears it to null after capture. Make quadBatchWriterUniformColorScaleBias a required ColorScaleBias | TintMaterialData | readonly number[] | null field and initialize it to null in createGlRenderStateRuntime; preserve the mode as the state-machine discriminant and the null clear after flush. Initializing a null header-owned scratch slot does not register the color-adjustment feature or retain its shader implementation. If empty, uniform, and promoted storage need a stronger invariant, model the batch fold as one named closed state whose uniform arm owns the exact adjustment value. The compiler will not choose or collapse an absence sentinel, infer a fold mode or identity adjustment, register the feature, compile or bind a shader, copy or materialize adjustment data, reinterpret or cast an owner, or add side storage.`;
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
    return `${subject} gives the construction-time skin-sampler location ${field} both omission and explicit null, but the represented program has one unusable state. The Classic, Debug, Matcap, PBR, Shaded, Toon, Unlit, and Wireframe factories plus compileShadowDepthSkinnedProgram assign both joint sampler lookups, including null for a variant without the uniform; compileGlCustomShaderProgram, compileShadowDepthProgram, and compileShadowDepthInstancedProgram omit both slots, and no later path resolves either one. ${consumer}. Make locJointTexture and locJointNormalTexture required WebGLUniformLocation | null fields, retain each exact getUniformLocation result, and initialize both to null in the three factories that currently omit them. If factory provenance must differ from a linked program that lacks the sampler, replace the pair with one named closed skin-program capability and handle every arm explicitly. The C++ backend can preserve the current null and undefined tags and the exact WebGLUniformLocation alternative, but that representation support does not make the duplicate unusable sentinel a source contract. The compiler will not choose or collapse an absence sentinel, query or bind a GL uniform, infer whether a program supports skinning, coordinate the pose and normal samplers, reinterpret or cast a location, or add side storage.`;
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
  return `${subject} gives the lazy GL uniform-location cache ${field} three observed states: undefined means unresolved, null means getUniformLocation already proved the linked program omits the uniform, and WebGLUniformLocation means present. ${producerAndConsumer}. Preserve that query-once contract by replacing the optional-null field with ${rewrite} and handling every arm explicitly. Do not collapse undefined to null, which would skip the first query, or null to undefined, which would repeat the query on later draws or binds. The C++ backend already represents all three tags, exact location assignment, and strict undefined/null probes without Any, casts, or side storage, so no compiler lowering change is warranted; representation support does not replace the source's named cache state. The compiler will preserve authored states but will not query GL, choose or collapse a sentinel, infer or synthesize a location, coordinate related cache fields, reinterpret or cast a location, or add side storage.`;
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
  return `${subject} gives the persisted FlightDocument node interaction slot ${field} both omission and explicit null, but the represented contract has one inactive state and transition is invalid without interactiveStates. flightDocumentText.readNode returns { children, fields, interactiveStates, kind, transition }, and the 2D and 3D scene writers assign both fields from readInteractiveStateBindingMetadata; format, refusal, and materialization paths collapse undefined and null with == null, != null, or ?? null. By contrast, substituteNode rebuilds { children, fields, kind }, demonstrating how optional storage can silently discard present interaction metadata. Make interactiveStates and transition required nullable fields on FlightDocumentNode, normalize omitted input syntax to null at ingress, and initialize or deliberately preserve both fields in every parser, writer, and reconstruction path. If callers need to distinguish absent syntax from disabled interaction, use a separate input shape or one named closed metadata state before constructing the persisted node. The compiler will not choose or collapse an absence sentinel, infer a transition from interactive states, decide whether a transformation preserves or clears metadata, clone or materialize either metadata owner, route it through Any, reinterpret or cast it, or add side storage.`;
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
  return `${subject} gives the opt-in AnimationPlayer signal ${field} both omission and explicit null, but the represented player has one signal-free state. cloneAnimationPlayer and initializeAnimationPlayer assign onEvent, onFinished, and onLooped to null; createAnimationPlayer delegates to that initializer, so both library construction paths choose the same sentinel. enableAnimationPlayerSignals checks each slot with == null, installs its exact Signal owner only when absent, is idempotent, and no path clears an enabled slot. ${flow} Make all three slots required fields with their exact callable-bearing Signal type | null, retain the explicit null assignments in the clone and initializer, and keep the nullish guards at emission. Null initialization remains allocation-free: the library creates the three Signal owners only in enableAnimationPlayerSignals. The C++ backend can already preserve the current null and undefined tags, the exact ${ownerType} value alternative, assignments, and nullish guards; that representation support does not choose the source contract's redundant disabled sentinel. If an external compatibility input must still accept omitted signal slots, keep that boundary shape separate and normalize it to null before constructing an AnimationPlayer; if omission and explicit disable must differ, replace them with one named closed signal state and handle every arm explicitly. The compiler will not choose or collapse an absence sentinel, allocate or clone a Signal owner, connect or emit a listener, re-parameterize the callback, route it through Any, reinterpret or cast it, or add side storage.`;
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
  const skeleton2D = getSkeleton2DMixedAbsencePropertyMessage(node, subject);
  if (skeleton2D) return skeleton2D;
  const slot2D = getSlot2DMixedAbsencePropertyMessage(node, subject);
  if (slot2D) return slot2D;
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
  return `${subject} uses a double assertion through unknown to claim that getNodeParent(source), whose declared result is NodeOf<Traits> | null, also carries the Spatial2DNode<Traits> bounds and transform capabilities required as computeNodeBoundsRectangle's target coordinate space. The current Spatial2DNode alias appends HasBoundsRectangle and HasTransform2D outside Traits, while these getters quantify only Traits extends object, so the shared Traits parameter does not prove that a parent returned by the node runtime owns either capability. Put the spatial capabilities inside the family contract: define or constrain Traits to a named HasBoundsRectangle & HasTransform2D base, accept the matching NodeOf<Traits> spatial owner, and pass getNodeParent(source) directly once NodeRuntime<Traits>.parent retains that proof. If the hierarchy genuinely permits a non-spatial parent, use a typed spatial predicate and choose null or another explicit coordinate space when it fails. The compiler will preserve the exact parent owner and null sentinel, but will not infer intersection members that the generic parameter omits, reinterpret or cast the parent, copy or materialize a replacement node, synthesize bounds or transform state, or add side storage.`;
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
        'Branch before the call: invoke createNodeRuntimeFactory() when it is present, otherwise invoke createNodeRuntime<Traits>(), then store the resulting exact runtime owner through Node<Traits>[EntityRuntimeKey], whose declared base slot accepts either result.',
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
    return `${subject} uses a double assertion through ${bridge} to install the represented zero-argument nullSignalEmit implementation in the open callable type parameter T. The bridge is not representation equivalence: each instantiation may require a different emitted parameter signature. Preserve the Signal<T> owner and every stored T slot, and construct only the emit callable through the checked callable-signature binding contract that either forwards T's exact parameters or deliberately ignores them for this no-op implementation. Prefer a named Signal argument-tuple/dispatch type and an exact typed no-op factory so the source no longer needs this assertion. The compiler may bind this represented callable implementation to T, but will not route it through Any, cast between callable carriers, copy or materialize the Signal or its slots, or add side storage; a non-callable or genuinely erased source must be refused.`;
  }
  if (ts.isArrowFunction(implementation) || ts.isFunctionExpression(implementation)) {
    if (signalModule === 'connection.ts' && getEnclosingVariableName(node) === 'trackedSlot') {
      return `${subject} uses a double assertion through ${bridge} to name the represented trackedSlot closure as the open callable type parameter T. Its Parameters<T> rest tuple preserves the invocation signature, but the assertion itself does not prove the open carrier. Preserve the captured SignalConnection<T> and exact T slot, including the connection, once, and slot capture identities, and construct only the wrapper callable through the checked callable-signature binding contract so invocation uses T's instantiated parameter list. Prefer a named Signal argument tuple and express the tracked wrapper in that exact dispatch type so the source no longer needs this assertion. The compiler may bind this represented closure implementation to T, but will not route it through Any, reinterpret or cast a callable owner, copy or materialize the connection or slot owners, or add side storage; a non-callable or genuinely erased source must be refused.`;
    }
    if (signalModule !== 'slot.ts') return undefined;
    return `${subject} uses a double assertion through ${bridge} to name the newly created dispatch implementation as the open callable type parameter T after its rest arguments were declared as any[]. Preserve the captured Signal<T>, SignalData<T>, and every stored T slot by reference, and construct only the returned emit callable through the checked callable-signature binding contract so invocation uses T's instantiated parameter list. Prefer a named Signal argument tuple and declare the dispatch closure with that exact tuple instead of erasing its arguments. The compiler may bind this represented function implementation to T, but will not route it through Any, reinterpret or cast a callable owner, copy or materialize the signal/data/slot owners, or add side storage; a non-callable or genuinely erased source must be refused.`;
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
    return `${subject} erases a stable binding identity even though the current producer and consumer roles are portable and exact. createAnimationChannel and initializeAnimationChannel accept any value and retain it; cloneAnimationClip reuses the exact reference; blend trees, crossfades, state machines, and layer stacks use it as a Map or Set identity key; and sampling passes the channel unchanged. Domain applicators then assert that same value to Node2DAnimationTarget, Scene3DAnimationTarget, MorphShapeAnimationTarget, Skeleton2DAnimationTarget, or format-local Lottie and Rive callback shapes. The skeleton path additionally reads kind and dispatches through an open binder registry before each binder casts the payload it owns. Scene3D document persistence already avoids serializing this live reference: it stores node index plus path and rebuilds a binding only after nodes exist. Replace unknown with an open named AnimationTargetRef entity containing a readonly string kind, and use it for AnimationChannel.targetRef, createAnimationChannel and initializeAnimationChannel, every core Map and Set key, sample visitor, and binder parameter. Keep the registry extensible rather than inventing a closed union: each scene, skeleton, morph, format, or vendor domain allocates a stable AnimationTargetRef with a namespaced kind and stores its concrete node/path, shape, bone/slot, or callback record in a domain-private typed WeakMap keyed by that ref. Its applicator resolves the ref through that map and skips null instead of asserting or shape-probing; an open skeleton binder resolves only the refs created by its paired producer. Reuse the same ref wherever clips must correspond by identity, and keep document serialization in its existing index/path form. Do not whitelist the erased property: the core requires reference identity and interpreting consumers recover structured state from it, so this is neither an unexamined payload nor an unsupported provider handle. The compiler can preserve the AnimationTargetRef entity identity and string kind, but it will not infer a target union from casts or registry entries, choose a target-specific Any carrier, retain or insert a cast, allocate or populate the domain maps, copy or materialize a target or ref, or replace reference equality with structural equality.`;
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
    isFlightTypesSource(node, 'FlightDocumentNodeSchema.ts') &&
    subject === 'type:FlightDocumentResourceLookup' &&
    isReadonlyUnknownRecord(node.type)
  ) {
    return `${subject} is the transient identity map between the open resource-resolver registry and the open node-schema registry. Each registered resolver creates its own live resource value, materialization records that value under the authored key, and registered node factories receive the same lookup and own every interpretation; the scene-document core neither inspects nor serializes a resolved value, and writers receive an empty lookup. This is a genuinely registry-owned opaque resource boundary. Record a reviewed source-portability exception for this exact alias while node schemas own all narrowing and no resolved value enters document fields, results, or portable persistence. If portable code must inspect resources, introduce a named closed tagged FlightDocumentResource handle domain shared by resolvers and node schemas while keeping native resource owners private. The compiler will not infer a union from registered kinds, choose a target-specific Any carrier, insert a cast, or copy or materialize a live resource.`;
  }
  if (
    isFlightTypesSource(node, 'AppWindow.ts') &&
    subject === 'type:NativeWindowHandle' &&
    node.type.kind === ts.SyntaxKind.UnknownKeyword
  ) {
    return `${subject} erases a host-owned native window before the neutral attach boundary. attachWindow forwards the value unchanged, then the web, Electron, and Tauri backends use isWebWindow, isElectronBrowserWindow, and isTauriWindow to cast it to Partial provider interfaces and recognize different method sets before storing the exact native owner in provider-private maps. ApplicationWindow itself stores neither the handle nor the native owner, and each backend's open path already constructs or obtains its exact Window, ElectronBrowserWindow, or TauriWindow without erasure. Use the target-token contract already implemented by InputTargetHandle, FullscreenTargetHandle, and WindowResizeTargetHandle: define NativeWindowHandle as Entity & { readonly __brand: 'NativeWindowHandle' }, then add provider-specific create/initialize pairs such as createWebNativeWindowHandle, createElectronNativeWindowHandle, and createTauriNativeWindowHandle. Each pair allocates and brands a token and records token to exact native owner in a provider-private WeakMap; provider test resets clear that map. Make WindowBackend.attach and attachWindow accept only the token, have each backend resolve it from its own map and return false for an unknown or foreign token, then call its existing exact typed attach helper. Keep open paths, ownership, duplicate-owner rejection, listener cleanup, close behavior, and native-to-ApplicationWindow reverse lookups unchanged, and remove the three structural predicates and their casts. Lower-level native providers use the same token-to-integer-or-object table in their host runtime. The generated ABI therefore carries one reference-shaped NativeWindowHandle and needs no Any alternative or new compiler runtime binding. Current Flight defines this alias in ApplicationWindow.ts even though the finding's older source path is AppWindow.ts. Do not whitelist the erased alias. The compiler will not infer one union from DOM, Electron, Tauri, or integer owners, choose a target-specific Any carrier, retain or insert a cast, inspect provider methods, copy or materialize the native window, allocate a token implicitly, or add provider storage.`;
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
  return `${subject} unnecessarily erases the browser-owned stream at a host capability boundary. createWebVideoResourceFromMediaStream is the only production caller and already has a MediaStream; the web provider only creates an HTMLVideoElement, assigns that same stream to srcObject, and returns the element as HostImageSource. Portable VideoResource state retains the element rather than the stream. Remove attachStream from HostVideoCapability and its provider, replace the capability with VideoCapabilityBackend exposing canPlayType plus optional createVideoElement, and make createVideoResourceFromMediaStream accept Readonly<VideoCapabilityBackend> and MediaStream directly. Have that function request the element, return null when unavailable, assign element.srcObject = stream, and construct an owned VideoResource from the element. On destruction, clear srcObject only for that owned element without stopping the caller-owned tracks. Current Flight already applies this rewrite in VideoCapabilityBackend.ts, videoResourceFrom.ts, and videoResource.ts, so no opaque stream handle or compiler carrier is needed. Do not whitelist the obsolete unknown parameter. The compiler will not assume MediaStream for every host capability, choose a target-specific Any carrier, retain the erased provider method, insert a cast for the stream, copy or materialize the live stream, stop its tracks, or add side storage.`;
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
  return `${subject} gives structured log records an open value domain even though every sink and LogSignals receive the raw LogEntry. Memory and buffered sinks can retain data before registered kind serializers and redaction run inside the JSON formatter, while text and custom formatters need the same declared values directly. Define a recursive named closed LogFieldValue domain covering portable scalars, arrays, and string-keyed records plus a LogFields record alias; make LogData string | LogFields and use LogFields for context fields, span fields, serializer results, and serializeLogError. Normalize current live object producers into those values before LogEntry construction. Do not whitelist the transport domain: the compiler will not infer a schema from logger call sites, invoke late serializers, stringify arbitrary fields, choose a target-specific Any carrier, insert a cast, or copy or materialize the record.`;
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
    return `${subject} is the application-owned result of accepting or dismissing a dialog entry. closeGuiDialog reads only entryId to validate the active entry, removes that entry, and emits the same result through onClose without inspecting, coercing, retaining, or serializing value. This is a genuinely application-opaque result boundary. Record a reviewed source-portability exception for this exact property while producers and listeners exclusively own the payload meaning and the GUI core remains identity transport. If close values enter portable persistence or shared interpretation, replace unknown with a named closed GuiDialogCloseValue domain or entry-discriminated result arms shared by close callers and listeners. The compiler will not infer a schema from entryId or listeners, choose a target-specific Any carrier, insert a cast, or copy or materialize the payload.`;
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
    return `${subject} is a heterogeneous command-property slot: ${source}, merge preserves it, and the matching binding writes it back on ${field === 'after' ? 'execute or redo' : 'undo'} without inspecting or coercing it. The string property key ranges over every field on NodeAny, so the source does not provide a finite value domain or a type relation between target, property, before, and after. The generic set-property builtin currently has no non-test construction site. Remove CommandPropertyEntry, SetNodePropertyCommand, SetNodePropertyCommandKind, createSetNodePropertyCommand, createSetNodePropertyCommandBatch, both initializeSetNodePropertyCommand functions, the set-property binding, and the dynamic readNodeProperty/writeNodeProperty helpers; unregister that default binding and update its tests. For each property edit that is actually needed, declare a command-kind-specific data interface whose target and before/after fields use the exact declared property types, capture those named members directly in its constructor, and write them directly in its matching binding. Compose heterogeneous batches from those typed commands with CompositeCommand; if one gesture needs coalescing, implement it inside the matching typed binding while retaining the original before and newest after values. Do not replace unknown with a guessed scalar or recursive value union and do not whitelist the open slots. The compiler will not infer a property-indexed union, choose a target-specific Any carrier, retain the dynamic assertions, insert a cast, or copy or materialize the value.`;
  }
  if (
    isFlightTypesSource(node, 'Notification.ts') &&
    node.questionToken !== undefined &&
    node.type?.kind === ts.SyntaxKind.UnknownKeyword
  ) {
    const isReadonly = node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ReadonlyKeyword) ?? false;
    if (subject === 'interface:NotificationRequest/property:data' && !isReadonly) {
      return `${subject} is caller-supplied public request state, not an unexamined provider token. The web-page and service-worker adapters forward the same value through WebNotificationOptions.data, HostNotificationDeliveryCapability exposes the request across every provider, and ScheduledNotification can retain and return that request. Non-web providers inspect request keys and reject data rather than supplying an independent carrier. Define one named closed NotificationData domain for the portable structured-clone subset, use it on NotificationRequest.data and WebNotificationOptions.data, and validate or normalize application values before request construction. Do not whitelist the open domain: the compiler will not infer the structured-clone subset, choose a target-specific Any carrier, insert a cast, or copy or materialize the payload.`;
    }
    if (subject === 'interface:WebNotificationOptions/property:data' && !isReadonly) {
      return `${subject} has one Flight producer: both web adapters copy NotificationRequest.data unchanged into the native options object, and the browser provider is the only consumer. It therefore has no independent open domain to preserve. Type it with the same named closed NotificationData domain as NotificationRequest.data so the internal facade carries the already-normalized request value to the browser. Do not whitelist the duplicate unknown boundary: the compiler will not infer the browser's structured-clone subset, choose a target-specific Any carrier, insert a cast, or copy or materialize the payload.`;
    }
    if (subject === 'interface:WebServiceWorkerNotificationInstance/property:data' && isReadonly) {
      return `${subject} declares browser-owned structured-clone data that no Flight production path reads. Active-list reconciliation reads only tag, close handling invokes close, and the public Notification resource exposes id, tag, and title without native data. Remove data from this injected provider facade until a real consumer exists. If one is added, normalize the browser value at ingress into the named closed NotificationData domain before returning or storing it. Do not whitelist an unused open member: the compiler will not infer the browser's structured-clone subset, choose a target-specific Any carrier, insert a cast, or copy or materialize the payload.`;
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
  return `${subject} is the private storage leg of HostAppLoopCapability's provider-issued cancellation token. Every scheduling path in startAppLoop assigns backend.requestFrame(tick) to frameHandle and immediately installs a cleanup closure that returns the currently scheduled token only to backend.cancelFrame on the same retained capability. Pause, frame-rate throttling, normal rescheduling, and initial scheduling all preserve that pairing; no application consumer inspects, coerces, serializes, exposes, or persists the token. createLoopState's initial null is never passed to cancelFrame because no cleanup closure exists until after the first requestFrame assignment. This paired identity transport is genuinely provider-opaque, so record a reviewed source-portability exception for this exact property while requestFrame remains its sole non-sentinel producer, cancelFrame remains its sole semantic consumer, and LoopState stays private. The exception does not justify the null as unknown assertion: initialize unknown directly with null or model the uninitialized state explicitly. If handles must cross portable storage, results, or providers, define one named closed AppLoopFrameHandle domain shared by HostAppLoopCapability, LoopState, and every provider. The compiler will not assume the web provider's numeric handle, choose a target-specific Any carrier, retain or insert a cast, copy or materialize the token, or change its identity.`;
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
  return `${subject} erases the computed EntityRuntimeKey cell to optional unknown only for the direct runtimeFactory() write into the existing node owner. That local asserted view discards the exact relation already declared by Node<Traits>[EntityRuntimeKey]: NodeRuntime<Traits> | undefined: Runtime extends NodeRuntime<Traits>, the selected NodeRuntimeFactory<Runtime> produces the written value, allocateEntity created this same owner, and getNodeRuntime reads the same slot. Replace the unknown view with a direct typed node[EntityRuntimeKey] = runtimeFactory() assignment or one named generic runtime-slot setter whose owner, value, and return types preserve that relation. If generic mapped-type or intersection inference rejects the direct write, repair that relation in semantic lowering rather than weakening the source carrier to unknown. A reviewed source-portability exception is not justified because no opaque provider payload crosses this boundary. The compiler will preserve the exact node owner, computed slot, and runtime subtype, but will not choose a target-specific Any carrier, retain or insert a cast, copy or materialize the node or runtime, or add side storage.`;
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
  return `${subject} preserves an optional unknown error for the Tray ${outcome} result; ${flow} The concrete Electron, Tauri, and wrapper catch paths construct an own error property even when JavaScript throws null or undefined. The optional spelling only permits a host-authored failure to omit a diagnostic: createTrayIcon checks that distinction with 'error' in result but immediately writes its public wrapper's error field with undefined for omission, while every other repository consumer either ignores error or reads result.error, so none observes own-property presence. Omission and an explicit undefined payload therefore do not form distinct public states. The payload crosses the public Tray result boundary unchanged. No consumer inspects it to recover a runtime domain, and it is neither a detection-only probe nor a normalized value: it is genuinely opaque. If portable consumers need machine-readable failure data, normalize every producer before result construction into one named closed TrayErrorPayload shared by capabilities, wrapper results, storage, and consumers; make error a required TrayErrorPayload | null on every failure arm and use null for no diagnostic. If arbitrary provider-thrown data is intentionally returned only as an unexamined host diagnostic, make error required unknown, use explicit undefined when no diagnostic exists, and record a reviewed source-portability exception for this exact property. The compiler can lower the current guarded presence test and exact value forwarding, but it will not infer Error, stringify the value, choose a target-specific Any carrier, insert a cast, collapse or invent an absence sentinel, or copy or materialize the payload.`;
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
    path.posix.basename(normalizePathPortable(node.getSourceFile().fileName)) !== 'LottieDocument.ts'
  ) {
    return undefined;
  }
  if (subject === 'interface:LottieDocument/property:chars') {
    return `${subject} exposes unknown elements for the Lottie character-data array, but parseLottieDocument only passes JSON through and the current importer never reads document.chars, so presence and omission have the same imported result. Remove chars from the portable LottieDocument projection while it is unsupported; raw JSON may still carry an extra key that the projection ignores. If character import is added, normalize the input into a named closed Lottie character payload with distinct shapes/precomposition arms before storing or consuming it. If the API intentionally promises access to raw character JSON, record a reviewed source-portability exception for this exact property and keep the erased payload outside portable runtime storage. The compiler will not reconstruct the schema from JSON or choose a target-specific Any carrier.`;
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
  const property = getNodeName(node.name);
  return `${subject} exposes ${textPayload.exposure} for the Lottie ${textPayload.domain}, but appendLottieText reads only LottieTextData.d.k[0].s and never reads ${property}, so presence and omission have the same imported result. Remove ${property} from the portable LottieTextData projection while it is unsupported; raw JSON may still carry an extra key that the projection ignores. If this animator feature is added, normalize it into its own named closed payload before portable storage or interpretation. If the API intentionally promises access to this raw animator JSON, record a reviewed source-portability exception for this exact property and keep the erased payload outside portable runtime storage. The compiler will not merge LottieTextData.a, .m, and .p into one opaque carrier or choose a target-specific Any carrier.`;
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
