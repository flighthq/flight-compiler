import {
  compareTextCodeUnits,
  normalizeCompilerStructuralValueCanonical,
  normalizePathPortable,
} from '../../compiler-canonical-form/src/index.js';
import type {
  CompilerCppPublicBinding,
  CompilerHaxeDualBinding,
  CompilerHaxeDualBindingPlan,
  CompilerHaxeDualBindingPlanInput,
  CompilerHaxePublicBindingIdentity,
  CompilerModuleFacadeSlot,
  CompilerPublicBindingModuleRefusal,
  IrBindingIdentity,
  IrBindingPattern,
  IrDeclaration,
  IrFunctionSignature,
  IrModule,
  IrType,
  IrTypeBindingIdentity,
} from '../../compiler-types/src/index.js';
import { convertPackageNameToHaxePackageName } from './haxeCompilerIdentity.js';
import { getCompilerRuntimeExternalSymbolTargetHaxe } from './haxeRuntimeExternalSymbolBinding.js';
import { emitIrTypeHaxe } from './haxeTypeEmission.js';

interface HaxeDualBindingRecord {
  readonly binding: Readonly<CompilerHaxeDualBindingPlanInput['cpp']['bindings'][number]>;
  readonly declaration: Readonly<IrDeclaration>;
  readonly declarationModule: Readonly<IrModule>;
  readonly slot: Readonly<CompilerModuleFacadeSlot & { readonly route: { readonly kind: 'binding' } }>;
}

export function createCompilerHaxeDualBindingPlan(
  input: Readonly<CompilerHaxeDualBindingPlanInput>,
): CompilerHaxeDualBindingPlan {
  if (input.cpp.schema !== 'flight-cpp-public-binding-plan/1') {
    throw new TypeError('Haxe dual binding planning requires flight-cpp-public-binding-plan/1');
  }
  if (input.facade.schema !== 'flight-compiler-module-facade/1') {
    throw new TypeError('Haxe dual binding planning requires flight-compiler-module-facade/1');
  }
  const slots = input.facade.modules
    .flatMap((module) => module.slots)
    .filter((slot): slot is HaxeDualBindingRecord['slot'] => slot.route.kind === 'binding');
  const slotsByIdentity = new Map(slots.map((slot) => [slot.identity, slot]));
  const cppBindings = new Map(input.cpp.bindings.map((binding) => [binding.facadeIdentity, binding]));
  if (cppBindings.size !== input.cpp.bindings.length) {
    throw new TypeError('C++ public binding plan duplicates a facade identity');
  }
  const absentCppSlot = input.cpp.bindings.find((binding) => !slotsByIdentity.has(binding.facadeIdentity));
  if (absentCppSlot) {
    throw new TypeError(`C++ public binding plan references absent facade slot ${absentCppSlot.facadeIdentity}`);
  }
  const allRecords = slots.map((slot): HaxeDualBindingRecord => {
    const binding = cppBindings.get(slot.identity) ?? createHaxeDualBindingMissingCppInput(slot);
    const declarationModule = getHaxeDualBindingModule(input.modules, slot.route.module);
    const declaration = declarationModule
      ? getHaxeDualBindingDeclaration(declarationModule, slot.route.binding.id)
      : undefined;
    if (!declarationModule || !declaration) {
      throw new TypeError(`Haxe public binding declaration is absent for ${slot.exportName}`);
    }
    return { binding, declaration, declarationModule, slot };
  });
  const records = allRecords.filter(
    (record) =>
      record.slot.lane === 'type' ||
      (record.declaration.kind !== 'class' && record.declaration.kind !== 'enum') ||
      !allRecords.some(
        (candidate) =>
          candidate.slot.lane === 'type' &&
          candidate.slot.exportName === record.slot.exportName &&
          candidate.slot.module.name === record.slot.module.name &&
          candidate.slot.module.packageName === record.slot.module.packageName &&
          normalizePathPortable(candidate.slot.module.source) === normalizePathPortable(record.slot.module.source) &&
          candidate.slot.route.binding.id === record.slot.route.binding.id,
      ),
  );
  const options = input.options ?? {};
  const typeNames = allocateHaxeDualBindingNames(
    records.filter((record) => record.slot.lane === 'type'),
    (record) =>
      `${getHaxeDualBindingRootPackage(record.slot.module.packageName, options.rootPackage)}\0${getSafeHaxeDualBindingTypeName(record.slot.exportName)}`,
    (record) => getSafeHaxeDualBindingTypeName(record.slot.exportName),
  );
  const holderNames = allocateHaxeDualBindingPackageHolders(records, options.rootPackage);
  const valueNames = allocateHaxeDualBindingNames(
    records.filter(
      (record) =>
        record.slot.lane === 'value' && record.declaration.kind !== 'class' && record.declaration.kind !== 'enum',
    ),
    (record) => {
      const root = getHaxeDualBindingRootPackage(record.slot.module.packageName, options.rootPackage);
      return `${root}.${holderNames.get(record.slot.module.packageName)!}\0${getSafeHaxeDualBindingName(record.slot.exportName)}`;
    },
    (record) => getSafeHaxeDualBindingName(record.slot.exportName),
  );
  const publicTypesByBinding = new Map<string, string>();
  for (const record of [...records].sort((left, right) => compareTextCodeUnits(left.binding.key, right.binding.key))) {
    if (record.slot.lane !== 'type') continue;
    const root = getHaxeDualBindingRootPackage(record.slot.module.packageName, options.rootPackage);
    const qualified = `${root}.${typeNames.get(record.binding.key)!}`;
    if (!publicTypesByBinding.has(record.slot.route.binding.id)) {
      publicTypesByBinding.set(record.slot.route.binding.id, qualified);
    }
  }
  const bindings = records
    .map((record): CompilerHaxeDualBinding => {
      const publicHaxe = createHaxeDualBindingPublicIdentity(
        record,
        typeNames,
        valueNames,
        holderNames,
        publicTypesByBinding,
        options.rootPackage,
        options.runtimeModule,
      );
      const javascriptRefusal = getHaxeDualBindingModuleRefusal(
        input.javascriptRefusals ?? [],
        record.slot.module,
        record.slot.route.module,
      );
      return {
        cpp: record.binding.binding,
        identity: record.binding.identity,
        javascript: javascriptRefusal
          ? {
              availability: 'refused',
              refusal: {
                code: 'js-module-refused',
                detailCode: javascriptRefusal.code,
                message: javascriptRefusal.message,
                subject: record.binding.key,
              },
            }
          : {
              availability: 'available',
              locator: {
                exportedName: record.slot.exportName,
                specifier:
                  input.packageSpecifiers?.[record.slot.module.packageName] ??
                  `${record.slot.module.packageName}/contract`,
              },
            },
        key: record.binding.key,
        publicHaxe,
      };
    })
    .sort((left, right) => compareTextCodeUnits(left.key, right.key));
  return cloneAndFreezeHaxeDualBindingPlan({ bindings, schema: 'flight-haxe-dual-binding-plan/1' });
}

function createHaxeDualBindingMissingCppInput(slot: Readonly<HaxeDualBindingRecord['slot']>): CompilerCppPublicBinding {
  const identity: CompilerCppPublicBinding['identity'] = {
    declarationIdentity: normalizeCompilerStructuralValueCanonical(slot.route.binding),
    exportRoute: normalizeCompilerStructuralValueCanonical({
      exportName: slot.exportName,
      source: slot.source,
      via: slot.via,
    }),
    packageName: slot.module.packageName,
    source: normalizePathPortable(slot.module.source),
    space: slot.lane,
  };
  const key = `source-export:${normalizeCompilerStructuralValueCanonical(identity)}`;
  return {
    binding: {
      availability: 'refused',
      refusal: {
        code: 'cpp-input-missing',
        message: `C++ public binding input is absent for ${slot.exportName}`,
        subject: key,
      },
    },
    facadeIdentity: slot.identity,
    identity,
    key,
  };
}

function createHaxeDualBindingPublicIdentity(
  record: Readonly<HaxeDualBindingRecord>,
  typeNames: ReadonlyMap<string, string>,
  valueNames: ReadonlyMap<string, string>,
  holderNames: ReadonlyMap<string, string>,
  publicTypesByBinding: ReadonlyMap<string, string>,
  rootPackage: string | undefined,
  runtimeModule: string | undefined,
): CompilerHaxePublicBindingIdentity {
  const root = getHaxeDualBindingRootPackage(record.slot.module.packageName, rootPackage);
  if (record.slot.lane === 'type') {
    const name = typeNames.get(record.binding.key)!;
    const qualifiedName = `${root}.${name}`;
    const kind = record.declaration.kind === 'class' || record.declaration.kind === 'enum' ? 'type-value' : 'type';
    return { kind, name, owner: root, qualifiedName, typeIdentity: qualifiedName };
  }
  if (record.declaration.kind === 'class' || record.declaration.kind === 'enum') {
    const qualifiedName =
      publicTypesByBinding.get(record.slot.route.binding.id) ??
      `${root}.${getSafeHaxeDualBindingTypeName(record.slot.exportName)}`;
    return {
      kind: 'type-value',
      name: qualifiedName.slice(qualifiedName.lastIndexOf('.') + 1),
      owner: qualifiedName.slice(0, qualifiedName.lastIndexOf('.')),
      qualifiedName,
      typeIdentity: qualifiedName,
    };
  }
  const owner = `${root}.${holderNames.get(record.slot.module.packageName)!}`;
  const name = valueNames.get(record.binding.key)!;
  const emitType = (type: Readonly<IrType>) => emitHaxeDualBindingType(type, publicTypesByBinding, runtimeModule);
  if (record.declaration.kind === 'function') {
    const signature = emitHaxeDualBindingFunctionSignature(name, record.declaration, emitType);
    return {
      kind: 'function',
      name,
      owner,
      qualifiedName: `${owner}.${name}`,
      signature,
      typeIdentity: emitHaxeDualBindingFunctionType(record.declaration, emitType),
    };
  }
  const type =
    record.declaration.kind === 'variable' && record.declaration.type ? emitType(record.declaration.type) : 'Dynamic';
  return { kind: 'value', name, owner, qualifiedName: `${owner}.${name}`, typeIdentity: type };
}

function emitHaxeDualBindingFunctionSignature(
  name: string,
  signature: Readonly<IrFunctionSignature>,
  emitType: (type: Readonly<IrType>) => string,
): string {
  const typeParameters =
    signature.typeParameters.length === 0
      ? ''
      : `<${signature.typeParameters.map((parameter) => getSafeHaxeDualBindingTypeName(parameter.binding.name)).join(', ')}>`;
  const parameters = signature.parameters
    .map((parameter) => {
      const type = parameter.rest && parameter.type.kind === 'array' ? parameter.type.element : parameter.type;
      const prefix = parameter.rest ? '...' : parameter.optional || parameter.initializer ? '?' : '';
      return `${prefix}${getSafeHaxeDualBindingName(parameter.binding.name)}:${emitType(type)}`;
    })
    .join(', ');
  return `function ${name}${typeParameters}(${parameters}):${emitType(signature.returns)};`;
}

function emitHaxeDualBindingFunctionType(
  signature: Readonly<IrFunctionSignature>,
  emitType: (type: Readonly<IrType>) => string,
): string {
  const parameters = signature.parameters.map((parameter) => {
    const type = parameter.rest && parameter.type.kind === 'array' ? parameter.type.element : parameter.type;
    return `${parameter.optional || parameter.initializer ? '?' : ''}${emitType(type)}`;
  });
  return `(${parameters.join(', ')})->${emitType(signature.returns)}`;
}

function emitHaxeDualBindingType(
  type: Readonly<IrType>,
  publicTypesByBinding: ReadonlyMap<string, string>,
  runtimeModule: string | undefined,
): string {
  return emitIrTypeHaxe(type, {
    fail: () => {
      throw new TypeError('Haxe dual binding type is not representable');
    },
    getBindingName: (binding) => publicTypesByBinding.get(binding.id) ?? getSafeHaxeDualBindingTypeName(binding.name),
    getExternalTypeName: (name) => getCompilerRuntimeExternalSymbolTargetHaxe(name, 'type', runtimeModule) ?? 'Dynamic',
    getMemberName: getSafeHaxeDualBindingName,
    getTypeName: getSafeHaxeDualBindingTypeName,
    resolveNamedType: (reference) =>
      reference.reference.kind === 'binding' ? publicTypesByBinding.get(reference.reference.binding.id) : undefined,
  });
}

function allocateHaxeDualBindingPackageHolders(
  records: readonly Readonly<HaxeDualBindingRecord>[],
  rootPackage: string | undefined,
): ReadonlyMap<string, string> {
  const packages = [...new Set(records.map((record) => record.slot.module.packageName))].sort(compareTextCodeUnits);
  const groups = new Map<string, string[]>();
  for (const packageName of packages) {
    const root = getHaxeDualBindingRootPackage(packageName, rootPackage);
    const preferred = getHaxeDualBindingPackageHolderName(packageName, rootPackage);
    const key = `${root}\0${preferred}`;
    groups.set(key, [...(groups.get(key) ?? []), packageName]);
  }
  const result = new Map<string, string>();
  for (const packageNames of groups.values()) {
    for (const packageName of packageNames) {
      const preferred = getHaxeDualBindingPackageHolderName(packageName, rootPackage);
      result.set(
        packageName,
        packageNames.length === 1 ? preferred : `${preferred}_flight_${getHaxeDualBindingStableHash(packageName)}`,
      );
    }
  }
  return result;
}

function allocateHaxeDualBindingNames(
  records: readonly Readonly<HaxeDualBindingRecord>[],
  getGroupKey: (record: Readonly<HaxeDualBindingRecord>) => string,
  getPreferredName: (record: Readonly<HaxeDualBindingRecord>) => string,
): ReadonlyMap<string, string> {
  const groups = new Map<string, HaxeDualBindingRecord[]>();
  for (const record of records) {
    const key = getGroupKey(record);
    groups.set(key, [...(groups.get(key) ?? []), record]);
  }
  const result = new Map<string, string>();
  for (const group of groups.values()) {
    group.sort((left, right) => compareTextCodeUnits(left.binding.key, right.binding.key));
    for (const record of group) {
      const preferred = getPreferredName(record);
      result.set(
        record.binding.key,
        group.length === 1 ? preferred : `${preferred}_flight_${getHaxeDualBindingStableHash(record.binding.key)}`,
      );
    }
  }
  return result;
}

function getHaxeDualBindingModule(
  modules: readonly Readonly<IrModule>[],
  identity: Readonly<{ name: string; packageName: string; source: string }>,
): Readonly<IrModule> | undefined {
  return modules.find(
    (module) =>
      module.name === identity.name &&
      module.packageName === identity.packageName &&
      normalizePathPortable(module.source) === normalizePathPortable(identity.source),
  );
}

function getHaxeDualBindingDeclaration(
  module: Readonly<IrModule>,
  bindingId: string,
): Readonly<IrDeclaration> | undefined {
  return module.declarations.find((declaration) =>
    getHaxeDualBindingDeclarationBindings(declaration).some((binding) => binding.id === bindingId),
  );
}

function getHaxeDualBindingDeclarationBindings(
  declaration: Readonly<IrDeclaration>,
): readonly (IrBindingIdentity | IrTypeBindingIdentity)[] {
  return 'binding' in declaration ? [declaration.binding] : getHaxeDualBindingPatternBindings(declaration.pattern);
}

function getHaxeDualBindingPatternBindings(pattern: Readonly<IrBindingPattern>): readonly IrBindingIdentity[] {
  if (pattern.kind === 'binding') return [pattern.binding];
  const children =
    pattern.kind === 'array'
      ? pattern.elements.flatMap((element) => (element ? getHaxeDualBindingPatternBindings(element.pattern) : []))
      : pattern.properties.flatMap((property) => getHaxeDualBindingPatternBindings(property.pattern));
  return pattern.rest ? [...children, ...getHaxeDualBindingPatternBindings(pattern.rest)] : children;
}

function getHaxeDualBindingModuleRefusal(
  refusals: readonly Readonly<CompilerPublicBindingModuleRefusal>[],
  publicModule: Readonly<{ name: string; packageName: string; source: string }>,
  declarationModule: Readonly<{ name: string; packageName: string; source: string }>,
): Readonly<CompilerPublicBindingModuleRefusal> | undefined {
  return [publicModule, declarationModule].flatMap((module) =>
    refusals.filter(
      (refusal) =>
        refusal.module.name === module.name &&
        refusal.module.packageName === module.packageName &&
        normalizePathPortable(refusal.module.source) === normalizePathPortable(module.source),
    ),
  )[0];
}

function getHaxeDualBindingRootPackage(packageName: string, rootPackage: string | undefined): string {
  const converted = convertPackageNameToHaxePackageName(packageName, rootPackage);
  return converted.slice(0, converted.lastIndexOf('.'));
}

function getHaxeDualBindingPackageHolderName(packageName: string, rootPackage: string | undefined): string {
  const segment = convertPackageNameToHaxePackageName(packageName, rootPackage).split('.').at(-1)!;
  return getSafeHaxeDualBindingTypeName(segment);
}

function getSafeHaxeDualBindingName(name: string): string {
  const stripped = name.startsWith('#') ? name.slice(1) : name;
  const escaped = [...stripped]
    .map((character, index) =>
      (index === 0 ? /[A-Za-z_]/u : /[A-Za-z0-9_]/u).test(character)
        ? character
        : `_u${character.codePointAt(0)!.toString(16).padStart(4, '0')}_`,
    )
    .join('');
  const identifier = escaped || '_';
  return haxeDualBindingKeywords.has(identifier) ? `${identifier}_` : identifier;
}

function getSafeHaxeDualBindingTypeName(name: string): string {
  const match = /^(?<prefix>_*)(?<name>.*)$/u.exec(name);
  const prefix = match?.groups?.prefix ?? '';
  const value = match?.groups?.name ?? name;
  const pascal = value
    .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
    .split(/[^A-Za-z0-9]+/u)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join('');
  return getSafeHaxeDualBindingName(`${prefix}${pascal}`);
}

function getHaxeDualBindingStableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function cloneAndFreezeHaxeDualBindingPlan(plan: CompilerHaxeDualBindingPlan): CompilerHaxeDualBindingPlan {
  const clone = structuredClone(plan);
  freezeHaxeDualBindingPlanValue(clone, new WeakSet());
  return clone;
}

function freezeHaxeDualBindingPlanValue(value: unknown, seen: WeakSet<object>): void {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  for (const child of Object.values(value)) freezeHaxeDualBindingPlanValue(child, seen);
  Object.freeze(value);
}

const haxeDualBindingKeywords = new Set([
  'abstract',
  'break',
  'case',
  'cast',
  'catch',
  'class',
  'continue',
  'default',
  'do',
  'dynamic',
  'else',
  'enum',
  'extends',
  'extern',
  'false',
  'final',
  'for',
  'function',
  'if',
  'implements',
  'import',
  'in',
  'inline',
  'interface',
  'macro',
  'new',
  'null',
  'operator',
  'overload',
  'override',
  'package',
  'private',
  'public',
  'return',
  'static',
  'super',
  'switch',
  'this',
  'throw',
  'trace',
  'true',
  'try',
  'typedef',
  'untyped',
  'using',
  'var',
  'while',
]);
