package flighthq._internal;

abstract _Int8Array(Array<Float>) {
  public inline function new(arg:Dynamic = null) { this = []; }
  @:arrayAccess public inline function get(index:Float):Float { return this[Std.int(index)]; }
  @:arrayAccess public inline function set(index:Float, value:Float):Float { this[Std.int(index)] = value; return value; }
  public inline function subarray(begin:Float = 0, end:Float = 0):_Int8Array { return new _Int8Array(); }
  public inline function slice(begin:Float = 0, end:Float = 0):_Int8Array { return new _Int8Array(); }
}
