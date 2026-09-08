// The runtime contract's Rust surface, in the smallest shape that lets `rustc` check emitted source
// and a harness run it. The maintained implementation lives downstream; this stands in for it so the
// gates check the compiler, not the runtime.
//
// `FlightTask` is clonable and shared because the source language's `await` is: a promise settles
// once and every await of it sees that settlement. A plain future is consumed by the first `.await`,
// which is a different thing, so the contract's `first-call-wins` settlement is what makes the two
// agree.
use std::future::Future;
use std::pin::Pin;
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
    use super::round;

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
}
