import path from 'node:path';

import {
  createBackendEmissionFailure,
  createCompilerGeneratedFileHeader,
  createIrModuleTargetNameAllocation,
  indentSourceLines,
  isCompilerTargetNameAllocationFailure,
} from '../../compiler-emission/src/index.js';
import {
  createCompilerLoweringPassBindingPattern,
  createCompilerLoweringPassCStyleFor,
  createCompilerLoweringPassExtraArgumentErasure,
  createCompilerLoweringPassInterfaceInheritance,
  createCompilerLoweringPassSwitchFallthrough,
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
  analyzeIrModuleStructuralObjectCompatibility,
  createIrObjectTypeShapeIdentity,
} from '../../compiler-structural/src/index.js';
import type { CompilerBackend, EmittedFile, RustCompilerBackendOptions } from '../../compiler-types/src/index.js';
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
import { createCompilerRuntimeExternalConstructorAbiPlanRust } from './rustRuntimeExternalConstructorAbi.js';
import {
  createCompilerRuntimeExternalSymbolBindingPlanRust,
  getCompilerRuntimeExternalSymbolTargetRust,
} from './rustRuntimeExternalSymbolBinding.js';

interface EmitContext {
  anonymousObjectRecords: Map<string, Readonly<{ name: string; properties: readonly IrObjectTypeProperty[] }>>;
  generatedNames: Set<string>;
  module: Readonly<IrModule>;
  objectRestRecords: Map<string, Readonly<{ name: string; properties: readonly IrObjectTypeProperty[] }>>;
  options: Readonly<RustCompilerBackendOptions>;
  targetNames: ReadonlyMap<string, string>;
}

type OperatorEmissionDecision = Readonly<{ emitted: string }> | Readonly<{ refusal: string }>;

export function createRustCompilerBackend(): CompilerBackend<RustCompilerBackendOptions> {
  return {
    emitModule(module, { options }) {
      return [emitIrModuleRust(module, options)];
    },
    name: 'rust',
  };
}

export function emitIrModuleRust(
  sourceModule: Readonly<IrModule>,
  options: Readonly<RustCompilerBackendOptions> = {},
): EmittedFile {
  const module = lowerIrModuleWithCompilerPasses(sourceModule, [
    createCompilerLoweringPassExtraArgumentErasure(),
    createCompilerLoweringPassBindingPattern(),
    createCompilerLoweringPassVariableHoisting(),
    createCompilerLoweringPassCStyleFor(),
    createCompilerLoweringPassInterfaceInheritance(),
    createCompilerLoweringPassSwitchFallthrough(),
  ]);
  assertStructuralObjectCompatibilityRust(module);
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
  const context: EmitContext = {
    anonymousObjectRecords: new Map(),
    generatedNames: new Set(targetNames.values()),
    module,
    objectRestRecords: new Map(),
    options,
    targetNames,
  };
  if (module.exports.length > 0) {
    emissionError(context, 're-exports and export assignments require Rust module-facade lowering');
  }
  const lines = [createCompilerGeneratedFileHeader(module, '//', options.upstreamCommit), '#![forbid(unsafe_code)]'];
  const imports = emitImports(module.imports, context);
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
  if (declaration.extends || declaration.implements.length > 0) {
    emissionError(context, `class ${declaration.binding.name} inheritance requires Rust ownership lowering`);
  }
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
  if (declaration.fields.some((field) => field.initializer)) {
    emissionError(context, `class ${declaration.binding.name} field initializers require constructor lowering`);
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
  if (declaration.methods.length > 0) {
    lines.push(
      '',
      `impl${emitTypeParameters(declaration.typeParameters, context)} ${getBindingTargetNameRust(declaration.binding, context)}${emitTypeArguments(declaration.typeParameters, context)} {`,
    );
    declaration.methods.forEach((method, index) => {
      if (index > 0) lines.push('');
      if (method.async) emissionError(context, `async method ${method.name} requires Flight task lowering`);
      const parameters = [
        ...(method.static ? [] : ['&mut self']),
        ...method.parameters.map((parameter) => emitParameter(parameter, context)),
      ].join(', ');
      lines.push(
        `  ${method.visibility === 'public' ? 'pub ' : ''}fn ${safeRustValueName(method.name)}${emitTypeParameters(method.typeParameters, context)}(${parameters}) -> ${emitType(method.returns, context)} {`,
        ...indentSourceLines(emitStatements(method.body, context), 2),
        '  }',
      );
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
  if (declaration.members.some((member) => typeof member.value !== 'number' || !Number.isInteger(member.value))) {
    emissionError(context, `enum ${declaration.binding.name} requires integer discriminants for Rust`);
  }
  if (
    declaration.members.some((member) => Number(member.value) < -2_147_483_648 || Number(member.value) > 2_147_483_647)
  ) {
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

function emitExpression(expression: Readonly<IrExpression>, context: EmitContext): string {
  switch (expression.kind) {
    case 'array':
      return `vec![${expression.elements.map((element) => (element ? emitExpression(element, context) : 'Default::default()')).join(', ')}]`;
    case 'assignment': {
      const left = emitExpression(expression.left, context);
      const right = emitExpression(expression.right, context);
      return `${left} ${emitAssignmentOperatorRust(expression.operator, expression.semantics, context)} ${right}`;
    }
    case 'await':
      emissionError(context, 'await requires Flight task lowering');
    case 'binary': {
      const left = emitExpression(expression.left, context);
      const right = emitExpression(expression.right, context);
      return `(${left} ${emitBinaryOperatorRust(expression.operator, expression.semantics, context)} ${right})`;
    }
    case 'call':
      if (expression.semantics.statementValue) return emitStatementValueExpressionRust(expression, context);
      if (expression.optional) return emitOptionalCallExpressionRust(expression, context);
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
      return emitIdentifierReferenceRust(expression.reference, context);
    case 'literal':
      return emitLiteral(expression.value);
    case 'new':
      if (expression.callee.kind !== 'identifier') {
        emissionError(context, 'qualified constructors require Rust type-path lowering');
      }
      assertIrConstructorInvocationAbiRust(expression, context);
      return `${emitConstructorReferenceRust(expression.callee.reference, context)}::new(${expression.arguments.map((argument) => emitExpression(argument, context)).join(', ')})`;
    case 'object':
      return emitObjectExpressionRust(expression, context);
    case 'objectRest':
      return emitObjectRestExpressionRust(expression, context);
    case 'property':
      if (expression.optional) return emitOptionalPropertyExpressionRust(expression, context);
      return `${emitExpression(expression.object, context)}${isAmbientIdentifier(expression.object) ? '::' : '.'}${safeRustValueName(expression.name)}`;
    case 'regexp':
      emissionError(context, 'regular expressions require a downstream standard-library mapping');
    case 'spread':
      emissionError(context, 'spread expressions require collection or structural lowering');
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

function emitFunction(declaration: Readonly<IrFunctionDeclaration>, context: EmitContext): string[] {
  if (declaration.async)
    emissionError(context, `async function ${declaration.binding.name} requires Flight task lowering`);
  return [
    `${declaration.exported ? 'pub ' : ''}fn ${getBindingTargetNameRust(declaration.binding, context)}${emitTypeParameters(declaration.typeParameters, context)}(${declaration.parameters.map((parameter) => emitParameter(parameter, context)).join(', ')}) -> ${emitType(declaration.returns, context)} {`,
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

function emitInterface(declaration: Readonly<IrInterfaceDeclaration>, context: EmitContext): string[] {
  if (declaration.extends.length > 0)
    emissionError(context, `interface ${declaration.binding.name} inheritance requires record flattening`);
  return emitRecord(
    getBindingTargetNameRust(declaration.binding, context),
    declaration.properties,
    declaration.typeParameters,
    declaration.exported,
    context,
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
  if (!defaults && !optionals) return expression.arguments.map((argument) => emitExpression(argument, context));
  const plan = defaults ?? optionals;
  if (!plan) return expression.arguments.map((argument) => emitExpression(argument, context));
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

function emitParameter(parameter: Readonly<IrParameter>, context: EmitContext): string {
  if (parameter.initializer) {
    return `${getBindingTargetNameRust(parameter.binding, context)}: Option<${emitType(parameter.type, context)}>`;
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
    return `${getBindingTargetNameRust(parameter.binding, context)}: ${optionalType}`;
  }
  const name = getBindingTargetNameRust(parameter.binding, context);
  if (parameter.rest) return `${name}: Vec<${emitType(parameter.type, context)}>`;
  return `${name}: ${emitType(parameter.type, context)}`;
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
      emissionError(context, 'try/catch/finally requires Flight rejection lowering');
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

function assertStructuralObjectCompatibilityRust(module: Readonly<IrModule>): void {
  const diagnostics = analyzeIrModuleStructuralObjectCompatibility(module).diagnostics;
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
  '??': undefined,
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
