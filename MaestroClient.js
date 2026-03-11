/* ═══════════════════════════════════════════════════════════════════════
   MaestroClient.js — Sanctuary v4
   ─────────────────────────────────────────────────────────────────────
   Client-side Maestro köprüsü:
   • generateScene(mood)      → Netlify'a istek at, Recipe al
   • applyMaestroRecipe(r)    → AudioEngine v4'e uygula
   • PreferenceVector bağlamı → istekle birlikte gönder
   • Safe Recipe fallback     → ses asla durmasın
   ═══════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  /* ── Sunucu Endpoint ─────────────────────────────────────────────── */
  var MAESTRO_URL = (typeof SANCTUARY_API_URL !== 'undefined')
    ? SANCTUARY_API_URL + '/gemini'
    : '/.netlify/functions/gemini';

  /* ── Safe Recipe: API tamamen çökerse ses devam eder ─────────────── */
  var SAFE_RECIPE = {
    sceneName     : 'Calm Breath',
    baseHz        : 432,
    binauralHz    : 4.0,
    textures      : [{name:'ocean',gain:0.60},{name:'wind',gain:0.25}],
    breath        : [4,4,8],
    textureLevels : { rain:0.0, fire:0.0, wind:0.25 },
    filterSettings: { cutoff:1800, resonance:0.6 },
    pulseRate     : 16,
  };

  /* ── Texture → Generator eşlemesi (AudioEngine ile uyumlu) ──────── */
  var TEXTURE_TO_GEN = {
    'ocean':'waves', 'river':'waves',
    'rain':'rain',   'white-noise':'rain',
    'forest':'wind', 'wind':'wind', 'night':'wind', 'whisper':'wind',
    'fire':'fire',
    'zen':'binaural',
  };

  /* ── PreferenceVector özeti oluştur (gizlilik: sadece gerekli alan) */
  function _buildPrefContext() {
    var pv = window.PreferenceVector;
    if (!pv) return null;
    return {
      preferredGen  : pv.preferredGen  || null,
      preferredBase : pv.preferredBase || null,
    };
  }

  /* ── Ana İstek Fonksiyonu ────────────────────────────────────────── */
  function generateScene(mood, extraInput) {
    var payload = {
      mood             : mood || 'Calm',
      input            : extraInput || '',
      preferenceContext: _buildPrefContext(),
    };

    return fetch(MAESTRO_URL, {
      method  : 'POST',
      headers : {'Content-Type':'application/json'},
      body    : JSON.stringify(payload),
    })
    .then(function (res) { return res.json(); })
    .then(function (recipe) {
      if (!recipe || typeof recipe !== 'object' || !recipe.baseHz) {
        console.warn('[MaestroClient] Geçersiz yanıt — Safe Recipe kullanılıyor');
        return SAFE_RECIPE;
      }
      console.info('[MaestroClient] Recipe alındı:', recipe.sceneName,
        '|', recipe.baseHz + 'Hz');
      return recipe;
    })
    .catch(function (err) {
      console.warn('[MaestroClient] Ağ hatası — Safe Recipe:', err.message);
      return SAFE_RECIPE;
    });
  }

  /* ── Recipe Uygulama Bridge ──────────────────────────────────────── */
  function applyMaestroRecipe(recipe) {
    if (!recipe || typeof recipe !== 'object') {
      console.warn('[MaestroClient] Geçersiz recipe — Safe Recipe uygulanıyor');
      recipe = SAFE_RECIPE;
    }

    var ae = window.Sanctuary && window.Sanctuary.AudioEngine;

    /* 1. Ses sahnesi: en baskın texture'dan gen belirle */
    var firstTex = (recipe.textures && recipe.textures[0]) ? recipe.textures[0].name : 'ocean';
    var gen      = TEXTURE_TO_GEN[firstTex] || 'waves';
    var base     = recipe.baseHz    || 432;
    var beat     = recipe.binauralHz || 4.0;

    if (typeof window.switchSound === 'function') {
      window.switchSound(gen, base, beat, recipe.sceneName || null, recipe);
    } else if (ae && typeof ae.switchSound === 'function') {
      ae.switchSound(gen, base, beat, recipe.sceneName || null, recipe);
    }

    /* 2. Layer gains: textureLevels varsa updateLayerGains çağır */
    if (recipe.textureLevels && ae && typeof ae.updateLayerGains === 'function') {
      var tl    = recipe.textureLevels;
      /* Synth = binaural/solfeggio katmanı → sabit 0.30 veya PreferenceVector */
      var synth = (window.PreferenceVector && window.PreferenceVector.layerGains)
        ? (window.PreferenceVector.layerGains.synth || 0.30)
        : 0.30;
      /* Texture = tüm doğa sesleri toplamının normalize edilmiş ağırlığı */
      var texMax = Math.max(tl.rain || 0, tl.fire || 0, tl.wind || 0,
        (recipe.textures || []).reduce(function (m, t) { return Math.max(m, t.gain||0); }, 0));
      var texture = Math.min(0.90, Math.max(0.40, texMax || 0.70));
      ae.updateLayerGains(synth, texture);
    }

    /* 3. applyMSD: maestro nesnesini doğrudan AudioEngine'e ilet */
    if (typeof window.applyMSD === 'function') {
      window.applyMSD(recipe);
    } else if (ae && typeof ae.applyMSD === 'function') {
      ae.applyMSD(recipe);
    }

    /* 4. LearningEngine'e bildir */
    if (window.LearningEngine && typeof window.LearningEngine.onSoundChange === 'function') {
      window.LearningEngine.onSoundChange(gen + '_' + base, 1.0);
    }

    console.info('[MaestroClient] Recipe uygulandı →', recipe.sceneName || gen,
      '| synth bus:', recipe.filterSettings ? recipe.filterSettings.cutoff + 'Hz' : '-');

    return recipe;
  }

  /* ── Convenience: tek çağrıyla üret + uygula ─────────────────────── */
  function generateAndApply(mood, extraInput) {
    return generateScene(mood, extraInput).then(applyMaestroRecipe);
  }

  /* ── Public API ─────────────────────────────────────────────────── */
  window.MaestroClient = {
    generateScene     : generateScene,
    applyMaestroRecipe: applyMaestroRecipe,
    generateAndApply  : generateAndApply,
    getSafeRecipe     : function () { return Object.assign({}, SAFE_RECIPE); },
  };

  /* Geriye dönük uyumluluk */
  window.generateMaestroScene = generateAndApply;

  console.info('[MaestroClient v4] Maestro köprüsü hazır. Endpoint:', MAESTRO_URL);
})();
