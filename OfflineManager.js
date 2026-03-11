/* ══════════════════════════════════════════════════════════════
   OfflineManager.js — Sanctuary Adım 11
   Offline mod, bağlantı izleme, toast bildirimleri
   ══════════════════════════════════════════════════════════════ */
(function() {
  'use strict';

  var _isOnline    = navigator.onLine;
  var _toastEl     = null;
  var _statusEl    = null;

  /* Bağlantı izle */
  window.addEventListener('online',  function() { _setOnline(true);  });
  window.addEventListener('offline', function() { _setOnline(false); });

  function _setOnline(val) {
    _isOnline = val;
    if (val) {
      showToast('✦ Bağlantı yeniden kuruldu', 'ok');
      _updateStatusBadge(true);
    } else {
      showToast('◌ Çevrimdışı mod aktif', 'warn');
      _updateStatusBadge(false);
    }
  }

  function _updateStatusBadge(online) {
    var el = document.getElementById('connection-badge');
    if (!el) return;
    el.textContent = online ? '' : '◌ Çevrimdışı';
    el.style.display = online ? 'none' : 'block';
  }

  /* Toast bildirimi */
  function showToast(msg, type) {
    if (_toastEl) { _toastEl.remove(); _toastEl = null; }
    var el = document.createElement('div');
    el.id = 'sanctuary-toast';
    var color = type === 'ok' ? '#4ecdc4' : '#c9a96e';
    el.style.cssText = 'position:fixed;top:16px;right:16px;background:rgba(6,10,24,0.96);border:1px solid ' + color + '40;border-radius:12px;padding:8px 14px;font-size:11px;color:' + color + ';letter-spacing:1px;z-index:1000;pointer-events:none;opacity:0;transition:opacity 0.3s;max-width:200px;';
    el.textContent = msg;
    document.body.appendChild(el);
    _toastEl = el;
    setTimeout(function(){ el.style.opacity = '1'; }, 30);
    setTimeout(function(){ el.style.opacity = '0'; setTimeout(function(){ if(_toastEl===el){el.remove();_toastEl=null;} }, 300); }, 3500);
  }

  /* PreferenceVector önbellekle */
  function cachePreferences() {
    if (!window.PreferenceManager) return;
    try {
      var data = window.PreferenceManager.getVector();
      localStorage.setItem('sanctuary_pref_backup', JSON.stringify(data));
    } catch(e) {}
  }

  function isOnline() { return _isOnline; }

  window.OfflineManager = { showToast: showToast, cachePreferences: cachePreferences, isOnline: isOnline };

  /* Başlangıçta durum kontrolü */
  if (!_isOnline) {
    setTimeout(function(){ showToast('◌ Çevrimdışı mod aktif', 'warn'); }, 1000);
  }

  console.info('[OfflineManager] Adım 11 hazır. Online:', _isOnline);
})();