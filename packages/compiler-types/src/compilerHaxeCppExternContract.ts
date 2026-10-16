import type { EmittedFile } from './compilerBackendContract.js';
import type { CompilerHaxeDualBindingPlan } from './compilerHaxeDualBindingContract.js';
import type { IrModule } from './compilerModuleIntermediateRepresentation.js';

export type CompilerHaxeCppExternCarrierKind =
  | 'boolean'
  | 'float'
  | 'optional-float'
  | 'reference-record'
  | 'string'
  | 'value-record'
  | 'void';

export interface CompilerHaxeCppExternCarrier {
  readonly cppType: string;
  readonly haxeType: string;
  readonly kind: CompilerHaxeCppExternCarrierKind;
  readonly transport: 'adapter' | 'direct';
}

export type CompilerHaxeCppExternRefusalCode =
  | 'cpp-binding-unavailable'
  | 'declaration-missing'
  | 'invalid-locator'
  | 'invalid-plan'
  | 'output-path-collision'
  | 'unsupported-carrier'
  | 'unsupported-declaration';

export interface CompilerHaxeCppExternRefusal {
  readonly code: CompilerHaxeCppExternRefusalCode;
  readonly detailCode?: string | undefined;
  readonly key: string;
  readonly message: string;
  readonly phase: 'emission' | 'planning';
}

export interface CompilerHaxeCppExternFunctionParameterPlan {
  readonly carrier: CompilerHaxeCppExternCarrier;
  readonly haxeName: string;
  readonly optional: boolean;
  readonly position: number;
}

export interface CompilerHaxeCppExternFunctionPlan {
  readonly adapter?: Readonly<{
    readonly headerPath: string;
    readonly nativeName: string;
    readonly semantics: readonly ('copy-optional-presence' | 'copy-string-utf8')[];
  }>;
  readonly haxeName: string;
  readonly haxeOwner: string;
  readonly include: string;
  readonly key: string;
  readonly kind: 'function';
  readonly parameters: readonly CompilerHaxeCppExternFunctionParameterPlan[];
  readonly result: CompilerHaxeCppExternCarrier;
  readonly targetNativeName: string;
}

export interface CompilerHaxeCppExternTypePlan {
  readonly haxeName: string;
  readonly haxePackage: string;
  readonly include: string;
  readonly key: string;
  readonly kind: 'type';
  readonly nativeName: string;
  readonly ownership: 'reference' | 'value';
}

export type CompilerHaxeCppExternDeclarationPlan = CompilerHaxeCppExternFunctionPlan | CompilerHaxeCppExternTypePlan;

export interface CompilerHaxeCppExternPlan {
  readonly declarations: readonly CompilerHaxeCppExternDeclarationPlan[];
  readonly refusals: readonly CompilerHaxeCppExternRefusal[];
  readonly schema: 'flight-haxe-cpp-extern-plan/1';
}

export interface CompilerHaxeCppExternPlanInput {
  readonly bindings: CompilerHaxeDualBindingPlan;
  readonly modules: readonly Readonly<IrModule>[];
}

export interface CompilerHaxeCppExternEmission {
  readonly files: readonly EmittedFile[];
  readonly refusals: readonly CompilerHaxeCppExternRefusal[];
  readonly schema: 'flight-haxe-cpp-extern-emission/1';
}
