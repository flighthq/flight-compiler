#pragma once

#include <chrono>
#include <concepts>
#include <condition_variable>
#include <coroutine>
#include <cstddef>
#include <exception>
#include <functional>
#include <memory>
#include <mutex>
#include <optional>
#include <stdexcept>
#include <type_traits>
#include <utility>
#include <vector>

#include <flight/array.hpp>
#include <flight/executor.hpp>
#include <flight/rejection.hpp>

namespace flight {

enum class TaskStatus {
  pending,
  fulfilled,
  rejected,
};

template <typename Value>
struct TaskSettlement {
  TaskStatus status;
  std::optional<Value> value;
  std::optional<Rejection> rejection;
};

template <>
struct TaskSettlement<void> {
  TaskStatus status;
  std::optional<Rejection> rejection;
};

template <typename Value>
class Task;

namespace detail {

class CoroutineOwner {
 public:
  explicit CoroutineOwner(std::coroutine_handle<> coroutine) noexcept : coroutine_(coroutine) {}

  CoroutineOwner(const CoroutineOwner&) = delete;
  CoroutineOwner& operator=(const CoroutineOwner&) = delete;

  ~CoroutineOwner() {
    if (coroutine_) coroutine_.destroy();
  }

 private:
  std::coroutine_handle<> coroutine_;
};

template <typename Value>
class TaskState {
 public:
  bool fulfill(Value value) {
    return complete(TaskStatus::fulfilled, std::optional<Value>(std::move(value)), std::nullopt, false);
  }

  bool fulfill_adopted(Value value) {
    return complete(TaskStatus::fulfilled, std::optional<Value>(std::move(value)), std::nullopt, true);
  }

  bool reject(Rejection rejection) {
    return complete(TaskStatus::rejected, std::nullopt,
                    std::optional<Rejection>(std::move(rejection)), false);
  }

  bool reject_adopted(Rejection rejection) {
    return complete(TaskStatus::rejected, std::nullopt,
                    std::optional<Rejection>(std::move(rejection)), true);
  }

  bool start_adoption() {
    std::lock_guard lock(mutex_);
    if (status_ != TaskStatus::pending || adopting_) return false;
    adopting_ = true;
    return true;
  }

  [[nodiscard]] Rejection rejection() const {
    std::lock_guard lock(mutex_);
    if (status_ != TaskStatus::rejected || !rejection_) {
      throw std::logic_error("flight::Task is not rejected");
    }
    return *rejection_;
  }

  [[nodiscard]] Value result() const {
    std::lock_guard lock(mutex_);
    if (status_ == TaskStatus::rejected && rejection_) rejection_->rethrow();
    if (status_ != TaskStatus::fulfilled || !value_) {
      throw std::logic_error("flight::Task result is not ready");
    }
    return *value_;
  }

  [[nodiscard]] TaskSettlement<Value> settlement() const {
    std::lock_guard lock(mutex_);
    return {.status = status_, .value = value_, .rejection = rejection_};
  }

  [[nodiscard]] TaskStatus status() const {
    std::lock_guard lock(mutex_);
    return status_;
  }

  void subscribe(std::function<void()> continuation) {
    bool invoke = false;
    {
      std::lock_guard lock(mutex_);
      if (status_ == TaskStatus::pending) {
        continuations_.push_back(std::move(continuation));
      } else {
        invoke = true;
      }
    }
    if (invoke) continuation();
  }

  void wait_briefly() const {
    std::unique_lock lock(mutex_);
    condition_.wait_for(lock, std::chrono::milliseconds(1), [&] { return status_ != TaskStatus::pending; });
  }

 private:
  bool complete(TaskStatus status, std::optional<Value> value,
                std::optional<Rejection> rejection, bool adopted) {
    std::vector<std::function<void()>> continuations;
    {
      std::lock_guard lock(mutex_);
      if (status_ != TaskStatus::pending || adopting_ != adopted) return false;
      status_ = status;
      value_ = std::move(value);
      rejection_ = std::move(rejection);
      continuations = std::move(continuations_);
    }
    condition_.notify_all();
    for (auto& continuation : continuations) continuation();
    return true;
  }

  mutable std::condition_variable condition_;
  bool adopting_ = false;
  std::vector<std::function<void()>> continuations_;
  std::optional<Rejection> rejection_;
  mutable std::mutex mutex_;
  TaskStatus status_ = TaskStatus::pending;
  std::optional<Value> value_;
};

template <>
class TaskState<void> {
 public:
  bool fulfill() { return complete(TaskStatus::fulfilled, std::nullopt, false); }

  bool fulfill_adopted() { return complete(TaskStatus::fulfilled, std::nullopt, true); }

  bool reject(Rejection rejection) {
    return complete(TaskStatus::rejected, std::optional<Rejection>(std::move(rejection)), false);
  }

  bool reject_adopted(Rejection rejection) {
    return complete(TaskStatus::rejected, std::optional<Rejection>(std::move(rejection)), true);
  }

  bool start_adoption() {
    std::lock_guard lock(mutex_);
    if (status_ != TaskStatus::pending || adopting_) return false;
    adopting_ = true;
    return true;
  }

  [[nodiscard]] Rejection rejection() const {
    std::lock_guard lock(mutex_);
    if (status_ != TaskStatus::rejected || !rejection_) {
      throw std::logic_error("flight::Task is not rejected");
    }
    return *rejection_;
  }

  void result() const {
    std::lock_guard lock(mutex_);
    if (status_ == TaskStatus::rejected && rejection_) rejection_->rethrow();
    if (status_ != TaskStatus::fulfilled) throw std::logic_error("flight::Task result is not ready");
  }

  [[nodiscard]] TaskSettlement<void> settlement() const {
    std::lock_guard lock(mutex_);
    return {.status = status_, .rejection = rejection_};
  }

  [[nodiscard]] TaskStatus status() const {
    std::lock_guard lock(mutex_);
    return status_;
  }

  void subscribe(std::function<void()> continuation) {
    bool invoke = false;
    {
      std::lock_guard lock(mutex_);
      if (status_ == TaskStatus::pending) {
        continuations_.push_back(std::move(continuation));
      } else {
        invoke = true;
      }
    }
    if (invoke) continuation();
  }

  void wait_briefly() const {
    std::unique_lock lock(mutex_);
    condition_.wait_for(lock, std::chrono::milliseconds(1), [&] { return status_ != TaskStatus::pending; });
  }

 private:
  bool complete(TaskStatus status, std::optional<Rejection> rejection, bool adopted) {
    std::vector<std::function<void()>> continuations;
    {
      std::lock_guard lock(mutex_);
      if (status_ != TaskStatus::pending || adopting_ != adopted) return false;
      status_ = status;
      rejection_ = std::move(rejection);
      continuations = std::move(continuations_);
    }
    condition_.notify_all();
    for (auto& continuation : continuations) continuation();
    return true;
  }

  mutable std::condition_variable condition_;
  bool adopting_ = false;
  std::vector<std::function<void()>> continuations_;
  std::optional<Rejection> rejection_;
  mutable std::mutex mutex_;
  TaskStatus status_ = TaskStatus::pending;
};

template <typename Result>
struct TaskResult {
  static constexpr bool is_task = false;
  using Type = std::remove_cvref_t<Result>;
};

template <typename Value>
struct TaskResult<Task<Value>> {
  static constexpr bool is_task = true;
  using Type = Value;
};

template <typename Result>
using TaskResultValue = typename TaskResult<std::remove_cvref_t<Result>>::Type;

template <typename Result>
inline constexpr bool is_task_result = TaskResult<std::remove_cvref_t<Result>>::is_task;

template <typename Value>
class TaskPromiseResult {
 public:
  explicit TaskPromiseResult(std::shared_ptr<TaskState<Value>> state) : state_(std::move(state)) {}

  template <typename Result>
    requires std::constructible_from<Value, Result&&>
  void return_value(Result&& result) {
    state_->fulfill(Value(std::forward<Result>(result)));
  }

 protected:
  std::shared_ptr<TaskState<Value>> state_;
};

template <>
class TaskPromiseResult<void> {
 public:
  explicit TaskPromiseResult(std::shared_ptr<TaskState<void>> state) : state_(std::move(state)) {}
  void return_void() { state_->fulfill(); }

 protected:
  std::shared_ptr<TaskState<void>> state_;
};

} // namespace detail

template <typename Value>
class Task {
 public:
  struct promise_type;

  class Rejecter {
   public:
    void operator()(Rejection rejection) const { state_->reject(std::move(rejection)); }

    void operator()(std::exception_ptr exception) const {
      state_->reject(Rejection::from_exception(std::move(exception)));
    }

    template <typename Reason>
      requires(!std::same_as<std::remove_cvref_t<Reason>, Rejection> &&
               !std::same_as<std::remove_cvref_t<Reason>, std::exception_ptr>)
    void operator()(Reason&& reason) const {
      state_->reject(Rejection::from_value(std::forward<Reason>(reason)));
    }

   private:
    friend class Task;
    explicit Rejecter(std::shared_ptr<detail::TaskState<Value>> state) : state_(std::move(state)) {}
    std::shared_ptr<detail::TaskState<Value>> state_;
  };

  class Resolver {
   public:
    template <typename Resolved>
      requires(!std::is_void_v<Value> && std::constructible_from<Value, Resolved&&>)
    void operator()(Resolved&& value) const {
      state_->fulfill(Value(std::forward<Resolved>(value)));
    }

    void operator()() const requires std::is_void_v<Value> { state_->fulfill(); }
    void operator()(Task task) const;

   private:
    friend class Task;
    explicit Resolver(std::shared_ptr<detail::TaskState<Value>> state) : state_(std::move(state)) {}
    std::shared_ptr<detail::TaskState<Value>> state_;
  };

  class Awaiter {
   public:
    Awaiter(std::shared_ptr<detail::TaskState<Value>> state,
            std::shared_ptr<detail::CoroutineOwner> source_owner) noexcept
        : source_owner_(std::move(source_owner)), state_(std::move(state)) {}

    [[nodiscard]] constexpr bool await_ready() const noexcept { return false; }

    template <typename Promise>
      requires requires(Promise& promise) {
        { promise.flight_executor() } -> std::same_as<std::shared_ptr<Executor>>;
        { promise.flight_owner() } -> std::same_as<std::shared_ptr<detail::CoroutineOwner>>;
      }
    void await_suspend(std::coroutine_handle<Promise> continuation) {
      auto owner = continuation.promise().flight_owner();
      if (!owner) throw std::logic_error("flight::Task continuation has no coroutine owner");
      auto executor = continuation.promise().flight_executor();
      state_->subscribe([continuation, executor = std::move(executor), owner = std::move(owner)] {
        Task::post(executor, [continuation, owner] {
          static_cast<void>(owner);
          if (!continuation.done()) continuation.resume();
        });
      });
    }

    Value await_resume() const {
      if constexpr (std::is_void_v<Value>) {
        state_->result();
      } else {
        return state_->result();
      }
    }

   private:
    std::shared_ptr<detail::CoroutineOwner> source_owner_;
    std::shared_ptr<detail::TaskState<Value>> state_;
  };

  Task(const Task&) noexcept = default;
  Task(Task&&) noexcept = default;
  Task& operator=(const Task&) noexcept = default;
  Task& operator=(Task&&) noexcept = default;

  template <typename Initializer>
  [[nodiscard]] static Task create(Initializer&& initializer,
                                   std::shared_ptr<Executor> executor = current_executor()) {
    auto task = pending(std::move(executor));
    try {
      ExecutorScope scope(task.executor_);
      if constexpr (std::invocable<Initializer&&, Resolver, Rejecter>) {
        std::invoke(std::forward<Initializer>(initializer), Resolver(task.state_), Rejecter(task.state_));
      } else {
        static_assert(std::invocable<Initializer&&, Resolver>,
                      "flight::Task initializer must accept resolve and optionally reject");
        std::invoke(std::forward<Initializer>(initializer), Resolver(task.state_));
      }
    } catch (...) {
      task.state_->reject(Rejection::from_exception(std::current_exception()));
    }
    return task;
  }

  template <typename Resolved = Value>
    requires(!std::is_void_v<Value> && std::constructible_from<Value, Resolved&&>)
  [[nodiscard]] static Task ready(Resolved&& value,
                                  std::shared_ptr<Executor> executor = current_executor()) {
    auto task = pending(std::move(executor));
    task.state_->fulfill(Value(std::forward<Resolved>(value)));
    return task;
  }

  [[nodiscard]] static Task ready(std::shared_ptr<Executor> executor = current_executor())
    requires std::is_void_v<Value>
  {
    auto task = pending(std::move(executor));
    task.state_->fulfill();
    return task;
  }

  [[nodiscard]] static Task resolve(Task task) { return task; }

  template <typename Resolved = Value>
    requires(!std::is_void_v<Value> && std::constructible_from<Value, Resolved&&>)
  [[nodiscard]] static Task resolve(Resolved&& value,
                                    std::shared_ptr<Executor> executor = current_executor()) {
    return ready(std::forward<Resolved>(value), std::move(executor));
  }

  [[nodiscard]] static Task resolve(std::shared_ptr<Executor> executor = current_executor())
    requires std::is_void_v<Value>
  {
    return ready(std::move(executor));
  }

  [[nodiscard]] static Task reject(Rejection rejection,
                                   std::shared_ptr<Executor> executor = current_executor()) {
    auto task = pending(std::move(executor));
    task.state_->reject(std::move(rejection));
    return task;
  }

  [[nodiscard]] static Task reject(std::exception_ptr exception,
                                   std::shared_ptr<Executor> executor = current_executor()) {
    return reject(Rejection::from_exception(std::move(exception)), std::move(executor));
  }

  template <typename Reason>
    requires(!std::same_as<std::remove_cvref_t<Reason>, Rejection> &&
             !std::same_as<std::remove_cvref_t<Reason>, std::exception_ptr>)
  [[nodiscard]] static Task reject(Reason&& reason,
                                   std::shared_ptr<Executor> executor = current_executor()) {
    return reject(Rejection::from_value(std::forward<Reason>(reason)), std::move(executor));
  }

  template <typename Joined = Value>
    requires(!std::is_void_v<Value> && std::same_as<Joined, Value>)
  [[nodiscard]] static Task<std::vector<Joined>> join_all(
      std::vector<Task> tasks, std::shared_ptr<Executor> executor = current_executor()) {
    auto output = Task<std::vector<Joined>>::pending(std::move(executor));
    if (tasks.empty()) {
      output.state_->fulfill({});
      return output;
    }

    struct JoinState {
      std::mutex mutex;
      std::size_t remaining;
      bool settled = false;
      std::vector<std::optional<Joined>> values;
    };
    auto join = std::make_shared<JoinState>();
    join->remaining = tasks.size();
    join->values.resize(tasks.size());
    for (std::size_t index = 0; index < tasks.size(); ++index) {
      auto source = tasks[index];
      source.state_->subscribe([source, output_state = output.state_, executor = output.executor_, join, index] {
        post(executor, [source, output_state, join, index] {
          if (source.status() == TaskStatus::rejected) {
            bool reject = false;
            {
              std::lock_guard lock(join->mutex);
              if (!join->settled) {
                join->settled = true;
                reject = true;
              }
            }
            if (reject) output_state->reject(source.state_->rejection());
            return;
          }

          std::optional<std::vector<Joined>> values;
          {
            std::lock_guard lock(join->mutex);
            if (join->settled) return;
            join->values[index] = source.state_->result();
            --join->remaining;
            if (join->remaining == 0) {
              join->settled = true;
              values.emplace();
              values->reserve(join->values.size());
              for (auto& value : join->values) values->push_back(std::move(*value));
            }
          }
          if (values) output_state->fulfill(std::move(*values));
        });
      });
    }
    return output;
  }

  [[nodiscard]] static Task join_all(std::vector<Task> tasks,
                                     std::shared_ptr<Executor> executor = current_executor())
    requires std::is_void_v<Value>
  {
    auto output = pending(std::move(executor));
    if (tasks.empty()) {
      output.state_->fulfill();
      return output;
    }

    struct JoinState {
      std::mutex mutex;
      std::size_t remaining;
      bool settled = false;
    };
    auto join = std::make_shared<JoinState>();
    join->remaining = tasks.size();
    for (const auto& source : tasks) {
      source.state_->subscribe([source, output_state = output.state_, executor = output.executor_, join] {
        post(executor, [source, output_state, join] {
          if (source.status() == TaskStatus::rejected) {
            bool reject = false;
            {
              std::lock_guard lock(join->mutex);
              if (!join->settled) {
                join->settled = true;
                reject = true;
              }
            }
            if (reject) output_state->reject(source.state_->rejection());
            return;
          }

          bool fulfill = false;
          {
            std::lock_guard lock(join->mutex);
            if (join->settled) return;
            --join->remaining;
            if (join->remaining == 0) {
              join->settled = true;
              fulfill = true;
            }
          }
          if (fulfill) output_state->fulfill();
        });
      });
    }
    return output;
  }

  template <typename Joined = Value>
    requires(!std::is_void_v<Value> && std::same_as<Joined, Value>)
  [[nodiscard]] static Task<std::vector<Joined>> all(
      std::vector<Task> tasks, std::shared_ptr<Executor> executor = current_executor()) {
    return join_all(std::move(tasks), std::move(executor));
  }

  [[nodiscard]] static Task all(std::vector<Task> tasks,
                                std::shared_ptr<Executor> executor = current_executor())
    requires std::is_void_v<Value>
  {
    return join_all(std::move(tasks), std::move(executor));
  }

  template <typename Function>
    requires(!std::is_void_v<Value> && std::copy_constructible<std::remove_cvref_t<Function>>)
  [[nodiscard]] auto then(Function function) const
      -> Task<detail::TaskResultValue<std::invoke_result_t<Function&, Value>>> {
    using Output = detail::TaskResultValue<std::invoke_result_t<Function&, Value>>;
    auto output = Task<Output>::pending(executor_);
    auto source = *this;
    state_->subscribe([source, output_state = output.state_, executor = executor_, function = std::move(function)]() mutable {
      post(executor, [source, output_state, function = std::move(function)]() mutable {
        if (source.status() == TaskStatus::rejected) {
          output_state->reject(source.state_->rejection());
          return;
        }
        settle_invocation<Output>(output_state, [&] { return std::invoke(function, source.state_->result()); });
      });
    });
    return output;
  }

  template <typename Function>
    requires(std::is_void_v<Value> && std::copy_constructible<std::remove_cvref_t<Function>>)
  [[nodiscard]] auto then(Function function) const
      -> Task<detail::TaskResultValue<std::invoke_result_t<Function&>>> {
    using Output = detail::TaskResultValue<std::invoke_result_t<Function&>>;
    auto output = Task<Output>::pending(executor_);
    auto source = *this;
    state_->subscribe([source, output_state = output.state_, executor = executor_, function = std::move(function)]() mutable {
      post(executor, [source, output_state, function = std::move(function)]() mutable {
        if (source.status() == TaskStatus::rejected) {
          output_state->reject(source.state_->rejection());
          return;
        }
        source.state_->result();
        settle_invocation<Output>(output_state, [&] { return std::invoke(function); });
      });
    });
    return output;
  }

  template <typename Function>
    requires std::copy_constructible<std::remove_cvref_t<Function>>
  [[nodiscard]] Task catch_error(Function function) const {
    using Result = std::invoke_result_t<Function&, const Rejection&>;
    static_assert(std::same_as<detail::TaskResultValue<Result>, Value>,
                  "a task rejection handler must preserve the task value type");
    auto output = pending(executor_);
    auto source = *this;
    state_->subscribe([source, output_state = output.state_, executor = executor_, function = std::move(function)]() mutable {
      post(executor, [source, output_state, function = std::move(function)]() mutable {
        if (source.status() == TaskStatus::fulfilled) {
          source.copy_settlement_to(output_state);
          return;
        }
        const auto rejection = source.state_->rejection();
        settle_invocation<Value>(output_state, [&] { return std::invoke(function, rejection); });
      });
    });
    return output;
  }

  template <typename Function>
    requires std::copy_constructible<std::remove_cvref_t<Function>>
  [[nodiscard]] Task finally(Function function) const {
    using Result = std::invoke_result_t<Function&>;
    auto output = pending(executor_);
    auto source = *this;
    state_->subscribe([source, output_state = output.state_, executor = executor_, function = std::move(function)]() mutable {
      post(executor, [source, output_state, executor, function = std::move(function)]() mutable {
        try {
          if constexpr (detail::is_task_result<Result>) {
            auto cleanup = std::invoke(function);
            cleanup.state_->subscribe([cleanup, source, output_state, executor] {
              post(executor, [cleanup, source, output_state] {
                if (cleanup.status() == TaskStatus::rejected) {
                  output_state->reject(cleanup.state_->rejection());
                } else {
                  source.copy_settlement_to(output_state);
                }
              });
            });
          } else {
            if constexpr (std::is_void_v<Result>) {
              std::invoke(function);
            } else {
              static_cast<void>(std::invoke(function));
            }
            source.copy_settlement_to(output_state);
          }
        } catch (...) {
          output_state->reject(Rejection::from_exception(std::current_exception()));
        }
      });
    });
    return output;
  }

  Value get() const {
    while (status() == TaskStatus::pending) {
      if (executor_->run_one()) continue;
      state_->wait_briefly();
    }
    if constexpr (std::is_void_v<Value>) {
      state_->result();
    } else {
      return state_->result();
    }
  }

  [[nodiscard]] std::shared_ptr<Executor> executor() const noexcept { return executor_; }
  [[nodiscard]] bool is_ready() const { return status() != TaskStatus::pending; }
  [[nodiscard]] TaskSettlement<Value> settle() const {
    try {
      if constexpr (std::is_void_v<Value>) {
        get();
      } else {
        static_cast<void>(get());
      }
    } catch (...) {
    }
    return state_->settlement();
  }
  [[nodiscard]] TaskStatus status() const { return state_->status(); }

  [[nodiscard]] Awaiter operator co_await() const& noexcept { return Awaiter(state_, owner_); }
  [[nodiscard]] Awaiter operator co_await() && noexcept { return Awaiter(state_, std::move(owner_)); }

 private:
  template <typename>
  friend class Task;

  Task(std::shared_ptr<detail::TaskState<Value>> state, std::shared_ptr<Executor> executor,
       std::shared_ptr<detail::CoroutineOwner> owner = {})
      : executor_(std::move(executor)), owner_(std::move(owner)), state_(std::move(state)) {
    if (!executor_) throw std::invalid_argument("flight::Task requires an executor");
  }

  [[nodiscard]] static Task pending(std::shared_ptr<Executor> executor) {
    return Task(std::make_shared<detail::TaskState<Value>>(), std::move(executor));
  }

  static void post(const std::shared_ptr<Executor>& executor, std::function<void()> operation) {
    executor->post([executor, operation = std::move(operation)]() mutable {
      ExecutorScope scope(executor);
      operation();
    });
  }

  void copy_settlement_to(const std::shared_ptr<detail::TaskState<Value>>& output) const {
    if (status() == TaskStatus::rejected) {
      output->reject(state_->rejection());
    } else if constexpr (std::is_void_v<Value>) {
      state_->result();
      output->fulfill();
    } else {
      output->fulfill(state_->result());
    }
  }

  void forward_to(const std::shared_ptr<detail::TaskState<Value>>& output) const {
    if (state_ == output) {
      output->reject(Rejection::from_exception(
          std::make_exception_ptr(std::logic_error("flight::Task cannot resolve itself"))));
      return;
    }
    if (!output->start_adoption()) return;
    auto source = *this;
    state_->subscribe([source, output] {
      if (source.status() == TaskStatus::rejected) {
        output->reject_adopted(source.state_->rejection());
      } else if constexpr (std::is_void_v<Value>) {
        source.state_->result();
        output->fulfill_adopted();
      } else {
        output->fulfill_adopted(source.state_->result());
      }
    });
  }

  template <typename Output, typename Invocation>
  static void settle_invocation(const std::shared_ptr<detail::TaskState<Output>>& output,
                                Invocation&& invocation) {
    using Result = std::invoke_result_t<Invocation&>;
    try {
      if constexpr (detail::is_task_result<Result>) {
        auto task = std::invoke(invocation);
        task.forward_to(output);
      } else if constexpr (std::is_void_v<Result>) {
        std::invoke(invocation);
        output->fulfill();
      } else {
        output->fulfill(Output(std::invoke(invocation)));
      }
    } catch (...) {
      output->reject(Rejection::from_exception(std::current_exception()));
    }
  }

  std::shared_ptr<Executor> executor_;
  std::shared_ptr<detail::CoroutineOwner> owner_;
  std::shared_ptr<detail::TaskState<Value>> state_;
};

template <typename Value>
void Task<Value>::Resolver::operator()(Task task) const {
  task.forward_to(state_);
}

template <typename Value>
struct Task<Value>::promise_type : detail::TaskPromiseResult<Value> {
  promise_type()
      : detail::TaskPromiseResult<Value>(std::make_shared<detail::TaskState<Value>>()),
        executor_(current_executor()) {}

  [[nodiscard]] Task get_return_object() {
    auto owner = std::make_shared<detail::CoroutineOwner>(
        std::coroutine_handle<promise_type>::from_promise(*this));
    owner_ = owner;
    return Task(this->state_, executor_, std::move(owner));
  }

  [[nodiscard]] constexpr std::suspend_never initial_suspend() const noexcept { return {}; }
  [[nodiscard]] constexpr std::suspend_always final_suspend() const noexcept { return {}; }

  [[nodiscard]] std::shared_ptr<Executor> flight_executor() const { return executor_; }
  [[nodiscard]] std::shared_ptr<detail::CoroutineOwner> flight_owner() const { return owner_.lock(); }

  void unhandled_exception() {
    this->state_->reject(Rejection::from_exception(std::current_exception()));
  }

 private:
  std::shared_ptr<Executor> executor_;
  std::weak_ptr<detail::CoroutineOwner> owner_;
};

template <typename Value>
[[nodiscard]] Task<Array<Value>> all_tasks(const Array<Task<Value>>& tasks) {
  std::vector<Task<Value>> values;
  values.reserve(tasks.size());
  for (const auto& task : tasks) values.push_back(task);
  return Task<Value>::join_all(std::move(values)).then([](std::vector<Value> settled) {
    return Array<Value>(std::make_move_iterator(settled.begin()),
                        std::make_move_iterator(settled.end()));
  });
}

template <typename Value, typename Reason>
[[nodiscard]] Task<Value> reject_task(Reason&& reason) {
  return Task<Value>::reject(std::forward<Reason>(reason));
}

template <typename Value>
[[nodiscard]] Task<Value> resolve_task(Task<Value> task) {
  return task;
}

template <typename Value>
  requires(!detail::is_task_result<Value>)
[[nodiscard]] Task<std::remove_cvref_t<Value>> resolve_task(Value&& value) {
  using Resolved = std::remove_cvref_t<Value>;
  return Task<Resolved>::resolve(std::forward<Value>(value));
}

template <typename Value>
  requires(!detail::is_task_result<Value>)
[[nodiscard]] Task<Value> resolve_task(const Value& value) {
  return Task<Value>::resolve(value);
}

} // namespace flight
