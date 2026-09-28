#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(PasskeyModule, NSObject)

RCT_EXTERN_METHOD(createWalletPasskey:(NSString *)rpId
                  prfSalt:(NSString *)prfSalt
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(createWalletPasskeyWithLabel:(NSString *)rpId
                  prfSalt:(NSString *)prfSalt
                  label:(NSString *)label
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(getWalletPasskeyPrf:(NSString *)rpId
                  prfSalt:(NSString *)prfSalt
                  credIdB64u:(NSString *)credIdB64u
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(getWalletPasskeyPrfAssertion:(NSString *)rpId
                  prfSalt:(NSString *)prfSalt
                  challengeB64u:(NSString *)challengeB64u
                  credIdB64u:(NSString *)credIdB64u
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(getWalletPasskeyAssertion:(NSString *)rpId
                  challengeB64u:(NSString *)challengeB64u
                  credIdB64u:(NSString *)credIdB64u
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

@end
