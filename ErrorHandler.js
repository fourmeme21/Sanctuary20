/* ══════════════════════════════════════════════════════════════
   ErrorHandler.js — Sanctuary Adım 11
   Global hata yakalama ve fallback yönetimi
   ══════════════════════════════════════════════════════════════ */
(function() {
  'use strict';

  var _fallbackActive = false;

  /* Global hata dinleyicisi */
  window.addEventListener('error', function(e) {
    console.warn('[ErrorHandler] Hata yakalandı:', e.message);
    _handleError({ type: 'js', message: e.message, source: e.filename });
  });

  window.addEventListener('unhandledrejection', function(e) {
    console.warn('[ErrorHandler] Promise hatası:', e.reason);
    _handleError({ type: 'promise', message: String(e.reason) });
  });

  function _handleError(err) {
    /* Gemini API hatası */
    if (err.message && (err.message.includes('Gemini') || err.message.includes('API') || err.message.includes('fetch'))) {
      _activateFallback('api');
      return;
    }
    /* WebRTC hatası */
    if (err.message && err.message.includes('RTCPeer')) {
      _activateFallback('webrtc');
      return;
    }
  }

  function _activateFallback(reason) {
    if (_fallbackActive) return;
    _fallbackActive = true;
    console.info('[ErrorHandler] Fallback aktif:', reason);
    _showToast(reason === 'api' ? '✦ Yerel mod aktif' : '⚠ Bağlantı kesildi, devam ediyor', 'warn');
    /* AudioEngine çalışıyorsa durdurma */
    if (window._playing === false && window.togglePlay) {
      /* Ses zaten duruyorsa başlat */
    }
  }

  function _showToast(msg, type) {
    if (window.OfflineManager) window.OfflineManager.showToast(msg, type);
    else {
      var t = document.createElement('div');
      t.textContent = msg;
      t.style.cssText = 'position:fixed;top:16px;right:16px;background:rgba(6,10,24,0.95);border:1px solid rgba(201,169,110,0.3);border-radius:12px;padding:8px 14px;font-size:11px;color:#c9a96e;letter-spacing:1px;z-index:1000;pointer-events:none;';
      document.body.appendChild(t);
      setTimeout(function(){ t.remove(); }, 4000);
    }
  }

  function reportError(err, context) {
    console.warn('[ErrorHandler]', context || '', err);
    _handleError({ message: String(err), type: 'manual' });
  }

  window.ErrorHandler = { reportError: reportError, showToast: _showToast };
  console.info('[ErrorHandler] Adım 11 hazır');
})();