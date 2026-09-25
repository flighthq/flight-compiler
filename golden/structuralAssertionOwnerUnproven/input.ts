export interface Node {
  readonly id: string;
}

export interface DerivedNode extends Node {
  readonly extra: number;
}

// The asserted row reads `extra`, which the subject's declaration does not carry, and a structural owner
// binds the members of the type the object was first reached as: the read would find no cell.
export function widen(node: Node): Readonly<DerivedNode> {
  return node as Readonly<DerivedNode>;
}
