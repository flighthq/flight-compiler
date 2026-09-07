import path from 'node:path';

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
  IrVariable,
  IrVariableDeclaration,
} from '../../compiler-types/src/index.js';
import { getCompilerCppAmbientMemberBinding } from './cppAmbientMemberBinding.js';
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
  properties: readonly { name: string; type: string }[];
}

interface EmitContext {
  anonymousStructs: Map<string, AnonymousStruct>;
  currentClass?: Readonly<IrClassDeclaration> | undefined;
  includes: Set<string>;
  module: Readonly<IrModule>;
  nullableBindingIds: ReadonlySet<string>;
  options: Readonly<CppCompilerBackendOptions>;
  returnsAbsent: boolean;
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
  assertRuntimeExternalSymbolBindingsCpp(module);
  let targetNames: Map<string, string>;
  try {
    targetNames = new Map(
      createIrModuleTargetNameAllocation(module, (binding) => ({
        namespace: 'identifier',
        preferredName: snakeCase(binding.name),
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
  const context: EmitContext = {
    anonymousStructs: new Map(),
    includes: new Set<string>(),
    module,
    nullableBindingIds: collectIrModuleNullableBindingIds(module),
    options,
    returnsAbsent: false,
    targetNames,
    generatedNames: new Set(targetNames.values()),
  };
  const declarations = module.declarations.map((declaration) => emitDeclaration(declaration, context));
  const imports = emitImports(module.imports, context);
  const lines = [createCompilerGeneratedFileHeader(module, '//', options.upstreamCommit)];
  lines.push('#pragma once');
  const sortedIncludes = [...context.includes].sort();
  for (const include of sortedIncludes) {
    lines.push(`#include <${include}>`);
  }
  if (options.runtimeHeader) lines.push(`#include "${options.runtimeHeader}"`);
  if (imports.length > 0) lines.push('', ...imports);
  const namespaceName = convertPackageNameToCppNamespace(module.packageName);
  lines.push('', `namespace ${namespaceName} {`);
  for (const struct of context.anonymousStructs.values()) {
    lines.push('');
    lines.push(`struct ${struct.name} {`);
    for (const property of struct.properties) {
      lines.push(`  ${property.type} ${property.name};`);
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
    if (field.static) continue;
    const fieldType = field.type ? emitType(field.type, context) : 'auto';
    lines.push(`  ${fieldType} ${safeCppName(field.name)};`);
  }
  if (declaration.classConstructor) {
    const params = declaration.classConstructor.parameters
      .map((parameter) => emitParameter(parameter, context))
      .join(', ');
    const superCall = declaration.extends ? extractSuperCallCpp(declaration.classConstructor.body, context) : undefined;
    const initList = superCall ? ` : ${superCall}` : '';
    const body = superCall
      ? declaration.classConstructor.body.filter((statement) => !isSuperCallStatement(statement))
      : declaration.classConstructor.body;
    lines.push(`  ${name}(${params})${initList} {`);
    lines.push(...indentSourceLines(emitStatements(body, context), 2));
    lines.push('  }');
  }
  if (hasSubclass || declaration.abstract) {
    lines.push(`  virtual ~${name}() = default;`);
  }
  for (const method of declaration.methods) {
    if (method.static) continue;
    const returnType = emitType(method.returns, context);
    const params = method.parameters.map((parameter) => emitParameter(parameter, context)).join(', ');
    const methodName = safeCppName(method.name);
    if (method.abstract) {
      lines.push(`  virtual ${returnType} ${methodName}(${params}) = 0;`);
      continue;
    }
    const needsVirtual = hasSubclass || declaration.abstract || overriddenMethods.has(method.name);
    const virtual = needsVirtual && !overriddenMethods.has(method.name) ? 'virtual ' : '';
    const override = overriddenMethods.has(method.name) ? ' override' : '';
    lines.push(`  ${virtual}${returnType} ${methodName}(${params})${override} {`);
    lines.push(...indentSourceLines(emitStatements(method.body, context), 2));
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
    const value = member.value !== undefined ? ` = ${emitLiteral(member.value)}` : '';
    lines.push(`  ${safeCppTypeName(member.name)}${value},`);
  }
  lines.push('};');
  return lines;
}

function emitStringEnumCpp(declaration: Readonly<IrEnumDeclaration>, context: EmitContext): string[] {
  context.includes.add('string');
  const name = getBindingTargetName(declaration.binding, context);
  return [`using ${name} = std::string;`];
}

function emitFunction(declaration: Readonly<IrFunctionDeclaration>, outer: EmitContext): string[] {
  const context: EmitContext = {
    ...outer,
    enclosingReturnType: declaration.returns,
    returnsAbsent: hasIrTypeAbsentMember(declaration.returns),
  };
  if (declaration.async) emissionError(context, 'async functions require C++ coroutine lowering');
  const returnType = emitType(declaration.returns, context);
  const typeParams = emitTypeParameters(declaration.typeParameters, context);
  const params = declaration.parameters.map((parameter) => emitParameter(parameter, context)).join(', ');
  const name = getBindingTargetName(declaration.binding, context);
  const lines: string[] = [];
  if (typeParams) lines.push(`template ${typeParams}`);
  lines.push(`${returnType} ${name}(${params}) {`);
  lines.push(...indentSourceLines(emitStatements(declaration.body, context)));
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
    const propType = emitType(property.type, context);
    lines.push(`  ${propType} ${safeCppName(property.name)};`);
  }
  lines.push('};');
  return lines;
}

function emitTypeAlias(declaration: Readonly<IrTypeAliasDeclaration>, context: EmitContext): string[] {
  const stringLiterals = getIrUnionTypeStringLiteralValues(declaration.type);
  if (stringLiterals) return emitStringLiteralUnionCpp(declaration, context);
  const name = getBindingTargetName(declaration.binding, context);
  const typeParams = emitTypeParameters(declaration.typeParameters, context);
  const lines: string[] = [];
  if (typeParams) lines.push(`template ${typeParams}`);
  lines.push(`using ${name} = ${emitType(declaration.type, context)};`);
  return lines;
}

function emitStringLiteralUnionCpp(declaration: Readonly<IrTypeAliasDeclaration>, context: EmitContext): string[] {
  context.includes.add('string');
  return [`using ${getBindingTargetName(declaration.binding, context)} = std::string;`];
}

function emitVariableDeclaration(declaration: Readonly<IrVariableDeclaration>, context: EmitContext): string[] {
  if ('pattern' in declaration) {
    emissionError(context, 'binding patterns require destructuring lowering before C++ emission');
  }
  const name = getBindingTargetName(declaration.binding, context);
  const type = declaration.type ? emitType(declaration.type, context) : 'auto';
  const constness = declaration.mutable ? '' : 'const ';
  const initializer = declaration.initializer ? ` = ${emitExpression(declaration.initializer, context)}` : '';
  return [`${constness}${type} ${name}${initializer};`];
}

function emitVariable(variable: Readonly<IrVariable>, context: EmitContext): string {
  if ('pattern' in variable) {
    emissionError(context, 'binding patterns require destructuring lowering before C++ emission');
  }
  const name = getBindingTargetName(variable.binding, context);
  const type = variable.type ? emitType(variable.type, context) : 'auto';
  const constness = variable.mutable ? '' : 'const ';
  const initializer = variable.initializer ? ` = ${emitExpression(variable.initializer, context)}` : '';
  return `${constness}${type} ${name}${initializer};`;
}

function emitExpression(expression: Readonly<IrExpression>, context: EmitContext): string {
  switch (expression.kind) {
    case 'array': {
      context.includes.add('vector');
      const elements = expression.elements.map((element) => (element ? emitExpression(element, context) : '{}'));
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
      const left = emitExpression(expression.left, context);
      const right = emitExpression(expression.right, context);
      return `${left} ${emitAssignmentOperator(expression.operator)} ${right}`;
    }
    case 'await':
      emissionError(context, 'await expressions require C++ coroutine lowering');
    case 'binary': {
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
        return `${emitExpression(expression.left, context)}.value_or(${emitExpression(expression.right, context)})`;
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
      if (expression.callee.kind === 'property' && expression.callee.member) {
        const binding = getCompilerCppAmbientMemberBinding(expression.callee.member);
        if (binding && binding.kind === 'sizeMethod') {
          const receiver = emitExpression(expression.callee.object, context);
          return `static_cast<double>(${receiver}${memberOp(expression.callee.object)}${binding.targetName}())`;
        }
        if (binding && binding.kind === 'method') {
          const receiver = emitExpression(expression.callee.object, context);
          const args = expression.arguments.map((argument) => emitExpression(argument, context));
          return `${receiver}${memberOp(expression.callee.object)}${binding.targetName}(${args.join(', ')})`;
        }
      }
      if (
        expression.callee.kind === 'property' &&
        expression.callee.member?.receiver === 'number' &&
        expression.callee.member.name === 'toString'
      ) {
        context.includes.add('string');
        return `std::to_string(${emitExpression(expression.callee.object, context)})`;
      }
      const callee =
        expression.callee.kind === 'function'
          ? `(${emitExpression(expression.callee, context)})`
          : emitExpression(expression.callee, context);
      const args = expression.arguments.map((argument) => emitExpression(argument, context));
      return `${callee}(${args.join(', ')})`;
    }
    case 'cast':
      return `static_cast<${emitType(expression.type, context)}>(${emitExpression(expression.expression, context)})`;
    case 'conditional':
      return `(${emitExpression(expression.condition, context)} ? ${emitExpression(expression.whenTrue, context)} : ${emitExpression(expression.whenFalse, context)})`;
    case 'element':
      return `${emitExpression(expression.object, context)}[static_cast<size_t>(${emitExpression(expression.index, context)})]`;
    case 'function': {
      if (expression.async) emissionError(context, 'async closures require C++ coroutine lowering');
      context.includes.add('functional');
      const params = expression.parameters.map((parameter) => {
        const paramType = parameter.type ? emitType(parameter.type, context) : 'auto';
        return `${paramType} ${getBindingTargetName(parameter.binding, context)}`;
      });
      if (expression.expression) {
        return `[=](${params.join(', ')}) { return ${emitExpression(expression.expression, context)}; }`;
      }
      return `[=](${params.join(', ')}) {\n${indentSourceLines(emitStatements(expression.body, context)).join('\n')}\n}`;
    }
    case 'identifier': {
      if (
        expression.presence === 'narrowedPresent' &&
        expression.reference.kind === 'binding' &&
        context.nullableBindingIds.has(expression.reference.binding.id)
      ) {
        context.includes.add('optional');
        return `${emitIdentifierReference(expression.reference, context)}.value()`;
      }
      return emitIdentifierReference(expression.reference, context);
    }
    case 'literal':
      return emitLiteral(expression.value);
    case 'new': {
      if (expression.callee.kind !== 'identifier') {
        emissionError(context, 'qualified constructors require C++ type-path lowering');
      }
      const typeName = emitIdentifierReference(expression.callee.reference, context);
      const args = expression.arguments.map((argument) => emitExpression(argument, context));
      return `${typeName}(${args.join(', ')})`;
    }
    case 'object': {
      const members = expression.members
        .filter((member): member is typeof member & { kind: 'property' } => member.kind === 'property')
        .map((member) => `.${safeCppName(member.name)} = ${emitExpression(member.value, context)}`);
      return `{${members.join(', ')}}`;
    }
    case 'property': {
      if (expression.member) {
        const binding = getCompilerCppAmbientMemberBinding(expression.member);
        if (binding && binding.kind === 'sizeMethod') {
          const receiver = emitExpression(expression.object, context);
          return `static_cast<double>(${receiver}${memberOp(expression.object)}${binding.targetName}())`;
        }
        if (binding && binding.kind === 'property') {
          return `${emitExpression(expression.object, context)}${memberOp(expression.object)}${binding.targetName}`;
        }
      }
      if (expression.object.kind === 'identifier' && expression.object.reference.kind === 'ambient') {
        const member = getCompilerRuntimeExternalMemberTargetCpp(expression.object.reference.name, expression.name);
        if (member) return member;
      }
      const enumeration = getIrExpressionEnumDeclaration(expression.object, context);
      if (enumeration) {
        return `${getBindingTargetName(enumeration.binding, context)}::${safeCppTypeName(expression.name)}`;
      }
      return `${emitExpression(expression.object, context)}${memberOp(expression.object)}${safeCppName(expression.name)}`;
    }
    case 'regexp':
      emissionError(context, 'regular expressions require a downstream standard-library mapping');
    case 'spread':
      emissionError(context, 'spreading an unbounded collection requires a fold or a variadic target');
    case 'template': {
      context.includes.add('string');
      const parts = expression.parts.map((part) =>
        typeof part === 'string'
          ? `std::string(${JSON.stringify(part)})`
          : `std::to_string(${emitExpression(part, context)})`,
      );
      return parts.length === 0 ? 'std::string()' : parts.join(' + ');
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
    case 'tupleSpread':
    case 'tupleRest':
    case 'tupleSuffix':
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
      if (statement.keyPlan.evaluation === 'preserve') {
        const objectName = generateUniqueName('for_in_object', context);
        context.includes.add('string');
        context.includes.add('vector');
        const variableName = getBindingTargetName(statement.variable.binding, context);
        return [
          '{',
          `  auto ${objectName} = ${emitExpression(statement.object, context)};`,
          `  for (const std::string& ${variableName} : std::vector<std::string>{${statement.keyPlan.keys.map((key) => JSON.stringify(key)).join(', ')}}) {`,
          ...indentSourceLines(emitStatements([statement.body], context), 2),
          '  }',
          '}',
        ];
      }
      context.includes.add('string');
      context.includes.add('vector');
      const variableName = getBindingTargetName(statement.variable.binding, context);
      return [
        `for (const std::string& ${variableName} : std::vector<std::string>{${statement.keyPlan.keys.map((key) => JSON.stringify(key)).join(', ')}}) {`,
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
      const varType = statement.variable.type ? emitType(statement.variable.type, context) : 'auto';
      return [
        `for (${varType} ${variableName} : ${iterable}) {`,
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
    case 'return':
      return [`return${statement.expression ? ` ${emitExpression(statement.expression, context)}` : ''};`];
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
    case 'throw': {
      context.includes.add('stdexcept');
      return [`throw std::runtime_error(${emitExpression(statement.expression, context)});`];
    }
    case 'try': {
      const lines = ['try {', ...indentSourceLines(emitStatementBody(statement.tryBody, context)), '}'];
      if (statement.catchClause) {
        context.includes.add('stdexcept');
        const catchVar = statement.catchClause.binding
          ? `const std::exception& ${safeCppName(statement.catchClause.binding.name)}`
          : '...';
        lines.push(
          `catch (${catchVar}) {`,
          ...indentSourceLines(emitStatementBody(statement.catchClause.body, context)),
          '}',
        );
      }
      if (statement.finallyBody) {
        emissionError(context, 'finally blocks require C++ RAII scope-guard lowering');
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

function emitType(type: Readonly<IrType>, context: EmitContext): string {
  switch (type.kind) {
    case 'array':
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
      return typeof type.value === 'boolean' ? 'bool' : typeof type.value === 'number' ? 'double' : 'std::string';
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
        type: emitType(property.type, context),
      }));
      const key = emittedProperties.map((property) => `${property.type} ${property.name}`).join('; ');
      const existing = context.anonymousStructs.get(key);
      if (existing) return existing.name;
      const structName = generateAnonymousStructName(type.properties, context);
      context.anonymousStructs.set(key, { name: structName, properties: emittedProperties });
      return structName;
    }
    case 'primitive':
      if (type.name === 'string') {
        context.includes.add('string');
        return 'std::string';
      }
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
      context.includes.add('variant');
      const variants = concrete.map((item) => emitType(item, context));
      return `std::variant<${variants.join(', ')}>`;
    }
    case 'unknown':
      if (type.source === 'this' && context.currentClass) {
        return getBindingTargetName(context.currentClass.binding, context);
      }
      return 'auto';
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
    context.includes.add('vector');
    return `std::vector<${type}> ${name}`;
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

function emitTypeParameters(parameters: readonly IrTypeParameter[], _context: EmitContext): string {
  if (parameters.length === 0) return '';
  return `<${parameters.map((parameter) => `typename ${parameter.binding.name}`).join(', ')}>`;
}

function emitIdentifierReference(
  reference: Readonly<IrExpression & { kind: 'identifier' }>['reference'],
  context: EmitContext,
): string {
  if (reference.kind === 'ambient') {
    const target = getCompilerRuntimeExternalSymbolTargetCpp(reference.name, 'value');
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
  return context.targetNames.get(reference.binding.id) ?? safeCppName(reference.binding.name);
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

function emitLiteral(value: boolean | null | number | string): string {
  if (value === null) return 'nullptr';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return 'std::numeric_limits<double>::quiet_NaN()';
    if (!Number.isFinite(value))
      return value > 0 ? 'std::numeric_limits<double>::infinity()' : '-std::numeric_limits<double>::infinity()';
    const text = String(value);
    return /[.eE]/u.test(text) ? text : `${text}.0`;
  }
  return JSON.stringify(value);
}

function emitStringConcatenation(expression: Readonly<IrExpression>, context: EmitContext): string {
  context.includes.add('string');
  const parts = collectStringParts(expression, context);
  return parts.join(' + ');
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
    const target = getCompilerRuntimeExternalSymbolTargetCpp(type.reference.name, 'type');
    if (target) return target;
    return type.reference.name;
  }
  return context.targetNames.get(type.reference.binding.id) ?? pascalCase(type.reference.binding.name);
}

function getBindingTargetName(binding: Readonly<{ id: string; name: string }>, context: EmitContext): string {
  return context.targetNames.get(binding.id) ?? safeCppName(binding.name);
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

function assertRuntimeExternalSymbolBindingsCpp(module: Readonly<IrModule>): void {
  const completeness = analyzeCompilerRuntimeExternalSymbolCompleteness(
    collectIrModulesRuntimeExternalSymbolIdentities([module]),
    createCompilerRuntimeExternalSymbolBindingPlanCpp(),
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
