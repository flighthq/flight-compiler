// The serialized `flight-haxe-dual-binding-plan/1` artifact, as this repository reads it.
//
// A dual-binding plan answers one question for a package: for each public name Haxe publishes, does a
// C++ backing carry it, does a JavaScript backing carry it, and where does each of those live? It is
// deliberately a serialized artifact rather than a compiler output object. The producer is the Haxe
// binding plan in `compiler-backend-hx`, the consumers are this gate, the flight-hx runtime wiring, and
// the native slice, and they live in different processes; nobody re-derives anybody else's identities. A
// plan names its own keys, public identities, and locators, and nothing here recomputes a TypeScript,
// Haxe, or C++ identity from source.
//
// The field names below are the serialized projection of `CompilerHaxeDualBindingPlan` in
// `compiler-types`: one `bindings` array, each binding carrying the source export identity, the public
// Haxe identity, and one backend entry per target. Availability is a discriminated pair rather than a
// flag, so a refused backing always arrives with the refusal that refused it.
//
// Everything in this file is pure: parse and validate a value that arrived from disk. Locating the named
// exports and symbols is the callers' business, because that needs a module loader and a C++ compiler.
export type HaxeDualBindingBackendKind = 'cpp' | 'javascript';

export type HaxeDualBindingCppCarrier = 'class' | 'enum' | 'function' | 'interface' | 'type-alias' | 'value';

export type HaxeDualBindingPublicKind = 'function' | 'type' | 'type-value' | 'value';

export type HaxeDualBindingPlanParseFailureRule =
  | 'haxe-dual-binding-plan-availability-incomplete'
  | 'haxe-dual-binding-plan-carrier-unsupported'
  | 'haxe-dual-binding-plan-key-duplicate'
  | 'haxe-dual-binding-plan-public-name-duplicate'
  | 'haxe-dual-binding-plan-schema-unsupported'
  | 'haxe-dual-binding-plan-shape-invalid';

export type HaxeDualBindingPlanParseFailure = Readonly<{
  detail: string;
  kind: 'haxe-dual-binding-plan-parse-failure';
  rule: HaxeDualBindingPlanParseFailureRule;
  subject: string;
}>;

export type HaxeDualBindingRefusal = Readonly<{
  code: string;
  detailCode?: string;
  message: string;
  subject: string;
}>;

export type HaxeDualBindingBacking<Locator> =
  | Readonly<{ availability: 'available'; locator: Readonly<Locator> }>
  | Readonly<{ availability: 'refused'; refusal: Readonly<HaxeDualBindingRefusal> }>;

export interface HaxeDualBindingCppLocator {
  readonly carrier: HaxeDualBindingCppCarrier;
  readonly include: string;
  readonly namespace: string;
  readonly spelling: string;
}

export interface HaxeDualBinding {
  readonly cpp: HaxeDualBindingBacking<HaxeDualBindingCppLocator>;
  readonly identity: Readonly<HaxeDualBindingSourceExportIdentity>;
  readonly javascript: HaxeDualBindingBacking<HaxeDualBindingJavaScriptLocator>;
  readonly key: string;
  readonly publicHaxe: Readonly<HaxeDualBindingPublicIdentity>;
}

export interface HaxeDualBindingJavaScriptLocator {
  readonly exportedName: string;
  readonly specifier: string;
}

export interface HaxeDualBindingPlan {
  readonly bindings: readonly HaxeDualBinding[];
  readonly schema: 'flight-haxe-dual-binding-plan/1';
}

export interface HaxeDualBindingPublicIdentity {
  readonly kind: HaxeDualBindingPublicKind;
  readonly name: string;
  readonly owner: string;
  readonly qualifiedName: string;
  readonly signature?: string;
  readonly typeIdentity: string;
}

export interface HaxeDualBindingSourceExportIdentity {
  readonly declarationIdentity: string;
  readonly exportRoute: string;
  readonly packageName: string;
  readonly source: string;
  readonly space: 'type' | 'value';
}

export type HaxeDualBindingPlanParseResult =
  | Readonly<{ kind: 'haxe-dual-binding-plan-parsed'; plan: HaxeDualBindingPlan }>
  | HaxeDualBindingPlanParseFailure;

export function parseHaxeDualBindingPlanArtifact(value: unknown): HaxeDualBindingPlanParseResult {
  if (!isRecord(value)) {
    return createHaxeDualBindingPlanParseFailure(
      'haxe-dual-binding-plan-shape-invalid',
      '<artifact>',
      'artifact is not an object',
    );
  }
  if (value['schema'] !== 'flight-haxe-dual-binding-plan/1') {
    return createHaxeDualBindingPlanParseFailure(
      'haxe-dual-binding-plan-schema-unsupported',
      '<artifact>',
      `expected schema flight-haxe-dual-binding-plan/1, received ${describeHaxeDualBindingPlanValue(value['schema'])}`,
    );
  }
  if (!Array.isArray(value['bindings'])) {
    return createHaxeDualBindingPlanParseFailure(
      'haxe-dual-binding-plan-shape-invalid',
      'bindings',
      'bindings must be an array',
    );
  }

  const bindings: HaxeDualBinding[] = [];
  const keys = new Set<string>();
  const publicNames = new Map<string, string>();
  for (const [index, entry] of value['bindings'].entries()) {
    const subject = `bindings[${index}]`;
    const binding = readHaxeDualBinding(entry, subject);
    if ('rule' in binding) return binding;
    if (keys.has(binding.key)) {
      return createHaxeDualBindingPlanParseFailure(
        'haxe-dual-binding-plan-key-duplicate',
        subject,
        `duplicate key ${JSON.stringify(binding.key)}`,
      );
    }
    keys.add(binding.key);
    const publicName = binding.publicHaxe.qualifiedName;
    const previous = publicNames.get(publicName);
    if (previous !== undefined) {
      if (previous !== (binding.publicHaxe.signature ?? '')) {
        return createHaxeDualBindingPlanParseFailure(
          'haxe-dual-binding-plan-public-name-duplicate',
          subject,
          `${publicName} is declared twice with different signatures (${previous || 'none'} and ${binding.publicHaxe.signature ?? 'none'})`,
        );
      }
      return createHaxeDualBindingPlanParseFailure(
        'haxe-dual-binding-plan-public-name-duplicate',
        subject,
        `${publicName} is bound twice; one public name has one dual binding`,
      );
    }
    publicNames.set(publicName, binding.publicHaxe.signature ?? '');
    bindings.push(binding);
  }

  return { kind: 'haxe-dual-binding-plan-parsed', plan: { bindings, schema: 'flight-haxe-dual-binding-plan/1' } };
}

// Failure order is part of the report: two runs over the same artifact print the same lines in the same
// order, whichever filesystem order produced them.
export function sortHaxeDualBindingPlanFailures(
  failures: readonly HaxeDualBindingPlanParseFailure[],
): readonly HaxeDualBindingPlanParseFailure[] {
  return [...failures].sort((left, right) =>
    left.subject === right.subject
      ? compareHaxeDualBindingText(left.rule, right.rule)
      : compareHaxeDualBindingText(left.subject, right.subject),
  );
}

function compareHaxeDualBindingText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function createHaxeDualBindingPlanParseFailure(
  rule: HaxeDualBindingPlanParseFailureRule,
  subject: string,
  detail: string,
): HaxeDualBindingPlanParseFailure {
  return { detail, kind: 'haxe-dual-binding-plan-parse-failure', rule, subject };
}

function describeHaxeDualBindingPlanValue(value: unknown): string {
  return typeof value === 'string' ? JSON.stringify(value) : String(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readHaxeDualBinding(entry: unknown, subject: string): HaxeDualBinding | HaxeDualBindingPlanParseFailure {
  if (!isRecord(entry)) {
    return createHaxeDualBindingPlanParseFailure(
      'haxe-dual-binding-plan-shape-invalid',
      subject,
      'binding must be an object',
    );
  }
  const key = entry['key'];
  if (typeof key !== 'string' || key.length === 0) {
    return createHaxeDualBindingPlanParseFailure(
      'haxe-dual-binding-plan-shape-invalid',
      subject,
      'binding key must be a non-empty string',
    );
  }
  const identity = readHaxeDualBindingSourceExportIdentity(entry['identity'], `${subject}.identity`);
  if ('rule' in identity) return identity;
  const publicHaxe = readHaxeDualBindingPublicIdentity(entry['publicHaxe'], `${subject}.publicHaxe`);
  if ('rule' in publicHaxe) return publicHaxe;
  const cpp = readHaxeDualBindingCppBacking(entry['cpp'], `${subject}.cpp`);
  if ('rule' in cpp) return cpp;
  const javascript = readHaxeDualBindingJavaScriptBacking(entry['javascript'], `${subject}.javascript`);
  if ('rule' in javascript) return javascript;
  return { cpp, identity, javascript, key, publicHaxe };
}

function readHaxeDualBindingBackingAvailability(
  value: unknown,
  subject: string,
): 'available' | 'refused' | HaxeDualBindingPlanParseFailure {
  if (!isRecord(value)) {
    return createHaxeDualBindingPlanParseFailure(
      'haxe-dual-binding-plan-availability-incomplete',
      subject,
      'a backend entry must be an object',
    );
  }
  const availability = value['availability'];
  if (availability === 'available' || availability === 'refused') return availability;
  return createHaxeDualBindingPlanParseFailure(
    'haxe-dual-binding-plan-availability-incomplete',
    subject,
    `availability must be available or refused, received ${describeHaxeDualBindingPlanValue(availability)}`,
  );
}

function readHaxeDualBindingCppBacking(
  value: unknown,
  subject: string,
): HaxeDualBindingBacking<HaxeDualBindingCppLocator> | HaxeDualBindingPlanParseFailure {
  const availability = readHaxeDualBindingBackingAvailability(value, subject);
  if (typeof availability !== 'string') return availability;
  const entry = value as Record<string, unknown>;
  if (availability === 'refused') {
    const refusal = readHaxeDualBindingRefusal(entry['refusal'], subject);
    return 'rule' in refusal ? refusal : { availability, refusal };
  }
  const locator = entry['locator'];
  if (!isRecord(locator)) {
    return createHaxeDualBindingPlanParseFailure(
      'haxe-dual-binding-plan-availability-incomplete',
      subject,
      'an available cpp backing must carry a locator',
    );
  }
  const carrier = locator['carrier'];
  if (
    carrier !== 'class' &&
    carrier !== 'enum' &&
    carrier !== 'function' &&
    carrier !== 'interface' &&
    carrier !== 'type-alias' &&
    carrier !== 'value'
  ) {
    return createHaxeDualBindingPlanParseFailure(
      'haxe-dual-binding-plan-carrier-unsupported',
      subject,
      `cpp carrier must be class, enum, function, interface, type-alias, or value, received ${describeHaxeDualBindingPlanValue(carrier)}`,
    );
  }
  const include = locator['include'];
  const namespace = locator['namespace'];
  const spelling = locator['spelling'];
  if (typeof include !== 'string' || include.length === 0 || typeof spelling !== 'string' || spelling.length === 0) {
    return createHaxeDualBindingPlanParseFailure(
      'haxe-dual-binding-plan-shape-invalid',
      subject,
      'a cpp locator must name an include and a spelling',
    );
  }
  if (typeof namespace !== 'string') {
    return createHaxeDualBindingPlanParseFailure(
      'haxe-dual-binding-plan-shape-invalid',
      subject,
      'a cpp locator namespace must be a string, empty when the symbol is global',
    );
  }
  return { availability, locator: { carrier, include, namespace, spelling } };
}

function readHaxeDualBindingJavaScriptBacking(
  value: unknown,
  subject: string,
): HaxeDualBindingBacking<HaxeDualBindingJavaScriptLocator> | HaxeDualBindingPlanParseFailure {
  const availability = readHaxeDualBindingBackingAvailability(value, subject);
  if (typeof availability !== 'string') return availability;
  const entry = value as Record<string, unknown>;
  if (availability === 'refused') {
    const refusal = readHaxeDualBindingRefusal(entry['refusal'], subject);
    return 'rule' in refusal ? refusal : { availability, refusal };
  }
  const locator = entry['locator'];
  if (!isRecord(locator)) {
    return createHaxeDualBindingPlanParseFailure(
      'haxe-dual-binding-plan-availability-incomplete',
      subject,
      'an available javascript backing must carry a locator',
    );
  }
  const exportedName = locator['exportedName'];
  const specifier = locator['specifier'];
  if (
    typeof exportedName !== 'string' ||
    exportedName.length === 0 ||
    typeof specifier !== 'string' ||
    specifier.length === 0
  ) {
    return createHaxeDualBindingPlanParseFailure(
      'haxe-dual-binding-plan-shape-invalid',
      subject,
      'a javascript locator must name a specifier and an exportedName',
    );
  }
  return { availability, locator: { exportedName, specifier } };
}

function readHaxeDualBindingPublicIdentity(
  value: unknown,
  subject: string,
): Readonly<HaxeDualBindingPublicIdentity> | HaxeDualBindingPlanParseFailure {
  if (!isRecord(value)) {
    return createHaxeDualBindingPlanParseFailure(
      'haxe-dual-binding-plan-shape-invalid',
      subject,
      'publicHaxe must be an object',
    );
  }
  const kind = value['kind'];
  if (kind !== 'function' && kind !== 'type' && kind !== 'type-value' && kind !== 'value') {
    return createHaxeDualBindingPlanParseFailure(
      'haxe-dual-binding-plan-shape-invalid',
      subject,
      `public kind must be function, type, type-value, or value, received ${describeHaxeDualBindingPlanValue(kind)}`,
    );
  }
  const name = value['name'];
  const qualifiedName = value['qualifiedName'];
  const typeIdentity = value['typeIdentity'];
  if (
    typeof name !== 'string' ||
    name.length === 0 ||
    typeof qualifiedName !== 'string' ||
    qualifiedName.length === 0 ||
    typeof typeIdentity !== 'string' ||
    typeIdentity.length === 0
  ) {
    return createHaxeDualBindingPlanParseFailure(
      'haxe-dual-binding-plan-shape-invalid',
      subject,
      'a public identity must name a name, a qualifiedName, and a typeIdentity',
    );
  }
  const owner = value['owner'];
  if (typeof owner !== 'string') {
    return createHaxeDualBindingPlanParseFailure(
      'haxe-dual-binding-plan-shape-invalid',
      subject,
      'a public identity owner must be a string, empty when the name is top level',
    );
  }
  const signature = value['signature'];
  return typeof signature === 'string'
    ? { kind, name, owner, qualifiedName, signature, typeIdentity }
    : { kind, name, owner, qualifiedName, typeIdentity };
}

function readHaxeDualBindingRefusal(
  value: unknown,
  subject: string,
): Readonly<HaxeDualBindingRefusal> | HaxeDualBindingPlanParseFailure {
  if (!isRecord(value)) {
    return createHaxeDualBindingPlanParseFailure(
      'haxe-dual-binding-plan-availability-incomplete',
      subject,
      'a refused backing must state its refusal',
    );
  }
  const code = value['code'];
  const message = value['message'];
  const refusalSubject = value['subject'];
  if (
    typeof code !== 'string' ||
    code.length === 0 ||
    typeof message !== 'string' ||
    message.length === 0 ||
    typeof refusalSubject !== 'string' ||
    refusalSubject.length === 0
  ) {
    return createHaxeDualBindingPlanParseFailure(
      'haxe-dual-binding-plan-availability-incomplete',
      subject,
      'a refusal must name a code, a message, and the subject it refused',
    );
  }
  const detailCode = value['detailCode'];
  return typeof detailCode === 'string'
    ? { code, detailCode, message, subject: refusalSubject }
    : { code, message, subject: refusalSubject };
}

function readHaxeDualBindingSourceExportIdentity(
  value: unknown,
  subject: string,
): Readonly<HaxeDualBindingSourceExportIdentity> | HaxeDualBindingPlanParseFailure {
  if (!isRecord(value)) {
    return createHaxeDualBindingPlanParseFailure(
      'haxe-dual-binding-plan-shape-invalid',
      subject,
      'identity must be an object',
    );
  }
  const declarationIdentity = value['declarationIdentity'];
  const exportRoute = value['exportRoute'];
  const packageName = value['packageName'];
  const source = value['source'];
  if (
    typeof declarationIdentity !== 'string' ||
    declarationIdentity.length === 0 ||
    typeof exportRoute !== 'string' ||
    exportRoute.length === 0 ||
    typeof packageName !== 'string' ||
    packageName.length === 0 ||
    typeof source !== 'string' ||
    source.length === 0
  ) {
    return createHaxeDualBindingPlanParseFailure(
      'haxe-dual-binding-plan-shape-invalid',
      subject,
      'a source export identity must name a declarationIdentity, an exportRoute, a packageName, and a source',
    );
  }
  const space = value['space'];
  if (space !== 'type' && space !== 'value') {
    return createHaxeDualBindingPlanParseFailure(
      'haxe-dual-binding-plan-shape-invalid',
      subject,
      `identity space must be type or value, received ${describeHaxeDualBindingPlanValue(space)}`,
    );
  }
  return { declarationIdentity, exportRoute, packageName, source, space };
}
