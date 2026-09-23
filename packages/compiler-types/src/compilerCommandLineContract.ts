// Pointing the compiler at a directory, as data rather than as process state.
//
// The filesystem and the output stream arrive as capabilities so that the decision layer — which
// modules to compile, what to report, what to exit with — can be exercised without a disk.
import type { CompilerPackageCompilationRefusalCode } from './compilerPackageCompilationContract.js';

export interface CompilerCommandLineRequest {
  readonly argv: readonly string[];
}

export interface CompilerCommandLineSource {
  readonly contents: string;
  /** How the module is named in a report; the source path relative to the directory compiled. */
  readonly moduleName: string;
  readonly sourcePath: string;
}

export interface CompilerCommandLineCapabilities {
  readonly listSourceFiles: (directory: string) => readonly CompilerCommandLineSource[];
  readonly write: (text: string) => void;
  readonly writeError: (text: string) => void;
  readonly writeOutputFile: (directory: string, relativePath: string, contents: string) => void;
}

export interface CompilerCommandLineRefusal {
  readonly code: CompilerPackageCompilationRefusalCode;
  readonly column?: number | undefined;
  readonly line?: number | undefined;
  readonly module: string;
  readonly reason: string;
  readonly stage: 'dependency' | 'emission' | 'initialization' | 'lowering';
}

export interface CompilerCommandLineResult {
  readonly emitted: number;
  readonly exitCode: number;
  readonly refusals: readonly CompilerCommandLineRefusal[];
}

// Checking a workspace, as data rather than as a build.
//
// Check mode asks the same deterministic compilation the emit path runs and does not write what it
// produced: the capability record it receives has no output-directory member, so "writes nothing" is a
// property of the shape rather than a promise in the text. The judgments a check makes -- which packages
// are in scope, which findings gate, which are only the runtime's to supply, what an earlier run already
// knew -- are all supplied explicitly, because none of them can be read off the refusals themselves.
export interface CompilerCommandLineCheckRequest {
  readonly argv: readonly string[];
}

export type CompilerCommandLineCheckFormat = 'json' | 'text';

// One package a check run may compile. `environments` is what the package declares about itself; an
// empty list is what "unmarked" means, and it is the default scope.
export interface CompilerCommandLineWorkspacePackage {
  readonly environments: readonly string[];
  readonly name: string;
  readonly root: string;
}

// One thing a module could not do, with the identity a baseline compares by. The identity is stable
// across runs and across package moves: the module's source path, the rule or reason the compiler groups
// by, and the source position when it has one.
export interface CompilerCommandLineCheckFinding {
  readonly code: CompilerPackageCompilationRefusalCode;
  readonly id: string;
  readonly module: string;
  readonly reason: string;
  readonly stage: CompilerCommandLineRefusal['stage'];
}

// Finding identity is line-and-column sensitive on purpose: a refusal that moves to a different source
// position is a different thing to look at, and a baseline that swallowed the move would hide it.
export interface CompilerCommandLineCheckCapabilities {
  /** The packages the workspace holds, in a deterministic order. Discovery is here; selection is the CLI's. */
  readonly listWorkspacePackages: (workspaceDirectory: string) => readonly CompilerCommandLineWorkspacePackage[];
  /** Sources of one package directory, the same shape the emit path receives. */
  readonly listSourceFiles: (directory: string) => readonly CompilerCommandLineSource[];
  /** The baseline text, or undefined when the file is absent. Never called to write. */
  readonly readBaseline: (path: string) => string | undefined;
  /** Whether a finding is the runtime\'s or the host\'s to supply rather than the compiler\'s to fix. */
  readonly isRuntimeOnlyFinding?: ((finding: Readonly<CompilerCommandLineCheckFinding>) => boolean) | undefined;
  readonly write: (text: string) => void;
  readonly writeError: (text: string) => void;
  readonly writeReportFile: (path: string, contents: string) => void;
}

export interface CompilerCommandLineCheckResult {
  /** Findings an earlier run already carried. */
  readonly baselined: number;
  readonly exitCode: number;
  readonly findings: readonly CompilerCommandLineCheckFinding[];
  /** Findings no baseline entry covered; empty without --baseline. */
  readonly introduced: readonly CompilerCommandLineCheckFinding[];
  /** The packages the run selected, in the order it reported them. */
  readonly packages: readonly string[];
  /** Baseline entries the run no longer finds; empty without --baseline. */
  readonly resolved: readonly string[];
  /** Findings the capability marked as the runtime\'s to supply; these do not gate. */
  readonly runtimeOnly: number;
}
