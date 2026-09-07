import path from 'node:path';

import {
  collectIrModuleNullableBindingIds,
  createBackendEmissionFailure,
  createCompilerGeneratedFileHeader,
  createIrModuleTargetNameAllocation,
  getIrUnionTypeStringLiteralValues,
  hasIrTypeAbsentMember,
  indentSourceLines,
  normalizeSourceTextGrouping,
  isCompilerTargetNameAllocationFailure,
} from '../../compiler-emission/src/index.js';
import { analyzeIrStatementSubtreeTraversal } from '../../compiler-ir-traversal/src/index.js';
import {
  createIrClassInitializationPlan,
  createCompilerLoweringPassAwaitConditionHoisting,
  createCompilerLoweringPassBindingPattern,
  createCompilerLoweringPassCStyleFor,
  createCompilerLoweringPassExtraArgumentErasure,
  createCompilerLoweringPassInterfaceInheritance,
  createCompilerLoweringPassSwitchFallthrough,
  createCompilerLoweringPassSwitchSuspension,
  createCompilerLoweringPassVariableHoisting,
  lowerIrModuleWithCompilerPasses,
} from '../../compiler-lowering/src/index.js';
import {
  analyzeCompilerRuntimeExternalConstructorAbiCompleteness,
  analyzeCompilerRuntimeExternalSymbolCompleteness,
  collectIrModulesRuntimeExternalConstructorInvocations,
  collectIrModulesRuntimeExternalSymbolIdentities,
} from '../../compiler-runtime-contract/src/index.js';
import {
  analyzeIrModuleStructuralObjectCompatibilityAcrossModules,
  createIrObjectTypeShapeIdentity,
} from '../../compiler-structural/src/index.js';
import type {
  CompilerBackend,
  CompilerModuleResolutionPlan,
  EmittedFile,
  RustCompilerBackendOptions,
} from '../../compiler-types/src/index.js';
import type {
  IrAssignmentOperator,
  IrAssignmentOperatorSemantics,
  IrBinaryOperator,
  IrBinaryOperatorSemantics,
  IrBindingIdentity,
  IrClassDeclaration,
  IrClassMethod,
  IrControlFlowLabelIdentity,
  IrDeclaration,
  IrEnumDeclaration,
  IrExport,
  IrExpression,
  IrFunctionDeclaration,
  IrIdentifierReference,
  IrImport,
  IrInterfaceDeclaration,
  IrModule,
  IrObjectMember,
  IrObjectTypeProperty,
  IrParameter,
  IrPostfixUnaryOperator,
  IrPrefixUnaryOperator,
  IrStatement,
  IrSwitchCase,
  IrType,
  IrTypeAliasDeclaration,
  IrTypeBindingIdentity,
  IrTypeReference,
  IrTypeParameter,
  IrUnaryOperatorSemantics,
  IrVariable,
  IrVariableDeclaration,
} from '../../compiler-types/src/index.js';
import { getCompilerRustAmbientMemberBinding } from './rustAmbientMemberBinding.js';
import {
  convertPackageNameToRustCrateName,
  convertSourcePathToRustModuleName,
  isRustCompilerKeyword,
} from './rustCompilerIdentity.js';
import {
  analyzeIrModuleOwnershipEvidenceRust,
  collectIrModuleMovedBindingIdsRust,
  collectIrModuleReferentMutatedParameterIdsRust,
} from './rustOwnershipEvidence.js';
import { createCompilerRuntimeExternalConstructorAbiPlanRust } from './rustRuntimeExternalConstructorAbi.js';
import {
  createCompilerRuntimeExternalSymbolBindingPlanRust,
  getCompilerRuntimeExternalMemberTargetRust,
  getCompilerRuntimeExternalSymbolTargetRust,
  isCompilerRuntimeExternalSymbolProvidedRust,
} from './rustRuntimeExternalSymbolBinding.js';

interface PrimitiveUnionEnum {
  readonly name: string;
  readonly variants: ReadonlyArray<{ primitiveKind: string; rustType: string; variantName: string }>;
}

interface EmitContext {
  anonymousObjectRecords: Map<string, Readonly<{ name: string; properties: readonly IrObjectTypeProperty[] }>>;
  // Which bindings the module rebinds. Rust needs `mut` on a parameter that is assigned to, and the
  // ownership analysis already decides that for every binding in the module.
  movedBindingIds: ReadonlySet<string>;
  accessorClassNames: ReadonlyMap<string, string>;
  callbackBindingIds: Set<string>;
  classBindingNames: ReadonlyMap<string, string>;
  enclosingReturnType?: Readonly<IrType> | undefined;
  runtimeTypeNames: Set<string>;
  borrowedParameterPositions: ReadonlyMap<string, ReadonlySet<number>>;
  deferredBindingIds: ReadonlySet<string>;
  primitiveUnionEnums: Map<string, PrimitiveUnionEnum>;
  primitiveUnionBindingIds: Map<string, string>;
  referentMutatedBindingIds: ReadonlySet<string>;
  referentMutatedParameterIds: ReadonlySet<string>;
  taggedUnionBindingNames: ReadonlyMap<string, string>;
  reboundBindingIds: ReadonlySet<string>;
  generatedNames: Set<string>;
  module: Readonly<IrModule>;
  needsRcImport: Set<'Rc'>;
  nullableBindingIds: ReadonlySet<string>;
  objectRestRecords: Map<string, Readonly<{ name: string; properties: readonly IrObjectTypeProperty[] }>>;
  options: Readonly<RustCompilerBackendOptions>;
  returnsAbsent: boolean;
  targetNames: ReadonlyMap<string, string>;
}

type OperatorEmissionDecision = Readonly<{ emitted: string }> | Readonly<{ refusal: string }>;

export function createRustCompilerBackend(): CompilerBackend<RustCompilerBackendOptions> {
  return {
    emitModule(module, { moduleResolution, modules, options }) {
      return [emitIrModuleRustWithContext(module, modules, moduleResolution, options)];
    },
    name: 'rust',
  };
}

export function emitIrModuleRust(
  sourceModule: Readonly<IrModule>,
  options: Readonly<RustCompilerBackendOptions> = {},
): EmittedFile {
  return emitIrModuleRustWithContext(sourceModule, [sourceModule], undefined, options);
}

function emitIrModuleRustWithContext(
  sourceModule: Readonly<IrModule>,
  sourceModules: readonly Readonly<IrModule>[],
  moduleResolution: Readonly<CompilerModuleResolutionPlan> | undefined,
  options: Readonly<RustCompilerBackendOptions>,
): EmittedFile {
  const module = lowerIrModuleWithCompilerPasses(sourceModule, [
    createCompilerLoweringPassExtraArgumentErasure(),
    createCompilerLoweringPassAwaitConditionHoisting(),
    createCompilerLoweringPassBindingPattern(),
    createCompilerLoweringPassVariableHoisting(),
    createCompilerLoweringPassCStyleFor(),
    createCompilerLoweringPassInterfaceInheritance(),
    createCompilerLoweringPassSwitchFallthrough(),
    createCompilerLoweringPassSwitchSuspension(),
  ]);
  assertStructuralObjectCompatibilityRust(
    module,
    replaceIrModuleBackendContext(sourceModules, module),
    moduleResolution,
  );
  assertRuntimeExternalSymbolBindingsRust(module);
  assertRuntimeExternalConstructorAbiRust(module);
  const constantIdentities = new Set(
    module.declarations.flatMap((declaration) =>
      declaration.kind === 'variable' && !declaration.mutable && !('pattern' in declaration)
        ? [declaration.binding.id]
        : [],
    ),
  );
  let targetNames: Map<string, string>;
  try {
    targetNames = new Map(
      createIrModuleTargetNameAllocation(module, (binding) => ({
        namespace: 'identifier',
        preferredName: getPreferredBindingNameRust(binding, constantIdentities),
      })).map((allocation) => [allocation.identity, allocation.name]),
    );
  } catch (error) {
    if (isCompilerTargetNameAllocationFailure(error)) {
      throw createBackendEmissionFailure(
        'rust',
        module,
        `public declarations share fixed Rust target name ${error.targetName}`,
      );
    }
    throw error;
  }
  const accessorClassNames = new Map<string, string>();
  const classBindingNames = new Map<string, string>();
  const borrowedParameterPositions = new Map<string, ReadonlySet<number>>();
  const primitiveUnionEnums = new Map<string, PrimitiveUnionEnum>();
  const primitiveUnionBindingIds = new Map<string, string>();
  const taggedUnionBindingNames = new Map<string, string>();
  const context: EmitContext = {
    accessorClassNames,
    anonymousObjectRecords: new Map(),
    callbackBindingIds: new Set<string>(),
    classBindingNames,
    borrowedParameterPositions,
    deferredBindingIds: new Set(
      analyzeIrModuleOwnershipEvidenceRust(module).bindings.flatMap((evidence) =>
        evidence.uses.filter((use) => use.kind === 'rebind').length === 1 ? [evidence.binding.id] : [],
      ),
    ),
    primitiveUnionEnums,
    primitiveUnionBindingIds,
    runtimeTypeNames: new Set<string>(),
    reboundBindingIds: new Set(
      analyzeIrModuleOwnershipEvidenceRust(module).bindings.flatMap((evidence) =>
        evidence.mutation !== 'none' ? [evidence.binding.id] : [],
      ),
    ),
    generatedNames: new Set(targetNames.values()),
    movedBindingIds: collectIrModuleMovedBindingIdsRust(module),
    referentMutatedBindingIds: new Set(
      analyzeIrModuleOwnershipEvidenceRust(module).bindings.flatMap((evidence) =>
        evidence.mutation === 'referentMutated' || evidence.mutation === 'bindingAndReferent'
          ? [evidence.binding.id]
          : [],
      ),
    ),
    referentMutatedParameterIds: collectIrModuleReferentMutatedParameterIdsRust(module),
    taggedUnionBindingNames,
    module,
    needsRcImport: new Set(),
    nullableBindingIds: collectIrModuleNullableBindingIds(module),
    objectRestRecords: new Map(),
    options,
    returnsAbsent: false,
    targetNames,
  };
  // Which bindings hold a union this module lowered to an enum. The type is on the binding, not on
  // the member access, so the access site can only tell that its object is an enum by asking here.
  for (const evidence of analyzeIrModuleOwnershipEvidenceRust(module).bindings) {
    if (evidence.type.kind !== 'named' || evidence.type.reference.kind !== 'binding') continue;
    const reference = evidence.type.reference;
    const alias = module.declarations.find(
      (candidate) => candidate.kind === 'typeAlias' && candidate.binding.name === reference.binding.name,
    );
    if (
      alias?.kind === 'typeAlias' &&
      alias.type.kind === 'union' &&
      getIrUnionTypeMemberRecordsRust(alias.type, context)
    ) {
      taggedUnionBindingNames.set(evidence.binding.id, getBindingTargetNameRust(alias.binding, context));
      continue;
    }
    // Which bindings hold a class with accessors. Rust has no properties, so a source-level field
    // read of one is a call, and the access site can only tell by asking what the binding holds.
    const classDeclaration = module.declarations.find(
      (candidate) => candidate.kind === 'class' && candidate.binding.name === reference.binding.name,
    );
    if (classDeclaration?.kind !== 'class') continue;
    classBindingNames.set(evidence.binding.id, classDeclaration.binding.name);
    if (classDeclaration.methods.some((method) => method.accessor)) {
      accessorClassNames.set(evidence.binding.id, classDeclaration.binding.name);
    }
  }
  // Which positions each module-local function borrows. Rust does not take a reference for an
  // argument the way it does for a method receiver, so the call site has to lend explicitly, and only
  // the callee's own declaration knows which positions those are.
  for (const declaration of module.declarations) {
    if (declaration.kind !== 'function') continue;
    const borrowed = new Set(
      declaration.parameters.flatMap((parameter, index) =>
        context.referentMutatedParameterIds.has(parameter.binding.id) ? [index] : [],
      ),
    );
    if (borrowed.size > 0) borrowedParameterPositions.set(declaration.binding.id, borrowed);
  }
  collectPrimitiveUnionBindingsRust(module, context);
  const lines = [createCompilerGeneratedFileHeader(module, '//', options.upstreamCommit), '#![forbid(unsafe_code)]'];
  const imports = [...emitImports(module.imports, context), ...emitReexportsRust(module.exports, context)];
  const declarations = module.declarations.map((declaration) => emitDeclaration(declaration, context));
  // The runtime contract's types are named bare in emitted source, so the module has to bring them
  // into scope. Which ones it needs is only known once everything is emitted, which is why the use
  // line is assembled here rather than beside the source's own imports.
  const runtimeImports =
    context.runtimeTypeNames.size > 0
      ? [`use ${options.runtimeCrate ?? 'flight_runtime'}::${emitUseTreeRust([...context.runtimeTypeNames].sort())};`]
      : [];
  const stdImports = context.needsRcImport.size > 0 ? ['use std::rc::Rc;'] : [];
  if (runtimeImports.length > 0 || imports.length > 0 || stdImports.length > 0)
    lines.push('', ...stdImports, ...runtimeImports, ...imports);
  context.anonymousObjectRecords.forEach((record) => {
    lines.push('', ...emitRecord(record.name, record.properties, [], false, context));
  });
  context.objectRestRecords.forEach((record) => {
    lines.push('', ...emitRecord(record.name, record.properties, [], false, context));
  });
  context.primitiveUnionEnums.forEach((union) => {
    lines.push('', ...emitPrimitiveUnionEnumRust(union));
  });
  declarations.forEach((declaration) => lines.push('', ...declaration));
  return {
    contents: lines.join('\n'),
    path: `${convertSourcePathToRustModuleName(module.source) ?? `_internal_${snakeCase(module.name)}`}.rs`,
  };
}

function emitClass(declaration: Readonly<IrClassDeclaration>, context: EmitContext): string[] {
  // Rust has no inheritance of state, so a base that carries fields has nothing to inherit into. A
  // stateless abstract base is a different thing: it is a set of methods, which is a trait, and the
  // subclass implements it.
  const abstractBase = getIrClassStatelessAbstractBaseRust(declaration, context);
  if (declaration.extends && !abstractBase) {
    emissionError(context, `class ${declaration.binding.name} inheritance requires Rust ownership lowering`);
  }
  // An abstract class declares behaviour and holds no state, which is what a Rust trait is. A method
  // it implements becomes the trait's default body, so a subclass inherits it by implementing nothing.
  if (declaration.abstract) return emitAbstractClassTraitRust(declaration, context);
  const inheritedTraits = abstractBase ? [getBindingTargetNameRust(abstractBase.binding, context)] : [];
  const implementedTraits = declaration.implements.map((reference) => {
    if (reference.kind !== 'named' || reference.reference.kind !== 'binding') {
      return emissionError(context, `class ${declaration.binding.name} implements a type with no Rust trait`);
    }
    const target = context.module.declarations.find(
      (candidate) =>
        candidate.kind === 'interface' &&
        reference.reference.kind === 'binding' &&
        candidate.binding.id === reference.reference.binding.id,
    );
    if (!target) {
      return emissionError(
        context,
        `class ${declaration.binding.name} implements an interface declared outside this module`,
      );
    }
    return emitType(reference, context);
  });
  const constructorFields = declaration.classConstructor
    ? getIrClassConstructorFieldAssignmentsRust(declaration, abstractBase !== undefined)
    : undefined;
  if (
    declaration.classConstructor &&
    !constructorFields &&
    (declaration.classConstructor.parameters.length > 0 || declaration.classConstructor.body.length > 0)
  ) {
    emissionError(context, `class ${declaration.binding.name} constructor requires Rust initialization lowering`);
  }
  // A static field is one value shared by the type, which Rust spells as an associated constant —
  // but only where the source's initializer is a constant. Anything computed needs a place to run,
  // and an associated constant has none.
  const staticFields = declaration.fields.filter((field) => field.static);
  if (staticFields.some((field) => field.initializer?.kind !== 'literal')) {
    emissionError(context, `class ${declaration.binding.name} static fields require a constant initializer`);
  }
  const constructed =
    !declaration.classConstructor ||
    (declaration.classConstructor.parameters.length === 0 && declaration.classConstructor.body.length === 0);
  const instanceFields = declaration.fields.filter((field) => !field.static);
  if (instanceFields.some((field) => field.initializer) && !constructed && !constructorFields) {
    emissionError(context, `class ${declaration.binding.name} field initializers require constructor lowering`);
  }
  if (instanceFields.some((field) => field.initializer) && instanceFields.some((field) => !field.initializer)) {
    emissionError(context, `class ${declaration.binding.name} partially initializes its fields`);
  }
  const lines = [
    '#[derive(Clone, Debug)]',
    `${declaration.exported ? 'pub ' : ''}struct ${getBindingTargetNameRust(declaration.binding, context)}${emitTypeParameters(declaration.typeParameters, context)} {`,
  ];
  for (const field of instanceFields) {
    lines.push(
      `    ${field.visibility === 'public' ? 'pub ' : ''}${safeRustValueName(field.name)}: ${emitType(field.type, context)},`,
    );
  }
  lines.push('}');
  // A field initializer is a constructor obligation, and the neutral plan already decides when each
  // field is initialized. Rust has no implicit constructor, so the plan becomes an associated `new`.
  const initialization =
    instanceFields.every((field) => field.initializer) && instanceFields.length > 0 && constructed
      ? createIrClassInitializationPlan(declaration)
      : undefined;
  const associated: string[] = staticFields.map(
    (field) =>
      `  ${field.visibility === 'public' ? 'pub ' : ''}const ${constantRustName(field.name)}: ${emitType(field.type, context)} = ${emitExpression(field.initializer!, context)};`,
  );
  if (constructorFields && declaration.classConstructor) {
    associated.push(
      `  ${declaration.exported ? 'pub ' : ''}fn new(${declaration.classConstructor.parameters.map((parameter) => emitParameter(parameter, context)).join(', ')}) -> Self {`,
      '    Self {',
      ...constructorFields.map(
        (field) => `      ${safeRustValueName(field.name)}: ${emitOwnedOperandRust(field.value, context)},`,
      ),
      '    }',
      '  }',
    );
  }
  if (initialization) {
    const instanceOrder = initialization.fields.filter(
      (field) => declaration.fields[field.fieldIndex] && !declaration.fields[field.fieldIndex]!.static,
    );
    associated.push(
      `  ${declaration.exported ? 'pub ' : ''}fn new() -> Self {`,
      '    Self {',
      ...instanceOrder.map((field) => {
        const source = declaration.fields[field.fieldIndex]!;
        return `      ${safeRustValueName(source.name)}: ${emitExpression(source.initializer!, context)},`;
      }),
      '    }',
      '  }',
    );
  }
  const mutatingMethodNames = getIrClassMutatingMethodNamesRust(declaration);
  // A trait's methods belong in its `impl` block, not in the inherent one, so the two are split by
  // which trait declares each method name.
  const traitMethodNames = new Map<string, string>();
  for (const reference of declaration.implements) {
    if (reference.kind !== 'named' || reference.reference.kind !== 'binding') continue;
    const target = context.module.declarations.find(
      (candidate) =>
        candidate.kind === 'interface' &&
        reference.reference.kind === 'binding' &&
        candidate.binding.id === reference.reference.binding.id,
    );
    if (target?.kind !== 'interface') continue;
    for (const property of target.properties) traitMethodNames.set(property.name, emitType(reference, context));
  }
  if (abstractBase) {
    const traitName = getBindingTargetNameRust(abstractBase.binding, context);
    for (const method of abstractBase.methods) traitMethodNames.set(method.name, traitName);
  }
  const traitDataProperties = new Map<string, IrObjectTypeProperty[]>();
  for (const reference of declaration.implements) {
    if (reference.kind !== 'named' || reference.reference.kind !== 'binding') continue;
    const target = context.module.declarations.find(
      (candidate) =>
        candidate.kind === 'interface' &&
        reference.reference.kind === 'binding' &&
        candidate.binding.id === reference.reference.binding.id,
    );
    if (target?.kind !== 'interface') continue;
    traitDataProperties.set(
      emitType(reference, context),
      target.properties.filter((property) => property.type.kind !== 'function'),
    );
  }
  const inherentMethods = declaration.methods.filter((method) => !traitMethodNames.has(method.name));
  const emitMethodLines = (method: (typeof declaration.methods)[number]): string[] => {
    // Rust has no properties, so an accessor is a method. A setter takes the receiver mutably and is
    // named apart from the getter, because Rust has one namespace for both and the source had two.
    const target = getIrClassMethodTargetNameRust(method);
    const receiver = method.accessor === 'set' || mutatingMethodNames.has(target) ? '&mut self' : '&self';
    const parameters = [
      ...(method.static ? [] : [receiver]),
      ...method.parameters.map((parameter) => emitParameter(parameter, context)),
    ].join(', ');
    // A setter yields nothing. The source wrote no return type and the neutral model kept that
    // unknown, but the accessor contract already decides it.
    const returns = method.accessor === 'set' ? '()' : emitType(method.returns, context);
    return [
      `  ${method.visibility === 'public' && !traitMethodNames.has(method.name) ? 'pub ' : ''}fn ${target}${emitTypeParameters(method.typeParameters, context)}(${parameters}) -> ${returns} {`,
      ...indentSourceLines(emitStatements(method.body, context), 2),
      '  }',
    ];
  };
  for (const trait of [...inheritedTraits, ...implementedTraits]) {
    const traitMethods = declaration.methods.filter((method) => traitMethodNames.get(method.name) === trait);
    lines.push(
      '',
      `impl${emitTypeParameters(declaration.typeParameters, context)} ${trait} for ${getBindingTargetNameRust(declaration.binding, context)}${emitTypeArguments(declaration.typeParameters, context)} {`,
    );
    const traitAccessors = traitDataProperties.get(trait) ?? [];
    traitMethods.forEach((method, index) => {
      if (index > 0) lines.push('');
      lines.push(...emitMethodLines(method));
    });
    traitAccessors.forEach((property, index) => {
      if (index > 0 || traitMethods.length > 0) lines.push('');
      lines.push(
        `  fn ${safeRustValueName(property.name)}(&self) -> ${emitType(property.type, context)} {`,
        `    self.${safeRustValueName(property.name)}.clone()`,
        '  }',
      );
    });
    lines.push('}');
  }
  if (inherentMethods.length > 0 || associated.length > 0) {
    lines.push(
      '',
      `impl${emitTypeParameters(declaration.typeParameters, context)} ${getBindingTargetNameRust(declaration.binding, context)}${emitTypeArguments(declaration.typeParameters, context)} {`,
      ...associated,
    );
    inherentMethods.forEach((method, index) => {
      if (index > 0 || associated.length > 0) lines.push('');
      lines.push(...emitMethodLines(method));
    });
    lines.push('}');
  }
  return lines;
}

function emitDeclaration(declaration: Readonly<IrDeclaration>, context: EmitContext): string[] {
  switch (declaration.kind) {
    case 'class':
      return emitClass(declaration, context);
    case 'enum':
      return emitEnum(declaration, context);
    case 'function':
      return emitFunction(declaration, context);
    case 'interface':
      return emitInterface(declaration, context);
    case 'typeAlias':
      return emitTypeAlias(declaration, context);
    case 'variable':
      return emitVariableDeclaration(declaration, context);
  }
}

function emitEnum(declaration: Readonly<IrEnumDeclaration>, context: EmitContext): string[] {
  const values = declaration.members.map((member) => member.value);
  if (values.every((value) => typeof value === 'string')) return emitStringEnumRust(declaration, context);
  if (values.some((value) => typeof value !== 'number' || !Number.isInteger(value))) {
    emissionError(context, `enum ${declaration.binding.name} requires one discriminant domain for Rust`);
  }
  if (values.some((value) => Number(value) < -2_147_483_648 || Number(value) > 2_147_483_647)) {
    emissionError(context, `enum ${declaration.binding.name} has a discriminant outside the Rust i32 range`);
  }
  const lines = [
    '#[derive(Clone, Copy, Debug, PartialEq, Eq)]',
    '#[repr(i32)]',
    `${declaration.exported ? 'pub ' : ''}enum ${getBindingTargetNameRust(declaration.binding, context)} {`,
  ];
  declaration.members.forEach((member) => {
    lines.push(`  ${safeRustTypeName(member.name)} = ${String(member.value)},`);
  });
  lines.push('}');
  return lines;
}

// Rust discriminants are integers, so a string enum keeps unit variants and carries its source
// values as an explicit mapping. Both directions are emitted because the source language treats the
// value as the enum: code compares against it and constructs from it.
function emitStringEnumRust(declaration: Readonly<IrEnumDeclaration>, context: EmitContext): string[] {
  const name = getBindingTargetNameRust(declaration.binding, context);
  const visibility = declaration.exported ? 'pub ' : '';
  return [
    '#[derive(Clone, Copy, Debug, PartialEq, Eq)]',
    `${visibility}enum ${name} {`,
    ...declaration.members.map((member) => `  ${safeRustTypeName(member.name)},`),
    '}',
    '',
    `impl ${name} {`,
    `  ${visibility}fn as_str(&self) -> &'static str {`,
    '    match self {',
    ...declaration.members.map(
      (member) => `      ${name}::${safeRustTypeName(member.name)} => ${JSON.stringify(String(member.value))},`,
    ),
    '    }',
    '  }',
    '',
    `  ${visibility}fn from_str(value: &str) -> Option<Self> {`,
    '    match value {',
    ...declaration.members.map(
      (member) => `      ${JSON.stringify(String(member.value))} => Some(${name}::${safeRustTypeName(member.name)}),`,
    ),
    '      _ => None,',
    '    }',
    '  }',
    '}',
  ];
}

function emitExpression(expression: Readonly<IrExpression>, context: EmitContext): string {
  switch (expression.kind) {
    case 'array':
      return `vec![${expression.elements.map((element) => (element ? emitOwnedOperandRust(element, context) : 'Default::default()')).join(', ')}]`;
    case 'assignment': {
      if (
        expression.operator === '=' &&
        expression.left.kind === 'property' &&
        getIrExpressionClassAccessorRust(expression.left.object, expression.left.name, 'set', context)
      ) {
        return `${emitExpression(expression.left.object, context)}.set_${safeRustValueName(expression.left.name)}(${emitOwnedOperandRust(expression.right, context)})`;
      }
      if (
        expression.operator === '+=' &&
        expression.semantics.left.flow === 'string' &&
        expression.semantics.right.flow === 'string'
      ) {
        const left = emitExpression(expression.left, context);
        const right = emitExpression(expression.right, context);
        return `${left}.push_str(&${normalizeSourceTextGrouping(right)})`;
      }
      if (
        (expression.operator === '&=' ||
          expression.operator === '|=' ||
          expression.operator === '^=' ||
          expression.operator === '<<=' ||
          expression.operator === '>>=') &&
        expression.semantics.left.flow === 'number' &&
        expression.semantics.right.flow === 'number'
      ) {
        const left = emitExpression(expression.left, context);
        const right = emitExpression(expression.right, context);
        const binaryOp = expression.operator.slice(0, -1);
        return `${left} = (((${left} as i32) ${binaryOp} (${right} as i32)) as f64)`;
      }
      if (
        expression.operator === '**=' &&
        expression.semantics.left.flow === 'number' &&
        expression.semantics.right.flow === 'number'
      ) {
        const left = emitExpression(expression.left, context);
        const right = emitExpression(expression.right, context);
        return `${left} = f64::powf(${left}, ${right})`;
      }
      if (
        expression.operator === '>>>=' &&
        expression.semantics.left.flow === 'number' &&
        expression.semantics.right.flow === 'number'
      ) {
        const left = emitExpression(expression.left, context);
        const right = emitExpression(expression.right, context);
        return `${left} = ((((${left} as i32) as u32) >> (${right} as u32)) as f64)`;
      }
      const left = emitExpression(expression.left, context);
      const right = emitOptionalTargetOperandRust(expression.left, expression.right, context);
      return `${left} ${emitAssignmentOperatorRust(expression.operator, expression.semantics, context)} ${normalizeSourceTextGrouping(right)}`;
    }
    case 'await':
      // `.await` consumes the future it is given, while the source language's await does not consume
      // the promise: a promise settles once and every await sees that settlement. A task reached more
      // than once is therefore cloned, which the runtime contract's first-call-wins settlement is
      // what makes equivalent.
      return `${emitOwnedOperandRust(expression.expression, context)}.await`;
    case 'binary': {
      if (expression.semantics.nullishComparison) {
        const evidence = expression.semantics.nullishComparison;
        // Rust has one absent value, `None`, so a comparison against `null` or `undefined` is
        // `.is_none()` — and the source's own absent literal is never emitted. Where the operand
        // admits both, the two comparisons differ and `Option` cannot tell them apart.
        if (evidence.admitsNull && evidence.admitsUndefined) {
          emissionError(
            context,
            `operator ${expression.operator} against ${evidence.literal} requires Rust Option-aware lowering`,
          );
        }
        const operand =
          expression.left.kind === 'identifier' && expression.left.reference.kind === 'ambient'
            ? expression.right
            : expression.left;
        const negated = expression.operator === '!=' || expression.operator === '!==';
        return `${emitExpression(operand, context)}.${negated ? 'is_some' : 'is_none'}()`;
      }
      if (expression.operator === '??') {
        // Rust has no `??`. The shape is `Option::unwrap_or_else`, which needs the left operand to
        // already be an Option — an optional chain produces one, an ordinary value does not.
        // A coalesce whose left cannot be absent is its left: the default is unreachable, and the
        // source's own types are what say so.
        if (expression.left.kind === 'property' && expression.left.optionalChain?.receiverNullish === 'excluded') {
          return emitExpression(expression.left, context);
        }
        if (!isIrExpressionOptionShapedRust(expression.left)) {
          emissionError(context, 'operator ?? requires an Option-shaped left operand for Rust');
        }
        return `${emitOptionShapedOperandRust(expression.left, context)}.unwrap_or_else(|| ${emitExpression(expression.right, context)})`;
      }
      if (
        expression.operator === '+' &&
        expression.semantics.left.flow === 'string' &&
        expression.semantics.right.flow === 'string'
      ) {
        return emitStringConcatenationRust(expression, context);
      }
      const typeofTest = getTypeofTypeTestRust(expression, context);
      if (typeofTest) {
        const operand = emitExpression(typeofTest.operand, context);
        const test = `matches!(${operand}, ${typeofTest.enumName}::${typeofTest.variantName}(_))`;
        return typeofTest.negated ? `!${test}` : test;
      }
      if (
        expression.operator === '**' &&
        expression.semantics.left.flow === 'number' &&
        expression.semantics.right.flow === 'number'
      ) {
        const left = emitExpression(expression.left, context);
        const right = emitExpression(expression.right, context);
        return `f64::powf(${left}, ${right})`;
      }
      if (
        expression.operator === '>>>' &&
        expression.semantics.left.flow === 'number' &&
        expression.semantics.right.flow === 'number'
      ) {
        const left = emitExpression(expression.left, context);
        const right = emitExpression(expression.right, context);
        return `((((${left} as i32) as u32) >> (${right} as u32)) as f64)`;
      }
      const op = emitBinaryOperatorRust(expression.operator, expression.semantics, context);
      const bitwise =
        expression.operator === '&' ||
        expression.operator === '|' ||
        expression.operator === '^' ||
        expression.operator === '<<' ||
        expression.operator === '>>';
      const left = emitExpression(expression.left, context);
      const right = emitExpression(expression.right, context);
      if (bitwise) return `(((${left} as i32) ${op} (${right} as i32)) as f64)`;
      return `(${left} ${op} ${right})`;
    }
    case 'call':
      if (expression.semantics.statementValue) return emitStatementValueExpressionRust(expression, context);
      if (expression.optional) return emitOptionalCallExpressionRust(expression, context);
      // Rust joins a slice of strings with a borrowed separator, while the source hands it an owned
      // one. The separator is the only argument, so the borrow is decided here rather than by a
      // general rule about where an owned string may stand.
      if (
        expression.callee.kind === 'property' &&
        expression.callee.member?.receiver === 'array' &&
        expression.callee.member.name === 'join'
      ) {
        const separator = expression.arguments[0];
        if (expression.arguments.length !== 1 || !separator) {
          emissionError(context, 'joining a collection requires exactly one separator argument');
        }
        return `${emitExpression(expression.callee.object, context)}.join(${emitBorrowedTextRust(separator, context)})`;
      }
      // A slice of a collection is a range in Rust, and the source's own optional bounds decide which
      // range. Copied back into an owned collection because the source's slice is a new array, not a
      // view into the one it came from.
      if (
        expression.callee.kind === 'property' &&
        expression.callee.member?.receiver === 'array' &&
        expression.callee.member.name === 'slice'
      ) {
        const receiver = emitExpression(expression.callee.object, context);
        if (expression.arguments.length === 0) return `${receiver}.clone()`;
        if (expression.arguments.length > 2) {
          emissionError(context, 'slicing a collection takes at most a start and an end');
        }
        const bounds = expression.arguments
          .map((argument) => `${emitExpression(argument, context)} as usize`)
          .join('..');
        return `${receiver}[${expression.arguments.length === 1 ? `${bounds}..` : bounds}].to_vec()`;
      }
      if (
        expression.callee.kind === 'property' &&
        expression.callee.member?.receiver === 'array' &&
        expression.callee.member.name === 'concat' &&
        expression.arguments.length === 1
      ) {
        const receiver = emitExpression(expression.callee.object, context);
        const other = emitExpression(expression.arguments[0]!, context);
        return `{ let mut __concat = ${receiver}; __concat.extend(${other}); __concat }`;
      }
      if (
        expression.callee.kind === 'property' &&
        expression.callee.member?.receiver === 'string' &&
        expression.callee.member.name === 'charAt' &&
        expression.arguments.length === 1
      ) {
        const receiver = emitExpression(expression.callee.object, context);
        const index = emitExpression(expression.arguments[0]!, context);
        return `${receiver}.chars().nth(${index} as usize).map(|c| c.to_string()).unwrap_or_default()`;
      }
      if (
        expression.callee.kind === 'property' &&
        expression.callee.member?.receiver === 'string' &&
        expression.callee.member.name === 'charCodeAt' &&
        expression.arguments.length === 1
      ) {
        const receiver = emitExpression(expression.callee.object, context);
        const index = emitExpression(expression.arguments[0]!, context);
        return `${receiver}.chars().nth(${index} as usize).map(|c| c as u32 as f64).unwrap_or(f64::NAN)`;
      }
      if (
        expression.callee.kind === 'property' &&
        expression.callee.member?.receiver === 'string' &&
        expression.callee.member.name === 'substring'
      ) {
        const receiver = emitExpression(expression.callee.object, context);
        if (expression.arguments.length === 0 || expression.arguments.length > 2) {
          emissionError(context, 'string substring takes a start index and an optional end index');
        }
        const bounds = expression.arguments
          .map((argument) => `${emitExpression(argument, context)} as usize`)
          .join('..');
        return `${receiver}[${expression.arguments.length === 1 ? `${bounds}..` : bounds}].to_string()`;
      }
      if (expression.callee.kind === 'property' && expression.callee.member) {
        const binding = getCompilerRustAmbientMemberBinding(expression.callee.member);
        if (binding && binding.kind !== 'countingMethod') {
          const receiver =
            emitPrimitiveUnionNarrowedReceiverRust(expression.callee.object, context) ??
            emitExpression(expression.callee.object, context);
          const borrows =
            binding.kind === 'borrowedMethod' || binding.kind === 'sentinelSearch' || binding.kind === 'splitCollect';
          const values = expression.arguments.map((argument) =>
            borrows ? emitBorrowedTextRust(argument, context) : emitExpression(argument, context),
          );
          if (binding.kind === 'iterator') {
            const closure = binding.borrowsElement
              ? emitBorrowedElementClosureRust(expression.arguments[0], context)
              : values[0];
            const ordered = binding.argumentOrder
              ? binding.argumentOrder.map((position) => values[position] ?? '')
              : [closure ?? ''];
            return `${receiver}.into_iter().${binding.targetName}(${ordered.join(', ')})${binding.collect ? '.collect::<Vec<_>>()' : ''}`;
          }
          if (binding.kind === 'positionSearch') {
            const borrowed = expression.arguments.map((argument) => emitBorrowedTextRust(argument, context));
            return `${receiver}.iter().${binding.targetName}(|x| x == ${borrowed.join(', ')}).map(|i| i as f64).unwrap_or(-1.0)`;
          }
          if (binding.kind === 'sentinelSearch') {
            return `${receiver}.${binding.targetName}(${values.join(', ')}).map(|i| i as f64).unwrap_or(-1.0)`;
          }
          if (binding.kind === 'splitCollect') {
            return `${receiver}.${binding.targetName}(${values.join(', ')}).map(|s| s.to_string()).collect::<Vec<String>>()`;
          }
          if (binding.kind === 'optionalLookup') {
            const borrowed = expression.arguments.map((argument) => emitBorrowedTextRust(argument, context));
            return `${receiver}.${binding.targetName}(${borrowed.join(', ')}).cloned()`;
          }
          const leading = binding.kind === 'method' ? (binding.leadingArguments ?? []) : [];
          const trailing = binding.kind === 'borrowedMethod' ? (binding.trailingArguments ?? []) : [];
          return `${receiver}.${binding.targetName}(${[...leading, ...values, ...trailing].join(', ')})${binding.owns ? '.to_owned()' : ''}`;
        }
      }
      {
        const calleeRust =
          expression.callee.kind === 'function'
            ? `(${emitExpression(expression.callee, context)})`
            : emitExpression(expression.callee, context);
        const isCallbackCallee =
          expression.callee.kind === 'identifier' &&
          expression.callee.reference.kind === 'binding' &&
          context.callbackBindingIds.has(expression.callee.reference.binding.id);
        if (isCallbackCallee) {
          const args = emitCallArgumentsRust(expression, context);
          return `${calleeRust}((${args.join(', ')}${args.length === 1 ? ',' : ''}))`;
        }
        return `${calleeRust}(${emitCallArgumentsRust(expression, context).join(', ')})`;
      }
    case 'cast':
      return `(${emitExpression(expression.expression, context)} as ${emitType(expression.type, context)})`;
    case 'conditional':
      return `if ${emitExpression(expression.condition, context)} { ${emitExpression(expression.whenTrue, context)} } else { ${emitExpression(expression.whenFalse, context)} }`;
    case 'element':
      if (expression.optional) return emitOptionalElementExpressionRust(expression, context);
      if (expression.semantics.receivers.includes('object')) {
        emissionError(context, 'computed object access requires JavaScript property-key coercion lowering');
      }
      if (expression.semantics.receivers.includes('tuple')) {
        const index = getElementAccessTupleIndexRust(expression, context);
        return `${emitExpression(expression.object, context)}.${String(index)}`;
      }
      // A written index is already a whole number; sending it through the neutral numeric type and
      // back is noise the source never asked for.
      return `${emitExpression(expression.object, context)}[${emitIndexOperandRust(expression.index, context)}]`;
    case 'function':
      if (expression.async) emissionError(context, 'async closures require Flight task lowering');
      if (expression.typeParameters.length > 0) emissionError(context, 'generic closures require monomorphization');
      return expression.expression
        ? `|${expression.parameters.map((parameter) => getBindingTargetNameRust(parameter.binding, context)).join(', ')}| ${normalizeSourceTextGrouping(emitExpression(expression.expression, context))}`
        : `|${expression.parameters.map((parameter) => getBindingTargetNameRust(parameter.binding, context)).join(', ')}| {\n${indentSourceLines(emitStatements(expression.body, context)).join('\n')}\n}`;
    case 'identifier': {
      if (
        expression.presence === 'narrowedPresent' &&
        expression.reference.kind === 'binding' &&
        context.nullableBindingIds.has(expression.reference.binding.id)
      )
        return `${emitIdentifierReferenceRust(expression.reference, context)}.clone().unwrap()`;
      const narrowedReceiver = emitPrimitiveUnionNarrowedReceiverRust(expression, context);
      if (narrowedReceiver) return `*${narrowedReceiver}`;
      return emitIdentifierReferenceRust(expression.reference, context);
    }
    case 'literal':
      return emitLiteral(expression.value);
    case 'new':
      if (expression.callee.kind !== 'identifier') {
        emissionError(context, 'qualified constructors require Rust type-path lowering');
      }
      assertIrConstructorInvocationAbiRust(expression, context);
      return `${emitConstructorReferenceRust(expression.callee.reference, context)}::new(${expression.arguments.map((argument) => emitOwnedOperandRust(argument, context)).join(', ')})`;
    case 'object':
      return emitObjectExpressionRust(expression, context);
    case 'objectRest':
      return emitObjectRestExpressionRust(expression, context);
    case 'property': {
      if (expression.optional) return emitOptionalPropertyExpressionRust(expression, context);
      // Rust spells a collection's length `len()`, and it counts in `usize` while the neutral numeric
      // domain is one type. The cast is what keeps the comparison it feeds well typed.
      // A member of the ambient surface is spelled by the table, not by the source's name. Rust
      // counts in `usize`, so a counting member is cast back into the neutral numeric domain.
      if (expression.member) {
        const binding = getCompilerRustAmbientMemberBinding(expression.member);
        if (!binding) {
          emissionError(context, `${expression.member.receiver} member ${expression.member.name} has no Rust binding`);
        }
        if (binding.kind === 'countingMethod') {
          const countingReceiver =
            emitPrimitiveUnionNarrowedReceiverRust(expression.object, context) ??
            emitExpression(expression.object, context);
          return `(${countingReceiver}.${binding.targetName}() as f64)`;
        }
      }
      // A union is a closed set of alternatives in Rust, so its fields are not reachable by name.
      // A reference control flow narrowed to one alternative reads that alternative's own field; an
      // unnarrowed one can only read what every alternative agrees on, through the shared accessor.
      // A class's static members belong to the type, not to a value of it, so Rust paths into the
      // type: an associated constant for a field and an associated function for a method. Reading
      // either off a value is the source language's spelling, not Rust's.
      const classDeclaration = getIrExpressionClassDeclarationRust(expression.object, context);
      if (classDeclaration) {
        const field = classDeclaration.fields.find(
          (candidate) => candidate.static && candidate.name === expression.name,
        );
        const method = classDeclaration.methods.find(
          (candidate) => candidate.static && candidate.name === expression.name,
        );
        if (field || method) {
          return `${getBindingTargetNameRust(classDeclaration.binding, context)}::${
            field ? constantRustName(expression.name) : safeRustValueName(expression.name)
          }`;
        }
      }
      // An enum member is a variant, not a field: Rust paths into the type rather than reading off a
      // value, and the variant keeps the source's own spelling.
      const enumeration = getIrExpressionEnumDeclarationRust(expression.object, context);
      if (enumeration) {
        return `${getBindingTargetNameRust(enumeration.binding, context)}::${safeRustTypeName(expression.name)}`;
      }
      // Reading a member of a narrowed `Option` only needs to look at it, so it is borrowed open
      // rather than copied out.
      const borrowedNarrow = emitBorrowedNarrowedReceiverRust(expression.object, context);
      if (borrowedNarrow !== undefined) {
        return `${borrowedNarrow}.${safeRustValueName(expression.name)}`;
      }
      const accessor = getIrExpressionClassAccessorRust(expression.object, expression.name, 'get', context);
      if (accessor) return `${emitExpression(expression.object, context)}.${safeRustValueName(expression.name)}()`;
      const union = getIrExpressionTaggedUnionRust(expression.object, context);
      if (union) {
        const object = emitExpression(expression.object, context);
        return expression.object.kind === 'identifier' && expression.object.narrowedMember
          ? `${object}.as_${safeRustValueName(expression.object.narrowedMember)}().${safeRustValueName(expression.name)}`
          : `${object}.${safeRustValueName(expression.name)}()`;
      }
      // A namespace-like ambient symbol has no target name of its own, so the member decides the
      // whole spelling: `Math.max` is `f64::max`, not `Math::max`.
      if (expression.object.kind === 'identifier' && expression.object.reference.kind === 'ambient') {
        const member = getCompilerRuntimeExternalMemberTargetRust(expression.object.reference.name, expression.name);
        if (member) return member;
      }
      // Indexing a collection yields a place the caller does not own, so a field read out of it is a
      // copy rather than a move. Every emitted record derives `Clone`, so the copy is always available.
      const owned = expression.object.kind === 'element' ? '.clone()' : '';
      return `${emitExpression(expression.object, context)}${isAmbientIdentifier(expression.object) ? '::' : '.'}${safeRustValueName(expression.name)}${owned}`;
    }
    case 'regexp':
      emissionError(context, 'regular expressions require a downstream standard-library mapping');
    case 'spread':
      // As in Haxe: a fixed tuple spread is already normalized away, so what reaches here spreads an
      // unbounded collection into a fixed-arity callee, and Rust has no variadic call to lower it to.
      emissionError(context, 'spreading an unbounded collection requires a fold or a variadic target');
    case 'template': {
      const format = expression.parts
        .map((part) => (typeof part === 'string' ? part.replaceAll('{', '{{').replaceAll('}', '}}') : '{}'))
        .join('');
      const values = expression.parts.flatMap((part) =>
        typeof part === 'string' ? [] : [emitExpression(part, context)],
      );
      return `format!(${JSON.stringify(format)}${values.length > 0 ? `, ${values.join(', ')}` : ''})`;
    }
    case 'tuple': {
      const elements = expression.elements.map((element) => {
        if (!element.expression) return 'None';
        const emitted = emitExpression(element.expression, context);
        return element.optional ? `Some(${emitted})` : emitted;
      });
      return `(${elements.join(', ')}${elements.length === 1 ? ',' : ''})`;
    }
    case 'tupleSpread':
      return emitTupleSpreadExpressionRust(expression, context);
    case 'tupleRest':
      return `${emitExpression(expression.object, context)}.${String(expression.start)}`;
    case 'tupleSuffix': {
      const object = emitExpression(expression.object, context);
      const elements = Array.from(
        { length: expression.width },
        (_, offset) => `${object}.${String(expression.start + offset)}`,
      );
      return `(${elements.join(', ')}${elements.length === 1 ? ',' : ''})`;
    }
    case 'unary': {
      const operand = emitExpression(expression.operand, context);
      const operator = expression.postfix
        ? emitPostfixUnaryOperatorRust(expression.operator, context)
        : emitPrefixUnaryOperatorRust(expression.operator, expression.semantics, context);
      if (expression.operator === '~') return `(!(${operand} as i32) as f64)`;
      if (expression.operator === '+' && expression.semantics.operand.flow === 'number') return operand;
      return expression.postfix ? `${operand}${operator}` : `${operator}${operand}`;
    }
    case 'undefinedValue':
      getIrTypeOptionalPayloadRust(expression.type, 'contextual undefined value', context);
      return 'None';
    case 'undefinedDefault':
      return `${emitExpression(expression.value, context)}.unwrap_or_else(|| ${emitExpression(expression.fallback, context)})`;
  }
}

// `Promise<T>` in the return position of an `async fn` is the future Rust already builds, so the
// emitted signature carries `T`. Anywhere else the task type has no native spelling yet.
function getIrTaskAwaitedTypeRust(type: Readonly<IrType>, context: EmitContext): Readonly<IrType> {
  if (type.kind !== 'named' || type.reference.kind !== 'ambient' || type.reference.name !== 'Promise') {
    emissionError(context, 'an async function must return a task type');
  }
  const awaited = type.typeArguments[0];
  if (type.typeArguments.length !== 1 || !awaited) {
    emissionError(context, 'a task type requires one awaited type argument');
  }
  return awaited;
}

// Rust distinguishes a method that observes its receiver from one that changes it, and the two are
// not interchangeable to a caller. Taking `&mut self` everywhere is the conservative choice that
// makes every method exclusive, so a shared read of one value blocks a read of another. The mutation
// evidence is already in the body: an assignment whose target reaches `this`, or a bare rebinding of
// it, is what requires exclusivity.
// Which methods need an exclusive receiver. Writing through `this` is the direct case; calling a
// method that writes is the transitive one, and missing it emits a `&self` method that calls a
// `&mut self` method — which Rust rejects. The relation is closed to a fixed point because a caller
// of a caller needs the same receiver.
// Keyed by the name the method is emitted under, not the name it was written under: a getter and a
// setter share one source name and Rust gives them two, so keying by the source name would hand the
// getter the setter's mutable receiver.
function getIrClassMutatingMethodNamesRust(declaration: Readonly<IrClassDeclaration>): ReadonlySet<string> {
  const mutating = new Set(
    declaration.methods
      .filter((method) => hasIrFunctionSignatureThisMutationRust(method))
      .map((method) => getIrClassMethodTargetNameRust(method)),
  );
  const calls = new Map(
    declaration.methods.map(
      (method) => [getIrClassMethodTargetNameRust(method), getIrFunctionSignatureSelfCallNamesRust(method)] as const,
    ),
  );
  let changed = true;
  while (changed) {
    changed = false;
    for (const method of declaration.methods) {
      const target = getIrClassMethodTargetNameRust(method);
      if (mutating.has(target)) continue;
      if ((calls.get(target) ?? []).some((name) => mutating.has(safeRustValueName(name)))) {
        mutating.add(target);
        changed = true;
      }
    }
  }
  return mutating;
}

function getIrFunctionSignatureSelfCallNamesRust(
  method: Readonly<{ body: readonly Readonly<IrStatement>[] }>,
): string[] {
  const names: string[] = [];
  const observer = {
    expression(expression: Readonly<IrExpression>) {
      if (
        expression.kind === 'call' &&
        expression.callee.kind === 'property' &&
        expression.callee.object.kind === 'identifier' &&
        expression.callee.object.reference.kind === 'this'
      ) {
        names.push(expression.callee.name);
      }
      return undefined;
    },
  };
  method.body.forEach((statement) => analyzeIrStatementSubtreeTraversal(statement, observer));
  return names;
}

function hasIrFunctionSignatureThisMutationRust(method: Readonly<{ body: readonly Readonly<IrStatement>[] }>): boolean {
  let mutates = false;
  const reachesThis = (expression: Readonly<IrExpression>): boolean => {
    if (expression.kind === 'identifier') return expression.reference.kind === 'this';
    if (expression.kind === 'property' || expression.kind === 'element') return reachesThis(expression.object);
    return false;
  };
  const observer = {
    expression(expression: Readonly<IrExpression>) {
      // An assignment and an update both write through their target. `this.count++` is a mutation
      // as much as `this.count = 1`, and the untyped walk this replaced missed it entirely.
      const target =
        expression.kind === 'assignment'
          ? expression.left
          : expression.kind === 'unary'
            ? expression.operand
            : undefined;
      if (!target || !reachesThis(target)) return undefined;
      mutates = true;
      return false;
    },
  };
  method.body.forEach((statement) => analyzeIrStatementSubtreeTraversal(statement, observer));
  return mutates;
}

function emitFunction(declaration: Readonly<IrFunctionDeclaration>, outer: EmitContext): string[] {
  const context: EmitContext = {
    ...outer,
    enclosingReturnType: declaration.returns,
    returnsAbsent: hasIrTypeAbsentMember(declaration.returns),
  };
  for (const parameter of declaration.parameters) {
    if (parameter.type.kind === 'function') context.callbackBindingIds.add(parameter.binding.id);
  }
  // Rust has native suspension, so it declines the neutral state-machine lowering that Haxe elects
  // and emits `async fn` instead. The awaited type of an async function is its return type: the
  // future is implied by `async`, so the task wrapper is dropped rather than named.
  return [
    `${declaration.exported ? 'pub ' : ''}${declaration.async ? 'async ' : ''}fn ${getBindingTargetNameRust(declaration.binding, context)}${emitTypeParameters(declaration.typeParameters, context)}(${declaration.parameters.map((parameter) => emitParameter(parameter, context)).join(', ')}) -> ${emitType(declaration.async ? getIrTaskAwaitedTypeRust(declaration.returns, context) : declaration.returns, context)} {`,
    ...indentSourceLines([
      ...declaration.parameters.flatMap((parameter) =>
        parameter.initializer
          ? [
              `let ${getBindingTargetNameRust(parameter.binding, context)} = ${getBindingTargetNameRust(parameter.binding, context)}.unwrap_or_else(|| ${emitExpression(parameter.initializer, context)});`,
            ]
          : [],
      ),
      ...emitStatements(declaration.body, context),
    ]),
    '}',
  ];
}

function emitImports(imports: readonly IrImport[], context: EmitContext): string[] {
  const lines = new Set<string>();
  for (const imported of imports) {
    if (imported.bindings.length === 0) continue;
    const module = rustImportModule(imported.specifier, context);
    const names = imported.bindings.map((binding) => {
      if (binding.imported === '*' || binding.imported === 'default') {
        emissionError(context, `${binding.imported} imports require explicit Rust mapping for ${imported.specifier}`);
      }
      const importedName =
        binding.binding.space === 'type' || /^[A-Z]/u.test(binding.imported)
          ? safeRustTypeName(binding.imported)
          : safeRustValueName(binding.imported);
      const localName = getBindingTargetNameRust(binding.binding, context);
      return importedName === localName ? importedName : `${importedName} as ${localName}`;
    });
    lines.add(`use ${module}::${emitUseTreeRust(names.sort())};`);
  }
  return [...lines].sort();
}

// A facade module names what it re-exports and where it came from, which is exactly what Rust's
// `pub use` says. The name a target spells it by depends on which space it lives in, so a re-export
// carries the same value-versus-type decision an import does.
function emitReexportsRust(exports: readonly IrExport[], context: EmitContext): string[] {
  const lines = new Set<string>();
  for (const exported of exports) {
    if (exported.kind === 'local') continue;
    if (exported.kind !== 'reexport') {
      emissionError(context, `${exported.kind} exports require Rust module-facade lowering`);
    }
    const module = rustImportModule(exported.specifier, context);
    const source =
      exported.typeOnly || /^[A-Z]/u.test(exported.imported)
        ? safeRustTypeName(exported.imported)
        : safeRustValueName(exported.imported);
    const target =
      exported.typeOnly || /^[A-Z]/u.test(exported.exported)
        ? safeRustTypeName(exported.exported)
        : safeRustValueName(exported.exported);
    lines.add(`pub use ${module}::${emitUseTreeRust([source === target ? source : `${source} as ${target}`])};`);
  }
  return [...lines].sort();
}

function emitInterface(declaration: Readonly<IrInterfaceDeclaration>, context: EmitContext): string[] {
  if (declaration.extends.length > 0)
    emissionError(context, `interface ${declaration.binding.name} inheritance requires record flattening`);
  // A shape a class implements is a contract on behaviour, which Rust spells as a trait. A shape
  // nothing implements is data, which Rust spells as a struct — and emitting the second as the first
  // would make an ordinary object type unconstructible.
  if (hasIrModuleClassImplementingRust(declaration, context)) {
    return emitTraitRust(declaration, context);
  }
  return emitRecord(
    getBindingTargetNameRust(declaration.binding, context),
    declaration.properties,
    declaration.typeParameters,
    declaration.exported,
    context,
  );
}

function emitTraitRust(declaration: Readonly<IrInterfaceDeclaration>, context: EmitContext): string[] {
  const visibility = declaration.exported ? 'pub ' : '';
  return [
    `${visibility}trait ${getBindingTargetNameRust(declaration.binding, context)}${emitTypeParameters(declaration.typeParameters, context)} {`,
    ...declaration.properties.map((property) => {
      // A Rust trait holds no data, so a data property becomes the accessor that reads it. Fields and
      // methods live in different namespaces, so the accessor keeps the property's own name.
      if (property.type.kind !== 'function') {
        if (property.optional) {
          return emissionError(
            context,
            `interface ${declaration.binding.name} property ${property.name} requires Rust optional accessor lowering`,
          );
        }
        return `  fn ${safeRustValueName(property.name)}(&self) -> ${emitType(property.type, context)};`;
      }
      const parameters = property.type.parameters
        .map(
          (parameter, index) =>
            `${safeRustValueName(parameter.name ?? `argument${String(index)}`)}: ${emitType(parameter.type, context)}`,
        )
        .join(', ');
      return `  fn ${safeRustValueName(property.name)}(&self${parameters ? `, ${parameters}` : ''}) -> ${emitType(property.type.returns, context)};`;
    }),
    '}',
  ];
}

function hasIrModuleClassImplementingRust(
  declaration: Readonly<IrInterfaceDeclaration>,
  context: EmitContext,
): boolean {
  return context.module.declarations.some(
    (candidate) =>
      candidate.kind === 'class' &&
      candidate.implements.some(
        (implemented) =>
          implemented.kind === 'named' &&
          implemented.reference.kind === 'binding' &&
          implemented.reference.binding.id === declaration.binding.id,
      ),
  );
}

function emitConstructorReferenceRust(reference: Readonly<IrIdentifierReference>, context: EmitContext): string {
  if (reference.kind === 'super') emissionError(context, 'super cannot be used as a Rust constructor value');
  if (reference.kind === 'this') emissionError(context, 'this cannot be used as a Rust constructor');
  if (reference.kind !== 'ambient') return getBindingTargetNameRust(reference.binding, context);
  const targetName = getCompilerRuntimeExternalSymbolTargetRust(reference.name, 'value');
  if (!targetName) emissionError(context, `external constructor ${reference.name} has no Rust binding`);
  return isCompilerRuntimeExternalSymbolProvidedRust(reference.name, 'value')
    ? recordRuntimeTypeRust(targetName, context)
    : targetName;
}

function assertIrConstructorInvocationAbiRust(
  expression: Readonly<Extract<IrExpression, { kind: 'new' }>>,
  context: EmitContext,
): void {
  if (expression.callee.kind === 'identifier' && expression.callee.reference.kind === 'ambient') return;
  // A class this module declares has an associated `new` whenever its constructor was lowered to one,
  // so the call is emitted; a class whose constructor was refused has nothing to call.
  if (expression.callee.kind === 'identifier' && expression.callee.reference.kind === 'binding') {
    const target = context.module.declarations.find(
      (candidate) =>
        candidate.kind === 'class' &&
        expression.callee.kind === 'identifier' &&
        expression.callee.reference.kind === 'binding' &&
        candidate.binding.id === expression.callee.reference.binding.id,
    );
    if (
      target?.kind === 'class' &&
      getIrClassConstructorFieldAssignmentsRust(
        target,
        getIrClassStatelessAbstractBaseRust(target, context) !== undefined,
      )
    ) {
      return;
    }
  }
  emissionError(context, 'class constructor calls require Rust initialization lowering');
}

function emitIdentifierReferenceRust(reference: Readonly<IrIdentifierReference>, context: EmitContext): string {
  if (reference.kind === 'super') emissionError(context, 'super requires Rust inheritance lowering');
  if (reference.kind === 'this') return 'self';
  if (reference.kind === 'ambient') {
    if (reference.name === 'undefined') {
      emissionError(context, 'undefined expressions require Rust Option-aware lowering');
    }
    const targetName = getCompilerRuntimeExternalSymbolTargetRust(reference.name, 'value');
    if (!targetName) emissionError(context, `external value ${reference.name} has no Rust binding`);
    return isCompilerRuntimeExternalSymbolProvidedRust(reference.name, 'value')
      ? recordRuntimeTypeRust(targetName, context)
      : targetName;
  }
  return getBindingTargetNameRust(reference.binding, context);
}

function emitLiteral(value: boolean | null | number | string): string {
  if (typeof value === 'string') return `${JSON.stringify(value)}.to_owned()`;
  if (value === null) return 'None';
  if (typeof value === 'number' && Number.isInteger(value)) return `${String(value)}.0`;
  return String(value);
}

function emitCallArgumentsRust(
  expression: Readonly<Extract<IrExpression, { kind: 'call' }>>,
  context: EmitContext,
): string[] {
  const signature = expression.semantics.signature;
  if (
    signature &&
    signature.restParameter === undefined &&
    typeof signature.providedArgumentCount === 'number' &&
    signature.providedArgumentCount > signature.parameterCount
  ) {
    emissionError(context, 'extra JavaScript call arguments require target-neutral erasure lowering');
  }
  const borrowed = getIrCallBorrowedPositionsRust(expression, context);
  const defaults = expression.semantics.defaultParameters;
  const optionals = expression.semantics.optionalParameters;
  if (!defaults && !optionals) {
    return expression.arguments.map((argument, index) =>
      borrowed.has(index) ? emitLentOperandRust(argument, context) : emitOwnedOperandRust(argument, context),
    );
  }
  const plan = defaults ?? optionals;
  if (!plan) return expression.arguments.map((argument) => emitOwnedOperandRust(argument, context));
  if (plan.providedArgumentCount === 'dynamic') {
    emissionError(context, 'spread calls into optional or default parameters require Rust ABI expansion lowering');
  }
  if (expression.arguments.length > plan.parameterCount) {
    emissionError(context, 'extra JavaScript call arguments require Rust ABI erasure lowering');
  }
  const wrapped = new Set([...(defaults?.defaulted ?? []), ...(optionals?.optional ?? [])]);
  const defaultProvided = new Map(defaults?.provided.map((provided) => [provided.position, provided]) ?? []);
  const optionalProvided = new Map(optionals?.provided.map((provided) => [provided.position, provided]) ?? []);
  return Array.from({ length: plan.parameterCount }, (_, index) => {
    const argument = expression.arguments[index];
    if (!argument) {
      if (!wrapped.has(index)) {
        emissionError(context, `missing required call argument at position ${String(index)}`);
      }
      return 'None';
    }
    const providedEvidence = defaultProvided.get(index) ?? optionalProvided.get(index);
    if (providedEvidence?.value === 'undefined' || argument.kind === 'undefinedValue') return 'None';
    const emitted = emitExpression(argument, context);
    const optionalEvidence = optionalProvided.get(index);
    if (optionalEvidence && hasIrTypeNullMemberRust(optionalEvidence.parameterType)) {
      return isNullableType(optionalEvidence.argumentType) ? `Some(${emitted})` : `Some(Some(${emitted}))`;
    }
    if (
      optionalEvidence &&
      isNullableType(optionalEvidence.parameterType) &&
      isNullableType(optionalEvidence.argumentType)
    ) {
      return emitted;
    }
    return wrapped.has(index) ? `Some(${emitted})` : emitted;
  });
}

function emitOptionalCallExpressionRust(
  expression: Readonly<Extract<IrExpression, { kind: 'call' }>>,
  context: EmitContext,
): string {
  const semantics = expression.semantics.optionalChain;
  if (!semantics) emissionError(context, 'optional call lacks neutral optional-chain evidence');
  const arguments_ = emitCallArgumentsRust(expression, context).join(', ');
  const callee = emitExpression(expression.callee, context);
  if (semantics.receiverNullish === 'excluded') return `${callee}(${arguments_})`;
  getIrTypeOptionalPayloadRust(semantics.receiverType, 'optional call receiver', context);
  const operation = isNullableType(semantics.valueType) ? 'and_then' : 'map';
  return `${callee}.as_ref().${operation}(|optional_chain_value| optional_chain_value(${arguments_}))`;
}

function emitOptionalElementExpressionRust(
  expression: Readonly<Extract<IrExpression, { kind: 'element' }>>,
  context: EmitContext,
): string {
  const semantics = expression.semantics.optionalChain;
  if (!semantics) emissionError(context, 'optional element access lacks neutral optional-chain evidence');
  if (semantics.receiverNullish === 'excluded') {
    return emitRequiredElementExpressionRust(expression, context);
  }
  const receiver = getIrTypeOptionalPayloadRust(semantics.receiverType, 'optional element receiver', context);
  const object = emitExpression(expression.object, context);
  const value = 'optional_chain_value';
  if (receiver.kind === 'tuple') {
    const index = getElementAccessTupleIndexRust(expression, context);
    const operation = receiver.elements[index]?.optional ? 'and_then' : 'map';
    return `${object}.as_ref().${operation}(|${value}| ${value}.${String(index)}.clone())`;
  }
  if (receiver.kind === 'array') {
    return `${object}.as_ref().and_then(|${value}| ${value}.get(${emitExpression(expression.index, context)} as usize).cloned())`;
  }
  emissionError(context, 'optional element access requires array or fixed-tuple receiver evidence');
}

function emitOptionalPropertyExpressionRust(
  expression: Readonly<Extract<IrExpression, { kind: 'property' }>>,
  context: EmitContext,
): string {
  const semantics = expression.optionalChain;
  if (!semantics) emissionError(context, 'optional property access lacks neutral optional-chain evidence');
  const object = emitExpression(expression.object, context);
  const property = safeRustValueName(expression.name);
  if (semantics.receiverNullish === 'excluded') {
    // Indexing yields a place the caller does not own, so the field read out of it is a copy.
    const owned = expression.object.kind === 'element' ? '.clone()' : '';
    return `${object}${isAmbientIdentifier(expression.object) ? '::' : '.'}${property}${owned}`;
  }
  getIrTypeOptionalPayloadRust(semantics.receiverType, 'optional property receiver', context);
  const operation = isNullableType(semantics.valueType) ? 'and_then' : 'map';
  return `${object}.as_ref().${operation}(|optional_chain_value| optional_chain_value.${property}.clone())`;
}

function emitRequiredElementExpressionRust(
  expression: Readonly<Extract<IrExpression, { kind: 'element' }>>,
  context: EmitContext,
): string {
  if (expression.semantics.receivers.includes('object')) {
    emissionError(context, 'computed object access requires JavaScript property-key coercion lowering');
  }
  if (expression.semantics.receivers.includes('tuple')) {
    const index = getElementAccessTupleIndexRust(expression, context);
    return `${emitExpression(expression.object, context)}.${String(index)}`;
  }
  return `${emitExpression(expression.object, context)}[${emitExpression(expression.index, context)} as usize]`;
}

function getIrTypeOptionalPayloadRust(type: Readonly<IrType>, subject: string, context: EmitContext): Readonly<IrType> {
  if (type.kind !== 'union') emissionError(context, `${subject} requires one concrete Rust Option payload`);
  const concrete = type.types.filter((member) => member.kind !== 'null' && member.kind !== 'undefined');
  if (concrete.length !== 1) emissionError(context, `${subject} requires one concrete Rust Option payload`);
  return concrete[0]!;
}

function emitObjectRestExpressionRust(
  expression: Readonly<Extract<IrExpression, { kind: 'objectRest' }>>,
  context: EmitContext,
): string {
  if (expression.excluded.some((key) => key.kind === 'computed')) {
    emissionError(context, 'computed object rest requires Rust property-key and record projection lowering');
  }
  if (expression.type.kind !== 'object') {
    emissionError(context, 'object rest requires closed residual-record type evidence');
  }
  const shape = createIrObjectTypeShapeIdentity(expression.type.properties);
  const existing = context.objectRestRecords.get(shape);
  const recordName = existing?.name ?? getGeneratedTargetNameRust('ObjectRestRecord', context);
  if (!existing) context.objectRestRecords.set(shape, { name: recordName, properties: expression.type.properties });
  const object = emitExpression(expression.object, context);
  const fields = expression.type.properties.map((property) => {
    const name = safeRustValueName(property.name);
    return {
      initializer: `${name}: ${object}.${name}.clone(),`,
    };
  });
  return `${recordName} { ${fields.map((field) => field.initializer).join(' ')} }`;
}

function emitObjectExpressionRust(
  expression: Readonly<Extract<IrExpression, { kind: 'object' }>>,
  context: EmitContext,
): string {
  const target = emitType(expression.type, context);
  const properties = getIrObjectConstructionPropertiesRust(expression.type, context);
  const members = expression.members.filter(
    (member): member is Extract<IrObjectMember, { kind: 'property' }> => member.kind === 'property',
  );
  const names = new Set<string>();
  const fields = members.map((member) => {
    names.add(member.name);
    const property = properties?.find((candidate) => candidate.name === member.name);
    const value = emitExpression(member.value, context);
    return `${safeRustValueName(member.name)}: ${property?.optional ? `Some(${value})` : value},`;
  });
  for (const property of properties ?? []) {
    if (names.has(property.name)) continue;
    fields.push(`${safeRustValueName(property.name)}: None,`);
  }
  return `${target} { ${fields.join(' ')} }`;
}

function getIrObjectConstructionPropertiesRust(
  type: Readonly<IrType>,
  context: EmitContext,
): readonly IrObjectTypeProperty[] | undefined {
  if (type.kind === 'object') return type.properties;
  if (type.kind !== 'named' || type.reference.kind !== 'binding' || type.reference.path.length > 0) return undefined;
  const bindingId = type.reference.binding.id;
  const declaration = context.module.declarations.find(
    (candidate) =>
      (candidate.kind === 'interface' || candidate.kind === 'typeAlias') && candidate.binding.id === bindingId,
  );
  if (declaration?.kind === 'interface') return declaration.properties;
  return declaration?.kind === 'typeAlias' && declaration.type.kind === 'object'
    ? declaration.type.properties
    : undefined;
}

function getIrObjectTypeTargetNameRust(properties: readonly IrObjectTypeProperty[], context: EmitContext): string {
  const shape = createIrObjectTypeShapeIdentity(properties);
  const existing = context.anonymousObjectRecords.get(shape);
  if (existing) return existing.name;
  const name = getGeneratedTargetNameRust('AnonymousObjectRecord', context);
  context.anonymousObjectRecords.set(shape, { name, properties });
  return name;
}

// A value Rust moves is invalidated at the site that consumes it, so a binding the source still
// needs afterwards is cloned into the consuming position rather than handed over. Every emitted
// record derives `Clone`, so this is always available. The election is per binding rather than per
// use, so the last consumption clones as well: correct, at the cost of one copy the source did not
// need, and a binding consumed once is left to move.
function emitOwnedOperandRust(expression: Readonly<IrExpression>, context: EmitContext): string {
  const source = emitExpression(expression, context);
  if (
    expression.kind === 'identifier' &&
    expression.reference.kind === 'binding' &&
    context.movedBindingIds.has(expression.reference.binding.id)
  )
    return `${source}.clone()`;
  if (expression.kind === 'element' && !expression.optional && expression.semantics.receivers.includes('array'))
    return `${source}.clone()`;
  return source;
}

function emitReturnedExpressionRust(expression: Readonly<IrExpression>, context: EmitContext): string {
  const source = emitExpression(expression, context);
  if (expression.kind === 'element' && !expression.optional && expression.semantics.receivers.includes('array'))
    return `${source}.clone()`;
  if (context.enclosingReturnType?.kind === 'function' && expression.kind === 'function') {
    context.needsRcImport.add('Rc');
    return `Rc::new(${source})`;
  }
  return source;
}

// A value lent to a callee that mutates through it. An argument that is already a mutable borrow is
// passed as it stands, because Rust reborrows it: taking a reference to it again would hand the
// callee a reference to the reference.
function emitLentOperandRust(expression: Readonly<IrExpression>, context: EmitContext): string {
  const source = emitExpression(expression, context);
  return expression.kind === 'identifier' &&
    expression.reference.kind === 'binding' &&
    context.referentMutatedParameterIds.has(expression.reference.binding.id)
    ? source
    : `&mut ${source}`;
}

// A closure an iterator adaptor hands a reference to. The source wrote it for the element, so the
// reference is destructured away at the binding — which Rust allows for a value it can copy, and
// which is why an element it cannot copy is refused rather than silently borrowed.
function emitBorrowedElementClosureRust(expression: Readonly<IrExpression> | undefined, context: EmitContext): string {
  if (expression?.kind !== 'function') {
    return emissionError(context, 'filtering requires a closure written where the predicate is passed');
  }
  const parameters = expression.parameters.map((parameter, index) => {
    if (index > 0) return getBindingTargetNameRust(parameter.binding, context);
    if (!isIrTypeCopyValueRust(parameter.type)) {
      emissionError(context, 'filtering an element Rust cannot copy requires a borrowed predicate lowering');
    }
    return `&${getBindingTargetNameRust(parameter.binding, context)}`;
  });
  const body = expression.expression
    ? normalizeSourceTextGrouping(emitExpression(expression.expression, context))
    : `{\n${indentSourceLines(emitStatements(expression.body, context)).join('\n')}\n}`;
  return `|${parameters.join(', ')}| ${body}`;
}

function isIrTypeCopyValueRust(type: Readonly<IrType>): boolean {
  return type.kind === 'primitive' && (type.name === 'boolean' || type.name === 'number');
}

// An index, in the form Rust counts with. A literal whole number is written as one; anything else is
// a value in the neutral numeric type and has to be converted.
function emitIndexOperandRust(expression: Readonly<IrExpression>, context: EmitContext): string {
  return expression.kind === 'literal' && typeof expression.value === 'number' && Number.isInteger(expression.value)
    ? String(expression.value)
    : `${emitExpression(expression, context)} as usize`;
}

function emitBorrowedNarrowedReceiverRust(object: Readonly<IrExpression>, context: EmitContext): string | undefined {
  if (object.kind !== 'identifier' || object.reference.kind !== 'binding') return undefined;
  if (object.presence !== 'narrowedPresent') return undefined;
  if (!context.nullableBindingIds.has(object.reference.binding.id)) return undefined;
  return `${emitIdentifierReferenceRust(object.reference, context)}.as_ref().unwrap()`;
}

// A value on its way into a binding that can hold nothing. The source language stores a value and an
// absence in one place without saying so; Rust's `Option` says so, and a present value has to be
// wrapped to enter it. A value that is already optional passes through: it is already the shape.
function emitOptionalTargetOperandRust(
  target: Readonly<IrExpression>,
  value: Readonly<IrExpression>,
  context: EmitContext,
): string {
  const source = emitExpression(value, context);
  if (target.kind !== 'identifier' || target.reference.kind !== 'binding') return source;
  if (!context.nullableBindingIds.has(target.reference.binding.id)) return source;
  const alreadyOptional =
    isIrExpressionOptionShapedRust(value) ||
    (value.kind === 'identifier' &&
      value.reference.kind === 'binding' &&
      context.nullableBindingIds.has(value.reference.binding.id));
  return alreadyOptional ? source : `Some(${source})`;
}

// Text in a position Rust borrows rather than owns. A literal is already a `&str` before it is
// owned, so the ownership is simply not taken; anything else is borrowed from the value it names.
function emitBorrowedTextRust(expression: Readonly<IrExpression>, context: EmitContext): string {
  return expression.kind === 'literal' && typeof expression.value === 'string'
    ? JSON.stringify(expression.value)
    : `&${emitExpression(expression, context)}`;
}

// A constructor that does nothing but fill its own fields is a Rust struct literal, which is the one
// constructor shape Rust has. The body must assign every instance field exactly once and read none of
// them back: a field literal cannot see a field the same literal is still building.
function getIrClassConstructorFieldAssignmentsRust(
  declaration: Readonly<IrClassDeclaration>,
  statelessBase: boolean,
): ReadonlyArray<{ name: string; value: Readonly<IrExpression> }> | undefined {
  const constructor = declaration.classConstructor;
  const instanceFields = declaration.fields.filter((field) => !field.static);
  if (!constructor || instanceFields.length === 0) return undefined;
  if (instanceFields.some((field) => field.initializer)) return undefined;
  const assigned: Array<{ name: string; value: Readonly<IrExpression> }> = [];
  for (const statement of constructor.body) {
    // A base that holds no state has nothing to initialize, so the call that would have initialized
    // it does nothing and leaves nothing for the struct literal to say.
    if (statelessBase && isIrStatementSuperConstructorCallRust(statement)) continue;
    if (statement.kind !== 'expression' || statement.expression.kind !== 'assignment') return undefined;
    const { left, operator, right } = statement.expression;
    if (operator !== '=' || left.kind !== 'property' || left.object.kind !== 'identifier') return undefined;
    if (left.object.reference.kind !== 'this' || left.optional) return undefined;
    if (assigned.some((field) => field.name === left.name)) return undefined;
    if (hasIrExpressionThisReferenceRust(right)) return undefined;
    assigned.push({ name: left.name, value: right });
  }
  return assigned.length === instanceFields.length &&
    instanceFields.every((field) => assigned.some((entry) => entry.name === field.name))
    ? assigned
    : undefined;
}

function isIrStatementSuperConstructorCallRust(statement: Readonly<IrStatement>): boolean {
  return (
    statement.kind === 'expression' &&
    statement.expression.kind === 'call' &&
    statement.expression.callee.kind === 'identifier' &&
    statement.expression.callee.reference.kind === 'super'
  );
}

function hasIrExpressionThisReferenceRust(expression: Readonly<IrExpression>): boolean {
  let found = false;
  analyzeIrStatementSubtreeTraversal(
    { expression, kind: 'expression' },
    {
      expression(node) {
        if (node.kind === 'identifier' && node.reference.kind === 'this') found = true;
        return undefined;
      },
    },
  );
  return found;
}

function emitParameter(parameter: Readonly<IrParameter>, context: EmitContext): string {
  // The source mutates what this parameter names, and the caller sees the change. Moving the value in
  // would mutate a copy and drop it — the same source, a different meaning — so the parameter is
  // borrowed mutably and every call site lends rather than gives.
  if (context.referentMutatedParameterIds.has(parameter.binding.id)) {
    if (parameter.initializer || parameter.optional || parameter.rest) {
      emissionError(
        context,
        `parameter ${parameter.binding.name} is mutated through and cannot also be optional or variadic in Rust`,
      );
    }
    return `${getBindingTargetNameRust(parameter.binding, context)}: &mut ${emitType(parameter.type, context)}`;
  }
  // A parameter the body assigns to is a local binding in Rust as much as in the source language, and
  // Rust will not accept the assignment without `mut`. Emitting it unconditionally would instead earn
  // an unused-mut warning on every parameter that is only read.
  const binding = `${context.reboundBindingIds.has(parameter.binding.id) ? 'mut ' : ''}${getBindingTargetNameRust(parameter.binding, context)}`;
  if (parameter.initializer) {
    return `${binding}: Option<${emitType(parameter.type, context)}>`;
  }
  if (parameter.optional) {
    const type = emitType(parameter.type, context);
    if (hasIrTypeNullMemberRust(parameter.type) && hasIrTypeUndefinedMemberRust(parameter.type)) {
      emissionError(context, 'optional parameters containing both null and undefined require distinct Rust sentinels');
    }
    const optionalType =
      hasIrTypeUndefinedMemberRust(parameter.type) && !hasIrTypeNullMemberRust(parameter.type)
        ? type
        : `Option<${type}>`;
    return `${binding}: ${optionalType}`;
  }
  if (parameter.rest) return `${binding}: ${emitType(parameter.type, context)}`;
  return `${binding}: ${emitType(parameter.type, context)}`;
}

function emitRecord(
  targetName: string,
  properties: readonly IrObjectTypeProperty[],
  typeParameters: readonly IrTypeParameter[],
  exported: boolean,
  context: EmitContext,
): string[] {
  // A record a public function names has to be at least as visible as that function, and a record
  // the source did not export is still named by one often enough that hiding it only produces a
  // private-interface warning. What leaves the crate is the crate root's decision, not this module's.
  void exported;
  const lines = ['#[derive(Clone, Debug)]', `pub struct ${targetName}${emitTypeParameters(typeParameters, context)} {`];
  for (const property of properties) {
    const type = emitType(property.type, context);
    lines.push(`  pub ${safeRustValueName(property.name)}: ${property.optional ? `Option<${type}>` : type},`);
  }
  lines.push('}');
  return lines;
}

function emitStatementValueExpressionRust(
  expression: Readonly<Extract<IrExpression, { kind: 'call' }>>,
  context: EmitContext,
): string {
  if (expression.callee.kind !== 'function' || expression.arguments.length > 0) {
    emissionError(context, 'statement-value call requires a zero-argument function carrier');
  }
  const completion = expression.callee.body.at(-1);
  if (completion?.kind !== 'return' || !completion.expression) {
    emissionError(context, 'statement-value call requires a final value return');
  }
  const statements = emitStatements(expression.callee.body.slice(0, -1), context);
  return `{ ${[...statements, emitExpression(completion.expression, context)].join(' ')} }`;
}

function emitStatement(statement: Readonly<IrStatement>, context: EmitContext): string[] {
  switch (statement.kind) {
    case 'block':
      return [
        `${emitControlFlowLabelRust(statement.label)}{`,
        ...indentSourceLines(emitStatements(statement.statements, context)),
        '}',
      ];
    case 'break':
      return [`break${statement.target ? ` ${emitControlFlowTargetRust(statement.target)}` : ''};`];
    case 'continue':
      return [`continue${statement.target ? ` ${emitControlFlowTargetRust(statement.target)}` : ''};`];
    case 'do':
      return [
        `${emitControlFlowLabelRust(statement.label)}loop {`,
        ...indentSourceLines(emitStatementBody(statement.body, context)),
        `  if !(${emitExpression(statement.condition, context)}) { break; }`,
        '}',
      ];
    case 'expression':
      return [`${emitExpression(statement.expression, context)};`];
    case 'for':
      emissionError(context, 'C-style for loops require control-flow lowering before Rust emission');
    case 'forIn':
      if ('pattern' in statement.variable)
        emissionError(context, 'binding patterns require destructuring lowering before Rust emission');
      if (!statement.keyPlan) {
        emissionError(context, 'object key iteration requires closed key evidence');
      }
      if (statement.keyPlan.evaluation === 'preserve') {
        emissionError(context, 'effectful object key iteration requires Rust structural-object evaluation lowering');
      }
      return [
        `${emitControlFlowLabelRust(statement.label)}for ${statement.variable.mutable ? 'mut ' : ''}${getBindingTargetNameRust(statement.variable.binding, context)} in [${statement.keyPlan.keys.map((key) => `${JSON.stringify(key)}.to_owned()`).join(', ')}] {`,
        ...indentSourceLines(emitStatementBody(statement.body, context)),
        '}',
      ];
    case 'forOf': {
      if (statement.await) emissionError(context, 'async iteration requires Flight task lowering');
      if ('pattern' in statement.variable)
        emissionError(context, 'binding patterns require destructuring lowering before Rust emission');
      const iterableRust = emitExpression(statement.iterable, context);
      const borrowPrefix = statement.iterable.kind === 'element' ? '&' : '';
      return [
        `${emitControlFlowLabelRust(statement.label)}for ${statement.variable.mutable ? 'mut ' : ''}${getBindingTargetNameRust(statement.variable.binding, context)} in ${borrowPrefix}${iterableRust} {`,
        ...indentSourceLines(emitStatementBody(statement.body, context)),
        '}',
      ];
    }
    case 'if': {
      const lines = [
        `if ${normalizeSourceTextGrouping(emitExpression(statement.condition, context))} {`,
        ...indentSourceLines(emitStatementBody(statement.consequent, context)),
        '}',
      ];
      if (statement.otherwise)
        lines.push('else {', ...indentSourceLines(emitStatementBody(statement.otherwise, context)), '}');
      return lines;
    }
    case 'return':
      // Comparing against `None` is not narrowing. Returning a binding that can be absent from a
      // function that cannot return one is Rust that does not compile, so it refuses here.
      if (
        !context.returnsAbsent &&
        statement.expression?.kind === 'identifier' &&
        statement.expression.reference.kind === 'binding' &&
        statement.expression.presence !== 'narrowedPresent' &&
        context.nullableBindingIds.has(statement.expression.reference.binding.id)
      ) {
        emissionError(context, 'returning a nullable binding requires Rust narrowing evidence');
      }
      return [
        `return${statement.expression ? ` ${normalizeSourceTextGrouping(emitReturnedExpressionRust(statement.expression, context))}` : ''};`,
      ];
    case 'switch': {
      const name = getGeneratedTargetNameRust('switch_value', context);
      const cases = statement.cases.filter((switchCase) => switchCase.expression);
      const otherwise = statement.cases.find((switchCase) => !switchCase.expression);
      const lines = [`let ${name} = ${emitExpression(statement.expression, context)};`];
      cases.forEach((switchCase, index) => {
        lines.push(
          `${index > 0 ? 'else ' : ''}if ${name} == ${emitExpression(switchCase.expression!, context)} {`,
          ...indentSourceLines(emitIrSwitchCaseStatementsRust(switchCase, statement.label, context)),
          '}',
        );
      });
      if (otherwise) {
        if (cases.length > 0) lines.push('else {');
        lines.push(
          ...indentSourceLines(
            emitIrSwitchCaseStatementsRust(otherwise, statement.label, context),
            cases.length > 0 ? 1 : 0,
          ),
        );
        if (cases.length > 0) lines.push('}');
      } else if (cases.length > 0) {
        lines.push('else {', '  unreachable!();', '}');
      }
      return [`${emitControlFlowLabelRust(statement.label)}{`, ...indentSourceLines(lines), '}'];
    }
    case 'throw':
      return [`panic!("{:?}", ${emitExpression(statement.expression, context)});`];
    case 'try':
      // Rust has no exceptions. The faithful shape is `Result` propagation, which means the runtime
      // contract has to say that a task settles with a rejection rather than yielding its value
      // directly — a runtime-surface decision, not a lowering this compiler can pick on its own.
      emissionError(context, 'try/catch/finally requires a Rust task settlement that carries rejection');
    case 'variable':
      return statement.declarations.map((variable) => emitVariable(variable, context));
    case 'while':
      // Rust spells a loop with no exit condition `loop`, and warns on `while true` because the two
      // differ to the borrow checker: only `loop` tells it the body always runs.
      const condition = normalizeSourceTextGrouping(emitExpression(statement.condition, context));
      return [
        `${emitControlFlowLabelRust(statement.label)}${condition === 'true' ? 'loop' : `while ${condition}`} {`,
        ...indentSourceLines(emitStatementBody(statement.body, context)),
        '}',
      ];
  }
}

function emitIrSwitchCaseStatementsRust(
  switchCase: Readonly<IrSwitchCase>,
  switchLabel: Readonly<IrControlFlowLabelIdentity> | undefined,
  context: EmitContext,
): string[] {
  const last = switchCase.statements.at(-1);
  const localBreak = last?.kind === 'break' && (!last.target || (switchLabel && last.target.id === switchLabel.id));
  return emitStatements(localBreak ? switchCase.statements.slice(0, -1) : switchCase.statements, context);
}

function emitControlFlowLabelRust(label: Readonly<IrControlFlowLabelIdentity> | undefined): string {
  return label ? `${emitControlFlowTargetRust(label)}: ` : '';
}

function emitControlFlowTargetRust(label: Readonly<IrControlFlowLabelIdentity>): string {
  return `'${safeRustValueName(label.name)}`;
}

function emitStatementBody(statement: Readonly<IrStatement>, context: EmitContext): string[] {
  return statement.kind === 'block'
    ? emitStatements(statement.statements, context)
    : emitStatements([statement], context);
}

function emitStatements(statements: readonly IrStatement[], context: EmitContext): string[] {
  return statements.flatMap((statement) => emitStatement(statement, context));
}

function emitType(type: Readonly<IrType>, context: EmitContext): string {
  switch (type.kind) {
    case 'array':
      return `Vec<${emitType(type.element, context)}>`;
    case 'function': {
      const parameters = type.parameters.map((parameter) => emitType(parameter.type, context));
      return `${recordRuntimeTypeRust('FlightCallback', context)}<(${parameters.join(', ')}${parameters.length === 1 ? ',' : ''}), ${emitType(type.returns, context)}>`;
    }
    case 'indexedAccess':
    case 'keyof':
    case 'typeOf':
      return opaqueHostType(context);
    case 'intersection':
      emissionError(context, 'intersection types require Rust record or trait lowering');
    case 'literal':
      return typeof type.value === 'boolean' ? 'bool' : typeof type.value === 'number' ? 'f64' : 'String';
    case 'named': {
      const sourceName = type.reference.kind === 'ambient' ? type.reference.name : undefined;
      if ((sourceName === 'Readonly' || sourceName === 'Required') && type.typeArguments[0]) {
        return emitType(type.typeArguments[0], context);
      }
      if (sourceName === 'Partial' && type.typeArguments[0])
        emissionError(context, 'Partial<T> requires structural field lowering');
      const mapped = getTypeReferenceTargetNameRust(type, context);
      const arguments_ = type.typeArguments.map((argument) => emitType(argument, context));
      return `${mapped}${arguments_.length > 0 ? `<${arguments_.join(', ')}>` : ''}`;
    }
    case 'never':
      return '!';
    case 'null':
    case 'undefined':
      return '()';
    case 'object':
      return getIrObjectTypeTargetNameRust(type.properties, context);
    case 'primitive':
      if (type.name === 'symbol') return recordRuntimeTypeRust('FlightSymbol', context);
      return { bigint: 'i64', boolean: 'bool', number: 'f64', string: 'String', symbol: 'FlightSymbol', void: '()' }[
        type.name
      ];
    case 'tuple': {
      const elements = type.elements.map((element) => {
        const emitted = emitType(element.type, context);
        return element.optional ? `Option<${emitted}>` : emitted;
      });
      return `(${elements.join(', ')}${elements.length === 1 ? ',' : ''})`;
    }
    case 'union': {
      const concrete = type.types.filter((item) => item.kind !== 'null' && item.kind !== 'undefined');
      if (hasIrTypeNullMemberRust(type) && hasIrTypeUndefinedMemberRust(type)) {
        emissionError(context, 'types containing both null and undefined require distinct Rust sentinels');
      }
      if (concrete.length === 1 && concrete.length !== type.types.length)
        return `Option<${emitType(concrete[0]!, context)}>`;
      const primitiveEnum = getOrCreatePrimitiveUnionEnumRust(concrete, context);
      if (primitiveEnum) return primitiveEnum.name;
      emissionError(context, 'non-nullable unions require Rust tagged-union lowering');
    }
    case 'unknown':
      return opaqueHostType(context);
  }
}

// A union of string literals is how the source language spells a closed set of names, and the source
// treats a value of it as a string everywhere: comparing it, returning it, storing it in a string
// field. Rust has no implicit conversion, so a unit-variant enum would need a coercion inserted at
// every one of those positions — type-directed work this backend does not do yet.
//
// So the set becomes the string it is made of, and the closed-ness is what is lost. Haxe keeps the
// enum because `from String to String` gives it exactly those coercions for free; that the two
// targets diverge here is a property of the targets, not an inconsistency in the compiler.
function emitStringLiteralUnionRust(declaration: Readonly<IrTypeAliasDeclaration>, context: EmitContext): string[] {
  return [
    `${declaration.exported ? 'pub ' : ''}type ${getBindingTargetNameRust(declaration.binding, context)} = String;`,
  ];
}

function emitTypeAlias(declaration: Readonly<IrTypeAliasDeclaration>, context: EmitContext): string[] {
  if (getIrUnionTypeStringLiteralValues(declaration.type)) return emitStringLiteralUnionRust(declaration, context);
  if (declaration.type.kind === 'union' && getIrUnionTypeMemberRecordsRust(declaration.type, context)) {
    return emitTaggedUnionRust(
      getBindingTargetNameRust(declaration.binding, context),
      declaration.type,
      declaration.exported,
      context,
    );
  }
  if (declaration.type.kind === 'object') {
    return emitRecord(
      getBindingTargetNameRust(declaration.binding, context),
      declaration.type.properties,
      declaration.typeParameters,
      declaration.exported,
      context,
    );
  }
  return [
    `${declaration.exported ? 'pub ' : ''}type ${getBindingTargetNameRust(declaration.binding, context)}${emitTypeParameters(declaration.typeParameters, context)} = ${emitType(declaration.type, context)};`,
  ];
}

function emitTupleSpreadExpressionRust(
  expression: Readonly<Extract<IrExpression, { kind: 'tupleSpread' }>>,
  context: EmitContext,
): string {
  const declarations: string[] = [];
  const elements: string[] = [];
  let resultIndex = 0;
  for (const segment of expression.segments) {
    if (segment.kind === 'element') {
      const target = expression.type.elements[resultIndex]!;
      if (!segment.element.expression) {
        elements.push('None');
      } else {
        const name = getGeneratedTargetNameRust('tuple_spread_element', context);
        declarations.push(`let ${name} = ${emitExpression(segment.element.expression, context)};`);
        elements.push(target.optional ? `Some(${name})` : name);
      }
      resultIndex += 1;
      continue;
    }
    segment.type.elements.forEach((element, offset) => {
      if (!isIrTypeCloneSafeRust(element.type)) {
        emissionError(
          context,
          `fixed tuple spread source index ${String(offset)} lacks clone-safe Rust ownership evidence`,
        );
      }
    });
    const name = getGeneratedTargetNameRust('tuple_spread_value', context);
    declarations.push(`let ${name} = &(${emitExpression(segment.expression, context)});`);
    segment.type.elements.forEach((element, offset) => {
      const value = `${name}.${String(offset)}.clone()`;
      const target = expression.type.elements[resultIndex + offset]!;
      elements.push(target.optional && !element.optional ? `Some(${value})` : value);
    });
    resultIndex += segment.type.elements.length;
  }
  const tuple = `(${elements.join(', ')}${elements.length === 1 ? ',' : ''})`;
  return `({ ${declarations.join(' ')} ${tuple} })`;
}

function emitTypeArguments(parameters: readonly IrTypeParameter[], context: EmitContext): string {
  return parameters.length === 0
    ? ''
    : `<${parameters.map((parameter) => getBindingTargetNameRust(parameter.binding, context)).join(', ')}>`;
}

function emitTypeParameters(parameters: readonly IrTypeParameter[], context: EmitContext): string {
  if (parameters.length === 0) return '';
  return `<${parameters
    .map((parameter) => {
      const name = getBindingTargetNameRust(parameter.binding, context);
      const bound = parameter.constraint ? emitType(parameter.constraint, context) : 'Clone';
      return `${name}: ${bound}`;
    })
    .join(', ')}>`;
}

function emitVariable(variable: Readonly<IrVariable>, context: EmitContext): string {
  if ('pattern' in variable)
    emissionError(context, 'binding patterns require destructuring lowering before Rust emission');
  if (variable.initialValue === 'undefined') {
    if (!variable.type || !isNullableType(variable.type)) {
      emissionError(context, 'observable undefined function-entry value requires a nullable Rust type domain');
    }
    return `let ${variable.mutable ? 'mut ' : ''}${getBindingTargetNameRust(variable.binding, context)}: ${emitType(variable.type, context)} = None;`;
  }
  if (variable.type?.kind === 'function') {
    context.callbackBindingIds.add(variable.binding.id);
  }
  const type =
    variable.type && !(variable.initializer?.kind === 'objectRest' && variable.type.kind === 'object')
      ? `: ${emitType(variable.type, context)}`
      : '';
  const isCallbackInitializer = variable.type?.kind === 'function' && variable.initializer?.kind === 'function';
  if (isCallbackInitializer) context.needsRcImport.add('Rc');
  const initializer = variable.initializer
    ? ` = ${normalizeSourceTextGrouping(isCallbackInitializer ? `Rc::new(${emitExpression(variable.initializer, context)})` : emitOwnedOperandRust(variable.initializer, context))}`
    : '';
  // A binding declared without a value and written once afterwards is Rust's deferred
  // initialization, not a mutation: the source hoisted the declaration above the assignment, and
  // `mut` on it would claim a rebinding that never happens.
  const deferred = !variable.initializer && context.deferredBindingIds.has(variable.binding.id);
  // Rust asks for `mut` to reach a value's own fields through a method, where the source language
  // only asks for it to rebind the name. A `const` the source mutates through is still `mut` here.
  const mutable = (variable.mutable && !deferred) || context.referentMutatedBindingIds.has(variable.binding.id);
  return `let ${mutable ? 'mut ' : ''}${getBindingTargetNameRust(variable.binding, context)}${type}${initializer};`;
}

function emitVariableDeclaration(declaration: Readonly<IrVariableDeclaration>, context: EmitContext): string[] {
  if ('pattern' in declaration)
    emissionError(context, 'binding patterns require destructuring lowering before Rust emission');
  if (!declaration.initializer || !declaration.type) {
    emissionError(context, `module variable ${declaration.binding.name} requires an initializer and type`);
  }
  if (declaration.mutable)
    emissionError(context, `mutable module variable ${declaration.binding.name} requires synchronization lowering`);
  return [
    `${declaration.exported ? 'pub ' : ''}const ${getBindingTargetNameRust(declaration.binding, context)}: ${emitType(declaration.type, context)} = ${emitExpression(declaration.initializer, context)};`,
  ];
}

function getBindingTargetNameRust(
  binding: Readonly<IrBindingIdentity | IrTypeBindingIdentity>,
  context: EmitContext,
): string {
  const targetName = context.targetNames.get(binding.id);
  if (!targetName) emissionError(context, `binding ${binding.name} has no Rust target name allocation`);
  return targetName;
}

function getGeneratedTargetNameRust(preferredName: string, context: EmitContext): string {
  let name = preferredName;
  for (let suffix = 2; context.generatedNames.has(name); suffix += 1) name = `${preferredName}_${String(suffix)}`;
  context.generatedNames.add(name);
  return name;
}

function getElementAccessTupleIndexRust(
  expression: Readonly<Extract<IrExpression, { kind: 'element' }>>,
  context: EmitContext,
): number {
  if (
    expression.semantics.receivers.length !== 1 ||
    expression.index.kind !== 'literal' ||
    typeof expression.index.value !== 'number' ||
    !Number.isSafeInteger(expression.index.value) ||
    expression.index.value < 0
  ) {
    emissionError(context, 'tuple projection requires one statically known nonnegative integer index');
  }
  return expression.index.value;
}

function getPreferredBindingNameRust(
  binding: Readonly<IrBindingIdentity | IrTypeBindingIdentity>,
  constants: ReadonlySet<string>,
): string {
  if (constants.has(binding.id)) return screamingSnakeCase(binding.name);
  return binding.space === 'type' ||
    binding.kind === 'class' ||
    binding.kind === 'enum' ||
    (binding.kind === 'import' && /^[A-Z]/u.test(binding.name))
    ? safeRustTypeName(binding.name)
    : safeRustValueName(binding.name);
}

function getTypeReferenceTargetNameRust(type: Readonly<IrTypeReference>, context: EmitContext): string {
  if (type.reference.kind === 'ambient') {
    const targetName = getCompilerRuntimeExternalSymbolTargetRust(type.reference.name, 'type');
    if (!targetName) emissionError(context, `external type ${type.reference.name} has no Rust binding`);
    return isCompilerRuntimeExternalSymbolProvidedRust(type.reference.name, 'type')
      ? recordRuntimeTypeRust(targetName, context)
      : targetName;
  }
  return [getBindingTargetNameRust(type.reference.binding, context), ...type.reference.path.map(safeRustTypeName)].join(
    '::',
  );
}

function assertStructuralObjectCompatibilityRust(
  module: Readonly<IrModule>,
  modules: readonly Readonly<IrModule>[],
  resolution: Readonly<CompilerModuleResolutionPlan> | undefined,
): void {
  const diagnostics = analyzeIrModuleStructuralObjectCompatibilityAcrossModules(
    module,
    modules,
    resolution,
  ).diagnostics;
  const diagnostic =
    diagnostics.find((candidate) => candidate.disposition !== 'indeterminate') ??
    diagnostics.find((candidate) => candidate.code !== 'unresolved-named-construction-target');
  if (diagnostic) {
    throw createBackendEmissionFailure(
      'rust',
      module,
      `structural object compatibility ${diagnostic.code} at ${JSON.stringify(diagnostic.path)}: ${diagnostic.message}`,
    );
  }
}

function replaceIrModuleBackendContext(
  modules: readonly Readonly<IrModule>[],
  replacement: Readonly<IrModule>,
): readonly Readonly<IrModule>[] {
  return modules.map((module) =>
    module.packageName === replacement.packageName &&
    module.source === replacement.source &&
    module.name === replacement.name
      ? replacement
      : module,
  );
}

function assertRuntimeExternalSymbolBindingsRust(module: Readonly<IrModule>): void {
  const completeness = analyzeCompilerRuntimeExternalSymbolCompleteness(
    collectIrModulesRuntimeExternalSymbolIdentities([module]),
    createCompilerRuntimeExternalSymbolBindingPlanRust(),
  );
  if (completeness.kind === 'complete') return;
  const problems = [
    completeness.missingExternalSymbols.length > 0
      ? `missing: ${completeness.missingExternalSymbols.map(formatRuntimeExternalSymbolIdentity).join(', ')}`
      : undefined,
    completeness.duplicateExternalSymbols.length > 0
      ? `duplicate: ${completeness.duplicateExternalSymbols.map(formatRuntimeExternalSymbolIdentity).join(', ')}`
      : undefined,
  ].filter((problem): problem is string => problem !== undefined);
  throw createBackendEmissionFailure(
    'rust',
    module,
    `runtime external symbol binding plan is incomplete (${problems.join('; ')})`,
  );
}

function assertRuntimeExternalConstructorAbiRust(module: Readonly<IrModule>): void {
  const completeness = analyzeCompilerRuntimeExternalConstructorAbiCompleteness(
    collectIrModulesRuntimeExternalConstructorInvocations([module]),
    createCompilerRuntimeExternalConstructorAbiPlanRust(),
  );
  if (completeness.kind === 'complete') return;
  const problems = [
    completeness.missingExternalConstructors.length > 0
      ? `missing: ${completeness.missingExternalConstructors.map(formatRuntimeExternalConstructorInvocation).join(', ')}`
      : undefined,
    completeness.duplicateExternalConstructors.length > 0
      ? `duplicate: ${completeness.duplicateExternalConstructors.map(formatRuntimeExternalSymbolIdentity).join(', ')}`
      : undefined,
    completeness.invalidExternalConstructors.length > 0
      ? `invalid: ${completeness.invalidExternalConstructors.map(formatRuntimeExternalSymbolIdentity).join(', ')}`
      : undefined,
  ].filter((problem): problem is string => problem !== undefined);
  throw createBackendEmissionFailure(
    'rust',
    module,
    `runtime external constructor ABI plan is incomplete (${problems.join('; ')})`,
  );
}

function formatRuntimeExternalConstructorInvocation(
  invocation: Readonly<{
    externalSymbol: { sourceName: string; space: string };
    providedArgumentCount: number | 'dynamic';
  }>,
): string {
  return `${formatRuntimeExternalSymbolIdentity(invocation.externalSymbol)}(${invocation.providedArgumentCount === 'dynamic' ? '...' : String(invocation.providedArgumentCount)})`;
}

function formatRuntimeExternalSymbolIdentity(identity: Readonly<{ sourceName: string; space: string }>): string {
  return `${identity.sourceName}[${identity.space}]`;
}

function isAmbientIdentifier(expression: Readonly<IrExpression>): boolean {
  return expression.kind === 'identifier' && expression.reference.kind === 'ambient';
}

function emissionError(context: EmitContext, message: string): never {
  throw createBackendEmissionFailure('rust', context.module, message);
}

function collectStringConcatenationOperands(expression: Readonly<IrExpression>): readonly IrExpression[] {
  if (
    expression.kind === 'binary' &&
    expression.operator === '+' &&
    expression.semantics.left.flow === 'string' &&
    expression.semantics.right.flow === 'string'
  ) {
    return [
      ...collectStringConcatenationOperands(expression.left),
      ...collectStringConcatenationOperands(expression.right),
    ];
  }
  return [expression];
}

function emitStringConcatenationRust(expression: Readonly<IrExpression>, context: EmitContext): string {
  const operands = collectStringConcatenationOperands(expression);
  const format = operands
    .map((operand) =>
      operand.kind === 'literal' && typeof operand.value === 'string'
        ? operand.value.replaceAll('{', '{{').replaceAll('}', '}}')
        : '{}',
    )
    .join('');
  const values = operands.flatMap((operand) =>
    operand.kind === 'literal' && typeof operand.value === 'string' ? [] : [emitExpression(operand, context)],
  );
  return `format!(${JSON.stringify(format)}${values.length > 0 ? `, ${values.join(', ')}` : ''})`;
}

function emitAssignmentOperatorRust(
  operator: IrAssignmentOperator,
  semantics: Readonly<IrAssignmentOperatorSemantics>,
  context: EmitContext,
): string {
  const emitted = rustAssignmentOperatorEmission[operator];
  if (!emitted) emissionError(context, `operator ${operator} requires Rust semantic lowering`);
  if (!isAssignmentOperatorDirectRust(operator, semantics)) {
    emissionError(
      context,
      `operator ${operator} on ${semantics.left.flow} and ${semantics.right.flow} requires Rust type-directed lowering`,
    );
  }
  return emitted;
}

function emitBinaryOperatorRust(
  operator: IrBinaryOperator,
  semantics: Readonly<IrBinaryOperatorSemantics>,
  context: EmitContext,
): string {
  const emitted = rustBinaryOperatorEmission[operator];
  if (!emitted) emissionError(context, `operator ${operator} requires Rust semantic lowering`);
  if (!isBinaryOperatorDirectRust(operator, semantics)) {
    emissionError(
      context,
      `operator ${operator} on ${semantics.left.flow} and ${semantics.right.flow} requires Rust type-directed lowering`,
    );
  }
  return emitted;
}

function emitPostfixUnaryOperatorRust(operator: IrPostfixUnaryOperator, context: EmitContext): string {
  emissionError(context, rustPostfixUnaryOperatorRefusal[operator]);
}

function emitPrefixUnaryOperatorRust(
  operator: IrPrefixUnaryOperator,
  semantics: Readonly<IrUnaryOperatorSemantics>,
  context: EmitContext,
): string {
  const decision = rustPrefixUnaryOperatorDecision[operator];
  if ('refusal' in decision) emissionError(context, decision.refusal);
  if (!isPrefixUnaryOperatorDirectRust(operator, semantics)) {
    emissionError(context, `operator ${operator} on ${semantics.operand.flow} requires Rust type-directed lowering`);
  }
  return decision.emitted;
}

function isAssignmentOperatorDirectRust(
  operator: IrAssignmentOperator,
  semantics: Readonly<IrAssignmentOperatorSemantics>,
): boolean {
  if (operator === '=') return true;
  if (operator === '%=' || operator === '*=' || operator === '+=' || operator === '-=' || operator === '/=') {
    return hasMatchingOperatorDomains(semantics, ['number']);
  }
  return false;
}

// Which expressions the Rust emitter renders as an `Option`. An optional chain projects into one; an
// ordinary value does not, and wrapping it would claim a nullability the emitted type does not have.
function isIrExpressionOptionShapedRust(expression: Readonly<IrExpression>): boolean {
  // An optional member is an `Option` field in the emitted record, so reading it is already the shape
  // the operator needs — the chain is about the object being absent, this is about the member.
  //
  // A chain the source wrote over a receiver its own types say cannot be absent produces a plain
  // value, not an `Option`. The `?.` is redundant there, and treating it as an `Option` asks a value
  // for a method it does not have.
  if (expression.kind === 'property') {
    if (expression.optionalChain?.receiverNullish === 'excluded') return false;
    return expression.optional || expression.absent === 'optionalMember';
  }
  if (expression.kind === 'call') return expression.optional;
  // An array index is absent-admitting in the source language whatever the index is, which is why
  // `values[index] ?? fallback` is ordinary code. Rust's `[]` panics instead, so the coalesce reads
  // through `get`, which is both the Option the operator needs and the faithful behaviour.
  if (expression.kind === 'element') {
    return expression.optional || (expression.semantics.receivers.includes('array') && !expression.optional);
  }
  return expression.kind === 'undefinedDefault';
}

function emitOptionShapedOperandRust(expression: Readonly<IrExpression>, context: EmitContext): string {
  if (expression.kind === 'element' && !expression.optional && expression.semantics.receivers.includes('array')) {
    return `${emitExpression(expression.object, context)}.get(${emitIndexOperandRust(expression.index, context)}).cloned()`;
  }
  return emitExpression(expression, context);
}

function isBinaryOperatorDirectRust(
  operator: IrBinaryOperator,
  semantics: Readonly<IrBinaryOperatorSemantics>,
): boolean {
  if (operator === '%' || operator === '*' || operator === '+' || operator === '-' || operator === '/') {
    return hasMatchingOperatorDomains(semantics, ['number']);
  }
  if (operator === '<' || operator === '<=' || operator === '>' || operator === '>=') {
    return semantics.left.flow === 'number' && semantics.right.flow === 'number' && semantics.result === 'boolean';
  }
  if (operator === '&&' || operator === '||') {
    return hasMatchingOperatorDomains(semantics, ['boolean']);
  }
  if (operator === '===' || operator === '!==') {
    return (
      semantics.left.flow === semantics.right.flow &&
      semantics.result === 'boolean' &&
      (semantics.left.flow === 'boolean' || semantics.left.flow === 'number' || semantics.left.flow === 'string')
    );
  }
  if (operator === '&' || operator === '|' || operator === '^' || operator === '<<' || operator === '>>') {
    return hasMatchingOperatorDomains(semantics, ['number']);
  }
  return false;
}

function isPrefixUnaryOperatorDirectRust(
  operator: IrPrefixUnaryOperator,
  semantics: Readonly<IrUnaryOperatorSemantics>,
): boolean {
  if (operator === '!') return semantics.operand.flow === 'boolean' && semantics.result === 'boolean';
  if (operator === '+' || operator === '-') return semantics.operand.flow === 'number' && semantics.result === 'number';
  if (operator === '~') return semantics.operand.flow === 'number' && semantics.result === 'number';
  return false;
}

function hasMatchingOperatorDomains(
  semantics: Readonly<IrAssignmentOperatorSemantics | IrBinaryOperatorSemantics>,
  supported: readonly IrAssignmentOperatorSemantics['left']['flow'][],
): boolean {
  return (
    semantics.left.flow === semantics.right.flow &&
    semantics.left.flow === semantics.result &&
    supported.includes(semantics.left.flow)
  );
}

function isNullableType(type: Readonly<IrType>): boolean {
  return (
    type.kind === 'null' ||
    type.kind === 'undefined' ||
    (type.kind === 'union' && type.types.some((member) => member.kind === 'null' || member.kind === 'undefined'))
  );
}

function hasIrTypeNullMemberRust(type: Readonly<IrType>): boolean {
  return type.kind === 'null' || (type.kind === 'union' && type.types.some((member) => member.kind === 'null'));
}

function hasIrTypeUndefinedMemberRust(type: Readonly<IrType>): boolean {
  return (
    type.kind === 'undefined' || (type.kind === 'union' && type.types.some((member) => member.kind === 'undefined'))
  );
}

function isIrTypeCloneSafeRust(type: Readonly<IrType>): boolean {
  switch (type.kind) {
    case 'array':
      return isIrTypeCloneSafeRust(type.element);
    case 'literal':
    case 'never':
    case 'null':
    case 'primitive':
    case 'undefined':
      return true;
    case 'tuple':
      return type.elements.every((element) => isIrTypeCloneSafeRust(element.type));
    case 'union':
      return type.types.every(isIrTypeCloneSafeRust);
    case 'function':
    case 'indexedAccess':
    case 'intersection':
    case 'keyof':
    case 'named':
    case 'object':
    case 'typeOf':
    case 'unknown':
      return false;
  }
}

function opaqueHostType(context: EmitContext): string {
  return context.options.opaqueHostType ?? recordRuntimeTypeRust('OpaqueHostValue', context);
}

function rustImportModule(specifier: string, context: EmitContext): string {
  if (specifier.startsWith('.')) {
    const target = path.posix.normalize(
      path.posix.join(path.posix.dirname(context.module.source), specifier.replace(/\.[cm]?js$/u, '.ts')),
    );
    return `crate::${convertSourcePathToRustModuleName(target) ?? `_internal_${snakeCase(path.posix.basename(target))}`}`;
  }
  if (specifier.startsWith('@')) {
    const packageName = /^(@[^/]+\/[^/]+)/u.exec(specifier)?.[1];
    if (!packageName) emissionError(context, `cannot identify package import ${specifier}`);
    return convertPackageNameToRustCrateName(packageName).replaceAll('-', '_');
  }
  emissionError(context, `external import ${specifier} requires a runtime or standard-library mapping`);
}

function safeRustTypeName(name: string): string {
  const value = name
    .split('.')
    .map((segment) => pascalCase(segment))
    .join('::');
  return isRustCompilerKeyword(value) ? `${value}_` : value;
}

// A union alias becomes a Rust enum only when every alternative is a named record this module
// declares: the variant needs a name and the accessors need the alternative's fields, and neither
// exists for an anonymous shape or a primitive.
function getIrUnionTypeMemberRecordsRust(
  type: Readonly<Extract<IrType, { kind: 'union' }>>,
  context: EmitContext,
): ReadonlyArray<{ name: string; properties: readonly IrObjectTypeProperty[] }> | undefined {
  const members: Array<{ name: string; properties: readonly IrObjectTypeProperty[] }> = [];
  for (const member of type.types) {
    if (member.kind !== 'named' || member.reference.kind !== 'binding') return undefined;
    const name = member.reference.binding.name;
    const declaration = context.module.declarations.find(
      (candidate) =>
        (candidate.kind === 'interface' || candidate.kind === 'typeAlias') && candidate.binding.name === name,
    );
    const properties =
      declaration?.kind === 'interface'
        ? declaration.properties
        : declaration?.kind === 'typeAlias' && declaration.type.kind === 'object'
          ? declaration.type.properties
          : undefined;
    if (!properties) return undefined;
    members.push({ name, properties });
  }
  return members.length > 1 ? members : undefined;
}

function getIrCallBorrowedPositionsRust(
  expression: Readonly<Extract<IrExpression, { kind: 'call' }>>,
  context: EmitContext,
): ReadonlySet<number> {
  return expression.callee.kind === 'identifier' && expression.callee.reference.kind === 'binding'
    ? (context.borrowedParameterPositions.get(expression.callee.reference.binding.id) ?? new Set())
    : new Set();
}

// The base a subclass can be lowered onto: an abstract class in this module that carries no state.
// A base with fields has state to inherit and Rust has nowhere to put it.
function getIrClassStatelessAbstractBaseRust(
  declaration: Readonly<IrClassDeclaration>,
  context: EmitContext,
): Readonly<IrClassDeclaration> | undefined {
  const reference = declaration.extends;
  if (!reference || reference.kind !== 'named' || reference.reference.kind !== 'binding') return undefined;
  const binding = reference.reference.binding;
  const target = context.module.declarations.find(
    (candidate) => candidate.kind === 'class' && candidate.binding.id === binding.id,
  );
  return target?.kind === 'class' && target.abstract && target.fields.length === 0 && !target.extends
    ? target
    : undefined;
}

function emitAbstractClassTraitRust(declaration: Readonly<IrClassDeclaration>, context: EmitContext): string[] {
  if (declaration.fields.length > 0) {
    emissionError(context, `abstract class ${declaration.binding.name} carries state a Rust trait cannot hold`);
  }
  if (declaration.classConstructor && declaration.classConstructor.body.length > 0) {
    emissionError(context, `abstract class ${declaration.binding.name} constructor has no Rust trait equivalent`);
  }
  const mutating = getIrClassMutatingMethodNamesRust(declaration);
  const visibility = declaration.exported ? 'pub ' : '';
  const lines = [
    `${visibility}trait ${getBindingTargetNameRust(declaration.binding, context)}${emitTypeParameters(declaration.typeParameters, context)} {`,
  ];
  declaration.methods.forEach((method, index) => {
    if (index > 0) lines.push('');
    const target = getIrClassMethodTargetNameRust(method);
    const parameters = [
      ...(method.static ? [] : [method.accessor === 'set' || mutating.has(target) ? '&mut self' : '&self']),
      ...method.parameters.map((parameter) => emitParameter(parameter, context)),
    ].join(', ');
    const returns = method.accessor === 'set' ? '()' : emitType(method.returns, context);
    const signature = `  fn ${target}${emitTypeParameters(method.typeParameters, context)}(${parameters}) -> ${returns}`;
    // A method the abstract class implements becomes the trait's default body, which is how a
    // subclass inherits it without restating it.
    if (method.abstract) {
      lines.push(`${signature};`);
      return;
    }
    lines.push(`${signature} {`, ...indentSourceLines(emitStatements(method.body, context), 2), '  }');
  });
  lines.push('}');
  return lines;
}

function getIrExpressionClassDeclarationRust(
  object: Readonly<IrExpression>,
  context: EmitContext,
): Readonly<IrClassDeclaration> | undefined {
  if (object.kind !== 'identifier' || object.reference.kind !== 'binding') return undefined;
  const binding = object.reference.binding;
  const declaration = context.module.declarations.find(
    (candidate) => candidate.kind === 'class' && candidate.binding.id === binding.id,
  );
  return declaration?.kind === 'class' ? declaration : undefined;
}

function getIrExpressionEnumDeclarationRust(
  object: Readonly<IrExpression>,
  context: EmitContext,
): Readonly<IrEnumDeclaration> | undefined {
  if (object.kind !== 'identifier' || object.reference.kind !== 'binding') return undefined;
  const binding = object.reference.binding;
  const declaration = context.module.declarations.find(
    (candidate) => candidate.kind === 'enum' && candidate.binding.id === binding.id,
  );
  return declaration?.kind === 'enum' ? declaration : undefined;
}

function getIrExpressionClassAccessorRust(
  object: Readonly<IrExpression>,
  name: string,
  accessor: 'get' | 'set',
  context: EmitContext,
): boolean {
  if (object.kind !== 'identifier' || object.reference.kind !== 'binding') return false;
  const className = context.accessorClassNames.get(object.reference.binding.id);
  if (!className) return false;
  const declaration = context.module.declarations.find(
    (candidate) => candidate.kind === 'class' && candidate.binding.name === className,
  );
  return (
    declaration?.kind === 'class' &&
    declaration.methods.some((method) => method.accessor === accessor && method.name === name)
  );
}

function getIrExpressionTaggedUnionRust(expression: Readonly<IrExpression>, context: EmitContext): string | undefined {
  if (expression.kind !== 'identifier' || expression.reference.kind !== 'binding') return undefined;
  return context.taggedUnionBindingNames.get(expression.reference.binding.id);
}

function collectPrimitiveUnionBindingsRust(module: Readonly<IrModule>, context: EmitContext): void {
  for (const declaration of module.declarations) {
    if (declaration.kind !== 'function') continue;
    for (const parameter of declaration.parameters) {
      if (parameter.type.kind !== 'union') continue;
      const concrete = parameter.type.types.filter((t) => t.kind !== 'null' && t.kind !== 'undefined');
      if (concrete.length < 2) continue;
      const enumRecord = getOrCreatePrimitiveUnionEnumRust(concrete, context);
      if (enumRecord) {
        context.primitiveUnionBindingIds.set(parameter.binding.id, enumRecord.name);
      }
    }
  }
}

function emitPrimitiveUnionEnumRust(union: PrimitiveUnionEnum): string[] {
  const lines = [
    '#[derive(Clone, Debug)]',
    `enum ${union.name} {`,
    ...union.variants.map((v) => `  ${v.variantName}(${v.rustType}),`),
    '}',
    '',
    `impl ${union.name} {`,
    ...union.variants.flatMap((v) => [
      `  fn as_${snakeCase(v.variantName)}(&self) -> &${v.rustType} {`,
      '    match self {',
      `      ${union.name}::${v.variantName}(value) => value,`,
      ...(union.variants.length > 1 ? [`      _ => panic!("${union.name} is not ${v.variantName}"),`] : []),
      '    }',
      '  }',
    ]),
    '}',
    '',
    `impl std::fmt::Display for ${union.name} {`,
    "  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {",
    '    match self {',
    ...union.variants.map((v) => `      ${union.name}::${v.variantName}(value) => write!(f, "{}", value),`),
    '    }',
    '  }',
    '}',
  ];
  return lines;
}

function emitPrimitiveUnionNarrowedReceiverRust(
  expression: Readonly<IrExpression>,
  context: EmitContext,
): string | undefined {
  if (expression.kind !== 'identifier' || !expression.narrowedMember) return undefined;
  const primitiveUnion = getIrExpressionPrimitiveUnionRust(expression, context);
  if (!primitiveUnion) return undefined;
  const variant = primitiveUnion.variants.find((v) => v.primitiveKind === expression.narrowedMember);
  if (!variant) return undefined;
  return `${emitIdentifierReferenceRust(expression.reference, context)}.as_${snakeCase(variant.variantName)}()`;
}

function getIrExpressionPrimitiveUnionRust(
  expression: Readonly<IrExpression>,
  context: EmitContext,
): PrimitiveUnionEnum | undefined {
  if (expression.kind !== 'identifier' || expression.reference.kind !== 'binding') return undefined;
  const enumName = context.primitiveUnionBindingIds.get(expression.reference.binding.id);
  if (!enumName) return undefined;
  for (const union of context.primitiveUnionEnums.values()) {
    if (union.name === enumName) return union;
  }
  return undefined;
}

function getOrCreatePrimitiveUnionEnumRust(
  types: readonly IrType[],
  context: EmitContext,
): PrimitiveUnionEnum | undefined {
  if (!types.every((t) => t.kind === 'primitive')) return undefined;
  const primitives = types.filter((t): t is Extract<IrType, { kind: 'primitive' }> => t.kind === 'primitive');
  const rustPrimitiveInfo: Record<string, { rustType: string; variantName: string } | undefined> = {
    boolean: { rustType: 'bool', variantName: 'Bool' },
    number: { rustType: 'f64', variantName: 'F64' },
    string: { rustType: 'String', variantName: 'Str' },
  };
  const variants = primitives.flatMap((p) => {
    const info = rustPrimitiveInfo[p.name];
    return info ? [{ primitiveKind: p.name, ...info }] : [];
  });
  if (variants.length !== primitives.length) return undefined;
  const key = variants
    .map((v) => v.primitiveKind)
    .sort()
    .join('|');
  const existing = context.primitiveUnionEnums.get(key);
  if (existing) return existing;
  const name = variants.map((v) => v.variantName).join('Or');
  const record: PrimitiveUnionEnum = { name, variants };
  context.primitiveUnionEnums.set(key, record);
  return record;
}

function getTypeofTypeTestRust(
  expression: Readonly<Extract<IrExpression, { kind: 'binary' }>>,
  context: EmitContext,
): { enumName: string; negated: boolean; operand: Readonly<IrExpression>; variantName: string } | undefined {
  if (
    expression.operator !== '===' &&
    expression.operator !== '==' &&
    expression.operator !== '!==' &&
    expression.operator !== '!='
  ) {
    return undefined;
  }
  const typeofSide =
    expression.left.kind === 'unary' && !expression.left.postfix && expression.left.operator === 'typeof'
      ? expression.left
      : expression.right.kind === 'unary' && !expression.right.postfix && expression.right.operator === 'typeof'
        ? expression.right
        : undefined;
  const literalSide = typeofSide === expression.left ? expression.right : expression.left;
  if (!typeofSide || literalSide.kind !== 'literal' || typeof literalSide.value !== 'string') return undefined;
  const primitiveUnion = getIrExpressionPrimitiveUnionRust(typeofSide.operand, context);
  if (!primitiveUnion) return undefined;
  const variant = primitiveUnion.variants.find((v) => v.primitiveKind === literalSide.value);
  if (!variant) return undefined;
  return {
    enumName: primitiveUnion.name,
    negated: expression.operator === '!==' || expression.operator === '!=',
    operand: typeofSide.operand,
    variantName: variant.variantName,
  };
}

// A Rust enum plus the accessors that make the alternatives reachable: one per alternative for a
// reference control flow narrowed, and one per field every alternative shares for a reference it did
// not. An accessor rather than a `match` at each site keeps the emitted shape of the source's own
// control flow, which is what makes the two targets comparable.
function emitTaggedUnionRust(
  targetName: string,
  type: Readonly<Extract<IrType, { kind: 'union' }>>,
  exported: boolean,
  context: EmitContext,
): string[] {
  const members = getIrUnionTypeMemberRecordsRust(type, context);
  if (!members) emissionError(context, 'non-nullable unions require Rust tagged-union lowering');
  const visibility = exported ? 'pub ' : '';
  const lines = ['#[derive(Clone, Debug)]', `${visibility}enum ${targetName} {`];
  for (const member of members) {
    lines.push(`  ${pascalCase(member.name)}(${getTargetNameForDeclaredRustType(member.name, context)}),`);
  }
  lines.push('}', '', `impl ${targetName} {`);
  for (const member of members) {
    lines.push(
      `  ${visibility}fn as_${safeRustValueName(member.name)}(&self) -> &${getTargetNameForDeclaredRustType(member.name, context)} {`,
      '    match self {',
      `      ${targetName}::${pascalCase(member.name)}(value) => value,`,
      ...(members.length > 1 ? [`      _ => panic!("${targetName} is not ${pascalCase(member.name)}"),`] : []),
      '    }',
      '  }',
    );
  }
  const shared = members[0]!.properties.filter((property) =>
    members.every((member) => member.properties.some((candidate) => candidate.name === property.name)),
  );
  for (const property of shared) {
    lines.push(
      `  ${visibility}fn ${safeRustValueName(property.name)}(&self) -> ${emitType(property.type, context)} {`,
      '    match self {',
      ...members.map(
        (member) =>
          `      ${targetName}::${pascalCase(member.name)}(value) => value.${safeRustValueName(property.name)}.clone(),`,
      ),
      '    }',
      '  }',
    );
  }
  lines.push('}');
  return lines;
}

function getTargetNameForDeclaredRustType(name: string, context: EmitContext): string {
  const declaration = context.module.declarations.find(
    (candidate) =>
      (candidate.kind === 'interface' || candidate.kind === 'typeAlias') && candidate.binding.name === name,
  );
  return declaration && (declaration.kind === 'interface' || declaration.kind === 'typeAlias')
    ? getBindingTargetNameRust(declaration.binding, context)
    : pascalCase(name);
}

// Rust spells a constant in upper snake case, and the name is otherwise the source's own.
// A getter keeps the source's name, because a call reads the same way; a setter takes a `set_` name,
// because the two accessors share one name in the source and Rust has one namespace for both.
function getIrClassMethodTargetNameRust(method: Readonly<IrClassMethod>): string {
  return method.accessor === 'set' ? `set_${safeRustValueName(method.name)}` : safeRustValueName(method.name);
}

// A runtime type is named bare where it is used and imported once at the top, which is how Rust
// spells a dependency. Recording the name at the point of use is what makes the import exact.
// Rust braces a use list only when there is more than one name in it, which is what `rustfmt` leaves
// behind and therefore what canonical output looks like.
function emitUseTreeRust(names: readonly string[]): string {
  return names.length === 1 ? names[0]! : `{${names.join(', ')}}`;
}

function recordRuntimeTypeRust(name: string, context: EmitContext): string {
  context.runtimeTypeNames.add(name);
  return name;
}

function constantRustName(name: string): string {
  return safeRustValueName(name).toUpperCase();
}

function safeRustValueName(name: string): string {
  if (name === 'this') return 'self';
  const value = snakeCase(name);
  return isRustCompilerKeyword(value) ? `${value}_` : value;
}

function pascalCase(value: string): string {
  return value
    .split(/[-_]/u)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join('');
}

function screamingSnakeCase(value: string): string {
  return snakeCase(value).toUpperCase();
}

function snakeCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/gu, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/gu, '$1_$2')
    .replace(/[-\s]+/gu, '_')
    .toLowerCase();
}

const rustAssignmentOperatorEmission = {
  '%=': '%=',
  '&&=': undefined,
  '&=': '&=',
  '**=': undefined,
  '*=': '*=',
  '+=': '+=',
  '-=': '-=',
  '/=': '/=',
  '<<=': '<<=',
  '=': '=',
  '>>=': '>>=',
  '>>>=': undefined,
  '??=': undefined,
  '^=': '^=',
  '|=': '|=',
  '||=': undefined,
} as const satisfies Readonly<Record<IrAssignmentOperator, string | undefined>>;

const rustBinaryOperatorEmission = {
  '%': '%',
  '&': '&',
  '&&': '&&',
  '*': '*',
  '**': undefined,
  '+': '+',
  ',': undefined,
  '-': '-',
  '/': '/',
  '<': '<',
  '<<': '<<',
  '<=': '<=',
  '!=': '!=',
  '!==': '!=',
  '==': '==',
  '===': '==',
  '>': '>',
  '>=': '>=',
  '>>': '>>',
  '>>>': undefined,
  '??': '??',
  '^': '^',
  in: undefined,
  instanceof: undefined,
  '|': '|',
  '||': '||',
} as const satisfies Readonly<Record<IrBinaryOperator, string | undefined>>;

const rustPostfixUnaryOperatorRefusal = {
  '++': 'postfix ++ requires value-preserving Rust lowering',
  '--': 'postfix -- requires value-preserving Rust lowering',
} as const satisfies Readonly<Record<IrPostfixUnaryOperator, string>>;

const rustPrefixUnaryOperatorDecision = {
  '!': { emitted: '!' },
  '+': { emitted: '+' },
  '++': { refusal: 'prefix ++ requires value-preserving Rust lowering' },
  '-': { emitted: '-' },
  '--': { refusal: 'prefix -- requires value-preserving Rust lowering' },
  delete: { refusal: 'delete requires Rust semantic lowering' },
  typeof: { refusal: 'typeof requires Rust semantic lowering' },
  void: { refusal: 'void requires Rust semantic lowering' },
  '~': { emitted: '!' },
} as const satisfies Readonly<Record<IrPrefixUnaryOperator, OperatorEmissionDecision>>;
