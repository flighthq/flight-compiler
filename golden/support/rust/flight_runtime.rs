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
pub struct FlightTask<T: Clone>(T);

impl<T: Clone> FlightTask<T> {
    pub fn ready(value: T) -> Self {
        FlightTask(value)
    }
}

impl<T: Clone> Future for FlightTask<T> {
    type Output = T;
    fn poll(self: Pin<&mut Self>, _context: &mut Context<'_>) -> Poll<Self::Output> {
        Poll::Ready(self.0.clone())
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
