#include <jni.h>
#include <cstring>
#include <vector>

#include "ufsecp_bridge.h"

namespace {

jbyteArray toByteArray(JNIEnv *env, const uint8_t *data, size_t len) {
  jbyteArray arr = env->NewByteArray(static_cast<jsize>(len));
  if (!arr) return nullptr;
  env->SetByteArrayRegion(arr, 0, static_cast<jsize>(len),
                          reinterpret_cast<const jbyte *>(data));
  return arr;
}

bool copyBytes(JNIEnv *env, jbyteArray arr, uint8_t *out, size_t expected) {
  if (!arr) return false;
  const jsize len = env->GetArrayLength(arr);
  if (static_cast<size_t>(len) != expected) return false;
  env->GetByteArrayRegion(arr, 0, len, reinterpret_cast<jbyte *>(out));
  return true;
}

void throwIllegalArg(JNIEnv *env, const char *msg) {
  jclass cls = env->FindClass("java/lang/IllegalArgumentException");
  if (cls) env->ThrowNew(cls, msg);
}

void throwRuntime(JNIEnv *env, const char *msg) {
  jclass cls = env->FindClass("java/lang/RuntimeException");
  if (cls) env->ThrowNew(cls, msg);
}

} // namespace

extern "C" {

JNIEXPORT jbyteArray JNICALL
Java_expo_modules_nativesecp256k1_NativeSecp256k1Module_nativeEcdsaSign(
    JNIEnv *env, jclass, jbyteArray msg32, jbyteArray priv32) {
  uint8_t m[32], p[32], out[64];
  if (!copyBytes(env, msg32, m, 32) || !copyBytes(env, priv32, p, 32)) {
    throwIllegalArg(env, "msg32 and priv32 must be 32 bytes");
    return nullptr;
  }
  if (native_secp_ecdsa_sign(m, p, out) != 0) {
    throwRuntime(env, "ecdsaSign failed");
    return nullptr;
  }
  return toByteArray(env, out, 64);
}

JNIEXPORT jboolean JNICALL
Java_expo_modules_nativesecp256k1_NativeSecp256k1Module_nativeEcdsaVerify(
    JNIEnv *env, jclass, jbyteArray msg32, jbyteArray sig64, jbyteArray pub33) {
  uint8_t m[32], s[64], pub[33];
  if (!copyBytes(env, msg32, m, 32) || !copyBytes(env, sig64, s, 64) ||
      !copyBytes(env, pub33, pub, 33)) {
    return JNI_FALSE;
  }
  return native_secp_ecdsa_verify(m, s, pub) == 1 ? JNI_TRUE : JNI_FALSE;
}

JNIEXPORT jbyteArray JNICALL
Java_expo_modules_nativesecp256k1_NativeSecp256k1Module_nativePubkeyCreate(
    JNIEnv *env, jclass, jbyteArray priv32) {
  uint8_t p[32], out[33];
  if (!copyBytes(env, priv32, p, 32)) {
    throwIllegalArg(env, "priv32 must be 32 bytes");
    return nullptr;
  }
  if (native_secp_pubkey_create(p, out) != 0) {
    throwRuntime(env, "pubkeyCreate failed");
    return nullptr;
  }
  return toByteArray(env, out, 33);
}

} // extern "C"
