#pragma once

#include <any>
#include <exception>
#include <stdexcept>
#include <type_traits>
#include <typeinfo>
#include <utility>

namespace flight {

class UnhandledRejection;

class Rejection {
 public:
  [[nodiscard]] static Rejection from_exception(std::exception_ptr exception) {
    if (!exception) throw std::invalid_argument("flight::Rejection requires an exception");
    return Rejection(std::move(exception));
  }

  template <typename Reason>
  [[nodiscard]] static Rejection from_value(Reason&& reason) {
    using Stored = std::decay_t<Reason>;
    static_assert(std::is_copy_constructible_v<Stored>, "rejection values must be copy constructible");
    return Rejection(std::any(std::forward<Reason>(reason)));
  }

  template <typename Reason>
  [[nodiscard]] const Reason& as() const {
    return std::any_cast<const Reason&>(value_);
  }

  [[nodiscard]] bool has_exception() const noexcept { return exception_ != nullptr; }

  template <typename Reason>
  [[nodiscard]] bool is() const noexcept {
    return value_.type() == typeid(Reason);
  }

  [[noreturn]] void rethrow() const;

 private:
  explicit Rejection(std::any value) : value_(std::move(value)) {}
  explicit Rejection(std::exception_ptr exception) : exception_(std::move(exception)) {}

  std::any value_;
  std::exception_ptr exception_;
};

class UnhandledRejection final : public std::runtime_error {
 public:
  explicit UnhandledRejection(Rejection rejection)
      : std::runtime_error("flight::Task rejected with a non-exception value"),
        rejection_(std::move(rejection)) {}

  [[nodiscard]] const Rejection& rejection() const noexcept { return rejection_; }

 private:
  Rejection rejection_;
};

[[noreturn]] inline void Rejection::rethrow() const {
  if (exception_) std::rethrow_exception(exception_);
  throw UnhandledRejection(*this);
}

} // namespace flight
