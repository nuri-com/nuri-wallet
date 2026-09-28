import AuthenticationServices
import CryptoKit
import Foundation
import React
import Security
import UIKit

@objc(PasskeyModule)
final class PasskeyModule: NSObject, ASAuthorizationControllerDelegate, ASAuthorizationControllerPresentationContextProviding {
  private enum PendingOperation {
    case assertion
    case create
    case prf
    case prfAssertion
  }

  private let attestedCredentialDataFlag: UInt8 = 0x40
  private let iso8601Formatter = ISO8601DateFormatter()
  private var pendingOperation: PendingOperation?
  private var pendingResolve: RCTPromiseResolveBlock?
  private var pendingReject: RCTPromiseRejectBlock?
  private var pendingController: ASAuthorizationController?
  private var pendingNativeMethod: String?
  private var pendingRpId: String?
  private var pendingCredIdHintLen: Int = 0
  private var pendingChallengeLen: Int = 0
  private var pendingPrfSaltLen: Int = 0
  private var pendingStartedAtMs: Int64 = 0

  @objc
  static func requiresMainQueueSetup() -> Bool {
    return true
  }

  @objc(createWalletPasskey:prfSalt:resolver:rejecter:)
  func createWalletPasskey(
    _ rpId: String,
    prfSalt: String,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    createWalletPasskeyInternal(
      rpId,
      prfSalt: prfSalt,
      label: nil,
      resolver: resolve,
      rejecter: reject
    )
  }

  @objc(createWalletPasskeyWithLabel:prfSalt:label:resolver:rejecter:)
  func createWalletPasskeyWithLabel(
    _ rpId: String,
    prfSalt: String,
    label: String,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    createWalletPasskeyInternal(
      rpId,
      prfSalt: prfSalt,
      label: label,
      resolver: resolve,
      rejecter: reject
    )
  }

  @objc(getWalletPasskeyPrf:prfSalt:credIdB64u:resolver:rejecter:)
  func getWalletPasskeyPrf(
    _ rpId: String,
    prfSalt: String,
    credIdB64u: String,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    guard #available(iOS 18.0, *) else {
      reject("get_failed", "Passkey PRF requires iOS 18+", nil)
      return
    }

    guard let normalizedRpId = normalizeRpId(rpId, rejecter: reject, code: "get_failed"),
          let prfSaltData = normalizePrfSalt(prfSalt, rejecter: reject, code: "get_failed")
    else {
      return
    }

    let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(
      relyingPartyIdentifier: normalizedRpId
    )
    let request = provider.createCredentialAssertionRequest(challenge: randomData(count: 32))
    request.userVerificationPreference = .required
    let normalizedCredId = credIdB64u.trimmingCharacters(in: .whitespacesAndNewlines)
    if !normalizedCredId.isEmpty {
      guard let credData = decodeBase64URL(normalizedCredId), !credData.isEmpty else {
        reject("get_failed", "Invalid credIdB64u", nil)
        return
      }
      request.allowedCredentials = [
        ASAuthorizationPlatformPublicKeyCredentialDescriptor(credentialID: credData),
      ]
    }
    request.prf = ASAuthorizationPublicKeyCredentialPRFAssertionInput.inputValues(
      ASAuthorizationPublicKeyCredentialPRFAssertionInput.InputValues(saltInput1: prfSaltData)
    )

    guard beginPending(
      .prf,
      nativeMethod: "PasskeyModule.getWalletPasskeyPrf",
      rpId: normalizedRpId,
      credIdHintLen: normalizedCredId.count,
      challengeLen: 32,
      prfSaltLen: prfSalt.count,
      resolver: resolve,
      rejecter: reject
    ) else {
      return
    }

    perform(controllerFor: request)
  }

  @objc(getWalletPasskeyAssertion:challengeB64u:credIdB64u:resolver:rejecter:)
  func getWalletPasskeyAssertion(
    _ rpId: String,
    challengeB64u: String,
    credIdB64u: String,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    guard #available(iOS 15.0, *) else {
      reject("assertion_failed", "Passkeys require iOS 15+", nil)
      return
    }

    guard let normalizedRpId = normalizeRpId(rpId, rejecter: reject, code: "assertion_failed") else {
      return
    }

    let challengeInput = challengeB64u.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let challengeData = decodeBase64URL(challengeInput), !challengeData.isEmpty else {
      reject("assertion_failed", "Invalid challengeB64u", nil)
      return
    }

    let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(
      relyingPartyIdentifier: normalizedRpId
    )
    let request = provider.createCredentialAssertionRequest(challenge: challengeData)
    request.userVerificationPreference = .required

    let normalizedCredId = credIdB64u.trimmingCharacters(in: .whitespacesAndNewlines)
    if !normalizedCredId.isEmpty {
      guard let credData = decodeBase64URL(normalizedCredId), !credData.isEmpty else {
        reject("assertion_failed", "Invalid credIdB64u", nil)
        return
      }
      request.allowedCredentials = [
        ASAuthorizationPlatformPublicKeyCredentialDescriptor(credentialID: credData),
      ]
    }

    guard beginPending(
      .assertion,
      nativeMethod: "PasskeyModule.getWalletPasskeyAssertion",
      rpId: normalizedRpId,
      credIdHintLen: normalizedCredId.count,
      challengeLen: challengeInput.count,
      prfSaltLen: 0,
      resolver: resolve,
      rejecter: reject
    ) else {
      return
    }

    perform(controllerFor: request)
  }

  @objc(getWalletPasskeyPrfAssertion:prfSalt:challengeB64u:credIdB64u:resolver:rejecter:)
  func getWalletPasskeyPrfAssertion(
    _ rpId: String,
    prfSalt: String,
    challengeB64u: String,
    credIdB64u: String,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    guard #available(iOS 18.0, *) else {
      reject("get_failed", "Passkey PRF requires iOS 18+", nil)
      return
    }

    guard let normalizedRpId = normalizeRpId(rpId, rejecter: reject, code: "get_failed"),
          let prfSaltData = normalizePrfSalt(prfSalt, rejecter: reject, code: "get_failed")
    else {
      return
    }

    let challengeInput = challengeB64u.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let challengeData = decodeBase64URL(challengeInput), !challengeData.isEmpty else {
      reject("get_failed", "Invalid challengeB64u", nil)
      return
    }

    let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(
      relyingPartyIdentifier: normalizedRpId
    )
    let request = provider.createCredentialAssertionRequest(challenge: challengeData)
    request.userVerificationPreference = .required

    let normalizedCredId = credIdB64u.trimmingCharacters(in: .whitespacesAndNewlines)
    if !normalizedCredId.isEmpty {
      guard let credData = decodeBase64URL(normalizedCredId), !credData.isEmpty else {
        reject("get_failed", "Invalid credIdB64u", nil)
        return
      }
      request.allowedCredentials = [
        ASAuthorizationPlatformPublicKeyCredentialDescriptor(credentialID: credData),
      ]
    }
    request.prf = ASAuthorizationPublicKeyCredentialPRFAssertionInput.inputValues(
      ASAuthorizationPublicKeyCredentialPRFAssertionInput.InputValues(saltInput1: prfSaltData)
    )

    guard beginPending(
      .prfAssertion,
      nativeMethod: "PasskeyModule.getWalletPasskeyPrfAssertion",
      rpId: normalizedRpId,
      credIdHintLen: normalizedCredId.count,
      challengeLen: challengeInput.count,
      prfSaltLen: prfSalt.count,
      resolver: resolve,
      rejecter: reject
    ) else {
      return
    }

    perform(controllerFor: request)
  }

  func authorizationController(
    controller: ASAuthorizationController,
    didCompleteWithAuthorization authorization: ASAuthorization
  ) {
    let operation = pendingOperation
    let nativeMethod = pendingNativeMethod
    let rpId = pendingRpId
    let startedAtMs = pendingStartedAtMs
    let resolve = pendingResolve
    let reject = pendingReject
    clearPending()

    guard let operation else {
      reject?("authorization_failed", "Missing pending passkey operation", nil)
      return
    }

    switch operation {
    case .assertion:
      guard let assertion = authorization.credential as? ASAuthorizationPlatformPublicKeyCredentialAssertion else {
        reject?(codeForOperation(operation), "Unexpected authorization credential", nil)
        return
      }

      resolve?([
        "credIdB64u": encodeBase64URL(assertion.credentialID),
        "clientDataB64u": encodeBase64URL(assertion.rawClientDataJSON),
        "authDataB64u": encodeBase64URL(assertion.rawAuthenticatorData),
        "sigB64u": encodeBase64URL(assertion.signature),
      ])
      logPasskeyNative("passkey_native_result", [
        "native_method": nativeMethod ?? "unknown",
        "status": "ok",
        "dur_ms": "\(max(0, nowMs() - startedAtMs))",
        "prompt_kind": promptKind(operation),
        "prf_requested": flag(prfRequested(operation)),
        "assertion_requested": flag(assertionRequested(operation)),
        "user_verification": "required",
        "face_id_role": "os_passkey_user_verification_possible",
        "legacy_keychain_biometric": "0",
        "rp_id": sanitize(rpId ?? "unknown"),
        "cred_id_len": "\(assertion.credentialID.count)",
        "secret_output": "not_logged",
      ], function: "authorizationController")
    case .create:
      guard #available(iOS 18.0, *),
            let registration = authorization.credential as? ASAuthorizationPlatformPublicKeyCredentialRegistration
      else {
        reject?(codeForOperation(operation), "Unexpected authorization credential", nil)
        return
      }
      handleCreateCompletion(registration, resolver: resolve, rejecter: reject)
      logPasskeyNative("passkey_native_result", [
        "native_method": nativeMethod ?? "unknown",
        "status": "ok",
        "dur_ms": "\(max(0, nowMs() - startedAtMs))",
        "prompt_kind": promptKind(operation),
        "prf_requested": flag(prfRequested(operation)),
        "assertion_requested": flag(assertionRequested(operation)),
        "user_verification": "required",
        "face_id_role": "os_passkey_user_verification_possible",
        "legacy_keychain_biometric": "0",
        "rp_id": sanitize(rpId ?? "unknown"),
        "cred_id_len": "\(registration.credentialID.count)",
        "secret_output": "not_logged",
      ], function: "authorizationController")
    case .prf, .prfAssertion:
      guard #available(iOS 18.0, *),
            let assertion = authorization.credential as? ASAuthorizationPlatformPublicKeyCredentialAssertion
      else {
        reject?(codeForOperation(operation), "Unexpected authorization credential", nil)
        return
      }
      handlePrfCompletion(
        assertion,
        includeAssertion: operation == .prfAssertion,
        resolver: resolve,
        rejecter: reject
      )
      logPasskeyNative("passkey_native_result", [
        "native_method": nativeMethod ?? "unknown",
        "status": "ok",
        "dur_ms": "\(max(0, nowMs() - startedAtMs))",
        "prompt_kind": promptKind(operation),
        "prf_requested": flag(prfRequested(operation)),
        "assertion_requested": flag(assertionRequested(operation)),
        "user_verification": "required",
        "face_id_role": "os_passkey_user_verification_possible",
        "legacy_keychain_biometric": "0",
        "rp_id": sanitize(rpId ?? "unknown"),
        "cred_id_len": "\(assertion.credentialID.count)",
        "secret_output": "not_logged",
      ], function: "authorizationController")
    }
  }

  func authorizationController(
    controller: ASAuthorizationController,
    didCompleteWithError error: Error
  ) {
    let operation = pendingOperation
    let nativeMethod = pendingNativeMethod
    let rpId = pendingRpId
    let startedAtMs = pendingStartedAtMs
    let reject = pendingReject
    clearPending()
    logPasskeyNative("passkey_native_result", [
      "native_method": nativeMethod ?? "unknown",
      "status": "failed",
      "dur_ms": "\(max(0, nowMs() - startedAtMs))",
      "prompt_kind": promptKind(operation),
      "prf_requested": flag(prfRequested(operation)),
      "assertion_requested": flag(assertionRequested(operation)),
      "user_verification": "required",
      "face_id_role": "os_passkey_user_verification_possible",
      "legacy_keychain_biometric": "0",
      "rp_id": sanitize(rpId ?? "unknown"),
      "err": sanitize(describeAuthorizationError(error)),
    ], function: "authorizationController")
    reject?(codeForOperation(operation), describeAuthorizationError(error), error)
  }

  func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
    let keyWindow = UIApplication.shared.connectedScenes
      .compactMap { $0 as? UIWindowScene }
      .flatMap { $0.windows }
      .first { $0.isKeyWindow }
    return keyWindow ?? ASPresentationAnchor()
  }

  private func nowMs() -> Int64 {
    Int64((Date().timeIntervalSince1970 * 1000).rounded())
  }

  private func shortLogTime() -> String {
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.dateFormat = "HH:mm:ss.SSS"
    return formatter.string(from: Date())
  }

  private func sanitize(_ value: String) -> String {
    let collapsed = value.replacingOccurrences(
      of: "\\s+",
      with: "_",
      options: .regularExpression
    )
    return String(collapsed.prefix(120))
  }

  private func flag(_ value: Bool) -> String {
    value ? "1" : "0"
  }

  private func promptKind(_ operation: PendingOperation?) -> String {
    switch operation {
    case .assertion:
      return "passkey_assertion"
    case .create:
      return "passkey_create_prf"
    case .prf:
      return "passkey_prf"
    case .prfAssertion:
      return "passkey_prf_assertion"
    case .none:
      return "unknown"
    }
  }

  private func prfRequested(_ operation: PendingOperation?) -> Bool {
    switch operation {
    case .create, .prf, .prfAssertion:
      return true
    case .assertion, .none:
      return false
    }
  }

  private func assertionRequested(_ operation: PendingOperation?) -> Bool {
    switch operation {
    case .assertion, .prfAssertion:
      return true
    case .create, .prf, .none:
      return false
    }
  }

  private func logPasskeyNative(
    _ step: String,
    _ fields: [String: String],
    function: String
  ) {
    let detail = fields
      .map { "\($0.key)=\(sanitize($0.value))" }
      .sorted()
      .joined(separator: " ")
    NSLog(
      "🔐 [\(shortLogTime()) src=ios/Nuricom/PasskeyModule.swift#\(function) INFO FLOW grp=Auth] Arkade_v4=1 step=\(step) \(detail)"
    )
  }

  private func clearPending() {
    pendingOperation = nil
    pendingResolve = nil
    pendingReject = nil
    pendingController = nil
    pendingNativeMethod = nil
    pendingRpId = nil
    pendingCredIdHintLen = 0
    pendingChallengeLen = 0
    pendingPrfSaltLen = 0
    pendingStartedAtMs = 0
  }

  private func beginPending(
    _ operation: PendingOperation,
    nativeMethod: String,
    rpId: String,
    credIdHintLen: Int,
    challengeLen: Int,
    prfSaltLen: Int,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) -> Bool {
    if pendingOperation != nil {
      reject(codeForOperation(operation), "Passkey request already in progress", nil)
      return false
    }

    pendingOperation = operation
    pendingResolve = resolve
    pendingReject = reject
    pendingNativeMethod = nativeMethod
    pendingRpId = rpId
    pendingCredIdHintLen = credIdHintLen
    pendingChallengeLen = challengeLen
    pendingPrfSaltLen = prfSaltLen
    pendingStartedAtMs = nowMs()
    return true
  }

  private func perform(controllerFor request: ASAuthorizationRequest) {
    let controller = ASAuthorizationController(authorizationRequests: [request])
    pendingController = controller
    controller.delegate = self
    controller.presentationContextProvider = self
    DispatchQueue.main.async {
      self.logPasskeyNative("passkey_native_prompt", [
        "native_method": self.pendingNativeMethod ?? "unknown",
        "status": "requested",
        "prompt_kind": self.promptKind(self.pendingOperation),
        "prf_requested": self.flag(self.prfRequested(self.pendingOperation)),
        "assertion_requested": self.flag(self.assertionRequested(self.pendingOperation)),
        "user_verification": "required",
        "face_id_role": "os_passkey_user_verification_possible",
        "face_id_direct_api": "0",
        "legacy_keychain_biometric": "0",
        "rp_id": self.sanitize(self.pendingRpId ?? "unknown"),
        "cred_id_hint_len": "\(self.pendingCredIdHintLen)",
        "challenge_len": "\(self.pendingChallengeLen)",
        "prf_salt_len": "\(self.pendingPrfSaltLen)",
        "secret_input": "not_logged",
      ], function: "perform")
      controller.performRequests()
    }
  }

  private func createWalletPasskeyInternal(
    _ rpId: String,
    prfSalt: String,
    label: String?,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    guard #available(iOS 18.0, *) else {
      reject("create_failed", "Passkey PRF requires iOS 18+", nil)
      return
    }

    guard let normalizedRpId = normalizeRpId(rpId, rejecter: reject, code: "create_failed"),
          let prfSaltData = normalizePrfSalt(prfSalt, rejecter: reject, code: "create_failed")
    else {
      return
    }

    let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(
      relyingPartyIdentifier: normalizedRpId
    )
    let request = provider.createCredentialRegistrationRequest(
      challenge: randomData(count: 32),
      name: normalizeLabel(label),
      userID: randomData(count: 16)
    )
    request.userVerificationPreference = .required
    request.attestationPreference = .none
    request.prf = ASAuthorizationPublicKeyCredentialPRFRegistrationInput.inputValues(
      ASAuthorizationPublicKeyCredentialPRFRegistrationInput.InputValues(saltInput1: prfSaltData)
    )

    guard beginPending(
      .create,
      nativeMethod: label == nil ? "PasskeyModule.createWalletPasskey" : "PasskeyModule.createWalletPasskeyWithLabel",
      rpId: normalizedRpId,
      credIdHintLen: 0,
      challengeLen: 32,
      prfSaltLen: prfSalt.count,
      resolver: resolve,
      rejecter: reject
    ) else {
      return
    }

    perform(controllerFor: request)
  }

  @available(iOS 18.0, *)
  private func handleCreateCompletion(
    _ registration: ASAuthorizationPlatformPublicKeyCredentialRegistration,
    resolver resolve: RCTPromiseResolveBlock?,
    rejecter reject: RCTPromiseRejectBlock?
  ) {
    guard let prfData = data(from: registration.prf?.first) else {
      reject?("create_failed", "Missing PRF output", nil)
      return
    }

    guard let credentialPublicKey = extractCredentialPublicKey(
      attestationObject: registration.rawAttestationObject
    ) else {
      reject?("create_failed", "Missing credential public key", nil)
      return
    }

    resolve?([
      "prfB64": prfData.base64EncodedString(),
      "credIdB64u": encodeBase64URL(registration.credentialID),
      "credPubkeyB64u": encodeBase64URL(credentialPublicKey),
      "isNew": true,
    ])
  }

  @available(iOS 18.0, *)
  private func handlePrfCompletion(
    _ assertion: ASAuthorizationPlatformPublicKeyCredentialAssertion,
    includeAssertion: Bool,
    resolver resolve: RCTPromiseResolveBlock?,
    rejecter reject: RCTPromiseRejectBlock?
  ) {
    guard let prfData = data(from: assertion.prf?.first) else {
      reject?("get_failed", "Missing PRF output", nil)
      return
    }

    var result: [String: Any] = [
      "prfB64": prfData.base64EncodedString(),
      "credIdB64u": encodeBase64URL(assertion.credentialID),
      "isNew": false,
    ]
    if includeAssertion {
      result["clientDataB64u"] = encodeBase64URL(assertion.rawClientDataJSON)
      result["authDataB64u"] = encodeBase64URL(assertion.rawAuthenticatorData)
      result["sigB64u"] = encodeBase64URL(assertion.signature)
    }

    resolve?(result)
  }

  private func normalizeRpId(
    _ rpId: String,
    rejecter reject: RCTPromiseRejectBlock,
    code: String
  ) -> String? {
    let normalizedRpId = rpId.trimmingCharacters(in: .whitespacesAndNewlines)
    if normalizedRpId.isEmpty {
      reject(code, "rpId is required", nil)
      return nil
    }
    return normalizedRpId
  }

  private func normalizePrfSalt(
    _ prfSalt: String,
    rejecter reject: RCTPromiseRejectBlock,
    code: String
  ) -> Data? {
    let normalizedSalt = prfSalt.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !normalizedSalt.isEmpty, let prfSaltData = normalizedSalt.data(using: .utf8) else {
      reject(code, "prfSalt is required", nil)
      return nil
    }
    return prfSaltData
  }

  private func normalizeLabel(_ label: String?) -> String {
    let normalizedLabel = String(label ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    if !normalizedLabel.isEmpty {
      return normalizedLabel
    }
    return "Nuri Wallet \(iso8601Formatter.string(from: Date()))"
  }

  private func codeForOperation(_ operation: PendingOperation?) -> String {
    switch operation {
    case .create:
      return "create_failed"
    case .prf, .prfAssertion:
      return "get_failed"
    case .assertion:
      return "assertion_failed"
    case .none:
      return "authorization_failed"
    }
  }

  private func randomData(count: Int) -> Data {
    var bytes = [UInt8](repeating: 0, count: max(0, count))
    let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
    if status == errSecSuccess {
      return Data(bytes)
    }
    let fallback = (0..<bytes.count).map { _ in UInt8.random(in: .min ... .max) }
    return Data(fallback)
  }

  private func data(from symmetricKey: SymmetricKey?) -> Data? {
    guard let symmetricKey else {
      return nil
    }
    return symmetricKey.withUnsafeBytes { Data($0) }
  }

  private func extractCredentialPublicKey(attestationObject: Data?) -> Data? {
    guard let attestationObject,
          let authData = extractAuthData(from: attestationObject)
    else {
      return nil
    }
    return extractCredentialPublicKey(fromAuthData: authData)
  }

  private func extractAuthData(from attestationObject: Data) -> Data? {
    var offset = 0
    guard let pairCount = readMapCount(from: attestationObject, offset: &offset) else {
      return nil
    }

    for _ in 0..<pairCount {
      guard let key = readTextString(from: attestationObject, offset: &offset) else {
        return nil
      }
      if key == "authData" {
        return readByteString(from: attestationObject, offset: &offset)
      }
      guard skipItem(in: attestationObject, offset: &offset) else {
        return nil
      }
    }

    return nil
  }

  private func extractCredentialPublicKey(fromAuthData authData: Data) -> Data? {
    guard authData.count >= 37 else {
      return nil
    }

    let flags = authData[32]
    guard (flags & attestedCredentialDataFlag) != 0 else {
      return nil
    }

    var offset = 37
    guard authData.count >= offset + 16 + 2 else {
      return nil
    }

    offset += 16
    let credentialIdLength =
      (Int(authData[offset]) << 8) | Int(authData[offset + 1])
    offset += 2

    guard authData.count >= offset + credentialIdLength else {
      return nil
    }

    offset += credentialIdLength
    return readCOSEPublicKey(from: authData, offset: &offset)
  }

  private func readCOSEPublicKey(from data: Data, offset: inout Int) -> Data? {
    guard let pairCount = readMapCount(from: data, offset: &offset) else {
      return nil
    }

    var x: Data?
    var y: Data?

    for _ in 0..<pairCount {
      guard let key = readInteger(from: data, offset: &offset) else {
        return nil
      }

      if key == -2 {
        x = readByteString(from: data, offset: &offset)
      } else if key == -3 {
        y = readByteString(from: data, offset: &offset)
      } else if !skipItem(in: data, offset: &offset) {
        return nil
      }
    }

    guard let x, let y, x.count == 32, y.count == 32 else {
      return nil
    }

    var out = Data([0x04])
    out.append(x)
    out.append(y)
    return out
  }

  private func readMapCount(from data: Data, offset: inout Int) -> Int? {
    guard let header = readHeader(from: data, offset: &offset),
          header.major == 5,
          let length = readLength(additional: header.additional, from: data, offset: &offset)
    else {
      return nil
    }
    return Int(length)
  }

  private func readTextString(from data: Data, offset: inout Int) -> String? {
    guard let stringData = readDataItem(expectedMajor: 3, from: data, offset: &offset) else {
      return nil
    }
    return String(data: stringData, encoding: .utf8)
  }

  private func readByteString(from data: Data, offset: inout Int) -> Data? {
    readDataItem(expectedMajor: 2, from: data, offset: &offset)
  }

  private func readDataItem(expectedMajor: UInt8, from data: Data, offset: inout Int) -> Data? {
    guard let header = readHeader(from: data, offset: &offset),
          header.major == expectedMajor,
          let length = readLength(additional: header.additional, from: data, offset: &offset)
    else {
      return nil
    }

    let byteCount = Int(length)
    guard data.count >= offset + byteCount else {
      return nil
    }

    let out = data.subdata(in: offset ..< offset + byteCount)
    offset += byteCount
    return out
  }

  private func readInteger(from data: Data, offset: inout Int) -> Int? {
    guard let header = readHeader(from: data, offset: &offset),
          let value = readLength(additional: header.additional, from: data, offset: &offset)
    else {
      return nil
    }

    switch header.major {
    case 0:
      return Int(value)
    case 1:
      return -1 - Int(value)
    default:
      return nil
    }
  }

  private func skipItem(in data: Data, offset: inout Int) -> Bool {
    guard let header = readHeader(from: data, offset: &offset) else {
      return false
    }

    switch header.major {
    case 0, 1:
      return readLength(additional: header.additional, from: data, offset: &offset) != nil
    case 2, 3:
      guard let length = readLength(additional: header.additional, from: data, offset: &offset) else {
        return false
      }
      let byteCount = Int(length)
      guard data.count >= offset + byteCount else {
        return false
      }
      offset += byteCount
      return true
    case 4:
      guard let count = readLength(additional: header.additional, from: data, offset: &offset) else {
        return false
      }
      for _ in 0..<count {
        if !skipItem(in: data, offset: &offset) {
          return false
        }
      }
      return true
    case 5:
      guard let count = readLength(additional: header.additional, from: data, offset: &offset) else {
        return false
      }
      for _ in 0..<count {
        if !skipItem(in: data, offset: &offset) || !skipItem(in: data, offset: &offset) {
          return false
        }
      }
      return true
    case 6:
      guard readLength(additional: header.additional, from: data, offset: &offset) != nil else {
        return false
      }
      return skipItem(in: data, offset: &offset)
    case 7:
      switch header.additional {
      case 0...23:
        return true
      case 24:
        return advance(in: data, offset: &offset, by: 1)
      case 25:
        return advance(in: data, offset: &offset, by: 2)
      case 26:
        return advance(in: data, offset: &offset, by: 4)
      case 27:
        return advance(in: data, offset: &offset, by: 8)
      default:
        return false
      }
    default:
      return false
    }
  }

  private func readHeader(from data: Data, offset: inout Int) -> (major: UInt8, additional: UInt8)? {
    guard data.indices.contains(offset) else {
      return nil
    }

    let byte = data[offset]
    offset += 1
    return (byte >> 5, byte & 0x1f)
  }

  private func readLength(
    additional: UInt8,
    from data: Data,
    offset: inout Int
  ) -> UInt64? {
    switch additional {
    case 0...23:
      return UInt64(additional)
    case 24:
      return readFixedWidthInteger(from: data, offset: &offset, byteCount: 1)
    case 25:
      return readFixedWidthInteger(from: data, offset: &offset, byteCount: 2)
    case 26:
      return readFixedWidthInteger(from: data, offset: &offset, byteCount: 4)
    case 27:
      return readFixedWidthInteger(from: data, offset: &offset, byteCount: 8)
    default:
      return nil
    }
  }

  private func readFixedWidthInteger(
    from data: Data,
    offset: inout Int,
    byteCount: Int
  ) -> UInt64? {
    guard data.count >= offset + byteCount else {
      return nil
    }

    var value: UInt64 = 0
    for index in 0..<byteCount {
      value = (value << 8) | UInt64(data[offset + index])
    }
    offset += byteCount
    return value
  }

  private func advance(in data: Data, offset: inout Int, by byteCount: Int) -> Bool {
    guard data.count >= offset + byteCount else {
      return false
    }
    offset += byteCount
    return true
  }

  private func decodeBase64URL(_ value: String) -> Data? {
    if value.isEmpty {
      return nil
    }
    var normalized = value.replacingOccurrences(of: "-", with: "+")
      .replacingOccurrences(of: "_", with: "/")
    let remainder = normalized.count % 4
    if remainder != 0 {
      normalized += String(repeating: "=", count: 4 - remainder)
    }
    return Data(base64Encoded: normalized)
  }

  private func encodeBase64URL(_ data: Data) -> String {
    return data.base64EncodedString()
      .replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
  }

  private func describeAuthorizationError(_ error: Error) -> String {
    let nsError = error as NSError
    if nsError.domain == ASAuthorizationError.errorDomain,
       let code = ASAuthorizationError.Code(rawValue: nsError.code) {
      switch code {
      case .canceled:
        return "Authorization canceled"
      case .failed:
        return "Authorization failed"
      case .invalidResponse:
        return "Invalid authorization response"
      case .notHandled:
        return "Authorization not handled"
      case .unknown:
        return "Unknown authorization error"
      @unknown default:
        return "Authorization error"
      }
    }

    let message = nsError.localizedDescription.trimmingCharacters(in: .whitespacesAndNewlines)
    return message.isEmpty ? "Authorization error" : message
  }
}
