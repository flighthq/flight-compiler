import type { CompilerCppPublicBindingPlan, CompilerHaxeDualBindingPlan } from './compilerHaxeDualBindingContract.js';
import type { CompilerModuleEvaluationPlan } from './compilerModuleEvaluationContract.js';
import type { CompilerModuleFacadePlan } from './compilerModuleFacadeContract.js';
import type { IrModule } from './compilerModuleIntermediateRepresentation.js';
import type { CompilerModuleResolutionPlan } from './compilerModuleResolutionContract.js';
import type { CompilerRefusalClassification } from './compilerRefusalClassificationContract.js';
import type {
  CompilerRuntimeAbiManifest,
  CompilerRuntimeExternalMemberBinding,
  CompilerRuntimeExternalSymbolBindingPlan,
} from './compilerRuntimeContract.js';
import type { CompilerRustModuleEvaluationExecutionPlan } from './compilerRustModuleEvaluationExecutionContract.js';
import type { CompilerRustPublicBindingPlan } from './compilerRustPublicBindingContract.js';
import type { CompilerModuleIdentity, CompilerSourceIdentity } from './compilerSourceIdentity.js';

export interface EmittedFileIdentity {
  readonly path: string;
}

export interface EmittedFile extends EmittedFileIdentity {
  readonly contents: string;
  /** Target dependency spellings required to compile this file, such as C++ include paths. */
  readonly dependencies?: readonly string[] | undefined;
}

/** One successfully retained module output supplied to package-graph finalization. */
export interface CompilerBackendModuleFile {
  readonly file: EmittedFile;
  readonly module: CompilerModuleIdentity;
}

/** A finalized replacement keyed to one exact retained module output. */
export interface CompilerBackendModuleFileReplacement {
  readonly file: EmittedFile;
  readonly module: CompilerModuleIdentity;
  /** The retained input file path this replacement owns; the replacement file may choose a new path. */
  readonly retainedPath: string;
}

/** A graph-finalized file owned by a package rather than by one arbitrarily chosen module. */
export interface CompilerBackendPackageFile {
  readonly file: EmittedFile;
  readonly owner: Readonly<{
    readonly kind: 'package';
    readonly packageName: string;
  }>;
  /** Every semantic module the backend consulted to derive this package file. */
  readonly provenance: readonly CompilerModuleIdentity[];
}

/** Final package-graph facts available only after module refusal filtering and facade construction. */
export interface CompilerBackendPackageGraphFinalization {
  readonly facade: CompilerModuleFacadePlan;
  /** Authoritative evaluation projection after all emission refusals and collisions have propagated. */
  readonly moduleEvaluation: CompilerModuleEvaluationPlan;
  /** Ordered by module identity, then emitted path. Refused, placeholder, and unselected outputs are absent. */
  readonly moduleFiles: readonly CompilerBackendModuleFile[];
  /**
   * One entry per module this run refused whose output is absent from `moduleFiles`, ordered by module
   * identity, then code, then message. The same refusal shape the public-binding request reports; absent
   * when every refused module retained its output or nothing was refused. A backend needs it to say an
   * absent imported target was refused rather than merely missing from the output.
   */
  readonly refusals?: readonly CompilerBackendPublicBindingRefusal[] | undefined;
  /**
   * Modules this run will ask the backend to leave a refusal placeholder for, ordered by module identity.
   * Present only for a best-effort run whose backend writes placeholders. A backend that plans a source
   * tree must account for these modules as real files -- their paths, module declarations, and import
   * targets -- while never re-emitting them as retained output. Absent means no placeholder will be
   * written, so a strict run's plan stays exactly the retained set.
   */
  readonly placeholderModules?: readonly Readonly<IrModule>[] | undefined;
}

// A backend's finalized target initialization schedule. This is the neutral seam that carries a
// target's own plan (today the Rust module-evaluation execution plan); adding a target extends the
// union rather than naming a target-specific field on the generic backend contracts. The neutral
// compiler report keeps its own `initialization` plan, which this does not replace.
export type CompilerBackendTargetInitializationPlan = CompilerRustModuleEvaluationExecutionPlan;

export interface CompilerBackendPackageGraphFinalizationResult {
  /** When present, this must replace every retained module identity and path exactly once. */
  readonly moduleFileReplacements?: readonly CompilerBackendModuleFileReplacement[] | undefined;
  /**
   * The backend's finalized executable startup schedule, when one exists. The backend publishes it so
   * the public-binding plan can carry the exact order; orchestration passes it back through the
   * public-binding request rather than letting a second planner derive a competing one.
   */
  readonly targetInitialization?: CompilerBackendTargetInitializationPlan | undefined;
  readonly packageFiles: readonly CompilerBackendPackageFile[];
}

export interface BackendEmitContext<Options> {
  readonly moduleResolution?: Readonly<CompilerModuleResolutionPlan> | undefined;
  /**
   * Every module of the compilation a backend may CONSULT while emitting, which is not the same set as the
   * modules it will be asked to WRITE. A backend resolves an imported owner, alias, or target name by looking the
   * declaration up here, so a module this list omits is silently indistinguishable from one that declares
   * nothing: the reference resolves elsewhere and the emitter spells it differently.
   *
   * It is therefore not narrowed by which modules the run emits. Only the `emitModule` call is: orchestration
   * calls it once per module the run emits, and a backend must return no file for a module it was not asked
   * about.
   */
  readonly modules: readonly IrModule[];
  readonly options: Readonly<Options>;
}

/** Whole-graph context prepared only after neutral module evaluation has reached its fixed point. */
export interface CompilerBackendEmissionSessionContext<Options> extends BackendEmitContext<Options> {
  readonly moduleEvaluation: CompilerModuleEvaluationPlan;
}

export type CompilerBackendPublicBindingPlan =
  | CompilerCppPublicBindingPlan
  | CompilerHaxeDualBindingPlan
  | CompilerRustPublicBindingPlan;

export interface CompilerBackendPublicBindingRefusal {
  readonly code: string;
  readonly message: string;
  readonly module: CompilerModuleIdentity;
}

export interface CompilerBackendPublicBindingRequest<Options> extends BackendEmitContext<Options> {
  readonly facade: CompilerModuleFacadePlan;
  /** The backend's finalized executable startup schedule, when the run produced one. */
  readonly targetInitialization?: CompilerBackendTargetInitializationPlan | undefined;
  readonly refusals: readonly CompilerBackendPublicBindingRefusal[];
}

/**
 * What orchestration knows about a refusal when it asks a backend for a replaceable placeholder: the module's
 * own reason and nothing more. The backend supplies the path and the file shape, because both are target
 * decisions and orchestration cannot derive either without naming a target.
 */
export interface CompilerRefusalPlaceholderRequest {
  readonly classification?: CompilerRefusalClassification | undefined;
  /** Where the emitter stopped, when it knew: the first thing a hand edit should look at. */
  readonly column?: number | undefined;
  readonly line?: number | undefined;
  readonly message: string;
  readonly refusedDependencies?: readonly string[] | undefined;
  readonly rule?: string | undefined;
  /**
   * The module's original source text, when the caller has it. A backend may quote the span of the declaration
   * that failed, so the hand edit sees the code it has to replace rather than only a description of it.
   */
  readonly sourceText?: string | undefined;
}

export interface CompilerBackend<Options = Record<string, never>> {
  /**
   * Exact external-symbol identities supplied by the target profile for this run. Semantic lowering uses
   * native type-space entries only as evidence that an ambient name has a target representation; it never
   * derives that fact from a target spelling or a downstream file path.
   */
  readonly createTypeScriptProfileTypeNameEvidence?:
    | ((options: Readonly<Options>) => CompilerRuntimeExternalSymbolBindingPlan)
    | undefined;
  /**
   * Optionally prepares graph-wide analysis once. Orchestration calls the returned session's `emitModule` for
   * each module the run emits, while `emitModule` on this record remains the single-module compatibility entry
   * point. The session's context is the whole compilation -- see `BackendEmitContext.modules` -- so the analysis
   * it builds here is what makes an emitted module resolve a dependency this run does not emit.
   */
  readonly createEmissionSession?:
    | ((context: CompilerBackendEmissionSessionContext<Options>) => CompilerBackendEmissionSession)
    | undefined;
  /** Versioned target-owned public identities reported beside the target-neutral package facade. */
  readonly createPublicBindingPlan?:
    | ((request: Readonly<CompilerBackendPublicBindingRequest<Options>>) => CompilerBackendPublicBindingPlan)
    | undefined;
  /**
   * Optionally writes a replaceable stub for a module refused for its own reasons, so a best-effort run
   * leaves a path a hand edit can land on instead of nothing. Returning `undefined` means this target has no
   * placeholder for that module and the run omits the file. A placeholder never breaks a build on purpose:
   * it is a well-formed header that declares only what it can justify, so a consumer fails later on the
   * declarations that are genuinely absent, not on an artifact the compiler poisoned.
   */
  readonly emitRefusalPlaceholder?:
    | ((
        module: Readonly<IrModule>,
        failure: Readonly<CompilerRefusalPlaceholderRequest>,
        options: Readonly<Options>,
      ) => EmittedFile | undefined)
    | undefined;
  readonly emitModule: (module: Readonly<IrModule>, context: BackendEmitContext<Options>) => readonly EmittedFile[];
  readonly name: string;
  /** Versioned runtime surface required by this backend's emitted code. */
  readonly runtimeAbi?: (() => CompilerRuntimeAbiManifest) | undefined;
}

export interface CompilerBackendEmissionSession {
  readonly emitModule: (module: Readonly<IrModule>) => readonly EmittedFile[];
  /**
   * Writes a refusal placeholder with the same graph-wide analysis as ordinary session emission. Backends that
   * omit this keep using `CompilerBackend.emitRefusalPlaceholder` as the compatibility fallback.
   */
  readonly emitRefusalPlaceholder?:
    | ((module: Readonly<IrModule>, failure: Readonly<CompilerRefusalPlaceholderRequest>) => EmittedFile | undefined)
    | undefined;
  /**
   * Finalizes retained module output and package-owned output once, after refusal filtering and final facade
   * construction. The session retains the complete semantic context from `BackendEmitContext.modules`;
   * `finalization.moduleFiles` instead describes only the selected module outputs that survived, so finalized
   * files never have to infer that state.
   */
  readonly finalizePackageGraph?:
    | ((
        finalization: Readonly<CompilerBackendPackageGraphFinalization>,
      ) => CompilerBackendPackageGraphFinalizationResult)
    | undefined;
}

export interface BackendCompilation {
  readonly backend: string;
  readonly files: readonly EmittedFile[];
}

export type BackendEmissionFailureCode = 'unsupported-ir';

export interface BackendEmissionFailure extends Error, CompilerSourceIdentity {
  readonly backend: string;
  /** Producer-owned attribution; absent only on failures created outside the compiler helpers. */
  readonly classification?: CompilerRefusalClassification | undefined;
  readonly code: BackendEmissionFailureCode;
  /**
   * One-based source column, absent when the backend cannot place the construct it refused. A backend
   * emits whole declarations, so the position is the declaration being emitted when the refusal names
   * syntax inside one, and absent when the refusal is about the module rather than a declaration in it.
   */
  readonly column?: number;
  readonly kind: 'backend-emission';
  readonly line?: number;
  /**
   * The stable identity of the decision this refusal records, when the message is not one.
   *
   * A message that names no instance — `object getters require target-specific accessor lowering` —
   * is already the identity of the decision and needs no second spelling. A message that embeds
   * instance data is not: forty modules refused for forty different missing symbols produce forty
   * messages describing one decision, and only the rule tells a consumer that. So `rule` is present
   * exactly when the message varies by instance, and a consumer groups by `rule ?? message`.
   */
  readonly rule?: string | undefined;
}

/**
 * A finalization failure a caller can branch on. Package-graph finalization is one run-level step, not a
 * per-module emission, so this carries the backend and its own stable code instead of a module identity.
 * A backend wraps only the failures it recognizes; an unexpected defect keeps escaping as itself.
 */
export interface CompilerBackendFinalizationFailure extends Error {
  readonly backend: string;
  /** The backend's own stable failure code, when the wrapped failure had one. */
  readonly code?: string | undefined;
  readonly kind: 'compiler-backend-finalization';
  /** Backend-owned subjects, in the backend's deterministic order. */
  readonly subjects?: readonly string[] | undefined;
}

export type HaxeCompilerEmissionMode = 'extern' | 'transpile';

export interface HaxeCompilerBackendOptions {
  /** Canonical public Haxe identities and target availability consumed by extern selector emission. */
  readonly dualBindingPlan?: Readonly<CompilerHaxeDualBindingPlan> | undefined;
  /** Whether Haxe binds JavaScript exports or transpiles their implementations. Defaults to `transpile`. */
  readonly emissionMode?: HaxeCompilerEmissionMode | undefined;
  readonly rootPackage?: string | undefined;
  /**
   * How a data shape is represented. `anonymous` is the honest structural translation of a
   * structural source type. `structInit` names it as a class instead, which the static targets give
   * real field offsets rather than the hashed lookup an anonymous structure resolves to, at the cost
   * of the structural interchange the source language allows.
   */
  readonly structuralRecords?: 'anonymous' | 'structInit' | undefined;
  readonly runtimeModule?: string | undefined;
  readonly upstreamCommit?: string | undefined;
}

export type CppCompilerRuntimeProfile = 'flight-cpp' | 'standard-library';

export interface CppCompilerExternalBindingConstruction {
  readonly kind: 'constructor' | 'factory';
  readonly targetName: string;
}

export interface CppCompilerExternalFieldBinding {
  readonly sourceField: string;
  readonly targetName: string;
}

export interface CppCompilerExternalObjectConstruction {
  readonly fields: readonly CppCompilerExternalFieldBinding[];
  readonly kind: 'field-assignment';
}

export interface CppCompilerExternalMemberParameterBinding {
  readonly position: number;
  readonly sourceType: string;
}

export type CppCompilerExternalInstancePropertyAccess = 'field' | 'zero-argument-method';

export interface CppCompilerExternalMemberBinding extends CompilerRuntimeExternalMemberBinding {
  /**
   * The number of source arguments this member's target represents. A call passing any other number has no
   * equivalent in the target -- a target with an unrelated overload would silently answer different
   * semantics, and one without would not compile at all -- so the emitter refuses it. Absent means the
   * profile constrains no count, which is the ordinary case for a member whose target is the whole
   * function.
   */
  readonly callArity?: number | undefined;
  /** The one source sentinel represented by an absent `callResultType` carrier. */
  readonly callResultAbsence?: 'null' | 'undefined' | undefined;
  /** Exact ambient source object types for parameters whose erased call-site IR cannot retain them. */
  readonly parameters?: readonly CppCompilerExternalMemberParameterBinding[] | undefined;
  /** How a declared instance property reaches its target value. Field access remains the default. */
  readonly propertyAccess?: CppCompilerExternalInstancePropertyAccess | undefined;
  /** Exact Record conversion capability of this member's external result; requires `callResultType`. */
  readonly recordConversion?: CppCompilerExternalBindingRecordConversion | undefined;
}

export interface CppCompilerExternalBindingNumericPropertyView {
  /** A readonly `String -> optional<double>` member on the represented target value. */
  readonly targetName: string;
}

export interface CppCompilerExternalBindingRecordConversion {
  /** `member` consumes a present result; `carrier-function` consumes and returns the whole nullable carrier. */
  readonly invocation: 'carrier-function' | 'member';
  /** The exact key domain produced by the conversion. */
  readonly keyType: 'string';
  /** The exact value domain produced by the conversion. */
  readonly valueType: 'number';
  /** Ownership of the external member result on which the conversion is invoked. */
  readonly resultOwnership: 'borrowed' | 'owned' | 'shared' | 'value';
  /** Whether the external member result can be null. */
  readonly resultNullability: 'non-null' | 'nullable';
  /** A zero-argument member, or a qualified free function accepting the whole result carrier. */
  readonly targetName: string;
}

export interface CppCompilerExternalBinding {
  /** The one source sentinel represented by an absent `callResultType` carrier. */
  readonly callResultAbsence?: 'null' | 'undefined' | undefined;
  /**
   * Exact target carrier for direct calls and retained callable utility projections. A utility
   * projection that the TypeScript checker resolves to a named ambient type still requires that
   * type's exact type-space binding.
   */
  readonly callResultType?: string | undefined;
  readonly construction?: CppCompilerExternalBindingConstruction | undefined;
  readonly headers: readonly string[];
  /** Static members for value-space bindings; instance members for type-space bindings. */
  readonly members?: readonly CppCompilerExternalMemberBinding[] | undefined;
  /** Explicit target ABI for source named/computed reads whose absence remains observable. */
  readonly numericPropertyView?: CppCompilerExternalBindingNumericPropertyView | undefined;
  readonly nullability: 'non-null' | 'nullable';
  /** Explicitly elects assignment-based construction for an external value object. */
  readonly objectConstruction?: CppCompilerExternalObjectConstruction | undefined;
  readonly ownership: 'borrowed' | 'owned' | 'shared' | 'value';
  readonly sourceName: string;
  readonly space: 'type' | 'value';
  readonly targetName: string;
  readonly weakKeyPolicyTargetName?: string | undefined;
}

export interface CppCompilerExternalBindingManifest {
  readonly bindings: readonly CppCompilerExternalBinding[];
  readonly schema: 'flight-cpp-external-bindings/1';
}

export interface CppCompilerPackageTarget {
  readonly includePrefix: string;
  readonly namespace: string;
}

export interface CppCompilerCAbiOutput {
  readonly adapterSourcePath: string;
  readonly headerPath: string;
  readonly packageName: string;
}

export interface CppCompilerBackendOptions {
  /** Explicitly elects one package-owned C ABI header and adapter translation unit. */
  readonly cAbi?: Readonly<CppCompilerCAbiOutput> | undefined;
  /** Target-native bindings supplied by the embedding package rather than the compiler runtime. */
  readonly externalBindings?: Readonly<CppCompilerExternalBindingManifest> | undefined;
  /** Installed include and public namespace identity for each source package. */
  readonly packageTargets?: Readonly<Record<string, Readonly<CppCompilerPackageTarget>>> | undefined;
  /**
   * Runtime representation elected by the backend. `standard-library` preserves the provisional
   * container mapping for generic consumers; `flight-cpp` elects the semantic runtime contract.
   */
  readonly runtimeProfile?: CppCompilerRuntimeProfile | undefined;
  readonly runtimeHeader?: string | undefined;
  readonly upstreamCommit?: string | undefined;
}

export interface RustCompilerBackendOptions {
  /** Target-native host bindings supplied by the embedding Rust workspace. */
  readonly hostBindings?: Readonly<RustCompilerExternalBindingManifest> | undefined;
  readonly opaqueHostType?: string | undefined;
  /** Crate the runtime contract's Rust types are imported from. */
  readonly runtimeCrate?: string | undefined;
  readonly upstreamCommit?: string | undefined;
}

export interface RustCompilerExternalBinding {
  readonly members?: readonly Readonly<{ sourceMember: string; targetName: string }>[] | undefined;
  readonly nullability: 'non-null' | 'nullable';
  readonly ownership: 'borrowed' | 'owned' | 'shared' | 'value';
  readonly sourceName: string;
  readonly space: 'type' | 'value';
  readonly targetName: string;
}

export interface RustCompilerExternalBindingManifest {
  readonly bindings: readonly RustCompilerExternalBinding[];
  readonly schema: 'flight-rust-external-bindings/1';
}
