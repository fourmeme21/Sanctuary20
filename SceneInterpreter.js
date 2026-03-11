/**
 * SceneInterpreter.js — Maestro JSON → AudioEngine + CSS Komut Çevirici
 * ─────────────────────────────────────────────────────────────────────────────
 * GeminiAdapter'dan gelen MAESTRO JSON'unu (baseHz, binauralHz, textures, breath)
 * Maestro JSON'unu window.switchSound() çağrısına ve CSS/UI komutlarına çevirir.
 * ─────────────────────────────────────────────────────────────────────────────
 * Desteklenen protokol:
 *   maestro.baseHz       {number}  — Ana şifa frekansı (Hz)
 *   maestro.binauralHz   {number}  — Binaural beat frekansı (Hz)
 *   maestro.textures     [{name, gain, file, isBinaural}]
 *   maestro.breath       [inhale, hold, exhale]
 *   maestro.sceneName    {string}  — Sahne adı
 *   maestro.velvetReady  {boolean} — GeminiAdapter doğrulama bayrağı
 * ─────────────────────────────────────────────────────────────────────────────
 */

/* Stereo pan değerleri (ses tipine göre) */
var _PAN_MAP = { ambient: 0.65, binaural: 0.0, tone: 0.2, noise: 0.5, fire: 0.4 };

function _applyPan(type, engine, layerId) {
  try {
    var panVal = _PAN_MAP[type] || 0.3;
    if (engine && typeof engine.setPan === 'function') {
      engine.setPan(layerId, (Math.random() > 0.5 ? 1 : -1) * panVal);
    }
  } catch (e) { /* sessizce geç */ }
}

const SceneInterpreter = (function () {

  /* ── Tema paleti (baseHz aralıklarına göre) ──────────────────────────── */
  const FREQ_TO_THEME = [
    { max: 100,      theme: 'theme-delta', label: 'Delta'  },
    { max: 250,      theme: 'theme-theta', label: 'Theta'  },
    { max: 500,      theme: 'theme-alpha', label: 'Alpha'  },
    { max: 1000,     theme: 'theme-beta',  label: 'Beta'   },
    { max: Infinity, theme: 'theme-gamma', label: 'Gamma'  },
  ];

  /* ── Dosya adı → AudioEngine generator tipi eşlemesi ─────────────────── */
  const FILE_TO_GEN = {
    'ocean.mp3'      : 'waves',
    'rain.mp3'       : 'rain',
    'forest.mp3'     : 'wind',
    'wind.mp3'       : 'wind',
    'fire.mp3'       : 'fire',
    'zen-bowl.mp3'   : 'binaural',
    'whisper.mp3'    : 'ambient',
    'river.mp3'      : 'waves',
    'night.mp3'      : 'ambient',
    'white-noise.mp3': 'noise',
    'pink-noise.mp3' : 'noise',
    'ambient.mp3'    : 'ambient',
    '__binaural__'   : 'binaural',
  };

  /* ═══════════════════════════════════════════════════════════════════════
     interpret() — Maestro JSON'unu komut setlerine çevir
  ═══════════════════════════════════════════════════════════════════════ */
  function interpret(maestro) {
    if (!maestro || typeof maestro !== 'object') {
      console.error('[SceneInterpreter] Geçersiz Maestro JSON:', maestro);
      return null;
    }

    /* velvetReady kontrolü — GeminiAdapter bypass tespiti */
    if (maestro.velvetReady !== true) {
      console.warn('[SceneInterpreter] velvetReady bayrağı yok — ham veri kabul edilmedi.');
      return null;
    }

    return {
      audioScript  : _buildAudioScript(maestro),   /* switchSound() argümanları */
      cssCommands  : _buildCSSCommands(maestro),
      uiCommands   : _buildUICommands(maestro),
      breathOptions: _buildBreathOptions(maestro),  /* startBreathCycle() seçenekleri */
    };
  }

  /* ═══════════════════════════════════════════════════════════════════════
     apply() — Komut setini AudioEngine + DOM'a uygula
  ═══════════════════════════════════════════════════════════════════════ */
  function apply(result, options) {
    options = options || {};
    if (!result) return;

    /* 1. switchSound() — direkt AudioEngine sentezleyicisi */
    _applyAudioScript(result.audioScript);

    /* 2. CSS tema + animasyon hızı */
    _applyCSSCommands(result.cssCommands);

    /* 3. UI etiketleri */
    _applyUICommands(result.uiCommands);

    /* 4. Nefes döngüsü */
    if (options.breathWrap && options.guideEl) {
      _applyBreathCycle(result.breathOptions, options.engine, options.breathWrap, options.guideEl);
    }
  }

  /* ─────────────────────────────────────────────────────────────────────
     TEXTURE → GEN MAP
     AudioEngine makeBuffer() desteklediği tipler: waves|rain|wind|fire|storm|binaural
  ───────────────────────────────────────────────────────────────────── */
  var TEXTURE_TO_GEN = {
    'ocean'      : 'waves',
    'river'      : 'waves',
    'rain'       : 'rain',
    'forest'     : 'wind',
    'wind'       : 'wind',
    'night'      : 'wind',
    'whisper'    : 'wind',
    'fire'       : 'fire',
    'zen'        : 'binaural',
    'white-noise': 'rain',
    'pink-noise' : 'rain',
    'binaural'   : 'binaural',
    'waves'      : 'waves',
    'storm'      : 'storm',
    'ambient'    : 'wind',
  };

  /* ─────────────────────────────────────────────────────────────────────
     SWITCH COMMAND — window.switchSound(gen, base, beat, label)
     loadScript() veya /samples/ bağımlılığı yok.
     Doğrudan AudioEngine sentezleyicisine konuşur.
  ───────────────────────────────────────────────────────────────────── */
  function _buildAudioScript(maestro) {
    var textures = Array.isArray(maestro.textures) ? maestro.textures : [];

    /* Birincil ambient texture — binaural olmayan ilk öğe */
    var primaryGen  = 'waves';
    var primaryGain = 0.60;

    for (var i = 0; i < textures.length; i++) {
      var t   = textures[i];
      var gen = TEXTURE_TO_GEN[t.name] || 'wind';
      if (gen === 'binaural') continue;
      primaryGen  = gen;
      primaryGain = typeof t.gain === 'number' ? t.gain : 0.60;
      break;
    }

    return {
      gen    : primaryGen,
      base   : maestro.baseHz     || 432,
      beat   : maestro.binauralHz || 7,
      label  : maestro.sceneName  || 'Sanctuary',
      gain   : primaryGain,
      maestro: maestro,   /* AudioEngine v4 texture katmanları için */
    };
  }

  function _applyAudioScript(cmd) {
    if (!cmd) return;

    if (typeof window.switchSound !== 'function') {
      console.warn('[SceneInterpreter] window.switchSound bulunamadı.');
      return;
    }

    window.switchSound(cmd.gen, cmd.base, cmd.beat, cmd.label, cmd.maestro);

    try {
      if (typeof window.setMasterVolume === 'function') {
        window.setMasterVolume(Math.max(0.3, Math.min(0.95, cmd.gain * 1.2)));
      }
    } catch (e) {}

    try {
      localStorage.setItem('lastGen',  cmd.gen);
      localStorage.setItem('lastBase', cmd.base);
      localStorage.setItem('lastBeat', cmd.beat);
    } catch (e) {}

    console.info('[SceneInterpreter] ✅ switchSound →',
      cmd.gen, '|', cmd.base + 'Hz base /', cmd.beat + 'Hz beat |', cmd.label);
  }

  /* ─────────────────────────────────────────────────────────────────────
     CSS KOMUTLARI
  ───────────────────────────────────────────────────────────────────── */
  function _buildCSSCommands(maestro) {
    var freq  = maestro.baseHz || 432;
    var entry = FREQ_TO_THEME.find(function (e) { return freq <= e.max; })
                || FREQ_TO_THEME[FREQ_TO_THEME.length - 1];

    /* Binaural frekansından yaklaşık BPM hesapla (görsel ritim için) */
    var approxBpm = maestro.binauralHz > 0
      ? Math.round(maestro.binauralHz * 10)   /* örn: 7 Hz → 70 BPM */
      : 60;

    return {
      theme    : entry.theme,
      freqLabel: entry.label,
      bpm      : Math.max(40, Math.min(120, approxBpm)),
    };
  }

  function _applyCSSCommands(css) {
    if (!css) return;
    try {
      var root = document.documentElement;

      /* Eski tema sınıflarını temizle */
      root.classList.forEach(function (cls) {
        if (cls.startsWith('theme-')) root.classList.remove(cls);
      });
      root.classList.add(css.theme);

      /* CSS custom properties — animasyon hızı */
      var beatDur = (60 / css.bpm).toFixed(3) + 's';
      root.style.setProperty('--beat-duration', beatDur);
      root.style.setProperty('--tempo-bpm', css.bpm);
    } catch (e) {
      console.warn('[SceneInterpreter] CSS komutu hatası:', e);
    }
  }

  /* ─────────────────────────────────────────────────────────────────────
     UI KOMUTLARI
  ───────────────────────────────────────────────────────────────────── */
  function _buildUICommands(maestro) {
    return {
      sceneName : maestro.sceneName || 'Sanctuary',
      baseHz    : maestro.baseHz,
      binauralHz: maestro.binauralHz,
      freqLabel : maestro.baseHz + ' Hz',
    };
  }

  function _applyUICommands(ui) {
    if (!ui) return;
    try {
      /* Sahne adı */
      var nameEl = document.getElementById('scene-name');
      if (nameEl) nameEl.textContent = ui.sceneName;

      /* Frekans rozeti */
      var freqEl = document.getElementById('freq-label');
      if (freqEl) freqEl.textContent = ui.freqLabel;

      /* AI sonuç alanı */
      var resultEl = document.getElementById('ai-result-text');
      if (resultEl) resultEl.textContent = ui.sceneName + ' · ' + ui.baseHz + ' Hz · Binaural ' + ui.binauralHz + ' Hz';

      /* Frekans rozeti görünürlük */
      var badge = document.getElementById('freq-badge');
      if (badge) badge.style.opacity = '1';
    } catch (e) {
      console.warn('[SceneInterpreter] UI komutu hatası:', e);
    }
  }

  /* ─────────────────────────────────────────────────────────────────────
     NEFES DÖNGÜSÜ SEÇENEKLERİ
  ───────────────────────────────────────────────────────────────────── */
  function _buildBreathOptions(maestro) {
    var breath = Array.isArray(maestro.breath) ? maestro.breath : [4, 2, 6];
    return {
      inhale    : breath[0] || 4,
      hold      : breath[1] || 2,
      exhale    : breath[2] || 6,
      volInhale : 0.85,
      volExhale : 0.55,
    };
  }

  function _applyBreathCycle(options, engine, breathWrap, guideEl) {
    if (typeof window.startBreathCycle !== 'function') return;
    try {
      /* Önceki döngüyü durdur */
      if (window._activeBreathStop) {
        window._activeBreathStop();
        window._activeBreathStop = null;
      }
      window._activeBreathStop = window.startBreathCycle(engine, breathWrap, guideEl, options);
    } catch (e) {
      console.warn('[SceneInterpreter] Nefes döngüsü başlatılamadı:', e);
    }
  }

  /* ── Public API ───────────────────────────────────────────────────────── */
  return { interpret: interpret, apply: apply };

})();

/* ── Export ─────────────────────────────────────────────────────────────── */
if (typeof module !== 'undefined') {
  module.exports = SceneInterpreter;
} else {
  window.SceneInterpreter = SceneInterpreter;
}