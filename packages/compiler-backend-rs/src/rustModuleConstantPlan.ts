import path from 'node:path';

import { compareTextCodeUnits, normalizePathPortable } from '../../compiler-canonical-form/src/index.js';
import type {
  CompilerModuleIdentity,
  CompilerModuleResolutionEdge,
  CompilerModuleResolutionPlan,
  CompilerRustModuleArrayImportRefusal,
  CompilerRustModuleConstantBindingPlan,
  CompilerRustModuleConstantModulePlan,
  CompilerRustModuleConstantPlan,
  CompilerRustModuleConstantPlanInput,
  CompilerRustModuleConstantRefusal,
  CompilerRustModuleConstantScalar,
  IrBindingIdentity,
  IrDeclaration,
  IrExpression,
  IrModule,
  IrVariableDeclaration,
} from '../../compiler-types/src/index.js';

type RustNamedModuleVariable = Readonly<IrVariableDeclaration> & Readonly<{ binding: Readonly<IrBindingIdentity> }>;

type RustNamedModuleConstant = RustNamedModuleVariable & Readonly<{ mutable: false }>;

interface RustModuleArrayDeclarationLocation {
  readonly declaration: RustNamedModuleVariable;
  readonly module: Readonly<IrModule>;
}

type RustModuleConstantDecision =
  | Readonly<{ dependencies: readonly string[]; kind: 'accepted'; scalar: CompilerRustModuleConstantScalar }>
  | Readonly<{
      kind: 'refused';
      reason: CompilerRustModuleConstantRefusal['reason'];
      subject: string;
    }>;

interface RustModuleConstantPlanningContext {
  readonly arrayRefusals: ReadonlyMap<string, ReadonlyMap<string, Readonly<CompilerRustModuleConstantRefusal>>>;
  readonly cyclicRuntimeEdges: ReadonlySet<string>;
  readonly moduleResolution: Readonly<CompilerModuleResolutionPlan> | undefined;
  readonly modules: readonly Readonly<IrModule>[];
  readonly plans: Map<string, CompilerRustModuleConstantModulePlan>;
  readonly planning: Set<string>;
}

/**
 * Proves the deliberately small expression language that Rust may place in a module `const` item.
 * Every omitted expression is a refusal: purity is insufficient when the emitted Rust may allocate,
 * call a non-const function, or erase the source language's single identity-bearing owner.
 */
export function createCompilerRustModuleConstantPlan(
  input: Readonly<CompilerRustModuleConstantPlanInput>,
): CompilerRustModuleConstantPlan {
  if (!input || typeof input !== 'object' || !Array.isArray(input.modules)) {
    throw new TypeError('Rust module-constant planning requires a module array');
  }
  if (input.moduleResolution && input.moduleResolution.schema !== 'flight-compiler-module-resolution/1') {
    throw new TypeError('Rust module-constant planning requires flight-compiler-module-resolution/1');
  }
  const modules = [...input.modules].sort((left, right) =>
    compareTextCodeUnits(getRustModuleConstantModuleKey(left), getRustModuleConstantModuleKey(right)),
  );
  const context: RustModuleConstantPlanningContext = {
    arrayRefusals: createRustModuleArrayRefusals(modules),
    cyclicRuntimeEdges: collectCyclicRustModuleConstantRuntimeEdges(modules, input.moduleResolution),
    moduleResolution: input.moduleResolution,
    modules,
    planning: new Set(),
    plans: new Map(),
  };
  const plans = modules.map((module) => createRustModuleConstantModulePlan(module, context));
  return cloneAndFreezeRustModuleConstantPlan({ modules: plans, schema: 'flight-rust-module-constant-plan/1' });
}

function createRustModuleArrayRefusals(
  modules: readonly Readonly<IrModule>[],
): ReadonlyMap<string, ReadonlyMap<string, Readonly<CompilerRustModuleConstantRefusal>>> {
  return new Map(
    modules.map((module) => [
      getRustModuleConstantModuleKey(module),
      new Map(
        module.declarations.flatMap((declaration, index) => {
          if (!isRustNamedModuleVariable(declaration) || !isRustModuleArrayIdentity(declaration)) return [];
          const refusal: CompilerRustModuleConstantRefusal = {
            bindingId: declaration.binding.id,
            code: 'rust-module-array-value-unrepresented',
            declarationPath: ['declarations', index],
            message: `module array value ${declaration.binding.name} requires runtime initialization and synchronized shared ownership; Rust const/static Vec storage is not represented`,
            reason: 'array-identity',
          };
          return [[declaration.binding.id, refusal] as const];
        }),
      ),
    ]),
  );
}

function createRustModuleArrayImportRefusals(
  module: Readonly<IrModule>,
  context: RustModuleConstantPlanningContext,
): readonly CompilerRustModuleArrayImportRefusal[] {
  return module.imports.flatMap((imported, importIndex) => {
    if (imported.typeOnly) return [];
    return imported.bindings.flatMap((binding, bindingIndex): CompilerRustModuleArrayImportRefusal[] => {
      if (binding.typeOnly || binding.imported === '*' || binding.imported === 'default') return [];
      const target = resolveRustModuleArrayImportModule(
        module,
        imported.specifier,
        binding.imported,
        context.modules,
        context.moduleResolution,
      );
      const provider = target
        ? resolveRustModuleArrayDeclaration(target, binding.imported, context, new Set())
        : undefined;
      if (
        !provider ||
        !context.arrayRefusals
          .get(getRustModuleConstantModuleKey(provider.module))
          ?.has(provider.declaration.binding.id)
      ) {
        return [];
      }
      return [
        {
          bindingId: binding.binding.id,
          code: 'rust-module-array-value-unrepresented',
          importPath: ['imports', importIndex, 'bindings', bindingIndex],
          message: `imported module array value ${binding.imported} requires runtime initialization and synchronized shared ownership; Rust const/static Vec storage is not represented`,
          providerBindingId: provider.declaration.binding.id,
          providerModule: cloneRustModuleConstantIdentity(provider.module),
          reason: 'array-identity',
        },
      ];
    });
  });
}

function createRustModuleConstantModulePlan(
  module: Readonly<IrModule>,
  context: RustModuleConstantPlanningContext,
): CompilerRustModuleConstantModulePlan {
  const key = getRustModuleConstantModuleKey(module);
  const existing = context.plans.get(key);
  if (existing) return existing;
  if (context.planning.has(key)) {
    return { bindings: [], importRefusals: [], module: cloneRustModuleConstantIdentity(module), refusals: [] };
  }
  context.planning.add(key);
  const bindings: CompilerRustModuleConstantBindingPlan[] = [];
  const refusals: CompilerRustModuleConstantRefusal[] = [];
  const bindingById = new Map<string, CompilerRustModuleConstantBindingPlan>();
  const refusalById = new Map<string, CompilerRustModuleConstantRefusal>();
  const declarationIndexByBindingId = new Map(
    module.declarations.flatMap((declaration, index) =>
      declaration.kind === 'variable' && 'binding' in declaration ? [[declaration.binding.id, index] as const] : [],
    ),
  );

  for (const [index, declaration] of module.declarations.entries()) {
    if (!isRustNamedModuleVariable(declaration)) continue;
    const declarationPath = ['declarations', index] as const;
    const arrayRefusal = context.arrayRefusals.get(key)?.get(declaration.binding.id);
    if (arrayRefusal) {
      const refusal = { ...arrayRefusal, declarationPath };
      refusals.push(refusal);
      refusalById.set(refusal.bindingId, refusal);
      continue;
    }
    if (!isRustNamedModuleConstant(declaration) || !declaration.initializer || !declaration.type) continue;
    const scalar = getRustModuleConstantDeclaredScalar(declaration);
    if (!scalar) {
      const refusal = createRustModuleConstantRefusal(
        declaration,
        declarationPath,
        'declared-type',
        'its declared type is not exactly number or boolean',
      );
      refusals.push(refusal);
      refusalById.set(refusal.bindingId, refusal);
      continue;
    }
    if (scalar === 'string') {
      if (declaration.initializer.kind === 'literal' && typeof declaration.initializer.value === 'string') {
        const binding: CompilerRustModuleConstantBindingPlan = {
          bindingId: declaration.binding.id,
          capability: 'literal-string-constant',
          declarationPath,
          dependencies: [],
          scalar,
        };
        bindings.push(binding);
        bindingById.set(binding.bindingId, binding);
        continue;
      }
      const refusal = createRustModuleConstantRefusal(
        declaration,
        declarationPath,
        'unsupported-expression',
        'its initializer is not one exact string literal',
      );
      refusals.push(refusal);
      refusalById.set(refusal.bindingId, refusal);
      continue;
    }
    const decision = classifyRustModuleConstantExpression(declaration.initializer, module, {
      ...context,
      bindingById,
      declarationIndex: index,
      declarationIndexByBindingId,
      refusalById,
    });
    if (decision.kind === 'refused' || decision.scalar !== scalar) {
      const refusal = createRustModuleConstantRefusal(
        declaration,
        declarationPath,
        decision.kind === 'refused' ? decision.reason : 'operator-domain',
        decision.kind === 'refused'
          ? decision.subject
          : `its initializer proves ${decision.scalar}, not the declared ${scalar}`,
      );
      refusals.push(refusal);
      refusalById.set(refusal.bindingId, refusal);
      continue;
    }
    const binding: CompilerRustModuleConstantBindingPlan = {
      bindingId: declaration.binding.id,
      capability: 'primitive-const-expression',
      declarationPath,
      dependencies: decision.dependencies,
      scalar,
    };
    bindings.push(binding);
    bindingById.set(binding.bindingId, binding);
  }

  const plan: CompilerRustModuleConstantModulePlan = {
    bindings,
    importRefusals: createRustModuleArrayImportRefusals(module, context),
    module: cloneRustModuleConstantIdentity(module),
    refusals,
  };
  context.planning.delete(key);
  context.plans.set(key, plan);
  return plan;
}

function classifyRustModuleConstantExpression(
  expression: Readonly<IrExpression>,
  module: Readonly<IrModule>,
  context: RustModuleConstantPlanningContext &
    Readonly<{
      bindingById: ReadonlyMap<string, CompilerRustModuleConstantBindingPlan>;
      declarationIndex: number;
      declarationIndexByBindingId: ReadonlyMap<string, number>;
      refusalById: ReadonlyMap<string, CompilerRustModuleConstantRefusal>;
    }>,
): RustModuleConstantDecision {
  switch (expression.kind) {
    case 'literal':
      if (typeof expression.value === 'boolean') return { dependencies: [], kind: 'accepted', scalar: 'boolean' };
      if (typeof expression.value === 'number') {
        return Number.isFinite(expression.value)
          ? { dependencies: [], kind: 'accepted', scalar: 'number' }
          : { kind: 'refused', reason: 'non-finite-number', subject: 'its number literal is not finite' };
      }
      return {
        kind: 'refused',
        reason: 'unsupported-expression',
        subject: 'string and null literals are not primitive Rust const carriers',
      };
    case 'identifier':
      return classifyRustModuleConstantIdentifier(expression, module, context);
    case 'unary': {
      if (expression.postfix) return unsupportedRustModuleConstantExpression(expression.kind);
      const operand = classifyRustModuleConstantExpression(expression.operand, module, context);
      if (operand.kind === 'refused') return operand;
      if (
        expression.operator === '!' &&
        operand.scalar === 'boolean' &&
        expression.semantics.operand.flow === 'boolean' &&
        expression.semantics.result === 'boolean'
      ) {
        return operand;
      }
      if (
        expression.operator === '-' &&
        operand.scalar === 'number' &&
        expression.semantics.operand.flow === 'number' &&
        expression.semantics.result === 'number'
      ) {
        return operand;
      }
      return unsupportedRustModuleConstantOperator(expression.operator);
    }
    case 'binary': {
      const left = classifyRustModuleConstantExpression(expression.left, module, context);
      if (left.kind === 'refused') return left;
      const right = classifyRustModuleConstantExpression(expression.right, module, context);
      if (right.kind === 'refused') return right;
      const dependencies = mergeRustModuleConstantDependencies(left.dependencies, right.dependencies);
      if (
        (expression.operator === '%' ||
          expression.operator === '*' ||
          expression.operator === '+' ||
          expression.operator === '-' ||
          expression.operator === '/') &&
        left.scalar === 'number' &&
        right.scalar === 'number' &&
        hasExactRustModuleConstantBinaryDomains(expression, 'number', 'number')
      ) {
        return { dependencies, kind: 'accepted', scalar: 'number' };
      }
      if (
        (expression.operator === '<' ||
          expression.operator === '<=' ||
          expression.operator === '>' ||
          expression.operator === '>=') &&
        left.scalar === 'number' &&
        right.scalar === 'number' &&
        hasExactRustModuleConstantBinaryDomains(expression, 'number', 'boolean')
      ) {
        return { dependencies, kind: 'accepted', scalar: 'boolean' };
      }
      if (
        (expression.operator === '&&' || expression.operator === '||') &&
        left.scalar === 'boolean' &&
        right.scalar === 'boolean' &&
        hasExactRustModuleConstantBinaryDomains(expression, 'boolean', 'boolean')
      ) {
        return { dependencies, kind: 'accepted', scalar: 'boolean' };
      }
      if (
        (expression.operator === '===' || expression.operator === '!==') &&
        left.scalar === right.scalar &&
        hasExactRustModuleConstantBinaryDomains(expression, left.scalar, 'boolean')
      ) {
        return { dependencies, kind: 'accepted', scalar: 'boolean' };
      }
      return unsupportedRustModuleConstantOperator(expression.operator);
    }
    case 'conditional': {
      const condition = classifyRustModuleConstantExpression(expression.condition, module, context);
      if (condition.kind === 'refused') return condition;
      const whenTrue = classifyRustModuleConstantExpression(expression.whenTrue, module, context);
      if (whenTrue.kind === 'refused') return whenTrue;
      const whenFalse = classifyRustModuleConstantExpression(expression.whenFalse, module, context);
      if (whenFalse.kind === 'refused') return whenFalse;
      if (condition.scalar !== 'boolean' || whenTrue.scalar !== whenFalse.scalar) {
        return unsupportedRustModuleConstantOperator('conditional');
      }
      return {
        dependencies: mergeRustModuleConstantDependencies(
          condition.dependencies,
          whenTrue.dependencies,
          whenFalse.dependencies,
        ),
        kind: 'accepted',
        scalar: whenTrue.scalar,
      };
    }
    case 'cast': {
      const operand = classifyRustModuleConstantExpression(expression.expression, module, context);
      if (operand.kind === 'refused') return operand;
      if (operand.scalar === 'number' && expression.type.kind === 'primitive' && expression.type.name === 'number') {
        return operand;
      }
      return unsupportedRustModuleConstantOperator('cast');
    }
    default:
      return unsupportedRustModuleConstantExpression(expression.kind);
  }
}

function classifyRustModuleConstantIdentifier(
  expression: Readonly<Extract<IrExpression, { kind: 'identifier' }>>,
  module: Readonly<IrModule>,
  context: RustModuleConstantPlanningContext &
    Readonly<{
      bindingById: ReadonlyMap<string, CompilerRustModuleConstantBindingPlan>;
      declarationIndex: number;
      declarationIndexByBindingId: ReadonlyMap<string, number>;
      refusalById: ReadonlyMap<string, CompilerRustModuleConstantRefusal>;
    }>,
): RustModuleConstantDecision {
  if (expression.reference.kind !== 'binding') return unsupportedRustModuleConstantExpression('identifier');
  const binding = expression.reference.binding;
  const local = context.bindingById.get(binding.id);
  if (local) return { dependencies: [binding.id], kind: 'accepted', scalar: local.scalar };
  if (context.refusalById.has(binding.id)) {
    return {
      kind: 'refused',
      reason: 'dependency-refused',
      subject: `it depends on unsupported module constant ${binding.name}`,
    };
  }
  const localIndex = context.declarationIndexByBindingId.get(binding.id);
  if (localIndex !== undefined && localIndex >= context.declarationIndex) {
    return {
      kind: 'refused',
      reason: 'dependency-not-earlier',
      subject: `it reads module binding ${binding.name} before that binding is initialized`,
    };
  }
  if (binding.kind !== 'import') return unsupportedRustModuleConstantExpression('identifier');
  return classifyImportedRustModuleConstant(binding.id, module, context);
}

function classifyImportedRustModuleConstant(
  bindingId: string,
  importer: Readonly<IrModule>,
  context: RustModuleConstantPlanningContext,
): RustModuleConstantDecision {
  const imported = importer.imports.flatMap((entry) =>
    entry.bindings.flatMap((binding) =>
      !binding.typeOnly && binding.binding.id === bindingId ? [{ entry, binding }] : [],
    ),
  );
  if (imported.length !== 1) return inexactRustModuleConstantImport('its imported binding is not unique');
  const request = imported[0]!;
  if (request.binding.imported === '*' || request.binding.imported === 'default') {
    return inexactRustModuleConstantImport('namespace and default imports are outside the Rust const proof');
  }
  const target = resolveExactRustModuleConstantImport(
    importer,
    request.entry.specifier,
    request.binding.imported,
    context.modules,
    context.moduleResolution,
  );
  if (!target) return inexactRustModuleConstantImport('its named import has no unique module-resolution edge');
  const edgeKey = getRustModuleConstantRuntimeEdgeKey(importer, target);
  if (context.cyclicRuntimeEdges.has(edgeKey)) {
    return {
      kind: 'refused',
      reason: 'dependency-cycle',
      subject: 'its imported constant is reached through a runtime module cycle',
    };
  }
  const provider = getDirectExportedRustModuleConstant(target, request.binding.imported);
  if (!provider) return inexactRustModuleConstantImport('its named export is not one exact direct variable binding');
  const targetPlan = createRustModuleConstantModulePlan(target, context);
  const accepted = targetPlan.bindings.find((candidate) => candidate.bindingId === provider.binding.id);
  if (accepted) return { dependencies: [bindingId], kind: 'accepted', scalar: accepted.scalar };
  return {
    kind: 'refused',
    reason: 'dependency-refused',
    subject: `its imported constant ${request.binding.imported} is not an approved Rust const expression`,
  };
}

function collectCyclicRustModuleConstantRuntimeEdges(
  modules: readonly Readonly<IrModule>[],
  moduleResolution: Readonly<CompilerModuleResolutionPlan> | undefined,
): ReadonlySet<string> {
  const targetsByModule = new Map<string, Set<string>>(
    modules.map((module) => [getRustModuleConstantModuleKey(module), new Set()]),
  );
  for (const importer of modules) {
    const importerKey = getRustModuleConstantModuleKey(importer);
    const targets = targetsByModule.get(importerKey)!;
    const addTarget = (specifier: string, importedName: string | undefined): void => {
      const target = resolveExactRustModuleConstantImport(importer, specifier, importedName, modules, moduleResolution);
      if (target) targets.add(getRustModuleConstantModuleKey(target));
    };
    for (const imported of importer.imports) {
      if (imported.typeOnly) continue;
      if (imported.bindings.length === 0) addTarget(imported.specifier, undefined);
      for (const binding of imported.bindings) {
        if (!binding.typeOnly) addTarget(imported.specifier, binding.imported);
      }
    }
    for (const exported of importer.exports) {
      if (!('specifier' in exported) || exported.typeOnly) continue;
      addTarget(exported.specifier, exported.kind === 'reexport' ? exported.imported : undefined);
    }
  }
  const cyclic = new Set<string>();
  for (const [from, targets] of targetsByModule) {
    for (const to of targets) {
      if (from === to || hasRustModuleConstantGraphPath(to, from, targetsByModule, new Set())) {
        cyclic.add(`${from}\0${to}`);
      }
    }
  }
  return cyclic;
}

function hasRustModuleConstantGraphPath(
  current: string,
  target: string,
  graph: ReadonlyMap<string, ReadonlySet<string>>,
  seen: Set<string>,
): boolean {
  if (current === target) return true;
  if (seen.has(current)) return false;
  seen.add(current);
  return [...(graph.get(current) ?? [])]
    .sort(compareTextCodeUnits)
    .some((next) => hasRustModuleConstantGraphPath(next, target, graph, seen));
}

function resolveExactRustModuleConstantImport(
  importer: Readonly<IrModule>,
  specifier: string,
  importedName: string | undefined,
  modules: readonly Readonly<IrModule>[],
  moduleResolution: Readonly<CompilerModuleResolutionPlan> | undefined,
): Readonly<IrModule> | undefined {
  const matching = moduleResolution?.edges.filter((edge) => edge.specifier === specifier) ?? [];
  const exact = matching.filter((edge) => edge.importer && isRustModuleConstantIdentityEqual(edge.importer, importer));
  const scoped = exact.length > 0 ? exact : matching.filter((edge) => edge.importer === undefined);
  const routes = scoped.filter(
    (edge) =>
      edge.importedNames === undefined || (importedName !== undefined && edge.importedNames.includes(importedName)),
  );
  const resolved = routes.flatMap((edge) => resolveRustModuleConstantEdgeTarget(edge, modules));
  const unique = new Map(resolved.map((module) => [getRustModuleConstantModuleKey(module), module]));
  return unique.size === 1 ? [...unique.values()][0] : undefined;
}

function resolveRustModuleConstantEdgeTarget(
  edge: Readonly<CompilerModuleResolutionEdge>,
  modules: readonly Readonly<IrModule>[],
): readonly Readonly<IrModule>[] {
  return modules.filter(
    (module) =>
      module.packageName === edge.target.packageName &&
      normalizePathPortable(module.source) === normalizePathPortable(edge.target.source),
  );
}

function resolveRustModuleArrayImportModule(
  importer: Readonly<IrModule>,
  specifier: string,
  importedName: string,
  modules: readonly Readonly<IrModule>[],
  moduleResolution: Readonly<CompilerModuleResolutionPlan> | undefined,
): Readonly<IrModule> | undefined {
  const resolved = resolveExactRustModuleConstantImport(importer, specifier, importedName, modules, moduleResolution);
  if (resolved || !specifier.startsWith('.')) return resolved;
  const source = normalizePathPortable(
    path.posix.join(path.posix.dirname(importer.source), specifier.replace(/\.[cm]?js$/u, '.ts')),
  );
  const candidates = new Set([source, `${source}.ts`, `${source}/index.ts`]);
  const matching = modules.filter(
    (module) =>
      module.packageName === importer.packageName &&
      candidates.has(normalizePathPortable(path.posix.normalize(module.source))),
  );
  return matching.length === 1 ? matching[0] : undefined;
}

function resolveRustModuleArrayDeclaration(
  module: Readonly<IrModule>,
  exportedName: string,
  context: RustModuleConstantPlanningContext,
  seen: ReadonlySet<string>,
): RustModuleArrayDeclarationLocation | undefined {
  const key = `${getRustModuleConstantModuleKey(module)}\0${exportedName}`;
  if (seen.has(key)) return undefined;
  const nextSeen = new Set(seen).add(key);
  const direct = module.declarations.filter(
    (declaration): declaration is RustNamedModuleVariable =>
      isRustNamedModuleVariable(declaration) && declaration.exported && declaration.binding.name === exportedName,
  );
  const local = module.exports.flatMap((exported) =>
    exported.kind === 'local' && !exported.typeOnly && exported.exported === exportedName
      ? module.declarations.filter(
          (declaration): declaration is RustNamedModuleVariable =>
            isRustNamedModuleVariable(declaration) && declaration.binding.id === exported.binding.id,
        )
      : [],
  );
  const declarations = new Map([...direct, ...local].map((declaration) => [declaration.binding.id, declaration]));
  const reexports = module.exports.filter(
    (exported) => exported.kind === 'reexport' && !exported.typeOnly && exported.exported === exportedName,
  );
  if (declarations.size + reexports.length !== 1) return undefined;
  const declaration = [...declarations.values()][0];
  if (declaration) return { declaration, module };
  const reexport = reexports[0];
  if (reexport?.kind !== 'reexport') return undefined;
  const target = resolveRustModuleArrayImportModule(
    module,
    reexport.specifier,
    reexport.imported,
    context.modules,
    context.moduleResolution,
  );
  return target ? resolveRustModuleArrayDeclaration(target, reexport.imported, context, nextSeen) : undefined;
}

function getDirectExportedRustModuleConstant(
  module: Readonly<IrModule>,
  exportedName: string,
): RustNamedModuleConstant | undefined {
  const direct = module.declarations.filter(
    (declaration): declaration is RustNamedModuleConstant =>
      isRustNamedModuleConstant(declaration) && declaration.exported && declaration.binding.name === exportedName,
  );
  const localExports = module.exports.flatMap((exported) =>
    exported.kind === 'local' && !exported.typeOnly && exported.exported === exportedName ? [exported] : [],
  );
  const local = localExports.flatMap((exported) =>
    module.declarations.filter(
      (declaration): declaration is RustNamedModuleConstant =>
        isRustNamedModuleConstant(declaration) && declaration.binding.id === exported.binding.id,
    ),
  );
  const candidates = new Map([...direct, ...local].map((declaration) => [declaration.binding.id, declaration]));
  return candidates.size === 1 ? [...candidates.values()][0] : undefined;
}

function isRustNamedModuleConstant(declaration: Readonly<IrDeclaration>): declaration is RustNamedModuleConstant {
  return isRustNamedModuleVariable(declaration) && !declaration.mutable;
}

function isRustNamedModuleVariable(declaration: Readonly<IrDeclaration>): declaration is RustNamedModuleVariable {
  return declaration.kind === 'variable' && !('pattern' in declaration);
}

function getRustModuleConstantDeclaredScalar(
  declaration: RustNamedModuleConstant,
): CompilerRustModuleConstantScalar | undefined {
  if (declaration.type?.kind !== 'primitive') return undefined;
  return declaration.type.name === 'boolean' || declaration.type.name === 'number' || declaration.type.name === 'string'
    ? declaration.type.name
    : undefined;
}

function isRustModuleArrayIdentity(declaration: RustNamedModuleVariable): boolean {
  if (declaration.type?.kind === 'array' || declaration.type?.kind === 'tuple') return true;
  const initializer = declaration.initializer;
  if (!initializer) return false;
  if (initializer.kind === 'array' || initializer.kind === 'tuple' || initializer.kind === 'tupleSpread') return true;
  return (
    initializer.kind === 'new' &&
    initializer.callee.kind === 'identifier' &&
    initializer.callee.reference.kind === 'ambient' &&
    initializer.callee.reference.name === 'Array'
  );
}

function hasExactRustModuleConstantBinaryDomains(
  expression: Readonly<Extract<IrExpression, { kind: 'binary' }>>,
  operand: CompilerRustModuleConstantScalar,
  result: CompilerRustModuleConstantScalar,
): boolean {
  return (
    expression.semantics.left.flow === operand &&
    expression.semantics.right.flow === operand &&
    expression.semantics.result === result
  );
}

function createRustModuleConstantRefusal(
  declaration: RustNamedModuleConstant,
  declarationPath: readonly (number | string)[],
  reason: CompilerRustModuleConstantRefusal['reason'],
  subject: string,
): CompilerRustModuleConstantRefusal {
  return {
    bindingId: declaration.binding.id,
    code: 'rust-module-constant-initializer-unsupported',
    declarationPath,
    message: `module constant ${declaration.binding.name} cannot be emitted as a Rust const item because ${subject}`,
    reason,
  };
}

function inexactRustModuleConstantImport(subject: string): RustModuleConstantDecision {
  return { kind: 'refused', reason: 'import-not-exact', subject };
}

function unsupportedRustModuleConstantExpression(
  kind: IrExpression['kind'] | 'identifier',
): RustModuleConstantDecision {
  return {
    kind: 'refused',
    reason: 'unsupported-expression',
    subject: `expression kind ${kind} is outside the allocation-free Rust const whitelist`,
  };
}

function unsupportedRustModuleConstantOperator(operator: string): RustModuleConstantDecision {
  return {
    kind: 'refused',
    reason: 'operator-domain',
    subject: `operator ${operator} lacks exact primitive Rust const evidence`,
  };
}

function mergeRustModuleConstantDependencies(...groups: readonly (readonly string[])[]): readonly string[] {
  return [...new Set(groups.flat())];
}

function getRustModuleConstantRuntimeEdgeKey(from: Readonly<IrModule>, to: Readonly<IrModule>): string {
  return `${getRustModuleConstantModuleKey(from)}\0${getRustModuleConstantModuleKey(to)}`;
}

function isRustModuleConstantIdentityEqual(
  left: Readonly<CompilerModuleIdentity>,
  right: Readonly<CompilerModuleIdentity>,
): boolean {
  return (
    left.name === right.name &&
    left.packageName === right.packageName &&
    normalizePathPortable(left.source) === normalizePathPortable(right.source)
  );
}

function cloneRustModuleConstantIdentity(module: Readonly<IrModule>): CompilerModuleIdentity {
  return { name: module.name, packageName: module.packageName, source: normalizePathPortable(module.source) };
}

function getRustModuleConstantModuleKey(module: Readonly<IrModule>): string {
  return `${module.packageName}\0${normalizePathPortable(path.posix.normalize(module.source))}\0${module.name}`;
}

function cloneAndFreezeRustModuleConstantPlan(plan: CompilerRustModuleConstantPlan): CompilerRustModuleConstantPlan {
  const clone = structuredClone(plan);
  freezeRustModuleConstantPlanValue(clone, new WeakSet());
  return clone;
}

function freezeRustModuleConstantPlanValue(value: unknown, seen: WeakSet<object>): void {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  for (const child of Object.values(value)) freezeRustModuleConstantPlanValue(child, seen);
  Object.freeze(value);
}
