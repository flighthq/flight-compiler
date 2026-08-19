export type Pair<Left, Right> = { readonly left: Left; readonly right: Right };

export function identity<Value>(value: Value): Value {
  return value;
}
