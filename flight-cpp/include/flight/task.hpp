#pragma once

#include <concepts>
#include <coroutine>
#include <exception>
#include <memory>
#include <optional>
#include <stdexcept>
#include <type_traits>
#include <utility>
#include <vector>

namespace flight {

namespace detail {

class CoroutineOwner {
 public:
  explicit CoroutineOwner(std::coroutine_handle<> coroutine) noexcept : coroutine_(coroutine) {}

  CoroutineOwner(const CoroutineOwner&) = delete;
  CoroutineOwner& operator=(const CoroutineOwner&) = delete;

  ~CoroutineOwner() {
    if (coroutine_) coroutine_.destroy();
  }

  [[nodiscard]] std::coroutine_handle<> coroutine() const noexcept { return coroutine_; }

 private:
  std::coroutine_handle<> coroutine_;
};

[[noreturn]] inline void throw_task_error(std::exception_ptr error) {
  if (!error) throw std::invalid_argument("flight::Task::reject requires an exception");
  std::rethrow_exception(error);
}

template <typename Value>
[[noreturn]] Value unreachable_task_value() {
  throw std::logic_error("unreachable task result");
}

} // namespace detail

template <typename Value>
class Task {
 public:
  struct promise_type;

 private:
  using Handle = std::coroutine_handle<promise_type>;

 public:
  class Awaiter {
   public:
    explicit Awaiter(std::shared_ptr<detail::CoroutineOwner> owner) noexcept
        : owner_(std::move(owner)) {}

    [[nodiscard]] bool await_ready() const noexcept;
    bool await_suspend(std::coroutine_handle<> continuation);
    Value await_resume() const;

   private:
    std::shared_ptr<detail::CoroutineOwner> owner_;
  };

  Task(const Task&) noexcept = default;
  Task(Task&&) noexcept = default;
  Task& operator=(const Task&) noexcept = default;
  Task& operator=(Task&&) noexcept = default;

  [[nodiscard]] static Task<std::vector<Value>> join_all(std::vector<Task> tasks);
  [[nodiscard]] static Task ready(Value value);
  [[nodiscard]] static Task reject(std::exception_ptr error);

  [[nodiscard]] Value get() const;
  [[nodiscard]] bool is_ready() const noexcept;
  [[nodiscard]] Awaiter operator co_await() const& noexcept { return Awaiter(owner_); }
  [[nodiscard]] Awaiter operator co_await() && noexcept { return Awaiter(std::move(owner_)); }

 private:
  explicit Task(std::shared_ptr<detail::CoroutineOwner> owner) noexcept : owner_(std::move(owner)) {}

  [[nodiscard]] static Handle handle(const std::shared_ptr<detail::CoroutineOwner>& owner) noexcept {
    return Handle::from_address(owner->coroutine().address());
  }

  [[nodiscard]] static Value result(const std::shared_ptr<detail::CoroutineOwner>& owner);

  std::shared_ptr<detail::CoroutineOwner> owner_;
};

template <typename Value>
struct Task<Value>::promise_type {
  std::exception_ptr error;
  std::optional<Value> value;

  [[nodiscard]] Task get_return_object() {
    return Task(std::make_shared<detail::CoroutineOwner>(Handle::from_promise(*this)));
  }

  [[nodiscard]] constexpr std::suspend_never initial_suspend() const noexcept { return {}; }
  [[nodiscard]] constexpr std::suspend_always final_suspend() const noexcept { return {}; }

  template <typename Result>
    requires std::constructible_from<Value, Result&&>
  void return_value(Result&& result) noexcept(std::is_nothrow_constructible_v<Value, Result&&>) {
    value.emplace(std::forward<Result>(result));
  }

  void unhandled_exception() noexcept { error = std::current_exception(); }
};

template <typename Value>
bool Task<Value>::Awaiter::await_ready() const noexcept {
  return Task::handle(owner_).done();
}

template <typename Value>
bool Task<Value>::Awaiter::await_suspend(std::coroutine_handle<> continuation) {
  static_cast<void>(continuation);
  throw std::logic_error("pending flight::Task requires an executor");
}

template <typename Value>
Value Task<Value>::Awaiter::await_resume() const {
  return Task::result(owner_);
}

template <typename Value>
Task<std::vector<Value>> Task<Value>::join_all(std::vector<Task> tasks) {
  std::vector<Value> values;
  values.reserve(tasks.size());
  for (const auto& task : tasks) values.push_back(co_await task);
  co_return values;
}

template <typename Value>
Task<Value> Task<Value>::ready(Value value) {
  co_return value;
}

template <typename Value>
Task<Value> Task<Value>::reject(std::exception_ptr error) {
  detail::throw_task_error(error);
  co_return detail::unreachable_task_value<Value>();
}

template <typename Value>
Value Task<Value>::get() const {
  return result(owner_);
}

template <typename Value>
bool Task<Value>::is_ready() const noexcept {
  return handle(owner_).done();
}

template <typename Value>
Value Task<Value>::result(const std::shared_ptr<detail::CoroutineOwner>& owner) {
  const auto coroutine = handle(owner);
  if (!coroutine.done()) throw std::logic_error("flight::Task result is not ready");
  if (coroutine.promise().error) std::rethrow_exception(coroutine.promise().error);
  if (!coroutine.promise().value) throw std::logic_error("flight::Task completed without a value");
  return *coroutine.promise().value;
}

template <>
class Task<void> {
 public:
  struct promise_type;

 private:
  using Handle = std::coroutine_handle<promise_type>;

 public:
  class Awaiter {
   public:
    explicit Awaiter(std::shared_ptr<detail::CoroutineOwner> owner) noexcept
        : owner_(std::move(owner)) {}

    [[nodiscard]] bool await_ready() const noexcept;
    bool await_suspend(std::coroutine_handle<> continuation);
    void await_resume() const;

   private:
    std::shared_ptr<detail::CoroutineOwner> owner_;
  };

  Task(const Task&) noexcept = default;
  Task(Task&&) noexcept = default;
  Task& operator=(const Task&) noexcept = default;
  Task& operator=(Task&&) noexcept = default;

  [[nodiscard]] static Task join_all(std::vector<Task> tasks);
  [[nodiscard]] static Task ready();
  [[nodiscard]] static Task reject(std::exception_ptr error);

  void get() const;
  [[nodiscard]] bool is_ready() const noexcept;
  [[nodiscard]] Awaiter operator co_await() const& noexcept { return Awaiter(owner_); }
  [[nodiscard]] Awaiter operator co_await() && noexcept { return Awaiter(std::move(owner_)); }

 private:
  explicit Task(std::shared_ptr<detail::CoroutineOwner> owner) noexcept : owner_(std::move(owner)) {}

  [[nodiscard]] static Handle handle(const std::shared_ptr<detail::CoroutineOwner>& owner) noexcept;
  static void result(const std::shared_ptr<detail::CoroutineOwner>& owner);

  std::shared_ptr<detail::CoroutineOwner> owner_;
};

struct Task<void>::promise_type {
  std::exception_ptr error;

  [[nodiscard]] Task get_return_object() {
    return Task(std::make_shared<detail::CoroutineOwner>(Handle::from_promise(*this)));
  }

  [[nodiscard]] constexpr std::suspend_never initial_suspend() const noexcept { return {}; }
  [[nodiscard]] constexpr std::suspend_always final_suspend() const noexcept { return {}; }
  constexpr void return_void() const noexcept {}
  void unhandled_exception() noexcept { error = std::current_exception(); }
};

inline bool Task<void>::Awaiter::await_ready() const noexcept {
  return Task::handle(owner_).done();
}

inline bool Task<void>::Awaiter::await_suspend(std::coroutine_handle<> continuation) {
  static_cast<void>(continuation);
  throw std::logic_error("pending flight::Task requires an executor");
}

inline void Task<void>::Awaiter::await_resume() const {
  Task::result(owner_);
}

inline Task<void> Task<void>::join_all(std::vector<Task> tasks) {
  for (const auto& task : tasks) co_await task;
  co_return;
}

inline Task<void> Task<void>::ready() {
  co_return;
}

inline Task<void> Task<void>::reject(std::exception_ptr error) {
  detail::throw_task_error(error);
  co_return;
}

inline void Task<void>::get() const {
  result(owner_);
}

inline bool Task<void>::is_ready() const noexcept {
  return handle(owner_).done();
}

inline auto Task<void>::handle(const std::shared_ptr<detail::CoroutineOwner>& owner) noexcept -> Handle {
  return Handle::from_address(owner->coroutine().address());
}

inline void Task<void>::result(const std::shared_ptr<detail::CoroutineOwner>& owner) {
  const auto coroutine = handle(owner);
  if (!coroutine.done()) throw std::logic_error("flight::Task result is not ready");
  if (coroutine.promise().error) std::rethrow_exception(coroutine.promise().error);
}

} // namespace flight
