package flighthq._internal;

abstract _UInt8Array(Array<Float>) {
  public var buffer(get, never):_ArrayBuffer;
  public inline function new(arg:Dynamic = null, byteOffset:Float = 0, length:Float = 0) { this = []; }
  private inline function get_buffer():_ArrayBuffer { return new _ArrayBuffer(this.length); }
  @:arrayAccess public inline function get(index:Float):Float { return this[Std.int(index)]; }
  @:arrayAccess public inline function set(index:Float, value:Float):Float { this[Std.int(index)] = value; return value; }
  public inline function subarray(begin:Float = 0, end:Float = 0):_UInt8Array { return new _UInt8Array(); }
  public inline function slice(begin:Float = 0, end:Float = 0):_UInt8Array { return new _UInt8Array(); }
}
