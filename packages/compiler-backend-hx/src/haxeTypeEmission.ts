import type {
  IrBindingIdentity,
  IrType,
  IrTypeBindingIdentity,
  IrTypeReference,
} from '../../compiler-types/src/index.js';

interface IrTypeHaxeEmissionContext {
  readonly fail: (message: string) => never;
  readonly getBindingName: (binding: Readonly<IrBindingIdentity | IrTypeBindingIdentity>) => string;
  readonly getExternalTypeName: (name: string) => string | undefined;
  readonly getMemberName: (name: string) => string;
  readonly getTypeName: (name: string) => string;
  readonly resolveNamedType?: ((type: Readonly<IrTypeReference>) => string | undefined) | undefined;
}

export function emitIrTypeHaxe(type: Readonly<IrType>, context: Readonly<IrTypeHaxeEmissionContext>): string {
  switch (type.kind) {
    case 'array':
      return `Array<${emitIrTypeHaxe(type.element, context)}>`;
    case 'function': {
      const parameters = type.parameters.map((parameter) => emitIrTypeHaxe(parameter.type, context));
      return `(${parameters.join(', ')})->${emitIrTypeHaxe(type.returns, context)}`;
    }
    case 'indexedAccess':
    case 'keyof':
    case 'typeOf':
      return 'Dynamic';
    case 'intersection':
      return type.types.length === 1 ? emitIrTypeHaxe(type.types[0]!, context) : 'Dynamic';
    case 'literal':
      return typeof type.value === 'boolean' ? 'Bool' : typeof type.value === 'number' ? 'Float' : 'String';
    case 'named': {
      const sourceName = type.reference.kind === 'ambient' ? type.reference.name : undefined;
      if (sourceName !== undefined && haxeErasedUtilityTypeNames.has(sourceName) && type.typeArguments[0]) {
        return emitIrTypeHaxe(type.typeArguments[0], context);
      }
      if (sourceName === 'Record' && type.typeArguments[1]) {
        const externalTypeName = context.getExternalTypeName(sourceName);
        if (!externalTypeName) context.fail(`external type ${sourceName} has no Haxe binding`);
        return `${externalTypeName}<${emitIrTypeHaxe(type.typeArguments[1], context)}>`;
      }
      const resolved = context.resolveNamedType?.(type);
      if (resolved !== undefined) return resolved;
      let targetName: string;
      if (type.reference.kind === 'ambient') {
        const externalTypeName = context.getExternalTypeName(type.reference.name);
        if (!externalTypeName) context.fail(`external type ${type.reference.name} has no Haxe binding`);
        targetName = externalTypeName;
      } else {
        targetName = [
          context.getBindingName(type.reference.binding),
          ...type.reference.path.map(context.getTypeName),
        ].join('.');
      }
      const arguments_ = type.typeArguments.map((argument) => emitIrTypeHaxe(argument, context));
      return targetName === 'Dynamic'
        ? targetName
        : `${targetName}${arguments_.length > 0 ? `<${arguments_.join(', ')}>` : ''}`;
    }
    case 'never':
    case 'null':
    case 'undefined':
      return 'Dynamic';
    case 'object':
      return `{ ${type.properties
        .map((property) => {
          const optional = property.optional ? '?' : '';
          return `${optional}${context.getMemberName(property.name)}:${emitIrTypeHaxe(property.type, context)}`;
        })
        .join(', ')} }`;
    case 'primitive':
      return {
        bigint: 'haxe.Int64',
        boolean: 'Bool',
        number: 'Float',
        string: 'String',
        symbol: 'Dynamic',
        void: 'Void',
      }[type.name];
    case 'tuple': {
      const elements = type.elements.map((element) => emitIrTypeHaxe(element.type, context));
      const shared = new Set(elements);
      return shared.size === 1 && !type.elements.some((element) => element.optional)
        ? `Array<${[...shared][0]!}>`
        : 'Array<Dynamic>';
    }
    case 'union': {
      const concrete = type.types.filter((item) => item.kind !== 'null' && item.kind !== 'undefined');
      if (hasIrTypeKindHaxe(type, 'null') && hasIrTypeKindHaxe(type, 'undefined')) {
        return 'Dynamic';
      }
      return concrete.length === 1 && concrete.length !== type.types.length
        ? `Null<${emitIrTypeHaxe(concrete[0]!, context)}>`
        : 'Dynamic';
    }
    case 'unknown':
      return 'Dynamic';
  }
}

const haxeErasedUtilityTypeNames = new Set([
  'Exclude',
  'Extract',
  'NoInfer',
  'Omit',
  'Partial',
  'Pick',
  'Readonly',
  'Required',
]);

function hasIrTypeKindHaxe(type: Readonly<IrType>, kind: IrType['kind']): boolean {
  return type.kind === kind || (type.kind === 'union' && type.types.some((member) => member.kind === kind));
}
