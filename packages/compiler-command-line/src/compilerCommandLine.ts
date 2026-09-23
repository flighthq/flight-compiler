import { createCppCompilerBackend } from '../../compiler-backend-cpp/src/index.js';
import { createHaxeCompilerBackend } from '../../compiler-backend-hx/src/index.js';
import { createRustCompilerBackend } from '../../compiler-backend-rs/src/index.js';
import { compareTextCodeUnits } from '../../compiler-canonical-form/src/index.js';
import {
  createFlightPackageEligibilityPlan,
  isFlightPackageEligibilityFailure,
} from '../../compiler-inventory/src/index.js';
import { compileTypeScriptPackageGraph, parseTypeScriptSource } from '../../compiler-orchestration/src/index.js';
import type {
  CompilerCommandLineCapabilities,
  FlightPackageEnvironment,
  CompilerCommandLineCheckCapabilities,
  CompilerCommandLineCheckFinding,
  CompilerCommandLineCheckFormat,
  CompilerCommandLineCheckRequest,
  CompilerCommandLineCheckResult,
  CompilerCommandLineRefusal,
  CompilerCommandLineRequest,
  CompilerCommandLineResult,
  CompilerCommandLineWorkspacePackage,
  HaxeCompilerEmissionMode,
} from '../../compiler-types/src/index.js';

// Pointing the compiler at a directory.
//
// All modules enter one graph compilation so sibling identities and graph-wide backend analysis are
// available. Each module still has its own outcome: pointed at an unfamiliar codebase, what one
// wants is the complete refusal report rather than a run that stops at the first unsupported form.
//
// The filesystem arrives as a capability record so the decision layer stays testable and so this
// stays the only place in the package that touches it.
export function compileCompilerCommandLineRequest(
  request: Readonly<CompilerCommandLineRequest>,
  capabilities: Readonly<CompilerCommandLineCapabilities>,
): CompilerCommandLineResult {
  const parsed = parseCompilerCommandLineRequest(request);
  if ('failure' in parsed) {
    capabilities.writeError(`${parsed.failure}\n\n${getCompilerCommandLineUsage()}\n`);
    return { emitted: 0, exitCode: 2, refusals: [] };
  }
  const backend =
    parsed.target === 'haxe'
      ? createHaxeCompilerBackend()
      : parsed.target === 'cpp'
        ? createCppCompilerBackend()
        : createRustCompilerBackend();
  const backendOptions: Record<string, unknown> =
    parsed.target === 'haxe'
      ? {
          emissionMode: parsed.emissionMode,
          ...(parsed.rootPackage === undefined ? {} : { rootPackage: parsed.rootPackage }),
        }
      : parsed.target === 'cpp'
        ? {
            runtimeProfile: parsed.runtimeProfile,
            ...(parsed.runtimeHeader === undefined ? {} : { runtimeHeader: parsed.runtimeHeader }),
          }
        : {};
  const sources = capabilities.listSourceFiles(parsed.sourceDirectory);
  if (sources.length === 0) {
    capabilities.writeError(`No TypeScript modules under ${parsed.sourceDirectory}\n`);
    return { emitted: 0, exitCode: 2, refusals: [] };
  }
  const result = compileTypeScriptPackageGraph({
    backend,
    backendOptions,
    graph: {
      entries: [],
      moduleDependencies: [],
      packages: [{ dependencies: [], name: parsed.packageName, root: parsed.sourceDirectory }],
      schema: 'flight-compiler-package-graph/1',
    },
    sources: sources.map((source) => ({
      packageName: parsed.packageName,
      packageRoot: parsed.sourceDirectory,
      sourceFile: parseTypeScriptSource(source.sourcePath, source.contents),
      upstreamDirectory: parsed.sourceDirectory,
    })),
  });
  for (const file of result.compilation.files) {
    capabilities.writeOutputFile(parsed.outputDirectory, file.path, file.contents);
  }
  const emitted = result.report.modules.filter((module) => module.status === 'emitted').length;
  const refusals = result.report.modules.flatMap((module): CompilerCommandLineRefusal[] => {
    const refusal = module.refusals[0];
    if (!refusal) return [];
    return [
      {
        code: refusal.code,
        ...(refusal.column === undefined ? {} : { column: refusal.column }),
        ...(refusal.line === undefined ? {} : { line: refusal.line }),
        module: module.module.source,
        reason: refusal.message,
        stage: refusal.stage,
      },
    ];
  });
  capabilities.write(createCompilerCommandLineReport(emitted, refusals));
  return { emitted, exitCode: refusals.length > 0 && !parsed.reportOnly ? 1 : 0, refusals };
}

// What a check found, as text. The summary line always prints; the findings print grouped by reason, the
// way the emit report does, because one rule blocking forty modules is one thing to decide about.
export function createCompilerCommandLineCheckReport(
  result: Readonly<CompilerCommandLineCheckResult>,
  format: CompilerCommandLineCheckFormat = 'text',
): string {
  if (format === 'json') return `${JSON.stringify(createCompilerCommandLineCheckJson(result), undefined, 2)}\n`;
  const lines = [createCompilerCommandLineCheckSummaryLine(result)];
  const grouped = new Map<string, string[]>();
  for (const finding of result.findings)
    grouped.set(finding.reason, [...(grouped.get(finding.reason) ?? []), finding.module]);
  const ordered = [...grouped.entries()].sort(
    (left, right) => right[1].length - left[1].length || compareTextCodeUnits(left[0], right[0]),
  );
  for (const [reason, modules] of ordered) {
    lines.push('', `  ${String(modules.length)}x ${reason}`);
    for (const module of modules.slice(0, refusalModuleSampleSize)) lines.push(`       ${module}`);
    if (modules.length > refusalModuleSampleSize) {
      lines.push(`       … and ${String(modules.length - refusalModuleSampleSize)} more`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function createCompilerCommandLineCheckSummaryLine(result: Readonly<CompilerCommandLineCheckResult>): string {
  return (
    `${String(result.packages.length)} package(s) checked, ${String(result.findings.length)} finding(s): ` +
    `${String(result.baselined)} baselined, ${String(result.introduced.length - result.runtimeOnly)} gating, ` +
    `${String(result.runtimeOnly)} runtime-only, ${String(result.resolved.length)} resolved.`
  );
}

export function createCompilerCommandLineReport(
  emitted: number,
  refusals: readonly Readonly<{ module: string; reason: string }>[],
): string {
  const lines = [`${String(emitted)} module(s) emitted, ${String(refusals.length)} refused.`];
  const grouped = new Map<string, string[]>();
  for (const refusal of refusals) {
    grouped.set(refusal.reason, [...(grouped.get(refusal.reason) ?? []), refusal.module]);
  }
  const ordered = [...grouped.entries()].sort(
    (left, right) => right[1].length - left[1].length || (left[0] < right[0] ? -1 : 1),
  );
  for (const [reason, modules] of ordered) {
    lines.push('', `  ${String(modules.length)}x ${reason}`);
    for (const module of modules.slice(0, refusalModuleSampleSize)) lines.push(`       ${module}`);
    if (modules.length > refusalModuleSampleSize) {
      lines.push(`       … and ${String(modules.length - refusalModuleSampleSize)} more`);
    }
  }
  return `${lines.join('\n')}\n`;
}

export function getCompilerCommandLineCheckUsage(): string {
  return commandLineCheckUsage;
}
export function getCompilerCommandLineUsage(): string {
  return commandLineUsage;
}

export function validateCompilerCommandLineCheckRequest(
  request: Readonly<CompilerCommandLineCheckRequest>,
  capabilities: Readonly<CompilerCommandLineCheckCapabilities>,
): CompilerCommandLineCheckResult {
  const parsed = parseCompilerCommandLineCheckRequest(request);
  if ('failure' in parsed) {
    capabilities.writeError(`${parsed.failure}\n\n${getCompilerCommandLineCheckUsage()}\n`);
    return createCompilerCommandLineCheckResult(capabilities, { packages: [], findings: [], resolved: [] }, 2);
  }
  const selected = selectCompilerCommandLinePackages(
    capabilities.listWorkspacePackages(parsed.workspaceDirectory),
    parsed,
  );
  if ('failure' in selected) {
    capabilities.writeError(`${selected.failure}\n`);
    return createCompilerCommandLineCheckResult(capabilities, { packages: [], findings: [], resolved: [] }, 2);
  }
  if (selected.length === 0) {
    capabilities.writeError(
      parsed.environmentNames.length === 0
        ? `No packages under ${parsed.workspaceDirectory}\n`
        : `No package under ${parsed.workspaceDirectory} declares ${parsed.environmentNames.join(', ')}\n`,
    );
    return createCompilerCommandLineCheckResult(capabilities, { packages: [], findings: [], resolved: [] }, 2);
  }
  const backend =
    parsed.target === 'haxe'
      ? createHaxeCompilerBackend()
      : parsed.target === 'cpp'
        ? createCppCompilerBackend()
        : createRustCompilerBackend();
  const backendOptions: Record<string, unknown> =
    parsed.target === 'cpp'
      ? {
          runtimeProfile: parsed.runtimeProfile,
          ...(parsed.runtimeHeader === undefined ? {} : { runtimeHeader: parsed.runtimeHeader }),
        }
      : {};
  const findings: CompilerCommandLineCheckFinding[] = [];
  const packages: string[] = [];
  for (const entry of selected) {
    const sources = capabilities.listSourceFiles(entry.root);
    if (sources.length === 0) {
      // A package with nothing to compile is not a package that passed: the check was pointed at
      // something that is not a workspace, which is an invocation failure rather than a clean run.
      capabilities.writeError(`No TypeScript modules under ${entry.root}\n`);
      return createCompilerCommandLineCheckResult(capabilities, { packages: [], findings: [], resolved: [] }, 2);
    }
    packages.push(entry.name);
    const result = compileTypeScriptPackageGraph({
      backend,
      backendOptions,
      graph: {
        entries: [],
        moduleDependencies: [],
        packages: [{ dependencies: [], name: entry.name, root: entry.root }],
        schema: 'flight-compiler-package-graph/1',
      },
      sources: sources.map((source) => ({
        packageName: entry.name,
        packageRoot: entry.root,
        sourceFile: parseTypeScriptSource(source.sourcePath, source.contents),
        upstreamDirectory: entry.root,
      })),
    });
    for (const module of result.report.modules) {
      for (const refusal of module.refusals) {
        const moduleName = module.module.source;
        const identity = refusal.rule ?? refusal.message;
        const position = refusal.line === undefined ? '' : `:${String(refusal.line)}:${String(refusal.column ?? 0)}`;
        findings.push({
          code: refusal.code,
          id: `${moduleName}::${identity}${position}`,
          module: moduleName,
          reason: refusal.message,
          stage: refusal.stage,
        });
      }
    }
  }
  findings.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  const baseline = parsed.baselinePath === undefined ? undefined : capabilities.readBaseline(parsed.baselinePath);
  const known = baseline === undefined ? undefined : parseCompilerCommandLineBaseline(baseline);
  const introduced = known === undefined ? findings : findings.filter((finding) => !known.has(finding.id));
  const resolved =
    known === undefined
      ? []
      : [...known].filter((id) => !findings.some((finding) => finding.id === id)).sort(compareTextCodeUnits);
  const result = createCompilerCommandLineCheckResult(
    capabilities,
    { packages, findings, introduced, resolved },
    undefined,
  );
  const report = createCompilerCommandLineCheckReport(result, parsed.format);
  if (parsed.reportPath === undefined) {
    capabilities.write(report);
  } else {
    // The file carries the whole report; the stream carries the result, because a run that writes a file
    // still has to say in one line what it decided.
    capabilities.writeReportFile(parsed.reportPath, report);
    capabilities.write(`${createCompilerCommandLineCheckSummaryLine(result)}\n`);
  }
  return result;
}

function createCompilerCommandLineCheckResult(
  capabilities: Readonly<CompilerCommandLineCheckCapabilities>,
  parts: Readonly<{
    packages: readonly string[];
    findings: readonly CompilerCommandLineCheckFinding[];
    introduced?: readonly CompilerCommandLineCheckFinding[] | undefined;
    resolved: readonly string[];
  }>,
  forcedExitCode: number | undefined,
): CompilerCommandLineCheckResult {
  const introduced = parts.introduced ?? parts.findings;
  const runtimeOnly = introduced.filter((finding) => capabilities.isRuntimeOnlyFinding?.(finding) === true);
  const gated = introduced.filter((finding) => capabilities.isRuntimeOnlyFinding?.(finding) !== true);
  const result: CompilerCommandLineCheckResult = {
    baselined: parts.findings.length - introduced.length,
    exitCode: forcedExitCode ?? (gated.length > 0 ? 1 : 0),
    findings: parts.findings,
    introduced,
    packages: parts.packages,
    resolved: parts.resolved,
    runtimeOnly: runtimeOnly.length,
  };
  return result;
}

// What the compiler could not do, grouped by reason rather than listed by module. One rule blocking
// forty modules is one thing to decide about; forty lines are forty things to read.

const commandLineUsage = `Usage: flight-compile <source-directory> --target <cpp|haxe|rust> --out <directory>

  --package <name>        Package name the modules belong to (default: @local/source)
  --emission-mode <mode>  Haxe emission: extern or transpile (default: transpile)
  --root-package <name>   Root package for Haxe output (default: the target's own)
  --runtime-profile <id>  C++ runtime profile: flight-cpp or standard-library (default: flight-cpp)
  --runtime-header <path> Override the flight-cpp runtime include spelling
  --report                Report refusals without failing the run`;

interface ParsedCompilerCommandLineRequest {
  readonly emissionMode: HaxeCompilerEmissionMode;
  readonly outputDirectory: string;
  readonly packageName: string;
  readonly reportOnly: boolean;
  readonly rootPackage?: string | undefined;
  readonly runtimeHeader?: string | undefined;
  readonly runtimeProfile: 'flight-cpp' | 'standard-library';
  readonly sourceDirectory: string;
  readonly target: 'cpp' | 'haxe' | 'rust';
}

function parseCompilerCommandLineRequest(
  request: Readonly<CompilerCommandLineRequest>,
): ParsedCompilerCommandLineRequest | Readonly<{ failure: string }> {
  const positional: string[] = [];
  const named = new Map<string, string>();
  let reportOnly = false;
  for (let index = 0; index < request.argv.length; index += 1) {
    const argument = request.argv[index]!;
    if (argument === '--report') {
      reportOnly = true;
      continue;
    }
    if (!argument.startsWith('--')) {
      positional.push(argument);
      continue;
    }
    if (!commandLineValueOptions.has(argument)) return { failure: `Unknown option ${argument}` };
    if (named.has(argument.slice(2))) return { failure: `${argument} may be supplied once` };
    const value = request.argv[index + 1];
    if (value === undefined || value.startsWith('--')) return { failure: `${argument} requires a value` };
    named.set(argument.slice(2), value);
    index += 1;
  }
  const sourceDirectory = positional[0];
  if (sourceDirectory === undefined) return { failure: 'A source directory is required' };
  if (positional.length > 1) return { failure: 'Exactly one source directory is required' };
  const target = named.get('target');
  if (target !== 'cpp' && target !== 'haxe' && target !== 'rust')
    return { failure: '--target must be cpp, haxe, or rust' };
  const outputDirectory = named.get('out');
  if (outputDirectory === undefined) return { failure: '--out is required' };
  const rootPackage = named.get('root-package');
  if (rootPackage !== undefined && target !== 'haxe') return { failure: '--root-package requires --target haxe' };
  const emissionMode = named.get('emission-mode') ?? 'transpile';
  if (emissionMode !== 'extern' && emissionMode !== 'transpile') {
    return { failure: '--emission-mode must be extern or transpile' };
  }
  if (named.has('emission-mode') && target !== 'haxe') {
    return { failure: '--emission-mode requires --target haxe' };
  }
  const runtimeProfile = named.get('runtime-profile') ?? 'flight-cpp';
  if (runtimeProfile !== 'flight-cpp' && runtimeProfile !== 'standard-library') {
    return { failure: '--runtime-profile must be flight-cpp or standard-library' };
  }
  const runtimeHeader = named.get('runtime-header');
  if ((named.has('runtime-profile') || runtimeHeader !== undefined) && target !== 'cpp') {
    return { failure: '--runtime-profile and --runtime-header require --target cpp' };
  }
  if (runtimeHeader !== undefined && (!isPortableIncludePath(runtimeHeader) || runtimeProfile !== 'flight-cpp')) {
    return {
      failure:
        runtimeProfile !== 'flight-cpp'
          ? '--runtime-header requires the flight-cpp runtime profile'
          : '--runtime-header must be a portable quoted-include path',
    };
  }
  return {
    emissionMode,
    outputDirectory,
    packageName: named.get('package') ?? '@local/source',
    reportOnly,
    ...(rootPackage === undefined ? {} : { rootPackage }),
    ...(runtimeHeader === undefined ? {} : { runtimeHeader }),
    runtimeProfile,
    sourceDirectory,
    target,
  };
}

function isPortableIncludePath(value: string): boolean {
  return value.length > 0 && !value.includes('\\') && !/["<>\r\n]/u.test(value);
}

const commandLineValueOptions = new Set([
  '--emission-mode',
  '--out',
  '--package',
  '--root-package',
  '--runtime-header',
  '--runtime-profile',
  '--target',
]);

const refusalModuleSampleSize = 3;

// Checking a workspace without writing one.
//
// The same deterministic compilation the emit path runs, asked once per selected package, with the
// output-file capability simply absent: check mode cannot write generated sources because its capability
// record has nowhere to put them. The report goes to the caller's streams, and the exit code says which
// of three things happened -- the check admitted the workspace, it found something that gates, or the
// invocation itself could not be carried out.
// The machine-readable form, with its own schema identity and no ordering that depends on iteration.
function createCompilerCommandLineCheckJson(result: Readonly<CompilerCommandLineCheckResult>): unknown {
  return {
    schema: 'flight-compiler-check/1',
    exitCode: result.exitCode,
    packages: [...result.packages],
    findings: result.findings.map((finding) => ({ ...finding })),
    introduced: result.introduced.map((finding) => finding.id),
    resolved: [...result.resolved],
    baselined: result.baselined,
    runtimeOnly: result.runtimeOnly,
  };
}

const commandLineCheckUsage = `Usage: flight-compile check <workspace> --target <cpp|haxe|rust>

  --environment <name>    Package environment to check; repeat for several (default: unmarked packages)
  --package <name>        Package to check by name; repeat for several (default: the workspace's unmarked
                          packages). A package that declares an environment needs --environment for it
  --baseline <file>       Compare findings against a baseline; the file is never rewritten
  --format <text|json>    Report format (default: text)
  --report <file>         Write the report to a file as well as printing the summary
  --runtime-profile <id>  C++ runtime profile: flight-cpp or standard-library (default: flight-cpp)
  --runtime-header <path> Override the flight-cpp runtime include spelling`;

interface ParsedCompilerCommandLineCheckRequest {
  readonly baselinePath?: string | undefined;
  readonly environmentNames: readonly string[];
  readonly format: CompilerCommandLineCheckFormat;
  readonly selectedPackageNames: readonly string[];
  readonly reportPath?: string | undefined;
  readonly runtimeHeader?: string | undefined;
  readonly runtimeProfile: 'flight-cpp' | 'standard-library';
  readonly target: 'cpp' | 'haxe' | 'rust';
  readonly workspaceDirectory: string;
}

function parseCompilerCommandLineCheckRequest(
  request: Readonly<CompilerCommandLineCheckRequest>,
): ParsedCompilerCommandLineCheckRequest | Readonly<{ failure: string }> {
  const positional: string[] = [];
  const named = new Map<string, string>();
  const environmentNames: string[] = [];
  const selectedPackageNames: string[] = [];
  for (let index = 0; index < request.argv.length; index += 1) {
    const argument = request.argv[index]!;
    if (!argument.startsWith('--')) {
      positional.push(argument);
      continue;
    }
    if (!commandLineCheckValueOptions.has(argument)) return { failure: `Unknown option ${argument}` };
    const value = request.argv[index + 1];
    if (value === undefined || value.startsWith('--')) return { failure: `${argument} requires a value` };
    index += 1;
    if (argument === '--environment') {
      if (environmentNames.includes(value)) return { failure: `--environment ${value} is supplied twice` };
      environmentNames.push(value);
      continue;
    }
    if (argument === '--package') {
      if (selectedPackageNames.includes(value)) return { failure: `--package ${value} is supplied twice` };
      selectedPackageNames.push(value);
      continue;
    }
    if (named.has(argument.slice(2))) return { failure: `${argument} may be supplied once` };
    named.set(argument.slice(2), value);
  }
  const workspaceDirectory = positional[0];
  if (workspaceDirectory === undefined) return { failure: 'A workspace directory is required' };
  if (positional.length > 1) return { failure: 'Exactly one workspace directory is required' };
  const target = named.get('target');
  if (target !== 'cpp' && target !== 'haxe' && target !== 'rust') {
    return { failure: '--target must be cpp, haxe, or rust' };
  }
  const format = named.get('format') ?? 'text';
  if (format !== 'text' && format !== 'json') return { failure: '--format must be text or json' };
  const reportPath = named.get('report');
  if (reportPath !== undefined && reportPath.length === 0) return { failure: '--report requires a path' };
  const runtimeProfile = named.get('runtime-profile') ?? 'flight-cpp';
  if (runtimeProfile !== 'flight-cpp' && runtimeProfile !== 'standard-library') {
    return { failure: '--runtime-profile must be flight-cpp or standard-library' };
  }
  const runtimeHeader = named.get('runtime-header');
  if ((named.has('runtime-profile') || runtimeHeader !== undefined) && target !== 'cpp') {
    return { failure: '--runtime-profile and --runtime-header require --target cpp' };
  }
  return {
    ...(named.get('baseline') === undefined ? {} : { baselinePath: named.get('baseline')! }),
    environmentNames,
    format,
    ...(reportPath === undefined ? {} : { reportPath }),
    ...(runtimeHeader === undefined ? {} : { runtimeHeader }),
    runtimeProfile,
    selectedPackageNames,
    target,
    workspaceDirectory,
  };
}

// Which packages a run is about. The eligibility lane owns this question -- the declared
// `flight.environment`, the narrow name selector, and what an unmarked package means -- so the CLI hands
// it the workspace's packages and takes back names. Repeating `--environment` asks for each in turn and
// unites the answers, which is what a caller naming two environments is asking for; with none named, the
// plan's own default applies. A refusal there is an invocation failure, not a finding.
function selectCompilerCommandLinePackages(
  packages: readonly Readonly<CompilerCommandLineWorkspacePackage>[],
  parsed: Readonly<ParsedCompilerCommandLineCheckRequest>,
): readonly Readonly<CompilerCommandLineWorkspacePackage>[] | Readonly<{ failure: string }> {
  const requested: readonly (FlightPackageEnvironment | undefined)[] =
    parsed.environmentNames.length === 0
      ? [undefined]
      : (parsed.environmentNames as readonly FlightPackageEnvironment[]);
  const eligible = new Set<string>();
  for (const environment of requested) {
    // Naming packages states the selection; naming none selects the workspace's own default, which is the
    // packages that carry no environment. Either way the plan below decides what the selection pulls in.
    const selected = packages.filter(
      (entry) =>
        (parsed.selectedPackageNames.length === 0 || parsed.selectedPackageNames.includes(entry.name)) &&
        (parsed.selectedPackageNames.length > 0 || entry.environment === environment),
    );
    try {
      const plan = createFlightPackageEligibilityPlan({
        packages: selected.map((entry) => ({
          dependencies: entry.dependencies,
          ...(entry.environment === undefined ? {} : { environment: entry.environment }),
          name: entry.name,
        })),
        selectedPackageNames: selected.map((entry) => entry.name),
        ...(environment === undefined ? {} : { environment }),
      });
      for (const name of plan.eligiblePackageNames) eligible.add(name);
    } catch (error) {
      if (isFlightPackageEligibilityFailure(error)) return { failure: error.message };
      throw error;
    }
  }
  return packages.filter((entry) => eligible.has(entry.name));
}

// One finding identity per line. Blank lines and `#` comments are ignored so a baseline can explain
// itself; the comparison is a set difference either way, so ordering never changes the answer.
function parseCompilerCommandLineBaseline(text: string): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    ids.add(trimmed);
  }
  return ids;
}

const commandLineCheckValueOptions = new Set([
  '--baseline',
  '--environment',
  '--format',
  '--package',
  '--report',
  '--runtime-header',
  '--runtime-profile',
  '--target',
]);
