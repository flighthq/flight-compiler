// Flight colocates tests with runtime sources. Keep this list deliberately syntactic and narrow:
// check mode must not need workspace-hoisted test dependencies merely to discover production code,
// while ordinary production names that happen to contain "test" must remain in the package graph.
export function isFlightWorkspaceProductionSource(file: string): boolean {
  return /\.tsx?$/u.test(file) && !file.endsWith('.d.ts') && !isFlightWorkspaceTestSource(file);
}

export function isFlightWorkspaceTestSource(file: string): boolean {
  return /(?:\.(?:test|spec)|TestHelper)\.tsx?$/u.test(file);
}
