/* ═══════════════════════════════════════════════════════════════════════
   SANCTUARY LearningEngine v2
   ─────────────────────────────────────────────────────────────────────
   Adım 2.2 — Biyometrik korelasyon + Oturum gözlemcisi + PreferenceVector
   • Sahne/frekans dinleme süresi → Affinity skoru
   • Stres %20+ düşüşü → "Highly Effective" etiketi
   • updateGlobalPreferences() → window.PreferenceVector push
   • localStorage kalıcılığı
   ═══════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  var STORAGE_KEY        = 'sanctuary_learning_v2';
  var AFFINITY_THRESHOLD = 300;   /* 5 dakika (saniye) → Affinity artışı */
  var STRESS_DROP_MIN    = 0.20;  /* %20 stres düşüşü → Highly Effective */
  var MAX_LOG            = 200;

  /* ── Kalıcı Durum ─────────────────────────────────────────────────── */
  var _state = _loadState();

  function _defaultState() {
    return {
      affinityMap : {},   /* { "528Hz_waves": { score, listenSec, effectiveCount } } */
      bioLog      : [],   /* AdaptiveEngine'den gelen shift kayıtları */
      sessionLog  : [],   /* Tamamlanan oturumlar */
    };
  }

  function _loadState() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) {}
    return _defaultState();
  }

  function _saveState() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(_state)); } catch (e) {}
  }

  /* ── Dahili Oturum Değişkenleri ───────────────────────────────────── */
  var _activeSound   = null;
  var _activeGen     = null;
  var _activeBase    = 0;
  var _sessionStart  = Date.now();
  var _lastVolume    = 1.0;
  var _stressAtStart = null;
  var _listenTimer   = null;

  /* ── Yardımcı: Sahne Anahtarı ─────────────────────────────────────── */
  function _key(gen, base) {
    return (gen || 'unknown') + '_' + (base || '0');
  }

  function _ensureKey(k) {
    if (!_state.affinityMap[k]) {
      _state.affinityMap[k] = { score: 0, listenSec: 0, effectiveCount: 0 };
    }
  }

  /* ── Oturum Gözlemcisi: 5+ dakika dinleme → Affinity ──────────────── */
  function _startListenTimer() {
    _stopListenTimer();
    _listenTimer = setInterval(function () {
      if (!_activeSound) return;
      var elapsed = (Date.now() - _sessionStart) / 1000;
      _ensureKey(_activeSound);
      _state.affinityMap[_activeSound].listenSec = elapsed;

      if (elapsed >= AFFINITY_THRESHOLD) {
        _state.affinityMap[_activeSound].score += 0.05;
        console.info('[LearningEngine] Affinity +0.05 →', _activeSound,
          '| toplam:', _state.affinityMap[_activeSound].score.toFixed(2));
        _saveState();
      }
    }, 10000);
  }

  function _stopListenTimer() {
    if (_listenTimer) { clearInterval(_listenTimer); _listenTimer = null; }
  }

  /* ── Biyometrik Korelasyon ────────────────────────────────────────── */
  function recordBiometricShift(entry) {
    _state.bioLog.push(entry);
    if (_state.bioLog.length > MAX_LOG) _state.bioLog.shift();

    if (_stressAtStart === null && typeof entry.stress === 'number') {
      _stressAtStart = entry.stress;
    }

    if (_stressAtStart !== null && typeof entry.stress === 'number') {
      var drop = _stressAtStart - entry.stress;
      if (drop >= STRESS_DROP_MIN && _activeSound) {
        _ensureKey(_activeSound);
        _state.affinityMap[_activeSound].effectiveCount += 1;
        _state.affinityMap[_activeSound].score += 0.10;
        console.info('[LearningEngine] Highly Effective →', _activeSound,
          '| stres düşüşü:', (drop * 100).toFixed(0) + '%');
        updateGlobalPreferences();
        _showOptimizeNotif();
      }
    }

    _saveState();
  }

  /* ── PreferenceVector Güncelleme ──────────────────────────────────── */
  function updateGlobalPreferences() {
    if (!window.PreferenceVector) window.PreferenceVector = {};

    var best = null, bestScore = -Infinity;
    Object.keys(_state.affinityMap).forEach(function (k) {
      var s = _state.affinityMap[k].score;
      if (s > bestScore) { bestScore = s; best = k; }
    });

    if (best) {
      var parts = best.split('_');
      window.PreferenceVector.preferredGen  = parts[0] || null;
      window.PreferenceVector.preferredBase = parseInt(parts[1]) || null;
      window.PreferenceVector.affinityMap   = _state.affinityMap;
      window.PreferenceVector.lastUpdated   = Date.now();
      console.info('[LearningEngine] PreferenceVector güncellendi →', best,
        '| skor:', bestScore.toFixed(2));
    }

    if (window.PreferenceVector.layerGains) {
      try {
        localStorage.setItem('sanctuary_layerGains',
          JSON.stringify(window.PreferenceVector.layerGains));
      } catch (e) {}
    }

    _saveState();
  }

  /* ── Eski API Uyumluluğu ─────────────────────────────────────────── */
  function onSoundChange(soundId, volume) {
    var gen  = window._lastGen  || soundId || 'unknown';
    var base = window._lastBase || 0;
    var key  = _key(gen, base);

    if (_activeSound && _activeSound !== key) {
      var dur = (Date.now() - _sessionStart) / 1000;
      if (dur < 30) {
        _ensureKey(_activeSound);
        _state.affinityMap[_activeSound].score = Math.max(0,
          _state.affinityMap[_activeSound].score - 0.05);
      }
      _state.sessionLog.push({
        key: _activeSound, durationSec: dur,
        stressStart: _stressAtStart, ts: Date.now()
      });
      if (_state.sessionLog.length > 50) _state.sessionLog.shift();
    }

    _activeSound   = key;
    _activeGen     = gen;
    _activeBase    = base;
    _lastVolume    = volume || 1.0;
    _sessionStart  = Date.now();
    _stressAtStart = null;

    _ensureKey(key);
    _state.affinityMap[key].score += 0.02;
    _startListenTimer();

    if (window.PreferenceManager)
      window.PreferenceManager.updateSoundWeight(soundId, 0.02);

    _saveState();
  }

  function onVolumeChange(soundId, volume) {
    if (!window.PreferenceManager) return;
    var delta = volume > _lastVolume ? 0.03 : -0.03;
    window.PreferenceManager.updateSoundWeight(soundId || _activeSound, delta);
    _lastVolume = volume;
  }

  function onSessionEnd(completionRate) {
    _stopListenTimer();
    if (_activeSound) {
      _ensureKey(_activeSound);
      _state.affinityMap[_activeSound].score += (completionRate || 0) * 0.1;
    }
    if (window.PreferenceManager) window.PreferenceManager.recordCompletion(completionRate);
    updateGlobalPreferences();
    _showOptimizeNotif();
    _saveState();
  }

  /* ── Bildirim ────────────────────────────────────────────────────── */
  function _showOptimizeNotif() {
    var existing = document.getElementById('optimize-notif');
    if (existing) existing.remove();
    var el = document.createElement('div');
    el.id = 'optimize-notif';
    el.textContent = '✦ Senin için optimize ediliyor...';
    el.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);'
      + 'background:rgba(6,10,24,0.95);border:1px solid rgba(201,169,110,0.25);'
      + 'border-radius:20px;padding:8px 18px;font-size:11px;color:rgba(201,169,110,0.8);'
      + 'letter-spacing:1px;z-index:900;pointer-events:none;opacity:0;transition:opacity 0.4s;';
    document.body.appendChild(el);
    setTimeout(function () { el.style.opacity = '1'; }, 50);
    setTimeout(function () {
      el.style.opacity = '0';
      setTimeout(function () { if (el.parentNode) el.remove(); }, 400);
    }, 3000);
  }

  /* ── Public API ─────────────────────────────────────────────────── */
  window.LearningEngine = {
    onSoundChange          : onSoundChange,
    onVolumeChange         : onVolumeChange,
    onSessionEnd           : onSessionEnd,
    recordBiometricShift   : recordBiometricShift,
    updateGlobalPreferences: updateGlobalPreferences,
    getAffinityMap         : function () { return _state.affinityMap; },
    getBioLog              : function () { return _state.bioLog.slice(); },
    showOptimizeNotif      : _showOptimizeNotif,
  };

  console.info('[LearningEngine v2] Biyometrik korelasyon + Affinity sistemi hazır.');
})();