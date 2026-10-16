import { formatHaxeDualBindingGateRunReport, runHaxeDualBindingGateChecks } from './haxeDualBindingRun.js';

// `npm run haxe-binding:check -- --artifacts=<directory> [--include=<directory>] [--slice=<path>]
// [--modules=<directory>]`
//
// The dual-binding gates need two inputs that only the fold can supply: the serialized plan artifacts
// the producer lanes wrote, and the place the C++ backing's symbols actually live (its generated header
// directories and the native slice). Both are arguments rather than conventions because guessing either
// one would let a green run mean nothing.
//
// The exit code is the report: a plan that cannot be read, cannot be parsed, or fails a gate is a
// failure, and a selection nothing could check is printed as unchecked so a reader can tell an
// unverified pass from a verified one.
const options = parseHaxeDualBindingCheckArguments(process.argv.slice(2));
if (options.artifactDirectory === undefined) {
  process.stderr.write(
    'usage: haxe-binding:check --artifacts=<directory> [--include=<directory>] [--slice=<path>] [--modules=<directory>]\n',
  );
  process.exitCode = 2;
} else {
  const report = await runHaxeDualBindingGateChecks({
    artifactDirectory: options.artifactDirectory,
    cpp: options.cpp,
    js: options.js,
  });
  process.stdout.write(formatHaxeDualBindingGateRunReport(report));
  process.exitCode = report.failures.length === 0 ? 0 : 1;
}

interface HaxeDualBindingCheckArguments {
  readonly artifactDirectory?: string;
  readonly cpp: { readonly includeDirectories: readonly string[]; readonly slicePaths: readonly string[] };
  readonly js: { readonly moduleDirectories: readonly string[] };
}

function parseHaxeDualBindingCheckArguments(argv: readonly string[]): HaxeDualBindingCheckArguments {
  const includeDirectories: string[] = [];
  const slicePaths: string[] = [];
  const moduleDirectories: string[] = [];
  let artifactDirectory: string | undefined;
  for (const argument of argv) {
    const [name, value] = splitHaxeDualBindingCheckArgument(argument);
    if (name === '--artifacts' && value !== undefined) artifactDirectory = value;
    else if (name === '--include' && value !== undefined) includeDirectories.push(value);
    else if (name === '--slice' && value !== undefined) slicePaths.push(value);
    else if (name === '--modules' && value !== undefined) moduleDirectories.push(value);
  }
  return {
    ...(artifactDirectory === undefined ? {} : { artifactDirectory }),
    cpp: { includeDirectories, slicePaths },
    js: { moduleDirectories },
  };
}

function splitHaxeDualBindingCheckArgument(argument: string): readonly [string, string | undefined] {
  const separator = argument.indexOf('=');
  return separator === -1 ? [argument, undefined] : [argument.slice(0, separator), argument.slice(separator + 1)];
}
