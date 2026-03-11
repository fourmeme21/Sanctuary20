/* ═══════════════════════════════════════════════════════════════════════
   SANCTUARY AdaptiveEngine v2
   ─────────────────────────────────────────────────────────────────────
   Adım 2.1 — BiometricSimulator ↔ AudioEngine v4 köprüsü
   • BPM + HRV → stressLevel (0.0–1.0) hesaplama
   • Her 3 saniyede applyBiometricEffect() çağrısı
   • LearningEngine için biyometrik log
   ═══════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  /* ── Dahili durum ─────────────────────────────────────────────────── */
  var _lastData     = null;
  var _throttle     = null;
  var _feedbackLoop = null;
  var _shiftLog     = [];          /* LearningEngine için biyometrik log */
  var LOOP_INTERVAL = 3000;        /* 3 saniyede bir feedback */

  /* ── Stres Hesaplama ──────────────────────────────────────────────
     BPM referans aralığı : 45–110  (yüksek BPM → yüksek stres)
     HRV referans aralığı : 10–80ms (düşük HRV  → yüksek stres)
     İki faktörün ağırlıklı ortalaması: BPM %40, HRV %60
  ─────────────────────────────────────────────────────────────────── */
  function _calcStress(bpm, hrv) {
    var bpmNorm  = Math.max(0, Math.min(1, (bpm - 45) / 65));   /* 45→0, 110→1 */
    var hrvNorm  = Math.max(0, Math.min(1, 1 - ((hrv - 10) / 70))); /* 80→0, 10→1 */
    return (bpmNorm * 0.40) + (hrvNorm * 0.60);
  }

  /* ── Biyometrik Veri Kaynağı ──────────────────────────────────────
     Önce window.SanctuaryState, sonra BiometricSimulator'a bakar.
  ─────────────────────────────────────────────────────────────────── */
  function _readBiometrics() {
    /* SanctuaryState (canlı veri öncelikli) */
    if (window.SanctuaryState && window.SanctuaryState.biometrics) {
      return window.SanctuaryState.biometrics;
    }
    /* BiometricSimulator fallback */
    if (window.BiometricSimulator && typeof window.BiometricSimulator.getData === 'function') {
      return window.BiometricSimulator.getData();
    }
    /* _lastData (en son gelen push verisi) */
    return _lastData;
  }

  /* ── Ana Adaptasyon Fonksiyonu ───────────────────────────────────── */
  function _applyAdaptation(data) {
    if (!data) return;

    var bpm    = typeof data.bpm === 'number' ? data.bpm : 70;
    var hrv    = typeof data.hrv === 'number' ? data.hrv : 50;
    var stress = (typeof data.stress === 'number')
      ? data.stress
      : _calcStress(bpm, hrv);

    /* AudioEngine v4 bridge */
    var ae = window.Sanctuary && window.Sanctuary.AudioEngine;
    if (ae && typeof ae.applyBiometricEffect === 'function') {
      ae.applyBiometricEffect({
        tension      : stress,          /* Ducking & Balance için */
        hrv          : hrv,             /* Alternatif tension kaynağı */
        masterVolume : 0.8 - stress * 0.2,
        eqLowBoost   : stress * 3,
        eqHighCut    : -(stress * 2),
      });
    } else if (typeof window.applyBiometricEffect === 'function') {
      /* Eski API uyumluluğu */
      window.applyBiometricEffect({
        tension      : stress,
        masterVolume : 0.8 - stress * 0.2,
        eqLowBoost   : stress * 3,
        eqHighCut    : -(stress * 2),
      });
    }

    /* UI güncelleme */
    if (typeof window._bioUpdateUI === 'function') {
      window._bioUpdateUI(data);
    }

    /* LearningEngine logu */
    _logShift(bpm, hrv, stress);

    console.info('[AdaptiveEngine] stress:', stress.toFixed(2),
      '| bpm:', bpm, '| hrv:', hrv);
  }

  /* ── LearningEngine Log ──────────────────────────────────────────── */
  function _logShift(bpm, hrv, stress) {
    var entry = {
      ts    : Date.now(),
      bpm   : bpm,
      hrv   : hrv,
      stress: parseFloat(stress.toFixed(3)),
      gen   : window._lastGen  || null,
      base  : window._lastBase || null,
    };
    _shiftLog.push(entry);
    if (_shiftLog.length > 200) _shiftLog.shift(); /* Son 200 kayıt */

    /* LearningEngine varsa direkt bildir */
    if (window.LearningEngine && typeof window.LearningEngine.recordBiometricShift === 'function') {
      try { window.LearningEngine.recordBiometricShift(entry); } catch (e) {}
    }
  }

  /* ── 3 Saniyelik Feedback Döngüsü ──────────────────────────────── */
  function _startFeedbackLoop() {
    if (_feedbackLoop) return;
    _feedbackLoop = setInterval(function () {
      var data = _readBiometrics();
      if (data) _applyAdaptation(data);
    }, LOOP_INTERVAL);
    console.info('[AdaptiveEngine] Feedback loop başladı (' + LOOP_INTERVAL + 'ms)');
  }

  function _stopFeedbackLoop() {
    if (_feedbackLoop) {
      clearInterval(_feedbackLoop);
      _feedbackLoop = null;
      console.info('[AdaptiveEngine] Feedback loop durduruldu');
    }
  }

  /* ── Push Listener (BiometricSimulator event tabanlı) ────────────── */
  function onBiometricUpdate(data) {
    _lastData = data;
    if (_throttle) return;
    _throttle = setTimeout(function () {
      _throttle = null;
      _applyAdaptation(_lastData);
    }, 500);
  }

  /* ── Public API ─────────────────────────────────────────────────── */
  window.AdaptiveEngine = {
    onBiometricUpdate : onBiometricUpdate,
    getLastData       : function () { return _lastData; },
    getShiftLog       : function () { return _shiftLog.slice(); },
    calcStress        : _calcStress,
    startLoop         : _startFeedbackLoop,
    stopLoop          : _stopFeedbackLoop,
  };

  /* Otomatik başlat */
  _startFeedbackLoop();

  console.info('[AdaptiveEngine v2] Biyometrik köprü hazır. Loop: ' + LOOP_INTERVAL + 'ms');
})();
