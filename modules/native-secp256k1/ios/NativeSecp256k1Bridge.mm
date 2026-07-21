#import "NativeSecp256k1Bridge.h"
#include "ufsecp_bridge.h"

@implementation NativeSecp256k1Bridge

+ (nullable NSData *)ecdsaSignMsg32:(NSData *)msg32 priv32:(NSData *)priv32 error:(NSError **)error {
  if (msg32.length != 32 || priv32.length != 32) {
    if (error) {
      *error = [NSError errorWithDomain:@"NativeSecp256k1"
                                   code:1
                               userInfo:@{NSLocalizedDescriptionKey : @"msg32 and priv32 must be 32 bytes"}];
    }
    return nil;
  }
  uint8_t out[64];
  int rc = native_secp_ecdsa_sign((const uint8_t *)msg32.bytes,
                                  (const uint8_t *)priv32.bytes,
                                  out);
  if (rc != 0) {
    if (error) {
      *error = [NSError errorWithDomain:@"NativeSecp256k1"
                                   code:2
                               userInfo:@{NSLocalizedDescriptionKey : @"ecdsaSign failed"}];
    }
    return nil;
  }
  return [NSData dataWithBytes:out length:64];
}

+ (BOOL)ecdsaVerifyMsg32:(NSData *)msg32 sig64:(NSData *)sig64 pub33:(NSData *)pub33 {
  if (msg32.length != 32 || sig64.length != 64 || pub33.length != 33) {
    return NO;
  }
  return native_secp_ecdsa_verify((const uint8_t *)msg32.bytes,
                                  (const uint8_t *)sig64.bytes,
                                  (const uint8_t *)pub33.bytes) == 1;
}

+ (nullable NSData *)pubkeyCreatePriv32:(NSData *)priv32 error:(NSError **)error {
  if (priv32.length != 32) {
    if (error) {
      *error = [NSError errorWithDomain:@"NativeSecp256k1"
                                   code:1
                               userInfo:@{NSLocalizedDescriptionKey : @"priv32 must be 32 bytes"}];
    }
    return nil;
  }
  uint8_t out[33];
  int rc = native_secp_pubkey_create((const uint8_t *)priv32.bytes, out);
  if (rc != 0) {
    if (error) {
      *error = [NSError errorWithDomain:@"NativeSecp256k1"
                                   code:3
                               userInfo:@{NSLocalizedDescriptionKey : @"pubkeyCreate failed"}];
    }
    return nil;
  }
  return [NSData dataWithBytes:out length:33];
}

@end
