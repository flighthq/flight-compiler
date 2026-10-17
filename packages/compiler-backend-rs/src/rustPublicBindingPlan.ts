import {
  compareTextCodeUnits,
  normalizeCompilerStructuralValueCanonical,
  normalizePathPortable,
} from '../../compiler-canonical-form/src/index.js';
import {
  createIrModuleTargetNameAllocation,
  isCompilerTargetNameAllocationFailure,
} from '../../compiler-emission/src/index.js';
import type {
  CompilerModuleFacadeSlot,
  CompilerModuleIdentity,
  CompilerRustPublicBinding,
  CompilerRustPublicBindingCarrier,
  CompilerRustPublicBindingModuleRefusal,
  CompilerRustPublicBindingPlan,
  CompilerRustPublicBindingPlanInput,
  CompilerRustPublicBindingPlanningFailure,
  CompilerRustPublicBindingPlanningFailureCode,
  CompilerRustPublicCrateIdentity,
  CompilerRustPublicDependencyEdge,
  CompilerRustPublicModuleLocator,
  IrBindingIdentity,
  IrBindingPattern,
  IrDeclaration,
  IrModule,
  IrTypeBindingIdentity,
} from '../../compiler-types/src/index.js';
import {
  convertPackageNameToRustCrateName,
  createRustCompilerModuleLocator,
  getRustConstantBindingIds,
  getRustPreferredBindingName,
  isRustCompilerKeyword,
} from './rustCompilerIdentity.js';

export function createCompilerRustPublicBindingPlan(
  input: Readonly<CompilerRustPublicBindingPlanInput>,
): CompilerRustPublicBindingPlan {
  if (input.facade.schema !== 'flight-compiler-module-facade/1') {
    throw new TypeError('Rust public binding planning requires flight-compiler-module-facade/1');
  }

  const identities = collectRustPublicModuleIdentities(input);
  const crates = createRustPublicCrateIdentities(identities);
  const cratesByPackage = new Map(crates.map((crate) => [crate.packageName, crate]));
  const locators = new Map(
    identities.map((identity) => [
      getRustPublicModuleIdentityKey(identity),
      createRustPublicModuleLocator(identity, cratesByPackage.get(identity.packageName)!, crates.length > 1),
    ]),
  );
  assertRustPublicModuleLocatorsUnique(identities, locators);
  const targetNames = createRustPublicTargetNameMaps(input.modules);
  const bindings = createRustPublicBindings(input, locators, targetNames);
  assertRustPublicBindingsUnique(bindings);
  const modules = identities.map((identity) => ({
    identity,
    locator: locators.get(getRustPublicModuleIdentityKey(identity))!,
  }));
  const dependencies = createRustPublicDependencyEdges(input.facade.modules, locators);

  return cloneAndFreezeRustPublicBindingPlan({
    bindings,
    crates,
    dependencies,
    modules,
    schema: 'flight-rust-public-binding-plan/2',
  });
}

export function isCompilerRustPublicBindingPlanningFailure(
  value: unknown,
): value is CompilerRustPublicBindingPlanningFailure {
  return (
    value instanceof Error &&
    'kind' in value &&
    value.kind === 'rust-public-binding-planning' &&
    'code' in value &&
    rustPublicBindingPlanningFailureCodes.has(value.code as CompilerRustPublicBindingPlanningFailureCode) &&
    'subjects' in value &&
    Array.isArray(value.subjects) &&
    value.subjects.length >= 2 &&
    value.subjects.every((subject) => typeof subject === 'string' && subject.length > 0)
  );
}

function collectRustPublicModuleIdentities(
  input: Readonly<CompilerRustPublicBindingPlanInput>,
): readonly CompilerModuleIdentity[] {
  const identities = new Map<string, CompilerModuleIdentity>();
  const add = (identity: Readonly<CompilerModuleIdentity>): void => {
    const normalized = {
      name: identity.name.normalize('NFC'),
      packageName: identity.packageName.normalize('NFC'),
      source: normalizePathPortable(identity.source),
    };
    identities.set(getRustPublicModuleIdentityKey(normalized), normalized);
  };
  input.modules.forEach(add);
  for (const facadeModule of input.facade.modules) {
    add(facadeModule.module);
    for (const slot of facadeModule.slots) {
      add(slot.module);
      add(slot.route.module);
      for (const hop of slot.via) {
        add(hop.module);
        add(hop.target);
      }
    }
  }
  return [...identities.values()].sort((left, right) =>
    compareTextCodeUnits(getRustPublicModuleIdentityKey(left), getRustPublicModuleIdentityKey(right)),
  );
}

function createRustPublicCrateIdentities(
  modules: readonly Readonly<CompilerModuleIdentity>[],
): readonly CompilerRustPublicCrateIdentity[] {
  const packages = [...new Set(modules.map((module) => module.packageName))].sort(compareTextCodeUnits);
  const crates = packages.map((packageName) => {
    const cargoName = convertPackageNameToRustCrateName(packageName);
    return { cargoName, packageName, rustName: cargoName.replaceAll('-', '_') };
  });
  const byCargoName = new Map<string, CompilerRustPublicCrateIdentity[]>();
  for (const crate of crates) {
    byCargoName.set(crate.cargoName, [...(byCargoName.get(crate.cargoName) ?? []), crate]);
  }
  for (const [cargoName, collisions] of byCargoName) {
    if (collisions.length < 2) continue;
    throw createRustPublicBindingPlanningFailure(
      'rust-public-crate-collision',
      collisions.map((crate) => crate.packageName),
      `Rust crate identity ${cargoName} is shared by ${collisions.map((crate) => crate.packageName).join(', ')}`,
    );
  }
  return crates;
}

function createRustPublicModuleLocator(
  identity: Readonly<CompilerModuleIdentity>,
  crate: Readonly<CompilerRustPublicCrateIdentity>,
  multiPackage: boolean,
): CompilerRustPublicModuleLocator {
  const { modulePath, source } = createRustCompilerModuleLocator(identity, {
    multiPackage,
  });
  return { crate, modulePath, source };
}

function assertRustPublicModuleLocatorsUnique(
  identities: readonly Readonly<CompilerModuleIdentity>[],
  locators: ReadonlyMap<string, Readonly<CompilerRustPublicModuleLocator>>,
): void {
  const byLocator = new Map<string, CompilerModuleIdentity[]>();
  for (const identity of identities) {
    const locator = locators.get(getRustPublicModuleIdentityKey(identity))!;
    const key = `${locator.crate.cargoName}\0${locator.modulePath.join('\0')}`;
    byLocator.set(key, [...(byLocator.get(key) ?? []), identity]);
  }
  for (const [locator, collisions] of byLocator) {
    if (collisions.length < 2) continue;
    const subjects = collisions.map(getRustPublicModuleIdentityKey);
    throw createRustPublicBindingPlanningFailure(
      'rust-public-module-collision',
      subjects,
      `Rust module locator ${locator.replaceAll('\0', '::')} is shared by ${subjects.join(', ')}`,
    );
  }
}

function createRustPublicTargetNameMaps(
  modules: readonly Readonly<IrModule>[],
): ReadonlyMap<string, ReadonlyMap<string, string>> {
  const maps = new Map<string, ReadonlyMap<string, string>>();
  for (const module of modules) {
    const constants = getRustConstantBindingIds(module);
    try {
      maps.set(
        getRustPublicModuleIdentityKey(module),
        new Map(
          createIrModuleTargetNameAllocation(module, (binding) => ({
            namespace: 'identifier',
            preferredName: getRustPreferredBindingName(binding, constants),
          })).map((allocation) => [allocation.identity, allocation.name]),
        ),
      );
    } catch (error) {
      if (!isCompilerTargetNameAllocationFailure(error)) throw error;
      throw createRustPublicBindingPlanningFailure(
        'rust-public-binding-collision',
        error.identities,
        `Rust public declarations share fixed spelling ${error.targetName}`,
      );
    }
  }
  return maps;
}

function createRustPublicBindings(
  input: Readonly<CompilerRustPublicBindingPlanInput>,
  locators: ReadonlyMap<string, Readonly<CompilerRustPublicModuleLocator>>,
  targetNames: ReadonlyMap<string, ReadonlyMap<string, string>>,
): readonly CompilerRustPublicBinding[] {
  const bindings = input.facade.modules.flatMap((facadeModule) =>
    facadeModule.slots.map((slot): CompilerRustPublicBinding => {
      const identity = createRustPublicBindingSourceExportIdentity(slot);
      const key = `source-export:${normalizeCompilerStructuralValueCanonical(identity)}`;
      const publicModule = getRustPublicBindingModule(input.modules, facadeModule.module);
      const targetModule = getRustPublicBindingModule(input.modules, slot.route.module);
      const declarationModule = slot.route.kind === 'binding' ? targetModule : undefined;
      const declaration =
        slot.route.kind === 'binding' && declarationModule
          ? getRustPublicBindingDeclaration(declarationModule, slot.route.binding.id)
          : undefined;
      const moduleRefusal = getRustPublicBindingModuleRefusal(
        input.refusals ?? [],
        facadeModule.module,
        slot.route.module,
      );
      let binding: CompilerRustPublicBinding['binding'];
      if (moduleRefusal) {
        binding = {
          availability: 'refused',
          refusal: {
            code: 'rust-module-refused',
            detailCode: moduleRefusal.code,
            message: moduleRefusal.message,
            subject: key,
          },
        };
      } else if (slot.route.kind === 'expression') {
        binding = {
          availability: 'refused',
          refusal: {
            code: 'rust-unsupported-facade-route',
            message: `Rust public binding ${slot.exportName} requires ${slot.route.kind} facade lowering`,
            subject: key,
          },
        };
      } else if (slot.route.kind === 'namespace' && (!publicModule || !targetModule)) {
        binding = {
          availability: 'refused',
          refusal: {
            code: 'rust-module-missing',
            message: `Rust public namespace module is absent for ${slot.exportName}`,
            subject: key,
          },
        };
      } else if (slot.route.kind === 'namespace') {
        binding = {
          availability: 'available',
          locator: {
            carrier: 'module',
            module: locators.get(getRustPublicModuleIdentityKey(publicModule!))!,
            spelling: getRustPublicExportName(slot.lane, slot.exportName),
            target: locators.get(getRustPublicModuleIdentityKey(targetModule!))!,
          },
        };
      } else if (!publicModule || !declarationModule || !declaration) {
        binding = {
          availability: 'refused',
          refusal: {
            code: 'rust-declaration-missing',
            message: `Rust public binding declaration is absent for ${slot.exportName}`,
            subject: key,
          },
        };
      } else {
        const module = locators.get(getRustPublicModuleIdentityKey(publicModule))!;
        const direct =
          slot.source.kind === 'local-binding' &&
          getRustPublicModuleIdentityKey(publicModule) === getRustPublicModuleIdentityKey(declarationModule);
        const allocated = targetNames
          .get(getRustPublicModuleIdentityKey(declarationModule))
          ?.get(slot.route.binding.id);
        const spelling = direct
          ? (allocated ?? getRustPreferredBindingName(slot.route.binding, new Set()))
          : getRustPublicExportName(slot.lane, slot.exportName);
        binding = {
          availability: 'available',
          locator: { carrier: getRustPublicBindingCarrier(declaration), module, spelling },
        };
      }
      return { binding, facadeIdentity: slot.identity, identity, key };
    }),
  );
  return bindings.sort((left, right) => compareTextCodeUnits(left.key, right.key));
}

function createRustPublicBindingSourceExportIdentity(
  slot: Readonly<CompilerModuleFacadeSlot>,
): CompilerRustPublicBinding['identity'] {
  return {
    declarationIdentity: normalizeCompilerStructuralValueCanonical(
      slot.route.kind === 'binding' ? slot.route.binding : slot.route,
    ),
    exportRoute: normalizeCompilerStructuralValueCanonical({
      exportName: slot.exportName,
      source: slot.source,
      via: slot.via,
    }),
    packageName: slot.module.packageName,
    source: normalizePathPortable(slot.module.source),
    space: slot.lane,
  };
}

function getRustPublicBindingModule(
  modules: readonly Readonly<IrModule>[],
  identity: Readonly<CompilerModuleIdentity>,
): Readonly<IrModule> | undefined {
  const key = getRustPublicModuleIdentityKey(identity);
  return modules.find((module) => getRustPublicModuleIdentityKey(module) === key);
}

function getRustPublicBindingDeclaration(
  module: Readonly<IrModule>,
  bindingId: string,
): Readonly<IrDeclaration> | undefined {
  return module.declarations.find((declaration) =>
    getRustPublicDeclarationBindings(declaration).some((binding) => binding.id === bindingId),
  );
}

function getRustPublicDeclarationBindings(
  declaration: Readonly<IrDeclaration>,
): readonly (IrBindingIdentity | IrTypeBindingIdentity)[] {
  return 'binding' in declaration ? [declaration.binding] : getRustPublicPatternBindings(declaration.pattern);
}

function getRustPublicPatternBindings(pattern: Readonly<IrBindingPattern>): readonly IrBindingIdentity[] {
  if (pattern.kind === 'binding') return [pattern.binding];
  const children =
    pattern.kind === 'array'
      ? pattern.elements.flatMap((element) => (element ? getRustPublicPatternBindings(element.pattern) : []))
      : pattern.properties.flatMap((property) => getRustPublicPatternBindings(property.pattern));
  return pattern.rest ? [...children, ...getRustPublicPatternBindings(pattern.rest)] : children;
}

function getRustPublicBindingCarrier(
  declaration: Readonly<IrDeclaration>,
): Exclude<CompilerRustPublicBindingCarrier, 'module'> {
  if (declaration.kind === 'typeAlias') return 'type-alias';
  if (declaration.kind === 'variable') return 'value';
  return declaration.kind;
}

function getRustPublicBindingModuleRefusal(
  refusals: readonly Readonly<CompilerRustPublicBindingModuleRefusal>[],
  publicModule: Readonly<CompilerModuleIdentity>,
  declarationModule: Readonly<CompilerModuleIdentity>,
): Readonly<CompilerRustPublicBindingModuleRefusal> | undefined {
  const keys = new Set([
    getRustPublicModuleIdentityKey(publicModule),
    getRustPublicModuleIdentityKey(declarationModule),
  ]);
  return refusals
    .filter((refusal) => keys.has(getRustPublicModuleIdentityKey(refusal.module)))
    .sort((left, right) =>
      compareTextCodeUnits(
        normalizeCompilerStructuralValueCanonical(left),
        normalizeCompilerStructuralValueCanonical(right),
      ),
    )[0];
}

function createRustPublicDependencyEdges(
  facadeModules: Readonly<CompilerRustPublicBindingPlanInput['facade']['modules']>,
  locators: ReadonlyMap<string, Readonly<CompilerRustPublicModuleLocator>>,
): readonly CompilerRustPublicDependencyEdge[] {
  const edges = new Map<string, CompilerRustPublicDependencyEdge>();
  for (const hop of facadeModules.flatMap((module) => module.slots.flatMap((slot) => slot.via))) {
    const from = locators.get(getRustPublicModuleIdentityKey(hop.module))!;
    const target = locators.get(getRustPublicModuleIdentityKey(hop.target))!;
    const edge = { from, kind: hop.kind, specifier: hop.specifier, target };
    const key = normalizeCompilerStructuralValueCanonical(edge);
    edges.set(key, edge);
  }
  return [...edges.entries()].sort(([left], [right]) => compareTextCodeUnits(left, right)).map(([, edge]) => edge);
}

function assertRustPublicBindingsUnique(bindings: readonly Readonly<CompilerRustPublicBinding>[]): void {
  const keys = new Map<string, CompilerRustPublicBinding[]>();
  const facadeIdentities = new Map<string, CompilerRustPublicBinding[]>();
  const locators = new Map<string, CompilerRustPublicBinding[]>();
  for (const binding of bindings) {
    keys.set(binding.key, [...(keys.get(binding.key) ?? []), binding]);
    facadeIdentities.set(binding.facadeIdentity, [...(facadeIdentities.get(binding.facadeIdentity) ?? []), binding]);
    if (binding.binding.availability !== 'available') continue;
    const locator = binding.binding.locator;
    const locatorKey = `${locator.module.crate.cargoName}\0${locator.module.modulePath.join('\0')}\0${binding.identity.space}\0${locator.spelling}`;
    locators.set(locatorKey, [...(locators.get(locatorKey) ?? []), binding]);
  }
  for (const group of [...keys.values(), ...facadeIdentities.values(), ...locators.values()]) {
    if (group.length < 2) continue;
    const subjects = group.map((binding) => binding.facadeIdentity);
    throw createRustPublicBindingPlanningFailure(
      'rust-public-binding-collision',
      subjects,
      `Rust public binding collision: ${subjects.join(', ')}`,
    );
  }
}

function getRustPublicExportName(space: 'type' | 'value', name: string): string {
  return space === 'type' ? rustPublicTypeName(name) : rustPublicValueName(name);
}

function rustPublicTypeName(name: string): string {
  const stripped = name.startsWith('#') ? name.slice(1) : name;
  const value = stripped
    .split('.')
    .map((segment) =>
      segment
        .split(/[-_]/u)
        .filter(Boolean)
        .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
        .join(''),
    )
    .join('::');
  return isRustCompilerKeyword(value) ? `${value}_` : value;
}

function rustPublicValueName(name: string): string {
  if (name === 'this') return 'self';
  const stripped = name.startsWith('#') ? name.slice(1) : name;
  const value = rustPublicSnakeCase(stripped);
  return isRustCompilerKeyword(value) ? `${value}_` : value;
}

function rustPublicSnakeCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/gu, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/gu, '$1_$2')
    .replace(/[-\s]+/gu, '_')
    .toLowerCase();
}

function getRustPublicModuleIdentityKey(identity: Readonly<CompilerModuleIdentity>): string {
  return `${identity.packageName.normalize('NFC')}\0${normalizePathPortable(identity.source)}\0${identity.name.normalize('NFC')}`;
}

function createRustPublicBindingPlanningFailure(
  code: CompilerRustPublicBindingPlanningFailureCode,
  subjects: readonly string[],
  message: string,
): CompilerRustPublicBindingPlanningFailure {
  return Object.assign(new Error(message), {
    code,
    kind: 'rust-public-binding-planning' as const,
    subjects: [...subjects].sort(compareTextCodeUnits),
  });
}

function cloneAndFreezeRustPublicBindingPlan(plan: CompilerRustPublicBindingPlan): CompilerRustPublicBindingPlan {
  const clone = structuredClone(plan);
  freezeRustPublicBindingPlanValue(clone, new WeakSet());
  return clone;
}

function freezeRustPublicBindingPlanValue(value: unknown, seen: WeakSet<object>): void {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  for (const child of Object.values(value)) freezeRustPublicBindingPlanValue(child, seen);
  Object.freeze(value);
}

const rustPublicBindingPlanningFailureCodes: ReadonlySet<CompilerRustPublicBindingPlanningFailureCode> = new Set([
  'rust-public-binding-collision',
  'rust-public-crate-collision',
  'rust-public-module-collision',
]);
