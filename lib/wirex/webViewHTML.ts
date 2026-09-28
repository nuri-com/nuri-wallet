import { WALLET_RP_ID } from "../../config/passkey";

const rpId = WALLET_RP_ID;

export const HARDWARE_KEY_CAPTURE_WEBVIEW_HTML = `<!doctype html>
<html>
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1.0,maximum-scale=1.0,user-scalable=no" />
    <title>Hardware Key WebAuthn</title>
    <style>
      body { margin:0; padding:0; font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif; background: transparent; display:flex; flex-direction:column; justify-content:flex-end; height:100vh; }
      .bar { padding:16px; }
      p { margin:0 0 12px 0; font-size:13px; color:#2C232E; line-height:1.35; }
      button { width:100%; padding:16px; border-radius:100px; border:none; font-size:16px; margin:0 0 12px 0; font-weight:600; background:#000000; color:#FFFFFF; }
    </style>
  </head>
  <body>
    <div class="bar">
      <p>Create a WebAuthn credential with your hardware key.</p>
      <button id="create">Create Hardware Key Credential</button>
    </div>
    <script>
      (function(){
        function post(m){ try { window.ReactNativeWebView.postMessage(m); } catch(_){} }
        function toB64(buf){ try{ var bytes=new Uint8Array(buf); var bin=""; for(var i=0;i<bytes.length;i++) bin+=String.fromCharCode(bytes[i]); return btoa(bin);}catch(e){ return ""; } }
        function b64u(buf){ return toB64(buf).replace(/\\+/g,"-").replace(/\\//g,"_").replace(/=+$/g,""); }
        function readString(key){
          try {
            var value = window[key];
            if (typeof value === "string") return value.trim();
          } catch(_) {}
          return "";
        }
        var rpId = "${rpId}";
        try { var host=(location.hostname||"").toLowerCase(); if (host && host.endsWith("${rpId}")) rpId="${rpId}"; } catch(_){ rpId="${rpId}"; }
        function buildLabel(){
          var forced = readString("__nuriCreateLabel");
          if (forced) return forced;
          try{
            var d=new Date();
            return "Nuri Hardware Key " + d.toISOString();
          }catch(_){ return "Nuri Hardware Key"; }
        }
        function applyButtonLabels(){
          try {
            var createText = readString("__nuriCreateButtonText");
            if (createText) {
              var el = document.getElementById("create");
              if (el) el.textContent = createText;
            }
          } catch(_) {}
        }
        async function runCreate(){
          post("info:hardware_create_tapped");
          try{
            if (!navigator.credentials || !window.PublicKeyCredential) {
              post("error:webauthn:not_supported");
              return;
            }
            var userId = new Uint8Array(16);
            crypto.getRandomValues(userId);
            var challenge = new Uint8Array(32);
            crypto.getRandomValues(challenge);
            var label = buildLabel();
            var createOpts = {
              publicKey: {
                challenge: challenge,
                rp: { id: rpId, name: "Nuri Wallet" },
                user: { id: userId, name: label, displayName: label },
                pubKeyCredParams: [{ type: "public-key", alg: -7 }],
                authenticatorSelection: {
                  authenticatorAttachment: "cross-platform",
                  residentKey: "preferred",
                  requireResidentKey: false,
                  userVerification: "preferred"
                },
                timeout: 60000,
                attestation: "none"
              }
            };
            var cred = await navigator.credentials.create(createOpts);
            if (!cred) { post("error:hw_create:empty_credential"); return; }
            var credId = "";
            var credPub = "";
            try {
              var rawId = cred.rawId || null;
              if (rawId) credId = b64u(new Uint8Array(rawId));
            } catch(_) {}
            try {
              var spki = cred.response && cred.response.getPublicKey ? cred.response.getPublicKey() : null;
              if (spki) credPub = b64u(new Uint8Array(spki));
            } catch(_) {}
            post("wallet_hw_create:" + (credId || "") + ":" + (credPub || ""));
          } catch(e){
            var n=e&&e.name?e.name:"Error";
            var m=e&&e.message?e.message:String(e);
            post("error:hw_create:" + n + ":" + m);
          }
        }
        var createBtn = document.getElementById("create");
        if (createBtn) {
          createBtn.onclick = function(){ runCreate(); };
        } else {
            post("error:hardware_create_button_missing");
        }
        applyButtonLabels();
        post("info:hardware_ui_ready");
      })();
    </script>
  </body>
</html>`;

export const PASSKEY_METADATA_CAPTURE_WEBVIEW_HTML = `<!doctype html>
<html>
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1.0,maximum-scale=1.0,user-scalable=no" />
    <title>Nuri Wallet Passkey Metadata</title>
    <style>
      body { margin:0; padding:0; font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif; background:#f7f8fa; display:flex; flex-direction:column; justify-content:flex-end; height:100vh; }
      .bar { padding:16px; }
      .hint { margin:0 0 12px 0; font-size:13px; line-height:1.35; color:#2C232E; }
      button { width:100%; padding:16px; border-radius:100px; border:none; font-size:16px; margin:0 0 12px 0; font-weight:600; background:#000000; color:#FFFFFF; }
      #have { margin:0 0 12px 0; padding:12px 0; text-align:center; font-size:16px; font-weight:500; color:#2C232E; text-decoration:underline; cursor:pointer; }
    </style>
  </head>
  <body>
    <div class="bar">
      <p class="hint">Tap a button below to open passkey prompt.</p>
      <div id="have">Use existing Nuri Wallet Passkey</div>
      <button id="create">Create Nuri Wallet Passkey</button>
    </div>
    <script>
      (function(){
        function post(m){ try { window.ReactNativeWebView.postMessage(m); } catch(_){} }
        function toB64(buf){ try{ var bytes=new Uint8Array(buf); var bin=""; for(var i=0;i<bytes.length;i++) bin+=String.fromCharCode(bytes[i]); return btoa(bin);}catch(e){ post("error:toB64:"+(e&&e.message?e.message:e)); return ""; } }
        function b64u(buf){ return toB64(buf).replace(/\\+/g,"-").replace(/\\//g,"_").replace(/=+$/g,""); }
        function readString(key){
          try {
            var value = window[key];
            if (typeof value === "string") return value.trim();
          } catch(_) {}
          return "";
        }
        var rpId = "${rpId}";
        try { var host=(location.hostname||"").toLowerCase(); if (host && host.endsWith("${rpId}")) rpId="${rpId}"; } catch(_){ rpId="${rpId}"; }
        function randomBytes(size){ var value=new Uint8Array(size); crypto.getRandomValues(value); return value; }
        function buildLabel(){
          var forced = readString("__nuriCreateLabel");
          var requireManaged = readString("__nuriRequireManagedLabel") === "1";
          if (forced) return forced;
          if (requireManaged) return "";
          try{ return "Nuri Wallet " + new Date().toISOString(); } catch(_){ return "Nuri Wallet"; }
        }
        function applyButtonLabels(){
          try {
            var existingText = readString("__nuriExistingButtonText");
            if (existingText) {
              var haveEl = document.getElementById("have");
              if (haveEl) haveEl.textContent = existingText;
            }
            var createText = readString("__nuriCreateButtonText");
            if (createText) {
              var createEl = document.getElementById("create");
              if (createEl) createEl.textContent = createText;
            }
          } catch(_) {}
        }
        async function runCreate(){
          post("info:passkey_create_tapped");
          try{
            if (!navigator.credentials || !window.PublicKeyCredential) { post("error:webauthn:not_supported"); return; }
            var userId = randomBytes(16);
            var challenge = randomBytes(32);
            var label = buildLabel();
            if (!label) { post("error:create:missing_managed_label"); return; }
            var createOpts = {
              publicKey: {
                challenge: challenge,
                rp: { id: rpId, name: "Nuri Wallet" },
                user: { id: userId, name: label, displayName: label },
                pubKeyCredParams: [{ type: "public-key", alg: -7 }],
                authenticatorSelection: {
                  residentKey: "required",
                  requireResidentKey: true,
                  userVerification: "preferred"
                },
                timeout: 60000,
                attestation: "none"
              }
            };
            var cred = await navigator.credentials.create(createOpts);
            if (!cred) { post("error:create:empty_credential"); return; }
            var credId = "";
            var credPub = "";
            try {
              var rawId = cred.rawId || null;
              if (rawId) credId = b64u(new Uint8Array(rawId));
            } catch(_) {}
            try {
              var spki = cred.response && cred.response.getPublicKey ? cred.response.getPublicKey() : null;
              if (spki) credPub = b64u(new Uint8Array(spki));
            } catch(_) {}
            post("wallet_meta_create:" + (credId || "") + ":" + (credPub || ""));
          } catch(e){
            var n=e&&e.name?e.name:"Error";
            var m=e&&e.message?e.message:String(e);
            post("error:create:" + n + ":" + m);
          }
        }
        async function runExisting(){
          post("info:passkey_existing_tapped");
          try{
            if (!navigator.credentials || !window.PublicKeyCredential) { post("error:webauthn:not_supported_auth_only"); return; }
            var challenge = randomBytes(32);
            var getOpts = {
              publicKey: {
                challenge: challenge,
                rpId: rpId,
                userVerification: "preferred",
                timeout: 60000
              }
            };
            var assertion = await navigator.credentials.get(getOpts);
            if (!assertion) { post("error:get_existing:empty_assertion"); return; }
            var credId = "";
            try {
              var rawId = assertion.rawId || null;
              if (rawId) credId = b64u(new Uint8Array(rawId));
            } catch(_) {}
            post("wallet_meta_existing:" + (credId || ""));
          } catch(e){
            var n=e&&e.name?e.name:"Error";
            var m=e&&e.message?e.message:String(e);
            post("error:get_existing:" + n + ":" + m);
          }
        }
        var haveEl = document.getElementById("have");
        if (haveEl) {
          haveEl.onclick = function(){ runExisting(); };
        } else {
          post("error:existing_button_missing");
        }
        var createBtn = document.getElementById("create");
        if (createBtn) {
          createBtn.onclick = function(){ runCreate(); };
        } else {
          post("error:create_button_missing");
        }
        window.__nuriRunExisting = function(){ runExisting(); };
        window.__nuriRunCreate = function(){ runCreate(); };
        applyButtonLabels();
        post("info:passkey_ui_ready");
      })();
    </script>
  </body>
</html>`;
