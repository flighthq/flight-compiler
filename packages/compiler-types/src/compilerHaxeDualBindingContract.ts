import type { CppCompilerBackendOptions, HaxeCompilerBackendOptions } from './compilerBackendContract.js';
import type { CompilerModuleFacadePlan } from './compilerModuleFacadeContract.js';
import type { IrModule } from './compilerModuleIntermediateRepresentation.js';
import type { CompilerModuleIdentity } from './compilerSourceIdentity.js';

export interface CompilerHaxeDualBindingSourceExportIdentity {
  readonly declarationIdentity: string;
  readonly exportRoute: string;
  readonly packageName: string;
  readonly source: string;
  readonly space: 'type' | 'value';
}

export type CompilerHaxeDualBindingRefusalCode =
  | 'cpp-declaration-missing'
  | 'cpp-input-missing'
  | 'cpp-module-refused'
  | 'cpp-renamed-value-reexport-unsupported'
  | 'js-module-refused';

export interface CompilerHaxeDualBindingRefusal {
  readonly code: CompilerHaxeDualBindingRefusalCode;
  readonly detailCode?: string | undefined;
  readonly message: string;
  readonly subject: string;
}

export type CompilerHaxeDualBindingBackend<Locator> =
  | Readonly<{ availability: 'available'; locator: Readonly<Locator> }>
  | Readonly<{ availability: 'refused'; refusal: Readonly<CompilerHaxeDualBindingRefusal> }>;

export type CompilerCppPublicBindingCarrier = 'class' | 'enum' | 'function' | 'interface' | 'type-alias' | 'value';

export interface CompilerCppPublicBindingLocator {
  readonly carrier: CompilerCppPublicBindingCarrier;
  readonly include: string;
  readonly namespace: string;
  readonly spelling: string;
}

export interface CompilerCppPublicBinding {
  readonly binding: CompilerHaxeDualBindingBackend<CompilerCppPublicBindingLocator>;
  /** Identity of the target-neutral facade slot used to join target plans without importing an emitter. */
  readonly facadeIdentity: string;
  readonly identity: CompilerHaxeDualBindingSourceExportIdentity;
  readonly key: string;
}

export interface CompilerCppPublicBindingPlan {
  readonly bindings: readonly CompilerCppPublicBinding[];
  readonly schema: 'flight-cpp-public-binding-plan/1';
}

export interface CompilerPublicBindingModuleRefusal {
  readonly code: string;
  readonly message: string;
  readonly module: CompilerModuleIdentity;
}

export interface CompilerCppPublicBindingPlanInput {
  readonly facade: CompilerModuleFacadePlan;
  readonly modules: readonly Readonly<IrModule>[];
  readonly options?: Readonly<CppCompilerBackendOptions> | undefined;
  readonly refusals?: readonly Readonly<CompilerPublicBindingModuleRefusal>[] | undefined;
}

export interface CompilerHaxePublicBindingIdentity {
  readonly kind: 'function' | 'type' | 'type-value' | 'value';
  readonly name: string;
  readonly owner: string;
  readonly qualifiedName: string;
  readonly signature?: string | undefined;
  readonly typeIdentity: string;
}

export interface CompilerHaxeJavaScriptBindingLocator {
  readonly exportedName: string;
  readonly specifier: string;
}

export interface CompilerHaxeDualBinding {
  readonly cpp: CompilerHaxeDualBindingBackend<CompilerCppPublicBindingLocator>;
  readonly identity: CompilerHaxeDualBindingSourceExportIdentity;
  readonly javascript: CompilerHaxeDualBindingBackend<CompilerHaxeJavaScriptBindingLocator>;
  readonly key: string;
  readonly publicHaxe: CompilerHaxePublicBindingIdentity;
}

export interface CompilerHaxeDualBindingPlan {
  readonly bindings: readonly CompilerHaxeDualBinding[];
  readonly schema: 'flight-haxe-dual-binding-plan/1';
}

export interface CompilerHaxeDualBindingPlanInput {
  readonly cpp: CompilerCppPublicBindingPlan;
  readonly facade: CompilerModuleFacadePlan;
  readonly javascriptRefusals?: readonly Readonly<CompilerPublicBindingModuleRefusal>[] | undefined;
  readonly modules: readonly Readonly<IrModule>[];
  readonly options?: Readonly<HaxeCompilerBackendOptions> | undefined;
  readonly packageSpecifiers?: Readonly<Record<string, string>> | undefined;
}
