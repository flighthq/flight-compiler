// The capability through which inventory reads a workspace.
//
// AGENTS.md requires that filesystem and process access stay at the edge and enter through explicit
// calls or capability records. Analysis that takes this record instead of importing `node:fs` is
// testable from an in-memory workspace, cannot reach a path nobody handed it, and states its host
// dependence in its signature rather than in its imports.
//
// The four operations are the complete set the inventory analysis performs. Deliberately absent:
// writing, deleting, watching, and process execution. Reading a checkout revision is a separate
// capability because it shells out rather than reading a file.

export interface WorkspaceSourceEntry {
  readonly isDirectory: boolean;
  readonly name: string;
}

export interface WorkspaceSource {
  readonly isDirectory: (candidate: string) => boolean;
  readonly isFile: (candidate: string) => boolean;
  readonly listDirectory: (directory: string) => readonly WorkspaceSourceEntry[];
  readonly readTextFile: (file: string) => string;
}
