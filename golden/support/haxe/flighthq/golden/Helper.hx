package flighthq.golden;

// The sibling module the import and facade fixtures name. A golden fixture is one module by design,
// so its siblings are supplied here rather than emitted.
typedef Shape = { kind:String };
typedef Circle = { kind:String, radius:Float };

class Helper {
  public static function helper(value:Float):Float {
    return value;
  }
}
