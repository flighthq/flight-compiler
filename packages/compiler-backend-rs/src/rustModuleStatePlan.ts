import path from 'node:path';

import { compareTextCodeUnits, normalizePathPortable } from '../../compiler-canonical-form/src/index.js';
import { analyzeIrModuleTraversal } from '../../compiler-ir-traversal/src/index.js';
import type {
  CompilerIrTraversalPath,
  CompilerModuleIdentity,
  CompilerModuleResolutionEdge,
  CompilerModuleResolutionPlan,
  CompilerRustModuleStateBindingPlan,
  CompilerRustModuleStateModulePlan,
  CompilerRustModuleStatePlan,
  CompilerRustModuleStatePlanInput,
  IrBindingIdentity,
  IrExpression,
  IrModule,
  IrVariableDeclaration,
} from '../../compiler-types/src/index.js';

type RustNamedModuleVariable = Readonly<IrVariableDeclaration> & Readonly<{ binding: Readonly<IrBindingIdentity> }>;

interface RustModuleStateUseInventory {
  readonly assignments: readonly Readonly<{
    expression: Readonly<Extract<IrExpression, { kind: 'assignment' }>>;
    path: CompilerIrTraversalPath;
  }>[];
  readonly functionExpressions: readonly CompilerIrTraversalPath[];
  readonly references: readonly CompilerIrTraversalPath[];
  readonly updates: readonly Readonly<{
    expression: Readonly<Extract<IrExpression, { kind: 'unary' }>>;
    path: CompilerIrTraversalPath;
  }>[];
}

/**
 * Plans the one module-state shape whose initialization is observationally constant and whose accesses
 * never expose a Rust lock guard. Absence from the plan is intentional: declaration emission retains the
 * existing synchronization refusal for every wider shape, including a near miss in the same module.
 */
export function createCompilerRustModuleStatePlan(
  input: Readonly<CompilerRustModuleStatePlanInput>,
): CompilerRustModuleStatePlan {
  if (!input || typeof input !== 'object' || !Array.isArray(input.modules)) {
    throw new TypeError('Rust module-state planning requires a module array');
  }
  if (input.moduleResolution && input.moduleResolution.schema !== 'flight-compiler-module-resolution/1') {
    throw new TypeError('Rust module-state planning requires flight-compiler-module-resolution/1');
  }
  const modules = [...input.modules]
    .sort((left, right) => compareTextCodeUnits(getRustModuleStateModuleKey(left), getRustModuleStateModuleKey(right)))
    .map(
      (module): CompilerRustModuleStateModulePlan => ({
        bindings: createRustModuleStateBindingPlans(module, input.modules, input.moduleResolution),
        module: cloneRustModuleStateIdentity(module),
      }),
    );
  return cloneAndFreezeRustModuleStatePlan({ modules, schema: 'flight-rust-module-state-plan/1' });
}

function createRustModuleStateBindingPlans(
  module: Readonly<IrModule>,
  modules: readonly Readonly<IrModule>[],
  moduleResolution: Readonly<CompilerModuleResolutionPlan> | undefined,
): readonly CompilerRustModuleStateBindingPlan[] {
  const mutableModuleVariables = module.declarations.filter(
    (declaration): declaration is RustNamedModuleVariable =>
      declaration.kind === 'variable' && declaration.mutable && 'binding' in declaration,
  );
  if (mutableModuleVariables.length !== 1) return [];
  const declaration = mutableModuleVariables[0]!;
  const scalar = getRustModuleStateLiteralScalar(declaration);
  if (declaration.exported || !scalar || isRustModuleStateBindingExported(module, declaration.binding.id)) return [];
  if (!hasOnlyEvaluationTrivialRustModuleDeclarations(module, declaration)) return [];
  if (hasIncidentRustModuleRuntimeDependency(module, modules, moduleResolution)) return [];
  const update = getRustModuleStateUpdateCapability(module, declaration.binding.id, scalar.scalar);
  if (!update) return [];
  return [
    {
      bindingId: declaration.binding.id,
      declarationPath: ['declarations', module.declarations.indexOf(declaration)],
      initializer: scalar.initializer,
      scalar: scalar.scalar,
      update,
    },
  ];
}

function getRustModuleStateLiteralScalar(
  declaration: RustNamedModuleVariable,
): Readonly<{ initializer: boolean | number; scalar: 'boolean' | 'number' }> | undefined {
  if (
    declaration.declarationKind !== 'let' ||
    declaration.type?.kind !== 'primitive' ||
    (declaration.type.name !== 'boolean' && declaration.type.name !== 'number') ||
    declaration.initializer?.kind !== 'literal'
  ) {
    return undefined;
  }
  const value = declaration.initializer.value;
  if (declaration.type.name === 'boolean' && typeof value === 'boolean') {
    return { initializer: value, scalar: 'boolean' };
  }
  if (declaration.type.name === 'number' && typeof value === 'number') {
    return { initializer: value, scalar: 'number' };
  }
  return undefined;
}

function isRustModuleStateBindingExported(module: Readonly<IrModule>, bindingId: string): boolean {
  return module.exports.some((exported) => exported.kind === 'local' && exported.binding.id === bindingId);
}

function hasOnlyEvaluationTrivialRustModuleDeclarations(
  module: Readonly<IrModule>,
  state: RustNamedModuleVariable,
): boolean {
  if (module.exports.some((exported) => exported.kind === 'default')) return false;
  return module.declarations.every((declaration) => {
    if (declaration === state) return true;
    if (declaration.kind === 'function' || declaration.kind === 'interface' || declaration.kind === 'typeAlias') {
      return true;
    }
    return declaration.kind === 'variable' && isRustEvaluationTrivialConstDeclaration(declaration);
  });
}

function isRustEvaluationTrivialConstDeclaration(declaration: Readonly<IrVariableDeclaration>): boolean {
  if (
    'pattern' in declaration ||
    declaration.declarationKind !== 'const' ||
    declaration.mutable ||
    declaration.type?.kind !== 'primitive' ||
    (declaration.type.name !== 'boolean' && declaration.type.name !== 'number') ||
    declaration.initializer?.kind !== 'literal'
  ) {
    return false;
  }
  return typeof declaration.initializer.value === declaration.type.name;
}

function hasIncidentRustModuleRuntimeDependency(
  candidate: Readonly<IrModule>,
  modules: readonly Readonly<IrModule>[],
  moduleResolution: Readonly<CompilerModuleResolutionPlan> | undefined,
): boolean {
  if (getRustModuleStateRuntimeSpecifiers(candidate).size > 0) return true;
  for (const importer of modules) {
    const runtimeSpecifiers = getRustModuleStateRuntimeSpecifiers(importer);
    for (const specifier of runtimeSpecifiers) {
      const routes = (moduleResolution?.edges ?? []).filter(
        (edge) =>
          edge.specifier === specifier &&
          (edge.importer === undefined || isRustModuleStateIdentityEqual(edge.importer, importer)) &&
          isRustModuleStateRuntimeRoute(importer, edge),
      );
      if (routes.some((route) => isRustModuleStateSourceEqual(route.target, candidate))) return true;
      if (
        routes.length === 0 &&
        specifier.startsWith('.') &&
        resolveRelativeRustModuleStateTarget(importer, specifier, modules) === candidate
      ) {
        return true;
      }
    }
  }
  return false;
}

function getRustModuleStateRuntimeSpecifiers(module: Readonly<IrModule>): ReadonlySet<string> {
  const result = new Set<string>();
  for (const imported of module.imports) {
    if (!imported.typeOnly) result.add(imported.specifier);
  }
  for (const exported of module.exports) {
    if ('specifier' in exported && !exported.typeOnly) result.add(exported.specifier);
  }
  return result;
}

function isRustModuleStateRuntimeRoute(
  importer: Readonly<IrModule>,
  edge: Readonly<CompilerModuleResolutionEdge>,
): boolean {
  if (edge.importedNames === undefined) return getRustModuleStateRuntimeSpecifiers(importer).has(edge.specifier);
  const importedNames = new Set(edge.importedNames);
  return (
    importer.imports.some(
      (imported) =>
        imported.specifier === edge.specifier &&
        !imported.typeOnly &&
        imported.bindings.some((binding) => !binding.typeOnly && importedNames.has(binding.imported)),
    ) ||
    importer.exports.some(
      (exported) =>
        'specifier' in exported &&
        exported.specifier === edge.specifier &&
        !exported.typeOnly &&
        (exported.kind !== 'reexport' || importedNames.has(exported.imported)),
    )
  );
}

function resolveRelativeRustModuleStateTarget(
  importer: Readonly<IrModule>,
  specifier: string,
  modules: readonly Readonly<IrModule>[],
): Readonly<IrModule> | undefined {
  const source = path.posix.normalize(
    path.posix.join(path.posix.dirname(importer.source), specifier.replace(/\.[cm]?js$/u, '.ts')),
  );
  const candidates = new Set([source, `${source}.ts`, `${source}/index.ts`]);
  return modules.find(
    (module) => module.packageName === importer.packageName && candidates.has(path.posix.normalize(module.source)),
  );
}

function getRustModuleStateUpdateCapability(
  module: Readonly<IrModule>,
  bindingId: string,
  scalar: 'boolean' | 'number',
): 'none' | 'number-increment-decrement' | undefined {
  const inventory = collectRustModuleStateUseInventory(module, bindingId);
  let hasNumberUpdate = false;
  for (const referencePath of inventory.references) {
    if (referencePath[0] !== 'declarations' || typeof referencePath[1] !== 'number') return undefined;
    const declaration = module.declarations[referencePath[1]];
    if (declaration?.kind !== 'function' || declaration.async || referencePath[2] !== 'body') return undefined;
    if (
      inventory.functionExpressions.some((functionPath) => isRustModuleStatePathPrefix(functionPath, referencePath))
    ) {
      return undefined;
    }
    const assignment = inventory.assignments.find(({ path: assignmentPath }) =>
      isRustModuleStatePathPrefix([...assignmentPath, 'left'], referencePath),
    );
    if (assignment) {
      if (
        assignment.expression.operator !== '=' ||
        referencePath.length !== assignment.path.length + 1 ||
        referencePath.at(-1) !== 'left'
      ) {
        return undefined;
      }
      continue;
    }
    const update = inventory.updates.find(({ path: updatePath }) =>
      isRustModuleStatePathPrefix([...updatePath, 'operand'], referencePath),
    );
    if (!update) continue;
    if (
      scalar !== 'number' ||
      update.expression.semantics.operand.flow !== 'number' ||
      update.expression.semantics.result !== 'number' ||
      referencePath.length !== update.path.length + 1 ||
      referencePath.at(-1) !== 'operand'
    ) {
      return undefined;
    }
    hasNumberUpdate = true;
  }
  return hasNumberUpdate ? 'number-increment-decrement' : 'none';
}

function collectRustModuleStateUseInventory(
  module: Readonly<IrModule>,
  bindingId: string,
): RustModuleStateUseInventory {
  const assignments: Array<{
    expression: Readonly<Extract<IrExpression, { kind: 'assignment' }>>;
    path: CompilerIrTraversalPath;
  }> = [];
  const functionExpressions: CompilerIrTraversalPath[] = [];
  const references: CompilerIrTraversalPath[] = [];
  const updates: Array<{
    expression: Readonly<Extract<IrExpression, { kind: 'unary' }>>;
    path: CompilerIrTraversalPath;
  }> = [];
  analyzeIrModuleTraversal(module, {
    expression(expression, traversalPath) {
      if (expression.kind === 'assignment') assignments.push({ expression, path: traversalPath });
      if (expression.kind === 'function') functionExpressions.push(traversalPath);
      if (expression.kind === 'unary' && (expression.operator === '++' || expression.operator === '--')) {
        updates.push({ expression, path: traversalPath });
      }
      if (
        expression.kind === 'identifier' &&
        expression.reference.kind === 'binding' &&
        expression.reference.binding.id === bindingId
      ) {
        references.push(traversalPath);
      }
    },
  });
  return { assignments, functionExpressions, references, updates };
}

function isRustModuleStatePathPrefix(prefix: CompilerIrTraversalPath, path_: CompilerIrTraversalPath): boolean {
  return prefix.length <= path_.length && prefix.every((part, index) => path_[index] === part);
}

function isRustModuleStateIdentityEqual(
  left: Readonly<CompilerModuleIdentity>,
  right: Readonly<CompilerModuleIdentity>,
): boolean {
  return (
    left.name === right.name &&
    left.packageName === right.packageName &&
    normalizePathPortable(left.source) === normalizePathPortable(right.source)
  );
}

function isRustModuleStateSourceEqual(
  left: Readonly<{ packageName: string; source: string }>,
  right: Readonly<{ packageName: string; source: string }>,
): boolean {
  return (
    left.packageName === right.packageName && normalizePathPortable(left.source) === normalizePathPortable(right.source)
  );
}

function cloneRustModuleStateIdentity(module: Readonly<IrModule>): CompilerModuleIdentity {
  return { name: module.name, packageName: module.packageName, source: normalizePathPortable(module.source) };
}

function getRustModuleStateModuleKey(module: Readonly<IrModule>): string {
  return `${module.packageName}\0${normalizePathPortable(module.source)}\0${module.name}`;
}

function cloneAndFreezeRustModuleStatePlan(plan: CompilerRustModuleStatePlan): CompilerRustModuleStatePlan {
  const clone = structuredClone(plan);
  freezeRustModuleStatePlanValue(clone, new WeakSet());
  return clone;
}

function freezeRustModuleStatePlanValue(value: unknown, seen: WeakSet<object>): void {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  for (const child of Object.values(value)) freezeRustModuleStatePlanValue(child, seen);
  Object.freeze(value);
}
