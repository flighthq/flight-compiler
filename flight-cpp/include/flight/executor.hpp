#pragma once

#include <cstddef>
#include <deque>
#include <functional>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <utility>

namespace flight {

class Executor {
 public:
  Executor() = default;
  Executor(const Executor&) = delete;
  Executor& operator=(const Executor&) = delete;
  virtual ~Executor() = default;

  virtual void post(std::function<void()> operation) = 0;
  virtual bool run_one() { return false; }
};

class QueueExecutor final : public Executor {
 public:
  void post(std::function<void()> operation) override {
    if (!operation) throw std::invalid_argument("flight::Executor cannot post an empty operation");
    std::lock_guard lock(mutex_);
    operations_.push_back(std::move(operation));
  }

  bool run_one() override {
    std::function<void()> operation;
    {
      std::lock_guard lock(mutex_);
      if (operations_.empty()) return false;
      operation = std::move(operations_.front());
      operations_.pop_front();
    }
    operation();
    return true;
  }

  std::size_t run_until_idle() {
    std::size_t count = 0;
    while (run_one()) ++count;
    return count;
  }

  [[nodiscard]] std::size_t size() const {
    std::lock_guard lock(mutex_);
    return operations_.size();
  }

 private:
  mutable std::mutex mutex_;
  std::deque<std::function<void()>> operations_;
};

inline std::shared_ptr<QueueExecutor> default_queue_executor() {
  static const auto executor = std::make_shared<QueueExecutor>();
  return executor;
}

namespace detail {

inline thread_local std::shared_ptr<Executor> active_executor;

} // namespace detail

inline std::shared_ptr<Executor> current_executor() {
  return detail::active_executor ? detail::active_executor : default_queue_executor();
}

class ExecutorScope {
 public:
  explicit ExecutorScope(std::shared_ptr<Executor> executor)
      : previous_(std::move(detail::active_executor)) {
    if (!executor) throw std::invalid_argument("flight::ExecutorScope requires an executor");
    detail::active_executor = std::move(executor);
  }

  ExecutorScope(const ExecutorScope&) = delete;
  ExecutorScope& operator=(const ExecutorScope&) = delete;

  ~ExecutorScope() { detail::active_executor = std::move(previous_); }

 private:
  std::shared_ptr<Executor> previous_;
};

} // namespace flight
