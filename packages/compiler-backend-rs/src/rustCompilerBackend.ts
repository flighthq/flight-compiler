import path from 'node:path';

import {
  collectIrModuleNullableBindingIds,
  createBackendEmissionFailure,
  createCompilerGeneratedFileHeader,
  createIrModuleTargetNameAllocation,
  hasIrTypeAbsentMember,
  indentSourceLines,
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
import {
  convertPackageNameToRustCrateName,
  convertSourcePathToRustModuleName,
  isRustCompilerKeyword,
} from './rustCompilerIdentity.js';
import { analyzeIrModuleOwnershipEvidenceRust, collectIrModuleMovedBindingIdsRust } from './rustOwnershipEvidence.js';
import { createCompilerRuntimeExternalConstructorAbiPlanRust } from './rustRuntimeExternalConstructorAbi.js';
import {
  createCompilerRuntimeExternalSymbolBindingPlanRust,
  getCompilerRuntimeExternalMemberTargetRust,
  getCompilerRuntimeExternalSymbolTargetRust,
} from './rustRuntimeExternalSymbolBinding.js';

interface EmitContext {
  anonymousObjectRecords: Map<string, Readonly<{ name: string; properties: readonly IrObjectTypeProperty[] }>>;
  // Which bindings the module rebinds. Rust needs `mut` on a parameter that is assigned to, and the
  // ownership analysis already decides that for every binding in the module.
  movedBindingIds: ReadonlySet<string>;
  taggedUnionBindingNames: ReadonlyMap<string, string>;
  reboundBindingIds: ReadonlySet<string>;
  generatedNames: Set<string>;
  module: Readonly<IrModule>;
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
  const taggedUnionBindingNames = new Map<string, string>();
  const context: EmitContext = {
    anonymousObjectRecords: new Map(),
    reboundBindingIds: new Set(
      analyzeIrModuleOwnershipEvidenceRust(module).bindings.flatMap((evidence) =>
        evidence.mutation === 'bindingAndReferent' || evidence.mutation === 'bindingReassigned'
          ? [evidence.binding.id]
          : [],
      ),
    ),
    generatedNames: new Set(targetNames.values()),
    movedBindingIds: collectIrModuleMovedBindingIdsRust(module),
    taggedUnionBindingNames,
    module,
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
    if (alias?.kind !== 'typeAlias' || alias.type.kind !== 'union') continue;
    if (!getIrUnionTypeMemberRecordsRust(alias.type, context)) continue;
    taggedUnionBindingNames.set(evidence.binding.id, getBindingTargetNameRust(alias.binding, context));
  }
  const lines = [createCompilerGeneratedFileHeader(module, '//', options.upstreamCommit), '#![forbid(unsafe_code)]'];
  const imports = [...emitImports(module.imports, context), ...emitReexportsRust(module.exports, context)];
  if (imports.length > 0) lines.push('', ...imports);
  const declarations = module.declarations.map((declaration) => emitDeclaration(declaration, context));
  context.anonymousObjectRecords.forEach((record) => {
    lines.push('', ...emitRecord(record.name, record.properties, [], false, context));
  });
  context.objectRestRecords.forEach((record) => {
    lines.push('', ...emitRecord(record.name, record.properties, [], false, context));
  });
  declarations.forEach((declaration) => lines.push('', ...declaration));
  return {
    contents: lines.join('\n'),
    path: `${convertSourcePathToRustModuleName(module.source) ?? `_internal_${snakeCase(module.name)}`}.rs`,
  };
}

function emitClass(declaration: Readonly<IrClassDeclaration>, context: EmitContext): string[] {
  if (declaration.extends) {
    emissionError(context, `class ${declaration.binding.name} inheritance requires Rust ownership lowering`);
  }
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
  if (
    declaration.classConstructor &&
    (declaration.classConstructor.parameters.length > 0 || declaration.classConstructor.body.length > 0)
  ) {
    emissionError(context, `class ${declaration.binding.name} constructor requires Rust initialization lowering`);
  }
  if (declaration.abstract)
    emissionError(context, `abstract class ${declaration.binding.name} requires Rust trait lowering`);
  if (declaration.fields.some((field) => field.static)) {
    emissionError(context, `class ${declaration.binding.name} static fields require associated-item lowering`);
  }
  const constructed =
    !declaration.classConstructor ||
    (declaration.classConstructor.parameters.length === 0 && declaration.classConstructor.body.length === 0);
  const instanceFields = declaration.fields.filter((field) => !field.static);
  if (declaration.fields.some((field) => field.initializer) && !constructed) {
    emissionError(context, `class ${declaration.binding.name} field initializers require constructor lowering`);
  }
  if (declaration.fields.some((field) => field.initializer) && instanceFields.some((field) => !field.initializer)) {
    emissionError(context, `class ${declaration.binding.name} partially initializes its fields`);
  }
  const lines = [
    '#[derive(Clone, Debug)]',
    `${declaration.exported ? 'pub ' : ''}struct ${getBindingTargetNameRust(declaration.binding, context)}${emitTypeParameters(declaration.typeParameters, context)} {`,
  ];
  for (const field of declaration.fields) {
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
  const associated: string[] = [];
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
    const parameters = [
      ...(method.static ? [] : [mutatingMethodNames.has(method.name) ? '&mut self' : '&self']),
      ...method.parameters.map((parameter) => emitParameter(parameter, context)),
    ].join(', ');
    return [
      `  ${method.visibility === 'public' && !traitMethodNames.has(method.name) ? 'pub ' : ''}fn ${safeRustValueName(method.name)}${emitTypeParameters(method.typeParameters, context)}(${parameters}) -> ${emitType(method.returns, context)} {`,
      ...indentSourceLines(emitStatements(method.body, context), 2),
      '  }',
    ];
  };
  for (const trait of implementedTraits) {
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
      const left = emitExpression(expression.left, context);
      const right = emitExpression(expression.right, context);
      return `${left} ${emitAssignmentOperatorRust(expression.operator, expression.semantics, context)} ${right}`;
    }
    case 'await':
      return `${emitExpression(expression.expression, context)}.await`;
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
        if (!isIrExpressionOptionShapedRust(expression.left)) {
          emissionError(context, 'operator ?? requires an Option-shaped left operand for Rust');
        }
        return `${emitOptionShapedOperandRust(expression.left, context)}.unwrap_or_else(|| ${emitExpression(expression.right, context)})`;
      }
      const left = emitExpression(expression.left, context);
      const right = emitExpression(expression.right, context);
      return `(${left} ${emitBinaryOperatorRust(expression.operator, expression.semantics, context)} ${right})`;
    }
    case 'call':
      if (expression.semantics.statementValue) return emitStatementValueExpressionRust(expression, context);
      if (expression.optional) return emitOptionalCallExpressionRust(expression, context);
      // Rust joins a slice of strings with a borrowed separator, while the source hands it an owned
      // one. The separator is the only argument, so the borrow is decided here rather than by a
      // general rule about where an owned string may stand.
      if (expression.callee.kind === 'property' && expression.callee.member === 'arrayJoin') {
        const separator = expression.arguments[0];
        if (expression.arguments.length !== 1 || !separator) {
          emissionError(context, 'joining a collection requires exactly one separator argument');
        }
        return `${emitExpression(expression.callee.object, context)}.join(${emitBorrowedTextRust(separator, context)})`;
      }
      return `${expression.callee.kind === 'function' ? `(${emitExpression(expression.callee, context)})` : emitExpression(expression.callee, context)}(${emitCallArgumentsRust(expression, context).join(', ')})`;
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
      return `${emitExpression(expression.object, context)}[${emitExpression(expression.index, context)} as usize]`;
    case 'function':
      if (expression.async) emissionError(context, 'async closures require Flight task lowering');
      if (expression.typeParameters.length > 0) emissionError(context, 'generic closures require monomorphization');
      return expression.expression
        ? `|${expression.parameters.map((parameter) => getBindingTargetNameRust(parameter.binding, context)).join(', ')}| ${emitExpression(expression.expression, context)}`
        : `|${expression.parameters.map((parameter) => getBindingTargetNameRust(parameter.binding, context)).join(', ')}| {\n${indentSourceLines(emitStatements(expression.body, context)).join('\n')}\n}`;
    case 'identifier':
      // Narrowing proved this reference holds a value, so the Option it was declared as is opened
      // here. Without the proof the emitter refuses rather than unwrapping on faith.
      return expression.presence === 'narrowedPresent' &&
        expression.reference.kind === 'binding' &&
        context.nullableBindingIds.has(expression.reference.binding.id)
        ? `${emitIdentifierReferenceRust(expression.reference, context)}.unwrap()`
        : emitIdentifierReferenceRust(expression.reference, context);
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
      if (expression.member === 'arrayLength') {
        return `(${emitExpression(expression.object, context)}.len() as f64)`;
      }
      // A union is a closed set of alternatives in Rust, so its fields are not reachable by name.
      // A reference control flow narrowed to one alternative reads that alternative's own field; an
      // unnarrowed one can only read what every alternative agrees on, through the shared accessor.
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
      return `${emitExpression(expression.object, context)}${isAmbientIdentifier(expression.object) ? '::' : '.'}${safeRustValueName(expression.name)}`;
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
function getIrClassMutatingMethodNamesRust(declaration: Readonly<IrClassDeclaration>): ReadonlySet<string> {
  const mutating = new Set(
    declaration.methods.filter((method) => hasIrFunctionSignatureThisMutationRust(method)).map((method) => method.name),
  );
  const calls = new Map(
    declaration.methods.map((method) => [method.name, getIrFunctionSignatureSelfCallNamesRust(method)] as const),
  );
  let changed = true;
  while (changed) {
    changed = false;
    for (const method of declaration.methods) {
      if (mutating.has(method.name)) continue;
      if ((calls.get(method.name) ?? []).some((name) => mutating.has(name))) {
        mutating.add(method.name);
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
  const context: EmitContext = { ...outer, returnsAbsent: hasIrTypeAbsentMember(declaration.returns) };
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
    lines.add(`use ${module}::{${names.sort().join(', ')}};`);
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
    lines.add(`pub use ${module}::{${source === target ? source : `${source} as ${target}`}};`);
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
  return targetName;
}

function assertIrConstructorInvocationAbiRust(
  expression: Readonly<Extract<IrExpression, { kind: 'new' }>>,
  context: EmitContext,
): void {
  if (expression.callee.kind === 'identifier' && expression.callee.reference.kind === 'ambient') return;
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
    return targetName;
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
  const defaults = expression.semantics.defaultParameters;
  const optionals = expression.semantics.optionalParameters;
  if (!defaults && !optionals) return expression.arguments.map((argument) => emitOwnedOperandRust(argument, context));
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
    return `${object}${isAmbientIdentifier(expression.object) ? '::' : '.'}${property}`;
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
  return expression.kind === 'identifier' &&
    expression.reference.kind === 'binding' &&
    context.movedBindingIds.has(expression.reference.binding.id)
    ? `${source}.clone()`
    : source;
}

// Text in a position Rust borrows rather than owns. A literal is already a `&str` before it is
// owned, so the ownership is simply not taken; anything else is borrowed from the value it names.
function emitBorrowedTextRust(expression: Readonly<IrExpression>, context: EmitContext): string {
  return expression.kind === 'literal' && typeof expression.value === 'string'
    ? JSON.stringify(expression.value)
    : `&${emitExpression(expression, context)}`;
}

function emitParameter(parameter: Readonly<IrParameter>, context: EmitContext): string {
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
  if (parameter.rest) return `${binding}: Vec<${emitType(parameter.type, context)}>`;
  return `${binding}: ${emitType(parameter.type, context)}`;
}

function emitRecord(
  targetName: string,
  properties: readonly IrObjectTypeProperty[],
  typeParameters: readonly IrTypeParameter[],
  exported: boolean,
  context: EmitContext,
): string[] {
  const lines = [
    '#[derive(Clone, Debug)]',
    `${exported ? 'pub ' : ''}struct ${targetName}${emitTypeParameters(typeParameters, context)} {`,
  ];
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
    case 'forOf':
      if (statement.await) emissionError(context, 'async iteration requires Flight task lowering');
      if ('pattern' in statement.variable)
        emissionError(context, 'binding patterns require destructuring lowering before Rust emission');
      return [
        `${emitControlFlowLabelRust(statement.label)}for ${statement.variable.mutable ? 'mut ' : ''}${getBindingTargetNameRust(statement.variable.binding, context)} in ${emitExpression(statement.iterable, context)} {`,
        ...indentSourceLines(emitStatementBody(statement.body, context)),
        '}',
      ];
    case 'if': {
      const lines = [
        `if ${emitExpression(statement.condition, context)} {`,
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
      return [`return${statement.expression ? ` ${emitExpression(statement.expression, context)}` : ''};`];
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
      return [
        `${emitControlFlowLabelRust(statement.label)}while ${emitExpression(statement.condition, context)} {`,
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
      return `FlightCallback<(${parameters.join(', ')}${parameters.length === 1 ? ',' : ''}), ${emitType(type.returns, context)}>`;
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
      emissionError(context, 'non-nullable unions require Rust tagged-union lowering');
    }
    case 'unknown':
      return opaqueHostType(context);
  }
}

function emitTypeAlias(declaration: Readonly<IrTypeAliasDeclaration>, context: EmitContext): string[] {
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
      return `${name}${parameter.constraint ? `: ${emitType(parameter.constraint, context)}` : ''}`;
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
  const type =
    variable.type && !(variable.initializer?.kind === 'objectRest' && variable.type.kind === 'object')
      ? `: ${emitType(variable.type, context)}`
      : '';
  const initializer = variable.initializer ? ` = ${emitExpression(variable.initializer, context)}` : '';
  return `let ${variable.mutable ? 'mut ' : ''}${getBindingTargetNameRust(variable.binding, context)}${type}${initializer};`;
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
    return targetName;
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
  if (expression.kind === 'call' || expression.kind === 'property') return expression.optional;
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
    return `${emitExpression(expression.object, context)}.get(${emitExpression(expression.index, context)} as usize).cloned()`;
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
  return false;
}

function isPrefixUnaryOperatorDirectRust(
  operator: IrPrefixUnaryOperator,
  semantics: Readonly<IrUnaryOperatorSemantics>,
): boolean {
  if (operator === '!') return semantics.operand.flow === 'boolean' && semantics.result === 'boolean';
  if (operator === '-') return semantics.operand.flow === 'number' && semantics.result === 'number';
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
  return context.options.opaqueHostType ?? 'OpaqueHostValue';
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

function getIrExpressionTaggedUnionRust(expression: Readonly<IrExpression>, context: EmitContext): string | undefined {
  if (expression.kind !== 'identifier' || expression.reference.kind !== 'binding') return undefined;
  return context.taggedUnionBindingNames.get(expression.reference.binding.id);
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
  '+': { refusal: 'operator + requires Rust semantic lowering' },
  '++': { refusal: 'prefix ++ requires value-preserving Rust lowering' },
  '-': { emitted: '-' },
  '--': { refusal: 'prefix -- requires value-preserving Rust lowering' },
  delete: { refusal: 'delete requires Rust semantic lowering' },
  typeof: { refusal: 'typeof requires Rust semantic lowering' },
  void: { refusal: 'void requires Rust semantic lowering' },
  '~': { refusal: 'operator ~ requires Rust semantic lowering' },
} as const satisfies Readonly<Record<IrPrefixUnaryOperator, OperatorEmissionDecision>>;
