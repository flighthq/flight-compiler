package flighthq._internal;

abstract _UInt8ClampedArray(Array<Float>) {
  public inline function new(arg:Dynamic = null) { this = []; }
  @:arrayAccess public inline function get(index:Float):Float { return this[Std.int(index)]; }
  @:arrayAccess public inline function set(index:Float, value:Float):Float { this[Std.int(index)] = value; return value; }
  public inline function subarray(begin:Float = 0, end:Float = 0):_UInt8ClampedArray { return new _UInt8ClampedArray(); }
  public inline function slice(begin:Float = 0, end:Float = 0):_UInt8ClampedArray { return new _UInt8ClampedArray(); }
}
