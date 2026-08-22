import { analyzeIrModuleClosureEvidence } from '../../compiler-closure/src/index.js';
import { analyzeIrModuleTraversal } from '../../compiler-ir-traversal/src/index.js';
import type {
  CompilerIrTraversalPath,
  CompilerRustOwnershipBindingEvidence,
  CompilerRustOwnershipBoundary,
  CompilerRustOwnershipEvidence,
  CompilerRustOwnershipUseEvidence,
  IrBindingIdentity,
  IrBindingPattern,
  IrExpression,
  IrModule,
  IrType,
} from '../../compiler-types/src/index.js';

interface RustOwnershipBindingDraft {
  readonly binding: Readonly<IrBindingIdentity>;
  readonly declaration: CompilerRustOwnershipBindingEvidence['declaration'];
  readonly declarationOrdinal: number;
  readonly type: Readonly<IrType>;
  readonly uses: Map<string, RustOwnershipUseDraft>;
}

interface RustOwnershipFunctionBoundary {
  readonly async: boolean;
  readonly path: CompilerIrTraversalPath;
}

interface RustOwnershipPatternBindingPlan {
  readonly declaration: CompilerRustOwnershipBindingEvidence['declaration'];
  readonly type: Readonly<IrType>;
}

interface RustOwnershipSuspensionDraft {
  readonly ordinal: number;
  readonly path: CompilerIrTraversalPath;
}

interface RustOwnershipUseDraft extends CompilerRustOwnershipUseEvidence {
  readonly ordinal: number;
}

export function analyzeIrModuleOwnershipEvidenceRust(module: Readonly<IrModule>): CompilerRustOwnershipEvidence {
  const closureCaptureBindingIds = new Set(
    analyzeIrModuleClosureEvidence(module).closures.flatMap((closure) =>
      closure.captures.map((capture) => capture.binding.id),
    ),
  );
  const bindings = new Map<string, RustOwnershipBindingDraft>();
  const carriers: CompilerIrTraversalPath[] = [];
  const functions: RustOwnershipFunctionBoundary[] = [];
  const patternBindings = new WeakMap<Readonly<IrBindingPattern>, RustOwnershipPatternBindingPlan>();
  const records: CompilerIrTraversalPath[] = [];
  const suspensions: RustOwnershipSuspensionDraft[] = [];
  let ordinal = 0;
  analyzeIrModuleTraversal(module, {
    bindingPattern(pattern, path) {
      ordinal += 1;
      if (pattern.kind === 'binding') {
        const plan = patternBindings.get(pattern) as RustOwnershipPatternBindingPlan;
        addRustOwnershipBindingDraft(
          pattern.binding,
          plan.declaration,
          pattern.type ?? plan.type,
          path,
          ordinal,
          bindings,
        );
      }
    },
    declaration(declaration, path) {
      ordinal += 1;
      if (declaration.kind === 'function') functions.push({ async: declaration.async, path });
      if (declaration.kind === 'class') {
        if (declaration.classConstructor) functions.push({ async: false, path: [...path, 'classConstructor'] });
        declaration.methods.forEach((method, index) =>
          functions.push({ async: method.async, path: [...path, 'methods', index] }),
        );
      }
    },
    expression(expression, path) {
      ordinal += 1;
      if (expression.kind === 'function') functions.push({ async: expression.async, path });
      if (expression.kind === 'object') records.push(path);
      if (expression.kind === 'await') suspensions.push({ ordinal, path });
      if (expression.kind === 'call' && expression.semantics.statementValue) carriers.push(path);
      addIrExpressionRustOwnershipMutation(expression, path, ordinal, bindings);
      if (expression.kind === 'identifier' && expression.reference.kind === 'binding') {
        addRustOwnershipUseDraft(expression.reference.binding.id, 'read', path, ordinal, bindings);
      }
    },
    parameter(parameter, path) {
      ordinal += 1;
      addRustOwnershipBindingDraft(parameter.binding, 'parameter', parameter.type, path, ordinal, bindings);
    },
    statement(statement, path) {
      ordinal += 1;
      if (statement.kind === 'forOf' && statement.await) suspensions.push({ ordinal, path });
    },
    variable(variable, path) {
      ordinal += 1;
      if ('binding' in variable) {
        addRustOwnershipBindingDraft(
          variable.binding,
          variable.mutable ? 'mutable' : 'immutable',
          variable.type ?? compilerUnknownRustOwnershipType,
          path,
          ordinal,
          bindings,
        );
      } else {
        addIrBindingPatternRustOwnershipPlan(
          variable.pattern,
          variable.mutable ? 'mutable' : 'immutable',
          variable.type ?? compilerUnknownRustOwnershipType,
          patternBindings,
        );
      }
    },
  });
  const evidence: CompilerRustOwnershipEvidence = {
    bindings: [...bindings.values()].map((binding) =>
      createCompilerRustOwnershipBindingEvidence(
        binding,
        closureCaptureBindingIds,
        functions,
        records,
        carriers,
        suspensions,
      ),
    ),
    module: { name: module.name, packageName: module.packageName, source: module.source },
    schema: 'flight-compiler-rust-ownership-evidence/1',
  };
  return cloneCompilerRustOwnershipValue(evidence);
}

function addIrBindingPatternRustOwnershipPlan(
  pattern: Readonly<IrBindingPattern>,
  declaration: CompilerRustOwnershipBindingEvidence['declaration'],
  type: Readonly<IrType>,
  plans: WeakMap<Readonly<IrBindingPattern>, RustOwnershipPatternBindingPlan>,
): void {
  if (pattern.kind === 'binding') {
    plans.set(pattern, { declaration, type });
    return;
  }
  if (pattern.kind === 'array') {
    for (const element of pattern.elements) {
      if (element) addIrBindingPatternRustOwnershipPlan(element.pattern, declaration, type, plans);
    }
  } else {
    for (const property of pattern.properties) {
      addIrBindingPatternRustOwnershipPlan(property.pattern, declaration, type, plans);
    }
  }
  if (pattern.rest) addIrBindingPatternRustOwnershipPlan(pattern.rest, declaration, type, plans);
}

function addIrExpressionRustOwnershipMutation(
  expression: Readonly<IrExpression>,
  path: CompilerIrTraversalPath,
  ordinal: number,
  bindings: ReadonlyMap<string, RustOwnershipBindingDraft>,
): void {
  if (expression.kind === 'assignment') {
    addIrExpressionRustOwnershipMutationTarget(expression.left, [...path, 'left'], ordinal, bindings);
  }
  if (expression.kind === 'unary' && (expression.operator === '++' || expression.operator === '--')) {
    addIrExpressionRustOwnershipMutationTarget(expression.operand, [...path, 'operand'], ordinal, bindings);
  }
}

function addIrExpressionRustOwnershipMutationTarget(
  expression: Readonly<IrExpression>,
  path: CompilerIrTraversalPath,
  ordinal: number,
  bindings: ReadonlyMap<string, RustOwnershipBindingDraft>,
): void {
  if (expression.kind === 'identifier' && expression.reference.kind === 'binding') {
    addRustOwnershipUseDraft(expression.reference.binding.id, 'rebind', path, ordinal, bindings);
  }
  if (
    (expression.kind === 'element' || expression.kind === 'property') &&
    expression.object.kind === 'identifier' &&
    expression.object.reference.kind === 'binding'
  ) {
    addRustOwnershipUseDraft(
      expression.object.reference.binding.id,
      'referentMutation',
      [...path, 'object'],
      ordinal,
      bindings,
    );
  }
}

function addRustOwnershipBindingDraft(
  binding: Readonly<IrBindingIdentity>,
  declaration: CompilerRustOwnershipBindingEvidence['declaration'],
  type: Readonly<IrType>,
  path: CompilerIrTraversalPath,
  ordinal: number,
  bindings: Map<string, RustOwnershipBindingDraft>,
): void {
  if (bindings.has(binding.id)) return;
  bindings.set(binding.id, {
    binding,
    declaration,
    declarationOrdinal: ordinal,
    type,
    uses: new Map(),
  });
}

function addRustOwnershipUseDraft(
  bindingId: string,
  kind: CompilerRustOwnershipUseEvidence['kind'],
  path: CompilerIrTraversalPath,
  ordinal: number,
  bindings: ReadonlyMap<string, RustOwnershipBindingDraft>,
): void {
  const binding = bindings.get(bindingId);
  if (!binding) return;
  const key = JSON.stringify(path);
  const existing = binding.uses.get(key);
  if (!existing || getRustOwnershipUsePriority(kind) > getRustOwnershipUsePriority(existing.kind)) {
    binding.uses.set(key, { kind, ordinal, path });
  }
}

function cloneCompilerRustOwnershipValue<Value>(value: Value): Value {
  const clone = structuredClone(value);
  freezeCompilerRustOwnershipValue(clone, new WeakSet());
  return clone;
}

function createCompilerRustOwnershipBindingEvidence(
  binding: Readonly<RustOwnershipBindingDraft>,
  closureCaptureBindingIds: ReadonlySet<string>,
  functions: readonly RustOwnershipFunctionBoundary[],
  records: readonly CompilerIrTraversalPath[],
  carriers: readonly CompilerIrTraversalPath[],
  suspensions: readonly RustOwnershipSuspensionDraft[],
): CompilerRustOwnershipBindingEvidence {
  const uses = [...binding.uses.values()].sort((left, right) => left.ordinal - right.ordinal);
  const boundaries = new Set<CompilerRustOwnershipBoundary>();
  if (closureCaptureBindingIds.has(binding.binding.id)) boundaries.add('closureCapture');
  if (uses.some((use) => records.some((record) => isRustOwnershipPathWithin(use.path, record)))) {
    boundaries.add('structuralRecord');
  }
  if (uses.some((use) => carriers.some((carrier) => isRustOwnershipPathWithin(use.path, carrier)))) {
    boundaries.add('statementValueCarrier');
  }
  if (
    suspensions.some((suspension) => {
      const boundary = getRustOwnershipFunctionBoundary(suspension.path, functions);
      return (
        boundary?.async &&
        binding.declarationOrdinal < suspension.ordinal &&
        uses.some((use) => use.ordinal > suspension.ordinal && isRustOwnershipPathWithin(use.path, boundary.path))
      );
    })
  ) {
    boundaries.add('suspension');
  }
  const rebind = uses.some((use) => use.kind === 'rebind');
  const referent = uses.some((use) => use.kind === 'referentMutation');
  return {
    binding: binding.binding,
    boundaries: compilerRustOwnershipBoundaryOrder.filter((boundary) => boundaries.has(boundary)),
    declaration: binding.declaration,
    mutation: rebind ? (referent ? 'bindingAndReferent' : 'bindingReassigned') : referent ? 'referentMutated' : 'none',
    reuse: uses.length === 0 ? 'unused' : uses.length === 1 ? 'single' : 'multiple',
    storage: getIrTypeRustOwnershipStorage(binding.type),
    type: binding.type,
    uses: uses.map(({ kind, path }) => ({ kind, path })),
  };
}

function freezeCompilerRustOwnershipValue(value: unknown, seen: WeakSet<object>): void {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  for (const child of Object.values(value)) freezeCompilerRustOwnershipValue(child, seen);
  Object.freeze(value);
}

function getIrTypeRustOwnershipStorage(type: Readonly<IrType>): CompilerRustOwnershipBindingEvidence['storage'] {
  switch (type.kind) {
    case 'literal':
    case 'never':
    case 'null':
    case 'primitive':
    case 'undefined':
      return 'valueSemantic';
    case 'array':
    case 'function':
    case 'object':
    case 'tuple':
      return 'sharedIdentity';
    case 'indexedAccess':
    case 'intersection':
    case 'keyof':
    case 'named':
    case 'typeOf':
    case 'union':
    case 'unknown':
      return 'indeterminate';
  }
}

function getRustOwnershipFunctionBoundary(
  path: CompilerIrTraversalPath,
  functions: readonly RustOwnershipFunctionBoundary[],
): RustOwnershipFunctionBoundary | undefined {
  let nearest: RustOwnershipFunctionBoundary | undefined;
  for (const candidate of functions) {
    if (isRustOwnershipPathWithin(path, candidate.path)) nearest = candidate;
  }
  return nearest;
}

function getRustOwnershipUsePriority(kind: CompilerRustOwnershipUseEvidence['kind']): number {
  return kind === 'read' ? 0 : kind === 'rebind' ? 1 : 2;
}

function isRustOwnershipPathWithin(path: CompilerIrTraversalPath, ancestor: CompilerIrTraversalPath): boolean {
  return ancestor.length <= path.length && ancestor.every((segment, index) => segment === path[index]);
}

const compilerRustOwnershipBoundaryOrder: readonly CompilerRustOwnershipBoundary[] = [
  'closureCapture',
  'statementValueCarrier',
  'structuralRecord',
  'suspension',
];

const compilerUnknownRustOwnershipType: IrType = Object.freeze({ kind: 'unknown', source: 'unknown' });
