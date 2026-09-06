import type { CompilerHaxeAmbientMemberBinding, IrResolvedMember } from '../../compiler-types/src/index.js';

// How Haxe spells a member of the ambient surface.
//
// A rename is the common case and stays data. A member Haxe puts somewhere else entirely — `trim` is
// a `StringTools` function, not a method — is a static call with the receiver as its first argument.
// A member absent from this table has no agreed Haxe spelling and is refused rather than guessed at,
// because a name that happens to exist on the target is the most expensive kind of coincidence.

export function getCompilerHaxeAmbientMemberBinding(
  member: Readonly<IrResolvedMember>,
): CompilerHaxeAmbientMemberBinding | undefined {
  return haxeAmbientMemberBindings[`${member.receiver}.${member.name}`];
}

const haxeAmbientMemberBindings: Readonly<Record<string, CompilerHaxeAmbientMemberBinding>> = {
  'array.concat': { kind: 'method', targetName: 'concat' },
  'array.every': { kind: 'staticCall', targetPath: 'Lambda.foreach' },
  'array.filter': { kind: 'method', targetName: 'filter' },
  'array.find': { kind: 'staticCall', targetPath: 'Lambda.find' },
  'array.includes': { kind: 'method', targetName: 'contains' },
  'array.indexOf': { kind: 'method', targetName: 'indexOf' },
  'array.join': { kind: 'method', targetName: 'join' },
  'array.lastIndexOf': { kind: 'method', targetName: 'lastIndexOf' },
  'array.length': { kind: 'property', targetName: 'length' },
  'array.map': { kind: 'method', targetName: 'map' },
  'array.pop': { kind: 'method', targetName: 'pop' },
  'array.push': { kind: 'method', targetName: 'push' },
  'array.reduce': { kind: 'staticFold', targetPath: 'Lambda.fold' },
  'array.reverse': { kind: 'method', targetName: 'reverse' },
  'array.some': { kind: 'staticCall', targetPath: 'Lambda.exists' },
  'array.shift': { kind: 'method', targetName: 'shift' },
  'array.slice': { kind: 'method', targetName: 'slice' },
  'array.unshift': { kind: 'method', targetName: 'unshift' },
  'date.getDate': { kind: 'method', targetName: 'getDate' },
  'date.getDay': { kind: 'method', targetName: 'getDay' },
  'date.getFullYear': { kind: 'method', targetName: 'getFullYear' },
  'date.getHours': { kind: 'method', targetName: 'getHours' },
  'date.getMilliseconds': { kind: 'method', targetName: 'getMilliseconds' },
  'date.getMinutes': { kind: 'method', targetName: 'getMinutes' },
  'date.getMonth': { kind: 'method', targetName: 'getMonth' },
  'date.getSeconds': { kind: 'method', targetName: 'getSeconds' },
  'date.getTime': { kind: 'method', targetName: 'getTime' },
  'date.toISOString': { kind: 'method', targetName: 'toISOString' },
  'date.toString': { kind: 'method', targetName: 'toString' },
  'error.message': { kind: 'property', targetName: 'message' },
  'number.toString': { kind: 'method', targetName: 'toString' },
  'map.delete': { kind: 'method', targetName: 'delete' },
  'map.get': { kind: 'method', targetName: 'get' },
  'map.has': { kind: 'method', targetName: 'has' },
  'map.set': { kind: 'method', targetName: 'set' },
  'map.size': { kind: 'property', targetName: 'size' },
  'set.add': { kind: 'method', targetName: 'add' },
  'set.delete': { kind: 'method', targetName: 'delete' },
  'set.has': { kind: 'method', targetName: 'has' },
  'set.size': { kind: 'property', targetName: 'size' },
  'string.charAt': { kind: 'method', targetName: 'charAt' },
  'string.charCodeAt': { kind: 'method', targetName: 'charCodeAt' },
  'string.endsWith': { kind: 'staticCall', targetPath: 'StringTools.endsWith' },
  'string.indexOf': { kind: 'method', targetName: 'indexOf' },
  'string.lastIndexOf': { kind: 'method', targetName: 'lastIndexOf' },
  'string.length': { kind: 'property', targetName: 'length' },
  // `string.replace` is deliberately absent. The source language replaces the first occurrence and
  // `StringTools.replace` replaces every one, so binding them to each other would be silently wrong
  // — the kind of wrong that compiles. It needs a runtime helper or an inline lowering, not a rename.
  'string.split': { kind: 'method', targetName: 'split' },
  'string.startsWith': { kind: 'staticCall', targetPath: 'StringTools.startsWith' },
  'string.substring': { kind: 'method', targetName: 'substring' },
  'string.toLowerCase': { kind: 'method', targetName: 'toLowerCase' },
  'string.toUpperCase': { kind: 'method', targetName: 'toUpperCase' },
  'string.trim': { kind: 'staticCall', targetPath: 'StringTools.trim' },
  'tuple.length': { kind: 'property', targetName: 'length' },
};
