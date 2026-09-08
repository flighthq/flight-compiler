import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import {
  collectIrModuleNullableBindingIds,
  createBackendEmissionFailure,
  createCompilerGeneratedFileHeader,
  createIrModuleTargetNameAllocation,
  getIrUnionTypeStringLiteralValues,
  hasIrTypeAbsentMember,
  indentSourceLines,
  isCompilerTargetNameAllocationFailure,
} from '../../compiler-emission/src/index.js';
import {
  analyzeIrExpressionSubtreeTraversal,
  analyzeIrModuleTraversal,
  analyzeIrStatementSubtreeTraversal,
} from '../../compiler-ir-traversal/src/index.js';
import {
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
  analyzeCompilerRuntimeExternalSymbolCompleteness,
  collectIrModulesRuntimeExternalSymbolIdentities,
} from '../../compiler-runtime-contract/src/index.js';
import type {
  CompilerBackend,
  CppCompilerBackendOptions,
  CppCompilerRuntimeProfile,
  EmittedFile,
  IrBinaryOperator,
  IrBinaryOperatorSemantics,
  IrClassDeclaration,
  IrControlFlowLabelIdentity,
  IrDeclaration,
  IrEnumDeclaration,
  IrExpression,
  IrFunctionDeclaration,
  IrImport,
  IrInterfaceDeclaration,
  IrModule,
  IrParameter,
  IrStatement,
  IrSwitchCase,
  IrType,
  IrTypeAliasDeclaration,
  IrTypeParameter,
  IrUnionMemberTestEvidence,
  IrVariable,
  IrVariableDeclaration,
} from '../../compiler-types/src/index.js';
import { getCompilerCppAmbientMemberBinding } from './cppAmbientMemberBinding.js';
import { createIrModuleClosureCapturePlanCpp } from './cppClosureCapturePlan.js';
import {
  convertPackageNameToCppNamespace,
  convertSourcePathToCppFileName,
  isCppCompilerKeyword,
} from './cppCompilerIdentity.js';
import {
  createCompilerRuntimeExternalSymbolBindingPlanCpp,
  getCompilerRuntimeExternalMemberTargetCpp,
  getCompilerRuntimeExternalSymbolTargetCpp,
} from './cppRuntimeExternalSymbolBinding.js';

interface AnonymousStruct {
  name: string;
  properties: readonly { name: string; optional: boolean; type: string }[];
}

interface CppVariantRepresentation {
  alternatives: readonly Readonly<{ member: IrType; representationKey: string; targetType: string }>[];
}

interface EmitContext {
  anonymousStructs: Map<string, AnonymousStruct>;
  arrayElementBindingIds: ReadonlySet<string>;
  async?: boolean | undefined;
  bindingClasses: ReadonlyMap<string, Readonly<IrClassDeclaration>>;
  bindingTypes: ReadonlyMap<string, Readonly<IrType>>;
  currentClass?: Readonly<IrClassDeclaration> | undefined;
  defaultedParameterIds: ReadonlySet<string>;
  finallyReturnVar?: string | undefined;
  includes: Set<string>;
  module: Readonly<IrModule>;
  nullableBindingIds: ReadonlySet<string>;
  options: Readonly<CppCompilerBackendOptions>;
  returnsAbsent: boolean;
  sharedCaptureTargetNames: ReadonlyMap<string, string>;
  targetNames: ReadonlyMap<string, string>;
  generatedNames: Set<string>;
  enclosingReturnType?: Readonly<IrType> | undefined;
}

export function createCppCompilerBackend(): CompilerBackend<CppCompilerBackendOptions> {
  return {
    emitModule(module, { options }) {
      return [emitIrModuleCppWithContext(module, options)];
    },
    name: 'cpp',
  };
}

export function emitIrModuleCpp(
  sourceModule: Readonly<IrModule>,
  options: Readonly<CppCompilerBackendOptions> = {},
): EmittedFile {
  return emitIrModuleCppWithContext(sourceModule, options);
}

function emitIrModuleCppWithContext(
  sourceModule: Readonly<IrModule>,
  options: Readonly<CppCompilerBackendOptions>,
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
  assertRuntimeExternalSymbolBindingsCpp(module, options);
  let targetNames: Map<string, string>;
  try {
    targetNames = new Map(
      createIrModuleTargetNameAllocation(module, (binding) => ({
        namespace: 'identifier',
        preferredName:
          binding.space === 'type' || binding.kind === 'class' || binding.kind === 'enum'
            ? pascalCase(binding.name)
            : snakeCase(binding.name),
      })).map((allocation) => [allocation.identity, allocation.name]),
    );
  } catch (error) {
    if (isCompilerTargetNameAllocationFailure(error)) {
      throw createBackendEmissionFailure(
        'cpp',
        module,
        `public declarations share fixed C++ target name ${error.targetName}`,
      );
    }
    throw error;
  }
  const bindingTypes = collectIrModuleBindingTypesCpp(module);
  const closureCapturePlan = createIrModuleClosureCapturePlanCpp(module);
  const sharedCaptureTargetNames = new Map<string, string>();
  const context: EmitContext = {
    anonymousStructs: new Map(),
    arrayElementBindingIds: collectIrModuleArrayElementBindingIdsCpp(module, bindingTypes),
    bindingClasses: collectIrModuleBindingClassesCpp(module, bindingTypes),
    bindingTypes,
    defaultedParameterIds: new Set(),
    includes: new Set<string>(),
    module,
    nullableBindingIds: collectIrModuleNullableBindingIds(module),
    options,
    returnsAbsent: false,
    sharedCaptureTargetNames,
    targetNames,
    generatedNames: new Set(targetNames.values()),
  };
  for (const bindingPlan of closureCapturePlan.bindings) {
    const bindingType = bindingTypes.get(bindingPlan.binding.id);
    if (
      bindingPlan.reasons.includes('capturedReferentMutation') &&
      (!bindingType || !hasSharedReferentRepresentationCpp(bindingType, context))
    ) {
      emissionError(
        context,
        `captured referent mutation of ${bindingPlan.binding.name} requires a shared C++ reference representation`,
      );
    }
    if (bindingPlan.representation !== 'sharedMutableCell') continue;
    if (!bindingType) {
      emissionError(
        context,
        `shared mutable capture ${bindingPlan.binding.name} requires concrete binding type evidence`,
      );
    }
    const targetName = targetNames.get(bindingPlan.binding.id) ?? safeCppName(bindingPlan.binding.name);
    sharedCaptureTargetNames.set(bindingPlan.binding.id, generateUniqueName(`${targetName}_capture`, context));
  }
  const declarations = [...module.declarations]
    .sort((left, right) => declarationPriorityCpp(left) - declarationPriorityCpp(right))
    .map((declaration) => emitDeclaration(declaration, context));
  const imports = emitImports(module.imports, context);
  const lines = [createCompilerGeneratedFileHeader(module, '//', options.upstreamCommit)];
  lines.push('#pragma once');
  const sortedIncludes = [...context.includes].sort();
  for (const include of sortedIncludes) {
    lines.push(`#include <${include}>`);
  }
  if (options.runtimeHeader) {
    lines.push(`#include "${options.runtimeHeader}"`);
  } else if (getCppRuntimeProfile(options) === 'flight-cpp') {
    lines.push('#include <flight/runtime.hpp>');
  }
  if (getCppRuntimeProfile(options) === 'flight-cpp') {
    lines.push(
      '',
      'static_assert(flight::runtime_contract.compiler_contract == "flight-runtime-contract/2", "Flight compiler/runtime contract mismatch");',
      'static_assert(flight::runtime_contract.cpp_abi == 1, "Flight C++ runtime ABI mismatch");',
    );
  }
  if (imports.length > 0) lines.push('', ...imports);
  const namespaceName = convertPackageNameToCppNamespace(module.packageName);
  lines.push('', `namespace ${namespaceName} {`);
  for (const struct of context.anonymousStructs.values()) {
    lines.push('');
    lines.push(`struct ${struct.name} {`);
    for (const property of struct.properties) {
      lines.push(`  ${emitOptionalTypeCpp(property.type, property.optional, context)} ${property.name};`);
    }
    lines.push('};');
  }
  declarations.forEach((declaration) => lines.push('', ...declaration));
  lines.push('', `} // namespace ${namespaceName}`);
  return {
    contents: lines.join('\n'),
    path: `${convertSourcePathToCppFileName(module.source) ?? `_internal_${snakeCase(module.name)}`}.hpp`,
  };
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

function emitClass(declaration: Readonly<IrClassDeclaration>, outer: EmitContext): string[] {
  const context: EmitContext = { ...outer, currentClass: declaration };
  const name = getBindingTargetName(declaration.binding, context);
  const typeParams = emitTypeParameters(declaration.typeParameters, context);
  const extendsClause = declaration.extends ? ` : public ${emitType(declaration.extends, context)}` : '';
  const overriddenMethods = getIrClassInheritedMethodNamesCpp(declaration, context);
  const hasSubclass = hasIrModuleSubclassCpp(declaration, context);
  const lines: string[] = [];
  if (typeParams) lines.push(`template ${typeParams}`);
  lines.push(`struct ${name}${extendsClause} {`);
  for (const field of declaration.fields) {
    const fieldType = emitOptionalTypeCpp(emitType(field.type, context), field.optional, context);
    const initializer = field.initializer ? ` = ${emitExpression(field.initializer, context, field.type)}` : '';
    const staticPrefix = field.static ? 'inline static ' : '';
    const constPrefix = field.static && field.readonly ? 'const ' : '';
    lines.push(`  ${staticPrefix}${constPrefix}${fieldType} ${safeCppName(field.name)}${initializer};`);
  }
  if (declaration.classConstructor) {
    if (
      declaration.extends &&
      declaration.classConstructor.parameters.some((parameter) => parameter.initializer !== undefined)
    ) {
      emissionError(context, 'derived constructor default parameters require pre-base-initializer lowering');
    }
    const constructorContext: EmitContext = {
      ...context,
      defaultedParameterIds: collectDefaultedParameterIdsCpp(declaration.classConstructor.parameters),
    };
    const params = declaration.classConstructor.parameters
      .map((parameter) => emitParameter(parameter, constructorContext))
      .join(', ');
    const constructorParameterBindingIds = new Set(
      declaration.classConstructor.parameters.map((parameter) => parameter.binding.id),
    );
    const superContext: EmitContext = {
      ...constructorContext,
      sharedCaptureTargetNames: new Map(
        [...constructorContext.sharedCaptureTargetNames].filter(
          ([bindingId]) => !constructorParameterBindingIds.has(bindingId),
        ),
      ),
    };
    const superCall = declaration.extends
      ? extractSuperCallCpp(declaration.classConstructor.body, superContext)
      : undefined;
    const initList = superCall ? ` : ${superCall}` : '';
    const body = superCall
      ? declaration.classConstructor.body.filter((statement) => !isSuperCallStatement(statement))
      : declaration.classConstructor.body;
    lines.push(`  ${name}(${params})${initList} {`);
    lines.push(
      ...indentSourceLines(
        [
          ...emitParameterInitializersCpp(declaration.classConstructor.parameters, constructorContext),
          ...emitStatements(body, constructorContext),
        ],
        2,
      ),
    );
    lines.push('  }');
  }
  if (hasSubclass || declaration.abstract) {
    lines.push(`  virtual ~${name}() = default;`);
  }
  for (const method of declaration.methods) {
    const methodContext: EmitContext = {
      ...context,
      async: method.async,
      defaultedParameterIds: collectDefaultedParameterIdsCpp(method.parameters),
      enclosingReturnType: method.returns,
      returnsAbsent: hasIrTypeAbsentMember(method.returns),
    };
    if (method.async) methodContext.includes.add('coroutine');
    const returnType = method.accessor === 'set' ? 'void' : emitType(method.returns, methodContext);
    const params = method.parameters.map((parameter) => emitParameter(parameter, methodContext)).join(', ');
    const methodName = safeCppName(method.name);
    if (method.abstract) {
      lines.push(`  virtual ${returnType} ${methodName}(${params}) = 0;`);
      continue;
    }
    const needsVirtual = !method.static && (hasSubclass || declaration.abstract || overriddenMethods.has(method.name));
    const virtual = needsVirtual && !overriddenMethods.has(method.name) ? 'virtual ' : '';
    const override = overriddenMethods.has(method.name) ? ' override' : '';
    const staticPrefix = method.static ? 'static ' : '';
    lines.push(`  ${staticPrefix}${virtual}${returnType} ${methodName}(${params})${override} {`);
    lines.push(
      ...indentSourceLines(
        [
          ...emitParameterInitializersCpp(method.parameters, methodContext),
          ...emitStatements(method.body, methodContext),
          ...(method.accessor === 'set' ? [] : emitImplicitCompletionCpp(method.body, methodContext)),
        ],
        2,
      ),
    );
    lines.push('  }');
  }
  lines.push('};');
  return lines;
}

function emitEnum(declaration: Readonly<IrEnumDeclaration>, context: EmitContext): string[] {
  const name = getBindingTargetName(declaration.binding, context);
  const allStringValues = declaration.members.every((member) => typeof member.value === 'string');
  if (allStringValues) return emitStringEnumCpp(declaration, context);
  const lines: string[] = [`enum class ${name} {`];
  for (const member of declaration.members) {
    if (typeof member.value !== 'number' || !Number.isSafeInteger(member.value)) {
      emissionError(
        context,
        `numeric enum member ${declaration.binding.name}.${member.name} requires an integer value`,
      );
    }
    const value = ` = ${String(member.value)}`;
    lines.push(`  ${safeCppTypeName(member.name)}${value},`);
  }
  lines.push('};');
  return lines;
}

function emitStringEnumCpp(declaration: Readonly<IrEnumDeclaration>, context: EmitContext): string[] {
  const name = getBindingTargetName(declaration.binding, context);
  const stringType = emitCppStringType(context);
  context.includes.add('utility');
  return [
    `struct ${name} {`,
    `  ${stringType} value;`,
    `  ${name}(${stringType} source) : value(std::move(source)) {}`,
    `  operator const ${stringType}&() const noexcept { return value; }`,
    `  friend bool operator==(const ${name}&, const ${name}&) noexcept = default;`,
    ...declaration.members.map((member) => `  static const ${name} ${safeCppTypeName(member.name)};`),
    '};',
    ...declaration.members.map(
      (member) =>
        `inline const ${name} ${name}::${safeCppTypeName(member.name)}{${stringType}(${JSON.stringify(member.value)})};`,
    ),
  ];
}

function emitFunction(declaration: Readonly<IrFunctionDeclaration>, outer: EmitContext): string[] {
  const context: EmitContext = {
    ...outer,
    async: declaration.async,
    defaultedParameterIds: collectDefaultedParameterIdsCpp(declaration.parameters),
    enclosingReturnType: declaration.returns,
    returnsAbsent: hasIrTypeAbsentMember(declaration.returns),
  };
  if (declaration.async) context.includes.add('coroutine');
  const returnType = emitType(declaration.returns, context);
  const typeParams = emitTypeParameters(declaration.typeParameters, context);
  const params = declaration.parameters.map((parameter) => emitParameter(parameter, context)).join(', ');
  const name = getBindingTargetName(declaration.binding, context);
  const lines: string[] = [];
  if (typeParams) lines.push(`template ${typeParams}`);
  lines.push(`inline ${returnType} ${name}(${params}) {`);
  lines.push(
    ...indentSourceLines([
      ...emitParameterInitializersCpp(declaration.parameters, context),
      ...emitStatements(declaration.body, context),
      ...emitImplicitCompletionCpp(declaration.body, context),
    ]),
  );
  lines.push('}');
  return lines;
}

function emitInterface(declaration: Readonly<IrInterfaceDeclaration>, context: EmitContext): string[] {
  const name = getBindingTargetName(declaration.binding, context);
  const typeParams = emitTypeParameters(declaration.typeParameters, context);
  const lines: string[] = [];
  if (typeParams) lines.push(`template ${typeParams}`);
  lines.push(`struct ${name} {`);
  for (const property of declaration.properties) {
    const propType = emitOptionalTypeCpp(emitType(property.type, context), property.optional, context);
    lines.push(`  ${propType} ${safeCppName(property.name)};`);
  }
  lines.push('};');
  return lines;
}

function emitTypeAlias(declaration: Readonly<IrTypeAliasDeclaration>, context: EmitContext): string[] {
  const stringLiterals = getIrUnionTypeStringLiteralValues(declaration.type);
  if (stringLiterals) return emitStringLiteralUnionCpp(declaration, context);
  if (declaration.type.kind === 'object') {
    const name = getBindingTargetName(declaration.binding, context);
    const typeParams = emitTypeParameters(declaration.typeParameters, context);
    const lines: string[] = [];
    if (typeParams) lines.push(`template ${typeParams}`);
    lines.push(`struct ${name} {`);
    for (const property of declaration.type.properties) {
      const propertyType = emitOptionalTypeCpp(emitType(property.type, context), property.optional, context);
      lines.push(`  ${propertyType} ${safeCppName(property.name)};`);
    }
    lines.push('};');
    return lines;
  }
  const name = getBindingTargetName(declaration.binding, context);
  const typeParams = emitTypeParameters(declaration.typeParameters, context);
  const lines: string[] = [];
  if (typeParams) lines.push(`template ${typeParams}`);
  lines.push(`using ${name} = ${emitType(declaration.type, context)};`);
  return lines;
}

function emitStringLiteralUnionCpp(declaration: Readonly<IrTypeAliasDeclaration>, context: EmitContext): string[] {
  return [`using ${getBindingTargetName(declaration.binding, context)} = ${emitCppStringType(context)};`];
}

function emitVariableDeclaration(declaration: Readonly<IrVariableDeclaration>, context: EmitContext): string[] {
  if ('pattern' in declaration) {
    emissionError(context, 'binding patterns require destructuring lowering before C++ emission');
  }
  if (!declaration.type && !declaration.initializer) {
    emissionError(context, `uninitialized variable ${declaration.binding.name} requires inferred type evidence`);
  }
  const name = getBindingTargetName(declaration.binding, context);
  const arrayElement = context.arrayElementBindingIds.has(declaration.binding.id);
  const type = declaration.type ? emitType(declaration.type, context) : 'auto';
  const emittedType = arrayElement ? emitOptionalTypeCpp(type, true, context) : type;
  const constness = emitBindingConstnessCpp(declaration.mutable, declaration.type);
  const initializer = declaration.initializer
    ? ` = ${arrayElement ? emitOptionalExpressionCpp(declaration.initializer, context, declaration.type) : emitExpression(declaration.initializer, context, declaration.type)}`
    : '';
  return [`inline ${constness}${emittedType} ${name}${initializer};`];
}

function emitVariable(variable: Readonly<IrVariable>, context: EmitContext): string {
  if ('pattern' in variable) {
    emissionError(context, 'binding patterns require destructuring lowering before C++ emission');
  }
  if (!variable.type && !variable.initializer) {
    emissionError(context, `uninitialized variable ${variable.binding.name} requires inferred type evidence`);
  }
  const name = getBindingTargetName(variable.binding, context);
  const arrayElement = context.arrayElementBindingIds.has(variable.binding.id);
  const type = variable.type ? emitType(variable.type, context) : 'auto';
  const emittedType = arrayElement ? emitOptionalTypeCpp(type, true, context) : type;
  const constness = emitBindingConstnessCpp(variable.mutable, variable.type);
  const initializer = variable.initializer
    ? ` = ${arrayElement ? emitOptionalExpressionCpp(variable.initializer, context, variable.type) : emitExpression(variable.initializer, context, variable.type)}`
    : '';
  const sharedCaptureTargetName = context.sharedCaptureTargetNames.get(variable.binding.id);
  if (sharedCaptureTargetName) {
    if (!variable.initializer) {
      emissionError(context, `shared mutable capture ${variable.binding.name} requires initialized storage`);
    }
    const sharedType = emitOptionalTypeCpp(type, arrayElement, context);
    const sharedInitializer = arrayElement
      ? emitOptionalExpressionCpp(variable.initializer, context, variable.type)
      : emitExpression(variable.initializer, context, variable.type);
    context.includes.add('memory');
    return `const auto ${sharedCaptureTargetName} = std::make_shared<${sharedType}>(${sharedInitializer});`;
  }
  return `${constness}${emittedType} ${name}${initializer};`;
}

function emitExpression(
  expression: Readonly<IrExpression>,
  context: EmitContext,
  expectedType?: Readonly<IrType> | undefined,
): string {
  switch (expression.kind) {
    case 'array': {
      const expectedArray = expectedType?.kind === 'array' ? expectedType : undefined;
      const elements = expression.elements.map((element) =>
        element ? emitExpression(element, context, expectedArray?.element) : '{}',
      );
      if (getCppRuntimeProfile(context.options) === 'flight-cpp') {
        if (elements.length === 0 && !expectedArray) {
          emissionError(context, 'an empty array requires contextual element type in C++ emission');
        }
        const target = expectedArray ? `flight::Array<${emitType(expectedArray.element, context)}>` : 'flight::Array';
        return `${target}{${elements.join(', ')}}`;
      }
      context.includes.add('vector');
      return `std::vector{${elements.join(', ')}}`;
    }
    case 'assignment': {
      if (
        expression.operator === '+=' &&
        expression.semantics.left.flow === 'string' &&
        expression.semantics.right.flow === 'string'
      ) {
        return `${emitExpression(expression.left, context)} += ${emitExpression(expression.right, context)}`;
      }
      const right = emitExpression(expression.right, context);
      if (expression.operator === '=' && expression.left.kind === 'property') {
        const setter = getIrExpressionClassAccessorCpp(expression.left.object, expression.left.name, 'set', context);
        if (setter) {
          return `${emitExpression(expression.left.object, context)}${memberOp(expression.left.object)}${safeCppName(expression.left.name)}(${right})`;
        }
      }
      const left = emitAssignmentTargetCpp(expression.left, context);
      return `${left} ${emitAssignmentOperator(expression.operator)} ${right}`;
    }
    case 'await':
      return `co_await ${emitExpression(expression.expression, context)}`;
    case 'binary': {
      if (expression.semantics.unionMemberTest) {
        return emitUnionMemberTestCpp(expression.semantics.unionMemberTest, context);
      }
      if (expression.semantics.nullishComparison) {
        context.includes.add('optional');
        const operand =
          expression.left.kind === 'identifier' && expression.left.reference.kind === 'ambient'
            ? expression.right
            : expression.left;
        const negated = expression.operator === '!=' || expression.operator === '!==';
        return `${negated ? '' : '!'}${emitExpression(operand, context)}.has_value()`;
      }
      if (expression.operator === '??') {
        context.includes.add('optional');
        return `${emitOptionalExpressionCpp(expression.left, context, expectedType)}.value_or(${emitExpression(expression.right, context, expectedType)})`;
      }
      if (
        expression.operator === '+' &&
        expression.semantics.left.flow === 'string' &&
        expression.semantics.right.flow === 'string'
      ) {
        return emitStringConcatenation(expression, context);
      }
      if (
        expression.operator === '**' &&
        expression.semantics.left.flow === 'number' &&
        expression.semantics.right.flow === 'number'
      ) {
        context.includes.add('cmath');
        return `std::pow(${emitExpression(expression.left, context)}, ${emitExpression(expression.right, context)})`;
      }
      if (
        expression.operator === '>>>' &&
        expression.semantics.left.flow === 'number' &&
        expression.semantics.right.flow === 'number'
      ) {
        context.includes.add('cstdint');
        return `static_cast<double>(static_cast<uint32_t>(static_cast<int32_t>(${emitExpression(expression.left, context)})) >> static_cast<uint32_t>(${emitExpression(expression.right, context)}))`;
      }
      if (expression.operator === '%') {
        context.includes.add('cmath');
        return `std::fmod(${emitExpression(expression.left, context)}, ${emitExpression(expression.right, context)})`;
      }
      const op = emitBinaryOperator(expression.operator, expression.semantics, context);
      const bitwise =
        expression.operator === '&' ||
        expression.operator === '|' ||
        expression.operator === '^' ||
        expression.operator === '<<' ||
        expression.operator === '>>';
      const left = emitExpression(expression.left, context);
      const right = emitExpression(expression.right, context);
      if (bitwise) {
        context.includes.add('cstdint');
        return `static_cast<double>(static_cast<int32_t>(${left}) ${op} static_cast<int32_t>(${right}))`;
      }
      return `(${left} ${op} ${right})`;
    }
    case 'call': {
      if (expression.optional) return emitOptionalCallExpressionCpp(expression, context);
      if (
        expression.callee.kind === 'property' &&
        expression.callee.member?.receiver === 'number' &&
        expression.callee.member.name === 'toString'
      ) {
        const value = `std::to_string(${emitExpression(expression.callee.object, context)})`;
        if (getCppRuntimeProfile(context.options) === 'flight-cpp') {
          return `flight::to_string(${emitExpression(expression.callee.object, context)})`;
        }
        context.includes.add('string');
        return value;
      }
      if (expression.callee.kind === 'property' && expression.callee.member) {
        const binding = getCompilerCppAmbientMemberBinding(
          expression.callee.member,
          getCppRuntimeProfile(context.options),
        );
        if (binding && binding.kind === 'sizeMethod') {
          const receiver = emitExpression(expression.callee.object, context);
          return `static_cast<double>(${receiver}${memberOp(expression.callee.object)}${binding.targetName}())`;
        }
        if (binding && binding.kind === 'method') {
          const receiver = emitExpression(expression.callee.object, context);
          const args = expression.arguments.map((argument) => emitExpression(argument, context));
          return `${receiver}${memberOp(expression.callee.object)}${binding.targetName}${emitCppTypeArguments(expression.typeArguments, context)}(${args.join(', ')})`;
        }
      }
      if (
        expression.arguments.length === 1 &&
        expression.arguments[0]!.kind === 'spread' &&
        expression.callee.kind === 'property' &&
        expression.callee.object.kind === 'identifier' &&
        expression.callee.object.reference.kind === 'ambient' &&
        expression.callee.object.reference.name === 'Math'
      ) {
        const spreadOperand = emitExpression(expression.arguments[0]!.expression, context);
        const foldTarget = cppMathSpreadFoldTargets[expression.callee.name];
        if (foldTarget) {
          context.includes.add('algorithm');
          context.includes.add('limits');
          return `${spreadOperand}.empty() ? ${foldTarget.identity} : *${foldTarget.algorithm}(${spreadOperand}.begin(), ${spreadOperand}.end())`;
        }
      }
      const callee =
        expression.callee.kind === 'function'
          ? `(${emitExpression(expression.callee, context)})`
          : emitExpression(expression.callee, context);
      const args = expression.arguments.map((argument) => emitExpression(argument, context));
      return `${callee}${emitCppTypeArguments(expression.typeArguments, context)}(${args.join(', ')})`;
    }
    case 'cast': {
      const asserted = emitUnionMemberAssertionCpp(expression.expression, expression.type, context);
      return (
        asserted ??
        `static_cast<${emitType(expression.type, context)}>(${emitExpression(expression.expression, context)})`
      );
    }
    case 'conditional':
      return `(${emitExpression(expression.condition, context)} ? ${emitExpression(expression.whenTrue, context)} : ${emitExpression(expression.whenFalse, context)})`;
    case 'element': {
      if (expression.optional) return emitOptionalElementExpressionCpp(expression, context);
      if (expression.semantics.receivers.includes('tuple')) {
        context.includes.add('tuple');
        const index = getElementAccessTupleIndexCpp(expression, context);
        return `std::get<${String(index)}>(${emitExpression(expression.object, context)})`;
      }
      if (getCppRuntimeProfile(context.options) === 'flight-cpp' && hasIndexedRuntimeReceiverCpp(expression, context)) {
        return `${emitExpression(expression.object, context)}.element(${emitExpression(expression.index, context)})`;
      }
      return `${emitExpression(expression.object, context)}[static_cast<size_t>(${emitExpression(expression.index, context)})]`;
    }
    case 'function': {
      if (expression.async) emissionError(context, 'async closures require C++ coroutine lowering');
      const functionContext: EmitContext = {
        ...context,
        async: false,
        defaultedParameterIds: collectDefaultedParameterIdsCpp(expression.parameters),
        enclosingReturnType: expression.returns,
        returnsAbsent: hasIrTypeAbsentMember(expression.returns),
      };
      const usesThis = irFunctionExpressionUsesThisCpp(expression);
      if (usesThis && expression.thisMode === 'dynamic') {
        emissionError(context, 'dynamic-this closures require receiver lowering');
      }
      if (usesThis && !context.currentClass) {
        emissionError(context, 'lexical-this closure requires class receiver context');
      }
      functionContext.includes.add('functional');
      const params = expression.parameters.map((parameter) => emitParameter(parameter, functionContext));
      const capture = usesThis ? '[=, this]' : '[=]';
      if (
        expression.expression &&
        functionContext.defaultedParameterIds.size === 0 &&
        !hasSharedCaptureParameterCpp(expression.parameters, functionContext)
      ) {
        return `${capture}(${params.join(', ')}) { return ${emitExpression(expression.expression, functionContext, expression.returns)}; }`;
      }
      return `${capture}(${params.join(', ')}) {\n${indentSourceLines([
        ...emitParameterInitializersCpp(expression.parameters, functionContext),
        ...(expression.expression
          ? [`return ${emitExpression(expression.expression, functionContext, expression.returns)};`]
          : [
              ...emitStatements(expression.body, functionContext),
              ...emitImplicitCompletionCpp(expression.body, functionContext),
            ]),
      ]).join('\n')}\n}`;
    }
    case 'identifier': {
      if (
        expression.reference.kind === 'binding' &&
        context.defaultedParameterIds.has(expression.reference.binding.id)
      ) {
        return `${emitIdentifierReference(expression.reference, context)}.value()`;
      }
      if (
        expression.presence === 'narrowedPresent' &&
        expression.reference.kind === 'binding' &&
        context.nullableBindingIds.has(expression.reference.binding.id)
      ) {
        context.includes.add('optional');
        return `${emitIdentifierReference(expression.reference, context)}.value()`;
      }
      if (expression.narrowedMember && expression.reference.kind === 'binding') {
        const narrowed = emitNarrowedUnionMemberCpp(expression, context);
        if (narrowed) return narrowed;
      }
      return emitIdentifierReference(expression.reference, context);
    }
    case 'literal':
      return emitLiteral(expression.value, context);
    case 'new': {
      if (expression.callee.kind !== 'identifier') {
        emissionError(context, 'qualified constructors require C++ type-path lowering');
      }
      const typeName = emitIdentifierReference(expression.callee.reference, context);
      if (typeName === 'std::runtime_error') context.includes.add('stdexcept');
      const args = expression.arguments.map((argument) => emitExpression(argument, context));
      const typeArguments = emitCppTypeArguments(expression.typeArguments, context);
      if (
        getCppRuntimeProfile(context.options) === 'flight-cpp' &&
        expression.callee.reference.kind === 'ambient' &&
        expression.callee.reference.name === 'Promise'
      ) {
        if (expression.typeArguments.length !== 1) {
          emissionError(context, 'flight-cpp Promise construction requires one explicit type argument');
        }
        return `${typeName}${typeArguments}::create(${args.join(', ')})`;
      }
      return `${typeName}${typeArguments}(${args.join(', ')})`;
    }
    case 'object': {
      const members = expression.members
        .filter((member): member is typeof member & { kind: 'property' } => member.kind === 'property')
        .map((member) => `.${safeCppName(member.name)} = ${emitExpression(member.value, context)}`);
      return `{${members.join(', ')}}`;
    }
    case 'property': {
      if (expression.optional) return emitOptionalPropertyExpressionCpp(expression, context);
      if (expression.member) {
        const binding = getCompilerCppAmbientMemberBinding(expression.member, getCppRuntimeProfile(context.options));
        if (binding && binding.kind === 'sizeMethod') {
          const receiver = emitExpression(expression.object, context);
          return `static_cast<double>(${receiver}${memberOp(expression.object)}${binding.targetName}())`;
        }
        if (binding && binding.kind === 'property') {
          return `${emitExpression(expression.object, context)}${memberOp(expression.object)}${binding.targetName}`;
        }
      }
      if (expression.object.kind === 'identifier' && expression.object.reference.kind === 'ambient') {
        const member = getCompilerRuntimeExternalMemberTargetCpp(
          expression.object.reference.name,
          expression.name,
          getCppRuntimeProfile(context.options),
        );
        if (member) return member;
      }
      if (
        expression.object.kind === 'identifier' &&
        expression.object.reference.kind === 'binding' &&
        !expression.object.narrowedMember &&
        getIrBindingVariantUnionTypeCpp(expression.object.reference.binding.id, context)
      ) {
        emissionError(context, `property ${expression.name} on a C++ variant requires proven union member access`);
      }
      const classDeclaration = getIrExpressionClassDeclarationCpp(expression.object, context);
      if (classDeclaration) {
        const staticMember =
          classDeclaration.fields.some((field) => field.static && field.name === expression.name) ||
          classDeclaration.methods.some((method) => method.static && method.name === expression.name);
        if (staticMember) {
          return `${getBindingTargetName(classDeclaration.binding, context)}::${safeCppName(expression.name)}`;
        }
      }
      const enumeration = getIrExpressionEnumDeclaration(expression.object, context);
      if (enumeration) {
        return `${getBindingTargetName(enumeration.binding, context)}::${safeCppTypeName(expression.name)}`;
      }
      if (getIrExpressionClassAccessorCpp(expression.object, expression.name, 'get', context)) {
        return `${emitExpression(expression.object, context)}${memberOp(expression.object)}${safeCppName(expression.name)}()`;
      }
      return `${emitExpression(expression.object, context)}${memberOp(expression.object)}${safeCppName(expression.name)}`;
    }
    case 'regexp':
      emissionError(context, 'regular expressions require a downstream standard-library mapping');
    case 'spread':
      emissionError(context, 'spreading an unbounded collection requires a fold or a variadic target');
    case 'template': {
      const flightRuntime = getCppRuntimeProfile(context.options) === 'flight-cpp';
      if (!flightRuntime) context.includes.add('string');
      const parts = expression.parts.map((part) =>
        typeof part === 'string'
          ? flightRuntime
            ? `flight::String(${JSON.stringify(part)})`
            : `std::string(${JSON.stringify(part)})`
          : flightRuntime
            ? `flight::to_string(${emitExpression(part, context)})`
            : `std::to_string(${emitExpression(part, context)})`,
      );
      return parts.length === 0 ? (flightRuntime ? 'flight::String()' : 'std::string()') : parts.join(' + ');
    }
    case 'tuple': {
      context.includes.add('tuple');
      const elements = expression.elements.map((element) => {
        if (!element.expression) {
          context.includes.add('optional');
          return 'std::nullopt';
        }
        const emitted = emitExpression(element.expression, context);
        if (element.optional) {
          context.includes.add('optional');
          return `std::make_optional(${emitted})`;
        }
        return emitted;
      });
      return `std::make_tuple(${elements.join(', ')})`;
    }
    case 'unary': {
      if (
        expression.operator === 'typeof' &&
        expression.operand.kind === 'identifier' &&
        expression.operand.reference.kind === 'binding' &&
        getIrBindingVariantUnionTypeCpp(expression.operand.reference.binding.id, context)
      ) {
        emissionError(context, 'typeof on a C++ variant requires proven union member test evidence');
      }
      const operand = emitExpression(expression.operand, context);
      if (expression.operator === '~') {
        context.includes.add('cstdint');
        return `static_cast<double>(~static_cast<int32_t>(${operand}))`;
      }
      if (expression.operator === '+' && expression.semantics.operand.flow === 'number') return operand;
      const operator = expression.postfix
        ? emitPostfixUnaryOperator(expression.operator)
        : emitPrefixUnaryOperator(expression.operator);
      return expression.postfix ? `${operand}${operator}` : `${operator}${operand}`;
    }
    case 'undefinedValue':
      context.includes.add('optional');
      return 'std::nullopt';
    case 'undefinedDefault': {
      context.includes.add('optional');
      return `${emitExpression(expression.value, context)}.value_or(${emitExpression(expression.fallback, context)})`;
    }
    case 'tupleRest': {
      context.includes.add('tuple');
      return `std::get<${String(expression.start)}>(${emitExpression(expression.object, context)})`;
    }
    case 'tupleSpread':
      return emitTupleSpreadExpressionCpp(expression, context);
    case 'tupleSuffix': {
      context.includes.add('tuple');
      const object = emitExpression(expression.object, context);
      const elements = Array.from(
        { length: expression.width },
        (_, offset) => `std::get<${String(expression.start + offset)}>(${object})`,
      );
      return `std::make_tuple(${elements.join(', ')})`;
    }
    case 'objectRest':
      emissionError(context, `${expression.kind} expressions require C++ structured binding lowering`);
  }
}

function emitStatement(statement: Readonly<IrStatement>, context: EmitContext): string[] {
  switch (statement.kind) {
    case 'block':
      return ['{', ...indentSourceLines(emitStatements(statement.statements, context)), '}'];
    case 'break':
      return ['break;'];
    case 'continue':
      return ['continue;'];
    case 'do':
      return [
        'do {',
        ...indentSourceLines(emitStatementBody(statement.body, context)),
        `} while (${emitExpression(statement.condition, context)});`,
      ];
    case 'expression':
      return [`${emitExpression(statement.expression, context)};`];
    case 'for':
      emissionError(context, 'C-style for loops require control-flow lowering before C++ emission');
    case 'forIn': {
      if ('pattern' in statement.variable) {
        emissionError(context, 'binding patterns require destructuring lowering before C++ emission');
      }
      if (!statement.keyPlan) {
        emissionError(context, 'object key iteration requires closed key evidence');
      }
      if (context.sharedCaptureTargetNames.has(statement.variable.binding.id)) {
        emissionError(context, 'shared mutable for-in capture requires iteration-storage lowering');
      }
      if (statement.variable.type?.kind !== 'primitive' || statement.variable.type.name !== 'string') {
        emissionError(context, 'for-in binding requires primitive string type evidence');
      }
      const flightRuntime = getCppRuntimeProfile(context.options) === 'flight-cpp';
      const keyType = emitType(statement.variable.type, context);
      const keyValues = statement.keyPlan.keys
        .map((key) => (flightRuntime ? `flight::String(${JSON.stringify(key)})` : JSON.stringify(key)))
        .join(', ');
      const keyCollection = flightRuntime ? `flight::Array<${keyType}>` : `std::vector<${keyType}>`;
      if (statement.keyPlan.evaluation === 'preserve') {
        const objectName = generateUniqueName('for_in_object', context);
        if (!flightRuntime) context.includes.add('vector');
        const variableName = getBindingTargetName(statement.variable.binding, context);
        return [
          '{',
          `  auto ${objectName} = ${emitExpression(statement.object, context)};`,
          `  static_cast<void>(${objectName});`,
          `  for (const ${keyType}& ${variableName} : ${keyCollection}{${keyValues}}) {`,
          ...indentSourceLines(emitStatements([statement.body], context), 2),
          '  }',
          '}',
        ];
      }
      if (!flightRuntime) context.includes.add('vector');
      const variableName = getBindingTargetName(statement.variable.binding, context);
      return [
        ...(statement.keyPlan.evaluation === 'alreadyEvaluated'
          ? [`static_cast<void>(${emitExpression(statement.object, context)});`]
          : []),
        `for (const ${keyType}& ${variableName} : ${keyCollection}{${keyValues}}) {`,
        ...indentSourceLines(emitStatements([statement.body], context)),
        '}',
      ];
    }
    case 'forOf': {
      if (statement.await) emissionError(context, 'async iteration requires C++ coroutine lowering');
      if ('pattern' in statement.variable) {
        emissionError(context, 'binding patterns require destructuring lowering before C++ emission');
      }
      const iterable = emitExpression(statement.iterable, context);
      const variableName = getBindingTargetName(statement.variable.binding, context);
      const sharedCaptureTargetName = context.sharedCaptureTargetNames.get(statement.variable.binding.id);
      if (sharedCaptureTargetName) {
        if (!statement.variable.type) {
          emissionError(
            context,
            `shared mutable capture ${statement.variable.binding.name} requires concrete binding type evidence`,
          );
        }
        const iterationValueName = generateUniqueName(`${variableName}_iteration_value`, context);
        context.includes.add('memory');
        return [
          `for (auto ${iterationValueName} : ${iterable}) {`,
          ...indentSourceLines([
            `const auto ${sharedCaptureTargetName} = std::make_shared<${emitType(statement.variable.type, context)}>(${iterationValueName});`,
            ...emitStatementBody(statement.body, context),
          ]),
          '}',
        ];
      }
      return [
        `for (auto ${variableName} : ${iterable}) {`,
        ...indentSourceLines(emitStatementBody(statement.body, context)),
        '}',
      ];
    }
    case 'if': {
      const lines = [
        `if (${emitExpression(statement.condition, context)}) {`,
        ...indentSourceLines(emitStatementBody(statement.consequent, context)),
        '}',
      ];
      if (statement.otherwise)
        lines.push('else {', ...indentSourceLines(emitStatementBody(statement.otherwise, context)), '}');
      return lines;
    }
    case 'return': {
      if (context.finallyReturnVar) {
        const lines: string[] = [];
        if (statement.expression) {
          lines.push(
            `${context.finallyReturnVar} = ${emitExpression(statement.expression, context, getExpectedReturnTypeCpp(context))};`,
          );
        }
        return lines;
      }
      const keyword = context.async ? 'co_return' : 'return';
      return [
        `${keyword}${statement.expression ? ` ${emitExpression(statement.expression, context, getExpectedReturnTypeCpp(context))}` : ''};`,
      ];
    }
    case 'switch': {
      const name = getGeneratedTargetName('switch_value', context);
      const cases = statement.cases.filter((switchCase) => switchCase.expression);
      const otherwise = statement.cases.find((switchCase) => !switchCase.expression);
      const lines = [`auto ${name} = ${emitExpression(statement.expression, context)};`];
      cases.forEach((switchCase, index) => {
        lines.push(
          `${index > 0 ? 'else ' : ''}if (${name} == ${emitExpression(switchCase.expression!, context)}) {`,
          ...indentSourceLines(emitSwitchCaseStatementsCpp(switchCase, statement.label, context)),
          '}',
        );
      });
      if (otherwise) {
        if (cases.length > 0) lines.push('else {');
        lines.push(
          ...indentSourceLines(
            emitSwitchCaseStatementsCpp(otherwise, statement.label, context),
            cases.length > 0 ? 1 : 0,
          ),
        );
        if (cases.length > 0) lines.push('}');
      }
      return ['{', ...indentSourceLines(lines), '}'];
    }
    case 'throw':
      return [`throw ${emitExpression(statement.expression, context)};`];
    case 'try': {
      if (statement.finallyBody)
        return emitTryFinallyCpp(statement as typeof statement & { finallyBody: IrStatement }, context);
      const lines = ['try {', ...indentSourceLines(emitStatementBody(statement.tryBody, context)), '}'];
      if (statement.catchClause) {
        lines.push(...emitCatchClauseCpp(statement.catchClause, context));
      }
      return lines;
    }
    case 'variable':
      return statement.declarations.map((variable) => emitVariable(variable, context));
    case 'while':
      return [
        `while (${emitExpression(statement.condition, context)}) {`,
        ...indentSourceLines(emitStatementBody(statement.body, context)),
        '}',
      ];
  }
}

function emitCatchClauseCpp(
  catchClause: NonNullable<Extract<IrStatement, { kind: 'try' }>['catchClause']>,
  context: EmitContext,
): string[] {
  if (catchClause.binding) context.includes.add('stdexcept');
  const catchVar = catchClause.binding ? `const std::exception& ${safeCppName(catchClause.binding.name)}` : '...';
  return [`catch (${catchVar}) {`, ...indentSourceLines(emitStatementBody(catchClause.body, context)), '}'];
}

function emitSwitchCaseStatementsCpp(
  switchCase: Readonly<IrSwitchCase>,
  switchLabel: Readonly<IrControlFlowLabelIdentity> | undefined,
  context: EmitContext,
): string[] {
  const last = switchCase.statements.at(-1);
  const localBreak = last?.kind === 'break' && (!last.target || (switchLabel && last.target.id === switchLabel.id));
  return emitStatements(localBreak ? switchCase.statements.slice(0, -1) : switchCase.statements, context);
}

function emitStatementBody(statement: Readonly<IrStatement>, context: EmitContext): string[] {
  return statement.kind === 'block'
    ? emitStatements(statement.statements, context)
    : emitStatements([statement], context);
}

function emitStatements(statements: readonly IrStatement[], context: EmitContext): string[] {
  return statements.flatMap((statement) => emitStatement(statement, context));
}

function containsReturnStatementCpp(statement: Readonly<IrStatement>): boolean {
  switch (statement.kind) {
    case 'return':
      return true;
    case 'block':
      return statement.statements.some(containsReturnStatementCpp);
    case 'if':
      return (
        containsReturnStatementCpp(statement.consequent) ||
        (statement.otherwise ? containsReturnStatementCpp(statement.otherwise) : false)
      );
    case 'try':
      return (
        containsReturnStatementCpp(statement.tryBody) ||
        (statement.catchClause ? containsReturnStatementCpp(statement.catchClause.body) : false) ||
        (statement.finallyBody ? containsReturnStatementCpp(statement.finallyBody) : false)
      );
    default:
      return false;
  }
}

function emitTryFinallyCpp(
  statement: Readonly<Extract<IrStatement, { kind: 'try' }>> & { finallyBody: IrStatement },
  context: EmitContext,
): string[] {
  context.includes.add('exception');
  const exceptionVar = getGeneratedTargetName('finally_exception', context);
  const lines: string[] = [];
  const hasReturn =
    containsReturnStatementCpp(statement.tryBody) ||
    (statement.catchClause ? containsReturnStatementCpp(statement.catchClause.body) : false);
  let returnVar: string | undefined;
  if (hasReturn && context.enclosingReturnType) {
    context.includes.add('optional');
    returnVar = getGeneratedTargetName('finally_return', context);
    const returnValueType = context.async
      ? getIrTaskAwaitedTypeCpp(context.enclosingReturnType, context)
      : context.enclosingReturnType;
    lines.push(`std::optional<${emitType(returnValueType, context)}> ${returnVar};`);
  }
  lines.push(`std::exception_ptr ${exceptionVar};`);
  const innerContext: EmitContext = returnVar ? { ...context, finallyReturnVar: returnVar } : context;
  lines.push('try {');
  if (statement.catchClause) {
    lines.push(
      ...indentSourceLines([
        'try {',
        ...indentSourceLines(emitStatementBody(statement.tryBody, innerContext)),
        '}',
        ...emitCatchClauseCpp(statement.catchClause, innerContext),
      ]),
    );
  } else {
    lines.push(...indentSourceLines(emitStatementBody(statement.tryBody, innerContext)));
  }
  lines.push('}');
  lines.push('catch (...) {');
  lines.push(...indentSourceLines([`${exceptionVar} = std::current_exception();`]));
  lines.push('}');
  lines.push(...emitStatementBody(statement.finallyBody, context));
  lines.push(`if (${exceptionVar}) std::rethrow_exception(${exceptionVar});`);
  if (returnVar) {
    const keyword = context.async ? 'co_return' : 'return';
    lines.push(`if (${returnVar}.has_value()) ${keyword} ${returnVar}.value();`);
  }
  return lines;
}

function emitType(type: Readonly<IrType>, context: EmitContext): string {
  switch (type.kind) {
    case 'array':
      if (getCppRuntimeProfile(context.options) === 'flight-cpp') {
        return `flight::Array<${emitType(type.element, context)}>`;
      }
      context.includes.add('vector');
      return `std::vector<${emitType(type.element, context)}>`;
    case 'function': {
      context.includes.add('functional');
      const parameters = type.parameters.map((parameter) => emitType(parameter.type, context));
      const returns = emitType(type.returns, context);
      return `std::function<${returns}(${parameters.join(', ')})>`;
    }
    case 'indexedAccess':
    case 'keyof':
    case 'typeOf':
      emissionError(context, `${type.kind} types require C++ type computation lowering`);
    case 'intersection':
      emissionError(context, 'intersection types require C++ multiple-inheritance lowering');
    case 'literal':
      return typeof type.value === 'boolean'
        ? 'bool'
        : typeof type.value === 'number'
          ? 'double'
          : emitCppStringType(context);
    case 'named': {
      const sourceName = type.reference.kind === 'ambient' ? type.reference.name : undefined;
      if ((sourceName === 'Readonly' || sourceName === 'Required') && type.typeArguments[0]) {
        return emitType(type.typeArguments[0], context);
      }
      if (sourceName === 'Partial' && type.typeArguments[0]) {
        emissionError(context, 'Partial<T> requires C++ optional-field lowering');
      }
      const mapped = getTypeReferenceTargetName(type, context);
      const arguments_ = type.typeArguments.map((argument) => emitType(argument, context));
      return `${mapped}${arguments_.length > 0 ? `<${arguments_.join(', ')}>` : ''}`;
    }
    case 'never':
      return 'void';
    case 'null':
    case 'undefined':
      return 'void';
    case 'object': {
      const emittedProperties = type.properties.map((property) => ({
        name: safeCppName(property.name),
        optional: property.optional,
        type: emitType(property.type, context),
      }));
      const key = emittedProperties
        .map((property) => `${property.optional ? '?' : ''}${property.type} ${property.name}`)
        .join('; ');
      const existing = context.anonymousStructs.get(key);
      if (existing) return existing.name;
      const structName = generateAnonymousStructName(type.properties, context);
      context.anonymousStructs.set(key, { name: structName, properties: emittedProperties });
      return structName;
    }
    case 'primitive':
      if (type.name === 'string') return emitCppStringType(context);
      if (type.name === 'void') return 'void';
      return {
        bigint: 'int64_t',
        boolean: 'bool',
        number: 'double',
        string: 'std::string',
        symbol: 'int',
        void: 'void',
      }[type.name];
    case 'tuple': {
      context.includes.add('tuple');
      const elements = type.elements.map((element) => {
        const emitted = emitType(element.type, context);
        if (element.optional) {
          context.includes.add('optional');
          return `std::optional<${emitted}>`;
        }
        return emitted;
      });
      return `std::tuple<${elements.join(', ')}>`;
    }
    case 'union': {
      const concrete = type.types.filter((item) => item.kind !== 'null' && item.kind !== 'undefined');
      if (concrete.length === 1 && concrete.length !== type.types.length) {
        context.includes.add('optional');
        return `std::optional<${emitType(concrete[0]!, context)}>`;
      }
      return emitVariantTypeCpp(type, context);
    }
    case 'unknown':
      if (type.source === 'this' && context.currentClass) {
        return getBindingTargetName(context.currentClass.binding, context);
      }
      return 'auto';
  }
}

function emitVariantTypeCpp(type: Readonly<Extract<IrType, { kind: 'union' }>>, context: EmitContext): string {
  const representation = getCppVariantRepresentation(type, context);
  return `std::variant<${representation.alternatives.map((alternative) => alternative.targetType).join(', ')}>`;
}

function emitUnionMemberAssertionCpp(
  expression: Readonly<IrExpression>,
  assertedType: Readonly<IrType>,
  context: EmitContext,
): string | undefined {
  if (expression.kind !== 'identifier' || expression.reference.kind !== 'binding') return undefined;
  const union = getIrBindingVariantUnionTypeCpp(expression.reference.binding.id, context);
  if (!union) return undefined;
  const representation = getCppVariantRepresentation(union, context);
  const alternatives = representation.alternatives.filter((alternative) =>
    isDeepStrictEqual(alternative.member, assertedType),
  );
  if (alternatives.length !== 1) {
    emissionError(context, 'type assertion target must identify exactly one C++ variant alternative');
  }
  return `std::get<${alternatives[0]!.targetType}>(${emitIdentifierReference(expression.reference, context)})`;
}

function emitUnionMemberTestCpp(evidence: Readonly<IrUnionMemberTestEvidence>, context: EmitContext): string {
  const union = getIrBindingVariantUnionTypeCpp(evidence.binding.id, context);
  if (!union) emissionError(context, 'union member test requires a C++ variant binding');
  const representation = getCppVariantRepresentation(union, context);
  const alternatives = representation.alternatives.filter((alternative) =>
    isDeepStrictEqual(alternative.member, evidence.member),
  );
  if (alternatives.length !== 1) {
    emissionError(context, 'union member test must identify exactly one C++ variant alternative');
  }
  const test = `std::holds_alternative<${alternatives[0]!.targetType}>(${emitBindingValueCpp(evidence.binding, context)})`;
  return evidence.whenResult ? test : `!${test}`;
}

function emitNarrowedUnionMemberCpp(
  expression: Readonly<Extract<IrExpression, { kind: 'identifier' }>>,
  context: EmitContext,
): string | undefined {
  if (!expression.narrowedMember || expression.reference.kind !== 'binding') return undefined;
  const union = getIrBindingVariantUnionTypeCpp(expression.reference.binding.id, context);
  if (!union) return undefined;
  const representation = getCppVariantRepresentation(union, context);
  const alternatives = representation.alternatives.filter(
    (alternative) => getIrUnionMemberNameCpp(alternative.member) === expression.narrowedMember,
  );
  if (alternatives.length !== 1) {
    emissionError(context, `narrowed member ${expression.narrowedMember} must identify one C++ variant alternative`);
  }
  return `std::get<${alternatives[0]!.targetType}>(${emitIdentifierReference(expression.reference, context)})`;
}

function getCppVariantRepresentation(
  type: Readonly<Extract<IrType, { kind: 'union' }>>,
  context: EmitContext,
): CppVariantRepresentation {
  if (type.types.some((member) => member.kind === 'null' || member.kind === 'undefined')) {
    emissionError(context, 'unions combining multiple values with null or undefined require optional-variant lowering');
  }
  if (type.types.some((member) => !isIrTypeCppVariantAlternative(member, context, new Set()))) {
    emissionError(context, 'multi-member union contains an unsupported C++ variant alternative');
  }
  const alternatives = type.types.map((member) => {
    const targetType = emitType(member, context);
    return {
      member,
      representationKey: getIrTypeCppVariantRepresentationKey(member, targetType, context, new Set()),
      targetType,
    };
  });
  if (new Set(alternatives.map((alternative) => alternative.representationKey)).size !== alternatives.length) {
    emissionError(context, 'multi-member union alternatives must have unique C++ representations');
  }
  context.includes.add('variant');
  return { alternatives };
}

function getIrTypeCppVariantRepresentationKey(
  type: Readonly<IrType>,
  targetType: string,
  context: EmitContext,
  seen: ReadonlySet<string>,
): string {
  if (type.kind !== 'named' || type.reference.kind !== 'binding' || type.typeArguments.length > 0) return targetType;
  const bindingId = type.reference.binding.id;
  if (seen.has(bindingId)) return targetType;
  const alias = context.module.declarations.find(
    (declaration) => declaration.kind === 'typeAlias' && declaration.binding.id === bindingId,
  );
  if (alias?.kind !== 'typeAlias' || alias.type.kind === 'object') return targetType;
  const nextSeen = new Set(seen);
  nextSeen.add(bindingId);
  const aliasTarget = getIrUnionTypeStringLiteralValues(alias.type)
    ? emitCppStringType(context)
    : emitType(alias.type, context);
  return getIrTypeCppVariantRepresentationKey(alias.type, aliasTarget, context, nextSeen);
}

function getIrBindingVariantUnionTypeCpp(
  bindingId: string,
  context: EmitContext,
): Extract<IrType, { kind: 'union' }> | undefined {
  const type = context.bindingTypes.get(bindingId);
  return type ? getIrVariantUnionTypeCpp(type, context, new Set()) : undefined;
}

function getIrVariantUnionTypeCpp(
  type: Readonly<IrType>,
  context: EmitContext,
  seen: ReadonlySet<string>,
): Extract<IrType, { kind: 'union' }> | undefined {
  if (type.kind === 'union') {
    return type.types.some((member) => member.kind === 'null' || member.kind === 'undefined') ? undefined : type;
  }
  if (type.kind !== 'named' || type.reference.kind !== 'binding' || type.typeArguments.length > 0) return undefined;
  const bindingId = type.reference.binding.id;
  if (seen.has(bindingId)) return undefined;
  const alias = context.module.declarations.find(
    (declaration) => declaration.kind === 'typeAlias' && declaration.binding.id === bindingId,
  );
  if (alias?.kind !== 'typeAlias') return undefined;
  const nextSeen = new Set(seen);
  nextSeen.add(bindingId);
  return getIrVariantUnionTypeCpp(alias.type, context, nextSeen);
}

function getIrUnionMemberNameCpp(type: Readonly<IrType>): string | undefined {
  if (type.kind === 'primitive') return type.name;
  if (type.kind !== 'named') return undefined;
  return type.reference.kind === 'binding' ? type.reference.binding.name : type.reference.name;
}

function isIrTypeCppVariantAlternative(
  type: Readonly<IrType>,
  context: EmitContext,
  seen: ReadonlySet<string>,
): boolean {
  if (type.kind === 'primitive') return type.name !== 'void';
  if (
    type.kind === 'array' ||
    type.kind === 'function' ||
    type.kind === 'literal' ||
    type.kind === 'object' ||
    type.kind === 'tuple'
  ) {
    return true;
  }
  if (type.kind !== 'named') return false;
  if (type.reference.kind !== 'binding' || type.typeArguments.length > 0) return true;
  const bindingId = type.reference.binding.id;
  if (seen.has(bindingId)) return false;
  const alias = context.module.declarations.find(
    (declaration) => declaration.kind === 'typeAlias' && declaration.binding.id === bindingId,
  );
  if (alias?.kind !== 'typeAlias') return true;
  const nextSeen = new Set(seen);
  nextSeen.add(bindingId);
  return alias.type.kind !== 'union' && isIrTypeCppVariantAlternative(alias.type, context, nextSeen);
}

function declarationPriorityCpp(declaration: Readonly<IrDeclaration>): number {
  return declaration.kind === 'class' ||
    declaration.kind === 'typeAlias' ||
    declaration.kind === 'interface' ||
    declaration.kind === 'enum'
    ? 0
    : 1;
}

function emitBindingConstnessCpp(mutable: boolean, type: Readonly<IrType> | undefined): string {
  return !mutable && type && isCppScalarValueType(type) ? 'const ' : '';
}

function isCppScalarValueType(type: Readonly<IrType>): boolean {
  if (type.kind === 'primitive' || type.kind === 'literal') return true;
  if (type.kind === 'union') {
    return type.types.every(
      (member) => member.kind === 'null' || member.kind === 'undefined' || isCppScalarValueType(member),
    );
  }
  return false;
}

function collectIrModuleBindingClassesCpp(
  module: Readonly<IrModule>,
  bindingTypes: ReadonlyMap<string, Readonly<IrType>>,
): ReadonlyMap<string, Readonly<IrClassDeclaration>> {
  const classesByIdentity = new Map(
    module.declarations
      .filter((declaration): declaration is IrClassDeclaration => declaration.kind === 'class')
      .map((declaration) => [declaration.binding.id, declaration] as const),
  );
  const result = new Map(classesByIdentity);
  for (const [bindingId, type] of bindingTypes) {
    if (type.kind !== 'named' || type.reference.kind !== 'binding') continue;
    const declaration = classesByIdentity.get(type.reference.binding.id);
    if (declaration) result.set(bindingId, declaration);
  }
  return result;
}

function collectIrModuleBindingTypesCpp(module: Readonly<IrModule>): ReadonlyMap<string, Readonly<IrType>> {
  const result = new Map<string, Readonly<IrType>>();
  analyzeIrModuleTraversal(module, {
    parameter(parameter) {
      result.set(parameter.binding.id, parameter.type);
    },
    variable(variable) {
      if ('binding' in variable && variable.type) result.set(variable.binding.id, variable.type);
    },
  });
  return result;
}

function collectIrModuleArrayElementBindingIdsCpp(
  module: Readonly<IrModule>,
  bindingTypes: ReadonlyMap<string, Readonly<IrType>>,
): ReadonlySet<string> {
  const result = new Set<string>();
  analyzeIrModuleTraversal(module, {
    variable(variable) {
      if (!('binding' in variable) || variable.initializer?.kind !== 'element') return;
      const initializer = variable.initializer;
      const resolvedReceiver = initializer.semantics.receivers.some(
        (receiver) => receiver === 'array' || receiver.endsWith('Array'),
      );
      const inferredReceiver =
        initializer.object.kind === 'identifier' &&
        initializer.object.reference.kind === 'binding' &&
        bindingTypes.get(initializer.object.reference.binding.id)?.kind === 'array';
      if (resolvedReceiver || inferredReceiver) result.add(variable.binding.id);
    },
  });
  return result;
}

function irFunctionExpressionUsesThisCpp(expression: Readonly<Extract<IrExpression, { kind: 'function' }>>): boolean {
  let usesThis = false;
  const observer = {
    expression(candidate: Readonly<IrExpression>) {
      if (candidate.kind === 'identifier' && candidate.reference.kind === 'this') {
        usesThis = true;
        return false;
      }
      return undefined;
    },
  };
  if (expression.expression) analyzeIrExpressionSubtreeTraversal(expression.expression, observer);
  for (const statement of expression.body) analyzeIrStatementSubtreeTraversal(statement, observer);
  return usesThis;
}

function getIrExpressionClassDeclarationCpp(
  expression: Readonly<IrExpression>,
  context: EmitContext,
): Readonly<IrClassDeclaration> | undefined {
  if (expression.kind === 'identifier') {
    if (expression.reference.kind === 'this') return context.currentClass;
    if (expression.reference.kind === 'binding') return context.bindingClasses.get(expression.reference.binding.id);
  }
  if (
    expression.kind === 'new' &&
    expression.callee.kind === 'identifier' &&
    expression.callee.reference.kind === 'binding'
  ) {
    return context.bindingClasses.get(expression.callee.reference.binding.id);
  }
  return undefined;
}

function getIrExpressionClassAccessorCpp(
  expression: Readonly<IrExpression>,
  name: string,
  accessor: 'get' | 'set',
  context: EmitContext,
): boolean {
  const declaration = getIrExpressionClassDeclarationCpp(expression, context);
  return declaration?.methods.some((method) => method.accessor === accessor && method.name === name) ?? false;
}

function emitAssignmentTargetCpp(expression: Readonly<IrExpression>, context: EmitContext): string {
  if (
    expression.kind === 'element' &&
    getCppRuntimeProfile(context.options) === 'flight-cpp' &&
    hasIndexedRuntimeReceiverCpp(expression, context)
  ) {
    return `${emitExpression(expression.object, context)}.element(${emitExpression(expression.index, context)})`;
  }
  return emitExpression(expression, context);
}

function emitOptionalExpressionCpp(
  expression: Readonly<IrExpression>,
  context: EmitContext,
  expectedType: Readonly<IrType> | undefined,
): string {
  if (
    expression.kind === 'element' &&
    getCppRuntimeProfile(context.options) === 'flight-cpp' &&
    hasIndexedRuntimeReceiverCpp(expression, context)
  ) {
    return `${emitExpression(expression.object, context)}.get(${emitExpression(expression.index, context)})`;
  }
  if (
    expression.kind === 'property' &&
    expression.absent === 'optionalMember' &&
    expression.object.kind === 'element' &&
    getCppRuntimeProfile(context.options) === 'flight-cpp' &&
    hasIndexedRuntimeReceiverCpp(expression.object, context)
  ) {
    if (!expectedType) {
      emissionError(context, 'an optional indexed member requires contextual result type in C++ emission');
    }
    const payload = emitType(expectedType, context);
    const receiver = `${emitExpression(expression.object.object, context)}.get(${emitExpression(expression.object.index, context)})`;
    context.includes.add('optional');
    return `([&]() -> std::optional<${payload}> { auto optional_chain_receiver = ${receiver}; if (!optional_chain_receiver.has_value()) return std::nullopt; return optional_chain_receiver.value().${safeCppName(expression.name)}; }())`;
  }
  return emitExpression(expression, context);
}

function emitOptionalCallExpressionCpp(
  expression: Readonly<Extract<IrExpression, { kind: 'call' }>>,
  context: EmitContext,
): string {
  const semantics = expression.semantics.optionalChain;
  if (!semantics) emissionError(context, 'optional call lacks neutral optional-chain evidence');
  if (semantics.receiverNullish === 'excluded') {
    return emitExpression({ ...expression, optional: false }, context);
  }
  const payload = emitOptionalChainPayloadTypeCpp(semantics.valueType, context);
  const callee = emitOptionalChainReceiverCpp(expression.callee, context);
  const arguments_ = expression.arguments.map((argument) => emitExpression(argument, context)).join(', ');
  context.includes.add('optional');
  return `([&]() -> std::optional<${payload}> { auto optional_chain_receiver = ${callee}; if (!optional_chain_receiver.has_value()) return std::nullopt; return optional_chain_receiver.value()(${arguments_}); }())`;
}

function emitOptionalElementExpressionCpp(
  expression: Readonly<Extract<IrExpression, { kind: 'element' }>>,
  context: EmitContext,
): string {
  const semantics = expression.semantics.optionalChain;
  if (!semantics) emissionError(context, 'optional element access lacks neutral optional-chain evidence');
  if (semantics.receiverNullish === 'excluded') {
    return emitExpression({ ...expression, optional: false }, context);
  }
  const payload = emitOptionalChainPayloadTypeCpp(semantics.valueType, context);
  const object = emitOptionalChainReceiverCpp(expression.object, context);
  const index = emitExpression(expression.index, context);
  context.includes.add('optional');
  if (semantics.receiverType.kind === 'union') {
    const receiver = getOptionalPayloadTypeCpp(semantics.receiverType, context);
    if (receiver.kind === 'tuple') {
      const tupleIndex = getElementAccessTupleIndexCpp(expression, context);
      return `([&]() -> std::optional<${payload}> { auto optional_chain_receiver = ${object}; if (!optional_chain_receiver.has_value()) return std::nullopt; return std::get<${String(tupleIndex)}>(optional_chain_receiver.value()); }())`;
    }
    if (receiver.kind === 'array') {
      return `([&]() -> std::optional<${payload}> { auto optional_chain_receiver = ${object}; if (!optional_chain_receiver.has_value()) return std::nullopt; return optional_chain_receiver.value().get(${index}); }())`;
    }
  }
  emissionError(context, 'optional element access requires nullable array or fixed-tuple receiver evidence');
}

function emitOptionalPropertyExpressionCpp(
  expression: Readonly<Extract<IrExpression, { kind: 'property' }>>,
  context: EmitContext,
): string {
  const semantics = expression.optionalChain;
  if (!semantics) emissionError(context, 'optional property access lacks neutral optional-chain evidence');
  const indexesRuntimeCollection =
    expression.object.kind === 'element' &&
    getCppRuntimeProfile(context.options) === 'flight-cpp' &&
    hasIndexedRuntimeReceiverCpp(expression.object, context);
  if (semantics.receiverNullish === 'excluded' && !indexesRuntimeCollection) {
    return emitExpression({ ...expression, optional: false }, context);
  }
  const payload = emitOptionalChainPayloadTypeCpp(semantics.valueType, context);
  const object = emitOptionalChainReceiverCpp(expression.object, context);
  let projected: string;
  if (expression.member) {
    const binding = getCompilerCppAmbientMemberBinding(expression.member, getCppRuntimeProfile(context.options));
    if (binding?.kind === 'sizeMethod') {
      projected = 'static_cast<double>(optional_chain_receiver.value().size())';
    } else if (binding?.kind === 'property') {
      projected = `optional_chain_receiver.value().${binding.targetName}`;
    } else {
      projected = `optional_chain_receiver.value().${safeCppName(expression.name)}`;
    }
  } else if (getIrExpressionClassAccessorCpp(expression.object, expression.name, 'get', context)) {
    projected = `optional_chain_receiver.value().${safeCppName(expression.name)}()`;
  } else {
    projected = `optional_chain_receiver.value().${safeCppName(expression.name)}`;
  }
  context.includes.add('optional');
  return `([&]() -> std::optional<${payload}> { auto optional_chain_receiver = ${object}; if (!optional_chain_receiver.has_value()) return std::nullopt; return ${projected}; }())`;
}

function emitOptionalChainReceiverCpp(expression: Readonly<IrExpression>, context: EmitContext): string {
  if (
    expression.kind === 'element' &&
    getCppRuntimeProfile(context.options) === 'flight-cpp' &&
    hasIndexedRuntimeReceiverCpp(expression, context)
  ) {
    return `${emitExpression(expression.object, context)}.get(${emitExpression(expression.index, context)})`;
  }
  return emitExpression(expression, context);
}

function emitOptionalChainPayloadTypeCpp(type: Readonly<IrType>, context: EmitContext): string {
  return emitType(hasIrTypeAbsentMember(type) ? getOptionalPayloadTypeCpp(type, context) : type, context);
}

function getOptionalPayloadTypeCpp(type: Readonly<IrType>, context: EmitContext): Readonly<IrType> {
  if (type.kind !== 'union') emissionError(context, 'optional chain receiver requires a nullable union type');
  const concrete = type.types.filter((member) => member.kind !== 'null' && member.kind !== 'undefined');
  if (concrete.length !== 1) {
    emissionError(context, 'optional chain receiver requires one concrete nullable union member');
  }
  return concrete[0]!;
}

function emitOptionalTypeCpp(type: string, optional: boolean, context: EmitContext): string {
  if (!optional) return type;
  context.includes.add('optional');
  return `std::optional<${type}>`;
}

function hasIndexedRuntimeReceiverCpp(
  expression: Readonly<Extract<IrExpression, { kind: 'element' }>>,
  context: EmitContext,
): boolean {
  if (expression.semantics.receivers.some((receiver) => receiver === 'array' || receiver.endsWith('Array'))) {
    return true;
  }
  if (expression.object.kind !== 'identifier' || expression.object.reference.kind !== 'binding') return false;
  const type = context.bindingTypes.get(expression.object.reference.binding.id);
  return type?.kind === 'array';
}

function hasSharedReferentRepresentationCpp(type: Readonly<IrType>, context: EmitContext): boolean {
  if (getCppRuntimeProfile(context.options) !== 'flight-cpp') return false;
  if (type.kind === 'array') return true;
  return (
    type.kind === 'named' && type.reference.kind === 'ambient' && cppSharedReferentRuntimeTypes.has(type.reference.name)
  );
}

function getExpectedReturnTypeCpp(context: EmitContext): Readonly<IrType> | undefined {
  if (!context.enclosingReturnType) return undefined;
  return context.async ? getIrTaskAwaitedTypeCpp(context.enclosingReturnType, context) : context.enclosingReturnType;
}

function collectDefaultedParameterIdsCpp(parameters: readonly IrParameter[]): ReadonlySet<string> {
  return new Set(parameters.filter((parameter) => parameter.initializer).map((parameter) => parameter.binding.id));
}

function emitParameterInitializersCpp(parameters: readonly IrParameter[], context: EmitContext): string[] {
  const parameterBindingIds = new Set(parameters.map((parameter) => parameter.binding.id));
  const initializedSharedCaptureTargetNames = new Map(
    [...context.sharedCaptureTargetNames].filter(([bindingId]) => !parameterBindingIds.has(bindingId)),
  );
  const lines: string[] = [];
  for (const parameter of parameters) {
    const parameterTargetName = getBindingTargetName(parameter.binding, context);
    if (parameter.initializer) {
      lines.push(
        `${parameterTargetName} = ${parameterTargetName}.value_or(${emitExpression(parameter.initializer, { ...context, sharedCaptureTargetNames: initializedSharedCaptureTargetNames }, parameter.type)});`,
      );
    }
    const sharedCaptureTargetName = context.sharedCaptureTargetNames.get(parameter.binding.id);
    if (!sharedCaptureTargetName) continue;
    const parameterType = emitType(parameter.type, context);
    const sharedType = emitOptionalTypeCpp(parameterType, parameter.optional, context);
    context.includes.add('memory');
    lines.push(`const auto ${sharedCaptureTargetName} = std::make_shared<${sharedType}>(${parameterTargetName});`);
    initializedSharedCaptureTargetNames.set(parameter.binding.id, sharedCaptureTargetName);
  }
  return lines;
}

function hasSharedCaptureParameterCpp(parameters: readonly IrParameter[], context: EmitContext): boolean {
  return parameters.some((parameter) => context.sharedCaptureTargetNames.has(parameter.binding.id));
}

function emitImplicitCompletionCpp(statements: readonly IrStatement[], context: EmitContext): string[] {
  if (statementsDefinitelyCompleteCpp(statements)) return [];
  const returnType = getExpectedReturnTypeCpp(context);
  if (!returnType) return [];
  const voidReturn = returnType.kind === 'primitive' && returnType.name === 'void';
  if (!context.async && voidReturn) return [];
  if (hasIrTypeAbsentMember(returnType)) {
    context.includes.add('optional');
    return [`${context.async ? 'co_return' : 'return'} std::nullopt;`];
  }
  if (context.async && voidReturn) return ['co_return;'];
  context.includes.add('stdexcept');
  return context.async
    ? ['co_await std::suspend_never{};', 'throw std::logic_error("Flight async function completed without a value");']
    : ['throw std::logic_error("Flight function completed without a value");'];
}

function statementsDefinitelyCompleteCpp(statements: readonly IrStatement[]): boolean {
  return statements.some(statementDefinitelyCompletesCpp);
}

function statementDefinitelyCompletesCpp(statement: Readonly<IrStatement>): boolean {
  switch (statement.kind) {
    case 'return':
    case 'throw':
      return true;
    case 'block':
      return statementsDefinitelyCompleteCpp(statement.statements);
    case 'if':
      return Boolean(
        statement.otherwise &&
        statementDefinitelyCompletesCpp(statement.consequent) &&
        statementDefinitelyCompletesCpp(statement.otherwise),
      );
    case 'try':
      if (statement.finallyBody && statementDefinitelyCompletesCpp(statement.finallyBody)) return true;
      return Boolean(
        statement.catchClause &&
        statementDefinitelyCompletesCpp(statement.tryBody) &&
        statementDefinitelyCompletesCpp(statement.catchClause.body),
      );
    default:
      return false;
  }
}

function emitParameter(parameter: Readonly<IrParameter>, context: EmitContext): string {
  const name = getBindingTargetName(parameter.binding, context);
  const type = parameter.type ? emitType(parameter.type, context) : 'auto';
  if (parameter.optional) {
    context.includes.add('optional');
    return `std::optional<${type}> ${name} = std::nullopt`;
  }
  if (parameter.rest) {
    return `${type} ${name}`;
  }
  return `${type} ${name}`;
}

function emitImports(imports: readonly IrImport[], context: EmitContext): string[] {
  return imports.flatMap((importItem) => {
    if (!importItem.specifier.startsWith('.')) return [];
    const target = path.posix.normalize(
      path.posix.join(path.posix.dirname(context.module.source), importItem.specifier.replace(/\.[cm]?js$/u, '.ts')),
    );
    const resolved = /\.tsx?$/u.test(target) ? target : `${target}.ts`;
    const fileName = convertSourcePathToCppFileName(resolved);
    if (!fileName) return [];
    return [`#include "${fileName}.hpp"`];
  });
}

function emitTypeParameters(parameters: readonly IrTypeParameter[], context: EmitContext): string {
  if (parameters.length === 0) return '';
  return `<${parameters.map((parameter) => `typename ${context.targetNames.get(parameter.binding.id) ?? pascalCase(parameter.binding.name)}`).join(', ')}>`;
}

function emitIdentifierReference(
  reference: Readonly<IrExpression & { kind: 'identifier' }>['reference'],
  context: EmitContext,
): string {
  if (reference.kind === 'ambient') {
    const target = getCompilerRuntimeExternalSymbolTargetCpp(
      reference.name,
      'value',
      getCppRuntimeProfile(context.options),
    );
    if (target) return target;
    return reference.name;
  }
  if (reference.kind === 'this') return 'this';
  if (reference.kind === 'super') {
    const base = context.currentClass?.extends;
    if (base && base.kind === 'named' && base.reference.kind === 'binding') {
      return context.targetNames.get(base.reference.binding.id) ?? safeCppName(base.reference.binding.name);
    }
    return 'super';
  }
  return emitBindingValueCpp(reference.binding, context);
}

function emitBindingValueCpp(binding: Readonly<{ id: string; name: string }>, context: EmitContext): string {
  const sharedCaptureTargetName = context.sharedCaptureTargetNames.get(binding.id);
  if (sharedCaptureTargetName) return `(*${sharedCaptureTargetName})`;
  return context.targetNames.get(binding.id) ?? safeCppName(binding.name);
}

function isSuperAccess(expression: Readonly<IrExpression>): boolean {
  return expression.kind === 'identifier' && expression.reference.kind === 'super';
}

function isThisAccess(expression: Readonly<IrExpression>): boolean {
  return expression.kind === 'identifier' && expression.reference.kind === 'this';
}

function memberOp(object: Readonly<IrExpression>): string {
  if (isSuperAccess(object)) return '::';
  return isThisAccess(object) ? '->' : '.';
}

function emitLiteral(value: boolean | null | number | string, context: EmitContext): string {
  if (value === null) return 'nullptr';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return 'std::numeric_limits<double>::quiet_NaN()';
    if (!Number.isFinite(value))
      return value > 0 ? 'std::numeric_limits<double>::infinity()' : '-std::numeric_limits<double>::infinity()';
    const text = String(value);
    return /[.eE]/u.test(text) ? text : `${text}.0`;
  }
  const literal = JSON.stringify(value);
  return getCppRuntimeProfile(context.options) === 'flight-cpp' ? `flight::String(${literal})` : literal;
}

function emitStringConcatenation(expression: Readonly<IrExpression>, context: EmitContext): string {
  if (getCppRuntimeProfile(context.options) !== 'flight-cpp') context.includes.add('string');
  const parts = collectStringParts(expression, context);
  return parts.join(' + ');
}

function emitCppStringType(context: EmitContext): string {
  if (getCppRuntimeProfile(context.options) === 'flight-cpp') return 'flight::String';
  context.includes.add('string');
  return 'std::string';
}

function emitCppTypeArguments(types: readonly Readonly<IrType>[], context: EmitContext): string {
  return types.length === 0 ? '' : `<${types.map((type) => emitType(type, context)).join(', ')}>`;
}

function collectStringParts(expression: Readonly<IrExpression>, context: EmitContext): string[] {
  if (
    expression.kind === 'binary' &&
    expression.operator === '+' &&
    expression.semantics.left.flow === 'string' &&
    expression.semantics.right.flow === 'string'
  ) {
    return [...collectStringParts(expression.left, context), ...collectStringParts(expression.right, context)];
  }
  return [emitExpression(expression, context)];
}

function emitTupleSpreadExpressionCpp(
  expression: Readonly<Extract<IrExpression, { kind: 'tupleSpread' }>>,
  context: EmitContext,
): string {
  context.includes.add('tuple');
  const declarations: string[] = [];
  const elements: string[] = [];
  let resultIndex = 0;
  for (const segment of expression.segments) {
    if (segment.kind === 'element') {
      const target = expression.type.elements[resultIndex]!;
      if (!segment.element.expression) {
        context.includes.add('optional');
        elements.push('std::nullopt');
      } else {
        const name = getGeneratedTargetName('tuple_spread_element', context);
        declarations.push(`auto ${name} = ${emitExpression(segment.element.expression, context)};`);
        if (target.optional) {
          context.includes.add('optional');
          elements.push(`std::make_optional(${name})`);
        } else {
          elements.push(name);
        }
      }
      resultIndex += 1;
      continue;
    }
    const name = getGeneratedTargetName('tuple_spread_value', context);
    declarations.push(`auto ${name} = ${emitExpression(segment.expression, context)};`);
    segment.type.elements.forEach((element, offset) => {
      const value = `std::get<${String(offset)}>(${name})`;
      const target = expression.type.elements[resultIndex + offset]!;
      if (target.optional && !element.optional) {
        context.includes.add('optional');
        elements.push(`std::make_optional(${value})`);
      } else {
        elements.push(value);
      }
    });
    resultIndex += segment.type.elements.length;
  }
  const tuple = `std::make_tuple(${elements.join(', ')})`;
  return `([&]() { ${declarations.join(' ')} return ${tuple}; })()`;
}

function emitAssignmentOperator(operator: string): string {
  if (operator === '**=') return '=';
  if (operator === '>>>=') return '=';
  return operator;
}

function emitBinaryOperator(
  operator: IrBinaryOperator,
  _semantics: Readonly<IrBinaryOperatorSemantics>,
  _context: EmitContext,
): string {
  if (operator === '===' || operator === '==') return '==';
  if (operator === '!==' || operator === '!=') return '!=';
  if (operator === '&&') return '&&';
  if (operator === '||') return '||';
  return operator;
}

function emitPrefixUnaryOperator(operator: string): string {
  if (operator === 'typeof') return 'typeid';
  if (operator === 'void') return '(void)';
  return operator;
}

function emitPostfixUnaryOperator(operator: string): string {
  return operator;
}

function getTypeReferenceTargetName(type: Readonly<IrType & { kind: 'named' }>, context: EmitContext): string {
  if (type.reference.kind === 'ambient') {
    const target = getCompilerRuntimeExternalSymbolTargetCpp(
      type.reference.name,
      'type',
      getCppRuntimeProfile(context.options),
    );
    if (target) return target;
    return type.reference.name;
  }
  return context.targetNames.get(type.reference.binding.id) ?? pascalCase(type.reference.binding.name);
}

function getBindingTargetName(binding: Readonly<{ id: string; name: string }>, context: EmitContext): string {
  return context.targetNames.get(binding.id) ?? safeCppName(binding.name);
}

function getCppRuntimeProfile(options: Readonly<CppCompilerBackendOptions>): CppCompilerRuntimeProfile {
  return options.runtimeProfile ?? 'standard-library';
}

function getIrTaskAwaitedTypeCpp(type: Readonly<IrType>, context: EmitContext): Readonly<IrType> {
  if (type.kind !== 'named' || type.reference.kind !== 'ambient' || type.reference.name !== 'Promise') {
    emissionError(context, 'an async function must return a task type');
  }
  const awaited = type.typeArguments[0];
  if (type.typeArguments.length !== 1 || !awaited) {
    emissionError(context, 'a task type requires one awaited type argument');
  }
  return awaited;
}

function getElementAccessTupleIndexCpp(
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

function getGeneratedTargetName(base: string, context: EmitContext): string {
  let candidate = safeCppName(base);
  let counter = 2;
  while (context.generatedNames.has(candidate)) {
    candidate = `${safeCppName(base)}_${String(counter)}`;
    counter += 1;
  }
  context.generatedNames.add(candidate);
  return candidate;
}

function getIrExpressionEnumDeclaration(
  expression: Readonly<IrExpression>,
  context: EmitContext,
): Readonly<IrEnumDeclaration> | undefined {
  if (expression.kind !== 'identifier' || expression.reference.kind !== 'binding') return undefined;
  return context.module.declarations.find(
    (candidate) =>
      candidate.kind === 'enum' &&
      expression.reference.kind === 'binding' &&
      candidate.binding.id === expression.reference.binding.id,
  ) as IrEnumDeclaration | undefined;
}

function assertRuntimeExternalSymbolBindingsCpp(
  module: Readonly<IrModule>,
  options: Readonly<CppCompilerBackendOptions> = {},
): void {
  const completeness = analyzeCompilerRuntimeExternalSymbolCompleteness(
    collectIrModulesRuntimeExternalSymbolIdentities([module]),
    createCompilerRuntimeExternalSymbolBindingPlanCpp(getCppRuntimeProfile(options)),
  );
  if (completeness.kind === 'complete') return;
  const problems = [
    completeness.missingExternalSymbols.length > 0
      ? `missing: ${completeness.missingExternalSymbols.map((identity) => `${identity.sourceName}[${identity.space}]`).join(', ')}`
      : undefined,
    completeness.duplicateExternalSymbols.length > 0
      ? `duplicate: ${completeness.duplicateExternalSymbols.map((identity) => `${identity.sourceName}[${identity.space}]`).join(', ')}`
      : undefined,
  ].filter((problem): problem is string => problem !== undefined);
  throw createBackendEmissionFailure(
    'cpp',
    module,
    `runtime external symbol binding plan is incomplete (${problems.join('; ')})`,
  );
}

function generateUniqueName(base: string, context: EmitContext): string {
  let candidate = base;
  let suffix = 0;
  while (context.generatedNames.has(candidate)) {
    suffix++;
    candidate = `${base}_${suffix}`;
  }
  context.generatedNames.add(candidate);
  return candidate;
}

function generateAnonymousStructName(properties: readonly { readonly name: string }[], context: EmitContext): string {
  const base = properties.map((property) => snakeCase(property.name)).join('_');
  let candidate = base || 'anonymous';
  let suffix = 0;
  while (context.generatedNames.has(candidate)) {
    suffix++;
    candidate = `${base}_${suffix}`;
  }
  context.generatedNames.add(candidate);
  return candidate;
}

function safeCppName(name: string): string {
  const snake = snakeCase(name);
  return isCppCompilerKeyword(snake) ? `${snake}_` : snake;
}

function safeCppTypeName(name: string): string {
  return pascalCase(name);
}

function snakeCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/gu, '$1_$2')
    .replace(/[^A-Za-z0-9]+/gu, '_')
    .replace(/^_+|_+$/gu, '')
    .toLowerCase();
}

function pascalCase(value: string): string {
  return value
    .replace(/(?:^|[_\-\s])([a-zA-Z])/gu, (_, letter: string) => letter.toUpperCase())
    .replace(/[^A-Za-z0-9]/gu, '');
}

function extractSuperCallCpp(body: readonly Readonly<IrStatement>[], context: EmitContext): string | undefined {
  for (const statement of body) {
    if (
      statement.kind !== 'expression' ||
      statement.expression.kind !== 'call' ||
      statement.expression.callee.kind !== 'identifier' ||
      statement.expression.callee.reference.kind !== 'super'
    ) {
      continue;
    }
    const callee = statement.expression.callee;
    const baseName = emitIdentifierReference(callee.reference, context);
    const args = statement.expression.arguments.map((argument: Readonly<IrExpression>) =>
      emitExpression(argument, context),
    );
    return `${baseName}(${args.join(', ')})`;
  }
  return undefined;
}

function getIrClassInheritedMethodNamesCpp(
  declaration: Readonly<IrClassDeclaration>,
  context: EmitContext,
): ReadonlySet<string> {
  const names = new Set<string>();
  let base = declaration.extends;
  const visited = new Set<string>();
  while (
    base &&
    base.kind === 'named' &&
    base.reference.kind === 'binding' &&
    !visited.has(base.reference.binding.id)
  ) {
    visited.add(base.reference.binding.id);
    const reference = base.reference;
    const target = context.module.declarations.find(
      (candidate) => candidate.kind === 'class' && candidate.binding.id === reference.binding.id,
    );
    if (target?.kind !== 'class') break;
    for (const method of target.methods) {
      names.add(method.name);
    }
    base = target.extends;
  }
  return names;
}

function hasIrModuleSubclassCpp(declaration: Readonly<IrClassDeclaration>, context: EmitContext): boolean {
  return context.module.declarations.some(
    (candidate) =>
      candidate.kind === 'class' &&
      candidate.extends?.kind === 'named' &&
      candidate.extends.reference.kind === 'binding' &&
      candidate.extends.reference.binding.id === declaration.binding.id,
  );
}

function isSuperCallStatement(statement: Readonly<IrStatement>): boolean {
  return (
    statement.kind === 'expression' &&
    statement.expression.kind === 'call' &&
    statement.expression.callee.kind === 'identifier' &&
    statement.expression.callee.reference.kind === 'super'
  );
}

function emissionError(context: EmitContext, message: string): never {
  throw createBackendEmissionFailure('cpp', context.module, message);
}

const cppMathSpreadFoldTargets: Readonly<Record<string, { algorithm: string; identity: string }>> = {
  max: { algorithm: 'std::max_element', identity: '-std::numeric_limits<double>::infinity()' },
  min: { algorithm: 'std::min_element', identity: 'std::numeric_limits<double>::infinity()' },
};

const cppSharedReferentRuntimeTypes = new Set([
  'Float32Array',
  'Float64Array',
  'Int16Array',
  'Int32Array',
  'Int8Array',
  'Map',
  'Set',
  'Uint16Array',
  'Uint32Array',
  'Uint8Array',
  'Uint8ClampedArray',
]);
