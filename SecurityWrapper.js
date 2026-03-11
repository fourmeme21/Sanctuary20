/* ══════════════════════════════════════════════════════════════
   SecurityWrapper.js — Sanctuary Adım 11
   API anahtarı ve hassas veri şifreleme (XOR + Base64)
   ══════════════════════════════════════════════════════════════ */
(function() {
  'use strict';

  var _SALT = 'SanctuaryV1_' + (navigator.userAgent.length % 97);

  function _xor(str, key) {
    var out = '';
    for (var i = 0; i < str.length; i++) {
      out += String.fromCharCode(str.charCodeAt(i) ^ key.charCodeAt(i % key.length));
    }
    return out;
  }

  function encrypt(value) {
    try {
      var xored = _xor(String(value), _SALT);
      return btoa(unescape(encodeURIComponent(xored)));
    } catch(e) { return btoa(String(value)); }
  }

  function decrypt(encoded) {
    try {
      var xored = decodeURIComponent(escape(atob(encoded)));
      return _xor(xored, _SALT);
    } catch(e) { try { return atob(encoded); } catch(e2) { return encoded; } }
  }

  function setSecure(key, value) {
    try { localStorage.setItem('sec_' + key, encrypt(value)); } catch(e) {}
  }

  function getSecure(key) {
    try {
      var raw = localStorage.getItem('sec_' + key);
      return raw ? decrypt(raw) : null;
    } catch(e) { return null; }
  }

  function removeSecure(key) {
    try { localStorage.removeItem('sec_' + key); } catch(e) {}
  }

  window.SecurityWrapper = { encrypt: encrypt, decrypt: decrypt, setSecure: setSecure, getSecure: getSecure, removeSecure: removeSecure };
  console.info('[SecurityWrapper] Adım 11 hazır');
})();