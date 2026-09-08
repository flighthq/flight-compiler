#pragma once

#include <memory>
#include <utility>

#include <flight/executor.hpp>
#include <flight/string.hpp>

namespace flight {

struct HostServices {
  std::shared_ptr<Executor> executor;
  std::shared_ptr<const UnicodeService> unicode;
};

class HostScope {
 public:
  explicit HostScope(HostServices services) {
    if (services.executor) executor_ = std::make_unique<ExecutorScope>(std::move(services.executor));
    if (services.unicode) unicode_ = std::make_unique<UnicodeServiceScope>(std::move(services.unicode));
  }

  HostScope(const HostScope&) = delete;
  HostScope& operator=(const HostScope&) = delete;

 private:
  std::unique_ptr<ExecutorScope> executor_;
  std::unique_ptr<UnicodeServiceScope> unicode_;
};

} // namespace flight
