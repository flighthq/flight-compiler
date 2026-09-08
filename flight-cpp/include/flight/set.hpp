#pragma once

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <initializer_list>
#include <iterator>
#include <limits>
#include <memory>
#include <stdexcept>
#include <utility>
#include <vector>

#include <flight/equality.hpp>

namespace flight {

template <typename Value, typename Equal = SameValueZero<Value>>
class Set {
 private:
  struct Record {
    Value value;
    std::uint64_t insertion_identity;
  };

  struct Storage {
    std::vector<Record> records;
    std::uint64_t next_insertion_identity = 0;
  };

 public:
  class const_iterator {
   public:
    using difference_type = typename std::vector<Record>::difference_type;
    using iterator_category = std::forward_iterator_tag;
    using pointer = const Value*;
    using reference = const Value&;
    using value_type = Value;

    const_iterator() = default;

    [[nodiscard]] reference operator*() const noexcept { return iterator_->value; }
    [[nodiscard]] pointer operator->() const noexcept { return &iterator_->value; }

    const_iterator& operator++() noexcept {
      ++iterator_;
      return *this;
    }

    const_iterator operator++(int) noexcept {
      auto previous = *this;
      ++*this;
      return previous;
    }

    [[nodiscard]] friend bool operator==(const const_iterator&, const const_iterator&) noexcept = default;

   private:
    friend class Set;
    using RecordIterator = typename std::vector<Record>::const_iterator;

    explicit const_iterator(RecordIterator iterator) noexcept : iterator_(iterator) {}

    RecordIterator iterator_{};
  };

  using size_type = typename std::vector<Record>::size_type;

  Set() : storage_(std::make_shared<Storage>()) {}

  Set(std::initializer_list<Value> values) : Set() {
    for (const auto& value : values) add(value);
  }

  template <typename Range>
    requires requires(const Range& range) {
      std::begin(range);
      std::end(range);
    }
  explicit Set(const Range& values) : Set() {
    for (const auto& value : values) add(value);
  }

  Set& add(Value value) {
    if (has(value)) return *this;
    if (storage_->next_insertion_identity == std::numeric_limits<std::uint64_t>::max()) {
      throw std::length_error("flight::Set exhausted insertion identities");
    }
    if constexpr (std::floating_point<Value>) {
      if (value == Value{0}) value = Value{0};
    }
    storage_->records.push_back(Record{std::move(value), storage_->next_insertion_identity});
    ++storage_->next_insertion_identity;
    return *this;
  }

  [[nodiscard]] const_iterator begin() const noexcept {
    return const_iterator(storage_->records.cbegin());
  }

  [[nodiscard]] const_iterator end() const noexcept {
    return const_iterator(storage_->records.cend());
  }

  void clear() noexcept { storage_->records.clear(); }

  [[nodiscard]] Set clone() const {
    Set result;
    *result.storage_ = *storage_;
    return result;
  }

  [[nodiscard]] bool empty() const noexcept { return storage_->records.empty(); }

  template <typename Function>
  void for_each(Function function) const {
    std::vector<std::uint64_t> visited;
    while (true) {
      const auto record = std::find_if(
          storage_->records.cbegin(), storage_->records.cend(), [&](const Record& candidate) {
            return std::find(visited.cbegin(), visited.cend(), candidate.insertion_identity) ==
                   visited.cend();
          });
      if (record == storage_->records.cend()) return;

      const auto identity = record->insertion_identity;
      const auto value = record->value;
      visited.push_back(identity);
      std::invoke(function, value);
    }
  }

  bool erase(const Value& value) {
    const auto found = find(value);
    if (found == storage_->records.end()) return false;
    storage_->records.erase(found);
    return true;
  }

  [[nodiscard]] bool has(const Value& value) const {
    return find(value) != storage_->records.end();
  }

  [[nodiscard]] size_type size() const noexcept { return storage_->records.size(); }

 private:
  [[nodiscard]] auto find(const Value& value) const {
    return std::find_if(storage_->records.cbegin(), storage_->records.cend(), [&](const Record& record) {
      return equal_(record.value, value);
    });
  }

  Equal equal_{};
  std::shared_ptr<Storage> storage_;
};

} // namespace flight
