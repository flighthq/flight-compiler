#pragma once

#include <cstddef>
#include <functional>
#include <optional>
#include <unordered_map>
#include <utility>

namespace flight {

template <typename Key, typename Value, typename Hash = std::hash<Key>,
          typename Equal = std::equal_to<Key>>
class WeakMap {
 public:
  WeakMap() = default;

  void set(const Key& key, const Value& value) { entries_[key] = value; }

  [[nodiscard]] std::optional<Value> get(const Key& key) const {
    auto it = entries_.find(key);
    if (it == entries_.end()) return std::nullopt;
    return it->second;
  }

  [[nodiscard]] bool has(const Key& key) const { return entries_.count(key) > 0; }

  bool delete_(const Key& key) { return entries_.erase(key) > 0; }

  [[nodiscard]] std::size_t size() const noexcept { return entries_.size(); }

 private:
  std::unordered_map<Key, Value, Hash, Equal> entries_;
};

}  // namespace flight
