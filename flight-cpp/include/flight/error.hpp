#pragma once

#include <stdexcept>
#include <utility>

#include <flight/string.hpp>

namespace flight {

class Error : public std::runtime_error {
 public:
  explicit Error(String message = String())
      : std::runtime_error(message.to_utf8()), message_(std::move(message)) {}

  [[nodiscard]] const String& message() const noexcept { return message_; }
  [[nodiscard]] static String name() { return String("Error"); }

 private:
  String message_;
};

} // namespace flight
