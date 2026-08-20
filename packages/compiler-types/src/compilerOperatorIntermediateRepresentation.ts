export type IrAssignmentOperator =
  | '%='
  | '&&='
  | '&='
  | '**='
  | '*='
  | '+='
  | '-='
  | '/='
  | '<<='
  | '='
  | '>>='
  | '>>>='
  | '??='
  | '^='
  | '|='
  | '||=';

export type IrBinaryOperator =
  | '%'
  | '&'
  | '&&'
  | '*'
  | '**'
  | '+'
  | ','
  | '-'
  | '/'
  | '<'
  | '<<'
  | '<='
  | '!='
  | '!=='
  | '=='
  | '==='
  | '>'
  | '>='
  | '>>'
  | '>>>'
  | '??'
  | '^'
  | 'in'
  | 'instanceof'
  | '|'
  | '||';

export type IrPostfixUnaryOperator = '++' | '--';

export type IrPrefixUnaryOperator = '!' | '+' | '++' | '-' | '--' | 'delete' | 'typeof' | 'void' | '~';
