/**
 * C++ bridge to UltrafastSecp256k1 CT ECDSA API.
 * See ufsecp_bridge.h for rationale.
 */

#include "ufsecp_bridge.h"

#include <array>
#include <cstring>

#include "secp256k1/ecdsa.hpp"
#include "secp256k1/private_key.hpp"
#include "secp256k1/ct/sign.hpp"
#include "secp256k1/ct/point.hpp"
#include "secp256k1/init.hpp"

namespace {

void ensure_init() {
  // Runs library self-test once (cached). Aborts process on catastrophic failure.
  (void)secp256k1::fast::ensure_library_integrity(false);
}

std::array<std::uint8_t, 32> copy32(const uint8_t* p) {
  std::array<std::uint8_t, 32> out{};
  std::memcpy(out.data(), p, 32);
  return out;
}

} // namespace

extern "C" {

int native_secp_ecdsa_sign(const uint8_t msg32[32],
                           const uint8_t priv32[32],
                           uint8_t sig64_out[64]) {
  if (!msg32 || !priv32 || !sig64_out) return -1;
  ensure_init();

  secp256k1::PrivateKey pk;
  if (!secp256k1::PrivateKey::from_bytes(priv32, pk)) {
    return -1;
  }

  const auto msg = copy32(msg32);
  const auto sig = secp256k1::ct::ecdsa_sign(msg, pk.scalar());
  if (!sig.is_valid()) {
    return -1;
  }

  const auto compact = sig.to_compact();
  std::memcpy(sig64_out, compact.data(), 64);
  return 0;
}

int native_secp_ecdsa_verify(const uint8_t msg32[32],
                             const uint8_t sig64[64],
                             const uint8_t pub33[33]) {
  if (!msg32 || !sig64 || !pub33) return 0;
  ensure_init();

  secp256k1::EcdsaPublicKey pub;
  if (!secp256k1::ecdsa_pubkey_parse(pub, pub33, 33)) {
    return 0;
  }

  secp256k1::ECDSASignature sig;
  if (!secp256k1::ECDSASignature::parse_compact_strict(sig64, sig)) {
    return 0;
  }

  return secp256k1::ecdsa_verify(msg32, pub, sig) ? 1 : 0;
}

int native_secp_pubkey_create(const uint8_t priv32[32],
                              uint8_t pub33_out[33]) {
  if (!priv32 || !pub33_out) return -1;
  ensure_init();

  secp256k1::PrivateKey pk;
  if (!secp256k1::PrivateKey::from_bytes(priv32, pk)) {
    return -1;
  }

  // CT generator mul: pubkey = priv * G, then compress.
  const auto point = secp256k1::ct::generator_mul(pk.scalar());
  if (point.is_infinity()) {
    return -1;
  }
  const auto compressed = point.to_compressed();
  std::memcpy(pub33_out, compressed.data(), 33);
  return 0;
}

} // extern "C"
