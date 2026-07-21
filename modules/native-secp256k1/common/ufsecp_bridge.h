/**
 * Thin C surface matching the ufsecp ECDSA subset used by BSV Browser.
 *
 * Mobile UltrafastSecp256k1 prebuilts ship the C++ engine (libfastsecp256k1.a /
 * xcframework) without a separate libufsecp.a. This bridge reimplements the
 * small sync surface we need against the CT C++ API, with the same semantics
 * as ufsecp_ecdsa_sign / verify / pubkey_create (low-S compact R||S).
 */

#pragma once

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/** 0 = success, non-zero = error */
int native_secp_ecdsa_sign(const uint8_t msg32[32],
                           const uint8_t priv32[32],
                           uint8_t sig64_out[64]);

/** 1 = valid, 0 = invalid */
int native_secp_ecdsa_verify(const uint8_t msg32[32],
                             const uint8_t sig64[64],
                             const uint8_t pub33[33]);

/** 0 = success, non-zero = error; writes 33-byte compressed pubkey */
int native_secp_pubkey_create(const uint8_t priv32[32],
                              uint8_t pub33_out[33]);

#ifdef __cplusplus
}
#endif
