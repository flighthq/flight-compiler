// The runtime contract's Rust surface, in the smallest shape that lets `rustc` check emitted source
// and a harness run it. The maintained implementation lives downstream; this stands in for it so the
// gates check the compiler, not the runtime.
//
// `FlightTask` is clonable and shared because the source language's `await` is: a promise settles
// once and every await of it sees that settlement. A plain future is consumed by the first `.await`,
// which is a different thing, so the contract's `first-call-wins` settlement is what makes the two
// agree.
use std::cell::RefCell;
use std::fmt;
use std::future::Future;
use std::marker::PhantomData;
use std::pin::Pin;
use std::rc::Rc;
use std::task::{Context, Poll, RawWaker, RawWakerVTable, Waker};

#[derive(Clone, Debug)]
pub struct FlightTask<T: Clone>(Result<T, String>);

impl<T: Clone> FlightTask<T> {
    pub fn ready(value: T) -> Self {
        FlightTask(Ok(value))
    }
    pub fn reject(error: impl Into<String>) -> Self {
        FlightTask(Err(error.into()))
    }
    pub fn settle(self) -> Result<T, String> {
        self.0
    }
}

impl<T: Clone> Future for FlightTask<T> {
    type Output = T;
    fn poll(self: Pin<&mut Self>, _context: &mut Context<'_>) -> Poll<Self::Output> {
        match &self.0 {
            Ok(value) => Poll::Ready(value.clone()),
            Err(e) => panic!("unhandled task rejection: {}", e),
        }
    }
}

/// Drives a future to completion on the calling thread. A settled task never yields, so no scheduler
/// is needed to observe the answer an emitted `async fn` produces.
pub fn block_on<F: Future>(future: F) -> F::Output {
    let waker = unsafe { Waker::from_raw(RawWaker::new(std::ptr::null(), &NOOP_WAKER_VTABLE)) };
    let mut context = Context::from_waker(&waker);
    let mut pinned = Box::pin(future);
    loop {
        if let Poll::Ready(value) = pinned.as_mut().poll(&mut context) {
            return value;
        }
    }
}

pub fn round(value: f64) -> f64 {
    if !value.is_finite() || value == 0.0 {
        return value;
    }
    if value < 0.0 && value >= -0.5 {
        return -0.0;
    }

    let lower = value.floor();
    if value - lower < 0.5 {
        lower
    } else {
        lower + 1.0
    }
}

/// Defines the storage and JavaScript numeric conversion for one typed-array element kind.
pub trait FlightTypedArrayCodec: 'static {
    type Element: Copy + Default + 'static;

    fn coerce(value: f64) -> Self::Element;
    fn to_number(value: Self::Element) -> f64;
}

/// A typed-array view. Cloning a value preserves its object identity; `subarray` creates a new
/// identity over shared storage, and `slice` creates both a new identity and new storage.
pub struct FlightTypedArray<C: FlightTypedArrayCodec> {
    storage: Rc<RefCell<Vec<C::Element>>>,
    offset: usize,
    length: usize,
    identity: Rc<()>,
    codec: PhantomData<C>,
}

impl<C: FlightTypedArrayCodec> Clone for FlightTypedArray<C> {
    fn clone(&self) -> Self {
        Self {
            storage: self.storage.clone(),
            offset: self.offset,
            length: self.length,
            identity: self.identity.clone(),
            codec: PhantomData,
        }
    }
}

impl<C: FlightTypedArrayCodec, D: FlightTypedArrayCodec> PartialEq<FlightTypedArray<D>>
    for FlightTypedArray<C>
{
    fn eq(&self, other: &FlightTypedArray<D>) -> bool {
        Rc::ptr_eq(&self.identity, &other.identity)
    }
}

impl<C: FlightTypedArrayCodec> fmt::Debug for FlightTypedArray<C> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("FlightTypedArray")
            .field("length", &self.length)
            .finish_non_exhaustive()
    }
}

/// Values accepted by a one-argument typed-array constructor and by `TypedArray.prototype.set`.
pub trait FlightTypedArraySource<C: FlightTypedArrayCodec> {
    fn into_typed_array_elements(self) -> Vec<C::Element>;
}

impl<C: FlightTypedArrayCodec> FlightTypedArraySource<C> for f64 {
    fn into_typed_array_elements(self) -> Vec<C::Element> {
        vec![C::coerce(0.0); typed_array_length(self)]
    }
}

impl<C: FlightTypedArrayCodec> FlightTypedArraySource<C> for Vec<f64> {
    fn into_typed_array_elements(self) -> Vec<C::Element> {
        self.into_iter().map(C::coerce).collect()
    }
}

impl<C: FlightTypedArrayCodec, D: FlightTypedArrayCodec> FlightTypedArraySource<C>
    for FlightTypedArray<D>
{
    fn into_typed_array_elements(self) -> Vec<C::Element> {
        self.into_iter().map(C::coerce).collect()
    }
}

impl<C: FlightTypedArrayCodec> FlightTypedArray<C> {
    pub fn empty() -> Self {
        Self::from_elements(Vec::new())
    }

    pub fn from_source<S: FlightTypedArraySource<C>>(source: S) -> Self {
        Self::from_elements(source.into_typed_array_elements())
    }

    pub fn len(&self) -> usize {
        self.length
    }

    pub fn get_index(&self, index: f64) -> f64 {
        let Some(index) = typed_array_index(index, self.length) else {
            return f64::NAN;
        };
        C::to_number(self.storage.borrow()[self.offset + index])
    }

    /// Stores the coerced element while returning the uncoerced assignment value.
    pub fn set_index(&self, index: f64, value: f64) -> f64 {
        if let Some(index) = typed_array_index(index, self.length) {
            self.storage.borrow_mut()[self.offset + index] = C::coerce(value);
        }
        value
    }

    pub fn copy_from<S: FlightTypedArraySource<C>>(&self, source: S, offset: f64) {
        let offset = typed_array_copy_offset(offset, self.length);
        let values = source.into_typed_array_elements();
        let end = offset
            .checked_add(values.len())
            .filter(|end| *end <= self.length)
            .expect("typed-array source exceeds its destination");
        self.storage.borrow_mut()[self.offset + offset..self.offset + end].copy_from_slice(&values);
    }

    pub fn slice(&self, start: f64) -> Self {
        self.slice_range(start, self.length as f64)
    }

    pub fn slice_range(&self, start: f64, end: f64) -> Self {
        let start = typed_array_relative_index(start, self.length);
        let end = typed_array_relative_index(end, self.length).max(start);
        let values = self.storage.borrow()[self.offset + start..self.offset + end].to_vec();
        Self::from_elements(values)
    }

    pub fn subarray(&self, start: f64) -> Self {
        self.subarray_range(start, self.length as f64)
    }

    pub fn subarray_range(&self, start: f64, end: f64) -> Self {
        let start = typed_array_relative_index(start, self.length);
        let end = typed_array_relative_index(end, self.length).max(start);
        Self {
            storage: self.storage.clone(),
            offset: self.offset + start,
            length: end - start,
            identity: Rc::new(()),
            codec: PhantomData,
        }
    }

    fn from_elements(elements: Vec<C::Element>) -> Self {
        let length = elements.len();
        Self {
            storage: Rc::new(RefCell::new(elements)),
            offset: 0,
            length,
            identity: Rc::new(()),
            codec: PhantomData,
        }
    }
}

impl<C: FlightTypedArrayCodec> IntoIterator for FlightTypedArray<C> {
    type Item = f64;
    type IntoIter = std::vec::IntoIter<f64>;

    fn into_iter(self) -> Self::IntoIter {
        let storage = self.storage.borrow();
        storage[self.offset..self.offset + self.length]
            .iter()
            .copied()
            .map(C::to_number)
            .collect::<Vec<_>>()
            .into_iter()
    }
}

fn typed_array_length(value: f64) -> usize {
    if !value.is_finite() || value < 0.0 {
        panic!("typed-array length must be a finite nonnegative number");
    }
    value.floor() as usize
}

fn typed_array_copy_offset(value: f64, length: usize) -> usize {
    let offset = typed_array_length(value);
    if offset > length {
        panic!("typed-array copy offset exceeds its destination");
    }
    offset
}

fn typed_array_index(value: f64, length: usize) -> Option<usize> {
    if !value.is_finite() || value < 0.0 || value.fract() != 0.0 {
        return None;
    }
    let index = value as usize;
    (index < length).then_some(index)
}

fn typed_array_relative_index(value: f64, length: usize) -> usize {
    if value.is_nan() {
        return 0;
    }
    if value == f64::NEG_INFINITY {
        return 0;
    }
    if value == f64::INFINITY {
        return length;
    }
    let integer = value.trunc();
    if integer < 0.0 {
        ((length as f64 + integer).max(0.0) as usize).min(length)
    } else {
        (integer as usize).min(length)
    }
}

fn coerce_unsigned_integer(value: f64, bits: u32) -> u64 {
    if !value.is_finite() || value == 0.0 {
        return 0;
    }
    value.trunc().rem_euclid(2_f64.powi(bits as i32)) as u64
}

fn coerce_signed_integer(value: f64, bits: u32) -> i64 {
    let unsigned = coerce_unsigned_integer(value, bits);
    let sign = 1_u64 << (bits - 1);
    if unsigned >= sign {
        (unsigned as i64) - ((1_u64 << bits) as i64)
    } else {
        unsigned as i64
    }
}

fn coerce_uint8_clamped(value: f64) -> u8 {
    if value.is_nan() || value <= 0.0 {
        return 0;
    }
    if value >= 255.0 {
        return 255;
    }
    let lower = value.floor();
    let fraction = value - lower;
    if fraction > 0.5 || (fraction == 0.5 && lower % 2.0 == 1.0) {
        (lower + 1.0) as u8
    } else {
        lower as u8
    }
}

macro_rules! define_flight_typed_array {
    ($codec:ident, $array:ident, $element:ty, $coerce:expr, $number:expr) => {
        pub struct $codec;

        impl FlightTypedArrayCodec for $codec {
            type Element = $element;

            fn coerce(value: f64) -> Self::Element {
                ($coerce)(value)
            }

            fn to_number(value: Self::Element) -> f64 {
                ($number)(value)
            }
        }

        pub type $array = FlightTypedArray<$codec>;
    };
}

define_flight_typed_array!(
    FlightFloat32ArrayCodec,
    FlightFloat32Array,
    f32,
    |value: f64| value as f32,
    |value: f32| value as f64
);
define_flight_typed_array!(
    FlightFloat64ArrayCodec,
    FlightFloat64Array,
    f64,
    |value: f64| value,
    |value: f64| value
);
define_flight_typed_array!(
    FlightInt8ArrayCodec,
    FlightInt8Array,
    i8,
    |value: f64| coerce_signed_integer(value, 8) as i8,
    |value: i8| value as f64
);
define_flight_typed_array!(
    FlightInt16ArrayCodec,
    FlightInt16Array,
    i16,
    |value: f64| coerce_signed_integer(value, 16) as i16,
    |value: i16| value as f64
);
define_flight_typed_array!(
    FlightInt32ArrayCodec,
    FlightInt32Array,
    i32,
    |value: f64| coerce_signed_integer(value, 32) as i32,
    |value: i32| value as f64
);
define_flight_typed_array!(
    FlightUint8ArrayCodec,
    FlightUint8Array,
    u8,
    |value: f64| coerce_unsigned_integer(value, 8) as u8,
    |value: u8| value as f64
);
define_flight_typed_array!(
    FlightUint8ClampedArrayCodec,
    FlightUint8ClampedArray,
    u8,
    coerce_uint8_clamped,
    |value: u8| value as f64
);
define_flight_typed_array!(
    FlightUint16ArrayCodec,
    FlightUint16Array,
    u16,
    |value: f64| coerce_unsigned_integer(value, 16) as u16,
    |value: u16| value as f64
);
define_flight_typed_array!(
    FlightUint32ArrayCodec,
    FlightUint32Array,
    u32,
    |value: f64| coerce_unsigned_integer(value, 32) as u32,
    |value: u32| value as f64
);

const NOOP_WAKER_VTABLE: RawWakerVTable = RawWakerVTable::new(
    |_| RawWaker::new(std::ptr::null(), &NOOP_WAKER_VTABLE),
    |_| {},
    |_| {},
    |_| {},
);

pub type FlightCallback<Arguments, Return> = std::rc::Rc<dyn Fn(Arguments) -> Return>;
pub type FlightSymbol = String;

#[derive(Clone, Debug)]
pub struct FlightDate(f64);

impl FlightDate {
    pub fn timestamp_millis(&self) -> f64 {
        self.0
    }
    pub fn year(&self) -> f64 {
        1970.0
    }
    pub fn to_iso_string(&self) -> String {
        "1970-01-01T00:00:00.000Z".to_owned()
    }
}

#[derive(Clone, Debug)]
pub struct OpaqueHostValue;

#[cfg(test)]
mod tests {
    use super::{
        round, FlightFloat32Array, FlightInt8Array, FlightUint8Array, FlightUint8ClampedArray,
    };

    #[test]
    fn round_matches_javascript_boundaries_and_special_values() {
        assert_eq!(round(3.5), 4.0);
        assert_eq!(round(-3.5), -3.0);
        assert_eq!(round(-3.5000000000000004), -4.0);
        assert_eq!(round(-3.4999999999999996), -3.0);
        assert!(round(-0.5).is_sign_negative());
        assert!(round(-0.1).is_sign_negative());
        assert!(round(-0.0).is_sign_negative());
        assert_eq!(round(f64::INFINITY), f64::INFINITY);
        assert_eq!(round(f64::NEG_INFINITY), f64::NEG_INFINITY);
        assert!(round(f64::NAN).is_nan());
    }

    #[test]
    fn typed_arrays_apply_element_specific_numeric_coercion() {
        let signed = FlightInt8Array::from_source(vec![130.0, -129.0, f64::NAN, f64::INFINITY]);
        assert_eq!(
            signed.into_iter().collect::<Vec<_>>(),
            vec![-126.0, 127.0, 0.0, 0.0]
        );

        let clamped = FlightUint8ClampedArray::from_source(vec![0.5, 1.5, 2.5, 3.5, 254.5, 255.5]);
        assert_eq!(
            clamped.into_iter().collect::<Vec<_>>(),
            vec![0.0, 2.0, 2.0, 4.0, 254.0, 255.0]
        );

        let narrowed = FlightFloat32Array::from_source(vec![3.5e38, -3.5e38]);
        let values = narrowed.into_iter().collect::<Vec<_>>();
        assert_eq!(values[0], f64::INFINITY);
        assert_eq!(values[1], f64::NEG_INFINITY);
    }

    #[test]
    fn typed_array_views_share_storage_but_keep_object_identity() {
        let source = FlightUint8Array::from_source(vec![1.0, 2.0, 3.0, 4.0]);
        let alias = source.subarray_range(1.0, 3.0);
        let copy = source.slice_range(1.0, 3.0);

        assert_ne!(source, alias);
        assert_ne!(source, copy);
        assert_eq!(source, source.clone());
        alias.set_index(0.0, 9.0);
        source.set_index(2.0, 8.0);

        assert_eq!(
            source.into_iter().collect::<Vec<_>>(),
            vec![1.0, 9.0, 8.0, 4.0]
        );
        assert_eq!(copy.into_iter().collect::<Vec<_>>(), vec![2.0, 3.0]);
    }
}
