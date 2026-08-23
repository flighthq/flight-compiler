// The sibling module the import and facade fixtures name.
#[derive(Clone, Debug)]
pub struct Shape {
    pub kind: String,
}

#[derive(Clone, Debug)]
pub struct Circle {
    pub kind: String,
    pub radius: f64,
}

pub fn helper(value: f64) -> f64 {
    value
}
