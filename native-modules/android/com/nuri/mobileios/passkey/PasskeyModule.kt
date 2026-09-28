package com.nuri.mobileios.passkey

import android.app.Activity
import android.os.Build
import android.os.CancellationSignal
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.util.Log
import androidx.core.content.ContextCompat
import androidx.credentials.CreatePublicKeyCredentialRequest
import androidx.credentials.CredentialManager
import androidx.credentials.CredentialManagerCallback
import androidx.credentials.CreateCredentialResponse
import androidx.credentials.GetCredentialRequest
import androidx.credentials.GetCredentialResponse
import androidx.credentials.GetPublicKeyCredentialOption
import androidx.credentials.PublicKeyCredential
import androidx.credentials.exceptions.CreateCredentialException
import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.credentials.exceptions.GetCredentialException
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.upokecenter.cbor.CBORObject
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.security.SecureRandom
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class PasskeyModule(private val reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {
  private companion object {
    private const val TAG = "PasskeyModule"
    private const val FLAG_AT = 0x40
  }

  override fun getName(): String = "PasskeyModule"

  @ReactMethod
  fun createWalletPasskey(rpId: String, prfSalt: String, promise: Promise) {
    createWalletPasskeyInternal(rpId, prfSalt, null, promise)
  }

  @ReactMethod
  fun createWalletPasskeyWithLabel(
    rpId: String,
    prfSalt: String,
    labelOverride: String?,
    promise: Promise,
  ) {
    createWalletPasskeyInternal(rpId, prfSalt, labelOverride, promise)
  }

  private fun createWalletPasskeyInternal(
    rpId: String,
    prfSalt: String,
    labelOverride: String?,
    promise: Promise,
  ) {
    val activity = getCurrentActivity() ?: run {
      promise.reject("no_activity", "Activity not available")
      return
    }
    Log.i(
      TAG,
      "createWalletPasskey start rpId=$rpId pkg=${activity.packageName} sdk=${Build.VERSION.SDK_INT} device=${Build.MODEL}",
    )
    val credentialManager = CredentialManager.create(activity)
    val executor = ContextCompat.getMainExecutor(activity)
    val cancellationSignal = CancellationSignal()
    val requestJson = buildCreateRequestJson(rpId, prfSalt, labelOverride)
    Log.d(TAG, "createWalletPasskey requestJsonLen=${requestJson.length}")
    val request = CreatePublicKeyCredentialRequest(requestJson)

    credentialManager.createCredentialAsync(
      activity,
      request,
      cancellationSignal,
      executor,
      object : CredentialManagerCallback<CreateCredentialResponse, CreateCredentialException> {
        override fun onResult(result: CreateCredentialResponse) {
          Log.i(TAG, "createWalletPasskey createCredentialAsync success")
          val regJson = (result as? androidx.credentials.CreatePublicKeyCredentialResponse)
            ?.registrationResponseJson
          if (regJson.isNullOrEmpty()) {
            promise.reject("create_failed", "Missing registration response")
            return
          }
          val credId = extractRawId(regJson)
          val credPubkey = extractPublicKey(regJson)
          val inlinePrfB64u = extractPrfB64u(regJson)
          Log.i(
            TAG,
            "createWalletPasskey response meta credIdLen=${safeLen(credId)} credPubkeyLen=${safeLen(credPubkey)} inlinePrf=${!inlinePrfB64u.isNullOrEmpty()}",
          )
          if (!inlinePrfB64u.isNullOrEmpty()) {
            val resultMap = Arguments.createMap().apply {
              putString("prfB64", b64uToB64(inlinePrfB64u))
              if (!credId.isNullOrEmpty()) putString("credIdB64u", credId)
              if (!credPubkey.isNullOrEmpty()) putString("credPubkeyB64u", credPubkey)
              putBoolean("isNew", true)
            }
            promise.resolve(resultMap)
            return
          }
          Log.w(
            TAG,
            "createWalletPasskey inline PRF missing; falling back to two-step getPrf",
          )
          Handler(Looper.getMainLooper()).postDelayed(
            {
              getPrf(
                activity,
                rpId,
                prfSalt,
                promise,
                true,
                credId,
                credPubkey,
                0,
                2,
                900,
              )
            },
            700,
          )
        }

        override fun onError(e: CreateCredentialException) {
          logCredentialError("createWalletPasskey", e)
          promise.reject("create_failed", describeCredentialError(e), e)
        }
      },
    )
  }

  @ReactMethod
  fun getWalletPasskeyPrf(rpId: String, prfSalt: String, credIdB64u: String?, promise: Promise) {
    val activity = getCurrentActivity() ?: run {
      promise.reject("no_activity", "Activity not available")
      return
    }
    getPrf(activity, rpId, prfSalt, promise, false, credIdB64u?.trim(), null)
  }

  @ReactMethod
  fun getWalletPasskeyPrfAssertion(
    rpId: String,
    prfSalt: String,
    challengeB64u: String,
    credIdB64u: String?,
    promise: Promise,
  ) {
    val activity = getCurrentActivity() ?: run {
      promise.reject("no_activity", "Activity not available")
      return
    }
    getPrf(
      activity,
      rpId,
      prfSalt,
      promise,
      false,
      credIdB64u?.trim(),
      null,
      assertionChallengeB64u = challengeB64u.trim(),
    )
  }

  @ReactMethod
  fun getWalletPasskeyAssertion(
    rpId: String,
    challengeB64u: String,
    credIdB64u: String?,
    promise: Promise,
  ) {
    val activity = getCurrentActivity() ?: run {
      promise.reject("no_activity", "Activity not available")
      return
    }
    Log.i(
      TAG,
      "getWalletPasskeyAssertion start rpId=$rpId challengeLen=${safeLen(challengeB64u)} credIdLen=${safeLen(credIdB64u)} pkg=${activity.packageName}",
    )
    val credentialManager = CredentialManager.create(activity)
    val executor = ContextCompat.getMainExecutor(activity)
    val cancellationSignal = CancellationSignal()
    val requestJson = buildGetAssertionRequestJson(rpId, challengeB64u, credIdB64u)
    val option = GetPublicKeyCredentialOption(requestJson)
    val request = GetCredentialRequest.Builder()
      .addCredentialOption(option)
      .build()

    credentialManager.getCredentialAsync(
      activity,
      request,
      cancellationSignal,
      executor,
      object : CredentialManagerCallback<GetCredentialResponse, GetCredentialException> {
        override fun onResult(result: GetCredentialResponse) {
          val credential = result.credential
          if (credential !is PublicKeyCredential) {
            promise.reject("assertion_failed", "Unexpected credential type")
            return
          }
          val authJson = credential.authenticationResponseJson
          val assertion = extractAssertionPayload(authJson, credIdB64u)
          if (assertion == null) {
            promise.reject("assertion_failed", "Missing assertion fields")
            return
          }
          val resultMap = Arguments.createMap().apply {
            putString("credIdB64u", assertion.credIdB64u)
            putString("clientDataB64u", assertion.clientDataB64u)
            putString("authDataB64u", assertion.authDataB64u)
            putString("sigB64u", assertion.sigB64u)
          }
          Log.i(
            TAG,
            "getWalletPasskeyAssertion success credIdLen=${safeLen(assertion.credIdB64u)}",
          )
          promise.resolve(resultMap)
        }

        override fun onError(e: GetCredentialException) {
          logCredentialError("getWalletPasskeyAssertion", e)
          promise.reject("assertion_failed", describeCredentialError(e), e)
        }
      },
    )
  }

  private fun getPrf(
    activity: Activity,
    rpId: String,
    prfSalt: String,
    promise: Promise,
    isNew: Boolean,
    credentialIdHint: String?,
    createCredPubkey: String?,
    attempt: Int = 0,
    maxAttempts: Int = 0,
    retryDelayMs: Long = 0,
    assertionChallengeB64u: String? = null,
  ) {
    val includeAssertion = !assertionChallengeB64u.isNullOrEmpty()
    Log.i(
      TAG,
      "getWalletPasskeyPrf start rpId=$rpId isNew=$isNew includeAssertion=$includeAssertion attempt=$attempt credentialIdHintLen=${safeLen(credentialIdHint)} pkg=${activity.packageName}",
    )
    val credentialManager = CredentialManager.create(activity)
    val executor = ContextCompat.getMainExecutor(activity)
    val cancellationSignal = CancellationSignal()
    // Security: always constrain get() to the specific credential. For the create
    // fallback (isNew) that is the credential we just created — never widen to "any
    // credential" on retry, or the system picker could return an OLDER Nuri passkey
    // whose id would then be persisted against the NEW credential's public key,
    // permanently breaking Arkade auth/recovery. For the existing-wallet path
    // (isNew == false) credentialIdHint may be null, which correctly broadens.
    val allowCredentialId = credentialIdHint
    val requestJson = buildGetRequestJson(rpId, prfSalt, allowCredentialId, assertionChallengeB64u)
    Log.d(TAG, "getWalletPasskeyPrf requestJsonLen=${requestJson.length}")
    val option = GetPublicKeyCredentialOption(requestJson)
    val request = GetCredentialRequest.Builder()
      .addCredentialOption(option)
      .build()

    credentialManager.getCredentialAsync(
      activity,
      request,
      cancellationSignal,
      executor,
      object : CredentialManagerCallback<GetCredentialResponse, GetCredentialException> {
        override fun onResult(result: GetCredentialResponse) {
          Log.i(TAG, "getWalletPasskeyPrf getCredentialAsync success")
          val credential = result.credential
          if (credential !is PublicKeyCredential) {
            promise.reject("get_failed", "Unexpected credential type")
            return
          }

          val authJson = credential.authenticationResponseJson
          val prfB64u = extractPrfB64u(authJson)
          if (prfB64u.isNullOrEmpty()) {
            promise.reject("prf_missing", "Missing PRF output")
            return
          }

          val resolvedCredId = extractRawId(authJson) ?: credentialIdHint
          Log.i(
            TAG,
            "getWalletPasskeyPrf response meta prfPresent=true credIdLen=${safeLen(resolvedCredId)}",
          )
          // Fail closed: the PRF assertion for a create fallback MUST come from the
          // credential we just created. If the authenticator returned a different one,
          // reject instead of pairing an old credId with the new credential's pubkey.
          if (isNew && !credentialIdHint.isNullOrEmpty() && resolvedCredId != credentialIdHint) {
            Log.w(
              TAG,
              "getWalletPasskeyPrf credential mismatch on create fallback; expectedLen=${safeLen(credentialIdHint)} gotLen=${safeLen(resolvedCredId)} — failing closed",
            )
            promise.reject(
              "credential_mismatch",
              "Passkey PRF returned a different credential than the one just created",
            )
            return
          }
          val resultMap = Arguments.createMap().apply {
            putString("prfB64", b64uToB64(prfB64u))
            if (!resolvedCredId.isNullOrEmpty()) putString("credIdB64u", resolvedCredId)
            if (!createCredPubkey.isNullOrEmpty()) putString("credPubkeyB64u", createCredPubkey)
            putBoolean("isNew", isNew)
          }
          if (includeAssertion) {
            val assertion = extractAssertionPayload(authJson, resolvedCredId ?: credentialIdHint)
            if (assertion == null) {
              promise.reject("assertion_failed", "Missing assertion fields")
              return
            }
            resultMap.putString("clientDataB64u", assertion.clientDataB64u)
            resultMap.putString("authDataB64u", assertion.authDataB64u)
            resultMap.putString("sigB64u", assertion.sigB64u)
          }
          promise.resolve(resultMap)
        }

        override fun onError(e: GetCredentialException) {
          val isNoCredential = e.type.contains("NO_CREDENTIAL")
          if (isNew && attempt < maxAttempts && (e is GetCredentialCancellationException || isNoCredential)) {
            Log.w(
              TAG,
              "getWalletPasskeyPrf transient failure; retrying attempt=${attempt + 1} delayMs=$retryDelayMs type=${e.type}",
            )
            Handler(Looper.getMainLooper()).postDelayed(
              {
                getPrf(
                  activity,
                  rpId,
                  prfSalt,
                  promise,
                  isNew,
                  credentialIdHint,
                  createCredPubkey,
                  attempt + 1,
                  maxAttempts,
                  retryDelayMs,
                  assertionChallengeB64u,
                )
              },
              retryDelayMs,
            )
            return
          }
          if (isTimeoutError(e)) {
            Log.w(
              TAG,
              "getWalletPasskeyPrf timeout rpId=$rpId isNew=$isNew attempt=$attempt maxAttempts=$maxAttempts allowCredIdLen=${safeLen(allowCredentialId)} prfSaltLen=${prfSalt.length} pkg=${activity.packageName} sdk=${Build.VERSION.SDK_INT}",
            )
          }
          logCredentialError("getWalletPasskeyPrf", e)
          promise.reject("get_failed", describeCredentialError(e), e)
        }
      },
    )
  }

  private fun buildCreateRequestJson(
    rpId: String,
    prfSalt: String,
    labelOverride: String?,
  ): String {
    val labelCandidate = (labelOverride ?: "").trim()
    val label = if (labelCandidate.isNotEmpty()) labelCandidate else buildLabel()
    val json = JSONObject()
    json.put("challenge", b64uEncode(randomBytes(32)))
    json.put(
      "rp",
      JSONObject()
        .put("id", rpId)
        .put("name", "Nuri Wallet"),
    )
    json.put(
      "user",
      JSONObject()
        .put("id", b64uEncode(randomBytes(16)))
        .put("name", label)
        .put("displayName", label),
    )
    json.put(
      "pubKeyCredParams",
      JSONArray().put(JSONObject().put("type", "public-key").put("alg", -7)),
    )
    json.put(
      "authenticatorSelection",
      JSONObject()
        .put("residentKey", "required")
        .put("requireResidentKey", true)
        .put("userVerification", "required"),
    )
    val prfEval = JSONObject().put("first", b64uEncode(prfSalt.toByteArray(Charsets.UTF_8)))
    json.put("extensions", JSONObject().put("prf", JSONObject().put("eval", prfEval)))
    json.put("timeout", 60000)
    json.put("attestation", "none")
    return json.toString()
  }

  private fun buildGetRequestJson(
    rpId: String,
    prfSalt: String,
    allowCredentialId: String?,
    challengeB64u: String? = null,
  ): String {
    val json = JSONObject()
    json.put("challenge", challengeB64u?.takeIf { it.isNotEmpty() } ?: b64uEncode(randomBytes(32)))
    json.put("rpId", rpId)
    json.put("userVerification", "required")
    json.put("timeout", 60000)
    val eval = JSONObject().put("first", b64uEncode(prfSalt.toByteArray(Charsets.UTF_8)))
    json.put("extensions", JSONObject().put("prf", JSONObject().put("eval", eval)))
    if (!allowCredentialId.isNullOrEmpty()) {
      val allow = JSONObject()
        .put("type", "public-key")
        .put("id", allowCredentialId)
      json.put("allowCredentials", JSONArray().put(allow))
    }
    return json.toString()
  }

  private fun buildGetAssertionRequestJson(
    rpId: String,
    challengeB64u: String,
    allowCredentialId: String?,
  ): String {
    val json = JSONObject()
    json.put("challenge", challengeB64u)
    json.put("rpId", rpId)
    json.put("userVerification", "required")
    json.put("timeout", 60000)
    if (!allowCredentialId.isNullOrEmpty()) {
      val allow = JSONObject()
        .put("type", "public-key")
        .put("id", allowCredentialId)
      json.put("allowCredentials", JSONArray().put(allow))
    }
    return json.toString()
  }

  private fun extractRawId(json: String): String? {
    return try {
      val obj = JSONObject(json)
      val rawId = obj.optString("rawId", "")
      if (rawId.isNotEmpty()) rawId else null
    } catch (_: Exception) {
      null
    }
  }

  private fun extractPublicKey(json: String): String? {
    return try {
      val obj = JSONObject(json)
      val response = obj.optJSONObject("response")
      val attestationB64u = response?.optString("attestationObject", "") ?: ""
      if (attestationB64u.isEmpty()) {
        Log.w(TAG, "extractPublicKey missing attestationObject")
        null
      } else {
        val pubKeyRaw = extractCredPubkeyFromAttestation(attestationB64u) ?: return null
        b64uEncode(pubKeyRaw)
      }
    } catch (_: Exception) {
      null
    }
  }

  private fun extractCredPubkeyFromAttestation(attestationB64u: String): ByteArray? {
    return try {
      val attestationBytes = b64uDecode(attestationB64u)
      val attestation = CBORObject.DecodeFromBytes(attestationBytes)
      val authDataObj = attestation.get(CBORObject.FromObject("authData")) ?: return null
      val authData = authDataObj.GetByteString()
      extractCredPubkeyFromAuthData(authData)
    } catch (_: Exception) {
      Log.w(TAG, "extractCredPubkeyFromAttestation failed")
      null
    }
  }

  private fun extractCredPubkeyFromAuthData(authData: ByteArray): ByteArray? {
    if (authData.size < 37) return null
    val flags = authData[32].toInt() and 0xFF
    if ((flags and FLAG_AT) == 0) return null
    var offset = 37
    if (authData.size < offset + 16 + 2) return null
    offset += 16
    val credIdLen =
      ((authData[offset].toInt() and 0xFF) shl 8) or (authData[offset + 1].toInt() and 0xFF)
    offset += 2
    if (authData.size < offset + credIdLen) return null
    offset += credIdLen
    if (authData.size <= offset) return null
    val cose = readCborObject(authData, offset) ?: return null
    val xObj = cose.get(CBORObject.FromObject(-2)) ?: return null
    val yObj = cose.get(CBORObject.FromObject(-3)) ?: return null
    val x = xObj.GetByteString()
    val y = yObj.GetByteString()
    if (x.size != 32 || y.size != 32) return null
    val raw = ByteArray(65)
    raw[0] = 0x04
    System.arraycopy(x, 0, raw, 1, 32)
    System.arraycopy(y, 0, raw, 33, 32)
    return raw
  }

  private fun readCborObject(data: ByteArray, offset: Int): CBORObject? {
    return try {
      val input = ByteArrayInputStream(data, offset, data.size - offset)
      CBORObject.Read(input)
    } catch (_: Exception) {
      null
    }
  }

  private fun logCredentialError(phase: String, e: Exception) {
    val type = when (e) {
      is CreateCredentialException -> e.type
      is GetCredentialException -> e.type
      else -> ""
    }
    val cause = e.cause
    val causeInfo = if (cause != null) "${cause.javaClass.simpleName}:${cause.message}" else "none"
    val typeInfo = if (type.isNotEmpty()) " type=$type" else ""
    Log.w(
      TAG,
      "$phase failed${typeInfo} class=${e.javaClass.simpleName} cause=$causeInfo msg=${e.message}",
      e,
    )
  }

  private fun isTimeoutError(e: Exception): Boolean {
    val message = e.message ?: return false
    return message.contains("timed out", ignoreCase = true)
  }

  private fun describeCredentialError(e: Exception): String {
    val type = when (e) {
      is CreateCredentialException -> e.type
      is GetCredentialException -> e.type
      else -> ""
    }
    val cause = e.cause
    val causeInfo = if (cause != null) "${cause.javaClass.simpleName}:${cause.message}" else ""
    val typeInfo = if (type.isNotEmpty()) " type=$type" else ""
    val causeSuffix = if (causeInfo.isNotEmpty()) " cause=$causeInfo" else ""
    val msg = e.message ?: "unknown"
    return "$msg$typeInfo$causeSuffix"
  }

  private fun safeLen(value: String?): Int {
    return value?.length ?: 0
  }

  private fun extractPrfB64u(json: String): String? {
    return try {
      val obj = JSONObject(json)
      val ext = obj.optJSONObject("clientExtensionResults") ?: return null
      val prf = ext.optJSONObject("prf") ?: return null
      val results = prf.optJSONObject("results") ?: prf
      val first = results.optString("first", "")
      if (first.isNotEmpty()) first else null
    } catch (_: Exception) {
      null
    }
  }

  private data class AssertionPayload(
    val credIdB64u: String,
    val clientDataB64u: String,
    val authDataB64u: String,
    val sigB64u: String,
  )

  private fun extractAssertionPayload(json: String, fallbackCredId: String?): AssertionPayload? {
    return try {
      val obj = JSONObject(json)
      val response = obj.optJSONObject("response") ?: return null
      val credIdB64u = obj.optString("rawId", "").ifEmpty { fallbackCredId ?: "" }
      val clientDataB64u = response.optString("clientDataJSON", "")
      val authDataB64u = response.optString("authenticatorData", "")
      val sigB64u = response.optString("signature", "")
      if (credIdB64u.isEmpty() || clientDataB64u.isEmpty() || authDataB64u.isEmpty() || sigB64u.isEmpty()) {
        null
      } else {
        AssertionPayload(
          credIdB64u = credIdB64u,
          clientDataB64u = clientDataB64u,
          authDataB64u = authDataB64u,
          sigB64u = sigB64u,
        )
      }
    } catch (_: Exception) {
      null
    }
  }

  private fun buildLabel(): String {
    return try {
      val fmt = SimpleDateFormat("dd-MMM-yy,HH:mm", Locale.US)
      "Nuri (${fmt.format(Date())})"
    } catch (_: Exception) {
      "Nuri"
    }
  }

  private fun randomBytes(len: Int): ByteArray {
    val bytes = ByteArray(len)
    SecureRandom().nextBytes(bytes)
    return bytes
  }

  private fun b64uEncode(bytes: ByteArray): String {
    return Base64.encodeToString(
      bytes,
      Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP,
    )
  }

  private fun b64uDecode(b64u: String): ByteArray {
    val normalized = b64u.replace('-', '+').replace('_', '/')
    val padding = (4 - normalized.length % 4) % 4
    val padded = normalized + "=".repeat(padding)
    return Base64.decode(padded, Base64.DEFAULT)
  }

  private fun b64uToB64(b64u: String): String {
    val decoded = b64uDecode(b64u)
    return Base64.encodeToString(decoded, Base64.NO_WRAP)
  }
}
