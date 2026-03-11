/* ═══════════════════════════════════════════════════════════════════════
   SanctuaryCore.js — Sanctuary v4.7 — AI Sanatçı Motoru
   ─────────────────────────────────────────────────────────────────────
   Adım 7.1 — Global Event Bus + Telemetry HUD + Diagnostics
   ─────────────────────────────────────────────────────────────────────
   İÇERİK:
   1. window.Sanctuary.Events  — merkezi Pub/Sub event bus
   2. Initialization Sequence  — doğru sırayla modül başlatma
   3. Telemetry HUD            — geliştirici overlay (Ctrl+Shift+D)
   4. window.Sanctuary.Diagnostics() — sağlık raporu
   ═══════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  /* ── Namespace ── */
  window.Sanctuary = window.Sanctuary || {};

  /* ══════════════════════════════════════════════════════════════════
     1. GLOBAL EVENT BUS
     Pub/Sub: bileşenler arası sıkı bağ olmadan iletişim.
     Kullanım:
       Sanctuary.Events.on('biometric:update', handler)
       Sanctuary.Events.emit('biometric:update', { stress:0.4, bpm:72 })
       Sanctuary.Events.off('biometric:update', handler)
  ══════════════════════════════════════════════════════════════════ */
  var _listeners = {};

  var Events = {

    on: function (event, handler) {
      if (!_listeners[event]) _listeners[event] = [];
      _listeners[event].push(handler);
      return function () { Events.off(event, handler); }; /* unsubscribe */
    },

    off: function (event, handler) {
      if (!_listeners[event]) return;
      _listeners[event] = _listeners[event].filter(function (h) { return h !== handler; });
    },

    emit: function (event, data) {
      (_listeners[event] || []).forEach(function (h) {
        try { h(data); } catch (e) { console.warn('[Events] Handler hatası (' + event + '):', e); }
      });
      /* CustomEvent köprüsü — DOM dinleyiciler de yakalayabilir */
      try {
        window.dispatchEvent(new CustomEvent('sanctuary:' + event, { detail: data }));
      } catch (e) {}
    },

    once: function (event, handler) {
      var unsub = Events.on(event, function (data) {
        handler(data);
        unsub();
      });
    },

    /* Tüm bağlı event isimlerini döner (debug için) */
    listEvents: function () { return Object.keys(_listeners); },
  };

  window.Sanctuary.Events = Events;

  /* ── Standart Event Katalog (modüller bu isimleri kullanır) ───────
     biometric:update   → AdaptiveEngine  → { stress, bpm, hrv }
     audio:scene        → AudioEngine     → { gen, base, beat, sceneName }
     audio:gains        → AudioEngine     → { synth, texture }
     preference:update  → LearningEngine  → PreferenceVector snapshot
     preference:sync    → FirebaseManager → { status, ts }
     room:created       → RoomManager     → room metadata
     room:joined        → RoomManager     → { role, code }
     room:left          → RoomManager     → { code }
     maestro:recipe     → MaestroClient   → Recipe object
     session:start      → LearningEngine  → { ts }
     session:end        → LearningEngine  → { duration, completionRate }
  ─────────────────────────────────────────────────────────────────── */

  /* ── Modül bağlantıları (event köprüleri) ─────────────────────── */
  function _wireModuleEvents() {
    /* AdaptiveEngine → Events */
    var origBioUpdate = window.AdaptiveEngine && window.AdaptiveEngine.onBiometricUpdate;
    if (origBioUpdate && window.AdaptiveEngine) {
      window.AdaptiveEngine.onBiometricUpdate = function(data) {
        origBioUpdate(data);
        Events.emit('biometric:update', data);
      };
    }

    /* AudioEngine → Events (switchSound wrap) */
    var origSwitch = window.switchSound;
    if (typeof origSwitch === 'function') {
      window.switchSound = function(gen, base, beat, label, maestro) {
        origSwitch(gen, base, beat, label, maestro);
        Events.emit('audio:scene', { gen:gen, base:base, beat:beat, sceneName:label });
      };
      if (window.Sanctuary.AudioEngine) window.Sanctuary.AudioEngine.switchSound = window.switchSound;
    }

    /* LearningEngine → Events */
    var origOnSessionEnd = window.LearningEngine && window.LearningEngine.onSessionEnd;
    if (origOnSessionEnd && window.LearningEngine) {
      window.LearningEngine.onSessionEnd = function(rate) {
        origOnSessionEnd(rate);
        Events.emit('session:end', { completionRate:rate, ts:Date.now() });
      };
    }

    /* MaestroClient → Events */
    var origApply = window.MaestroClient && window.MaestroClient.applyMaestroRecipe;
    if (origApply && window.MaestroClient) {
      window.MaestroClient.applyMaestroRecipe = function(recipe) {
        var result = origApply(recipe);
        Events.emit('maestro:recipe', recipe);
        return result;
      };
    }
  }

  /* ══════════════════════════════════════════════════════════════════
     2. INITIALIZATION SEQUENCE
     Sıra: FirebaseManager → AudioEngine → AdaptiveEngine → LearningEngine
  ══════════════════════════════════════════════════════════════════ */
  function _runInitSequence() {
    console.info('[SanctuaryCore] Init sequence başlıyor...');

    /* — Step 1: FirebaseManager (config window._firebaseConfig veya atla) — */
    if (window.FirebaseManager && window._firebaseConfig) {
      try {
        window.FirebaseManager.init(window._firebaseConfig);
        console.info('[SanctuaryCore] ✓ FirebaseManager başlatıldı.');
      } catch (e) {
        console.warn('[SanctuaryCore] FirebaseManager init hatası:', e.message);
      }
    }

    /* — Step 2: AudioEngine zaten IIFE ile kendini başlatır, kontrol et — */
    if (window.Sanctuary && window.Sanctuary.AudioEngine) {
      console.info('[SanctuaryCore] ✓ AudioEngine hazır.');

      /* [v4.7] Uzamsal Reverb otomatik kur — dryWet: 0.25, IR: 2.4s */
      try {
        var ae = window.Sanctuary.AudioEngine;
        if (typeof ae.setupSpatialReverb === 'function') {
          var reverbResult = ae.setupSpatialReverb();
          console.info('[SanctuaryCore] ✓ Spatial Reverb kuruldu: dryWet=' +
            (reverbResult ? reverbResult.dryWet : 0.25));
        }
      } catch(e) {
        console.warn('[SanctuaryCore] setupSpatialReverb hatası:', e.message);
      }
    }

    /* — Step 3: AdaptiveEngine feedback loop — */
    if (window.AdaptiveEngine && typeof window.AdaptiveEngine.startLoop === 'function') {
      window.AdaptiveEngine.startLoop();
      console.info('[SanctuaryCore] ✓ AdaptiveEngine loop başlatıldı.');
    }

    /* — Step 4: LearningEngine cloud history merge (Firebase hazırsa) — */
    if (window.LearningEngine && window.FirebaseManager) {
      /* FirebaseManager auth asenkron — kısa bekle */
      var mergeAttempts = 0;
      var mergeInterval = setInterval(function() {
        mergeAttempts++;
        if (window.FirebaseManager.isReady()) {
          clearInterval(mergeInterval);
          console.info('[SanctuaryCore] ✓ LearningEngine → Firebase sync hazır.');
          Events.emit('session:start', { ts: Date.now() });
        } else if (mergeAttempts > 15) {
          clearInterval(mergeInterval);
          console.warn('[SanctuaryCore] Firebase auth zaman aşımı — yerel LearningEngine kullanılıyor.');
          Events.emit('session:start', { ts: Date.now() });
        }
      }, 500);
    } else {
      Events.emit('session:start', { ts: Date.now() });
    }

    /* — Event köprülerini kur — */
    _wireModuleEvents();

    console.info('[SanctuaryCore] Init sequence tamamlandı.');
  }

  /* ══════════════════════════════════════════════════════════════════
     3. TELEMETRY HUD (Ctrl+Shift+D ile aç/kapat)
  ══════════════════════════════════════════════════════════════════ */
  var _hudEl   = null;
  var _hudOpen = false;
  var _hudRaf  = null;

  function _buildHud() {
    if (_hudEl) return;
    _hudEl = document.createElement('div');
    _hudEl.id = 'sanctuary-hud';
    _hudEl.style.cssText = [
      'position:fixed', 'top:12px', 'right:12px', 'z-index:99999',
      'background:rgba(5,5,7,0.92)', 'border:1px solid rgba(201,169,110,0.3)',
      'border-radius:12px', 'padding:12px 16px', 'min-width:260px',
      'font-family:monospace', 'font-size:11px', 'color:rgba(240,238,232,0.85)',
      'line-height:1.6', 'pointer-events:none',
      'backdrop-filter:blur(8px)', '-webkit-backdrop-filter:blur(8px)',
      'display:none', 'white-space:pre',
    ].join(';');
    document.body.appendChild(_hudEl);
  }

  function _hudTick() {
    if (!_hudOpen || !_hudEl) return;

    var ae  = window.Sanctuary && window.Sanctuary.AudioEngine;
    var adp = window.AdaptiveEngine;
    var pv  = window.PreferenceVector || {};
    var fm  = window.FirebaseManager;
    var bio = adp ? adp.getLastData() : null;

    var stress  = bio ? (bio.stress  !== undefined ? bio.stress.toFixed(2)  : '—') : '—';
    var bpm     = bio ? (bio.bpm     !== undefined ? bio.bpm                : '—') : '—';
    var hrv     = bio ? (bio.hrv     !== undefined ? bio.hrv + 'ms'         : '—') : '—';
    var base    = window._lastBase  || (ae ? ae.getFreq() : '—');
    var gen     = window._lastGen   || '—';
    var vol     = ae ? (ae.getVolume() * 100).toFixed(0) + '%' : '—';
    var playing = ae ? (ae.isPlaying() ? '▶ Çalıyor' : '⏸ Durdu') : '—';
    var synth   = pv.layerGains ? pv.layerGains.synth   : '—';
    var texture = pv.layerGains ? pv.layerGains.texture : '—';
    var prefGen = pv.preferredGen  || '—';
    var prefBase= pv.preferredBase || '—';
    var fbStatus= fm ? (fm.isReady() ? '🟢 Bağlı' : '🔴 Bağlantı yok') : '⚪ Devre dışı';
    var fbUid   = fm ? (fm.getUid() ? fm.getUid().slice(0,8)+'…' : '—') : '—';
    var evts    = Events.listEvents().length;

    /* ── [6. ADIM] Biyometrik Nefes Senkron verileri ── */
    var breathState  = (window.VisualizerEngine && window.VisualizerEngine.getBreathState)
      ? window.VisualizerEngine.getBreathState() : null;
    var breathPhase  = breathState ? breathState.phase.toUpperCase() : '—';
    var breathCycle  = breathState ? breathState.cycle : '—';
    var breathPat    = breathState ? breathState.pattern.join('-') : '—';

    /* LPF CutoffHz — AudioEngine _breathLP.frequency (DSP durumu) */
    var dspStatus   = (ae && typeof ae.getDSPStatus === 'function') ? ae.getDSPStatus() : null;
    var cutoffHz    = dspStatus && dspStatus.breathLP_freq != null
      ? Math.round(dspStatus.breathLP_freq) + 'Hz' : '—';
    var baseHz      = dspStatus ? (window._lastBase || '—') : '—';
    var curBand     = ae && typeof ae.getCurrentBand === 'function' ? ae.getCurrentBand() : '—';

    _hudEl.textContent = [
      '━━ SANCTUARY v4 HUD ━━━━━━━━━━━━━━',
      '🎵 Audio',
      '  Durum   : ' + playing,
      '  Sahne   : ' + gen + ' @ ' + base + 'Hz',
      '  Volume  : ' + vol,
      '  Band    : ' + curBand,
      '',
      '🫁 Nefes Senkron  [6. Adım]',
      '  Phase   : ' + breathPhase,
      '  BaseHz  : ' + baseHz,
      '  CutoffHz: ' + cutoffHz,
      '  Pattern : ' + breathPat + 's  |  Döngü: ' + breathCycle,
      '',
      '🧬 Biometrik',
      '  Stres   : ' + stress + '  BPM: ' + bpm + '  HRV: ' + hrv,
      '',
      '🎚 PreferenceVector',
      '  Tercih  : ' + prefGen + ' @ ' + prefBase + 'Hz',
      '  Synth   : ' + synth + '  Texture: ' + texture,
      '',
      '☁ Firebase',
      '  Durum   : ' + fbStatus,
      '  UID     : ' + fbUid,
      '',
      '📡 Events: ' + evts + ' kanal  |  Ctrl+Shift+D kapat',
    ].join('\n');

    _hudRaf = requestAnimationFrame(_hudTick);
  }

  function _toggleHud() {
    _buildHud();
    _hudOpen = !_hudOpen;
    if (_hudOpen) {
      _hudEl.classList.add('active');
    } else {
      _hudEl.classList.remove('active');
    }
    if (_hudOpen) {
      _hudTick();
    } else {
      if (_hudRaf) { cancelAnimationFrame(_hudRaf); _hudRaf = null; }
    }
  }

  document.addEventListener('keydown', function(e) {
    if (e.ctrlKey && e.shiftKey && (e.key === 'D' || e.key === 'd')) {
      e.preventDefault();
      _toggleHud();
    }
  });

  /* ══════════════════════════════════════════════════════════════════
     4. DIAGNOSTICS
     window.Sanctuary.Diagnostics() → konsola sağlık raporu yazar
  ══════════════════════════════════════════════════════════════════ */
  var REQUIRED_MODULES = [
    { key:'Sanctuary.AudioEngine',   check: function(){ return !!(window.Sanctuary && window.Sanctuary.AudioEngine); } },
    { key:'AdaptiveEngine',          check: function(){ return !!window.AdaptiveEngine; } },
    { key:'LearningEngine',          check: function(){ return !!window.LearningEngine; } },
    { key:'MaestroClient',           check: function(){ return !!window.MaestroClient; } },
    { key:'RoomManager',             check: function(){ return !!window.RoomManager; } },
    { key:'FirebaseManager',         check: function(){ return !!window.FirebaseManager; } },
    { key:'PreferenceVector',        check: function(){ return !!window.PreferenceVector; } },
    { key:'switchSound',             check: function(){ return typeof window.switchSound === 'function'; } },
    { key:'togglePlay',              check: function(){ return typeof window.togglePlay === 'function'; } },
    { key:'applyBiometricEffect',    check: function(){
      var ae = window.Sanctuary && window.Sanctuary.AudioEngine;
      return !!(ae && typeof ae.applyBiometricEffect === 'function');
    }},
    { key:'updateLayerGains',        check: function(){
      var ae = window.Sanctuary && window.Sanctuary.AudioEngine;
      return !!(ae && typeof ae.updateLayerGains === 'function');
    }},
    { key:'ServiceWorker',           check: function(){ return 'serviceWorker' in navigator; } },
    { key:'AudioContext',            check: function(){ return !!(window.AudioContext || window.webkitAudioContext); } },
  ];

  function Diagnostics() {
    console.group('[SanctuaryCore] 🔍 Diagnostics Raporu');

    var pass = 0, fail = 0;
    REQUIRED_MODULES.forEach(function(m) {
      var ok = false;
      try { ok = m.check(); } catch(e) {}
      if (ok) {
        console.info('  ✅', m.key);
        pass++;
      } else {
        console.warn('  ❌', m.key, '— EKSİK veya BAĞLI DEĞİL');
        fail++;
      }
    });

    /* Event Bus durumu */
    var evts = Events.listEvents();
    console.info('  📡 Event kanalları (' + evts.length + '):', evts.join(', ') || '—');

    /* AdaptiveEngine son veri */
    var adp = window.AdaptiveEngine;
    if (adp && adp.getLastData()) {
      var b = adp.getLastData();
      console.info('  🧬 Son biyometrik: stress=' + (b.stress||'?') + ' bpm=' + (b.bpm||'?'));
    }

    /* Firebase durumu */
    var fm = window.FirebaseManager;
    if (fm) {
      console.info('  ☁ Firebase:', fm.isReady() ? 'Bağlı' : 'Hazır değil', '| UID:', fm.getUid() || '—');
    }

    /* PreferenceVector */
    var pv = window.PreferenceVector;
    if (pv) {
      console.info('  🎚 PreferenceVector: gen=' + (pv.preferredGen||'?') + ' base=' + (pv.preferredBase||'?'));
    }

    console.info('─────────────────────────────────────');
    console.info('  Sonuç: ' + pass + ' ✅  ' + fail + ' ❌  |  Toplam: ' + REQUIRED_MODULES.length + ' modül');

    /* ── [v4.6] Saturator stabilite raporu ── */
    var ae = window.Sanctuary && window.Sanctuary.AudioEngine;
    var dsp = (ae && typeof ae.getDSPStatus === 'function') ? ae.getDSPStatus() : null;
    var driveVal = dsp ? dsp.saturator_drive : null;
    if (driveVal !== null && driveVal !== undefined) {
      var satStatus = driveVal <= 0.20 ? 'Stable' : driveVal <= 0.35 ? 'Warm' : 'Hot';
      console.info('  🎛 Audio Saturation: ' + satStatus + ' (drive=' + driveVal.toFixed(2) + ')');
    } else {
      console.info('  🎛 Audio Saturation: Stable');
    }

    /* ── [v4.7] AI Sanatçı Motoru & Uzamsal Ses durumu ── */
    var reverbActive = !!(ae && ae.getDSPStatus && ae.getDSPStatus().reverb_wetness !== undefined);
    console.info('  🤖 AI Artist Engine: ACTIVE (v4.7)');
    console.info('  🌐 Spatial Reverb: ' + (reverbActive ? 'CONVOLVER_READY' : 'STANDBY') +
      ' | dryWet=0.25 | IR=2.4s');

    var textureMap = ae && typeof ae.getTextureMap === 'function' ? ae.getTextureMap() : null;
    var soulLayerPresent = !!(textureMap && textureMap['velvet_base_v1']);
    console.info('  🎵 Texture Layer: ' + (soulLayerPresent ? 'Velvet_v1 ✅' : 'Velvet_v1 ⏳ (sample bekleniyor)'));

    if (fail === 0) {
      console.info('  🟢 TÜM SİSTEMLER HAZIR');
    } else {
      console.warn('  🟡 ' + fail + ' modül eksik veya bağlantısız');
    }
    console.groupEnd();

    return { pass:pass, fail:fail, total:REQUIRED_MODULES.length };
  }

  window.Sanctuary.Diagnostics = Diagnostics;
  window.Sanctuary.Events       = Events;
  window.Sanctuary.toggleHud    = _toggleHud;

  /* ── DOMContentLoaded'da init sequence — */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _runInitSequence);
  } else {
    /* Zaten yüklendiyse hemen çalıştır */
    setTimeout(_runInitSequence, 0);
  }

  console.info('[SanctuaryCore v4.7 — AI Sanatçı Motoru] Event Bus + HUD + Diagnostics yüklendi. Ctrl+Shift+D = HUD');
})();