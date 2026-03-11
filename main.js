/**
 * main.js — Sanctuary 11. Aşama (Performans & Bellek Optimizasyonu)
 * ─────────────────────────────────────────────────────────────────────────────
 * 4. Aşama korundu. Ek değişiklikler (Phase 5):
 *   1. PageVisibilityManager — Sekme gizlenince Ripple/Waveform durur, CPU tasarrufu
 *   2. RenderGuard           — Oda listesi sadece veri değiştiğinde render edilir
 *   3. stopWaveformLoop()    — cancelAnimationFrame ile RAF döngüsü iptal edilir
 *   4. fetchWithTimeout      — cache: 'force-cache' destekli (SW ile entegre)
 *   5. Cleanup on unload     — beforeunload + pagehide'da tüm kaynaklar temizlenir
 * ─────────────────────────────────────────────────────────────────────────────
 * 4. Aşama özeti:
 *   - Toast Sistemi, Hata Yönetimi, Offline/Online panel, Loading Spinners, Fetch Timeout
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

/* ══════════════════════════════════════════════════════════════════
   PHASE 5 — BÖLÜM 0: PAGE VISIBILITY MANAGER
   Sekme arka plana geçince Ripple ve Waveform efektleri durur.
   Öne gelince otomatik devam eder. CPU ve pil tasarrufu sağlar.
══════════════════════════════════════════════════════════════════ */

var PageVisibilityManager = (function () {
  var _tabVisible  = !document.hidden;
  var _handlers    = [];   // { onHide, onShow } nesneleri
  var _listener    = null;

  function _onVisibilityChange() {
    _tabVisible = !document.hidden;
    _handlers.forEach(function (h) {
      try {
        if (!_tabVisible && typeof h.onHide === 'function') h.onHide();
        if (_tabVisible  && typeof h.onShow === 'function') h.onShow();
      } catch (e) {
        console.warn('[PageVisibilityManager] Handler hatası:', e);
      }
    });
    console.debug('[PageVisibilityManager] Sekme:', _tabVisible ? 'görünür' : 'gizli');
  }

  function init() {
    if (_listener) return; // zaten başlatılmış
    _listener = _onVisibilityChange;
    document.addEventListener('visibilitychange', _listener);
  }

  /** Yeni bir handler çifti kaydet. Cleanup için unregister fonksiyonu döner. */
  function register(onHide, onShow) {
    var h = { onHide: onHide, onShow: onShow };
    _handlers.push(h);
    return function unregister() {
      var idx = _handlers.indexOf(h);
      if (idx !== -1) _handlers.splice(idx, 1);
    };
  }

  function isVisible() { return _tabVisible; }

  function dispose() {
    if (_listener) {
      document.removeEventListener('visibilitychange', _listener);
      _listener = null;
    }
    _handlers = [];
  }

  return { init: init, register: register, isVisible: isVisible, dispose: dispose };
})();

/* ══════════════════════════════════════════════════════════════════
   PHASE 5 — BÖLÜM 0B: RENDER GUARD
   Oda listesi ve ses listelerinin gereksiz yeniden render edilmesini önler.
   Veriyi stringify ederek önceki versiyonla karşılaştırır (deep comparison).
   Veri değişmediyse DOM dokunulmaz → CPU ve layout tasarrufu.
══════════════════════════════════════════════════════════════════ */

var RenderGuard = (function () {
  var _lastHashes = {}; // key → string hash

  /**
   * data değişmediyse false döner (render atla).
   * data değiştiyse true döner (render gerekiyor) ve hash günceller.
   * @param {string} key  — benzersiz anahtar (örn: 'rooms', 'sounds')
   * @param {*}      data — karşılaştırılacak veri
   */
  function shouldRender(key, data) {
    try {
      var hash = JSON.stringify(data);
      if (_lastHashes[key] === hash) return false;
      _lastHashes[key] = hash;
      return true;
    } catch (e) {
      // JSON.stringify başarısız olursa her zaman render et
      return true;
    }
  }

  function invalidate(key) {
    delete _lastHashes[key];
  }

  function invalidateAll() {
    _lastHashes = {};
  }

  return { shouldRender: shouldRender, invalidate: invalidate, invalidateAll: invalidateAll };
})();

/* ══════════════════════════════════════════════════════════════════
   PHASE 5 — BÖLÜM 0C: GLOBAL RAF REGISTRY
   Tüm requestAnimationFrame ID'lerini takip eder.
   Temizlik gerektiğinde (sekme kapat, dispose) hepsini iptal eder.
══════════════════════════════════════════════════════════════════ */

var RAFRegistry = (function () {
  var _ids = new Set();

  function add(id) { _ids.add(id); return id; }

  function remove(id) {
    cancelAnimationFrame(id);
    _ids.delete(id);
  }

  function cancelAll() {
    _ids.forEach(function (id) { cancelAnimationFrame(id); });
    _ids.clear();
    console.info('[RAFRegistry] Tüm RAF döngüleri iptal edildi.');
  }

  return { add: add, remove: remove, cancelAll: cancelAll };
})();

/**
 * PHASE 5: stopWaveformLoop — tüm waveform RAF'larını cancelAnimationFrame ile iptal eder.
 * AudioEngine.stopWaveformLoop() ile birlikte çağrılmalıdır.
 */
function stopWaveformLoop() {
  RAFRegistry.cancelAll();
  /* AudioEngine entegrasyonu varsa */
  try {
    if (typeof AudioEngine !== 'undefined' && AudioEngine.getInstance) {
      AudioEngine.getInstance().stopWaveformLoop();
    }
  } catch (e) { /* AudioEngine henüz yüklenmemiş olabilir */ }
  console.info('[main] Waveform döngüsü durduruldu.');
}

/* ══════════════════════════════════════════════════════════════════
   BÖLÜM 1 — MERKEZI TOAST BİLDİRİM SİSTEMİ
   Cam efektli, 4 tip: success | error | warning | info
   Otomatik kapanır, progress bar gösterir, kapatılabilir.
══════════════════════════════════════════════════════════════════ */

var ToastManager = (function () {
  var container = null;
  var queue = [];
  var MAX_VISIBLE = 3;
  var visible = 0;

  var ICONS = {
    success : '✦',
    error   : '✕',
    warning : '⚠',
    info    : '◈'
  };

  var TITLES = {
    success : 'Başarılı',
    error   : 'Hata',
    warning : 'Uyarı',
    info    : 'Bilgi'
  };

  var DURATIONS = {
    success : 3500,
    error   : 5000,
    warning : 4500,
    info    : 3500
  };

  function getContainer() {
    if (container) return container;
    container = document.getElementById('toast-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'toast-container';
      document.body.appendChild(container);
    }
    return container;
  }

  function createToast(message, type, title, duration) {
    type     = type     || 'info';
    title    = title    || TITLES[type]  || 'Bilgi';
    duration = duration || DURATIONS[type] || 3500;

    var el = document.createElement('div');
    el.className = 'toast toast-' + type;
    el.setAttribute('role', 'alert');
    el.setAttribute('aria-live', 'polite');

    el.innerHTML = [
      '<span class="toast-icon">' + (ICONS[type] || '◈') + '</span>',
      '<div class="toast-body">',
      '  <div class="toast-title">' + _escapeHtml(title) + '</div>',
      '  <div class="toast-msg">'   + _escapeHtml(message) + '</div>',
      '</div>',
      '<button class="toast-close" aria-label="Kapat">×</button>',
      '<div class="toast-progress" style="animation-duration:' + duration + 'ms"></div>',
    ].join('');

    return { el: el, duration: duration };
  }

  function show(message, type, title, duration) {
    var toast = createToast(message, type, title, duration);
    var el    = toast.el;
    var ms    = toast.duration;

    var c = getContainer();
    c.appendChild(el);
    visible++;

    // Slide-up tetikle
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        el.classList.add('toast-show');
      });
    });

    // Kapatma butonu
    var closeBtn = el.querySelector('.toast-close');
    if (closeBtn) {
      closeBtn.addEventListener('click', function () { dismiss(el); });
    }

    // Otomatik kapat
    var timer = setTimeout(function () { dismiss(el); }, ms);

    // Hover'da duraklat
    el.addEventListener('mouseenter', function () { clearTimeout(timer); });
    el.addEventListener('mouseleave', function () {
      timer = setTimeout(function () { dismiss(el); }, 1500);
    });

    // Fazla toast varsa en eskiyi kapat
    if (visible > MAX_VISIBLE) {
      var oldest = c.querySelector('.toast');
      if (oldest && oldest !== el) dismiss(oldest);
    }

    return el;
  }

  function dismiss(el) {
    if (!el || el._dismissing) return;
    el._dismissing = true;
    el.classList.remove('toast-show');
    el.classList.add('toast-hide');
    visible = Math.max(0, visible - 1);
    setTimeout(function () {
      if (el.parentNode) el.parentNode.removeChild(el);
    }, 380);
  }

  function _escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  return {
    show    : show,
    success : function (msg, title, dur) { return show(msg, 'success', title, dur); },
    error   : function (msg, title, dur) { return show(msg, 'error',   title, dur); },
    warning : function (msg, title, dur) { return show(msg, 'warning', title, dur); },
    info    : function (msg, title, dur) { return show(msg, 'info',    title, dur); },
    dismiss : dismiss
  };
})();

/* Geriye dönük uyumluluk — eski showToast() çağrıları çalışmaya devam eder */
function showToast(message, type, title) {
  type = type || 'info';
  console.info('[Toast]', type.toUpperCase() + ':', message);
  return ToastManager.show(message, type, title);
}

/* ══════════════════════════════════════════════════════════════════
   BÖLÜM 2 — ONLINE / OFFLINE PANEL
   İnternet kesilince kırmızı banner, gelince yeşil flash gösterilir.
══════════════════════════════════════════════════════════════════ */

var NetworkMonitor = (function () {
  var offlinePanel = null;
  var onlineFlash  = null;
  var _isOnline    = navigator.onLine;

  function getOfflinePanel() {
    if (offlinePanel) return offlinePanel;
    offlinePanel = document.getElementById('offline-panel');
    if (!offlinePanel) {
      offlinePanel = document.createElement('div');
      offlinePanel.id = 'offline-panel';
      offlinePanel.innerHTML = [
        '<span class="offline-dot"></span>',
        '<div class="offline-text">',
        '  <span class="offline-title">İnternet Bağlantısı Kesildi</span>',
        '  <span class="offline-sub">Çevrimdışı Mod Aktif — Temel Sahneler Kullanılabilir</span>',
        '</div>',
        '<span class="offline-icon">📡</span>',
      ].join('');
      document.body.insertBefore(offlinePanel, document.body.firstChild);
    }
    return offlinePanel;
  }

  function getOnlineFlash() {
    if (onlineFlash) return onlineFlash;
    onlineFlash = document.getElementById('online-flash');
    if (!onlineFlash) {
      onlineFlash = document.createElement('div');
      onlineFlash.id = 'online-flash';
      onlineFlash.innerHTML = '<span style="font-size:14px">✦</span> <span class="online-flash-text">Bağlantı Yeniden Sağlandı</span>';
      onlineFlash.setAttribute('aria-live', 'polite');
      document.body.insertBefore(onlineFlash, document.body.firstChild);
    }
    return onlineFlash;
  }

  function handleOffline() {
    _isOnline = false;
    console.warn('[NetworkMonitor] Çevrimdışı.');
    var panel = getOfflinePanel();
    panel.classList.add('show');
  }

  function handleOnline() {
    _isOnline = true;
    console.info('[NetworkMonitor] Çevrimiçi.');

    // Offline paneli kapat
    var panel = getOfflinePanel();
    panel.classList.remove('show');

    // Online flash göster
    var flash = getOnlineFlash();
    flash.classList.add('show');
    setTimeout(function () { flash.classList.remove('show'); }, 2800);

    ToastManager.success('İnternet bağlantısı yeniden sağlandı.', 'Bağlandı');
  }

  function init() {
    window.addEventListener('online',  handleOnline);
    window.addEventListener('offline', handleOffline);

    // Sayfa açılırken zaten çevrimdışıysa hemen göster
    if (!navigator.onLine) {
      handleOffline();
    }
  }

  return {
    init     : init,
    isOnline : function () { return _isOnline; }
  };
})();

/* ══════════════════════════════════════════════════════════════════
   BÖLÜM 3 — FETCH WRAPPER (10 saniyelik timeout)
   fetchWithTimeout() — standart fetch yerine her yerde bu kullanılır.
══════════════════════════════════════════════════════════════════ */

function fetchWithTimeout(url, options, timeoutMs) {
  timeoutMs = timeoutMs || 10000;
  options   = options   || {};

  /* PHASE 5: Ses dosyaları için cache: force-cache ekle (SW ile entegre) */
  if (!options.cache) {
    var urlLower = (url || '').toLowerCase();
    if (/\.(mp3|ogg|wav|m4a|aac|flac|webm)(\?|$)/.test(urlLower) ||
        urlLower.includes('/audio/')) {
      options.cache = 'force-cache';
    }
  }

  var controller = new AbortController();
  options.signal = controller.signal;

  var timeoutId = setTimeout(function () {
    controller.abort();
    console.error('[fetchWithTimeout] İstek zaman aşımına uğradı:', url);
  }, timeoutMs);

  return fetch(url, options)
    .then(function (response) {
      clearTimeout(timeoutId);
      if (!response.ok) {
        throw new Error('HTTP ' + response.status + ': ' + response.statusText);
      }
      return response;
    })
    .catch(function (err) {
      clearTimeout(timeoutId);
      if (err.name === 'AbortError') {
        console.error('[fetchWithTimeout] Timeout:', url);
        ToastManager.error(
          'Sunucudan yanıt alınamadı. Lütfen tekrar deneyin.',
          'İşlem Zaman Aşımına Uğradı',
          6000
        );
        throw new Error('TIMEOUT: ' + url);
      }
      if (!navigator.onLine) {
        ToastManager.error('İnternet bağlantısı yok. Lütfen bağlantınızı kontrol edin.', 'Bağlantı Hatası');
      } else {
        ToastManager.error('Bağlantı hatası: ' + err.message, 'Ağ Hatası');
      }
      throw err;
    });
}

/* ══════════════════════════════════════════════════════════════════
   BÖLÜM 4 — LOADING SPINNER YARDIMCILARI
   Buton, konteyner veya play butonu için spinner ekler/kaldırır.
══════════════════════════════════════════════════════════════════ */

var LoadingManager = (function () {

  /**
   * Butona spinner ekler, disabled yapar.
   * @returns {function} restore — orijinal metni geri getirir
   */
  function setButtonLoading(btn, loadingText) {
    if (!btn) return function () {};
    var originalHTML = btn.innerHTML;
    var originalDisabled = btn.disabled;
    loadingText = loadingText || '';

    btn.disabled = true;
    btn.innerHTML = '<span class="spinner spinner-sm"></span>'
      + (loadingText ? '<span style="margin-left:8px">' + loadingText + '</span>' : '');

    return function restore() {
      btn.disabled  = originalDisabled;
      btn.innerHTML = originalHTML;
    };
  }

  /**
   * Play butonuna özel spinner (altın rengi, büyük)
   */
  function setPlayLoading(playBtn, on) {
    if (!playBtn) return;
    var iconEl = playBtn.querySelector('.play-icon');
    if (!iconEl) return;

    if (on) {
      // Spinner olarak değiştir
      iconEl.dataset.originalText = iconEl.textContent;
      iconEl.style.display = 'none';

      var spinner = playBtn.querySelector('.play-spinner');
      if (!spinner) {
        spinner = document.createElement('span');
        spinner.className = 'spinner spinner-gold play-spinner';
        playBtn.appendChild(spinner);
      }
      spinner.style.display = 'inline-block';
    } else {
      // Orijinal ikona geri dön
      if (iconEl) iconEl.style.display = '';
      var sp = playBtn.querySelector('.play-spinner');
      if (sp) sp.style.display = 'none';
    }
  }

  /**
   * Oda listesi için skeleton loader
   */
  function showRoomsSkeleton(container, count) {
    if (!container) return;
    count = count || 4;
    var html = '';
    for (var i = 0; i < count; i++) {
      html += [
        '<div class="skeleton-card">',
        '  <div class="sk-line short skeleton"></div>',
        '  <div class="sk-line mid skeleton"   style="margin-top:10px"></div>',
        '  <div class="sk-line long skeleton"  style="margin-top:8px"></div>',
        '  <div style="display:flex;align-items:center;gap:8px;margin-top:14px">',
        '    <div class="sk-circle skeleton"></div>',
        '    <div class="sk-line short skeleton" style="margin:0"></div>',
        '  </div>',
        '</div>',
      ].join('');
    }
    container.innerHTML = html;
  }

  /**
   * Genel overlay loader (tam ekran değil, element üzerinde)
   */
  function showOverlay(parentEl, message) {
    if (!parentEl) return function () {};
    var overlay = document.createElement('div');
    overlay.className = 'loading-overlay';
    overlay.innerHTML = [
      '<div class="loading-overlay-inner">',
      '  <span class="spinner spinner-lg spinner-violet"></span>',
      message ? '<span class="loading-overlay-text">' + message + '</span>' : '',
      '</div>',
    ].join('');

    var pos = window.getComputedStyle(parentEl).position;
    if (pos === 'static') parentEl.style.position = 'relative';
    parentEl.appendChild(overlay);

    return function hideOverlay() {
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      if (pos === 'static') parentEl.style.position = '';
    };
  }

  return {
    setButtonLoading  : setButtonLoading,
    setPlayLoading    : setPlayLoading,
    showRoomsSkeleton : showRoomsSkeleton,
    showOverlay       : showOverlay
  };
})();

/* ══════════════════════════════════════════════════════════════════
   BÖLÜM 5 — RİPPLE EFEKTİ (Çok Halkalı Su Dalgası)
   mousedown + touchstart desteği
   Her tıklamada 3 halka oluşur, CSS animasyonu ile kaybolur.
══════════════════════════════════════════════════════════════════ */

function initRippleEffect() {
  var RING_COUNT  = 3;
  var RING_DELAYS = [0, 120, 260];

  function spawnRippleAt(x, y) {
    var size = Math.max(window.innerWidth, window.innerHeight) * 0.72;

    for (var i = 0; i < RING_COUNT; i++) {
      ;(function (delay, idx) {
        setTimeout(function () {
          var ring = document.createElement('div');
          ring.className    = 'ripple-circle';
          ring.dataset.ring = idx + 1;

          ring.style.cssText = [
            'position:fixed',
            'width:'  + size + 'px',
            'height:' + size + 'px',
            'left:'   + x   + 'px',
            'top:'    + y   + 'px',
            'border-radius:50%',
            'pointer-events:none',
            'transform:translate(-50%,-50%) scale(0)',
            'z-index:9999',
          ].join(';');

          var styles = [
            { border: '1px solid rgba(201,169,110,0.32)', animDuration: '1.8s' },
            { border: '1px solid rgba(201,169,110,0.17)', animDuration: '2.15s' },
            { border: '1px solid rgba(170,130,220,0.11)', animDuration: '2.55s' },
          ];
          var s = styles[idx] || styles[0];
          ring.style.border     = s.border;
          ring.style.animation  = 'rippleExpand ' + s.animDuration + ' cubic-bezier(0.2,0,0.4,1) forwards';
          ring.style.willChange = 'transform, opacity';

          document.body.appendChild(ring);
          ring.addEventListener('animationend', function () { ring.remove(); }, { once: true });
        }, delay);
      })(RING_DELAYS[i], i);
    }
  }

  document.addEventListener('mousedown', function (e) {
    if (window._rippleDisabled) return; /* PHASE 5: sekme gizliyse ripple spawn etme */
    if (e.target.closest('button, .cta-btn, .play-btn, .back-btn, input, textarea, select')) return;
    spawnRippleAt(e.clientX, e.clientY);
  });

  document.addEventListener('touchstart', function (e) {
    if (window._rippleDisabled) return; /* PHASE 5 */
    if (e.target.closest('button, .cta-btn, .play-btn, .back-btn, input, textarea, select')) return;
    var t = e.touches[0];
    spawnRippleAt(t.clientX, t.clientY);
  }, { passive: true });
}

/* ══════════════════════════════════════════════════════════════════
   BÖLÜM 6 — SEKME GEÇİŞ ANİMASYONLARI
   switchTab() global fonksiyonunu override eder.
   İçerik blur+fade-in (0.3s) ile gelir.
══════════════════════════════════════════════════════════════════ */

function initTabAnimations() {
  window.switchTab = function (tabId) {
    var panels  = document.querySelectorAll('.tab-panel');
    var buttons = document.querySelectorAll('.tab-item');

    panels.forEach(function (el) { el.classList.remove('active'); });
    buttons.forEach(function (el) {
      el.classList.remove('active');
      el.setAttribute('aria-selected', 'false');
    });

    var target = document.getElementById(tabId);
    if (target) {
      target.classList.remove('active');
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          target.classList.add('active');
        });
      });
    }

    var btnId     = 'tab-btn-' + tabId.replace('tab-', '');
    var activeBtn = document.getElementById(btnId);
    if (activeBtn) {
      activeBtn.classList.add('active');
      activeBtn.setAttribute('aria-selected', 'true');
    }

    if (tabId === 'tab-journal') {
      var d = document.getElementById('journal-date');
      if (d) d.textContent = new Date().toLocaleDateString('tr-TR', {
        weekday: 'long', day: 'numeric', month: 'long'
      });
    }
  };
}

/* ══════════════════════════════════════════════════════════════════
   BÖLÜM 7 — NEFES DÖNGÜSÜ (Ses Senkronlu)
   engine.fadeTo() ile nefes hızına ses seviyesi uyarlanır.
══════════════════════════════════════════════════════════════════ */

function startBreathCycle(engine, breathWrap, guideEl, options) {
  options = options || {};

  var inhale    = options.inhale    || 4;
  var hold      = options.hold      || 2;
  var exhale    = options.exhale    || 6;
  var volInhale = options.volInhale || 0.85;
  var volExhale = options.volExhale || 0.55;

  var stopped = false;
  var timers  = [];

  function clearTimers() {
    timers.forEach(clearTimeout);
    timers = [];
  }

  function setGuide(text, active) {
    if (!guideEl) return;
    guideEl.textContent = text;
    guideEl.classList.toggle('on', active === undefined ? true : active);
  }

  function setBreathClass(cls) {
    if (!breathWrap) return;
    breathWrap.classList.remove('breath-inhale', 'breath-hold', 'breath-exhale', 'breath-idle');
    if (cls) breathWrap.classList.add(cls);
    if (cls === 'breath-inhale') breathWrap.style.setProperty('--inhale-dur', inhale + 's');
    if (cls === 'breath-exhale') breathWrap.style.setProperty('--exhale-dur', exhale + 's');
  }

  function syncVolume(targetVol, durationSec) {
    if (!engine) return;
    try {
      if (typeof engine.fadeTo === 'function') {
        engine.fadeTo(targetVol, durationSec * 0.88);
      } else if (engine._layers && Array.isArray(engine._layers)) {
        engine._layers.forEach(function (layer) {
          if (typeof layer.fadeTo === 'function') {
            layer.fadeTo(targetVol, durationSec * 0.88);
          }
        });
      } else if (typeof engine.setMasterVolume === 'function') {
        engine.setMasterVolume(targetVol);
      }
    } catch (err) {
      console.warn('[BreathCycle] Volume sync hatası:', err);
      /* Ses senkronu kritik değil — sessizce devam et */
    }
  }

  /* PHASE 11 — Haptic helper: mobilde kısa titreşim */
  function _haptic(ms) {
    try {
      if (navigator.vibrate) navigator.vibrate(ms || 20);
    } catch (e) { /* iOS Safari desteklemez, sessizce geç */ }
  }

  function runCycle() {
    if (stopped) return;

    setBreathClass('breath-inhale');
    setGuide('Nefes al…');
    syncVolume(volInhale, inhale);
    _haptic(20); /* PHASE 11 — Nefes Al titreşimi */

    timers.push(setTimeout(function () {
      if (stopped) return;
      setBreathClass('breath-hold');
      setGuide('Tut…');

      timers.push(setTimeout(function () {
        if (stopped) return;
        setBreathClass('breath-exhale');
        setGuide('Nefes ver…');
        syncVolume(volExhale, exhale);
        _haptic(20); /* PHASE 11 — Nefes Ver titreşimi */

        timers.push(setTimeout(function () {
          if (stopped) return;
          runCycle();
        }, exhale * 1000));
      }, hold * 1000));
    }, inhale * 1000));
  }

  runCycle();

  return function stopBreathCycle() {
    stopped = true;
    clearTimers();
    setBreathClass('breath-idle');
    setGuide('', false);
    if (engine) syncVolume(0.70, 1.5);
  };
}

/* ══════════════════════════════════════════════════════════════════
   BÖLÜM 8 — API KEY GÜVENLİ YÜKLEME
══════════════════════════════════════════════════════════════════ */

function initApiKey(key) {
  if (!key || typeof key !== 'string') return;
  try {
    var state = (typeof getStateManager === 'function') ? getStateManager() : null;
    if (state && typeof state.setApiKey === 'function') {
      state.setApiKey(key.trim());
      console.info('[main] API key runtime belleğe yüklendi.');
      ToastManager.success('API anahtarı başarıyla yüklendi.', 'Hazır');
    }
  } catch (e) {
    console.error('[main] StateManager bulunamadı:', e);
    ToastManager.error('API anahtarı yüklenemedi: ' + e.message, 'API Hatası');
  }
}

function clearApiKey() {
  try {
    var state = (typeof getStateManager === 'function') ? getStateManager() : null;
    if (state && typeof state.clearApiKey === 'function') state.clearApiKey();
  } catch (e) {
    console.warn('[main] clearApiKey hatası:', e);
  }
}

/* ══════════════════════════════════════════════════════════════════
   BÖLÜM 9 — SES DOSYASI YÜKLEME (Hata Yönetimli)
   Ses yüklenirken play butonunda spinner gösterilir.
══════════════════════════════════════════════════════════════════ */

function loadAudioWithFeedback(audioEl, src, playBtn) {
  if (!audioEl) return;

  // Play butonunda loading göster
  if (playBtn) LoadingManager.setPlayLoading(playBtn, true);

  audioEl.src = src;
  audioEl.load();

  audioEl.addEventListener('canplaythrough', function onReady() {
    audioEl.removeEventListener('canplaythrough', onReady);
    if (playBtn) LoadingManager.setPlayLoading(playBtn, false);
    console.info('[Audio] Hazır:', src);
  }, { once: true });

  audioEl.addEventListener('error', function onErr(e) {
    audioEl.removeEventListener('error', onErr);
    if (playBtn) LoadingManager.setPlayLoading(playBtn, false);

    var code = audioEl.error ? audioEl.error.code : '?';
    console.error('[Audio] Ses dosyası yüklenemedi. Kod:', code, 'Src:', src);
    ToastManager.error(
      'Ses dosyası yüklenemedi. Lütfen tekrar deneyin.',
      'Ses Hatası',
      5000
    );
  }, { once: true });
}

/* ══════════════════════════════════════════════════════════════════
   BÖLÜM 10 — ODA UI YÖNETİMİ
══════════════════════════════════════════════════════════════════ */

function renderRoomList(container, category) {
  if (!container) return;

  /* PHASE 5: RenderGuard — veri değişmediyse DOM'a dokunma */
  var cacheKey = 'rooms:' + (category || 'all');

  // Skeleton loader göster (sadece ilk render veya kategori değişince)
  if (RenderGuard.shouldRender('rooms-skeleton-' + cacheKey, Date.now() - (Date.now() % 2000))) {
    LoadingManager.showRoomsSkeleton(container, 4);
  }

  setTimeout(function () {
    try {
      var data;

      if (typeof RoomManager === 'undefined') {
        data = _getDemoRoomsData();
      } else {
        data = RoomManager.getPublicRooms(category || null) || [];
      }

      /* PHASE 5: Veri değişmediyse render atla */
      if (!RenderGuard.shouldRender(cacheKey, data)) {
        console.debug('[renderRoomList] Veri değişmedi, render atlandı:', cacheKey);
        return;
      }

      if (typeof RoomManager === 'undefined') {
        container.innerHTML = _demoRoomsHTML();
        _bindRoomCards(container);
        return;
      }

      if (!data || data.length === 0) {
        container.innerHTML = [
          '<div class="empty-state">',
          '  <div class="empty-icon">🌿</div>',
          '  <p class="empty-title">Henüz aktif oda yok</p>',
          '  <p class="empty-sub">İlk odayı sen kur ve herkesi davet et.</p>',
          '  <button class="btn-start-first" id="btn-first-room">Oda Kur</button>',
          '</div>',
        ].join('');
        var firstBtn = document.getElementById('btn-first-room');
        if (firstBtn) firstBtn.addEventListener('click', function () { handleCreateRoom(); });
        return;
      }

      container.innerHTML = data.map(function (room) {
        var card    = RoomManager.buildRoomCard(room);
        var fillPct = Math.round(card.capacityFill * 100);
        return _buildCardHTML(card, fillPct);
      }).join('');

      _bindRoomCards(container);
    } catch (err) {
      console.error('[renderRoomList] Oda listesi yüklenemedi:', err);
      ToastManager.error('Oda listesi yüklenemedi. Sayfayı yenileyin.', 'Yükleme Hatası');
      container.innerHTML = '<div class="empty-state"><div class="empty-icon">⚠️</div><p class="empty-title">Yükleme başarısız</p></div>';
    }
  }, 400);
}

function _getDemoRoomsData() {
  return [
    { id: 'd1', name: 'Gece Odak',        category: 'Odak',      current: 3, capacity: 8,  isPrivate: false, hostId: 'A' },
    { id: 'd2', name: 'Derin Uyku',        category: 'Uyku',      current: 5, capacity: 10, isPrivate: false, hostId: 'B' },
    { id: 'd3', name: 'Şifa Meditasyonu', category: 'Meditasyon', current: 2, capacity: 5,  isPrivate: true,  hostId: 'C' },
    { id: 'd4', name: 'Sabah Enerjisi',   category: 'Doğa',       current: 7, capacity: 12, isPrivate: false, hostId: 'D' },
  ];
}

function _demoRoomsHTML() {
  return _getDemoRoomsData().map(function (card) {
    var fillPct = Math.round((card.current / card.capacity) * 100);
    return _buildCardHTML(card, fillPct);
  }).join('');
}

function _buildCardHTML(card, fillPct) {
  return [
    '<div class="room-card" data-room-id="' + card.id + '">',
    '  <div class="card-top">',
    '    <span class="badge-live"><span class="dot"></span> CANLI</span>',
    card.isPrivate
      ? '    <span class="badge-private"><svg viewBox="0 0 12 12" fill="currentColor"><path d="M6 1a2.5 2.5 0 0 0-2.5 2.5V5H3v5h6V5h-.5V3.5A2.5 2.5 0 0 0 6 1zm1.5 4h-3V3.5a1.5 1.5 0 0 1 3 0V5z"/></svg>Özel</span>'
      : '',
    '  </div>',
    '  <p class="room-name">'     + card.name     + '</p>',
    '  <p class="room-category">' + card.category + '</p>',
    '  <div class="card-footer">',
    '    <div class="host-info">',
    '      <div class="host-avatar">' + ((card.hostId || 'H')[0].toUpperCase()) + '</div>',
    '      <span class="host-name">Host</span>',
    '    </div>',
    '    <div class="capacity-bar-wrap">',
    '      <p class="capacity-text">' + card.current + '/' + card.capacity + '</p>',
    '      <div class="capacity-bar"><div class="capacity-fill" style="width:' + fillPct + '%"></div></div>',
    '    </div>',
    '  </div>',
    '</div>',
  ].join('');
}

function _bindRoomCards(container) {
  container.querySelectorAll('.room-card').forEach(function (card) {
    card.addEventListener('click', function () {
      var roomId = card.dataset.roomId;
      if (roomId) handleJoinRoom(roomId);
    });
  });
}

/* ══════════════════════════════════════════════════════════════════
   BÖLÜM 11 — ODA HANDLER'LARI (Hata Yönetimli)
══════════════════════════════════════════════════════════════════ */

function handleCreateRoom(formData) {
  formData = formData || {};

  if (typeof RoomManager === 'undefined') {
    console.error('[handleCreateRoom] RoomManager yüklenmedi.');
    ToastManager.error('Oda sistemi şu an kullanılamıyor. Lütfen sayfayı yenileyin.', 'Sistem Hatası');
    return null;
  }

  try {
    var result = RoomManager.createRoom(formData);
    if (!result.success) {
      if (result.error && result.error.includes('Premium')) {
        document.dispatchEvent(new CustomEvent('sanctuary:showPaywall', { detail: { reason: result.error } }));
      } else {
        console.error('[handleCreateRoom] Hata:', result.error);
        ToastManager.error(result.error || 'Oda oluşturulamadı.', 'Oda Hatası');
      }
      return null;
    }
    ToastManager.success('"' + (result.room && result.room.name) + '" odası oluşturuldu!', 'Oda Kuruldu');
    var grid = document.querySelector('.rooms-grid');
    if (grid) renderRoomList(grid);
    return result.room;
  } catch (err) {
    console.error('[handleCreateRoom] Beklenmedik hata:', err);
    ToastManager.error('Beklenmedik bir hata oluştu. Lütfen tekrar deneyin.', 'Hata');
    return null;
  }
}

function handleJoinRoom(roomId, password) {
  if (typeof RoomManager === 'undefined') {
    console.error('[handleJoinRoom] RoomManager yüklenmedi.');
    ToastManager.error('Oda sistemi şu an kullanılamıyor.', 'Sistem Hatası');
    return;
  }

  try {
    password = password || null;
    var room   = RoomManager.getRoomById(roomId);
    if (!room) {
      console.error('[handleJoinRoom] Oda bulunamadı:', roomId);
      ToastManager.error('Bu oda artık mevcut değil.', 'Oda Bulunamadı');
      return;
    }

    var result = RoomManager.joinRoom(roomId, password);
    if (!result.success) {
      if (result.error && result.error.includes('Premium')) {
        document.dispatchEvent(new CustomEvent('sanctuary:showPaywall', { detail: { reason: result.error } }));
      } else {
        console.error('[handleJoinRoom] Katılım hatası:', result.error);
        ToastManager.error(result.error || 'Odaya katılınamadı.', 'Katılım Hatası');
      }
      return;
    }
    ToastManager.success('"' + room.name + '" odasına katıldınız.', 'Katıldınız');
  } catch (err) {
    console.error('[handleJoinRoom] Beklenmedik hata:', err);
    ToastManager.error('Odaya katılırken bir hata oluştu.', 'Hata');
  }
}

function handleDeleteRoom(roomId) {
  if (typeof RoomManager === 'undefined') return;
  try {
    var result = RoomManager.deleteRoom(roomId);
    if (!result.success) {
      console.error('[handleDeleteRoom] Silme hatası:', result.error);
      ToastManager.error(result.error || 'Oda silinemedi.', 'Silme Hatası');
      return;
    }
    ToastManager.success('Oda başarıyla silindi.', 'Silindi');
    var grid = document.querySelector('.rooms-grid');
    if (grid) renderRoomList(grid);
  } catch (err) {
    console.error('[handleDeleteRoom] Beklenmedik hata:', err);
    ToastManager.error('Oda silinirken bir hata oluştu.', 'Hata');
  }
}

function handleLeaveRoom(roomId) {
  if (typeof RoomManager === 'undefined') return;
  try {
    var result = RoomManager.leaveRoom(roomId);
    if (!result.success) {
      console.error('[handleLeaveRoom] Ayrılma hatası:', result.error);
      ToastManager.error(result.error || 'Odadan ayrılınamadı.', 'Ayrılma Hatası');
      return;
    }
    var msg = result.deleted  ? 'Odadan ayrıldınız. Oda boşaldığı için kapatıldı.'
            : result.newHost  ? 'Odadan ayrıldınız. Oda sahipliği devredildi.'
            :                   'Odadan ayrıldınız.';
    ToastManager.info(msg, 'Ayrıldınız');
    var grid = document.querySelector('.rooms-grid');
    if (grid) renderRoomList(grid);
  } catch (err) {
    console.error('[handleLeaveRoom] Beklenmedik hata:', err);
    ToastManager.error('Odadan ayrılırken bir hata oluştu.', 'Hata');
  }
}

/* ══════════════════════════════════════════════════════════════════
   BÖLÜM 12 — AI ORACLE OVERLAY KONTROLÜ
   Mevcut overlay'in düzgün çalıştığını garanti eder.
══════════════════════════════════════════════════════════════════ */

var AiOracleUI = (function () {
  function showProcessing() {
    var el = document.getElementById('ai-processing');
    if (!el) return;
    el.style.display = 'flex';
    requestAnimationFrame(function () {
      el.classList.add('show');
    });
  }

  function hideProcessing() {
    var el = document.getElementById('ai-processing');
    if (!el) return;
    el.classList.remove('show');
    setTimeout(function () {
      el.style.display = 'none';
    }, 350);
  }

  /**
   * AI Oracle çağrısı — timeout + hata yönetimi ile
   */
  function generateFrequency(prompt, apiCallFn, onSuccess) {
    if (!prompt || !prompt.trim()) {
      ToastManager.warning('Lütfen bir ruh halinizi veya niyetinizi yazın.', 'Boş İstek');
      return;
    }

    showProcessing();

    // 10 saniyelik timeout
    var timeoutId = setTimeout(function () {
      hideProcessing();
      console.error('[AiOracle] İstek zaman aşımına uğradı.');
      ToastManager.error('AI Oracle yanıt vermedi. Lütfen tekrar deneyin.', 'Zaman Aşımı', 6000);
    }, 10000);

    Promise.resolve()
      .then(function () {
        return apiCallFn(prompt);
      })
      .then(function (result) {
        clearTimeout(timeoutId);
        hideProcessing();
        if (typeof onSuccess === 'function') onSuccess(result);
        ToastManager.success('Frekans başarıyla oluşturuldu.', 'Oracle');
      })
      .catch(function (err) {
        clearTimeout(timeoutId);
        hideProcessing();
        console.error('[AiOracle] Frekans üretim hatası:', err);

        if (err && err.message && err.message.includes('TIMEOUT')) return; // zaten bildirildi

        if (!navigator.onLine) {
          ToastManager.error('İnternet bağlantısı yok. AI Oracle çevrimdışı çalışamaz.', 'Bağlantı Hatası');
        } else if (err && err.message && err.message.includes('401')) {
          ToastManager.error('API anahtarı geçersiz veya süresi dolmuş.', 'Yetki Hatası', 6000);
        } else if (err && err.message && err.message.includes('429')) {
          ToastManager.warning('Çok fazla istek gönderildi. Lütfen biraz bekleyin.', 'İstek Limiti');
        } else {
          ToastManager.error('AI Oracle bir hatayla karşılaştı. Lütfen tekrar deneyin.', 'Oracle Hatası');
        }
      });
  }

  return {
    showProcessing   : showProcessing,
    hideProcessing   : hideProcessing,
    generateFrequency: generateFrequency
  };
})();

/* ══════════════════════════════════════════════════════════════════
   BÖLÜM 13 — BAŞLATMA
══════════════════════════════════════════════════════════════════ */

document.addEventListener('DOMContentLoaded', function () {

  /* 0a. PHASE 5: PageVisibilityManager — sekme gizlenince efektler durur */
  try {
    PageVisibilityManager.init();

    /* Ripple efektini sekme görünürlüğüne bağla */
    PageVisibilityManager.register(
      function onHide() {
        /* Sekme gizlendi — ripple spawn'unu durdur */
        window._rippleDisabled = true;
        console.debug('[main] Ripple devre dışı (sekme gizli)');
      },
      function onShow() {
        /* Sekme görünür — ripple'ı yeniden etkinleştir */
        window._rippleDisabled = false;
        console.debug('[main] Ripple etkin (sekme görünür)');
      }
    );

    /* PHASE 11 — Canvas animasyonlarını sekme görünürlüğüne bağla
     * Sekme arka plana geçince waveform + particles durur → pil/ısı tasarrufu
     * Ses kesintisiz devam eder */
    PageVisibilityManager.register(
      function onHide() {
        /* Waveform RAF durdur */
        try { stopWaveformLoop(); } catch (e) {}
        /* Gen canvas dondur */
        var canvas = document.getElementById('gen-canvas');
        if (canvas) canvas.style.animationPlayState = 'paused';
        /* Particle animasyonlarını dondur */
        document.querySelectorAll('.detox-particle, .ai-star').forEach(function (el) {
          el.style.animationPlayState = 'paused';
        });
        window._canvasPaused = true;
        console.debug('[main] Canvas animasyonları durduruldu (arka plan)');
      },
      function onShow() {
        /* Waveform tekrar başlat — AudioEngine aktifse */
        try {
          if (typeof AudioEngine !== 'undefined' && AudioEngine.getInstance) {
            var eng = AudioEngine.getInstance();
            if (eng.isPlaying && eng.startWaveformLoop) {
              /* Waveform callback'i varsa yeniden başlat */
              eng.startWaveformLoop(eng._lastWaveformCallback || function () {});
            }
          }
        } catch (e) {}
        /* Gen canvas ve particle animasyonlarını devam ettir */
        var canvas = document.getElementById('gen-canvas');
        if (canvas) canvas.style.animationPlayState = 'running';
        document.querySelectorAll('.detox-particle, .ai-star').forEach(function (el) {
          el.style.animationPlayState = 'running';
        });
        window._canvasPaused = false;
        console.debug('[main] Canvas animasyonları devam ediyor');
      }
    );
  } catch (e) {
    console.warn('[init] PageVisibilityManager başlatılamadı:', e);
  }

  /* 0b. PHASE 5: Ağ izleme */
  try {
    NetworkMonitor.init();
  } catch (e) {
    console.error('[init] NetworkMonitor başlatılamadı:', e);
  }

  /* 1. Ripple efekti */
  try {
    initRippleEffect();
  } catch (e) {
    console.error('[init] Ripple başlatılamadı:', e);
  }

  /* 2. Sekme animasyonları */
  try {
    initTabAnimations();
  } catch (e) {
    console.error('[init] TabAnimations başlatılamadı:', e);
  }

  /* 3. Oda listesi */
  var roomsGrid = document.querySelector('.rooms-grid');
  if (roomsGrid) {
    try {
      renderRoomList(roomsGrid);
    } catch (e) {
      console.error('[init] Oda listesi yüklenemedi:', e);
      ToastManager.error('Oda listesi yüklenemedi.', 'Yükleme Hatası');
    }
  }

  /* 4. Oda kur butonu */
  var openModalBtn = document.getElementById('btnOpenCreateModal');
  if (openModalBtn) {
    openModalBtn.addEventListener('click', function () {
      try {
        var modal = document.getElementById('createRoomModal');
        if (modal) modal.classList.add('open');
      } catch (e) {
        console.error('[init] Modal açılamadı:', e);
        ToastManager.error('Modal açılamadı.', 'Hata');
      }
    });
  }

  /* 5. Filter bar */
  document.querySelectorAll('.filter-chip').forEach(function (chip) {
    chip.addEventListener('click', function () {
      try {
        document.querySelectorAll('.filter-chip').forEach(function (c) { c.classList.remove('active'); });
        chip.classList.add('active');
        var cat  = chip.dataset.filter || chip.dataset.category || null;
        var grid = document.querySelector('.rooms-grid');
        if (grid) {
          /* PHASE 5: Kategori değişince RenderGuard'ı invalidate et */
          RenderGuard.invalidate('rooms:' + (cat && cat !== 'all' && cat !== 'tümü' ? cat : 'all'));
          renderRoomList(grid, (cat === 'all' || cat === 'tümü') ? null : cat);
        }
      } catch (e) {
        console.error('[filter] Filtre hatası:', e);
        ToastManager.error('Filtre uygulanamadı.', 'Hata');
      }
    });
  });

  /* 6. API key input */
  var apiKeyInput = document.getElementById('api-key-input');
  if (apiKeyInput) {
    apiKeyInput.addEventListener('change', function (e) {
      try {
        initApiKey(e.target.value);
        e.target.value       = '';
        e.target.placeholder = '••••••••••••••••';
      } catch (e2) {
        console.error('[init] API key işlenemedi:', e2);
        ToastManager.error('API anahtarı işlenemedi.', 'Hata');
      }
    });
  }

  /* 7. Kapasite stepper */
  var capacity = 5;
  var capVal   = document.getElementById('capValue');
  var btnInc   = document.getElementById('btnCapInc');
  var btnDec   = document.getElementById('btnCapDec');
  if (btnInc) {
    btnInc.addEventListener('click', function () {
      if (capacity < 20) { capacity++; if (capVal) capVal.textContent = capacity; }
    });
  }
  if (btnDec) {
    btnDec.addEventListener('click', function () {
      if (capacity > 2) { capacity--; if (capVal) capVal.textContent = capacity; }
    });
  }

  /* 8. Oda tipi seçimi */
  document.querySelectorAll('.type-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      document.querySelectorAll('.type-btn').forEach(function (b) { b.classList.remove('selected'); });
      this.classList.add('selected');
      var pf = document.getElementById('passwordField');
      if (pf) pf.style.display = (this.dataset.type === 'private') ? 'block' : 'none';
    });
  });

  /* 9. Modal kapat */
  var closeModal = document.getElementById('btnCloseModal');
  if (closeModal) {
    closeModal.addEventListener('click', function () {
      var modal = document.getElementById('createRoomModal');
      if (modal) modal.classList.remove('open');
    });
  }
  var createRoomModal = document.getElementById('createRoomModal');
  if (createRoomModal) {
    createRoomModal.addEventListener('click', function (e) {
      if (e.target === this) this.classList.remove('open');
    });
  }

  /* 10. Oda oluştur (form submit) */
  var submitRoom = document.getElementById('btnSubmitRoom');
  if (submitRoom) {
    submitRoom.addEventListener('click', function () {
      try {
        var nameInput = document.getElementById('roomName');
        if (!nameInput || !nameInput.value.trim()) {
          ToastManager.warning('Oda adı boş bırakılamaz.', 'Eksik Alan');
          if (nameInput) nameInput.focus();
          return;
        }

        var roomName = nameInput.value.trim();
        var restore  = LoadingManager.setButtonLoading(submitRoom, 'Oluşturuluyor…');

        setTimeout(function () {
          try {
            restore();
            /* PHASE 5: Yeni oda eklenince RenderGuard invalidate et */
            RenderGuard.invalidateAll();
            ToastManager.success('✦ "' + roomName + '" odası oluşturuldu!', 'Oda Kuruldu');
            var modal = document.getElementById('createRoomModal');
            if (modal) modal.classList.remove('open');
            if (nameInput) nameInput.value = '';
            var grid = document.querySelector('.rooms-grid');
            if (grid) renderRoomList(grid);
          } catch (e) {
            restore();
            console.error('[submitRoom] Oda oluşturma hatası:', e);
            ToastManager.error('Oda oluşturulamadı. Tekrar deneyin.', 'Hata');
          }
        }, 900);
      } catch (e) {
        console.error('[submitRoom] Beklenmedik hata:', e);
        ToastManager.error('Beklenmedik bir hata oluştu.', 'Hata');
      }
    });
  }

  console.info('[Sanctuary] 5. Aşama yüklendi. PageVisibilityManager, RenderGuard, RAFRegistry hazır.');
});

/* ══════════════════════════════════════════════════════════════════
   GLOBAL TEMIZLIK — PHASE 5
   beforeunload + pagehide: tüm kaynaklar temizlenir
══════════════════════════════════════════════════════════════════ */

function _globalCleanup() {
  try { clearApiKey(); }         catch (e) { /* no-op */ }
  try { RAFRegistry.cancelAll(); }  catch (e) { /* no-op */ }
  try { PageVisibilityManager.dispose(); } catch (e) { /* no-op */ }
  try { stopWaveformLoop(); }    catch (e) { /* no-op */ }
  console.info('[Sanctuary] Kaynaklar temizlendi.');
}

window.addEventListener('beforeunload', _globalCleanup);
/* PHASE 5: pagehide — mobil tarayıcılar beforeunload'ı her zaman tetiklemez */
window.addEventListener('pagehide',     _globalCleanup);

/* ══════════════════════════════════════════════════════════════════
   GLOBAL API — Diğer modüller bu fonksiyonlara erişebilir
   PHASE 5: Yeni modüller eklendi
══════════════════════════════════════════════════════════════════ */

window.SanctuaryToast      = ToastManager;
window.SanctuaryLoading    = LoadingManager;
window.SanctuaryNetwork    = NetworkMonitor;
window.SanctuaryAiUI       = AiOracleUI;
window.SanctuaryVisibility = PageVisibilityManager;
window.SanctuaryRenderGuard = RenderGuard;
window.SanctuaryRAF        = RAFRegistry;
window.fetchSanctuary      = fetchWithTimeout;
window.loadAudio           = loadAudioWithFeedback;
window.stopWaveformLoop    = stopWaveformLoop;

/* [YENİ v4.3] FrequencyManager erişim kısayolları */
window.getAMSeries = function(baseHz, beatHz) {
  if (typeof window.getFrequencyManager !== 'function') return null;
  return window.getFrequencyManager(baseHz).getAMSeries(baseHz, beatHz);
};
window.getResonantFreq = function(textureName) {
  if (typeof window.getFrequencyManager !== 'function') return 800;
  return window.getFrequencyManager().getResonantFreqForTexture(textureName);
};

/* Geriye dönük uyumluluk */
window.handleCreateRoom = handleCreateRoom;
window.handleJoinRoom   = handleJoinRoom;
window.handleDeleteRoom = handleDeleteRoom;
window.handleLeaveRoom  = handleLeaveRoom;
window.renderRoomList   = renderRoomList;
window.showToast        = showToast;

/* ═══════════════════════════════════════════════════════════════
   8. AŞAMA — Konsolidasyon & Yayına Hazırlık
   1. Merkezi CONFIG
   2. sessionBuffer — sekme geçişlerinde veri korunumu
   3. window.Sanctuary global namespace
   4. Merkezi hata yakalayıcı
═══════════════════════════════════════════════════════════════ */

/* ── Merkezi CONFIG v4.3 ── */
window.SanctuaryConfig = {
  breath: { inhale:4000, hold:7000, exhale:8000, pause:1000 },
  audio: {
    masterVolume:0.75, ambientVolume:0.55, binauralVolume:0.10,
    fadeOutDuration:120, bufferSeconds:8,
  },
  /* [GÜNCELLENDİ v4.3] Solfeggio tablosundan gelen gerçek frekanslar.
     FrequencyManager SOLFEGGIO_TABLE ile birebir eşleşir.
     Eski: base:180/200/160 → Yeni: Solfeggio Hz değerleri (396, 528, 174, vb.)
     gen alanları: AudioEngine v4.3 TEXTURE_MAP adlandırmasıyla uyumlu.  */
  moods: {
    'Huzursuz':  { base: 396, beat: 6.3,  gen: 'ocean',    solfeggioHz: 396, bg: 'teal'   },
    'Yorgun':    { base: 528, beat: 4.8,  gen: 'rain',     solfeggioHz: 528, bg: 'violet' },
    'Kaygılı':   { base: 396, beat: 7.2,  gen: 'wind',     solfeggioHz: 396, bg: 'sky'    },
    'Mutsuz':    { base: 417, beat: 5.5,  gen: 'ocean',    solfeggioHz: 417, bg: 'rose'   },
    'Sakin':     { base: 432, beat: 10.5, gen: 'zen',      solfeggioHz: 528, bg: 'teal'   },
    'Minnettar': { base: 528, beat: 10.0, gen: 'forest',   solfeggioHz: 528, bg: 'gold'   },
    /* [YENİ v4.3] Ek Maestro mood eşlemeleri — Solfeggio tablosundan */
    'deep_sleep'      : { base: 174, beat: 2.5,  gen: 'rain',     solfeggioHz: 174, bg: 'indigo' },
    'deep_meditation' : { base: 963, beat: 4.0,  gen: 'zen',      solfeggioHz: 963, bg: 'violet' },
    'stress_relief'   : { base: 285, beat: 7.0,  gen: 'forest',   solfeggioHz: 285, bg: 'teal'   },
    'anxiety_acute'   : { base: 396, beat: 6.0,  gen: 'wind',     solfeggioHz: 396, bg: 'sky'    },
    'focus'           : { base: 741, beat: 14.0, gen: 'fire',     solfeggioHz: 741, bg: 'gold'   },
    'energize'        : { base: 639, beat: 14.5, gen: 'campfire', solfeggioHz: 639, bg: 'orange' },
  },
};

/* ── sessionBuffer — Sekme geçişlerinde veri korunumu ── */
window.SanctuarySessionBuffer = (function() {
  var _data = {};
  return {
    set: function(k, v) { _data[k] = v; },
    get: function(k)    { return _data[k]; },
    clear: function(k)  { delete _data[k]; },
  };
})();

/* ── switchTab'ı sessionBuffer ile güçlendir ── */
(function() {
  var _origSwitchTab = window.switchTab || window.Sanctuary && window.Sanctuary.switchTab;
  window.switchTab = function(tabId) {
    // Aktif sekmedeki textarea'yı kaydet
    var active = document.querySelector('.tab-panel.active');
    if (active) {
      var ta = active.querySelector('textarea');
      if (ta) window.SanctuarySessionBuffer.set('tab_' + active.id, ta.value);
    }
    // Orijinal switchTab'ı çağır
    if (_origSwitchTab) _origSwitchTab(tabId);
    // Yeni sekmedeki textarea'yı geri yükle
    setTimeout(function() {
      var panel = document.getElementById(tabId);
      if (panel) {
        var ta = panel.querySelector('textarea');
        var saved = window.SanctuarySessionBuffer.get('tab_' + tabId);
        if (ta && saved !== undefined) ta.value = saved;
      }
    }, 50);
  };
})();

/* ── Merkezi hata yakalayıcı ── */
(function() {
  function _showErrorToast(msg) {
    var toast = document.getElementById('notif-toast');
    if (!toast) return;
    var title = toast.querySelector('.nt-title');
    var body  = toast.querySelector('.nt-body');
    if (title) title.textContent = '⚠️ Sistem uyarısı';
    if (body)  body.textContent  = msg || 'Beklenmeyen bir hata oluştu.';
    toast.classList.add('show');
    setTimeout(function() { toast.classList.remove('show'); }, 4000);
  }

  window.onerror = function(msg, src, line) {
    console.error('[Sanctuary]', msg, src + ':' + line);
    _showErrorToast('Bir şeyler ters gitti. Lütfen sayfayı yenileyin.');
    return false;
  };

  window.addEventListener('unhandledrejection', function(e) {
    console.error('[Sanctuary Promise]', e.reason);
    _showErrorToast('Arka plan işlemi başarısız oldu.');
  });
})();

/* ══════════════════════════════════════════════════════════════════
   applyMSD() v4.3 — Maestro verisini sistemin tamamına uygulayan
   merkezi orkestratör. velvetReady: true olan veriye kapı açar.

   Zincir: GeminiAdapter → applyMSD → FrequencyManager.getAMSeries()
                                    → AudioEngine (Phi katmanları + Tremolo)
                                    → SceneInterpreter → StateManager
                                    → VisualizerEngine → LearningEngine
   ─────────────────────────────────────────────────────────────────
   v4.3 Değişiklikleri:
     - FrequencyManager.getAMSeries(baseHz, binauralHz) çağrısı eklendi.
       Phi katman seti (A/B/C) + Tremolo parametreleri tek nesnede alınır.
     - AudioEngine.startSound() çağrısından ÖNCE FM.applyMSD(maestro) ile
       FrequencyManager singleton'ı Solfeggio'ya kilitlenir.
     - Maestro'dan gelen texture isimleri AudioEngine._resolveTexture() ile
       normalize edilir — 'Calm Embers' → 'calm embers' otomatik.
     - Resonant Peak frekansı FM.getResonantFreqForTexture() ile belirlenir
       ve maestro nesnesine eklenerek SceneInterpreter'a iletilir.
══════════════════════════════════════════════════════════════════ */
window.applyMSD = function(maestro) {
  /* ── Kapı: velvetReady kontrolü ── */
  if (!maestro || maestro.velvetReady !== true) {
    console.error('[applyMSD] velvetReady bayrağı yok — veri reddedildi.', maestro);
    ToastManager.error('Sahne verisi doğrulanmadı. Oracle tekrar deneyecek.', 'Velvet Hatası');
    return false;
  }

  console.info('[applyMSD v4.3] ✅ Maestro kabul edildi:', maestro.sceneName,
    '| baseHz:', maestro.baseHz, '| binauralHz:', maestro.binauralHz);

  /* ── [YENİ v4.3] FrequencyManager: Solfeggio kilitle + AM serisi hesapla ── */
  var amSeries = null;
  try {
    if (typeof window.getFrequencyManager === 'function') {
      var fm = window.getFrequencyManager(maestro.baseHz || 432);

      /* Solfeggio'yu Maestro verisinden güncelle */
      fm.applyMSD(maestro);

      /* Phi katmanları + Tremolo parametreleri + EEG band tek nesnede */
      amSeries = fm.getAMSeries(maestro.baseHz, maestro.binauralHz);

      /* Aktif texture için Resonant Peak frekansı → maestro nesnesine ekle */
      var primaryTexture = (Array.isArray(maestro.textures) && maestro.textures[0])
        ? maestro.textures[0].name
        : (maestro.gen || 'ambient');
      maestro._resonantFreq = fm.getResonantFreqForTexture(primaryTexture);

      console.info('[applyMSD v4.3] AM Serisi hazırlandı.',
        '\n  EEG Band     :', amSeries.band,
        '\n  Phi¹ (Katman B):', amSeries.phiLayers.layerB.phi1.toFixed(2), 'Hz',
        '\n  Phi² (Katman B):', amSeries.phiLayers.layerB.phi2.toFixed(2), 'Hz',
        '\n  Tremolo LFO  :', amSeries.tremolo.lfoHz, 'Hz | depth:', amSeries.tremolo.depth,
        '\n  ResonantFreq :', maestro._resonantFreq, 'Hz →', primaryTexture
      );
    }
  } catch(e) {
    console.warn('[applyMSD v4.3] FrequencyManager AM serisi hesaplanamadı:', e.message);
  }

  /* ── 1. SceneInterpreter: Maestro → audioScript + cssCommands + uiCommands ── */
  var result = null;
  try {
    if (typeof window.SceneInterpreter !== 'undefined') {
      result = window.SceneInterpreter.interpret(maestro);
    } else {
      console.warn('[applyMSD] SceneInterpreter yüklenmemiş.');
    }
  } catch(e) {
    console.error('[applyMSD] SceneInterpreter hatası:', e);
  }

  if (result) {
    var engine = null;
    try {
      if (typeof AudioEngine !== 'undefined' && AudioEngine.getInstance) {
        engine = AudioEngine.getInstance();
      }
    } catch(e) {}

    /* [YENİ v4.3] amSeries'i SceneInterpreter result nesnesine ekle
       SceneInterpreter.apply() → AudioEngine.startSound() bu veriyi kullanır */
    if (amSeries && result) {
      result._amSeries = amSeries;
    }

    var breathWrap = document.getElementById('breath-circle') || document.querySelector('.breath-wrap');
    var guideEl    = document.getElementById('breath-guide')  || document.querySelector('.breath-guide');

    window.SceneInterpreter.apply(result, {
      engine    : engine,
      breathWrap: breathWrap,
      guideEl   : guideEl,
    });
  }

  /* ── 2. StateManager: Maestro'yu merkezi state'e kaydet ── */
  try {
    var sm = (typeof getStateManager === 'function') ? getStateManager() : null;
    if (sm) {
      if (typeof sm.set === 'function')             sm.set('currentMSD', maestro);
      if (typeof sm.set === 'function' && amSeries) sm.set('currentAMSeries', amSeries);
      if (typeof sm.setCurrentScene === 'function') sm.setCurrentScene(maestro.sceneName);
    }
  } catch(e) {
    console.warn('[applyMSD] StateManager kayıt hatası:', e);
  }

  /* ── 3. VisualizerEngine: sahneye göre renk paleti güncelle ── */
  try {
    if (typeof window.VisualizerEngine !== 'undefined' && window.VisualizerEngine.setMood) {
      window.VisualizerEngine.setMood(maestro.sceneName || 'Calm');
    }
  } catch(e) {}

  /* ── 4. LearningEngine: bu sahneyi öğrenme verisine ekle ── */
  try {
    if (typeof window.LearningEngine !== 'undefined' && window.LearningEngine.record) {
      window.LearningEngine.record({
        sceneName : maestro.sceneName,
        baseHz    : maestro.baseHz,
        binauralHz: maestro.binauralHz,
        band      : amSeries ? amSeries.band : null,
        timestamp : Date.now(),
      });
    }
  } catch(e) {}

  /* ── 5. LocalStorage güncelle ── */
  try {
    localStorage.setItem('lastBase',      maestro.baseHz);
    localStorage.setItem('lastBeat',      maestro.binauralHz);
    localStorage.setItem('lastGen',       'binaural');
    localStorage.setItem('lastSceneName', maestro.sceneName || '');
    if (amSeries) localStorage.setItem('lastBand', amSeries.band);
  } catch(e) {}

  return true;
};

/* ══════════════════════════════════════════════════════════════════
   getMaestroRecipe() v4.3 — GeminiAdapter'ı doğrudan çağıran
   Maestro orkestratörü. window.Sanctuary.generateAIFreq'in
   tek geçerli backend'i budur.

   [GÜNCELLENDİ v4.3] Başarılı Maestro sonucunda:
     1. FrequencyManager.applyMSD(maestro) → Solfeggio kilitle
     2. window.applyMSD(maestro) → tüm sisteme yay (önceki davranış)

   @param {string} userInput    — Kullanıcı niyeti (boş olabilir)
   @param {string} selectedMood — Aktif ruh hali
   @param {string} [mode]       — 'oracle' | 'mood' (varsayılan: 'mood')
══════════════════════════════════════════════════════════════════ */
window.getMaestroRecipe = function(userInput, selectedMood, mode) {
  mode = mode || 'mood';

  if (typeof window.GeminiAdapter === 'undefined') {
    console.error('[getMaestroRecipe] GeminiAdapter yüklenmemiş!');
    ToastManager.error('AI motoru henüz hazır değil. Lütfen sayfayı yenileyin.', 'Sistem Hatası');
    return Promise.reject(new Error('GeminiAdapter yüklenmemiş'));
  }

  if (mode === 'oracle' && !userInput) {
    userInput = 'Beni sen yönlendir. Şu anki ihtiyacıma en uygun sahneyi seç.';
  }

  var adapter = new window.GeminiAdapter();

  return adapter.generateScene(userInput || '', selectedMood)
    .then(function(maestro) {
      /* [YENİ v4.3] FrequencyManager singleton'ı Maestro Solfeggio'suna kilitle */
      try {
        if (typeof window.getFrequencyManager === 'function') {
          window.getFrequencyManager(maestro.baseHz || 432).applyMSD(maestro);
          console.info('[getMaestroRecipe v4.3] FM Solfeggio kilitlendi:',
            maestro.solfeggioHz || maestro.baseHz, 'Hz');
        }
      } catch(e) {
        console.warn('[getMaestroRecipe v4.3] FM applyMSD hatası:', e.message);
      }

      var applied = window.applyMSD(maestro);
      if (applied) {
        ToastManager.success(
          maestro.sceneName + ' · ' + maestro.baseHz + ' Hz',
          '✦ Maestro Aktif'
        );
      }
      return maestro;
    })
    .catch(function(err) {
      console.error('[getMaestroRecipe] Pipeline hatası:', err);
      ToastManager.error('Maestro yanıt vermedi. Tekrar deneyin.', 'Oracle Hatası');
      throw err;
    });
};

/* ── window.Sanctuary global namespace ── */
window.Sanctuary = {
  config:        window.SanctuaryConfig,
  sessionBuffer: window.SanctuarySessionBuffer,
  // Mevcut fonksiyonlara referanslar
  switchTab:        function(id) { window.switchTab(id); },
  togglePlay:       function()   { if(window.togglePlay)   window.togglePlay();   },
  goSanctuary:      function()   { if(window.goSanctuary)  window.goSanctuary();  },
  goBack:           function()   { if(window.goBack)        window.goBack();       },
  pickMood:         function(el) { if(window.pickMood)     window.pickMood(el);   },
  openPaywall:      function()   { if(window.openPaywall)  window.openPaywall();  },
  closePaywall:     function()   { if(window.closePaywall) window.closePaywall(); },
  showAnalytics:    function()   { if(window.showAnalytics)window.showAnalytics();},
  /* ── GeminiAdapter'a doğrudan köprü ── */
  generateAIFreq: function(userInput, mode) {
    var mood = '';
    try {
      var sm = (typeof getStateManager === 'function') ? getStateManager() : null;
      if (sm && typeof sm.getSelectedMood === 'function') mood = sm.getSelectedMood() || '';
    } catch(e) {}
    if (!mood) {
      var moodEl = document.getElementById('s-mood');
      if (moodEl) mood = moodEl.textContent.trim();
    }
    return window.getMaestroRecipe(userInput || '', mood, mode || 'mood');
  },
  /* ── Oracle Mode: kullanıcı girdisi olmadan tetikleme ── */
  activateOracle: function() {
    return window.Sanctuary.generateAIFreq('', 'oracle');
  },
  saveJournalEntry: function()   { if(window.saveJournalEntry)window.saveJournalEntry();},
  setSleepTimer:    function(m)  { if(window.setSleepTimer)window.setSleepTimer(m);},
  cancelSleepTimer: function()   { if(window.cancelSleepTimer)window.cancelSleepTimer();},
  /* ── Doğrudan erişim ── */
  applyMSD:       function(maestro) { return window.applyMSD(maestro); },
  getMaestroRecipe: function(input, mood, mode) { return window.getMaestroRecipe(input, mood, mode); },
};

console.info('[Sanctuary] 8. Aşama v4.3 yüklendi ✓ — Maestro pipeline + FM entegrasyonu hazır');

/* ═══════════════════════════════════════════════════════════
   9. AŞAMA — Zihin Haritası, Akıllı Öneriler, Duygu-Ses
═══════════════════════════════════════════════════════════ */

/* ── Zihin Haritası Render ── */
window.renderMindMap = function() {
  var stats = window.SanctuaryStats;
  if (!stats) return;
  var days = stats.getLast7Days();
  var dotsEl = document.getElementById('mind-map-dots');
  var streakEl = document.getElementById('mind-map-streak');
  if (!dotsEl) return;

  var maxMin = Math.max.apply(null, days.map(function(d){ return d.minutes; }).concat([1]));

  dotsEl.innerHTML = '';
  days.forEach(function(day) {
    var dot = document.createElement('div');
    dot.className = 'mind-map-dot' + (day.count === 0 ? ' empty' : '');
    var h = day.count > 0 ? Math.max(12, Math.round((day.minutes / maxMin) * 44)) : 8;
    dot.style.height = h + 'px';
    dot.style.background = day.mood ? stats.getMoodColor(day.mood) : 'rgba(255,255,255,0.06)';
    if (day.count > 0) dot.style.boxShadow = '0 0 8px ' + stats.getMoodColor(day.mood) + '55';
    dot.setAttribute('data-label', day.day + (day.mood ? ' · ' + day.mood : '') + (day.minutes > 0 ? ' · ' + day.minutes + 'dk' : ''));
    dotsEl.appendChild(dot);
  });

  var streak = stats.getStreak();
  if (streakEl) {
    streakEl.textContent = streak > 0 ? '🔥 ' + streak + ' günlük seri' : '';
  }
};

/* ── Kişiselleştirilmiş Karşılama ── */
window.updatePersonalizedGreeting = function() {
  var stats = window.SanctuaryStats;
  if (!stats) return;
  var msgEl = document.getElementById('s-message');
  if (msgEl) {
    var msg = stats.getPersonalizedMessage();
    if (msg) msgEl.textContent = msg;
  }
};

/* ── Akıllı Frekans Önerisi ── */
window.showSmartSuggestion = function(mood) {
  var stats = window.SanctuaryStats;
  if (!stats) return;
  var suggest = document.getElementById('smart-suggest');
  var suggestText = document.getElementById('smart-suggest-text');
  if (!suggest || !suggestText) return;

  var rec = stats.getSmartFreqSuggestion(mood);
  suggestText.textContent = '✦ Senin için öneri: ' + rec.label + ' — şimdi dene?';
  suggest.style.display = 'flex';
  suggest.onclick = function() {
    if (window.switchSound) window.switchSound(rec.gen, rec.freq, rec.beat, rec.label);
    try {
      localStorage.setItem('lastGen', rec.gen);
      localStorage.setItem('lastBase', rec.freq);
      localStorage.setItem('lastBeat', rec.beat);
    } catch(e) {}
    suggest.style.display = 'none';
  };
};

/* ── Duygu-Ses İlişkilendirmesi (Journal) v4.3 ── */
window.analyzeJournalAndModulate = function(text) {
  if (!text || !window.switchSound) return;
  var lower     = text.toLowerCase();
  var wordCount = text.trim().split(/\s+/).length;

  /* [GÜNCELLENDİ v4.3] texture isimleri AudioEngine TEXTURE_MAP ile uyumlu.
     Frekanslar FrequencyManager SOLFEGGIO_TABLE'dan.                          */
  if (lower.includes('fırtına') || lower.includes('öfke') || lower.includes('sinir')) {
    window.switchSound('waves', 396, 6.3, 'Sakinleştirici Dalgalar');
  } else if (lower.includes('deniz') || lower.includes('okyanus') || lower.includes('huzur')) {
    window.switchSound('ocean', 396, 4.8, 'Okyanus Huzuru');
  } else if (lower.includes('sakin') || lower.includes('nefes') || lower.includes('dingin')) {
    window.switchSound('zen', 432, 7.0, 'Derin Huzur');
  } else if (lower.includes('uyku') || lower.includes('yorgun') || lower.includes('dinlen')) {
    window.switchSound('rain', 174, 2.5, 'Uyku Yağmuru');
  } else if (lower.includes('ateş') || lower.includes('sıcak') || lower.includes('huzurlu')) {
    window.switchSound('calm embers', 528, 4.8, 'Sakin Kor Ateşi');  /* [YENİ v4.3] */
  } else if (lower.includes('fısıltı') || lower.includes('sessiz')) {
    window.switchSound('whisper', 528, 6.0, 'Fısıltı');               /* [YENİ v4.3] */
  } else if (wordCount > 50) {
    /* Uzun yazı = yoğun düşünceler → zihin netliği */
    window.switchSound('zen', 741, 14.0, 'Zihin Berraklığı');
  }
};

/* ── pickMood'u intercept et — akıllı öneri + GeminiAdapter otomatik tetikleme ── */
(function() {
  var _origPickMood = window.pickMood;
  window.pickMood = function(el) {
    if (_origPickMood) _origPickMood(el);
    var mood = el ? el.getAttribute('data-mood') : null;
    if (!mood) return;

    /* Akıllı öneri göster */
    setTimeout(function() { window.showSmartSuggestion(mood); }, 300);

    /* Aktivite kaydı — StateManager merkezi state */
    window._sessionStart = Date.now();
    try {
      var sm = (typeof getStateManager === 'function') ? getStateManager() : null;
      if (sm && typeof sm.setSelectedMood === 'function') sm.setSelectedMood(mood);
    } catch(e) {}

    /* Kişiselleştirilmiş mesaj güncelle */
    setTimeout(window.updatePersonalizedGreeting, 100);

    /* ── GeminiAdapter: ruh haline göre Maestro otomatik çek ──
     * Kullanıcı mood seçer seçmez sahne hazırlanmaya başlar.
     * Sonuç applyMSD() üzerinden tüm sisteme yayılır.
     */
    if (typeof window.GeminiAdapter !== 'undefined') {
      setTimeout(function() {
        var adapter = new window.GeminiAdapter();
        /* Processing overlay göster */
        if (window.SanctuaryAiUI) window.SanctuaryAiUI.showProcessing();

        adapter.generateScene('', mood)
          .then(function(maestro) {
            if (window.SanctuaryAiUI) window.SanctuaryAiUI.hideProcessing();
            var applied = window.applyMSD(maestro);
            if (applied) {
              console.info('[pickMood] onMoodSelect → Maestro uygulandı:', mood, '→', maestro.sceneName);
            }
          })
          .catch(function(err) {
            if (window.SanctuaryAiUI) window.SanctuaryAiUI.hideProcessing();
            console.warn('[pickMood] GeminiAdapter hatası (sessiz):', err.message);
            /* Hata durumunda kullanıcıya bildirim gösterme — mood seçimi etkilenmesin */
          });
      }, 150); /* Küçük gecikme: UI animasyonu tamamlansın */
    }
  };
})();

/* ── Journal kaydetme — ses modülasyonu ── */
(function() {
  var _origSave = window.saveJournalEntry;
  window.saveJournalEntry = function() {
    if (_origSave) _origSave();
    var ta = document.getElementById('journal-textarea');
    var text = ta ? ta.value : '';
    if (text.trim().length > 10) {
      window.analyzeJournalAndModulate(text);
    }
    // Aktivite logla
    if (window.SanctuaryStats) {
      window.SanctuaryStats.logActivity('journal', 0, localStorage.getItem('lastMood'));
    }
  };
})();

/* [togglePlay wrapper kaldırıldı] */

/* ── Sayfa yüklenince zihin haritasını render et ── */
(function() {
  function _initPhase9() {
    window.renderMindMap && window.renderMindMap();
    window.updatePersonalizedGreeting && window.updatePersonalizedGreeting();
    // Journal tab'ına geçilince haritayı yenile
    var _origSwitch = window.switchTab;
    window.switchTab = function(tabId) {
      if (_origSwitch) _origSwitch(tabId);
      if (tabId === 'tab-journal') {
        setTimeout(function() { window.renderMindMap && window.renderMindMap(); }, 100);
      }
    };
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _initPhase9);
  } else {
    setTimeout(_initPhase9, 500);
  }
})();

/* ═══════════════════════════════════════════════════════════════
   10. AŞAMA — Senkronize Odalar, Avatar Aura, Reaksiyonlar
═══════════════════════════════════════════════════════════════ */

/* ── Oda Render (RoomManager entegreli) ── */
window.renderRooms = function(filter) {
  var grid = document.getElementById('roomsGrid');
  if (!grid) return;
  var rm = window.RoomManager;
  if (!rm) return;

  var rooms = rm.getPublicRooms(filter || 'all');
  grid.innerHTML = '';

  if (!rooms.length) {
    grid.innerHTML = '<div class="empty-state"><div class="empty-icon">🌙</div><p class="empty-title">Bu kategoride oda yok</p><p class="empty-sub">İlk odayı sen kur!</p></div>';
    return;
  }

  var catLabels = {odak:'🎯 Odak', uyku:'😴 Uyku', meditasyon:'🧘 Meditasyon', doga:'🌿 Doğa', genel:'✨ Genel'};

  rooms.forEach(function(room) {
    var card = rm.buildRoomCard(room);
    var pct = Math.round(card.capacityFill * 100);
    var initials = card.hostName.split(' ').map(function(w){ return w[0]||''; }).join('').slice(0,2).toUpperCase();

    var el = document.createElement('div');
    el.className = 'room-card';
    el.setAttribute('data-room-id', card.id);
    el.innerHTML =
      '<div class="card-top">' +
        '<span class="badge-live"><span class="dot"></span>LIVE</span>' +
        (card.isPrivate ? '<span class="badge-private">🔒 Özel</span>' : '') +
      '</div>' +
      '<div class="room-name">' + card.name + '</div>' +
      '<div class="room-category">' + (catLabels[card.category]||card.category) + '</div>' +
      '<div class="room-auras" id="auras-' + card.id + '">' + _buildAuras(room) + '</div>' +
      '<div class="card-footer">' +
        '<div class="host-info">' +
          '<div class="host-avatar">' + initials + '</div>' +
          '<span class="host-name">' + card.hostName + '</span>' +
        '</div>' +
        '<div class="capacity-bar-wrap">' +
          '<div class="capacity-text">' + card.current + '/' + card.capacity + ' kişi</div>' +
          '<div class="capacity-bar"><div class="capacity-fill" style="width:' + pct + '%"></div></div>' +
        '</div>' +
      '</div>' +
      '<div class="room-reactions" id="reactions-' + card.id + '"></div>';

    el.addEventListener('click', function(e) {
      if (e.target.classList.contains('reaction-btn')) return;
      window.openRoomModal && window.openRoomModal(card.id);
    });

    grid.appendChild(el);
  });
};

function _buildAuras(room) {
  var html = '';
  var shown = room.participants.slice(0,5);
  shown.forEach(function(uid, i) {
    var breathing = window.RoomManager && window.RoomManager.isBreathing(uid);
    html += '<div class="aura-dot' + (breathing ? ' breathing' : '') + '" title="' + uid + '"></div>';
  });
  if (room.participants.length > 5) {
    html += '<div class="aura-dot aura-more">+' + (room.participants.length-5) + '</div>';
  }
  return html;
}

/* ── Oda Modal ── */
window.openRoomModal = function(roomId) {
  var rm = window.RoomManager;
  if (!rm) return;
  var room = rm.getRoomById(roomId);
  if (!room) return;

  var modal = document.getElementById('room-modal');
  if (!modal) {
    modal = _createRoomModal();
    document.body.appendChild(modal);
  }

  var card = rm.buildRoomCard(room);
  modal.querySelector('.rm-title').textContent = card.name;
  modal.querySelector('.rm-host').textContent = '🎙 Host: ' + card.hostName;
  modal.querySelector('.rm-count').textContent = card.current + '/' + card.capacity + ' katılımcı';
  modal.setAttribute('data-room-id', roomId);

  // Ses senkronizasyonu
  var cfg = room.audioConfig || {};
  var freqEl = modal.querySelector('.rm-freq');
  if (freqEl) freqEl.textContent = cfg.base ? cfg.base + ' Hz · ' + (cfg.gen||'') : '—';

  modal.style.display = 'flex';
  requestAnimationFrame(function(){ modal.classList.add('show'); });
  document.body.style.overflow = 'hidden';

  // Odaya katılınca sesi senkronize et
  var joinBtn = modal.querySelector('.rm-join-btn');
  if (joinBtn) {
    joinBtn.onclick = function() {
      var res = rm.joinRoom(roomId);
      if (res.success && res.room.audioConfig && window.switchSound) {
        var a = res.room.audioConfig;
        window.switchSound(a.gen, a.base, a.beat, a.label||'');
        try{localStorage.setItem('lastGen',a.gen);localStorage.setItem('lastBase',a.base);localStorage.setItem('lastBeat',a.beat);}catch(e){}
      }
      window.closeRoomModal && window.closeRoomModal();
    };
  }
};

function _createRoomModal() {
  var m = document.createElement('div');
  m.id = 'room-modal';
  m.className = 'modal-overlay';
  m.style.display = 'none';
  m.innerHTML =
    '<div class="modal-sheet room-modal-sheet">' +
      '<div class="modal-handle-bar"></div>' +
      '<div class="rm-header">' +
        '<h3 class="rm-title"></h3>' +
        '<button class="modal-close-btn" onclick="window.closeRoomModal()">✕</button>' +
      '</div>' +
      '<div class="rm-meta">' +
        '<span class="rm-host"></span>' +
        '<span class="rm-count"></span>' +
      '</div>' +
      '<div class="rm-freq-wrap">🎵 <span class="rm-freq"></span></div>' +
      '<div class="rm-reaction-bar">' +
        '<button class="reaction-btn" onclick="window.sendReaction(\'❤️\')">❤️</button>' +
        '<button class="reaction-btn" onclick="window.sendReaction(\'✨\')">✨</button>' +
        '<button class="reaction-btn" onclick="window.sendReaction(\'🙏\')">🙏</button>' +
        '<button class="reaction-btn" onclick="window.sendReaction(\'🌊\')">🌊</button>' +
        '<button class="reaction-btn" onclick="window.sendReaction(\'🔥\')">🔥</button>' +
      '</div>' +
      '<button class="rm-join-btn cta-btn">✦ Odaya Katıl</button>' +
    '</div>';
  m.addEventListener('click', function(e){ if(e.target===m) window.closeRoomModal(); });
  return m;
}

window.closeRoomModal = function() {
  var m = document.getElementById('room-modal');
  if (!m) return;
  m.classList.remove('show');
  setTimeout(function(){ m.style.display='none'; document.body.style.overflow=''; }, 350);
};

/* ── Floating Reaksiyon Sistemi ── */
window.sendReaction = function(emoji) {
  var container = document.getElementById('reaction-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'reaction-container';
    container.style.cssText = 'position:fixed;bottom:120px;left:0;right:0;pointer-events:none;z-index:9999;';
    document.body.appendChild(container);
  }

  for (var i = 0; i < 3; i++) {
    (function(delay) {
      setTimeout(function() {
        var el = document.createElement('div');
        el.className = 'floating-reaction';
        el.textContent = emoji;
        el.style.left = (20 + Math.random() * 60) + '%';
        el.style.animationDuration = (1.5 + Math.random() * 1) + 's';
        container.appendChild(el);
        setTimeout(function(){ if(el.parentNode) el.parentNode.removeChild(el); }, 3000);
      }, delay);
    })(i * 200);
  }
};

/* ── Filtre bar güncelle ── */
(function() {
  function _initRooms() {
    window.renderRooms('all');
    var bar = document.getElementById('roomFilterBar');
    if (bar) {
      bar.addEventListener('click', function(e) {
        var chip = e.target.closest('.filter-chip');
        if (!chip) return;
        bar.querySelectorAll('.filter-chip').forEach(function(c){ c.classList.remove('active'); });
        chip.classList.add('active');
        window.renderRooms(chip.getAttribute('data-filter'));
      });
    }

    // RoomManager event'lerini dinle
    if (window.RoomManager) {
      window.RoomManager.on('audio_sync', function(data) {
        // Host ses değiştirdi — bildirim göster
        var toast = document.getElementById('notif-toast');
        if (toast) {
          var t = toast.querySelector('.nt-title');
          var b = toast.querySelector('.nt-body');
          if (t) t.textContent = '🎵 Host sesi güncelledi';
          if (b) b.textContent = (data.audioConfig.base||'') + ' Hz · ' + (data.audioConfig.gen||'');
          toast.classList.add('show');
          setTimeout(function(){ toast.classList.remove('show'); }, 3000);
        }
      });

      window.RoomManager.on('host_changed', function(data) {
        window.renderRooms && window.renderRooms('all');
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _initRooms);
  } else {
    setTimeout(_initRooms, 300);
  }
})();

/* ── Nefes-Aura Senkronizasyonu (Phase 10) ── */

/**
 * startBreathCycle'ı RoomManager ile entegre et.
 * Kullanıcı nefes yaptığında küresi titreşir; odadaki herkes görür.
 * Orijinal startBreathCycle fonksiyonunu wrap eder.
 */
(function() {
  var _origStartBreath = window.startBreathCycle || (typeof startBreathCycle === 'function' ? startBreathCycle : null);

  window.startBreathCycleRoom = function(engine, breathWrap, guideEl, options, roomId) {
    roomId = roomId || null;
    var userId = 'user_local';

    // Aura küresi referansı — odadaki kendi noktamız
    var selfAura = null;
    if (roomId) {
      selfAura = document.querySelector('#auras-' + roomId + ' .aura-dot[title="' + userId + '"]');
    }

    /* Orijinal döngüyü başlat */
    var stopFn = typeof startBreathCycle === 'function'
      ? startBreathCycle(engine, breathWrap, guideEl, options)
      : null;

    /* RoomManager'a bildir */
    if (roomId && typeof RoomManager !== 'undefined') {
      RoomManager.setBreathing(roomId, userId, true);
    }

    /* AudioEngine köprüsü */
    try {
      if (typeof AudioEngine !== 'undefined' && AudioEngine.getInstance) {
        AudioEngine.getInstance().startBreathBroadcast(roomId, userId);
      }
    } catch (e) {}

    /* Aura küresi animasyonu */
    if (selfAura) selfAura.classList.add('breathing');

    /* Aura UI periyodik güncelleme (500ms) */
    var _auraTimer = null;
    if (roomId) {
      _auraTimer = setInterval(function() {
        var wrap = document.getElementById('auras-' + roomId);
        if (!wrap || typeof RoomManager === 'undefined') return;
        var room = RoomManager.getRoomById(roomId);
        if (!room) return;
        wrap.innerHTML = _buildAuras(room);
      }, 500);
    }

    /* Stop wrapper */
    return function stopBreathRoom() {
      if (typeof stopFn === 'function') stopFn();
      if (_auraTimer) clearInterval(_auraTimer);

      if (roomId && typeof RoomManager !== 'undefined') {
        RoomManager.setBreathing(roomId, userId, false);
      }

      try {
        if (typeof AudioEngine !== 'undefined' && AudioEngine.getInstance) {
          AudioEngine.getInstance().stopBreathBroadcast(roomId, userId);
        }
      } catch (e) {}

      if (selfAura) selfAura.classList.remove('breathing');
    };
  };
})();

/* ── Odaya katılınca Room Audio dinleyicisini başlat ── */
(function() {
  var _origJoin = window.handleJoinRoom;
  window.handleJoinRoom = function(roomId, password) {
    if (_origJoin) _origJoin(roomId, password);

    /* AudioEngine'i room event'lerine abone et */
    setTimeout(function() {
      try {
        if (typeof AudioEngine !== 'undefined' && AudioEngine.getInstance) {
          var engine = AudioEngine.getInstance();
          engine._listenRoomEvents && engine._listenRoomEvents(roomId);
        }
      } catch (e) {}
    }, 300);
  };
})();

/* ── Oda Modal Join butonuna nefes entegrasyonu ── */
(function() {
  /* Room modal render edilince join butonuna hook ekle */
  var _origOpen = window.openRoomModal;
  window.openRoomModal = function(roomId) {
    if (_origOpen) _origOpen(roomId);

    setTimeout(function() {
      var joinBtn = document.querySelector('#room-modal .rm-join-btn');
      if (!joinBtn || joinBtn._phase10breath) return;
      joinBtn._phase10breath = true;

      joinBtn.addEventListener('click', function() {
        /* AudioEngine room sync dinleyicisini başlat */
        try {
          if (typeof AudioEngine !== 'undefined' && AudioEngine.getInstance) {
            var eng = AudioEngine.getInstance();
            if (eng._listenRoomEvents) eng._listenRoomEvents(roomId);
          }
        } catch(e) {}
      });
    }, 100);
  };
})();

/* ── Host Ses Değiştirme Fonksiyonu (Host için) ── */
window.hostSyncAudio = function(roomId, audioConfig) {
  if (!roomId || !audioConfig) return;
  try {
    if (typeof RoomManager !== 'undefined') {
      RoomManager.syncRoomAudio(roomId, audioConfig);
      window.SanctuaryToast && window.SanctuaryToast.success(
        audioConfig.base + ' Hz · ' + audioConfig.gen,
        '🎵 Oda sesi güncellendi'
      );
    }
  } catch(e) {
    console.warn('[hostSyncAudio] Hata:', e);
  }
};

console.info('[Sanctuary] 10. Aşama — Nefes-Aura Senkronizasyonu & Room Audio Köprüsü hazır ✓');
(function() {
  var _origSubmit = document.getElementById('btnSubmitRoom');
  function _hookSubmit() {
    var btn = document.getElementById('btnSubmitRoom');
    if (!btn || btn._phase10) return;
    btn._phase10 = true;
    btn.addEventListener('click', function() {
      var name = (document.getElementById('roomName')||{}).value;
      if (!name || !name.trim()) { var ni=document.getElementById('roomName'); if(ni)ni.focus(); return; }
      var category = (document.getElementById('roomCategory')||{}).value || 'genel';
      var isPriv = !!(document.querySelector('.type-btn.selected') && document.querySelector('.type-btn.selected').getAttribute('data-type')==='private');
      var cap = parseInt((document.getElementById('capValue')||{}).textContent||'10') || 10;
      var pwd = isPriv ? ((document.getElementById('roomPassword')||{}).value||'') : null;

      var res = window.RoomManager && window.RoomManager.createRoom({
        type: isPriv ? 'private' : 'public',
        name: name.trim(),
        hostId: 'user_local',
        capacity: cap,
        password: pwd,
        category: category,
        audioConfig: {gen:'binaural', base:432, beat:7},
      });

      window.renderRooms && window.renderRooms('all');
      var modal = document.getElementById('createRoomModal');
      if (modal) modal.style.display = 'none';
      var ni = document.getElementById('roomName'); if(ni) ni.value='';
    });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _hookSubmit);
  } else {
    setTimeout(_hookSubmit, 500);
  }
})();

/* == ADIM 8: Rol Secimi == */
(function() {
  window.showRoleSelector = function() {
    var existing = document.getElementById('role-selector-modal');
    if (existing) { existing.style.display = 'flex'; return; }
    var modal = document.createElement('div');
    modal.id = 'role-selector-modal';
    modal.style.cssText = [
      'position:fixed;inset:0;background:rgba(0,0,0,0.85);z-index:2000',
      'display:flex;flex-direction:column;align-items:center;justify-content:center',
      'gap:16px;padding:24px'
    ].join(';');

    var title = document.createElement('h2');
    title.textContent = 'Odaya Katil';
    title.style.cssText = 'color:#c9a96e;font-size:22px;margin:0 0 8px';
    modal.appendChild(title);

    var desc = document.createElement('p');
    desc.textContent = 'Yonetici olarak oda kur ya da kod girerek katil';
    desc.style.cssText = 'color:rgba(255,255,255,0.6);font-size:14px;margin:0 0 16px;text-align:center';
    modal.appendChild(desc);

    var hostBtn = document.createElement('button');
    hostBtn.textContent = 'Oda Kur (Yonetici)';
    hostBtn.style.cssText = 'width:100%;max-width:320px;padding:14px;border-radius:14px;background:linear-gradient(135deg,#c9a96e,#a07840);border:none;color:#fff;font-size:16px;cursor:pointer';
    hostBtn.onclick = window._startAsHost;
    modal.appendChild(hostBtn);

    var row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;width:100%;max-width:320px';

    var inp = document.createElement('input');
    inp.id = 'room-code-input';
    inp.placeholder = 'Oda kodu gir...';
    inp.style.cssText = 'flex:1;padding:12px;border-radius:12px;border:1px solid rgba(201,169,110,0.4);background:rgba(255,255,255,0.05);color:#fff;font-size:15px;letter-spacing:3px;text-transform:uppercase';
    row.appendChild(inp);

    var joinBtn = document.createElement('button');
    joinBtn.textContent = 'Katil';
    joinBtn.style.cssText = 'padding:12px 16px;border-radius:12px;background:rgba(201,169,110,0.15);border:1px solid rgba(201,169,110,0.4);color:#c9a96e;cursor:pointer';
    joinBtn.onclick = window._joinAsListener;
    row.appendChild(joinBtn);
    modal.appendChild(row);

    var cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Vazgec';
    cancelBtn.style.cssText = 'background:none;border:none;color:rgba(255,255,255,0.4);cursor:pointer;font-size:13px';
    cancelBtn.onclick = function() { modal.style.display = 'none'; };
    modal.appendChild(cancelBtn);

    document.body.appendChild(modal);
  };

  window._startAsHost = function() {
    var name = 'Sanctuary Odasi ' + new Date().toLocaleTimeString('tr', {hour:'2-digit', minute:'2-digit'});
    if (window.RoomManager) window.RoomManager.createRoom(name, 'meditasyon', 8);
    var m = document.getElementById('role-selector-modal');
    if (m) m.style.display = 'none';
  };

  window._joinAsListener = function() {
    var inp = document.getElementById('room-code-input');
    var code = inp ? inp.value : '';
    if (!code.trim()) { alert('Lutfen oda kodunu girin.'); return; }
    if (window.RoomManager) window.RoomManager.joinRoom(code.trim());
    var m = document.getElementById('role-selector-modal');
    if (m) m.style.display = 'none';
  };
})();

/* ══ ADIM 9: BiometricSimulator Başlat ══ */
(function() {
  window.addEventListener('load', function() {
    if (window.BiometricSimulator) {
      window.BiometricSimulator.start(3000); /* 3 saniyede bir güncelle */
      console.info('[Adım9] BiometricSimulator aktif');
    }
  });
})();

/* ══ ADIM 9: BiometricSimulator başlat ══ */
window.addEventListener('load', function() {
  if (window.BiometricSimulator) {
    window.BiometricSimulator.start(3000);
    console.info('[Adım9] BiometricSimulator aktif');
  }
});

/* ══ ADIM 12: VisualizerEngine başlat ══ */
(function() {
  var _visStarted = false;
  /* _audioToggle: AudioEngine.js sonunda tanımlanan güvenli yedek referans */
  window.togglePlay = function() {
    var fn = window._audioToggle || null;
    if (fn) fn.apply(this, arguments);
    setTimeout(function() {
      if (!_visStarted && window.VisualizerEngine) {
        window.VisualizerEngine.init('vis-canvas', window._analyser || null);
        _visStarted = true;
      }
      if (window._playing && window.VisualizerEngine) window.VisualizerEngine.start();
      else if (window.VisualizerEngine) window.VisualizerEngine.stop();
    }, 100);
  };

  /* ── selectMood: VisualizerEngine renk güncelle + Maestro tetikle ── */
  var _origMood = window.selectMood;
  if (_origMood) {
    window.selectMood = function(mood) {
      _origMood.apply(this, arguments);

      /* VisualizerEngine: sahne rengini güncelle */
      if (window.VisualizerEngine) window.VisualizerEngine.setMood(mood);

      /* GeminiAdapter: mood değişince Maestro yeniden hesapla */
      if (typeof window.getMaestroRecipe === 'function') {
        window.getMaestroRecipe('', mood, 'mood')
          .then(function(maestro) {
            console.info('[selectMood] Maestro güncellendi:', mood, '→', maestro.sceneName);
          })
          .catch(function(err) {
            console.warn('[selectMood] Maestro güncellenemedi:', err.message);
          });
      }
    };
  }

  /* ── Oracle Butonu: "Oracle Mode" — kullanıcı girdisiz, saf AI sahnesi ──
   * #ai-generate-btn'e ek olarak varsa #oracle-btn de dinlenir.
   * Her iki buton da getMaestroRecipe() → applyMSD() zincirini tetikler.
   */
  function _bindOracleButton(btn, mode) {
    if (!btn || btn._maestroBound) return;
    btn._maestroBound = true;

    btn.addEventListener('click', function(e) {
      e.preventDefault();

      /* Girdi alanından kullanıcı niyetini al (varsa) */
      var input = document.getElementById('ai-input');
      var userInput = (input && input.value.trim()) ? input.value.trim() : '';

      /* Aktif ruh halini al */
      var mood = '';
      try {
        var sm = (typeof getStateManager === 'function') ? getStateManager() : null;
        if (sm && typeof sm.getSelectedMood === 'function') mood = sm.getSelectedMood() || '';
      } catch(e) {}
      if (!mood) {
        var moodEl = document.getElementById('s-mood');
        if (moodEl) mood = moodEl.textContent.trim();
      }

      /* Loading state */
      var restoreBtn = null;
      if (window.SanctuaryLoading) {
        restoreBtn = window.SanctuaryLoading.setButtonLoading(btn, 'Oracle düşünüyor…');
      }
      if (window.SanctuaryAiUI) window.SanctuaryAiUI.showProcessing();

      window.getMaestroRecipe(userInput, mood, mode || 'oracle')
        .then(function() {
          if (restoreBtn) restoreBtn();
          if (window.SanctuaryAiUI) window.SanctuaryAiUI.hideProcessing();
        })
        .catch(function() {
          if (restoreBtn) restoreBtn();
          if (window.SanctuaryAiUI) window.SanctuaryAiUI.hideProcessing();
        });
    });
  }

  /* Oracle butonlarını DOMContentLoaded'da bağla */
  function _initOracleButtons() {
    _bindOracleButton(document.getElementById('ai-generate-btn'), 'mood');
    _bindOracleButton(document.getElementById('oracle-btn'),       'oracle');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _initOracleButtons);
  } else {
    setTimeout(_initOracleButtons, 0);
  }
})();
