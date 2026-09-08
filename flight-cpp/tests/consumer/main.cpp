#include <flight/runtime.hpp>

int main() {
  flight::Array<int> values{1, 2};
  return values.push(3) == 3 && flight::runtime_contract.cpp_abi == 1 ? 0 : 1;
}
