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

/// Repeats text using JavaScript's numeric count rules rather than Rust's usize-only API.
pub fn repeat_text(value: &str, count: f64) -> String {
    if count.is_nan() || count == 0.0 {
        return String::new();
    }
    if count < 0.0 || count.is_infinite() {
        panic!("invalid string repeat count");
    }
    value.repeat(count.trunc() as usize)
}

/// The byte storage shared by every typed-array view over one source ArrayBuffer. A downstream
/// DataView implementation can use the same storage contract once that runtime capability lands.
#[derive(Clone)]
pub struct FlightArrayBuffer {
    storage: Rc<RefCell<Vec<u8>>>,
    identity: Rc<()>,
}

impl FlightArrayBuffer {
    pub fn new(byte_length: f64) -> Self {
        Self::from_bytes(vec![0; typed_array_length(byte_length)])
    }

    pub fn from_bytes(bytes: Vec<u8>) -> Self {
        Self {
            storage: Rc::new(RefCell::new(bytes)),
            identity: Rc::new(()),
        }
    }

    pub fn byte_length(&self) -> usize {
        self.storage.borrow().len()
    }
}

impl PartialEq for FlightArrayBuffer {
    fn eq(&self, other: &Self) -> bool {
        Rc::ptr_eq(&self.identity, &other.identity)
    }
}

impl fmt::Debug for FlightArrayBuffer {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("FlightArrayBuffer")
            .field("byte_length", &self.byte_length())
            .finish_non_exhaustive()
    }
}

/// A byte-oriented view over shared ArrayBuffer storage.
pub struct FlightDataView {
    buffer: FlightArrayBuffer,
    byte_offset: usize,
    byte_length: usize,
    identity: Rc<()>,
}

impl Clone for FlightDataView {
    fn clone(&self) -> Self {
        Self {
            buffer: self.buffer.clone(),
            byte_offset: self.byte_offset,
            byte_length: self.byte_length,
            identity: self.identity.clone(),
        }
    }
}

impl PartialEq for FlightDataView {
    fn eq(&self, other: &Self) -> bool {
        Rc::ptr_eq(&self.identity, &other.identity)
    }
}

impl fmt::Debug for FlightDataView {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("FlightDataView")
            .field("byte_offset", &self.byte_offset)
            .field("byte_length", &self.byte_length)
            .finish_non_exhaustive()
    }
}

impl FlightDataView {
    pub fn from_buffer(buffer: FlightArrayBuffer) -> Self {
        Self::from_buffer_offset(buffer, 0.0)
    }

    pub fn from_buffer_offset(buffer: FlightArrayBuffer, byte_offset: f64) -> Self {
        let buffer_length = buffer.byte_length();
        let byte_offset = data_view_offset(byte_offset, buffer_length);
        Self::from_buffer_parts(buffer, byte_offset, buffer_length - byte_offset)
    }

    pub fn from_buffer_range(
        buffer: FlightArrayBuffer,
        byte_offset: f64,
        byte_length: f64,
    ) -> Self {
        let buffer_length = buffer.byte_length();
        let byte_offset = data_view_offset(byte_offset, buffer_length);
        let byte_length = typed_array_length(byte_length);
        byte_offset
            .checked_add(byte_length)
            .filter(|end| *end <= buffer_length)
            .expect("DataView exceeds its buffer");
        Self::from_buffer_parts(buffer, byte_offset, byte_length)
    }

    pub fn buffer(&self) -> FlightArrayBuffer {
        self.buffer.clone()
    }

    pub fn byte_length(&self) -> usize {
        self.byte_length
    }

    pub fn byte_offset(&self) -> usize {
        self.byte_offset
    }

    pub fn get_float32(&self, byte_offset: f64, little_endian: Option<bool>) -> f64 {
        let bytes = self.read_bytes::<4>(byte_offset);
        if little_endian.unwrap_or(false) {
            f32::from_le_bytes(bytes) as f64
        } else {
            f32::from_be_bytes(bytes) as f64
        }
    }

    pub fn get_float64(&self, byte_offset: f64, little_endian: Option<bool>) -> f64 {
        let bytes = self.read_bytes::<8>(byte_offset);
        if little_endian.unwrap_or(false) {
            f64::from_le_bytes(bytes)
        } else {
            f64::from_be_bytes(bytes)
        }
    }

    pub fn get_int8(&self, byte_offset: f64) -> f64 {
        i8::from_ne_bytes(self.read_bytes::<1>(byte_offset)) as f64
    }

    pub fn get_int16(&self, byte_offset: f64, little_endian: Option<bool>) -> f64 {
        let bytes = self.read_bytes::<2>(byte_offset);
        if little_endian.unwrap_or(false) {
            i16::from_le_bytes(bytes) as f64
        } else {
            i16::from_be_bytes(bytes) as f64
        }
    }

    pub fn get_int32(&self, byte_offset: f64, little_endian: Option<bool>) -> f64 {
        let bytes = self.read_bytes::<4>(byte_offset);
        if little_endian.unwrap_or(false) {
            i32::from_le_bytes(bytes) as f64
        } else {
            i32::from_be_bytes(bytes) as f64
        }
    }

    pub fn get_uint8(&self, byte_offset: f64) -> f64 {
        u8::from_ne_bytes(self.read_bytes::<1>(byte_offset)) as f64
    }

    pub fn get_uint16(&self, byte_offset: f64, little_endian: Option<bool>) -> f64 {
        let bytes = self.read_bytes::<2>(byte_offset);
        if little_endian.unwrap_or(false) {
            u16::from_le_bytes(bytes) as f64
        } else {
            u16::from_be_bytes(bytes) as f64
        }
    }

    pub fn get_uint32(&self, byte_offset: f64, little_endian: Option<bool>) -> f64 {
        let bytes = self.read_bytes::<4>(byte_offset);
        if little_endian.unwrap_or(false) {
            u32::from_le_bytes(bytes) as f64
        } else {
            u32::from_be_bytes(bytes) as f64
        }
    }

    pub fn set_float32(&self, byte_offset: f64, value: f64, little_endian: Option<bool>) {
        let value = value as f32;
        self.write_bytes(
            byte_offset,
            if little_endian.unwrap_or(false) {
                value.to_le_bytes()
            } else {
                value.to_be_bytes()
            },
        );
    }

    pub fn set_float64(&self, byte_offset: f64, value: f64, little_endian: Option<bool>) {
        self.write_bytes(
            byte_offset,
            if little_endian.unwrap_or(false) {
                value.to_le_bytes()
            } else {
                value.to_be_bytes()
            },
        );
    }

    pub fn set_int8(&self, byte_offset: f64, value: f64) {
        self.write_bytes(
            byte_offset,
            (coerce_signed_integer(value, 8) as i8).to_ne_bytes(),
        );
    }

    pub fn set_int16(&self, byte_offset: f64, value: f64, little_endian: Option<bool>) {
        let value = coerce_signed_integer(value, 16) as i16;
        self.write_bytes(
            byte_offset,
            if little_endian.unwrap_or(false) {
                value.to_le_bytes()
            } else {
                value.to_be_bytes()
            },
        );
    }

    pub fn set_int32(&self, byte_offset: f64, value: f64, little_endian: Option<bool>) {
        let value = coerce_signed_integer(value, 32) as i32;
        self.write_bytes(
            byte_offset,
            if little_endian.unwrap_or(false) {
                value.to_le_bytes()
            } else {
                value.to_be_bytes()
            },
        );
    }

    pub fn set_uint8(&self, byte_offset: f64, value: f64) {
        self.write_bytes(
            byte_offset,
            (coerce_unsigned_integer(value, 8) as u8).to_ne_bytes(),
        );
    }

    pub fn set_uint16(&self, byte_offset: f64, value: f64, little_endian: Option<bool>) {
        let value = coerce_unsigned_integer(value, 16) as u16;
        self.write_bytes(
            byte_offset,
            if little_endian.unwrap_or(false) {
                value.to_le_bytes()
            } else {
                value.to_be_bytes()
            },
        );
    }

    pub fn set_uint32(&self, byte_offset: f64, value: f64, little_endian: Option<bool>) {
        let value = coerce_unsigned_integer(value, 32) as u32;
        self.write_bytes(
            byte_offset,
            if little_endian.unwrap_or(false) {
                value.to_le_bytes()
            } else {
                value.to_be_bytes()
            },
        );
    }

    fn from_buffer_parts(
        buffer: FlightArrayBuffer,
        byte_offset: usize,
        byte_length: usize,
    ) -> Self {
        Self {
            buffer,
            byte_offset,
            byte_length,
            identity: Rc::new(()),
        }
    }

    fn read_bytes<const WIDTH: usize>(&self, byte_offset: f64) -> [u8; WIDTH] {
        let start = self.absolute_range_start(byte_offset, WIDTH);
        self.buffer.storage.borrow()[start..start + WIDTH]
            .try_into()
            .expect("DataView access width")
    }

    fn write_bytes<const WIDTH: usize>(&self, byte_offset: f64, bytes: [u8; WIDTH]) {
        let start = self.absolute_range_start(byte_offset, WIDTH);
        self.buffer.storage.borrow_mut()[start..start + WIDTH].copy_from_slice(&bytes);
    }

    fn absolute_range_start(&self, byte_offset: f64, width: usize) -> usize {
        let relative = data_view_offset(byte_offset, self.byte_length);
        relative
            .checked_add(width)
            .filter(|end| *end <= self.byte_length)
            .expect("DataView access exceeds its view");
        self.byte_offset + relative
    }
}

/// Defines the byte width and JavaScript numeric conversion for one typed-array element kind.
pub trait FlightTypedArrayCodec: 'static {
    type Element: Copy + Default + 'static;

    const BYTES_PER_ELEMENT: usize;

    fn coerce(value: f64) -> Self::Element;
    fn decode(bytes: &[u8]) -> Self::Element;
    fn encode(value: Self::Element, bytes: &mut [u8]);
    fn to_number(value: Self::Element) -> f64;
}

/// A typed-array view. Cloning a value preserves its object identity; `subarray` creates a new
/// identity over shared storage, and `slice` creates both a new identity and new storage.
pub struct FlightTypedArray<C: FlightTypedArrayCodec> {
    buffer: FlightArrayBuffer,
    byte_offset: usize,
    length: usize,
    identity: Rc<()>,
    codec: PhantomData<C>,
}

impl<C: FlightTypedArrayCodec> Clone for FlightTypedArray<C> {
    fn clone(&self) -> Self {
        Self {
            buffer: self.buffer.clone(),
            byte_offset: self.byte_offset,
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
            .field("byte_offset", &self.byte_offset)
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

    pub fn from_buffer(buffer: FlightArrayBuffer) -> Self {
        Self::from_buffer_offset(buffer, 0.0)
    }

    pub fn from_buffer_offset(buffer: FlightArrayBuffer, byte_offset: f64) -> Self {
        let byte_offset = typed_array_byte_offset::<C>(byte_offset, buffer.byte_length());
        let remaining = buffer.byte_length() - byte_offset;
        if remaining % C::BYTES_PER_ELEMENT != 0 {
            panic!("typed-array buffer length is not aligned to its element width");
        }
        Self::from_buffer_parts(buffer, byte_offset, remaining / C::BYTES_PER_ELEMENT)
    }

    pub fn from_buffer_range(buffer: FlightArrayBuffer, byte_offset: f64, length: f64) -> Self {
        let byte_offset = typed_array_byte_offset::<C>(byte_offset, buffer.byte_length());
        let length = typed_array_length(length);
        let byte_length = length
            .checked_mul(C::BYTES_PER_ELEMENT)
            .expect("typed-array byte length overflow");
        byte_offset
            .checked_add(byte_length)
            .filter(|end| *end <= buffer.byte_length())
            .expect("typed-array view exceeds its buffer");
        Self::from_buffer_parts(buffer, byte_offset, length)
    }

    pub fn buffer(&self) -> FlightArrayBuffer {
        self.buffer.clone()
    }

    pub fn byte_length(&self) -> usize {
        self.length * C::BYTES_PER_ELEMENT
    }

    pub fn byte_offset(&self) -> usize {
        self.byte_offset
    }

    pub fn len(&self) -> usize {
        self.length
    }

    pub fn get_index(&self, index: f64) -> f64 {
        let Some(index) = typed_array_index(index, self.length) else {
            return f64::NAN;
        };
        C::to_number(self.read_element(index))
    }

    /// Stores the coerced element while returning the uncoerced assignment value.
    pub fn set_index(&self, index: f64, value: f64) -> f64 {
        if let Some(index) = typed_array_index(index, self.length) {
            self.write_element(index, C::coerce(value));
        }
        value
    }

    pub fn copy_from<S: FlightTypedArraySource<C>>(&self, source: S, offset: f64) {
        let offset = typed_array_copy_offset(offset, self.length);
        let values = source.into_typed_array_elements();
        offset
            .checked_add(values.len())
            .filter(|end| *end <= self.length)
            .expect("typed-array source exceeds its destination");
        for (index, value) in values.into_iter().enumerate() {
            self.write_element(offset + index, value);
        }
    }

    pub fn slice(&self, start: f64) -> Self {
        self.slice_range(start, self.length as f64)
    }

    pub fn slice_range(&self, start: f64, end: f64) -> Self {
        let start = typed_array_relative_index(start, self.length);
        let end = typed_array_relative_index(end, self.length).max(start);
        Self::from_elements((start..end).map(|index| self.read_element(index)).collect())
    }

    pub fn subarray(&self, start: f64) -> Self {
        self.subarray_range(start, self.length as f64)
    }

    pub fn subarray_range(&self, start: f64, end: f64) -> Self {
        let start = typed_array_relative_index(start, self.length);
        let end = typed_array_relative_index(end, self.length).max(start);
        Self::from_buffer_parts(
            self.buffer.clone(),
            self.byte_offset + start * C::BYTES_PER_ELEMENT,
            end - start,
        )
    }

    fn from_buffer_parts(buffer: FlightArrayBuffer, byte_offset: usize, length: usize) -> Self {
        Self {
            buffer,
            byte_offset,
            length,
            identity: Rc::new(()),
            codec: PhantomData,
        }
    }

    fn from_elements(elements: Vec<C::Element>) -> Self {
        let length = elements.len();
        let array = Self::from_buffer_parts(
            FlightArrayBuffer::new((length * C::BYTES_PER_ELEMENT) as f64),
            0,
            length,
        );
        for (index, value) in elements.into_iter().enumerate() {
            array.write_element(index, value);
        }
        array
    }

    fn read_element(&self, index: usize) -> C::Element {
        let start = self.byte_offset + index * C::BYTES_PER_ELEMENT;
        C::decode(&self.buffer.storage.borrow()[start..start + C::BYTES_PER_ELEMENT])
    }

    fn write_element(&self, index: usize, value: C::Element) {
        let start = self.byte_offset + index * C::BYTES_PER_ELEMENT;
        C::encode(
            value,
            &mut self.buffer.storage.borrow_mut()[start..start + C::BYTES_PER_ELEMENT],
        );
    }
}

impl<C: FlightTypedArrayCodec> IntoIterator for FlightTypedArray<C> {
    type Item = f64;
    type IntoIter = std::vec::IntoIter<f64>;

    fn into_iter(self) -> Self::IntoIter {
        (0..self.length)
            .map(|index| C::to_number(self.read_element(index)))
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

fn typed_array_byte_offset<C: FlightTypedArrayCodec>(value: f64, buffer_length: usize) -> usize {
    let offset = typed_array_length(value);
    if offset > buffer_length || offset % C::BYTES_PER_ELEMENT != 0 {
        panic!("typed-array byte offset is outside or misaligned with its buffer");
    }
    offset
}

fn data_view_offset(value: f64, byte_length: usize) -> usize {
    let offset = typed_array_length(value);
    if offset > byte_length {
        panic!("DataView byte offset exceeds its storage");
    }
    offset
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

            const BYTES_PER_ELEMENT: usize = std::mem::size_of::<$element>();

            fn coerce(value: f64) -> Self::Element {
                ($coerce)(value)
            }

            fn decode(bytes: &[u8]) -> Self::Element {
                <$element>::from_ne_bytes(bytes.try_into().expect("typed-array element width"))
            }

            fn encode(value: Self::Element, bytes: &mut [u8]) {
                bytes.copy_from_slice(&value.to_ne_bytes());
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
        round, FlightArrayBuffer, FlightDataView, FlightFloat32Array, FlightInt8Array,
        FlightUint16Array, FlightUint8Array, FlightUint8ClampedArray,
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

    #[test]
    fn buffer_backed_typed_array_views_share_byte_storage() {
        let buffer = FlightArrayBuffer::new(4.0);
        let whole = FlightUint8Array::from_buffer(buffer.clone());
        let middle = FlightUint8Array::from_buffer_range(buffer.clone(), 1.0, 2.0);

        middle.set_index(0.0, 9.0);
        middle.set_index(1.0, 8.0);

        assert_eq!(
            whole.into_iter().collect::<Vec<_>>(),
            vec![0.0, 9.0, 8.0, 0.0]
        );
        assert_eq!(middle.buffer(), buffer);
    }

    #[test]
    fn differently_typed_views_share_the_same_bytes() {
        let buffer = FlightArrayBuffer::new(2.0);
        let bytes = FlightUint8Array::from_buffer(buffer.clone());
        let words = FlightUint16Array::from_buffer(buffer);

        words.set_index(0.0, 258.0);

        assert_eq!(
            bytes.into_iter().collect::<Vec<_>>(),
            258_u16.to_ne_bytes().map(f64::from),
        );
    }

    #[test]
    fn data_view_reads_and_writes_shared_bytes_with_explicit_endianness() {
        let buffer = FlightArrayBuffer::new(8.0);
        let bytes = FlightUint8Array::from_buffer(buffer.clone());
        let view = FlightDataView::from_buffer_range(buffer.clone(), 1.0, 6.0);

        view.set_uint32(0.0, 0x01020304 as f64, None);
        view.set_uint16(4.0, 0x0506 as f64, Some(true));

        assert_eq!(
            bytes.into_iter().collect::<Vec<_>>(),
            vec![0.0, 1.0, 2.0, 3.0, 4.0, 6.0, 5.0, 0.0]
        );
        assert_eq!(view.get_uint32(0.0, None), 0x01020304 as f64);
        assert_eq!(view.get_uint16(4.0, Some(true)), 0x0506 as f64);
        assert_eq!(view.byte_offset(), 1);
        assert_eq!(view.byte_length(), 6);
        assert_eq!(view.buffer(), buffer);
        assert_ne!(view, FlightDataView::from_buffer(buffer.clone()));
        let tail = FlightDataView::from_buffer_offset(buffer, 2.0);
        assert_eq!(tail.byte_offset(), 2);
        assert_eq!(tail.byte_length(), 6);
    }

    #[test]
    fn data_view_preserves_float_and_signed_integer_values() {
        let view = FlightDataView::from_buffer(FlightArrayBuffer::new(16.0));

        view.set_float32(0.0, -1.5, None);
        view.set_float64(4.0, std::f64::consts::PI, Some(true));
        view.set_int8(12.0, 255.0);
        view.set_int16(13.0, -258.0, None);

        assert_eq!(view.get_float32(0.0, None), -1.5);
        assert_eq!(view.get_float64(4.0, Some(true)), std::f64::consts::PI);
        assert_eq!(view.get_int8(12.0), -1.0);
        assert_eq!(view.get_int16(13.0, None), -258.0);
    }

    #[test]
    #[should_panic(expected = "DataView access exceeds its view")]
    fn data_view_refuses_an_out_of_range_access() {
        let view = FlightDataView::from_buffer(FlightArrayBuffer::new(2.0));
        view.get_uint32(0.0, None);
    }
}
