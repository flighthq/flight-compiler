import { isDeepStrictEqual } from 'node:util';

import { compareTextCodeUnits, normalizePathPortable } from '../../compiler-canonical-form/src/index.js';
import { analyzeIrModuleTraversal } from '../../compiler-ir-traversal/src/index.js';
import {
  analyzeIrTypeStructuralAssignability,
  createIrTypeParameterSubstitutionPlan,
  isCompilerStructuralTypeSubstitutionFailure,
  resolveIrTypeStructuralSubstitution,
} from '../../compiler-structural/src/index.js';
import type {
  CompilerLoweringPass,
  CompilerModuleIdentity,
  CompilerModuleResolutionPlan,
  CompilerStructuralTypeSubstitutionPlan,
  IrClassDeclaration,
  IrClassMethod,
  IrInterfaceDeclaration,
  IrModule,
  IrObjectTypeProperty,
  IrType,
  IrTypeAliasDeclaration,
  IrTypeBindingIdentity,
  IrTypeReference,
} from '../../compiler-types/src/index.js';
import { createCompilerLoweringFailure } from './compilerLoweringPass.js';

interface InterfaceInheritanceLoweringContext {
  readonly module: InterfaceInheritanceModuleRecord;
  readonly moduleSet: InterfaceInheritanceModuleSet;
  readonly subject: Readonly<IrModule>;
}

interface InterfaceInheritanceDeclarationLocation {
  readonly declaration: Readonly<InterfaceInheritanceStructuralDeclaration>;
  readonly identity: string;
  readonly module: InterfaceInheritanceModuleRecord;
}

interface InterfaceInheritanceModuleRecord {
  readonly declarations: ReadonlyMap<string, InterfaceInheritanceDeclarationLocation>;
  readonly identity: string;
  readonly module: Readonly<IrModule>;
  readonly source: string;
}

type InterfaceInheritanceStructuralDeclaration = IrClassDeclaration | IrInterfaceDeclaration | IrTypeAliasDeclaration;

interface InterfaceInheritanceModuleSet {
  readonly modules: readonly InterfaceInheritanceModuleRecord[];
  readonly resolution: Readonly<CompilerModuleResolutionPlan>;
}

const compilerLoweringPassNameInterfaceInheritance = 'interface-inheritance';

export function createCompilerLoweringPassInterfaceInheritance(
  modules: readonly Readonly<IrModule>[] = [],
  resolution: Readonly<CompilerModuleResolutionPlan> = compilerEmptyModuleResolutionPlan,
): CompilerLoweringPass {
  let moduleRecords: readonly InterfaceInheritanceModuleRecord[] | undefined;
  return {
    idempotent: true,
    lowerIrModule(module) {
      moduleRecords ??= modules.map(createInterfaceInheritanceModuleRecord);
      return lowerIrModuleInterfaceInheritance(module, moduleRecords, resolution);
    },
    name: compilerLoweringPassNameInterfaceInheritance,
    runsAfter: [],
    verifyIrModule(module) {
      let inherited = false;
      analyzeIrModuleTraversal(module, {
        declaration(declaration) {
          if (declaration.kind === 'interface' && declaration.extends.length > 0) inherited = true;
        },
      });
      return inherited
        ? { kind: 'invalid', reason: 'interface inheritance remains after structural flattening' }
        : { kind: 'valid' };
    },
  };
}

function lowerIrModuleInterfaceInheritance(
  module: Readonly<IrModule>,
  moduleRecords: readonly InterfaceInheritanceModuleRecord[],
  resolution: Readonly<CompilerModuleResolutionPlan>,
): IrModule {
  const moduleSet = createInterfaceInheritanceModuleSet(module, moduleRecords, resolution);
  const subject = getInterfaceInheritanceModuleRecord(module, moduleSet);
  if (!subject) throw new TypeError('Interface inheritance subject must belong to the explicit module set');
  const context: InterfaceInheritanceLoweringContext = { module: subject, moduleSet, subject: module };
  return {
    ...module,
    declarations: module.declarations.map((declaration) =>
      declaration.kind === 'interface' ? lowerIrInterfaceDeclarationInheritance(declaration, context) : declaration,
    ),
  };
}

function lowerIrInterfaceDeclarationInheritance(
  declaration: Readonly<IrInterfaceDeclaration>,
  context: InterfaceInheritanceLoweringContext,
): IrInterfaceDeclaration {
  const inherited = declaration.extends.length > 0;
  const properties = getIrInterfaceDeclarationPropertiesFlattened(
    getInterfaceInheritanceDeclarationLocation(declaration, context.module),
    createIrTypeParameterSubstitutionPlan([], []),
    new Set(),
    context,
  );
  return {
    ...declaration,
    extends: [],
    properties: inherited
      ? properties.map((property, index) => rebindIrInterfacePropertyTypeParameters(property, declaration, index))
      : properties,
  };
}

function getIrInterfaceDeclarationPropertiesFlattened(
  location: Readonly<InterfaceInheritanceDeclarationLocation>,
  substitutions: Readonly<CompilerStructuralTypeSubstitutionPlan>,
  ancestors: ReadonlySet<string>,
  context: InterfaceInheritanceLoweringContext,
): readonly IrObjectTypeProperty[] {
  const declaration = location.declaration;
  if (ancestors.has(location.identity)) {
    failIrInterfaceInheritanceLowering(
      context.subject,
      `interface ${declaration.binding.name} has cyclic structural inheritance`,
    );
  }
  const nextAncestors = new Set(ancestors).add(location.identity);
  if (declaration.kind === 'class') {
    return getIrInterfaceHeritageClassPropertiesFlattened(location, nextAncestors, substitutions, context);
  }
  if (declaration.kind === 'typeAlias') {
    return getIrInterfaceHeritageTypePropertiesFlattened(
      resolveIrTypeStructuralSubstitution(declaration.type, substitutions),
      location,
      nextAncestors,
      context,
    );
  }
  const properties: IrObjectTypeProperty[] = [];
  for (const reference of declaration.extends) {
    const utilityProperties = getIrInterfaceUtilityHeritagePropertiesFlattened(
      reference,
      location,
      nextAncestors,
      substitutions,
      context,
    );
    if (utilityProperties) {
      for (const property of utilityProperties) {
        addIrInterfacePropertyFlattened(property, declaration, properties, context);
      }
      continue;
    }
    const base = getIrInterfaceDeclarationBase(reference, location, context);
    const baseSubstitutions = getIrInterfaceTypeSubstitutionPlan(reference, base.declaration, substitutions, context);
    for (const property of getIrInterfaceDeclarationPropertiesFlattened(
      base,
      baseSubstitutions,
      nextAncestors,
      context,
    )) {
      addIrInterfacePropertyFlattened(property, declaration, properties, context);
    }
  }
  for (const property of declaration.properties) {
    addIrInterfacePropertyFlattened(
      { ...property, type: resolveIrTypeStructuralSubstitution(property.type, substitutions) },
      declaration,
      properties,
      context,
      true,
    );
  }
  return properties;
}

function getIrInterfaceUtilityHeritagePropertiesFlattened(
  reference: Readonly<IrTypeReference>,
  location: Readonly<InterfaceInheritanceDeclarationLocation>,
  ancestors: ReadonlySet<string>,
  substitutions: Readonly<CompilerStructuralTypeSubstitutionPlan>,
  context: InterfaceInheritanceLoweringContext,
): readonly IrObjectTypeProperty[] | undefined {
  if (reference.reference.kind !== 'ambient' || reference.reference.name !== 'Partial') return undefined;
  if (reference.typeArguments.length !== 1) {
    return failIrInterfaceInheritanceLowering(
      context.subject,
      `interface ${location.declaration.binding.name} inherits Partial with invalid type argument count`,
    );
  }
  const target = resolveIrTypeStructuralSubstitution(reference.typeArguments[0]!, substitutions);
  return getIrInterfaceHeritageTypePropertiesFlattened(target, location, ancestors, context).map((property) => ({
    ...property,
    optional: true,
  }));
}

function getIrInterfaceHeritageClassPropertiesFlattened(
  location: Readonly<InterfaceInheritanceDeclarationLocation>,
  ancestors: ReadonlySet<string>,
  substitutions: Readonly<CompilerStructuralTypeSubstitutionPlan>,
  context: InterfaceInheritanceLoweringContext,
): readonly IrObjectTypeProperty[] {
  const declaration = location.declaration;
  if (declaration.kind !== 'class') throw new TypeError('Class heritage location must contain a class');
  const properties: IrObjectTypeProperty[] = [];
  if (declaration.extends) {
    const base = getIrInterfaceDeclarationBase(declaration.extends, location, context);
    const baseSubstitutions = getIrInterfaceTypeSubstitutionPlan(
      declaration.extends,
      base.declaration,
      substitutions,
      context,
    );
    for (const property of getIrInterfaceDeclarationPropertiesFlattened(base, baseSubstitutions, ancestors, context)) {
      addIrInterfacePropertyFlattened(property, declaration, properties, context);
    }
  }
  for (const field of declaration.fields) {
    if (field.static) continue;
    if (field.visibility !== 'public' || field.branded) {
      return failIrInterfaceInheritanceLowering(
        context.subject,
        `class ${declaration.binding.name} heritage has nominal field ${field.name}`,
      );
    }
    addIrInterfacePropertyFlattened(
      {
        name: field.name,
        optional: field.optional,
        readonly: field.readonly,
        type: resolveIrTypeStructuralSubstitution(field.type, substitutions),
      },
      declaration,
      properties,
      context,
    );
  }
  for (const method of declaration.methods) {
    if (method.static) continue;
    if (method.visibility !== 'public' || method.branded || method.accessor) {
      return failIrInterfaceInheritanceLowering(
        context.subject,
        `class ${declaration.binding.name} heritage has unsupported method ${method.name}`,
      );
    }
    const signatures = [...method.overloads, method].map((signature) =>
      resolveIrTypeStructuralSubstitution(getIrInterfaceHeritageClassMethodType(signature), substitutions),
    );
    const [first, second, ...rest] = signatures;
    addIrInterfacePropertyFlattened(
      {
        name: method.name,
        optional: false,
        readonly: true,
        type: first && second ? { kind: 'intersection', types: [first, second, ...rest] } : first!,
      },
      declaration,
      properties,
      context,
    );
  }
  return properties;
}

function getIrInterfaceHeritageClassMethodType(
  signature: Readonly<Pick<IrClassMethod, 'parameters' | 'returns' | 'typeParameters'>>,
): Extract<IrType, { kind: 'function' }> {
  return {
    kind: 'function',
    parameters: signature.parameters.map((parameter) => {
      const value = { name: parameter.binding.name, type: parameter.type };
      if (parameter.rest) return { ...value, optional: false, rest: true };
      return parameter.optional
        ? { ...value, optional: true, rest: false }
        : { ...value, optional: false, rest: false };
    }),
    returns: signature.returns,
    typeParameters: signature.typeParameters,
  };
}

function getIrInterfaceHeritageTypePropertiesFlattened(
  type: Readonly<IrType>,
  location: Readonly<InterfaceInheritanceDeclarationLocation>,
  ancestors: ReadonlySet<string>,
  context: InterfaceInheritanceLoweringContext,
): readonly IrObjectTypeProperty[] {
  if (type.kind === 'object') return type.properties;
  if (type.kind === 'named') {
    const base = getIrInterfaceDeclarationBase(type, location, context);
    const substitutions = getIrInterfaceTypeSubstitutionPlan(
      type,
      base.declaration,
      createIrTypeParameterSubstitutionPlan([], []),
      context,
    );
    return getIrInterfaceDeclarationPropertiesFlattened(base, substitutions, ancestors, context);
  }
  if (type.kind === 'intersection') {
    const properties: IrObjectTypeProperty[] = [];
    for (const member of type.types) {
      for (const property of getIrInterfaceHeritageTypePropertiesFlattened(member, location, ancestors, context)) {
        addIrInterfacePropertyFlattened(property, location.declaration, properties, context);
      }
    }
    return properties;
  }
  return failIrInterfaceInheritanceLowering(
    context.subject,
    `heritage type alias ${location.declaration.binding.name} is not object-shaped`,
  );
}

function getIrInterfaceDeclarationBase(
  reference: Readonly<IrTypeReference>,
  location: Readonly<InterfaceInheritanceDeclarationLocation>,
  context: InterfaceInheritanceLoweringContext,
): Readonly<InterfaceInheritanceDeclarationLocation> {
  const declaration = location.declaration;
  if (reference.reference.kind !== 'binding') {
    return failIrInterfaceInheritanceLowering(
      context.subject,
      `interface ${declaration.binding.name} inherits a nonlocal interface that cannot be structurally resolved`,
    );
  }
  const bindingReference = reference.reference;
  if (bindingReference.binding.kind !== 'import') {
    if (bindingReference.path.length > 0) {
      return failIrInterfaceInheritanceLowering(
        context.subject,
        `interface ${declaration.binding.name} inherits a nonlocal interface that cannot be structurally resolved`,
      );
    }
    const base = location.module.declarations.get(bindingReference.binding.id);
    if (base) return base;
    return failIrInterfaceInheritanceLowering(
      context.subject,
      `interface ${declaration.binding.name} inherits unavailable interface ${bindingReference.binding.name}`,
    );
  }
  const imported = location.module.module.imports.flatMap((entry) =>
    entry.bindings
      .filter((candidate) => candidate.binding.id === bindingReference.binding.id)
      .flatMap((candidate) => {
        if (candidate.imported === '*' && bindingReference.path.length === 1) {
          return [{ exportName: bindingReference.path[0]!, specifier: entry.specifier }];
        }
        return bindingReference.path.length === 0 && candidate.imported !== '*'
          ? [{ exportName: candidate.imported, specifier: entry.specifier }]
          : [];
      }),
  );
  const bases = deduplicateInterfaceInheritanceDeclarationLocations(
    imported.flatMap(({ exportName, specifier }) =>
      getInterfaceInheritanceSpecifierModules(location.module, specifier, context.moduleSet).flatMap((module) =>
        getInterfaceInheritanceExportLocations(module, exportName, context.moduleSet, new Set()),
      ),
    ),
  );
  if (bases.length === 1) return bases[0]!;
  if (bases.length > 1) {
    return failIrInterfaceInheritanceLowering(
      context.subject,
      `interface ${declaration.binding.name} inherits ambiguous interface ${bindingReference.binding.name}`,
    );
  }
  return failIrInterfaceInheritanceLowering(
    context.subject,
    `interface ${declaration.binding.name} inherits unavailable interface ${bindingReference.binding.name}`,
  );
}

function getIrInterfaceTypeSubstitutionPlan(
  reference: Readonly<IrTypeReference>,
  declaration: Readonly<InterfaceInheritanceStructuralDeclaration>,
  outerSubstitutions: Readonly<CompilerStructuralTypeSubstitutionPlan>,
  context: InterfaceInheritanceLoweringContext,
): CompilerStructuralTypeSubstitutionPlan {
  try {
    return createIrTypeParameterSubstitutionPlan(
      declaration.typeParameters,
      reference.typeArguments.map((argument) => resolveIrTypeStructuralSubstitution(argument, outerSubstitutions)),
    );
  } catch (error) {
    if (isCompilerStructuralTypeSubstitutionFailure(error)) {
      if (error.code === 'too-many-type-arguments') {
        return failIrInterfaceInheritanceLowering(
          context.subject,
          `interface ${declaration.binding.name} receives too many heritage type arguments`,
        );
      }
      if (error.code === 'missing-type-argument') {
        const index = typeof error.path[1] === 'number' ? error.path[1] : -1;
        const parameter = declaration.typeParameters[index];
        return failIrInterfaceInheritanceLowering(
          context.subject,
          `interface ${declaration.binding.name} requires heritage type argument ${parameter?.binding.name ?? 'unknown'}`,
        );
      }
    }
    throw error;
  }
}

function addIrInterfacePropertyFlattened(
  property: Readonly<IrObjectTypeProperty>,
  declaration: Readonly<InterfaceInheritanceStructuralDeclaration>,
  properties: IrObjectTypeProperty[],
  context: InterfaceInheritanceLoweringContext,
  directOverride = false,
): void {
  const existingIndex = properties.findIndex((candidate) => candidate.name === property.name);
  if (existingIndex < 0) {
    properties.push(property);
    return;
  }
  const existing = properties[existingIndex]!;
  if (
    directOverride &&
    (!property.optional || existing.optional) &&
    analyzeIrTypeStructuralAssignability(property.type, existing.type).status === 'compatible'
  ) {
    properties[existingIndex] = property;
    return;
  }
  if (!isDeepStrictEqual(existing, property)) {
    failIrInterfaceInheritanceLowering(
      context.subject,
      `interface ${declaration.binding.name} inherits incompatible property ${property.name}`,
    );
  }
}

function createInterfaceInheritanceModuleSet(
  subject: Readonly<IrModule>,
  moduleRecords: readonly InterfaceInheritanceModuleRecord[],
  resolution: Readonly<CompilerModuleResolutionPlan>,
): InterfaceInheritanceModuleSet {
  const subjectIdentity = getInterfaceInheritanceModuleIdentity(subject);
  const records = [
    ...moduleRecords.filter((record) => record.identity !== subjectIdentity),
    moduleRecords.find((record) => record.module === subject) ?? createInterfaceInheritanceModuleRecord(subject),
  ];
  records.sort(compareInterfaceInheritanceRecords);
  if (records.some((record, index) => index > 0 && record.identity === records[index - 1]!.identity)) {
    throw new TypeError('Interface inheritance module set contains a duplicate module identity');
  }
  return { modules: records, resolution };
}

function createInterfaceInheritanceModuleRecord(module: Readonly<IrModule>): InterfaceInheritanceModuleRecord {
  const identity = getInterfaceInheritanceModuleIdentity(module);
  const record: { declarations: Map<string, InterfaceInheritanceDeclarationLocation> } & Omit<
    InterfaceInheritanceModuleRecord,
    'declarations'
  > = {
    declarations: new Map(),
    identity,
    module,
    source: normalizePathPortable(module.source),
  };
  for (const declaration of module.declarations) {
    if (declaration.kind !== 'class' && declaration.kind !== 'interface' && declaration.kind !== 'typeAlias') continue;
    if (record.declarations.has(declaration.binding.id)) {
      throw new TypeError('Interface inheritance module contains a duplicate structural declaration identity');
    }
    record.declarations.set(declaration.binding.id, {
      declaration,
      identity: `${identity}\0${declaration.binding.id}`,
      module: record,
    });
  }
  return record;
}

function getInterfaceInheritanceModuleRecord(
  module: Readonly<IrModule>,
  moduleSet: Readonly<InterfaceInheritanceModuleSet>,
): InterfaceInheritanceModuleRecord | undefined {
  const identity = getInterfaceInheritanceModuleIdentity(module);
  return moduleSet.modules.find((candidate) => candidate.identity === identity);
}

function getInterfaceInheritanceDeclarationLocation(
  declaration: Readonly<IrInterfaceDeclaration>,
  module: Readonly<InterfaceInheritanceModuleRecord>,
): InterfaceInheritanceDeclarationLocation {
  const location = module.declarations.get(declaration.binding.id);
  if (!location || location.declaration.kind !== 'interface') {
    throw new TypeError('Interface declaration must belong to its lowering module');
  }
  return location;
}

function getInterfaceInheritanceExportLocations(
  module: Readonly<InterfaceInheritanceModuleRecord>,
  exportName: string,
  moduleSet: Readonly<InterfaceInheritanceModuleSet>,
  seen: ReadonlySet<string>,
): readonly InterfaceInheritanceDeclarationLocation[] {
  const query = `${module.identity}\0${exportName}`;
  if (seen.has(query)) return [];
  const nextSeen = new Set(seen).add(query);
  const locations = [...module.declarations.values()].filter(
    (location) => location.declaration.exported && location.declaration.binding.name === exportName,
  );
  for (const exported of module.module.exports) {
    if (exported.kind === 'local' && exported.exported === exportName) {
      const location = module.declarations.get(exported.binding.id);
      if (location) locations.push(location);
    }
    if (exported.kind === 'reexport' && exported.exported === exportName) {
      for (const target of getInterfaceInheritanceSpecifierModules(module, exported.specifier, moduleSet)) {
        locations.push(...getInterfaceInheritanceExportLocations(target, exported.imported, moduleSet, nextSeen));
      }
    }
    if (exported.kind === 'all' && exportName !== 'default') {
      for (const target of getInterfaceInheritanceSpecifierModules(module, exported.specifier, moduleSet)) {
        locations.push(...getInterfaceInheritanceExportLocations(target, exportName, moduleSet, nextSeen));
      }
    }
  }
  return deduplicateInterfaceInheritanceDeclarationLocations(locations);
}

function getInterfaceInheritanceSpecifierModules(
  from: Readonly<InterfaceInheritanceModuleRecord>,
  specifier: string,
  moduleSet: Readonly<InterfaceInheritanceModuleSet>,
): readonly InterfaceInheritanceModuleRecord[] {
  const candidates = getInterfaceInheritanceSpecifierSourceCandidates(from.source, specifier);
  const matching = moduleSet.resolution.edges.filter((edge) => edge.specifier === specifier);
  const exact = matching.filter(
    (edge) => edge.importer && getInterfaceInheritanceModuleIdentity(edge.importer) === from.identity,
  );
  const resolutionTargets = (exact.length > 0 ? exact : matching.filter((edge) => !edge.importer)).map(
    (edge) => `${edge.target.packageName}\0${normalizePathPortable(edge.target.source)}`,
  );
  return moduleSet.modules.filter(
    (candidate) =>
      (candidate.module.packageName === from.module.packageName && candidates.has(candidate.source)) ||
      resolutionTargets.includes(`${candidate.module.packageName}\0${candidate.source}`),
  );
}

function getInterfaceInheritanceSpecifierSourceCandidates(source: string, specifier: string): ReadonlySet<string> {
  const normalized = normalizePathPortable(specifier);
  if (normalized !== '.' && normalized !== '..' && !normalized.startsWith('./') && !normalized.startsWith('../')) {
    return new Set();
  }
  const parts = source.split('/');
  parts.pop();
  for (const part of normalized.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (parts.length === 0) return new Set();
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  const resolved = parts.join('/');
  const candidates = new Set([resolved]);
  for (const [emitted, sourceExtension] of [
    ['.cjs', '.cts'],
    ['.js', '.ts'],
    ['.jsx', '.tsx'],
    ['.mjs', '.mts'],
  ] as const) {
    if (resolved.endsWith(emitted)) candidates.add(`${resolved.slice(0, -emitted.length)}${sourceExtension}`);
  }
  if (!/\.[^/]+$/u.test(resolved)) {
    candidates.add(`${resolved}.ts`);
    candidates.add(`${resolved}/index.ts`);
  }
  return candidates;
}

function deduplicateInterfaceInheritanceDeclarationLocations(
  locations: readonly InterfaceInheritanceDeclarationLocation[],
): InterfaceInheritanceDeclarationLocation[] {
  return [...new Map(locations.map((location) => [location.identity, location])).values()].sort((left, right) =>
    compareTextCodeUnits(left.identity, right.identity),
  );
}

function compareInterfaceInheritanceRecords(
  left: Readonly<InterfaceInheritanceModuleRecord>,
  right: Readonly<InterfaceInheritanceModuleRecord>,
): number {
  return compareTextCodeUnits(left.identity, right.identity);
}

function getInterfaceInheritanceModuleIdentity(identity: Readonly<CompilerModuleIdentity>): string {
  return `${identity.packageName}\0${normalizePathPortable(identity.source)}\0${identity.name}`;
}

function rebindIrInterfacePropertyTypeParameters(
  property: Readonly<IrObjectTypeProperty>,
  declaration: Readonly<IrInterfaceDeclaration>,
  propertyIndex: number,
): IrObjectTypeProperty {
  return {
    ...property,
    type: rebindIrTypeInterfaceInheritance(
      property.type,
      declaration,
      `properties[${String(propertyIndex)}].type`,
      new Map(),
    ),
  };
}

function rebindIrTypeInterfaceInheritance(
  type: Readonly<IrType>,
  declaration: Readonly<IrInterfaceDeclaration>,
  path: string,
  bindings: ReadonlyMap<string, Readonly<IrTypeBindingIdentity>>,
): IrType {
  switch (type.kind) {
    case 'array':
      return {
        ...type,
        element: rebindIrTypeInterfaceInheritance(type.element, declaration, `${path}.element`, bindings),
      };
    case 'function': {
      const nestedBindings = new Map(bindings);
      const typeParameters = type.typeParameters.map((parameter, index) => {
        const binding = {
          ...parameter.binding,
          id: `${parameter.binding.id}:interface-inheritance:${JSON.stringify([declaration.binding.id, path, index])}`,
        };
        nestedBindings.set(parameter.binding.id, binding);
        return { ...parameter, binding };
      });
      return {
        ...type,
        parameters: type.parameters.map((parameter, index) => ({
          ...parameter,
          type: rebindIrTypeInterfaceInheritance(
            parameter.type,
            declaration,
            `${path}.parameters[${String(index)}].type`,
            nestedBindings,
          ),
        })),
        returns: rebindIrTypeInterfaceInheritance(type.returns, declaration, `${path}.returns`, nestedBindings),
        typeParameters: typeParameters.map((parameter, index) => ({
          ...parameter,
          ...(parameter.constraint
            ? {
                constraint: rebindIrTypeInterfaceInheritance(
                  parameter.constraint,
                  declaration,
                  `${path}.typeParameters[${String(index)}].constraint`,
                  nestedBindings,
                ),
              }
            : {}),
          ...(parameter.default
            ? {
                default: rebindIrTypeInterfaceInheritance(
                  parameter.default,
                  declaration,
                  `${path}.typeParameters[${String(index)}].default`,
                  nestedBindings,
                ),
              }
            : {}),
        })),
      };
    }
    case 'indexedAccess':
      return {
        ...type,
        index: rebindIrTypeInterfaceInheritance(type.index, declaration, `${path}.index`, bindings),
        object: rebindIrTypeInterfaceInheritance(type.object, declaration, `${path}.object`, bindings),
      };
    case 'intersection': {
      const types = type.types.map((member, index) =>
        rebindIrTypeInterfaceInheritance(member, declaration, `${path}.types[${String(index)}]`, bindings),
      );
      return { ...type, types: [types[0]!, types[1]!, ...types.slice(2)] };
    }
    case 'keyof':
      return {
        ...type,
        type: rebindIrTypeInterfaceInheritance(type.type, declaration, `${path}.type`, bindings),
      };
    case 'named': {
      const binding = type.reference.kind === 'binding' ? bindings.get(type.reference.binding.id) : undefined;
      const reference = type.reference.kind === 'binding' && binding ? { ...type.reference, binding } : type.reference;
      return {
        ...type,
        reference,
        typeArguments: type.typeArguments.map((argument, index) =>
          rebindIrTypeInterfaceInheritance(argument, declaration, `${path}.typeArguments[${String(index)}]`, bindings),
        ),
      };
    }
    case 'object':
      return {
        ...type,
        properties: type.properties.map((property, index) => ({
          ...property,
          type: rebindIrTypeInterfaceInheritance(
            property.type,
            declaration,
            `${path}.properties[${String(index)}].type`,
            bindings,
          ),
        })),
      };
    case 'tuple':
      return {
        ...type,
        elements: type.elements.map((element, index) => ({
          ...element,
          type: rebindIrTypeInterfaceInheritance(
            element.type,
            declaration,
            `${path}.elements[${String(index)}].type`,
            bindings,
          ),
        })),
      };
    case 'union': {
      const types = type.types.map((member, index) =>
        rebindIrTypeInterfaceInheritance(member, declaration, `${path}.types[${String(index)}]`, bindings),
      );
      return { ...type, types: [types[0]!, types[1]!, ...types.slice(2)] };
    }
    case 'literal':
    case 'never':
    case 'null':
    case 'primitive':
    case 'typeOf':
    case 'undefined':
    case 'unknown':
      return type;
  }
}

function failIrInterfaceInheritanceLowering(module: Readonly<IrModule>, message: string): never {
  throw createCompilerLoweringFailure('unsupported-ir', compilerLoweringPassNameInterfaceInheritance, module, message);
}

const compilerEmptyModuleResolutionPlan: CompilerModuleResolutionPlan = Object.freeze({
  edges: Object.freeze([]),
  schema: 'flight-compiler-module-resolution/1',
});
