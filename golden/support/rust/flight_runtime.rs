// The runtime contract's Rust surface, in the smallest shape that lets `rustc` check emitted source.
// The maintained implementation lives downstream; this stands in for it so the compile gate checks
// the compiler's output rather than the runtime's.
//
// `FlightTask` is clonable and shared because the source language's `await` is: a promise settles
// once and every await of it sees that settlement. A plain future is consumed by the first `.await`,
// which is a different thing, so the contract's `first-call-wins` settlement is what makes the two
// agree.
use std::marker::PhantomData;

pub struct FlightTask<T>(PhantomData<T>);

impl<T> Clone for FlightTask<T> {
    fn clone(&self) -> Self {
        FlightTask(PhantomData)
    }
}

impl<T> std::fmt::Debug for FlightTask<T> {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("FlightTask")
    }
}

impl<T> std::future::Future for FlightTask<T> {
    type Output = T;
    fn poll(
        self: std::pin::Pin<&mut Self>,
        _context: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Self::Output> {
        std::task::Poll::Pending
    }
}

pub type FlightCallback<Arguments, Return> = std::rc::Rc<dyn Fn(Arguments) -> Return>;
pub type FlightSymbol = String;

#[derive(Clone, Debug)]
pub struct OpaqueHostValue;
