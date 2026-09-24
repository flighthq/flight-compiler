// Which targets an emitted-source lane runs.
//
// Both emitted-source gates -- the compile check and the behavioral oracle -- default to every target
// they can find locally, because that is what a person running them by hand wants. A CI job is the
// other case: a job named for one target must exercise exactly that target, or the runner image's
// contents decide whether a nominal C++ job also builds Haxe and Rust. The filter is therefore
// explicit and repeatable, and an unknown target fails rather than being ignored.

export type SourceCompileTarget = 'cpp' | 'haxe' | 'rust';

export interface SourceCompileFilters {
  readonly targets: ReadonlySet<SourceCompileTarget>;
}

export function parseSourceCompileFilters(args: readonly string[]): SourceCompileFilters {
  const targets = new Set<SourceCompileTarget>();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? '';
    const inline = argument.startsWith('--target=') ? argument.slice('--target='.length) : undefined;
    if (argument !== '--target' && inline === undefined) {
      throw new Error(`Unknown emitted-source argument: ${argument}`);
    }
    const value = inline ?? args[index + 1];
    if (!value) throw new Error(`${argument} requires a value`);
    if (inline === undefined) index += 1;
    if (value !== 'cpp' && value !== 'haxe' && value !== 'rust') {
      throw new Error(`Unknown emitted-source target: ${value}`);
    }
    targets.add(value);
  }
  if (targets.size === 0) {
    targets.add('cpp');
    targets.add('haxe');
    targets.add('rust');
  }
  return { targets };
}

export function getSourceCompileTargets(filters: Readonly<SourceCompileFilters>): readonly SourceCompileTarget[] {
  return [...filters.targets].sort();
}
