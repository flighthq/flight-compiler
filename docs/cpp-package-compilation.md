# C++ package compilation

`compileTypeScriptPackageGraph` is the public regeneration boundary for target repositories. One request supplies every source with its source package and package root, a versioned package graph, exact module dependencies where discovery is not sufficient, one backend, and its options. The compiler lowers each source once and prepares graph-wide backend analysis once.

The graph schema is `flight-compiler-package-graph/1`. Package dependencies are explicit and are checked against every cross-package module edge. Relative sibling edges are resolved from the supplied module set; package exports can be supplied through `CompilerModuleResolutionPlan`. An importer-specific resolution edge takes precedence over a workspace-wide export edge with the same specifier.

The result report uses `flight-compiler-package-report/1` and contains:

- one emitted or refused outcome per source module;
- stable refusal codes, stages, and lowering source locations;
- dependency-closed partial output, so no reported file depends on a refused module;
- source ownership and normalized dependencies for every emitted file;
- package dependency and output-file inventories; and
- the target-neutral ECMAScript module evaluation plan for the surviving entry closure.

The C++ backend accepts a `packageTargets` record. Namespace and installed include identity are separate, so `@flighthq/types` can emit under namespace `flight::types` and include prefix `flight/types` without rewriting generated text.

`externalBindings` uses `flight-cpp-external-bindings/1`. Each ambient type or value binding declares its required headers, qualified C++ target, type or value space, nullability, ownership, optional static members, and optional constructor or factory spelling. Reachable ambient symbols without exactly one built-in or downstream binding are refused. Native binding manifests live with the target package or host adapter; the compiler does not import their implementation.

The initialization report plans dependency order, live bindings, declaration initialization, and supported executable top-level statements. C++ carries synchronous top-level control flow through ordered inline initialization closures. Top-level `await` remains a structured refusal until asynchronous module evaluation is represented, and nested `var` remains refused where preserving its module-scoped binding would require declaration hoisting.

The [flight-cpp adoption register](../agents/flight-cpp-adoption.md) tracks runtime headers, host manifests, ABI coordination, build integration, and downstream release gates required by the compiler's current emitted contract. It remains in this repository until `flight-cpp` adopts an equivalent maintained register.
