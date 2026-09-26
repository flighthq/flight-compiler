type Scalar = boolean | number | string;

// A carrier stating an index signature is the runtime's keyed record, and the runtime enumerates a record
// through its own accessors. The named-property view is a handle on an OBJECT's properties and is not an
// overload a record can be passed to, so the record takes the binding that names it.
interface Fields {
  [name: string]: Scalar;
}

// A declaration with named members stays on the view: the two carriers are different things.
interface Named {
  alpha: number;
  beta: string;
}

export function recordKeys(fields: Fields): string[] {
  return Object.keys(fields);
}

export function recordValues(fields: Fields): Scalar[] {
  return Object.values(fields);
}

export function recordEntries(fields: Fields): [string, Scalar][] {
  return Object.entries(fields);
}

export function objectKeys(value: Named): string[] {
  return Object.keys(value);
}

export function objectValues(value: Named): unknown[] {
  return Object.values(value);
}
