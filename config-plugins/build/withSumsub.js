"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const config_plugins_1 = require("@expo/config-plugins");
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const SUMSUB_MAVEN_REPO = "https://maven.sumsub.com/repository/maven-public/";
const SUMSUB_POD_SOURCE = "source 'https://github.com/SumSubstance/Specs.git'";
const COCOAPODS_SOURCE = "source 'https://cdn.cocoapods.org/'";
function ensureSumsubMavenRepository(contents) {
    if (contents.includes("maven.sumsub.com"))
        return contents;
    const repoLine = `    maven { url '${SUMSUB_MAVEN_REPO}' }`;
    return contents.replace(/allprojects\s*\{\s*repositories\s*\{/, (match) => `${match}\n${repoLine}`);
}
function ensureSumsubPodSource(contents) {
    const hasCocoaPodsSource = contents.includes(COCOAPODS_SOURCE);
    const hasSumsubSource = contents.includes(SUMSUB_POD_SOURCE);
    if (hasCocoaPodsSource && hasSumsubSource)
        return contents;
    if (hasCocoaPodsSource) {
        return contents.replace(COCOAPODS_SOURCE, `${COCOAPODS_SOURCE}\n${SUMSUB_POD_SOURCE}`);
    }
    if (hasSumsubSource) {
        return contents.replace(SUMSUB_POD_SOURCE, `${COCOAPODS_SOURCE}\n${SUMSUB_POD_SOURCE}`);
    }
    return `${COCOAPODS_SOURCE}\n${SUMSUB_POD_SOURCE}\n${contents}`;
}
function patchSumsubPodspec(podspecPath, targetVersion) {
    if (!node_fs_1.default.existsSync(podspecPath)) {
        throw new Error(`Sumsub podspec not found: ${podspecPath}`);
    }
    const contents = node_fs_1.default.readFileSync(podspecPath, "utf8");
    const sdkVersionRegex = /^(\s*)sdk_version\s*=\s*["'][^"']+["']\s*$/m;
    const dependencyRegex = /^\s*s\.dependency\s+['"]IdensicMobileSDK['"]\s*,\s*['"][^'"]*['"]\s*$/gm;
    let next = contents;
    if (sdkVersionRegex.test(contents)) {
        next = contents.replace(sdkVersionRegex, (_, p1) => `${p1}sdk_version = "${targetVersion}"`);
    }
    else if (dependencyRegex.test(contents)) {
        next = contents.replace(dependencyRegex, () => `  s.dependency "IdensicMobileSDK", "= ${targetVersion}"`);
    }
    else {
        throw new Error(`IdensicMobileSDK dependency not found in Sumsub podspec: ${podspecPath}`);
    }
    if (next !== contents) {
        node_fs_1.default.writeFileSync(podspecPath, next);
    }
}
function patchSumsubAndroidBuildGradle(buildGradlePath) {
    if (!node_fs_1.default.existsSync(buildGradlePath)) {
        throw new Error(`Sumsub Android build.gradle not found: ${buildGradlePath}`);
    }
    const contents = node_fs_1.default.readFileSync(buildGradlePath, "utf8");
    const legacyJavaCompileDestination = /from\s+javaCompileTask\.destinationDir\b/g;
    if (!legacyJavaCompileDestination.test(contents))
        return;
    node_fs_1.default.writeFileSync(buildGradlePath, contents.replace(legacyJavaCompileDestination, "from javaCompileTask.destinationDirectory"));
}
function patchedMobilesdkModuleIos(targetVersion) {
    return `// [sumsub-patch] IdensicMobileSDK ${targetVersion} compatibility
#import "MobilesdkModule.h"
#import <IdensicMobileSDK/IdensicMobileSDK.h>

@interface MobilesdkModule ()
@property (nonatomic, copy) void(^tokenExpirationOnComplete)(NSString * _Nullable newAccessToken);
@property (nonatomic, weak) SNSMobileSDK *sdk;
@end

@implementation MobilesdkModule

RCT_EXPORT_MODULE(SNSMobileSDKModule)

- (NSArray<NSString *> *)supportedEvents
{
    return @[@"onTokenExpired", @"onLog", @"onStatusChanged", @"onActionResult", @"onEvent"];
}

RCT_EXPORT_METHOD(launch:(NSString *)apiUrl flowName:(NSString *)flowName accessToken:(NSString *)accessToken
                  locale:(NSString *)locale
                  supportEmail:(NSString *)supportEmail
                  debug:(BOOL)debug
                  handlers:(NSDictionary *)handlers
                  applicantConf:(NSDictionary *)applicantConf
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
{
    (void)flowName;
    (void)supportEmail;
    (void)reject;

    SNSMobileSDK *sdk;

    SNSEnvironment environment = (apiUrl && apiUrl.length > 0) ? apiUrl : SNSEnvironmentProduction;
    sdk = [SNSMobileSDK setupWithAccessToken:accessToken
                                 environment:environment];

    if (locale && locale.length > 0) {
        sdk.locale = locale;
    }

    if (![handlers isKindOfClass:NSDictionary.class]) {
        handlers = @{};
    }
    if (![applicantConf isKindOfClass:NSDictionary.class]) {
        applicantConf = @{};
    }

    if (!sdk.isReady) {
        return resolve([self makeResult:sdk]);
    }

    self.sdk = sdk;

    if (debug) {
        sdk.logLevel = SNSLogLevel_Debug;
    }

    if (applicantConf[@"email"]) {
        sdk.initialEmail = applicantConf[@"email"];
    }
    if (applicantConf[@"phone"]) {
        sdk.initialPhone = applicantConf[@"phone"];
    }

    __weak typeof(self) weakSelf = self;

    [sdk setTokenExpirationHandler:^(void (^ _Nonnull onComplete)(NSString * _Nullable)) {

        weakSelf.tokenExpirationOnComplete = onComplete;

        [weakSelf sendEventWithName:@"onTokenExpired" body:nil];
    }];

    if (handlers[@"onStatusChanged"]) {

        [sdk setOnStatusDidChange:^(SNSMobileSDK * _Nonnull sdk, SNSMobileSDKStatus prevStatus) {

            [weakSelf sendEventWithName:@"onStatusChanged" body:@{
                @"newStatus": [sdk descriptionForStatus:sdk.status] ?: @"",
                @"prevStatus": [sdk descriptionForStatus:prevStatus] ?: @"",
            }];
        }];
    }

    if (handlers[@"onActionResult"]) {
        // Intentionally not supported in IdensicMobileSDK 1.40+.
    }

    if (handlers[@"onLog"]) {

        [sdk logHandler:^(SNSLogLevel level, NSString * _Nonnull message) {
            NSLog(@"[Idensic] %@", message);

            [weakSelf sendEventWithName:@"onLog" body:@{
                @"level": @(level),
                @"message": message ?: @"",
            }];
        }];
    }

    if (handlers[@"onEvent"]) {

        [sdk onEvent:^(SNSMobileSDK * _Nonnull sdk, SNSEvent * _Nonnull event) {

            [weakSelf sendEventWithName:@"onEvent" body:@{
                @"eventType": [event descriptionForEventType:event.eventType] ?: @"",
                @"payload": event.payload ?: @{},
            }];
        }];
    }

    [sdk setOnDidDismiss:^(SNSMobileSDK * _Nonnull sdk) {

        resolve([weakSelf makeResult:sdk]);
    }];

    dispatch_async(dispatch_get_main_queue(), ^{
        [self applyCustomizationIfAny];

        [sdk present];
    });
}

RCT_EXPORT_METHOD(updateAccessToken:(NSString *)newAccessToken)
{
    if (self.tokenExpirationOnComplete) {
        dispatch_async(dispatch_get_main_queue(), ^{
            self.tokenExpirationOnComplete(newAccessToken);
            self.tokenExpirationOnComplete = nil;
        });
    }
}

RCT_EXPORT_METHOD(onActionResultCompleted:(NSDictionary *)params)
{
    (void)params;
}

RCT_EXPORT_METHOD(dismiss)
{
    dispatch_async(dispatch_get_main_queue(), ^{
        [self.sdk dismiss];
    });
}

#pragma mark - Customization

- (void)applyCustomizationIfAny {

    NSString *className = @"IdensicMobileSDKCustomization";

    Class customization = [NSBundle.mainBundle classNamed:className];
    if (!customization) {
        NSString *classPrefix = [NSBundle.mainBundle objectForInfoDictionaryKey:(__bridge NSString *)kCFBundleExecutableKey];
        if (classPrefix) {
            customization = [NSBundle.mainBundle classNamed:[NSString stringWithFormat:@"%@.%@", classPrefix, className]];
        }
    }

    if (customization && [customization respondsToSelector:@selector(apply:)]) {
        [customization performSelector:@selector(apply:) withObject:self.sdk];
    }
}

#pragma mark - Helpers

- (NSDictionary *)makeResult:(SNSMobileSDK *)sdk {

    NSMutableDictionary *result = NSMutableDictionary.new;

    result[@"success"] = @(sdk.status != SNSMobileSDKStatus_Failed);
    result[@"status"] = [sdk descriptionForStatus:sdk.status];

    if (sdk.status == SNSMobileSDKStatus_Failed) {
        result[@"errorType"] = [sdk descriptionForFailReason:sdk.failReason];
        result[@"errorMsg"] = sdk.verboseStatus;
    }

    return result.copy;
}

@end
`;
}
function patchSumsubIosModule(mobilesdkModuleIosPath, targetVersion) {
    if (!node_fs_1.default.existsSync(mobilesdkModuleIosPath)) {
        throw new Error(`Sumsub MobilesdkModule.m not found: ${mobilesdkModuleIosPath}`);
    }
    const contents = node_fs_1.default.readFileSync(mobilesdkModuleIosPath, "utf8");
    const looksModern = contents.includes("setupWithAccessToken:") &&
        !/setupWithBaseUrl|SNSActionResult|actionResultHandler|SNSActionResultHandlerReaction/.test(contents);
    if (looksModern)
        return;
    const looksLegacy = /setupWithBaseUrl|SNSActionResult|actionResultHandler|SNSActionResultHandlerReaction/.test(contents);
    if (!looksLegacy) {
        throw new Error(`Sumsub MobilesdkModule.m format not recognized; cannot patch automatically: ${mobilesdkModuleIosPath}`);
    }
    node_fs_1.default.writeFileSync(mobilesdkModuleIosPath, patchedMobilesdkModuleIos(targetVersion));
}
const withSumsub = (config, { targetVersion = "1.40.2" } = {}) => {
    let nextConfig = (0, config_plugins_1.withProjectBuildGradle)(config, (modConfig) => {
        modConfig.modResults.contents = ensureSumsubMavenRepository(modConfig.modResults.contents);
        return modConfig;
    });
    nextConfig = (0, config_plugins_1.withPodfile)(nextConfig, (modConfig) => {
        modConfig.modResults.contents = ensureSumsubPodSource(modConfig.modResults.contents);
        return modConfig;
    });
    nextConfig = (0, config_plugins_1.withDangerousMod)(nextConfig, [
        "ios",
        async (modConfig) => {
            const sumsubModuleRoot = node_path_1.default.join(modConfig.modRequest.projectRoot, "node_modules", "@sumsub", "react-native-mobilesdk-module");
            patchSumsubPodspec(node_path_1.default.join(sumsubModuleRoot, "react-native-mobilesdk-module.podspec"), targetVersion);
            patchSumsubIosModule(node_path_1.default.join(sumsubModuleRoot, "ios", "MobilesdkModule.m"), targetVersion);
            return modConfig;
        },
    ]);
    nextConfig = (0, config_plugins_1.withDangerousMod)(nextConfig, [
        "android",
        async (modConfig) => {
            patchSumsubAndroidBuildGradle(node_path_1.default.join(modConfig.modRequest.projectRoot, "node_modules", "@sumsub", "react-native-mobilesdk-module", "android", "build.gradle"));
            return modConfig;
        },
    ]);
    return nextConfig;
};
exports.default = withSumsub;
