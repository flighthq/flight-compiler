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
  IrBindingIdentity,
  IrInterfaceDeclaration,
  IrImport,
  IrModule,
  IrObjectTypeProperty,
  IrType,
  IrTypeAliasDeclaration,
  IrTypeBindingIdentity,
  IrTypeNameReference,
  IrTypeReference,
  IrVariableDeclaration,
} from '../../compiler-types/src/index.js';
import { createCompilerLoweringFailure } from './compilerLoweringPass.js';

interface InterfaceInheritanceLoweringContext {
  readonly importedTypeBindings: Map<string, IrTypeBindingIdentity>;
  readonly imports: IrImport[];
  readonly module: InterfaceInheritanceModuleRecord;
  readonly moduleSet: InterfaceInheritanceModuleSet;
  readonly options: Readonly<CompilerInterfaceInheritanceLoweringOptions>;
  readonly subject: Readonly<IrModule>;
}

export interface CompilerInterfaceInheritanceLoweringOptions {
  readonly eraseAmbientUtilityHeritage?:
    | ((reference: Readonly<IrTypeReference>, declaration: Readonly<IrInterfaceDeclaration>) => boolean)
    | undefined;
}

interface InterfaceInheritanceTypeImport {
  readonly imported: string;
  readonly path: readonly string[];
  readonly target: InterfaceInheritanceModuleRecord;
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
  resolution: Readonly<CompilerModuleResolutionPlan> | undefined = compilerEmptyModuleResolutionPlan,
  options: Readonly<CompilerInterfaceInheritanceLoweringOptions> = {},
): CompilerLoweringPass {
  let moduleRecords: readonly InterfaceInheritanceModuleRecord[] | undefined;
  return {
    idempotent: true,
    lowerIrModule(module) {
      moduleRecords ??= createInterfaceInheritanceModuleRecords(modules);
      return lowerIrModuleInterfaceInheritance(
        module,
        moduleRecords,
        resolution ?? compilerEmptyModuleResolutionPlan,
        options,
      );
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

function createInterfaceInheritanceModuleRecords(
  modules: readonly Readonly<IrModule>[],
): readonly InterfaceInheritanceModuleRecord[] {
  const records = modules.map(createInterfaceInheritanceModuleRecord).sort(compareInterfaceInheritanceRecords);
  if (records.some((record, index) => index > 0 && record.identity === records[index - 1]!.identity)) {
    throw new TypeError('Interface inheritance module set contains a duplicate module identity');
  }
  return records;
}

function lowerIrModuleInterfaceInheritance(
  module: Readonly<IrModule>,
  moduleRecords: readonly InterfaceInheritanceModuleRecord[],
  resolution: Readonly<CompilerModuleResolutionPlan>,
  options: Readonly<CompilerInterfaceInheritanceLoweringOptions>,
): IrModule {
  const moduleSet = createInterfaceInheritanceModuleSet(module, moduleRecords, resolution);
  const subject = getInterfaceInheritanceModuleRecord(module, moduleSet);
  if (!subject) throw new TypeError('Interface inheritance subject must belong to the explicit module set');
  const context: InterfaceInheritanceLoweringContext = {
    importedTypeBindings: new Map(),
    imports: module.imports.map((imported) => ({ ...imported, bindings: [...imported.bindings] })),
    module: subject,
    moduleSet,
    options,
    subject: module,
  };
  return {
    ...module,
    declarations: module.declarations.map((declaration) =>
      declaration.kind === 'interface' ? lowerIrInterfaceDeclarationInheritance(declaration, context) : declaration,
    ),
    imports: context.imports,
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
      ? properties.map((property, index) =>
          rebindIrInterfacePropertyTypeParameters(property, declaration, index, context),
        )
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
  if (
    location.declaration.kind === 'interface' &&
    context.options.eraseAmbientUtilityHeritage?.(reference, location.declaration)
  ) {
    return [];
  }
  if (reference.reference.kind !== 'ambient') return undefined;
  const utility = reference.reference.name;
  if (!['Omit', 'Partial', 'Pick', 'Readonly', 'Required'].includes(utility)) return undefined;
  const expectedArguments = utility === 'Omit' || utility === 'Pick' ? 2 : 1;
  if (reference.typeArguments.length !== expectedArguments) {
    return failIrInterfaceInheritanceLowering(
      context.subject,
      `interface ${location.declaration.binding.name} inherits ${utility} with invalid type argument count`,
    );
  }
  const target = resolveIrTypeStructuralSubstitution(reference.typeArguments[0]!, substitutions);
  const properties = getIrInterfaceHeritageTypePropertiesFlattened(target, location, ancestors, context);
  if (utility === 'Partial') return properties.map((property) => ({ ...property, optional: true }));
  if (utility === 'Readonly') return properties.map((property) => ({ ...property, readonly: true }));
  if (utility === 'Required') return properties.map((property) => ({ ...property, optional: false }));
  const keys = getIrInterfaceUtilityHeritageKeys(
    resolveIrTypeStructuralSubstitution(reference.typeArguments[1]!, substitutions),
    location,
    context,
  );
  return properties.filter((property) => (utility === 'Pick') === keys.has(property.name));
}

function getIrInterfaceUtilityHeritageKeys(
  type: Readonly<IrType>,
  location: Readonly<InterfaceInheritanceDeclarationLocation>,
  context: InterfaceInheritanceLoweringContext,
): ReadonlySet<string> {
  const resolved = resolveIrTypeInterfaceInheritance(type, location.module, context, new Set());
  const members = resolved.kind === 'union' ? resolved.types : [resolved];
  const keys = new Set<string>();
  for (const member of members) {
    if (member.kind === 'never') continue;
    if (member.kind !== 'literal' || typeof member.value !== 'string') {
      return failIrInterfaceInheritanceLowering(
        context.subject,
        `interface ${location.declaration.binding.name} inherits utility with nonliteral property keys`,
      );
    }
    keys.add(member.value);
  }
  return keys;
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
  return getIrInterfaceDeclarationBaseFromModule(
    reference,
    location.module,
    location.declaration.binding.name,
    context,
  );
}

function getIrInterfaceDeclarationBaseFromModule(
  reference: Readonly<IrTypeReference>,
  module: Readonly<InterfaceInheritanceModuleRecord>,
  subjectName: string,
  context: InterfaceInheritanceLoweringContext,
): Readonly<InterfaceInheritanceDeclarationLocation> {
  if (reference.reference.kind !== 'binding') {
    return failIrInterfaceInheritanceLowering(
      context.subject,
      `interface ${subjectName} inherits a nonlocal interface that cannot be structurally resolved`,
    );
  }
  const bindingReference = reference.reference;
  if (bindingReference.binding.kind !== 'import') {
    if (bindingReference.path.length > 0) {
      return failIrInterfaceInheritanceLowering(
        context.subject,
        `interface ${subjectName} inherits a nonlocal interface that cannot be structurally resolved`,
      );
    }
    const base = module.declarations.get(bindingReference.binding.id);
    if (base) return base;
    return failIrInterfaceInheritanceLowering(
      context.subject,
      `interface ${subjectName} inherits unavailable interface ${bindingReference.binding.name}`,
    );
  }
  const imported = module.module.imports.flatMap((entry) =>
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
      getInterfaceInheritanceSpecifierModules(module, specifier, context.moduleSet).flatMap((target) =>
        getInterfaceInheritanceExportLocations(target, exportName, context.moduleSet, new Set()),
      ),
    ),
  );
  if (bases.length === 1) return bases[0]!;
  if (bases.length > 1) {
    return failIrInterfaceInheritanceLowering(
      context.subject,
      `interface ${subjectName} inherits ambiguous interface ${bindingReference.binding.name}`,
    );
  }
  return failIrInterfaceInheritanceLowering(
    context.subject,
    `interface ${subjectName} inherits unavailable interface ${bindingReference.binding.name}`,
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
  const propertyType = resolveIrTypeInterfaceInheritance(property.type, context.module, context, new Set());
  const existingType = resolveIrTypeInterfaceInheritance(existing.type, context.module, context, new Set());
  const propertyToExisting = analyzeIrTypeStructuralAssignability(
    removeIrObjectPropertyReadonlyInterfaceInheritance(propertyType),
    removeIrObjectPropertyReadonlyInterfaceInheritance(existingType),
  );
  if (
    (!property.optional || existing.optional) &&
    (propertyToExisting.status === 'compatible' ||
      (directOverride && propertyToExisting.status === 'indeterminate') ||
      (directOverride && isIrInterfaceMethodOverrideCompatible(propertyType, existingType)))
  ) {
    properties[existingIndex] = property;
    return;
  }
  const existingToProperty = analyzeIrTypeStructuralAssignability(
    removeIrObjectPropertyReadonlyInterfaceInheritance(existingType),
    removeIrObjectPropertyReadonlyInterfaceInheritance(propertyType),
  );
  if ((!existing.optional || property.optional) && existingToProperty.status === 'compatible') {
    return;
  }
  if (!isDeepStrictEqual(existing, property)) {
    const diagnostic = propertyToExisting.diagnostics[0] ?? existingToProperty.diagnostics[0];
    const detail = diagnostic ? ` (${diagnostic.code} at ${diagnostic.path.map(String).join('.') || 'type'})` : '';
    failIrInterfaceInheritanceLowering(
      context.subject,
      `interface ${declaration.binding.name} inherits incompatible property ${property.name}${detail}`,
    );
  }
}

function removeIrObjectPropertyReadonlyInterfaceInheritance(type: Readonly<IrType>): IrType {
  switch (type.kind) {
    case 'array':
      return { ...type, element: removeIrObjectPropertyReadonlyInterfaceInheritance(type.element) };
    case 'function':
      return {
        ...type,
        parameters: type.parameters.map((parameter) => ({
          ...parameter,
          type: removeIrObjectPropertyReadonlyInterfaceInheritance(parameter.type),
        })),
        returns: removeIrObjectPropertyReadonlyInterfaceInheritance(type.returns),
      };
    case 'indexedAccess':
      return {
        ...type,
        index: removeIrObjectPropertyReadonlyInterfaceInheritance(type.index),
        object: removeIrObjectPropertyReadonlyInterfaceInheritance(type.object),
      };
    case 'intersection': {
      const types = type.types.map(removeIrObjectPropertyReadonlyInterfaceInheritance);
      return { ...type, types: [types[0]!, types[1]!, ...types.slice(2)] };
    }
    case 'keyof':
      return { ...type, type: removeIrObjectPropertyReadonlyInterfaceInheritance(type.type) };
    case 'named':
      return {
        ...type,
        typeArguments: type.typeArguments.map(removeIrObjectPropertyReadonlyInterfaceInheritance),
      };
    case 'object':
      return {
        ...type,
        properties: type.properties.map((property) => ({
          ...property,
          readonly: false,
          type: removeIrObjectPropertyReadonlyInterfaceInheritance(property.type),
        })),
      };
    case 'tuple':
      return {
        ...type,
        elements: type.elements.map((element) => ({
          ...element,
          type: removeIrObjectPropertyReadonlyInterfaceInheritance(element.type),
        })),
      };
    case 'union': {
      const types = type.types.map(removeIrObjectPropertyReadonlyInterfaceInheritance);
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

function isIrInterfaceMethodOverrideCompatible(source: Readonly<IrType>, target: Readonly<IrType>): boolean {
  if (source.kind !== 'function' || target.kind !== 'function') return false;
  if (source.typeParameters.length !== target.typeParameters.length) return false;
  const sourceRequired = source.parameters.filter((parameter) => !parameter.optional && !parameter.rest).length;
  const targetRequired = target.parameters.filter((parameter) => !parameter.optional && !parameter.rest).length;
  if (sourceRequired !== targetRequired) return false;
  return analyzeIrTypeStructuralAssignability(source.returns, target.returns).status !== 'incompatible';
}

function resolveIrTypeInterfaceInheritance(
  type: Readonly<IrType>,
  module: Readonly<InterfaceInheritanceModuleRecord>,
  context: InterfaceInheritanceLoweringContext,
  declarations: ReadonlySet<string>,
  expandStructures = true,
): IrType {
  switch (type.kind) {
    case 'array':
      return {
        ...type,
        element: resolveIrTypeInterfaceInheritance(type.element, module, context, declarations, expandStructures),
      };
    case 'function':
      return {
        ...type,
        parameters: type.parameters.map((parameter) => ({
          ...parameter,
          type: resolveIrTypeInterfaceInheritance(parameter.type, module, context, declarations, expandStructures),
        })),
        returns: resolveIrTypeInterfaceInheritance(type.returns, module, context, declarations, expandStructures),
      };
    case 'indexedAccess':
      return {
        ...type,
        index: resolveIrTypeInterfaceInheritance(type.index, module, context, declarations, expandStructures),
        object: resolveIrTypeInterfaceInheritance(type.object, module, context, declarations, expandStructures),
      };
    case 'intersection': {
      const types = type.types.map((member) =>
        resolveIrTypeInterfaceInheritance(member, module, context, declarations, expandStructures),
      );
      return { ...type, types: [types[0]!, types[1]!, ...types.slice(2)] };
    }
    case 'keyof':
      return {
        ...type,
        type: resolveIrTypeInterfaceInheritance(type.type, module, context, declarations, expandStructures),
      };
    case 'named': {
      const location = getInterfaceInheritanceTypeDeclaration(type, module, context);
      if (!location && type.reference.kind === 'binding' && type.reference.binding.space === 'value') {
        const declaration = getInterfaceInheritanceValueDeclaration(type.reference, module, context);
        if (
          declaration?.declarationKind === 'const' &&
          declaration.initializer?.kind === 'literal' &&
          declaration.initializer.value !== null
        ) {
          return { kind: 'literal', value: declaration.initializer.value };
        }
      }
      if (!location || declarations.has(location.identity)) {
        return {
          ...type,
          typeArguments: type.typeArguments.map((argument) =>
            resolveIrTypeInterfaceInheritance(argument, module, context, declarations, expandStructures),
          ),
        };
      }
      const substitutions = getIrInterfaceTypeSubstitutionPlan(
        type,
        location.declaration,
        createIrTypeParameterSubstitutionPlan([], []),
        context,
      );
      const nextDeclarations = new Set(declarations).add(location.identity);
      if (location.declaration.kind === 'typeAlias') {
        return resolveIrTypeInterfaceInheritance(
          resolveIrTypeStructuralSubstitution(location.declaration.type, substitutions),
          location.module,
          context,
          nextDeclarations,
          expandStructures,
        );
      }
      if (!expandStructures) {
        return {
          ...type,
          reference: { binding: location.declaration.binding, kind: 'binding', path: [] },
          typeArguments: type.typeArguments.map((argument) =>
            resolveIrTypeInterfaceInheritance(argument, module, context, declarations, false),
          ),
        };
      }
      return {
        kind: 'object',
        properties: getIrInterfaceDeclarationPropertiesFlattened(location, substitutions, new Set(), context).map(
          (property) => ({
            ...property,
            type: resolveIrTypeInterfaceInheritance(property.type, location.module, context, nextDeclarations, false),
          }),
        ),
      };
    }
    case 'object':
      return {
        ...type,
        properties: type.properties.map((property) => ({
          ...property,
          type: resolveIrTypeInterfaceInheritance(property.type, module, context, declarations, expandStructures),
        })),
      };
    case 'tuple':
      return {
        ...type,
        elements: type.elements.map((element) => ({
          ...element,
          type: resolveIrTypeInterfaceInheritance(element.type, module, context, declarations, expandStructures),
        })),
      };
    case 'union': {
      const types = type.types.map((member) =>
        resolveIrTypeInterfaceInheritance(member, module, context, declarations, expandStructures),
      );
      return { ...type, types: [types[0]!, types[1]!, ...types.slice(2)] };
    }
    case 'literal':
    case 'never':
    case 'null':
    case 'primitive':
      return type;
    case 'typeOf': {
      const declaration = getInterfaceInheritanceValueDeclaration(type.reference, module, context);
      return declaration?.declarationKind === 'const' &&
        declaration.initializer?.kind === 'literal' &&
        declaration.initializer.value !== null
        ? { kind: 'literal', value: declaration.initializer.value }
        : type;
    }
    case 'undefined':
    case 'unknown':
      return type;
  }
}

function getInterfaceInheritanceTypeDeclaration(
  type: Readonly<IrTypeReference>,
  module: Readonly<InterfaceInheritanceModuleRecord>,
  context: InterfaceInheritanceLoweringContext,
): InterfaceInheritanceDeclarationLocation | undefined {
  if (type.reference.kind !== 'binding') return undefined;
  const reference = type.reference;
  const origin = getInterfaceInheritanceBindingModule(reference.binding, context) ?? module;
  const declaration = origin.declarations.get(reference.binding.id);
  if (declaration) return declaration;
  if (reference.binding.space === 'value') {
    const declarations = [...origin.declarations.values()].filter(
      (candidate) => candidate.declaration.binding.name === reference.binding.name,
    );
    if (declarations.length === 1) return declarations[0];
  }
  if (
    origin.module.imports.some((imported) =>
      imported.bindings.some(({ binding }) => binding.id === reference.binding.id),
    )
  ) {
    const imported = origin.module.imports.flatMap((entry) =>
      entry.bindings
        .filter((candidate) => candidate.binding.id === reference.binding.id)
        .flatMap((candidate) => {
          if (candidate.imported === '*' && reference.path.length === 1) {
            return [{ exportName: reference.path[0]!, specifier: entry.specifier }];
          }
          return reference.path.length === 0 && candidate.imported !== '*'
            ? [{ exportName: candidate.imported, specifier: entry.specifier }]
            : [];
        }),
    );
    const locations = deduplicateInterfaceInheritanceDeclarationLocations(
      imported.flatMap(({ exportName, specifier }) =>
        getInterfaceInheritanceSpecifierModules(origin, specifier, context.moduleSet).flatMap((target) =>
          getInterfaceInheritanceExportLocations(target, exportName, context.moduleSet, new Set()),
        ),
      ),
    );
    return locations.length === 1 ? locations[0] : undefined;
  }
  return undefined;
}

function getInterfaceInheritanceValueDeclaration(
  reference: Readonly<IrTypeNameReference | Extract<IrType, { kind: 'typeOf' }>['reference']>,
  module: Readonly<InterfaceInheritanceModuleRecord>,
  context: InterfaceInheritanceLoweringContext,
): Readonly<IrVariableDeclaration & { readonly binding: IrBindingIdentity }> | undefined {
  const origins =
    reference.kind === 'binding'
      ? [getInterfaceInheritanceBindingModule(reference.binding, context) ?? module]
      : context.moduleSet.modules;
  const declarations = new Map<string, IrVariableDeclaration & { readonly binding: IrBindingIdentity }>();
  for (const origin of origins) {
    const local = origin.module.declarations.find(
      (declaration): declaration is IrVariableDeclaration & { readonly binding: IrBindingIdentity } =>
        declaration.kind === 'variable' &&
        'binding' in declaration &&
        (reference.kind === 'binding'
          ? declaration.binding.id === reference.binding.id
          : declaration.binding.name === reference.name),
    );
    if (local) declarations.set(`${origin.identity}\0${local.binding.id}`, local);
    for (const imported of origin.module.imports) {
      const candidate = imported.bindings.find(({ binding }) =>
        reference.kind === 'binding' ? binding.id === reference.binding.id : binding.name === reference.name,
      );
      if (!candidate) continue;
      const exportName =
        candidate.imported === '*' && reference.kind === 'binding' ? reference.path[0] : candidate.imported;
      if (!exportName) continue;
      for (const target of getInterfaceInheritanceSpecifierModules(origin, imported.specifier, context.moduleSet)) {
        const declaration = target.module.declarations.find(
          (item): item is IrVariableDeclaration & { readonly binding: IrBindingIdentity } => {
            if (item.kind !== 'variable' || !('binding' in item)) return false;
            return (
              (item.exported && item.binding.name === exportName) ||
              target.module.exports.some(
                (exported) =>
                  exported.kind === 'local' &&
                  exported.exported === exportName &&
                  exported.binding.id === item.binding.id,
              )
            );
          },
        );
        if (declaration) declarations.set(`${target.identity}\0${declaration.binding.id}`, declaration);
      }
    }
  }
  return declarations.size === 1 ? declarations.values().next().value : undefined;
}

function getInterfaceInheritanceBindingModule(
  binding: Readonly<IrBindingIdentity | IrTypeBindingIdentity>,
  context: InterfaceInheritanceLoweringContext,
): InterfaceInheritanceModuleRecord | undefined {
  const source = normalizePathPortable(binding.source);
  return context.moduleSet.modules.find(
    (module) => module.module.packageName === binding.packageName && module.source === source,
  );
}

function createInterfaceInheritanceModuleSet(
  subject: Readonly<IrModule>,
  moduleRecords: readonly InterfaceInheritanceModuleRecord[],
  resolution: Readonly<CompilerModuleResolutionPlan>,
): InterfaceInheritanceModuleSet {
  const subjectIdentity = getInterfaceInheritanceModuleIdentity(subject);
  const existingIndex = moduleRecords.findIndex((record) => record.identity === subjectIdentity);
  if (existingIndex >= 0 && moduleRecords[existingIndex]!.module === subject) {
    return { modules: moduleRecords, resolution };
  }
  const subjectRecord = createInterfaceInheritanceModuleRecord(subject);
  const records = [...moduleRecords];
  if (existingIndex >= 0) records[existingIndex] = subjectRecord;
  else {
    records.push(subjectRecord);
    records.sort(compareInterfaceInheritanceRecords);
  }
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
  context: InterfaceInheritanceLoweringContext,
): IrObjectTypeProperty {
  return {
    ...property,
    type: rebindIrTypeInterfaceInheritance(
      property.type,
      declaration,
      `properties[${String(propertyIndex)}].type`,
      new Map(),
      context,
    ),
  };
}

function rebindIrTypeInterfaceInheritance(
  type: Readonly<IrType>,
  declaration: Readonly<IrInterfaceDeclaration>,
  path: string,
  bindings: ReadonlyMap<string, Readonly<IrTypeBindingIdentity>>,
  context: InterfaceInheritanceLoweringContext,
): IrType {
  switch (type.kind) {
    case 'array':
      return {
        ...type,
        element: rebindIrTypeInterfaceInheritance(type.element, declaration, `${path}.element`, bindings, context),
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
            context,
          ),
        })),
        returns: rebindIrTypeInterfaceInheritance(
          type.returns,
          declaration,
          `${path}.returns`,
          nestedBindings,
          context,
        ),
        typeParameters: typeParameters.map((parameter, index) => ({
          ...parameter,
          ...(parameter.constraint
            ? {
                constraint: rebindIrTypeInterfaceInheritance(
                  parameter.constraint,
                  declaration,
                  `${path}.typeParameters[${String(index)}].constraint`,
                  nestedBindings,
                  context,
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
                  context,
                ),
              }
            : {}),
        })),
      };
    }
    case 'indexedAccess':
      return {
        ...type,
        index: rebindIrTypeInterfaceInheritance(type.index, declaration, `${path}.index`, bindings, context),
        object: rebindIrTypeInterfaceInheritance(type.object, declaration, `${path}.object`, bindings, context),
      };
    case 'intersection': {
      const types = type.types.map((member, index) =>
        rebindIrTypeInterfaceInheritance(member, declaration, `${path}.types[${String(index)}]`, bindings, context),
      );
      return { ...type, types: [types[0]!, types[1]!, ...types.slice(2)] };
    }
    case 'keyof':
      return {
        ...type,
        type: rebindIrTypeInterfaceInheritance(type.type, declaration, `${path}.type`, bindings, context),
      };
    case 'named': {
      const binding = type.reference.kind === 'binding' ? bindings.get(type.reference.binding.id) : undefined;
      const reference =
        type.reference.kind === 'binding' && binding
          ? { ...type.reference, binding }
          : rebindIrInterfaceInheritedTypeReference(type.reference, declaration, context);
      return {
        ...type,
        reference,
        typeArguments: type.typeArguments.map((argument, index) =>
          rebindIrTypeInterfaceInheritance(
            argument,
            declaration,
            `${path}.typeArguments[${String(index)}]`,
            bindings,
            context,
          ),
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
            context,
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
            context,
          ),
        })),
      };
    case 'union': {
      const types = type.types.map((member, index) =>
        rebindIrTypeInterfaceInheritance(member, declaration, `${path}.types[${String(index)}]`, bindings, context),
      );
      return { ...type, types: [types[0]!, types[1]!, ...types.slice(2)] };
    }
    case 'literal':
    case 'never':
    case 'null':
    case 'primitive':
    case 'undefined':
    case 'unknown':
      return type;
    case 'typeOf':
      return resolveIrTypeInterfaceInheritance(type, context.module, context, new Set());
  }
}

function rebindIrInterfaceInheritedTypeReference(
  reference: Readonly<IrTypeNameReference>,
  declaration: Readonly<IrInterfaceDeclaration>,
  context: InterfaceInheritanceLoweringContext,
): IrTypeNameReference {
  if (
    reference.kind !== 'binding' ||
    (reference.binding.packageName === context.subject.packageName &&
      reference.binding.source === context.subject.source)
  ) {
    return reference;
  }
  const imported = getInterfaceInheritanceTypeImport(reference, context);
  const key = `${reference.binding.id}\0${imported.imported}`;
  let binding = context.importedTypeBindings.get(key);
  if (!binding) {
    binding = {
      column: declaration.binding.column,
      fingerprint: declaration.binding.fingerprint,
      id: `type-binding:${JSON.stringify([
        context.subject.packageName,
        context.subject.source,
        'interface-inheritance',
        reference.binding.id,
        imported.imported,
      ])}`,
      kind: 'import',
      line: declaration.binding.line,
      name: reference.binding.name,
      packageName: context.subject.packageName,
      scope: 'module',
      source: context.subject.source,
      space: 'type',
    };
    context.importedTypeBindings.set(key, binding);
    addInterfaceInheritanceTypeImport(binding, imported, context);
  }
  return { binding, kind: 'binding', path: imported.path };
}

function getInterfaceInheritanceTypeImport(
  reference: Readonly<Extract<IrTypeNameReference, { kind: 'binding' }>>,
  context: InterfaceInheritanceLoweringContext,
): InterfaceInheritanceTypeImport {
  for (const module of context.moduleSet.modules) {
    const declaration = module.declarations.get(reference.binding.id);
    if (declaration) {
      return { imported: declaration.declaration.binding.name, path: reference.path, target: module };
    }
    for (const imported of module.module.imports) {
      const candidate = imported.bindings.find((binding) => binding.binding.id === reference.binding.id);
      if (!candidate) continue;
      const targets = getInterfaceInheritanceSpecifierModules(module, imported.specifier, context.moduleSet);
      if (targets.length !== 1) {
        return failIrInterfaceInheritanceLowering(
          context.subject,
          `inherited type ${reference.binding.name} does not resolve to one module`,
        );
      }
      if (candidate.imported === '*') {
        const [name, ...remainingPath] = reference.path;
        if (!name) {
          return failIrInterfaceInheritanceLowering(
            context.subject,
            `inherited namespace type ${reference.binding.name} has no exported member path`,
          );
        }
        return { imported: name, path: remainingPath, target: targets[0]! };
      }
      return { imported: candidate.imported, path: reference.path, target: targets[0]! };
    }
  }
  return failIrInterfaceInheritanceLowering(
    context.subject,
    `inherited type ${reference.binding.name} has no source module introduction`,
  );
}

function addInterfaceInheritanceTypeImport(
  binding: Readonly<IrTypeBindingIdentity>,
  imported: Readonly<InterfaceInheritanceTypeImport>,
  context: InterfaceInheritanceLoweringContext,
): void {
  if (imported.target.module.packageName !== context.subject.packageName) {
    failIrInterfaceInheritanceLowering(
      context.subject,
      `inherited type ${imported.imported} requires cross-package import materialization`,
    );
  }
  const specifier = getInterfaceInheritanceRelativeSpecifier(context.subject.source, imported.target.source);
  const index = context.imports.findIndex((candidate) => candidate.specifier === specifier);
  const importBinding = { binding, imported: imported.imported, typeOnly: true } as const;
  if (index < 0) {
    context.imports.push({ bindings: [importBinding], specifier, typeOnly: true });
    return;
  }
  const existing = context.imports[index]!;
  context.imports[index] = { ...existing, bindings: [...existing.bindings, importBinding] };
}

function getInterfaceInheritanceRelativeSpecifier(fromSource: string, targetSource: string): string {
  const from = normalizePathPortable(fromSource).split('/');
  const target = normalizePathPortable(targetSource).split('/');
  from.pop();
  target[target.length - 1] = target
    .at(-1)!
    .replace(/\.cts$/u, '.cjs')
    .replace(/\.mts$/u, '.mjs')
    .replace(/\.tsx$/u, '.jsx')
    .replace(/\.ts$/u, '.js');
  while (from[0] !== undefined && from[0] === target[0]) {
    from.shift();
    target.shift();
  }
  const relative = [...from.map(() => '..'), ...target].join('/');
  return relative.startsWith('.') ? relative : `./${relative}`;
}

function failIrInterfaceInheritanceLowering(module: Readonly<IrModule>, message: string): never {
  throw createCompilerLoweringFailure('unsupported-ir', compilerLoweringPassNameInterfaceInheritance, module, message);
}

const compilerEmptyModuleResolutionPlan: CompilerModuleResolutionPlan = Object.freeze({
  edges: Object.freeze([]),
  schema: 'flight-compiler-module-resolution/1',
});
