import { analyzeIrModuleTraversal } from '../../compiler-ir-traversal/src/index.js';
import type {
  CompilerClosureBindingUseEvidence,
  CompilerClosureBindingUseKind,
  CompilerClosureCaptureEvidence,
  CompilerClosureCaptureLifetimeBoundary,
  CompilerClosureCaptureMutation,
  CompilerClosureEvidence,
  CompilerClosureModuleEvidence,
  CompilerClosureOrigin,
  CompilerClosureValueUseEvidence,
  CompilerIrTraversalPath,
  IrBindingIdentity,
  IrExpression,
  IrModule,
  IrStatement,
  IrVariable,
} from '../../compiler-types/src/index.js';

interface ClosureBindingDraft {
  readonly binding: Readonly<IrBindingIdentity>;
  readonly declarationOrdinal: number;
  readonly ownerPath?: CompilerIrTraversalPath | undefined;
  readonly path: CompilerIrTraversalPath;
}

interface ClosureContextDraft<Value> {
  readonly ownerPath?: CompilerIrTraversalPath | undefined;
  readonly path: CompilerIrTraversalPath;
  readonly value: Readonly<Value>;
}

interface ClosureDraft {
  readonly async: boolean;
  readonly body: CompilerClosureEvidence['body'];
  creationOrdinal: number;
  readonly hostBindingId?: string | undefined;
  readonly origin: CompilerClosureOrigin;
  readonly parentPath?: CompilerIrTraversalPath | undefined;
  readonly path: CompilerIrTraversalPath;
  readonly selfBindingId?: string | undefined;
  readonly thisMode: CompilerClosureEvidence['thisMode'];
}

interface ClosureHostDraft {
  readonly bindingId: string;
}

interface ClosureRawUseDraft extends CompilerClosureBindingUseEvidence {
  readonly bindingId: string;
  readonly ordinal: number;
  readonly ownerPath?: CompilerIrTraversalPath | undefined;
}

interface ClosureSuspensionDraft {
  readonly ordinal: number;
  readonly ownerPath?: CompilerIrTraversalPath | undefined;
  readonly path: CompilerIrTraversalPath;
}

interface ClosureTraversalDraft {
  readonly bindings: Map<string, ClosureBindingDraft>;
  readonly closures: ClosureDraft[];
  readonly closurePaths: Map<string, ClosureDraft>;
  readonly exportedBindingIds: ReadonlySet<string>;
  readonly expressionHosts: WeakMap<Readonly<Extract<IrExpression, { kind: 'function' }>>, ClosureHostDraft>;
  readonly expressions: Array<ClosureContextDraft<IrExpression>>;
  readonly statements: Array<ClosureContextDraft<IrStatement>>;
  readonly suspensions: ClosureSuspensionDraft[];
  readonly thisUses: Array<
    Readonly<{ ownerPath?: CompilerIrTraversalPath | undefined; path: CompilerIrTraversalPath }>
  >;
  readonly uses: Map<string, ClosureRawUseDraft>;
  readonly variables: Array<ClosureContextDraft<IrVariable>>;
}

export function analyzeIrModuleClosureEvidence(module: Readonly<IrModule>): CompilerClosureModuleEvidence {
  const exportedBindingIds = new Set(
    module.exports.flatMap((entry) => (entry.kind === 'local' && !entry.typeOnly ? [entry.binding.id] : [])),
  );
  for (const declaration of module.declarations) {
    if ('exported' in declaration && declaration.exported && 'binding' in declaration) {
      exportedBindingIds.add(declaration.binding.id);
    }
  }
  const draft: ClosureTraversalDraft = {
    bindings: new Map(),
    closures: [],
    closurePaths: new Map(),
    exportedBindingIds,
    expressionHosts: new WeakMap(),
    expressions: [],
    statements: [],
    suspensions: [],
    thisUses: [],
    uses: new Map(),
    variables: [],
  };
  let declarationOrdinal = 0;
  module.imports.forEach((imported, importIndex) =>
    imported.bindings.forEach((entry, bindingIndex) => {
      if (!entry.typeOnly) {
        addCompilerClosureBindingDraft(
          entry.binding,
          ['imports', importIndex, 'bindings', bindingIndex],
          declarationOrdinal,
          draft,
        );
        declarationOrdinal += 1;
      }
    }),
  );
  analyzeIrModuleTraversal(module, {
    bindingPattern(pattern, path) {
      declarationOrdinal += 1;
      if (pattern.kind === 'binding') {
        addCompilerClosureBindingDraft(pattern.binding, path, declarationOrdinal, draft);
      }
    },
    declaration(declaration, path) {
      declarationOrdinal += 1;
      const parentPath = getCompilerClosureBoundaryPath(path, draft.closures);
      if (declaration.kind === 'function') {
        addCompilerClosureBindingDraft(declaration.binding, path, declarationOrdinal, draft, parentPath);
        addCompilerClosureDraft(
          {
            async: declaration.async,
            body: 'block',
            creationOrdinal: 0,
            hostBindingId: declaration.binding.id,
            origin: { binding: declaration.binding, kind: 'functionDeclaration' },
            parentPath,
            path,
            selfBindingId: declaration.binding.id,
            thisMode: 'dynamic',
          },
          draft,
        );
      }
      if (declaration.kind === 'class') {
        addCompilerClosureBindingDraft(declaration.binding, path, declarationOrdinal, draft, parentPath);
        if (declaration.classConstructor) {
          addCompilerClosureDraft(
            {
              async: false,
              body: 'block',
              creationOrdinal: 0,
              origin: { classBinding: declaration.binding, kind: 'classConstructor' },
              parentPath,
              path: [...path, 'classConstructor'],
              thisMode: 'dynamic',
            },
            draft,
          );
        }
        declaration.methods.forEach((method, index) =>
          addCompilerClosureDraft(
            {
              async: method.async,
              body: 'block',
              creationOrdinal: 0,
              origin: {
                classBinding: declaration.binding,
                kind: 'classMethod',
                method: method.name,
                static: method.static,
              },
              parentPath,
              path: [...path, 'methods', index],
              thisMode: 'dynamic',
            },
            draft,
          ),
        );
      }
      if (declaration.kind === 'enum') {
        addCompilerClosureBindingDraft(declaration.binding, path, declarationOrdinal, draft, parentPath);
      }
      if (declaration.kind === 'variable' && 'binding' in declaration && declaration.initializer?.kind === 'function') {
        draft.expressionHosts.set(declaration.initializer, { bindingId: declaration.binding.id });
      }
    },
    expression(expression, path) {
      declarationOrdinal += 1;
      if (expression.kind === 'function') {
        const parentPath = getCompilerClosureBoundaryPath(path, draft.closures);
        const host = draft.expressionHosts.get(expression);
        addCompilerClosureDraft(
          {
            async: expression.async,
            body: expression.expression ? 'expression' : 'block',
            creationOrdinal: 0,
            ...(host ? { hostBindingId: host.bindingId } : {}),
            origin: {
              ...(expression.binding ? { binding: expression.binding } : {}),
              kind: 'functionExpression',
            },
            parentPath,
            path,
            ...(expression.binding ? { selfBindingId: expression.binding.id } : {}),
            thisMode: expression.thisMode,
          },
          draft,
        );
        if (expression.binding) {
          addCompilerClosureBindingDraft(expression.binding, [...path, 'binding'], declarationOrdinal, draft, path);
        }
      }
    },
    parameter(parameter, path) {
      declarationOrdinal += 1;
      addCompilerClosureBindingDraft(parameter.binding, path, declarationOrdinal, draft);
    },
    statement(statement, path) {
      declarationOrdinal += 1;
      if (statement.kind === 'try' && statement.catchClause?.binding) {
        addCompilerClosureBindingDraft(
          statement.catchClause.binding,
          [...path, 'catchClause', 'binding'],
          declarationOrdinal,
          draft,
        );
      }
    },
    variable(variable, path) {
      declarationOrdinal += 1;
      if ('binding' in variable) {
        addCompilerClosureBindingDraft(variable.binding, path, declarationOrdinal, draft);
        if (variable.initializer?.kind === 'function') {
          draft.expressionHosts.set(variable.initializer, { bindingId: variable.binding.id });
        }
      }
    },
  });
  collectCompilerClosureRuntimeEvidence(module, draft);
  const evidence: CompilerClosureModuleEvidence = {
    closures: draft.closures.map((closure) => createCompilerClosureEvidence(closure, module, draft)),
    module: { name: module.name, packageName: module.packageName, source: module.source },
    schema: 'flight-compiler-closure-evidence/1',
  };
  return cloneCompilerClosureEvidenceValue(evidence);
}

function addCompilerClosureBindingDraft(
  binding: Readonly<IrBindingIdentity>,
  path: CompilerIrTraversalPath,
  declarationOrdinal: number,
  draft: ClosureTraversalDraft,
  ownerPath = getCompilerClosureBoundaryPath(path, draft.closures),
): void {
  if (draft.bindings.has(binding.id)) return;
  draft.bindings.set(binding.id, { binding, declarationOrdinal, ownerPath, path });
}

function addCompilerClosureDraft(closure: ClosureDraft, draft: ClosureTraversalDraft): void {
  draft.closures.push(closure);
  draft.closurePaths.set(JSON.stringify(closure.path), closure);
}

function addCompilerClosureRawUse(
  bindingId: string,
  kind: CompilerClosureBindingUseKind,
  path: CompilerIrTraversalPath,
  ordinal: number,
  draft: ClosureTraversalDraft,
): void {
  const key = JSON.stringify(path);
  const existing = draft.uses.get(key);
  if (!existing || getCompilerClosureBindingUsePriority(kind) > getCompilerClosureBindingUsePriority(existing.kind)) {
    draft.uses.set(key, {
      bindingId,
      kind,
      ordinal,
      ownerPath: getCompilerClosureBoundaryPath(path, draft.closures),
      path,
    });
  }
}

function addIrExpressionCompilerClosureMutation(
  expression: Readonly<IrExpression>,
  path: CompilerIrTraversalPath,
  ordinal: number,
  draft: ClosureTraversalDraft,
): void {
  if (expression.kind === 'assignment') {
    const target = getIrExpressionCompilerClosureMutationTarget(expression.left, [...path, 'left']);
    if (target) addCompilerClosureRawUse(target.bindingId, target.kind, target.path, ordinal, draft);
  }
  if (
    expression.kind === 'unary' &&
    (expression.operator === '++' || expression.operator === '--' || expression.operator === 'delete')
  ) {
    const target = getIrExpressionCompilerClosureMutationTarget(expression.operand, [...path, 'operand']);
    if (target) addCompilerClosureRawUse(target.bindingId, target.kind, target.path, ordinal, draft);
  }
}

function classifyCompilerClosureValueUses(
  path: CompilerIrTraversalPath,
  ownerPath: CompilerIrTraversalPath | undefined,
  directStorage: boolean,
  module: Readonly<IrModule>,
  draft: Readonly<ClosureTraversalDraft>,
): CompilerClosureValueUseEvidence[] {
  const uses: CompilerClosureValueUseEvidence[] = [];
  const add = (kind: CompilerClosureValueUseEvidence['kind'], usePath: CompilerIrTraversalPath = path): void => {
    uses.push({ kind, path: usePath });
  };
  if (
    module.exports.some(
      (entry, index) => entry.kind === 'default' && isCompilerClosurePathWithin(path, ['exports', index, 'expression']),
    )
  ) {
    add('exported');
  }
  for (const context of draft.statements) {
    if (!isCompilerClosureContextOwner(context.ownerPath, ownerPath)) continue;
    if (
      context.value.kind === 'return' &&
      context.value.expression &&
      isCompilerClosurePathWithin(path, [...context.path, 'expression'])
    ) {
      add('returned', context.path);
    }
    if (context.value.kind === 'expression' && isCompilerClosurePathEqual(path, [...context.path, 'expression'])) {
      add('discarded', context.path);
    }
  }
  for (const context of draft.expressions) {
    if (!isCompilerClosureContextOwner(context.ownerPath, ownerPath) || context.path.length >= path.length) continue;
    const expression = context.value;
    if (
      (expression.kind === 'call' || expression.kind === 'new') &&
      isCompilerClosurePathWithin(path, [...context.path, 'callee'])
    ) {
      add('directInvocation', context.path);
    }
    if (
      (expression.kind === 'call' || expression.kind === 'new') &&
      expression.arguments.some((_argument, index) =>
        isCompilerClosurePathWithin(path, [...context.path, 'arguments', index]),
      )
    ) {
      add('passedArgument', context.path);
    }
    if (expression.kind === 'assignment' && isCompilerClosurePathWithin(path, [...context.path, 'right'])) {
      add(expression.left.kind === 'element' || expression.left.kind === 'property' ? 'storedProperty' : 'unknown');
    }
    if (
      (expression.kind === 'array' || expression.kind === 'object') &&
      isCompilerClosurePathWithin(path, context.path)
    ) {
      add('storedAggregate', context.path);
    }
  }
  for (const context of draft.variables) {
    if (
      isCompilerClosureContextOwner(context.ownerPath, ownerPath) &&
      context.value.initializer &&
      isCompilerClosurePathEqual(path, [...context.path, 'initializer'])
    ) {
      add(directStorage ? 'storedBinding' : 'storedAlias', context.path);
    }
  }
  if (uses.length === 0) add('unknown');
  return uses;
}

function cloneCompilerClosureEvidenceValue<Value>(value: Value): Value {
  const clone = structuredClone(value);
  freezeCompilerClosureEvidenceValue(clone, new WeakSet());
  return clone;
}

function collectCompilerClosureRuntimeEvidence(module: Readonly<IrModule>, draft: ClosureTraversalDraft): void {
  let ordinal = 0;
  analyzeIrModuleTraversal(module, {
    declaration(declaration, path) {
      ordinal += 1;
      if (declaration.kind === 'function') setCompilerClosureCreationOrdinal(path, ordinal, draft);
      if (declaration.kind === 'class') {
        if (declaration.classConstructor) {
          setCompilerClosureCreationOrdinal([...path, 'classConstructor'], ordinal, draft);
        }
        declaration.methods.forEach((_method, index) =>
          setCompilerClosureCreationOrdinal([...path, 'methods', index], ordinal, draft),
        );
      }
    },
    expression(expression, path) {
      ordinal += 1;
      const ownerPath = getCompilerClosureBoundaryPath(path, draft.closures);
      draft.expressions.push({ ownerPath, path, value: expression });
      if (expression.kind === 'function') setCompilerClosureCreationOrdinal(path, ordinal, draft);
      if (expression.kind === 'await') draft.suspensions.push({ ordinal, ownerPath, path });
      if (expression.kind === 'identifier') {
        if (expression.reference.kind === 'binding') {
          addCompilerClosureRawUse(expression.reference.binding.id, 'read', path, ordinal, draft);
        }
        if (expression.reference.kind === 'this') draft.thisUses.push({ ownerPath, path });
      }
      addIrExpressionCompilerClosureMutation(expression, path, ordinal, draft);
    },
    statement(statement, path) {
      ordinal += 1;
      const ownerPath = getCompilerClosureBoundaryPath(path, draft.closures);
      draft.statements.push({ ownerPath, path, value: statement });
      if (statement.kind === 'forOf' && statement.await) draft.suspensions.push({ ordinal, ownerPath, path });
    },
    variable(variable, path) {
      ordinal += 1;
      draft.variables.push({ ownerPath: getCompilerClosureBoundaryPath(path, draft.closures), path, value: variable });
    },
  });
}

function createCompilerClosureCaptureEvidence(
  closure: Readonly<ClosureDraft>,
  binding: Readonly<ClosureBindingDraft>,
  uses: readonly ClosureRawUseDraft[],
  escape: CompilerClosureEvidence['escape'],
  draft: Readonly<ClosureTraversalDraft>,
): CompilerClosureCaptureEvidence {
  const lifetimeBoundaries = new Set<CompilerClosureCaptureLifetimeBoundary>();
  if (binding.binding.scope === 'module') lifetimeBoundaries.add('moduleLifetime');
  if (
    binding.binding.scope === 'block' &&
    hasCompilerClosureIterationLifetime(binding.path, closure.path, draft.statements)
  ) {
    lifetimeBoundaries.add('iteration');
  }
  if (escape === 'mayEscape' && binding.binding.scope !== 'module') lifetimeBoundaries.add('closureEscape');
  if (
    draft.suspensions.some(
      (suspension) =>
        isCompilerClosurePathEqual(suspension.ownerPath, closure.path) &&
        uses.some((use) => use.ordinal > suspension.ordinal),
    )
  ) {
    lifetimeBoundaries.add('suspension');
  }
  const mutations = uses.map((use) => use.kind);
  const outsideMutations = [...draft.uses.values()]
    .filter(
      (use) =>
        use.bindingId === binding.binding.id &&
        use.kind !== 'read' &&
        !isCompilerClosurePathEqual(use.ownerPath, closure.path),
    )
    .sort((left, right) => left.ordinal - right.ordinal)
    .map((use) => ({
      kind: use.kind,
      lexicalRelation: use.ordinal < closure.creationOrdinal ? ('beforeCreation' as const) : ('afterCreation' as const),
      path: use.path,
    }));
  return {
    binding: binding.binding,
    declarationPath: binding.path,
    lifetimeBoundaries: compilerClosureCaptureLifetimeBoundaryOrder.filter((boundary) =>
      lifetimeBoundaries.has(boundary),
    ),
    mutation: getCompilerClosureCaptureMutation(mutations),
    outsideMutations,
    uses: uses.map(({ kind, path }) => ({ kind, path })),
  };
}

function createCompilerClosureEvidence(
  closure: Readonly<ClosureDraft>,
  module: Readonly<IrModule>,
  draft: Readonly<ClosureTraversalDraft>,
): CompilerClosureEvidence {
  const selfReferences: CompilerIrTraversalPath[] = [];
  const captures = new Map<string, ClosureRawUseDraft[]>();
  for (const use of [...draft.uses.values()].sort((left, right) => left.ordinal - right.ordinal)) {
    if (!isCompilerClosurePathEqual(use.ownerPath, closure.path)) continue;
    if (closure.selfBindingId === use.bindingId) {
      selfReferences.push(use.path);
      continue;
    }
    const binding = draft.bindings.get(use.bindingId);
    if (!binding || isCompilerClosurePathEqual(binding.ownerPath, closure.path)) continue;
    const bindingUses = captures.get(use.bindingId) ?? [];
    bindingUses.push(use);
    captures.set(use.bindingId, bindingUses);
  }
  const valueUses = getCompilerClosureValueUses(closure, module, draft);
  const escape: CompilerClosureEvidence['escape'] = valueUses.some((use) =>
    compilerClosureEscapingValueUseKinds.has(use.kind),
  )
    ? 'mayEscape'
    : 'knownNonEscaping';
  return {
    async: closure.async,
    body: closure.body,
    captures: [...captures].flatMap(([bindingId, uses]) => {
      const binding = draft.bindings.get(bindingId) as ClosureBindingDraft;
      return [createCompilerClosureCaptureEvidence(closure, binding, uses, escape, draft)];
    }),
    escape,
    origin: closure.origin,
    path: closure.path,
    selfReferences,
    suspensions: draft.suspensions
      .filter((suspension) => isCompilerClosurePathEqual(suspension.ownerPath, closure.path))
      .map((suspension) => suspension.path),
    thisMode: closure.thisMode,
    thisUses: draft.thisUses
      .filter((use) => isCompilerClosurePathEqual(use.ownerPath, closure.path))
      .map((use) => use.path),
    valueUses,
  };
}

function freezeCompilerClosureEvidenceValue(value: unknown, seen: WeakSet<object>): void {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  for (const child of Object.values(value)) freezeCompilerClosureEvidenceValue(child, seen);
  Object.freeze(value);
}

function getCompilerClosureBindingUsePriority(kind: CompilerClosureBindingUseKind): number {
  return kind === 'read' ? 0 : kind === 'rebind' ? 1 : 2;
}

function getCompilerClosureBoundaryPath(
  path: CompilerIrTraversalPath,
  closures: readonly Readonly<ClosureDraft>[],
): CompilerIrTraversalPath | undefined {
  let nearest: CompilerIrTraversalPath | undefined;
  for (const closure of closures) {
    if (isCompilerClosurePathWithin(path, closure.path) && (!nearest || closure.path.length > nearest.length)) {
      nearest = closure.path;
    }
  }
  return nearest;
}

function getCompilerClosureCaptureMutation(
  kinds: readonly CompilerClosureBindingUseKind[],
): CompilerClosureCaptureMutation {
  const rebind = kinds.includes('rebind');
  const referent = kinds.includes('referentMutation');
  return rebind ? (referent ? 'bindingAndReferent' : 'bindingReassigned') : referent ? 'referentMutated' : 'none';
}

function getCompilerClosureValueUses(
  closure: Readonly<ClosureDraft>,
  module: Readonly<IrModule>,
  draft: Readonly<ClosureTraversalDraft>,
): CompilerClosureValueUseEvidence[] {
  const uses: CompilerClosureValueUseEvidence[] = [];
  if (closure.origin.kind === 'classConstructor' || closure.origin.kind === 'classMethod') {
    uses.push({ kind: 'classStorage', path: closure.path });
  } else if (closure.origin.kind === 'functionDeclaration') {
    uses.push({ kind: 'storedBinding', path: closure.path });
  } else {
    uses.push(
      ...classifyCompilerClosureValueUses(
        closure.path,
        closure.parentPath,
        closure.hostBindingId !== undefined,
        module,
        draft,
      ),
    );
  }
  if (closure.hostBindingId) {
    if (draft.exportedBindingIds.has(closure.hostBindingId)) uses.push({ kind: 'exported', path: closure.path });
    for (const use of draft.uses.values()) {
      if (use.bindingId === closure.hostBindingId && use.kind === 'read' && closure.selfBindingId !== use.bindingId) {
        uses.push(...classifyCompilerClosureValueUses(use.path, use.ownerPath, false, module, draft));
      }
    }
  }
  return uses.filter(
    (use, index) =>
      uses.findIndex(
        (candidate) => candidate.kind === use.kind && isCompilerClosurePathEqual(candidate.path, use.path),
      ) === index,
  );
}

function getIrExpressionCompilerClosureMutationTarget(
  expression: Readonly<IrExpression>,
  path: CompilerIrTraversalPath,
):
  | Readonly<{
      bindingId: string;
      kind: Extract<CompilerClosureBindingUseKind, 'rebind' | 'referentMutation'>;
      path: CompilerIrTraversalPath;
    }>
  | undefined {
  if (expression.kind === 'identifier' && expression.reference.kind === 'binding') {
    return { bindingId: expression.reference.binding.id, kind: 'rebind', path };
  }
  if (expression.kind === 'element' || expression.kind === 'property') {
    const target = getIrExpressionCompilerClosureMutationTarget(expression.object, [...path, 'object']);
    return target ? { ...target, kind: 'referentMutation' } : undefined;
  }
  return undefined;
}

function isCompilerClosureContextOwner(
  left: CompilerIrTraversalPath | undefined,
  right: CompilerIrTraversalPath | undefined,
): boolean {
  return isCompilerClosurePathEqual(left, right);
}

function hasCompilerClosureIterationLifetime(
  bindingPath: CompilerIrTraversalPath,
  closurePath: CompilerIrTraversalPath,
  statements: readonly ClosureContextDraft<IrStatement>[],
): boolean {
  return statements.some((context) => {
    if (
      'body' in context.value &&
      isCompilerClosurePathWithin(bindingPath, [...context.path, 'body']) &&
      isCompilerClosurePathWithin(closurePath, [...context.path, 'body'])
    ) {
      return true;
    }
    if (context.value.kind === 'for') {
      return (
        isCompilerClosurePathWithin(bindingPath, [...context.path, 'initializer']) &&
        isCompilerClosurePathWithin(closurePath, [...context.path, 'body'])
      );
    }
    if (context.value.kind === 'forIn' || context.value.kind === 'forOf') {
      return (
        isCompilerClosurePathWithin(bindingPath, [...context.path, 'variable']) &&
        isCompilerClosurePathWithin(closurePath, [...context.path, 'body'])
      );
    }
    return false;
  });
}

function isCompilerClosurePathEqual(
  left: CompilerIrTraversalPath | undefined,
  right: CompilerIrTraversalPath | undefined,
): boolean {
  if (!left || !right) return left === right;
  return left.length === right.length && left.every((segment, index) => segment === right[index]);
}

function isCompilerClosurePathWithin(path: CompilerIrTraversalPath, ancestor: CompilerIrTraversalPath): boolean {
  return ancestor.length <= path.length && ancestor.every((segment, index) => segment === path[index]);
}

function setCompilerClosureCreationOrdinal(
  path: CompilerIrTraversalPath,
  ordinal: number,
  draft: ClosureTraversalDraft,
): void {
  const closure = draft.closurePaths.get(JSON.stringify(path));
  (closure as ClosureDraft).creationOrdinal = ordinal;
}

const compilerClosureCaptureLifetimeBoundaryOrder: readonly CompilerClosureCaptureLifetimeBoundary[] = [
  'moduleLifetime',
  'iteration',
  'closureEscape',
  'suspension',
];

const compilerClosureEscapingValueUseKinds = new Set<CompilerClosureValueUseEvidence['kind']>([
  'classStorage',
  'exported',
  'passedArgument',
  'returned',
  'storedAggregate',
  'storedAlias',
  'storedProperty',
  'unknown',
]);
