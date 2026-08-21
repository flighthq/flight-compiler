import { compareTextCodeUnits } from '../../compiler-canonical-form/src/index.js';
import { isCompilerSourceFingerprint } from '../../compiler-provenance/src/index.js';
import type {
  AppliedSemanticPatches,
  IrBindingIdentity,
  IrBindingPattern,
  IrDeclaration,
  IrModule,
  PatchAuditRecord,
  PatchAuditSkippedRecord,
  SemanticPatch,
  SemanticPatchAnalysis,
  SemanticPatchAnalysisChange,
  SemanticPatchFailure,
  SemanticPatchFailureCode,
} from '../../compiler-types/src/index.js';

interface IndexedDeclaration {
  declaration: IrDeclaration;
  readonly moduleIndex: number;
  readonly patternBinding?: IrBindingIdentity | undefined;
}

interface SemanticDeclarationTarget {
  readonly exportName: string;
  readonly patternBinding?: IrBindingIdentity | undefined;
}

interface ExecutedSemanticPatchSet extends AppliedSemanticPatches {
  readonly changes: readonly SemanticPatchAnalysisChange[];
}

export function analyzeSemanticPatchSet(
  modules: readonly IrModule[],
  patches: readonly SemanticPatch[],
  backend: string,
): SemanticPatchAnalysis {
  const { audit, changes } = executeSemanticPatchSet(modules, patches, backend);
  return { audit, changes, schema: 'flight-compiler-patch-analysis/1' };
}

export function applySemanticPatchSet(
  modules: readonly IrModule[],
  patches: readonly SemanticPatch[],
  backend: string,
): AppliedSemanticPatches {
  const { audit, modules: output } = executeSemanticPatchSet(modules, patches, backend);
  return { audit, modules: output };
}

function executeSemanticPatchSet(
  modules: readonly IrModule[],
  patches: readonly SemanticPatch[],
  backend: string,
): ExecutedSemanticPatchSet {
  validatePatchBackend(backend);
  validatePatchDefinitions(patches);
  validateUniqueIds(patches);
  validateConflicts(patches);
  let output: readonly IrModule[] = structuredClone(modules);
  const active = patches.filter(
    (patch) => patch.scope.kind === 'neutral' || (patch.scope.kind === 'backend' && patch.scope.backend === backend),
  );
  const skipped: PatchAuditSkippedRecord[] = patches
    .filter((patch) => patch.scope.kind === 'backend' && patch.scope.backend !== backend)
    .sort(comparePatchPrecedence)
    .map((patch) => ({ ...createPatchAuditRecord(patch), skipReason: 'backend-mismatch' }));
  validateActiveRemovals(active);
  const applied: PatchAuditRecord[] = [];
  const changes: SemanticPatchAnalysisChange[] = [];
  const declarationIndex = new Map<string, IndexedDeclaration[]>();
  for (const [moduleIndex, module] of output.entries()) {
    for (const declaration of module.declarations) {
      for (const target of declarationSemanticTargets(declaration)) {
        const key = targetKey({
          exportName: target.exportName,
          packageName: declaration.origin.packageName,
          source: declaration.origin.source,
        });
        const indexed = declarationIndex.get(key) ?? [];
        indexed.push({
          declaration,
          moduleIndex,
          ...(target.patternBinding ? { patternBinding: target.patternBinding } : {}),
        });
        declarationIndex.set(key, indexed);
      }
    }
  }

  for (const patch of [...active].sort(comparePatchPrecedence)) {
    const matches = declarationIndex.get(targetKey(patch.target)) ?? [];
    if (matches.length === 0) {
      throw createSemanticPatchError(
        'unmatched-patch-target',
        [patch.id],
        targetSubject(patch.target),
        `Unmatched semantic patch ${patch.id}`,
      );
    }
    if (matches.length > 1)
      throw createSemanticPatchError(
        'ambiguous-patch-target',
        [patch.id],
        targetSubject(patch.target),
        `Ambiguous semantic patch ${patch.id}: matched ${String(matches.length)} declarations`,
      );
    const match = matches[0]!;
    const { declaration } = match;
    if (declaration.kind !== patch.expect.kind) {
      throw createSemanticPatchError(
        'patch-kind-mismatch',
        [patch.id],
        targetSubject(patch.target),
        `Semantic patch ${patch.id} expected ${patch.expect.kind}, received ${declaration.kind}`,
      );
    }
    if (declaration.origin.fingerprint !== patch.expect.fingerprint) {
      throw createSemanticPatchError(
        'stale-patch-fingerprint',
        [patch.id],
        targetSubject(patch.target),
        `Stale semantic patch ${patch.id}: expected ${patch.expect.fingerprint}, received ${declaration.origin.fingerprint}`,
      );
    }
    if (match.patternBinding) {
      throw createSemanticPatchError(
        'incompatible-patch-operation',
        [patch.id],
        targetSubject(patch.target),
        `Semantic patch ${patch.id} targets binding-pattern leaf ${match.patternBinding.name}; apply destructuring lowering before semantic patches`,
      );
    }

    const before = structuredClone(declaration);
    let updatedDeclaration: IrDeclaration | undefined;
    switch (patch.operation) {
      case 'remove':
        updatedDeclaration = undefined;
        break;
      case 'rename':
        updatedDeclaration = renameSemanticDeclaration(declaration, patch.name);
        break;
      case 'replaceBody':
        if (declaration.kind !== 'function') {
          throw createSemanticPatchError(
            'incompatible-patch-operation',
            [patch.id],
            targetSubject(patch.target),
            `Semantic patch ${patch.id} requires a function`,
          );
        }
        updatedDeclaration = { ...declaration, body: structuredClone([...patch.body]) };
        break;
      case 'replaceType':
        if (declaration.kind !== 'typeAlias') {
          throw createSemanticPatchError(
            'incompatible-patch-operation',
            [patch.id],
            targetSubject(patch.target),
            `Semantic patch ${patch.id} requires a type alias`,
          );
        }
        updatedDeclaration = { ...declaration, type: structuredClone(patch.type) };
        break;
    }
    const module = output[match.moduleIndex]!;
    const declarationPosition = module.declarations.indexOf(declaration);
    if (declarationPosition < 0) {
      throw createSemanticPatchError(
        'patch-index-desynchronized',
        [patch.id],
        targetSubject(patch.target),
        `Semantic patch index lost declaration ${patch.id}`,
      );
    }
    const declarations = updatedDeclaration
      ? module.declarations.map((item, index) => (index === declarationPosition ? updatedDeclaration : item))
      : module.declarations.filter((_item, index) => index !== declarationPosition);
    output = output.map((item, index) => (index === match.moduleIndex ? { ...module, declarations } : item));
    if (updatedDeclaration) match.declaration = updatedDeclaration;
    else declarationIndex.delete(targetKey(patch.target));
    const patchRecord = createPatchAuditRecord(patch);
    applied.push(patchRecord);
    changes.push({
      ...(updatedDeclaration ? { after: structuredClone(updatedDeclaration) } : {}),
      before,
      patch: structuredClone(patchRecord),
    });
  }

  return {
    audit: {
      applied,
      backend,
      schema: 'flight-compiler-patch-audit/2',
      skipped,
      summary: { applied: applied.length, skipped: skipped.length },
    },
    changes,
    modules: output,
  };
}

function createPatchAuditRecord(patch: Readonly<SemanticPatch>): PatchAuditRecord {
  return {
    fingerprint: patch.expect.fingerprint,
    id: patch.id,
    operation: patch.operation,
    reason: patch.reason,
    scope: structuredClone(patch.scope),
    target: structuredClone(patch.target),
  };
}

function declarationSemanticTargets(declaration: Readonly<IrDeclaration>): readonly SemanticDeclarationTarget[] {
  if (declaration.kind === 'variable' && 'pattern' in declaration) {
    return collectBindingPatternTargets(declaration.pattern);
  }
  return [{ exportName: declaration.binding.name }];
}

function collectBindingPatternTargets(pattern: Readonly<IrBindingPattern>): readonly SemanticDeclarationTarget[] {
  if (pattern.kind === 'binding') {
    return [{ exportName: pattern.binding.name, patternBinding: pattern.binding }];
  }
  if (pattern.kind === 'object') {
    return [
      ...pattern.properties.flatMap((property) => collectBindingPatternTargets(property.pattern)),
      ...(pattern.rest ? collectBindingPatternTargets(pattern.rest) : []),
    ];
  }
  return [
    ...pattern.elements.flatMap((element) => (element ? collectBindingPatternTargets(element.pattern) : [])),
    ...(pattern.rest ? collectBindingPatternTargets(pattern.rest) : []),
  ];
}

function renameSemanticDeclaration(declaration: Readonly<IrDeclaration>, name: string): IrDeclaration {
  switch (declaration.kind) {
    case 'class':
    case 'enum':
    case 'function':
      return { ...declaration, binding: { ...declaration.binding, name } };
    case 'variable':
      if ('pattern' in declaration)
        throw new TypeError('binding-pattern declarations cannot be renamed before destructuring lowering');
      return { ...declaration, binding: { ...declaration.binding, name } };
    case 'interface':
    case 'typeAlias':
      return { ...declaration, binding: { ...declaration.binding, name } };
  }
}

function comparePatchPrecedence(left: Readonly<SemanticPatch>, right: Readonly<SemanticPatch>): number {
  const leftRank = left.scope.kind === 'neutral' ? 0 : 1;
  const rightRank = right.scope.kind === 'neutral' ? 0 : 1;
  return leftRank - rightRank || compareTextCodeUnits(left.id, right.id);
}

function comparePatchIdentifiers(left: Readonly<SemanticPatch>, right: Readonly<SemanticPatch>): number {
  return compareTextCodeUnits(left.id, right.id);
}

export function defineSemanticPatchSet<const Patches extends readonly SemanticPatch[]>(patches: Patches): Patches {
  return patches;
}

export function isSemanticPatchFailure(value: unknown): value is SemanticPatchFailure {
  return (
    value instanceof Error &&
    'kind' in value &&
    value.kind === 'semantic-patch' &&
    'code' in value &&
    typeof value.code === 'string' &&
    Object.hasOwn(semanticPatchFailureCodes, value.code) &&
    'patchIds' in value &&
    Array.isArray(value.patchIds) &&
    value.patchIds.every((id) => typeof id === 'string') &&
    'subject' in value &&
    typeof value.subject === 'string'
  );
}

function createSemanticPatchError(
  code: SemanticPatchFailureCode,
  patchIds: readonly string[],
  subject: string,
  message: string,
): SemanticPatchFailure {
  const failure = Object.assign(new Error(message), {
    code,
    kind: 'semantic-patch' as const,
    patchIds: [...patchIds].sort(compareTextCodeUnits),
    subject,
  });
  failure.name = 'SemanticPatchError';
  return failure;
}

function targetKey(target: Readonly<SemanticPatch['target']>): string {
  return JSON.stringify([target.packageName, target.source, target.exportName]);
}

function targetSubject(target: Readonly<SemanticPatch['target']>): string {
  return `${target.packageName}/${target.source}#${target.exportName}`;
}

function validateActiveRemovals(patches: readonly SemanticPatch[]): void {
  const byTarget = new Map<string, SemanticPatch[]>();
  for (const patch of [...patches].sort(comparePatchIdentifiers)) {
    const key = targetKey(patch.target);
    const targetPatches = byTarget.get(key) ?? [];
    targetPatches.push(patch);
    byTarget.set(key, targetPatches);
  }
  for (const targetPatches of byTarget.values()) {
    if (targetPatches.length > 1 && targetPatches.some((patch) => patch.operation === 'remove')) {
      throw createSemanticPatchError(
        'conflicting-patch-removal',
        targetPatches.map((patch) => patch.id),
        targetSubject(targetPatches[0]!.target),
        `Remove patch conflicts with another active patch: ${targetPatches.map((patch) => patch.id).join(', ')}`,
      );
    }
  }
}

function validatePatchBackend(backend: string): void {
  if (!isNonBlankString(backend)) {
    throw createSemanticPatchError(
      'invalid-patch-backend',
      [],
      backend,
      'Semantic patch application requires a named backend',
    );
  }
}

function validatePatchDefinitions(patches: readonly SemanticPatch[]): void {
  patches.forEach((patch, index) => {
    const value: unknown = patch;
    const subject = `$[${String(index)}]`;
    if (!isRecord(value) || !isNonBlankString(value.id)) {
      throw createSemanticPatchError(
        'invalid-patch-id',
        [],
        subject,
        `Semantic patch ${subject} requires a nonempty id`,
      );
    }
    const patchIds = [value.id];
    if (!isNonBlankString(value.reason)) {
      throw createSemanticPatchError(
        'invalid-patch-reason',
        patchIds,
        value.id,
        `Semantic patch ${value.id} requires a nonempty reason`,
      );
    }
    if (
      !isRecord(value.target) ||
      !isNonBlankString(value.target.packageName) ||
      !isNonBlankString(value.target.source) ||
      !isNonBlankString(value.target.exportName)
    ) {
      throw createSemanticPatchError(
        'invalid-patch-target',
        patchIds,
        value.id,
        `Semantic patch ${value.id} requires a complete target identity`,
      );
    }
    const target = {
      exportName: value.target.exportName,
      packageName: value.target.packageName,
      source: value.target.source,
    } satisfies SemanticPatch['target'];
    if (
      !isRecord(value.expect) ||
      !semanticPatchDeclarationKinds.has(String(value.expect.kind)) ||
      !isCompilerSourceFingerprint(value.expect.fingerprint)
    ) {
      throw createSemanticPatchError(
        'invalid-patch-expectation',
        patchIds,
        targetSubject(target),
        `Semantic patch ${value.id} requires an exact fingerprint and declaration kind`,
      );
    }
    if (
      !isRecord(value.scope) ||
      (value.scope.kind !== 'neutral' && (value.scope.kind !== 'backend' || !isNonBlankString(value.scope.backend)))
    ) {
      throw createSemanticPatchError(
        'invalid-patch-scope',
        patchIds,
        targetSubject(target),
        `Semantic patch ${value.id} requires a neutral or named backend scope`,
      );
    }
    if (
      (value.operation !== 'remove' &&
        value.operation !== 'rename' &&
        value.operation !== 'replaceBody' &&
        value.operation !== 'replaceType') ||
      (value.operation === 'rename' && !isNonBlankString(value.name)) ||
      (value.operation === 'replaceBody' && !Array.isArray(value.body)) ||
      (value.operation === 'replaceType' && !isRecord(value.type))
    ) {
      throw createSemanticPatchError(
        'invalid-patch-operation',
        patchIds,
        targetSubject(target),
        `Semantic patch ${value.id} has an invalid operation payload`,
      );
    }
  });
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null;
}

function validateConflicts(patches: readonly SemanticPatch[]): void {
  const owners = new Map<string, string>();
  for (const patch of [...patches].sort(comparePatchIdentifiers)) {
    const scope = patch.scope.kind === 'neutral' ? 'neutral' : `backend:${patch.scope.backend}`;
    const key = JSON.stringify([
      scope,
      patch.target.packageName,
      patch.target.source,
      patch.target.exportName,
      patch.operation,
    ]);
    const owner = owners.get(key);
    if (owner) {
      throw createSemanticPatchError(
        'conflicting-patch-operation',
        [owner, patch.id],
        targetSubject(patch.target),
        `Conflicting semantic patches ${owner} and ${patch.id}`,
      );
    }
    owners.set(key, patch.id);
  }
}

function validateUniqueIds(patches: readonly SemanticPatch[]): void {
  const ids = new Set<string>();
  for (const patch of patches) {
    if (ids.has(patch.id)) {
      throw createSemanticPatchError(
        'duplicate-patch-id',
        [patch.id],
        patch.id,
        `Duplicate semantic patch id ${patch.id}`,
      );
    }
    ids.add(patch.id);
  }
}

const semanticPatchFailureCodes = {
  'ambiguous-patch-target': null,
  'conflicting-patch-operation': null,
  'conflicting-patch-removal': null,
  'duplicate-patch-id': null,
  'incompatible-patch-operation': null,
  'invalid-patch-backend': null,
  'invalid-patch-expectation': null,
  'invalid-patch-id': null,
  'invalid-patch-operation': null,
  'invalid-patch-reason': null,
  'invalid-patch-scope': null,
  'invalid-patch-target': null,
  'patch-index-desynchronized': null,
  'patch-kind-mismatch': null,
  'stale-patch-fingerprint': null,
  'unmatched-patch-target': null,
} as const satisfies Readonly<Record<SemanticPatchFailureCode, null>>;

const semanticPatchDeclarationKinds = new Set(['class', 'enum', 'function', 'interface', 'typeAlias', 'variable']);
