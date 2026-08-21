import { analyzeIrModuleTraversal } from '../../compiler-ir-traversal/src/index.js';
import type {
  CompilerIrTraversalPath,
  CompilerStructuralObjectCompatibilityDiagnostic,
  CompilerStructuralObjectCompatibilityDisposition,
  CompilerStructuralObjectCompatibilityReport,
  IrInterfaceDeclaration,
  IrModule,
  IrObjectExpression,
  IrObjectTypeProperty,
  IrType,
  IrTypeAliasDeclaration,
} from '../../compiler-types/src/index.js';
import {
  createIrTypeParameterSubstitutionPlan,
  isCompilerStructuralTypeSubstitutionFailure,
  resolveIrTypeStructuralSubstitution,
} from './compilerStructuralTypeSubstitution.js';

type StructuralDeclaration = Readonly<IrInterfaceDeclaration | IrTypeAliasDeclaration>;

type StructuralTargetResolution =
  | Readonly<{ kind: 'closed'; properties: readonly IrObjectTypeProperty[] }>
  | Readonly<{
      code:
        | 'cyclic-construction-target'
        | 'invalid-type-application'
        | 'non-structural-construction-target'
        | 'open-construction-target'
        | 'unresolved-named-construction-target';
      disposition: 'incompatible' | 'indeterminate';
      kind: 'diagnostic';
      message: string;
    }>;

export function analyzeIrModuleStructuralObjectCompatibility(
  module: Readonly<IrModule>,
): CompilerStructuralObjectCompatibilityReport {
  const declarations = new Map(
    module.declarations.flatMap((declaration) =>
      declaration.kind === 'interface' || declaration.kind === 'typeAlias'
        ? ([[declaration.binding.id, declaration]] as const)
        : [],
    ),
  );
  const diagnostics: CompilerStructuralObjectCompatibilityDiagnostic[] = [];
  analyzeIrModuleTraversal(module, {
    expression(expression, path) {
      if (expression.kind === 'object') {
        analyzeIrObjectExpressionStructuralCompatibility(expression, path, declarations, diagnostics);
      }
    },
  });
  const frozenDiagnostics = Object.freeze(
    diagnostics.map((diagnostic) => Object.freeze({ ...diagnostic, path: Object.freeze([...diagnostic.path]) })),
  );
  return Object.freeze({
    diagnostics: frozenDiagnostics,
    module: Object.freeze({ name: module.name, packageName: module.packageName, source: module.source }),
    schema: 'flight-compiler-structural-object-compatibility/1',
    status: getCompilerStructuralObjectCompatibilityStatus(frozenDiagnostics),
  });
}

function analyzeIrObjectExpressionStructuralCompatibility(
  expression: Readonly<IrObjectExpression>,
  path: CompilerIrTraversalPath,
  declarations: ReadonlyMap<string, StructuralDeclaration>,
  diagnostics: CompilerStructuralObjectCompatibilityDiagnostic[],
): void {
  const resolution = getIrTypeStructuralConstructionTarget(expression.type, declarations, new Set());
  if (resolution.kind === 'diagnostic') {
    addCompilerStructuralObjectCompatibilityDiagnostic(
      resolution.code,
      resolution.disposition,
      resolution.message,
      path,
      undefined,
      diagnostics,
    );
  }

  const properties = resolution.kind === 'closed' ? resolution.properties : undefined;
  const propertyNames = properties ? new Set(properties.map((property) => property.name)) : undefined;
  const provided = new Set<string>();
  let membershipIndeterminate = false;
  expression.members.forEach((member, index) => {
    const memberPath = [...path, 'members', index];
    if (member.kind === 'computedProperty') {
      membershipIndeterminate = true;
      addCompilerStructuralObjectCompatibilityDiagnostic(
        'computed-property-indeterminate',
        'requires-lowering',
        'computed object property membership requires property-key and evaluation lowering',
        memberPath,
        undefined,
        diagnostics,
      );
      return;
    }
    if (member.kind === 'spread') {
      membershipIndeterminate = true;
      addCompilerStructuralObjectCompatibilityDiagnostic(
        'spread-membership-indeterminate',
        'requires-lowering',
        'object spread membership requires structural copy and source-shape lowering',
        memberPath,
        undefined,
        diagnostics,
      );
      return;
    }
    if (provided.has(member.name)) {
      addCompilerStructuralObjectCompatibilityDiagnostic(
        'duplicate-property-requires-normalization',
        'requires-lowering',
        `object property ${member.name} is written more than once and requires evaluation-preserving normalization`,
        memberPath,
        member.name,
        diagnostics,
      );
    }
    provided.add(member.name);
    if (propertyNames && !propertyNames.has(member.name)) {
      addCompilerStructuralObjectCompatibilityDiagnostic(
        'unknown-property',
        'incompatible',
        `object property ${member.name} is absent from its closed construction type`,
        memberPath,
        member.name,
        diagnostics,
      );
    }
  });
  if (!properties || membershipIndeterminate) return;
  for (const property of properties) {
    if (!property.optional && !provided.has(property.name)) {
      addCompilerStructuralObjectCompatibilityDiagnostic(
        'missing-required-property',
        'incompatible',
        `required object property ${property.name} is absent from its construction`,
        path,
        property.name,
        diagnostics,
      );
    }
  }
}

function getIrTypeStructuralConstructionTarget(
  type: Readonly<IrType>,
  declarations: ReadonlyMap<string, StructuralDeclaration>,
  ancestors: ReadonlySet<string>,
): StructuralTargetResolution {
  if (type.kind === 'object') return { kind: 'closed', properties: type.properties };
  if (type.kind !== 'named') {
    return {
      code: 'open-construction-target',
      disposition: 'indeterminate',
      kind: 'diagnostic',
      message: 'object construction lacks closed structural target evidence',
    };
  }
  const target = getIrTypeStructuralConstructionTargetName(type);
  if (type.reference.kind !== 'binding' || type.reference.path.length > 0) {
    return {
      code: 'unresolved-named-construction-target',
      disposition: 'indeterminate',
      kind: 'diagnostic',
      message: `named structural construction target ${target} is not locally resolvable`,
    };
  }
  const bindingId = type.reference.binding.id;
  if (ancestors.has(bindingId)) {
    return {
      code: 'cyclic-construction-target',
      disposition: 'incompatible',
      kind: 'diagnostic',
      message: `structural construction target ${target} is cyclic`,
    };
  }
  const declaration = declarations.get(bindingId);
  if (!declaration) {
    return {
      code: 'unresolved-named-construction-target',
      disposition: 'indeterminate',
      kind: 'diagnostic',
      message: `named structural construction target ${target} is unavailable in this module`,
    };
  }
  let resolved: IrType;
  try {
    const plan = createIrTypeParameterSubstitutionPlan(declaration.typeParameters, type.typeArguments);
    resolved =
      declaration.kind === 'interface'
        ? {
            kind: 'object',
            properties: declaration.properties.map((property) => ({
              ...property,
              type: resolveIrTypeStructuralSubstitution(property.type, plan),
            })),
          }
        : resolveIrTypeStructuralSubstitution(declaration.type, plan);
  } catch (error) {
    if (!isCompilerStructuralTypeSubstitutionFailure(error)) throw error;
    return {
      code: 'invalid-type-application',
      disposition: 'incompatible',
      kind: 'diagnostic',
      message: `structural construction target ${target} has invalid generic application (${error.code})`,
    };
  }
  if (resolved.kind === 'object') return { kind: 'closed', properties: resolved.properties };
  if (resolved.kind === 'named') {
    return getIrTypeStructuralConstructionTarget(resolved, declarations, new Set(ancestors).add(bindingId));
  }
  return {
    code: 'non-structural-construction-target',
    disposition: 'incompatible',
    kind: 'diagnostic',
    message: `object construction target ${target} does not resolve to a structural record`,
  };
}

function getIrTypeStructuralConstructionTargetName(type: Readonly<Extract<IrType, { kind: 'named' }>>): string {
  return type.reference.kind === 'ambient'
    ? type.reference.name
    : [type.reference.binding.name, ...type.reference.path].join('.');
}

function addCompilerStructuralObjectCompatibilityDiagnostic(
  code: CompilerStructuralObjectCompatibilityDiagnostic['code'],
  disposition: CompilerStructuralObjectCompatibilityDisposition,
  message: string,
  path: CompilerIrTraversalPath,
  property: string | undefined,
  diagnostics: CompilerStructuralObjectCompatibilityDiagnostic[],
): void {
  diagnostics.push({ code, disposition, message, path, ...(property === undefined ? {} : { property }) });
}

function getCompilerStructuralObjectCompatibilityStatus(
  diagnostics: readonly CompilerStructuralObjectCompatibilityDiagnostic[],
): CompilerStructuralObjectCompatibilityReport['status'] {
  if (diagnostics.some((diagnostic) => diagnostic.disposition === 'incompatible')) return 'incompatible';
  return diagnostics.length === 0 ? 'compatible' : 'indeterminate';
}
