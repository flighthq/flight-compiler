import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { CppCompilerToolchain } from './cppToolchain.js';
import { createCppExecutableArguments, findCppCompilerToolchain } from './cppToolchain.js';
import type { HaxeDualBindingLocatorEvidence, HaxeDualBindingLocatorHooks } from './haxeDualBindingGate.js';
import { describeHaxeDualBindingCppSpelling } from './haxeDualBindingGate.js';
import type { HaxeDualBindingCppLocator, HaxeDualBindingJavaScriptLocator } from './haxeDualBindingPlan.js';

// The two existence hooks a dual-binding gate asks its questions through.
//
// A plan claims that a public name lives somewhere: an export of a JavaScript module, or a symbol a C++
// header declares and a native slice defines. Confirming that claim needs the two things the gate itself
// must not own -- a module loader and a compiler -- so they are providers here, at the edge, and the gate
// stays a pure function of the answers.
//
// Neither provider guesses. The C++ provider never reads a header as text: it writes a translation unit
// that includes the declared header and names the declared reference, then compiles and links it against
// the slice. A header that declares the symbol but a slice that never defines it answers absent, which is
// the question the plan is really asking.
export interface HaxeDualBindingCppLocatorOptions {
  // `undefined` discovers an installed compiler; `null` states there is none, which the gate reports as
  // unchecked rather than as a pass.
  readonly compiler?: Readonly<CppCompilerToolchain> | null;
  readonly includeDirectories: readonly string[];
  // Sources, objects, or archives the probe links against. A reference to a declared type resolves at
  // compile time; a reference to a callable needs this to link.
  readonly slicePaths?: readonly string[];
  readonly timeoutMs?: number;
}

export interface HaxeDualBindingJsLocatorOptions {
  // Directories a relative specifier resolves against. A bare specifier is imported as it is.
  readonly moduleDirectories?: readonly string[];
}

type HaxeDualBindingJavaScriptLocatorResolver = HaxeDualBindingLocatorHooks['resolveJavaScriptExport'];

export function createHaxeDualBindingCppSymbolLocator(
  options: Readonly<HaxeDualBindingCppLocatorOptions>,
): HaxeDualBindingLocatorHooks['resolveCppSymbol'] {
  const toolchain = options.compiler === undefined ? findCppCompilerToolchain() : options.compiler;
  const resolved: (locator: Readonly<HaxeDualBindingCppLocator>) => HaxeDualBindingLocatorEvidence = (locator) => {
    if (!toolchain) {
      return {
        detail: 'no C++ compiler is installed, so no header or slice could be asked for this symbol',
        status: 'skipped',
      };
    }
    const directory = mkdtempSync(path.join(tmpdir(), 'haxe-dual-binding-'));
    try {
      const source = path.join(directory, 'probe.cpp');
      const output = path.join(directory, process.platform === 'win32' ? 'probe.exe' : 'probe');
      writeFileSync(source, createHaxeDualBindingCppProbeSource(locator));
      const result = spawnSync(
        toolchain.command,
        [
          ...createCppExecutableArguments(toolchain, source, output, options.includeDirectories),
          ...(options.slicePaths ?? []),
        ],
        { encoding: 'utf8', timeout: options.timeoutMs ?? 60_000 },
      );
      if (result.error) return { detail: String(result.error.message), status: 'absent' };
      if (result.status === 0) return { status: 'present' };
      return {
        detail: describeHaxeDualBindingCppFailure(result.stderr ?? '', locator),
        status: 'absent',
      };
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  };
  return resolved;
}

// Loading through the real loader is the point: an export that only exists in a type declaration, or a
// module whose top level throws, must answer absent rather than plausible. Every specifier the caller
// names is imported once, in sorted order, before the gate runs, so the answers are a function of the
// loaded modules and nothing else. A specifier the caller did not name answers unchecked rather than
// present: an unasked question is not a pass.
export async function createHaxeDualBindingJavaScriptExportLocator(
  specifiers: readonly string[],
  options: Readonly<HaxeDualBindingJsLocatorOptions> = {},
): Promise<HaxeDualBindingJavaScriptLocatorResolver> {
  const moduleDirectories = options.moduleDirectories ?? [];
  const loaded = new Map<string, Awaited<ReturnType<typeof loadHaxeDualBindingJsNamespace>>>();
  for (const specifier of [...new Set(specifiers)].sort(compareHaxeDualBindingLocatorText)) {
    loaded.set(specifier, await loadHaxeDualBindingJsNamespace(specifier, moduleDirectories));
  }
  return (locator) => {
    const entry = loaded.get(locator.specifier);
    return entry === undefined
      ? {
          detail: `${locator.specifier} was not among the specifiers the locator was asked to load, so its export was never asked for`,
          status: 'skipped',
        }
      : answerHaxeDualBindingJavaScriptExport(entry, locator);
  };
}

async function loadHaxeDualBindingJsNamespace(
  specifier: string,
  moduleDirectories: readonly string[],
): Promise<{ readonly failure?: string; readonly namespace?: Record<string, unknown> }> {
  try {
    const namespace = (await import(resolveHaxeDualBindingJsSpecifier(specifier, moduleDirectories))) as Record<
      string,
      unknown
    >;
    return { namespace };
  } catch (error) {
    return { failure: error instanceof Error ? error.message : String(error) };
  }
}

function answerHaxeDualBindingJavaScriptExport(
  loaded: Readonly<{ readonly failure?: string; readonly namespace?: Record<string, unknown> }>,
  locator: Readonly<HaxeDualBindingJavaScriptLocator>,
): HaxeDualBindingLocatorEvidence {
  if (loaded.failure !== undefined) return { detail: loaded.failure, status: 'absent' };
  const namespace = loaded.namespace ?? {};
  if (!Object.hasOwn(namespace, locator.exportedName) || namespace[locator.exportedName] === undefined) {
    return { detail: `${locator.specifier} exports no ${locator.exportedName}`, status: 'absent' };
  }
  return { status: 'present' };
}

function compareHaxeDualBindingLocatorText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

// The translation unit that asks the compiler the gate's question. The plan names a carrier and a
// spelling rather than a C++ expression, so this derives the one reference that proves that carrier: a
// callable's address, which only links when the slice defines it, or the size of the named type, which
// only compiles when the header declares it. Nothing here reads the header as text.
function createHaxeDualBindingCppProbeSource(locator: Readonly<HaxeDualBindingCppLocator>): string {
  const spelling = describeHaxeDualBindingCppSpelling(locator);
  const reference = locator.carrier === 'function' ? `&${spelling}` : `sizeof(${spelling})`;
  return `#include "${locator.include}"

int main() {
  volatile auto probe = (${reference});
  (void)probe;
  return 0;
}
`;
}

// A compiler's own words are the evidence: they name the missing header, the undeclared symbol, or the
// undefined reference that only linking could reveal.
function describeHaxeDualBindingCppFailure(stderr: string, locator: Readonly<HaxeDualBindingCppLocator>): string {
  const lines = stderr
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  // The driver's summary line ("ld returned 1 exit status") says only that something failed, so a line
  // that names the symbol is the evidence; the last line is the fallback for a diagnostic that does not
  // spell the qualified name.
  const symbol = locator.spelling;
  const named = [...lines].reverse().find((line) => line.includes(symbol));
  return (
    named ?? lines.at(-1) ?? `the compiler refused ${describeHaxeDualBindingCppSpelling(locator)} without a diagnostic`
  );
}

function resolveHaxeDualBindingJsSpecifier(specifier: string, moduleDirectories: readonly string[]): string {
  if (!specifier.startsWith('.') && !path.isAbsolute(specifier)) return specifier;
  return pathToFileURL(path.resolve(moduleDirectories[0] ?? process.cwd(), specifier)).href;
}
