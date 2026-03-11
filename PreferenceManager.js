/* ══════════════════════════════════════════════════════════════
   PreferenceManager.js — Sanctuary Adım 10
   Kullanıcı tercih vektörünü saklar ve günceller
   ══════════════════════════════════════════════════════════════ */
(function() {
  'use strict';

  var STORAGE_KEY = 'sanctuary_preference_vector';

  var _defaults = {
    tempoPreference   : 0.5,   /* 0=yavaş, 1=hızlı */
    natureIntensity   : 0.6,   /* Doğa sesi yoğunluğu */
    binauralPreference: 0.5,   /* Binaural tercih */
    voicePresence     : 0.3,   /* Ses miktarı */
    sessionCount      : 0,     /* Toplam oturum */
    lastMood          : null,  /* Son seçilen mood */
    soundWeights      : {},    /* { soundId: weight } */
    completionRates   : [],    /* Son 10 oturum tamamlanma oranı */
    updatedAt         : null
  };

  var _vector = _load();

  function _load() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return Object.assign({}, _defaults, JSON.parse(raw));
    } catch(e) {}
    return Object.assign({}, _defaults);
  }

  function _save() {
    try {
      _vector.updatedAt = Date.now();
      localStorage.setItem(STORAGE_KEY, JSON.stringify(_vector));
    } catch(e) { console.warn('[PreferenceManager] Kayıt hatası', e); }
  }

  /* Ses ağırlığını artır/azalt */
  function updateSoundWeight(soundId, delta) {
    if (!_vector.soundWeights[soundId]) _vector.soundWeights[soundId] = 0.5;
    _vector.soundWeights[soundId] = Math.max(0, Math.min(1,
      _vector.soundWeights[soundId] + delta
    ));
    _save();
  }

  /* Oturum tamamlanma oranını kaydet */
  function recordCompletion(rate) {
    _vector.completionRates.push(rate);
    if (_vector.completionRates.length > 10) _vector.completionRates.shift();
    _vector.sessionCount++;
    _save();
  }

  /* Mood seçimini kaydet */
  function recordMood(mood) {
    _vector.lastMood = mood;
    _save();
  }

  /* Gemini için context özeti */
  function getGeminiContext() {
    var topSounds = Object.entries(_vector.soundWeights)
      .sort(function(a,b){ return b[1]-a[1]; })
      .slice(0,3)
      .map(function(e){ return e[0]; });
    var avgCompletion = _vector.completionRates.length
      ? (_vector.completionRates.reduce(function(a,b){return a+b;},0) / _vector.completionRates.length).toFixed(2)
      : '0.50';
    return {
      preferredSounds : topSounds,
      tempoPreference : _vector.tempoPreference,
      natureIntensity : _vector.natureIntensity,
      sessionCount    : _vector.sessionCount,
      avgCompletion   : parseFloat(avgCompletion),
      lastMood        : _vector.lastMood
    };
  }

  function getVector() { return Object.assign({}, _vector); }

  function reset() {
    _vector = Object.assign({}, _defaults);
    localStorage.removeItem(STORAGE_KEY);
  }

  window.PreferenceManager = {
    updateSoundWeight : updateSoundWeight,
    recordCompletion  : recordCompletion,
    recordMood        : recordMood,
    getGeminiContext  : getGeminiContext,
    getVector         : getVector,
    reset             : reset
  };
  console.info('[PreferenceManager] Adım 10 hazır. Oturum:', _vector.sessionCount);
})();