#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@interface NativeSecp256k1Bridge : NSObject

+ (nullable NSData *)ecdsaSignMsg32:(NSData *)msg32 priv32:(NSData *)priv32 error:(NSError **)error;
+ (BOOL)ecdsaVerifyMsg32:(NSData *)msg32 sig64:(NSData *)sig64 pub33:(NSData *)pub33;
+ (nullable NSData *)pubkeyCreatePriv32:(NSData *)priv32 error:(NSError **)error;

@end

NS_ASSUME_NONNULL_END
