export interface Node {
  readonly id: string;
}

export interface DerivedNode extends Node {
  readonly extra: number;
}

// The asserted row reads only members the subject's own declaration carries, so the view built from
// that subject answers every one and the cast re-views the object the source named.
export function same(node: Node): Readonly<Node> {
  return node as Readonly<Node>;
}

export function widen(node: DerivedNode): Readonly<Node> {
  return node as Readonly<Node>;
}
