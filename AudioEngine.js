/* ═══════════════════════════════════════════════════════════════════════
   SANCTUARY AudioEngine v4.7 — AI Sanatçı Motoru
   ─────────────────────────────────────────────────────────────────────
   v4.3 değişiklikleri korundu (TEXTURE_MAP, Phi, Tremolo, ResonantPeak)

   5. ADIM: HİBRİT DİNAMİK MODÜLASYON (A + B + C + Yan Çıktı)
   ─────────────────────────────────────────────────────────────────────

   A — ANALOG SICAKLIK (Tape Saturator):
   ├─ WaveShaperNode: soft-clip eğrisi → harmonik bozunma (2. ve 3. harmonik)
   ├─ drive parametresi: 0.0 (kuru) → 1.0 (doygun) — varsayılan 0.35
   ├─ Zincir konumu: synthBus → saturator → (mevcut EQ zinciri devamı)
   └─ Maestro dspProfile.driveAmount ile runtime'da ayarlanabilir

   B — CANLILIK / PITCH DRIFT (Yüzen LFO):
   ├─ startPitchDriftLFO(): tüm aktif osilatörlere 0.03–0.05Hz LFO bağlar
   ├─ drift derinliği: ±0.12 Hz — insan kulağının eşiğinde, makine tınısını kırar
   ├─ LFO tipi: sine — organik, periyodik değil (iki LFO çakışık faz farkı)
   └─ startBinauralLayer() içinden otomatik tetiklenir

   C — DERİNLİK / UZAMSAL REVERB (ConvolverNode):
   ├─ buildImpulseResponse(): sentetik IR buffer — 2.4s oda yankısı (Rapor: "geniş mekân")
   ├─ Wet/Dry karışımı: wet 0.28, dry 1.0 — subtle, ses boğulmaz
   ├─ textureBus çıkışına paralel bağlanır (synthBus bypass — binaural temiz kalır)
   └─ Maestro dspProfile.reverbWetness ile runtime'da ayarlanabilir

   YAN ÇIKTI — generateAIPrompt():
   ├─ Maestro JSON → Stable Audio / Suno / Udio için metin komutu
   ├─ Master Prompt yapısı: SceneName + BaseHz + textures + beatHz + EEG band
   ├─ window.Sanctuary.generateAIPrompt(maestro) ile erişilir
   └─ applyMSD() başarısında otomatik olarak konsola loglanır

   v4.4 DSP Zinciri (tam):
     synthBus → saturator(WaveShaper) → master → breathGain
                                                → eqLow → eqMid → eqHigh
                                                → velvetHS → resonantPeak
                                                → breathLP → comp → limiter
     textureBus → master (+ reverbBus paralel)
   ═══════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  /* ── Dahili durum ──────────────────────────────────────────────────── */
  var _ctx        = null;
  var _master     = null;
  var _synthBus   = null;   /* Sentezleyici alt karışım — gain kontrol */
  var _textureBus = null;   /* Texture alt karışım */

  /* Velvet Bus DSP zinciri node'ları */
  var _eqLow      = null;   /* Low-Shelf: 250Hz +2dB — sıcaklık */
  var _eqMid      = null;   /* Peaking: 1000Hz -1.5dB — honk bastırma */
  var _eqHigh     = null;   /* High-Shelf: 8000Hz -3dB — temel treble control */
  var _velvetHS   = null;   /* [YENİ] High-Shelf: 1900Hz sönümleme — ipeksi kıs */
  var _breathLP   = null;   /* Nefes Low-Pass — Q dalgalı */
  var _comp       = null;   /* Compressor — dinamik kontrol */
  var _limiter    = null;   /* [REVİZE] Velvet Limiter — -3dB brick wall */
  var _breathGain = null;   /* Nefes gain puls */

  var _oscs         = [];
  var _sampleNodes  = [];
  var _lfoNodes     = [];
  var _synthNodes   = [];
  var _clickTimers  = [];   /* Rain click zamanlayıcıları */

  /* [YENİ v4.2] Prosedürel node yönetimi */
  var _proceduralFM    = {};  /* { textureName: FMSynthesizer } — aktif FM örnekleri */
  var _proceduralGrain = {};  /* { textureName: GranularEngine } — aktif granular örnekleri */

  var _playing      = false;
  var _startTime    = 0;
  var _pauseOffset  = 0;
  var _loopDur      = 8;
  var _curGen       = null;
  var _curBase      = 0;
  var _curBeat      = 0;
  var _curBand      = 'theta'; /* [YENİ] Aktif EEG bandı */

  var _breathTimer   = null;
  var _currentBreath = [4, 2, 6];
  var _bufferCache   = {};

  /* ── [6. ADIM] Biyometrik LPF hedef frekansları ──────────────────────
     Maestro'dan gelen 4-2-7 pattern'ine göre güncellenir.
     Varsayılan: 3000Hz (inhale) / 600Hz (exhale)                       */
  var _breathLPF_inhale = 3000;   /* Nefes alırken LPF açılır → ses parlar  */
  var _breathLPF_exhale = 600;    /* Nefes verirken LPF kapanır → ses derinleşir */

  /* ── PreferenceVector katman kazançları ────────────────────────────── */
  var _layerGains = (window.PreferenceVector && window.PreferenceVector.layerGains)
    ? window.PreferenceVector.layerGains
    : { synth: 0.30, texture: 0.70 };

  /* ══════════════════════════════════════════════════════════════════════
     TEXTURE_MAP v4.3 — Maestro texture adı → { file, gen, fallbackGen }
     ─────────────────────────────────────────────────────────────────────
     'file'        : /samples/ klasöründeki gerçek OGG dosyası adı.
                     null → dosya yok, doğrudan prosedürel senteze git.
     'gen'         : Prosedürel fallback algoritması.
     'resonantFreq': Resonant Peak filtresi için merkez frekansı (Hz).
                     Bu frekanstaki harmonikler canlandırılır (Görev 4).
     'phiBase'     : Phi harmonik serisi için temel frekans (Hz).
                     null → runtime'da Maestro'dan gelen baseHz kullanılır.

     Maestro'nun üretebileceği tüm texture isimleri kapsanmıştır:
     Doğa sesleri, ambiyans, meditasyon, uyku, zen kategorileri.
  ══════════════════════════════════════════════════════════════════════ */
  var TEXTURE_MAP = {
    /* ── Su / Okyanus ── */
    'ocean'        : { file: 'ocean.ogg',      gen: 'waves',   resonantFreq: 180,  phiBase: null },
    'river'        : { file: 'ocean.ogg',      gen: 'waves',   resonantFreq: 220,  phiBase: null },
    'stream'       : { file: 'ocean.ogg',      gen: 'waves',   resonantFreq: 260,  phiBase: null },
    'waves'        : { file: 'ocean.ogg',      gen: 'waves',   resonantFreq: 160,  phiBase: null },
    'underwater'   : { file: 'ocean.ogg',      gen: 'waves',   resonantFreq: 120,  phiBase: null },

    /* ── Yağmur ── */
    'rain'         : { file: 'rain.ogg',       gen: 'rain',    resonantFreq: 3200, phiBase: null },
    'drizzle'      : { file: 'rain.ogg',       gen: 'rain',    resonantFreq: 4000, phiBase: null },
    'storm'        : { file: 'rain.ogg',       gen: 'rain',    resonantFreq: 2800, phiBase: null },
    'white-noise'  : { file: 'rain.ogg',       gen: 'rain',    resonantFreq: 2000, phiBase: null },
    'pink-noise'   : { file: 'rain.ogg',       gen: 'rain',    resonantFreq: 1500, phiBase: null },

    /* ── Orman / Doğa ── */
    'forest'       : { file: 'forest.ogg',     gen: 'wind',    resonantFreq: 600,  phiBase: null },
    'wind'         : { file: 'forest.ogg',     gen: 'wind',    resonantFreq: 500,  phiBase: null },
    'night'        : { file: 'forest.ogg',     gen: 'wind',    resonantFreq: 800,  phiBase: null },
    'crickets'     : { file: 'forest.ogg',     gen: 'wind',    resonantFreq: 4500, phiBase: null },
    'birds'        : { file: 'forest.ogg',     gen: 'wind',    resonantFreq: 2200, phiBase: null },
    'meadow'       : { file: 'forest.ogg',     gen: 'wind',    resonantFreq: 900,  phiBase: null },
    'leaves'       : { file: 'forest.ogg',     gen: 'wind',    resonantFreq: 1200, phiBase: null },

    /* ── Ateş ── */
    'fire'         : { file: 'fire.ogg',       gen: 'fire',    resonantFreq: 800,  phiBase: 150  },
    'fireplace'    : { file: 'fire.ogg',       gen: 'fire',    resonantFreq: 700,  phiBase: 150  },
    'campfire'     : { file: 'fire.ogg',       gen: 'fire',    resonantFreq: 850,  phiBase: 150  },
    'embers'       : { file: 'fire.ogg',       gen: 'fire',    resonantFreq: 650,  phiBase: 150  },
    'calm embers'  : { file: 'fire.ogg',       gen: 'fire',    resonantFreq: 600,  phiBase: 150  },

    /* ── Zen / Meditasyon ── */
    'zen'          : { file: 'zen-bowl.ogg',   gen: 'binaural',resonantFreq: 432,  phiBase: 432  },
    'bowl'         : { file: 'zen-bowl.ogg',   gen: 'binaural',resonantFreq: 432,  phiBase: 432  },
    'singing-bowl' : { file: 'zen-bowl.ogg',   gen: 'binaural',resonantFreq: 528,  phiBase: 528  },
    'tibetan'      : { file: 'zen-bowl.ogg',   gen: 'binaural',resonantFreq: 396,  phiBase: 396  },
    'temple'       : { file: 'zen-bowl.ogg',   gen: 'binaural',resonantFreq: 417,  phiBase: 417  },

    /* ── Fısıltı / Nefes ── */
    'whisper'      : { file: null,             gen: 'wind',    resonantFreq: 2500, phiBase: null },
    'breath'       : { file: null,             gen: 'wind',    resonantFreq: 1800, phiBase: null },
    'asmr'         : { file: null,             gen: 'wind',    resonantFreq: 3000, phiBase: null },

    /* ── Uzay / Ambiyans ── */
    'space'        : { file: null,             gen: 'waves',   resonantFreq: 80,   phiBase: 174  },
    'cosmos'       : { file: null,             gen: 'waves',   resonantFreq: 60,   phiBase: 174  },
    'void'         : { file: null,             gen: 'waves',   resonantFreq: 40,   phiBase: 174  },
    'drone'        : { file: null,             gen: 'binaural',resonantFreq: 100,  phiBase: 285  },
    'ambient'      : { file: null,             gen: 'waves',   resonantFreq: 300,  phiBase: null },

    /* ── [v4.7] AI Sanatçı Motoru — Velvet Soul Katmanı — Master Atmosphere
       velvet_base_v1 : Sistemin kalıcı "Ruh" katmanı.
       Tüm diğer texture'ların (wind, zen, ocean vb.) ALTINDA sürekli çalar;
       diğer katmanlar bu Master Atmosphere'in üstüne biner.
       Dosya: /samples/velvet_base_v1.mp3 — AI üretimi, 396Hz solfeggio,
              celestial velvet, infinite loopable, 432Hz tuning.
       Fallback: dosya yoksa 'binaural' prosedürel sentez devreye girer.
       resonantFreq: 396Hz — solfeggio root, Maestro ResonantPeak ile uyumlu.
       phiBase: 396 — Phi harmonik serisi bu frekanstan üretilir.
       isSoulLayer: true — bu flag ile loadSoulLayer() tanır ve loop'lar.
       role: 'master_atmosphere' — tüm katman hiyerarşisinin tabanı.        */
    'velvet_base_v1': { file: 'velvet_base_v1.mp3', gen: 'binaural', resonantFreq: 396, phiBase: 396, isSoulLayer: true, role: 'master_atmosphere' },
  };

  /* Geriye dönük uyumluluk: eski TEXTURE_TO_FILE ve TEXTURE_TO_GEN API'leri */
  var TEXTURE_TO_FILE = (function() {
    var m = {};
    Object.keys(TEXTURE_MAP).forEach(function(k) { m[k] = TEXTURE_MAP[k].file; });
    return m;
  })();
  var TEXTURE_TO_GEN = (function() {
    var m = {};
    Object.keys(TEXTURE_MAP).forEach(function(k) { m[k] = TEXTURE_MAP[k].gen; });
    return m;
  })();

  /** Texture adını normalize et: küçük harf + trim (Maestro bazen büyük harf gönderir) */
  function _resolveTexture(name) {
    if (!name) return TEXTURE_MAP['ambient'];
    var key = String(name).toLowerCase().trim();
    return TEXTURE_MAP[key] || TEXTURE_MAP['ambient'];
  }

  var MOOD_MAP = {
    'Huzursuz' : { base:396, beat:6.3,  gen:'waves' },
    'Yorgun'   : { base:528, beat:4.8,  gen:'wind'  },
    'Kaygılı'  : { base:396, beat:7.2,  gen:'wind'  },
    'Mutsuz'   : { base:417, beat:5.5,  gen:'waves' },
    'Sakin'    : { base:432, beat:10.5, gen:'waves' },
    'Minnettar': { base:528, beat:10.0, gen:'rain'  },
  };

  /* ══════════════════════════════════════════════════════════════════════
     AUDIO CONTEXT
  ══════════════════════════════════════════════════════════════════════ */
  function getCtx() {
    if (!_ctx) {
      var C = window.AudioContext || window.webkitAudioContext;
      _ctx = new C();
    }
    return _ctx;
  }

  /* ══════════════════════════════════════════════════════════════════════
     VELVET BUS v4.1 — Master sinyal zinciri + alt karışım bus'ları
     ─────────────────────────────────────────────────────────────────────
     Zincir sırası (Rapor Bölüm 5.2):
       synthBus ─┐
       textureBus ─┤→ master → breathGain
                               → eqLow(250Hz +2dB)
                               → eqMid(1kHz -1.5dB)
                               → eqHigh(8kHz -3dB)
                               → velvetHS(1900Hz HighShelf -6dB) ← YENİ
                               → breathLP(cutoff 1600-2100Hz, Q dalgalı)
                               → comp(threshold -6dB, ratio 4:1)
                               → limiter(threshold -3dB, ratio 20:1) ← REVİZE
                               → destination
  ══════════════════════════════════════════════════════════════════════ */
  function ensureMaster(ctx) {
    if (_master) return;

    /* ── Alt karışım bus'ları ── */
    _synthBus = ctx.createGain();
    _synthBus.gain.value = _layerGains.synth;

    _textureBus = ctx.createGain();
    _textureBus.gain.value = _layerGains.texture;

    /* ── 3-band EQ ─────────────────────────────────────────────
       Low  : 250Hz  +2.0dB  → sıcaklık, dolgunluk
       Mid  : 1000Hz -1.5dB  → dijital 'honk' bastırma
       High : 8000Hz -3.0dB  → genel treble kontrolü              */
    _eqLow = ctx.createBiquadFilter();
    _eqLow.type = 'lowshelf';
    _eqLow.frequency.value = 250;
    _eqLow.gain.value = 2.0;

    _eqMid = ctx.createBiquadFilter();
    _eqMid.type = 'peaking';
    _eqMid.frequency.value = 1000;
    _eqMid.Q.value = 0.8;
    _eqMid.gain.value = -1.5;

    _eqHigh = ctx.createBiquadFilter();
    _eqHigh.type = 'highshelf';
    _eqHigh.frequency.value = 8000;
    _eqHigh.gain.value = -3.0;

    /* ── [YENİ] Velvet High-Shelf Filter — 1900Hz ipeksi sönümleme ──
       Rapor: "1900Hz üzerindeki frekansları ipeksi bir şekilde sönümleyen
              High-Shelf Filter yapısını ana sinyal yoluna ekle"
       Parametreler:
         type      : 'highshelf'  — 1900Hz üzerini etkiler
         frequency : 1900 Hz      — kesim noktası (rapor değeri)
         gain      : -6 dB        — nazik, tiz frekanslarda kısmak için
         Q         : 0.7          — Butterworth benzeri yumuşak dönüş          */
    _velvetHS = ctx.createBiquadFilter();
    _velvetHS.type = 'highshelf';
    _velvetHS.frequency.value = 1900;
    _velvetHS.gain.value = -6.0;
    /* Not: BiquadFilter highshelf için Q parametresi standart API'de
       desteklenmez — gain ve frequency yeterli. Daha hassas eğim için
       iki ardışık highshelf eklenebilir (bkz. applyDSPProfile).     */

    /* ── Nefes Low-Pass (Q dalgalanır, sinyal zincirinde breathLP'den önce) ── */
    _breathLP = ctx.createBiquadFilter();
    _breathLP.type = 'lowpass';
    _breathLP.frequency.value = 1800;
    _breathLP.Q.value = 0.5;

    /* ── Compressor (Rapor Bölüm 5.2 — "Dinamik kontrol") ──
       threshold : -6 dBFS  — orta dinamik müdahale
       ratio     : 4:1      — müzikal, doğal sıkıştırma (Velvet Limiter'dan ayrı)
       knee      : 8 dB     — yumuşak diz geçişi
       attack    : 3ms      — transient koruması
       release   : 250ms    — doğal bırakma                               */
    _comp = ctx.createDynamicsCompressor();
    _comp.threshold.value = -6;
    _comp.ratio.value     = 4;
    _comp.knee.value      = 8;
    _comp.attack.value    = 0.003;
    _comp.release.value   = 0.25;

    /* ── [REVİZE] Velvet Limiter — -3dB brick-wall ──────────────────────
       Rapor: "-3dB eşikli Velvet Limiter (DynamicsCompressorNode) zorunlu"
       threshold : -3 dBFS  — rapor kesin değeri
       ratio     : 20:1     — brick-wall (pratik olarak sınırsız)
       knee      : 0 dB     — sert sınır, klipleme önleme
       attack    : 1ms      — anlık tepki
       release   : 100ms    — hızlı serbest bırakma, pompajı önler          */
    _limiter = ctx.createDynamicsCompressor();
    _limiter.threshold.value = -3;
    _limiter.ratio.value     = 20;
    _limiter.knee.value      = 0;
    _limiter.attack.value    = 0.001;
    _limiter.release.value   = 0.1;

    /* ── Nefes Gain ── */
    _breathGain = ctx.createGain();
    _breathGain.gain.value = 1.0;

    /* ── [YENİ v4.4 — A] Tape Saturator (WaveShaperNode) ──────────────────
       synthBus çıkışını yumuşakça kırpar → 2. ve 3. harmonikler oluşur.
       Bu, "saf sinus" sesinin dijital soğukluğunu kıran ana mekanizma.

       Soft-clip eğrisi: f(x) = x / (1 + |x| × drive)
       drive = 0.35 varsayılan → çok hafif, fark edilir ama agresif değil.
       Tam devre dışı için drive=0 (WaveShaper identity curve).

       Zincir konumu: synthBus → saturator → master (texture bypass — reverb ile koheransı bozma)
       textureBus direkt master'a bağlı kalır (texture sesi zaten organik).    */
    _saturator = ctx.createWaveShaper();
    _saturator.curve    = _buildSatCurve(_satDrive, 256);
    _saturator.oversample = '2x';  /* 2x oversampling: aliasing baskıla */

    /* ── [YENİ v4.4 — C] Uzamsal Reverb (ConvolverNode) ──────────────────
       textureBus → reverbWetGain → convolver → master (paralel yol)
       synthBus binaural frekanslarını temiz tutar — reverb sadece texture'a.

       IR (Impulse Response): 2.4s sentetik oda yankısı.
       buildImpulseResponse() ile AudioContext içinde üretilir — dosya gerektirmez.

       Wet/Dry dengesi: wet=0.28, dry=1.0
       Düşük wet değeri: reverb mevcudiyeti hissedilir ama ses bulanıklaşmaz.    */
    _reverbNode    = ctx.createConvolver();
    _reverbNode.buffer = _buildImpulseResponse(ctx, 2.4, 2.2);  /* 2.4s, decay 2.2 */
    _reverbWetGain = ctx.createGain();
    _reverbWetGain.gain.value = _reverbWetness;
    _reverbDryGain = ctx.createGain();
    _reverbDryGain.gain.value = 1.0;

    /* ── Master ── */
    _master = ctx.createGain();
    /* [v4.7] Master gain -6dB (0.5) — Soul katmanı + osilatör çakışmasını önler.
       PreferenceVector varsa onun değeri kullanılır, yoksa 0.5 sabit.         */
    _master.gain.value = (window._prefVector ? Math.min(window._prefVector.masterVolume, 0.5) : 0.5);

    /* ── Velvet Sinyal Zinciri v4.4 ─────────────────────────────────────
       synthBus  → saturator ─────────────────────────────────────────────┐
       textureBus → reverbDryGain ─────────────────────────────────────────┤→ master
                 → reverbWetGain → convolver(IR) ──────────────────────────┘
                                                  → breathGain
                                                  → eqLow(250Hz +2dB)
                                                  → eqMid(1kHz -1.5dB)
                                                  → eqHigh(8kHz -3dB)
                                                  → velvetHS(1900Hz -6dB)
                                                  → [resonantPeak — per-sound]
                                                  → breathLP(1600-2100Hz)
                                                  → comp(-6dB / 4:1)
                                                  → limiter(-3dB / 20:1)
                                                  → destination               */
    _synthBus.connect(_saturator);
    _saturator.connect(_master);

    _textureBus.connect(_reverbDryGain);
    _reverbDryGain.connect(_master);
    _textureBus.connect(_reverbWetGain);
    _reverbWetGain.connect(_reverbNode);
    _reverbNode.connect(_master);

    _master.connect(_breathGain);
    _breathGain.connect(_eqLow);
    _eqLow.connect(_eqMid);
    _eqMid.connect(_eqHigh);
    _eqHigh.connect(_velvetHS);
    _velvetHS.connect(_breathLP);
    _breathLP.connect(_comp);
    _comp.connect(_limiter);
    _limiter.connect(ctx.destination);

    console.info('[AudioEngine v4.4] Velvet Bus v4.4 kuruldu.',
      '\n  Saturator  : WaveShaper drive=' + _satDrive + ' | oversample=2x',
      '\n  Reverb     : ConvolverNode 2.4s IR | wet=' + _reverbWetness,
      '\n  HighShelf  : 1900Hz -6dB',
      '\n  Limiter    : -3dB / 20:1',
      '\n  Comp       : -6dB / 4:1'
    );
  }

  /* ══════════════════════════════════════════════════════════════════════
     [YENİ] applyDSPProfile() — Maestro v2 dspProfile uygulayıcı
     Rapor Bölüm 4.2 — Maestro v2 şemasının dspProfile alanı:
       { lowBoostDb, midCutDb, reverbWetness, stereoWidth }
  ══════════════════════════════════════════════════════════════════════ */
  function applyDSPProfile(profile) {
    if (!profile || !_ctx) return;
    var now = _ctx.currentTime;
    var ramp = 0.5; /* 500ms — ani geçiş önleme */

    /* Low boost (0–4dB) — Maestro'dan gelen sıcaklık artışı */
    if (_eqLow && typeof profile.lowBoostDb === 'number') {
      var lb = Math.max(-3, Math.min(6, 2.0 + profile.lowBoostDb));
      _eqLow.gain.setValueAtTime(_eqLow.gain.value, now);
      _eqLow.gain.linearRampToValueAtTime(lb, now + ramp);
    }

    /* Mid cut (0–5dB) — stres frekansı azaltma */
    if (_eqMid && typeof profile.midCutDb === 'number') {
      var mc = Math.max(-8, Math.min(0, -profile.midCutDb));
      _eqMid.gain.setValueAtTime(_eqMid.gain.value, now);
      _eqMid.gain.linearRampToValueAtTime(mc, now + ramp);
    }

    /* reverbWetness (0.2–0.5) → Velvet HighShelf + Reverb wet gain güncelle */
    if (typeof profile.reverbWetness === 'number') {
      var wet = Math.max(0.0, Math.min(0.8, profile.reverbWetness));

      /* [YENİ v4.4] Gerçek ConvolverNode wet gain'ini güncelle */
      if (_reverbWetGain && _ctx) {
        _reverbWetGain.gain.setValueAtTime(_reverbWetGain.gain.value, _ctx.currentTime);
        _reverbWetGain.gain.linearRampToValueAtTime(wet, _ctx.currentTime + ramp);
        _reverbWetness = wet;
      }

      /* velvetHS: yüksek wetness → tiz biraz daha açık (reverb hava katmanı) */
      if (_velvetHS) {
        var hsGain = -6 + (wet - 0.2) * 10;
        hsGain = Math.max(-10, Math.min(-3, hsGain));
        _velvetHS.gain.setValueAtTime(_velvetHS.gain.value, now);
        _velvetHS.gain.linearRampToValueAtTime(hsGain, now + ramp);
      }
    }

    /* [YENİ v4.4 — A] driveAmount → Saturator eğrisini runtime'da güncelle */
    if (_saturator && typeof profile.driveAmount === 'number') {
      _satDrive = Math.max(0, Math.min(1, profile.driveAmount));
      _saturator.curve = _buildSatCurve(_satDrive, 256);
      console.info('[AudioEngine v4.4] Saturator drive güncellendi →', _satDrive);
    }

    console.info('[AudioEngine v4.4] DSP profili uygulandı:', JSON.stringify(profile));
  }

  /* ══════════════════════════════════════════════════════════════════════
     [YENİ] validateBinauralHz() — EEG bölge doğrulaması
     Rapor Bölüm 5.4 Tablo + Bölüm 4.1 KISITLAR:
       "binauralHz asla 2Hz altına düşürme (epilepsi riski)"
       Delta: 2-4Hz | Theta: 4-8Hz | Alpha: 8-14Hz | Low Beta: 14-20Hz
  ══════════════════════════════════════════════════════════════════════ */
  function validateBinauralHz(hz) {
    var BINAURAL_HARD_MIN = 2;  /* Epilepsi güvenlik sınırı — rapor zorunluluğu */
    var BINAURAL_HARD_MAX = 20;

    if (!isFinite(hz) || hz <= 0) {
      console.warn('[AudioEngine v4.1] Geçersiz binauralHz:', hz, '→ 6Hz (Theta) kullanılıyor');
      return 6;
    }

    var safe = Math.max(BINAURAL_HARD_MIN, Math.min(BINAURAL_HARD_MAX, hz));

    if (safe !== hz) {
      console.warn('[AudioEngine v4.1] binauralHz sınıra getirildi:', hz, '→', safe, 'Hz');
    }

    /* EEG band logu */
    var band = safe < 4  ? 'Delta (2-4Hz)' :
               safe < 8  ? 'Theta (4-8Hz)' :
               safe < 14 ? 'Alpha (8-14Hz)' : 'Low Beta (14-20Hz)';
    _curBand = band;
    console.info('[AudioEngine v4.1] Binaural EEG bandı:', band, '| Beat:', safe, 'Hz');

    return safe;
  }

  /* ══════════════════════════════════════════════════════════════════════
     KATMAN 5 — NEFES SENKRONu
     Gain puls + filtre cutoff (1600→2100Hz) + Q rezonans (0.5→1.2)
  ══════════════════════════════════════════════════════════════════════ */
  function startBreathCycle(breath) {
    if (_breathTimer) clearTimeout(_breathTimer);
    if (!_breathGain || !_breathLP || !_ctx) return;

    var b      = (Array.isArray(breath) && breath.length >= 3) ? breath : [4, 2, 6];
    var inhale = Math.max(1, b[0]);
    var hold   = Math.max(0, b[1]);
    var exhale = Math.max(1, b[2]);
    var total  = inhale + hold + exhale;

    function cycle() {
      if (!_playing || !_breathGain) return;
      var now = _ctx.currentTime;

      /* Gain puls */
      _breathGain.gain.cancelScheduledValues(now);
      _breathGain.gain.setValueAtTime(1.0, now);
      _breathGain.gain.linearRampToValueAtTime(1.06, now + inhale);
      _breathGain.gain.setValueAtTime(1.06, now + inhale + hold);
      _breathGain.gain.linearRampToValueAtTime(0.97, now + inhale + hold + exhale * 0.7);
      _breathGain.gain.linearRampToValueAtTime(1.0,  now + total);

      /* Filtre frekansı — Maestro 4-2-7 biyometrik senkron
         Nefes alırken: LPF cutoff → 3000Hz (ses parlar, tizler açılır)
         Nefes verirken: LPF cutoff → 600Hz  (ses derinleşir, kadifemsi)  */
      var lpfInhale = _breathLPF_inhale || 3000;
      var lpfExhale = _breathLPF_exhale || 600;

      _breathLP.frequency.cancelScheduledValues(now);
      _breathLP.frequency.setValueAtTime(_breathLP.frequency.value, now);
      _breathLP.frequency.linearRampToValueAtTime(lpfInhale, now + inhale);
      _breathLP.frequency.setValueAtTime(lpfInhale, now + inhale + hold);
      _breathLP.frequency.linearRampToValueAtTime(lpfExhale, now + total);

      /* Q rezonans: inhale → 1.2, exhale → 0.5 */
      _breathLP.Q.cancelScheduledValues(now);
      _breathLP.Q.setValueAtTime(0.5, now);
      _breathLP.Q.linearRampToValueAtTime(1.2, now + inhale);
      _breathLP.Q.setValueAtTime(1.2, now + inhale + hold);
      _breathLP.Q.linearRampToValueAtTime(0.5, now + total);

      _breathTimer = setTimeout(cycle, total * 1000);
    }
    cycle();
  }

  function stopBreathCycle() {
    if (_breathTimer) { clearTimeout(_breathTimer); _breathTimer = null; }
    if (_breathGain && _ctx) {
      var now = _ctx.currentTime;
      _breathGain.gain.cancelScheduledValues(now);
      _breathGain.gain.setValueAtTime(1.0, now);
    }
    if (_breathLP && _ctx) {
      var now2 = _ctx.currentTime;
      _breathLP.frequency.cancelScheduledValues(now2);
      _breathLP.frequency.setValueAtTime(1800, now2);
      _breathLP.Q.cancelScheduledValues(now2);
      _breathLP.Q.setValueAtTime(0.5, now2);
    }
  }

  /* ══════════════════════════════════════════════════════════════════════
     [6. ADIM] updateFiltersByBreath(pattern)
     ─────────────────────────────────────────────────────────────────────
     Maestro'dan gelen nefes pattern'ini (_breathLP / LPF) ile senkronize
     eder. Her nefes döngüsü AudioContext zamanlayıcısıyla hassas biçimde
     zamanlanır — setTimeout drift'inden bağımsız.

     Parametreler:
       pattern : [inhale, hold, exhale]  → örnek: [4, 2, 7]
       inhale  : LPF cutoff → 3000Hz  (ses parlar, tizler açılır)
       exhale  : LPF cutoff →  600Hz  (ses derinleşir, kadifemsi)

     DSP Zincir konumu:
       velvetHS → [breathLP ← burası] → comp → limiter

     Çağrı örneği:
       window.Sanctuary.AudioEngine.updateFiltersByBreath([4, 2, 7]);
  ══════════════════════════════════════════════════════════════════════ */
  function updateFiltersByBreath(pattern) {
    if (!_breathLP || !_ctx) {
      console.warn('[AudioEngine v4.4] updateFiltersByBreath: breathLP veya ctx hazır değil.');
      return;
    }

    /* Pattern doğrulama — eksik değerler için güvenli varsayılan */
    var b      = (Array.isArray(pattern) && pattern.length >= 3) ? pattern : [4, 2, 7];
    var inhale = Math.max(1, Number(b[0]) || 4);
    var hold   = Math.max(0, Number(b[1]) || 2);
    var exhale = Math.max(1, Number(b[2]) || 7);

    /* LPF hedef frekanslarını güncelle — bir sonraki cycle'dan itibaren geçerli */
    _breathLPF_inhale = 3000;  /* Nefes alırken: ses parlar */
    _breathLPF_exhale = 600;   /* Nefes verirken: ses derinleşir */

    /* Dahili pattern kaydını güncelle */
    _currentBreath = [inhale, hold, exhale];

    /* Mevcut cycle'ı durdur ve yeni pattern'le yeniden başlat */
    if (_breathTimer) {
      clearTimeout(_breathTimer);
      _breathTimer = null;
    }

    /* Anlık LPF geçişi — setTargetAtTime (τ=0.15) ile yumuşak, click-free geçiş
       v4.6: linearRamp → setTargetAtTime. Tıklama sesi riski ortadan kalkar.   */
    var now   = _ctx.currentTime;
    var total = inhale + hold + exhale;
    var TAU   = 0.15; /* zaman sabiti — küçük değer = hızlı ama click-free */

    _breathLP.frequency.cancelScheduledValues(now);
    _breathLP.frequency.setValueAtTime(_breathLP.frequency.value, now);
    _breathLP.frequency.setTargetAtTime(_breathLPF_inhale, now,          TAU);
    _breathLP.frequency.setTargetAtTime(_breathLPF_inhale, now + inhale, TAU * 0.5);
    _breathLP.frequency.setTargetAtTime(_breathLPF_exhale, now + inhale + hold, TAU);

    /* Q rezonans: inhale → 1.4 (parlak), exhale → 0.4 (yumuşak) */
    _breathLP.Q.cancelScheduledValues(now);
    _breathLP.Q.setValueAtTime(_breathLP.Q.value, now);
    _breathLP.Q.setTargetAtTime(1.4, now,                       TAU);
    _breathLP.Q.setTargetAtTime(1.4, now + inhale,              TAU * 0.5);
    _breathLP.Q.setTargetAtTime(0.4, now + inhale + hold,       TAU);

    /* Gain puls: inhale → +6% parlaklık, exhale → -3% derinlik */
    if (_breathGain) {
      _breathGain.gain.cancelScheduledValues(now);
      _breathGain.gain.setValueAtTime(_breathGain.gain.value, now);
      _breathGain.gain.setTargetAtTime(1.06, now,                                   TAU);
      _breathGain.gain.setTargetAtTime(1.06, now + inhale,                          TAU * 0.5);
      _breathGain.gain.setTargetAtTime(0.97, now + inhale + hold + exhale * 0.7,   TAU);
      _breathGain.gain.setTargetAtTime(1.0,  now + total,                           TAU);
    }

    /* Döngüyü sürdür — AudioContext tabanlı özyinelemeli zamanlama */
    if (_playing) {
      _breathTimer = setTimeout(function() {
        updateFiltersByBreath(_currentBreath);
      }, total * 1000);
    }

    console.info(
      '[AudioEngine v4.4 — 6. ADIM] Biyometrik LPF senkronize edildi.',
      '\n  Pattern  : inhale=' + inhale + 's | hold=' + hold + 's | exhale=' + exhale + 's',
      '\n  LPF      : ' + _breathLP.frequency.value.toFixed(0) + 'Hz →',
      _breathLPF_inhale + 'Hz (inhale) → ' + _breathLPF_exhale + 'Hz (exhale)',
      '\n  Toplam döngü: ' + total + 's'
    );
  }

  /* ══════════════════════════════════════════════════════════════════════
     TEMİZLEYİCİLER
  ══════════════════════════════════════════════════════════════════════ */
  function stopAll() {
    _clickTimers.forEach(function(t){ clearInterval(t); }); _clickTimers = [];
    _oscs.forEach(function(o){ try{o.stop();o.disconnect();}catch(e){} }); _oscs=[];
    _sampleNodes.forEach(function(n){ try{n.stop();n.disconnect();}catch(e){} }); _sampleNodes=[];
    _lfoNodes.forEach(function(n){ try{n.stop();n.disconnect();}catch(e){} }); _lfoNodes=[];
    _synthNodes.forEach(function(n){ try{n.stop();n.disconnect();}catch(e){} }); _synthNodes=[];
    /* [YENİ v4.4] Pitch Drift LFO'larını temizle */
    _driftLFOs.forEach(function(n){ try{n.stop();n.disconnect();}catch(e){} }); _driftLFOs=[];
    stopProceduralNodes();
  }

  /* ══════════════════════════════════════════════════════════════════════
     KATMAN 1 — BİNAURAL + PHI HARMONİK KATMANLAMA v4.3
     ─────────────────────────────────────────────────────────────────────
     Eski yaklaşım: sadece baseHz + (baseHz × 1.5) + (baseHz × 2.0) sabit çarpanlar.
     Yeni yaklaşım: FrequencyManager.getSolfeggioPhiHarmonics() ile Altın Oran serisi.

     3 Bağımsız Harmonik Katman (farklı gain + pan + synthBus routing):
       Katman A — Temel binaural çift (sol/sağ): gain 0.10, stereo merger
       Katman B — Phi^1 ve Phi^2 harmonikler:   gain 0.035, hafif pan spread
       Katman C — Phi^3 ve Phi^4 harmonikler:   gain 0.015, geniş pan spread

     Gain hiyerarşisi: A > B > C → piramit yapısı, texture'ı boğmaz.
     Toplam synthBus gain: ≤ 0.18 (Rapor: "sentezleyici < texture her zaman")
  ══════════════════════════════════════════════════════════════════════ */
  function startBinauralLayer(ctx, base, beat) {
    if (!beat || beat <= 0) return;

    var safeBeat = validateBinauralHz(beat);

    /* FrequencyManager'dan binaural çifti + Phi harmonik serisi al */
    var leftFreq, rightFreq, phiSeries;
    if (window.getFrequencyManager) {
      var fm   = window.getFrequencyManager(base);
      var pair = fm.getBinauralPair(safeBeat, base);
      leftFreq  = pair.left;
      rightFreq = pair.right;
      /* Phi harmonik serisi: baseHz × φ^0..4 (ilk 5 harmonik) */
      phiSeries = fm.getSolfeggioPhiHarmonics(base, 5);
    } else {
      leftFreq  = isFinite(base) ? base : 432;
      rightFreq = leftFreq + safeBeat;
      /* Fallback: manuel Phi serisi */
      var PHI = 1.618033988749895;
      phiSeries = [leftFreq, leftFreq*PHI, leftFreq*PHI*PHI, leftFreq*Math.pow(PHI,3), leftFreq*Math.pow(PHI,4)];
    }

    /* ── KATMAN A: Temel Binaural Çift ─────────────────────────────────
       Sol kulak: leftFreq | Sağ kulak: rightFreq
       ChannelMerger → tam stereo ayrım → synthBus                       */
    var mg = ctx.createChannelMerger(2);
    mg.connect(_synthBus);

    [[leftFreq, 0], [rightFreq, 1]].forEach(function(p) {
      var o = ctx.createOscillator();
      var g = ctx.createGain();
      o.type = 'sine'; o.frequency.value = p[0];
      g.gain.value = 0.10;
      o.connect(g); g.connect(mg, 0, p[1]);
      o.start(); _oscs.push(o);
    });

    /* ── KATMAN B: Phi^1 ve Phi^2 Harmonikler ──────────────────────────
       phiSeries[1] = base × φ¹  | phiSeries[2] = base × φ²
       Gain: 0.035 | Pan: ±0.25 (hafif yayılım)
       Bu katman sesin "orta bölgesini" zenginleştirir.                   */
    var layerBPans = [-0.25, 0.25];
    [1, 2].forEach(function(idx) {
      var hFreq = phiSeries[idx];
      if (!hFreq || hFreq > 18000) return;
      var ho = ctx.createOscillator();
      var hg = ctx.createGain();
      ho.type = 'sine'; ho.frequency.value = hFreq;
      hg.gain.value = 0.035;
      if (ctx.createStereoPanner) {
        var hp = ctx.createStereoPanner();
        hp.pan.value = layerBPans[idx - 1];
        ho.connect(hg); hg.connect(hp); hp.connect(_synthBus);
      } else {
        ho.connect(hg); hg.connect(_synthBus);
      }
      ho.start(); _oscs.push(ho);
    });

    /* ── KATMAN C: Phi^3 ve Phi^4 Harmonikler ──────────────────────────
       phiSeries[3] = base × φ³  | phiSeries[4] = base × φ⁴
       Gain: 0.015 | Pan: ±0.55 (geniş stereo alan)
       Bu katman "hava" ve "genişlik" hissi katar — çok kısık.           */
    var layerCPans = [-0.55, 0.55];
    [3, 4].forEach(function(idx) {
      var hFreq = phiSeries[idx];
      if (!hFreq || hFreq > 18000) return;
      var ho = ctx.createOscillator();
      var hg = ctx.createGain();
      ho.type = 'sine'; ho.frequency.value = hFreq;
      hg.gain.value = 0.015;
      if (ctx.createStereoPanner) {
        var hp = ctx.createStereoPanner();
        hp.pan.value = layerCPans[idx - 3];
        ho.connect(hg); hg.connect(hp); hp.connect(_synthBus);
      } else {
        ho.connect(hg); hg.connect(_synthBus);
      }
      ho.start(); _oscs.push(ho);
    });

    console.info('[AudioEngine v4.3] Binaural + Phi Harmonik katmanları başladı.',
      '\n  Katman A (Binaural): Sol', leftFreq.toFixed(2), 'Hz | Sağ', rightFreq.toFixed(2), 'Hz | Beat', safeBeat, 'Hz',
      '\n  Katman B (Phi¹/²) :', (phiSeries[1]||0).toFixed(2), 'Hz /', (phiSeries[2]||0).toFixed(2), 'Hz | gain 0.035',
      '\n  Katman C (Phi³/⁴) :', (phiSeries[3]||0).toFixed(2), 'Hz /', (phiSeries[4]||0).toFixed(2), 'Hz | gain 0.015',
      '\n  EEG Band:', _curBand
    );

    /* [YENİ v4.4 — B] Pitch Drift LFO — tüm binaural + Phi osilatörlerine uygula */
    startPitchDriftLFO(ctx, _oscs.slice());  /* slice(): LFO başlamadan önce anlık kopya */
  }

  /* ══════════════════════════════════════════════════════════════════════
     [YENİ v4.3] startTremoloLayer() — Binaural Genlik Modülasyonu (AM/Tremolo)
     ─────────────────────────────────────────────────────────────────────
     Görev 3: Binaural beat'i sadece sol-sağ frekans farkı olarak değil,
     merkezi carrier frekansının (baseHz) genliğini de beatHz hızında titret.

     Fiziği:
       carrier (baseHz) × [1 + depth × sin(2π × beatHz × t)]
       Beyin, genlik zarfındaki bu titreşimi de işler → güçlendirilmiş entrainment.

     depth = 0.18 (raporun "subtle modulation" ilkesi — agresif değil, destekleyici)
     synthBus'a bağlanır, gain sınırı: 0.08 (tremolo additive, temel binaural'ı boğmaz)
  ══════════════════════════════════════════════════════════════════════ */
  function startTremoloLayer(ctx, baseHz, beatHz) {
    if (!baseHz || !beatHz || beatHz <= 0) return;

    var safeBeat = Math.max(2, Math.min(20, beatHz));

    /* Carrier: merkezi frekans */
    var carrier = ctx.createOscillator();
    carrier.type = 'sine';
    carrier.frequency.value = isFinite(baseHz) ? baseHz : 432;

    /* Tremolo LFO: beatHz hızında genlik titreşimi */
    var tremoloLFO = ctx.createOscillator();
    tremoloLFO.type = 'sine';
    tremoloLFO.frequency.value = safeBeat;

    /* LFO → gain modülasyonu
       depth 0.18 → gain [1 - 0.18, 1 + 0.18] = [0.82, 1.18]
       Çarpım yerine GainNode.gain AudioParam'ı modüle ediyoruz */
    var tremoloDepthGain = ctx.createGain();
    tremoloDepthGain.gain.value = 0.18;  /* tremolo derinliği */

    var tremoloBaseGain = ctx.createGain();
    tremoloBaseGain.gain.value = 0.08;   /* toplam katman seviyesi */

    /* Zincir: tremoloLFO → depthGain → tremoloBaseGain.gain (AudioParam) */
    tremoloLFO.connect(tremoloDepthGain);
    tremoloDepthGain.connect(tremoloBaseGain.gain);

    /* Carrier → tremoloBaseGain → synthBus */
    carrier.connect(tremoloBaseGain);
    tremoloBaseGain.connect(_synthBus);

    carrier.start();
    tremoloLFO.start();

    _oscs.push(carrier);
    _lfoNodes.push(tremoloLFO);

    console.info('[AudioEngine v4.3] Tremolo (AM) katmanı başladı.',
      '| Carrier:', (isFinite(baseHz) ? baseHz : 432).toFixed(2), 'Hz',
      '| Beat (AM):', safeBeat, 'Hz',
      '| Depth: 0.18 | Gain: 0.08'
    );
  }

  /* ══════════════════════════════════════════════════════════════════════
     [YENİ v4.3] _applyResonantPeak() — Harmonik Canlandırıcı Filtre
     ─────────────────────────────────────────────────────────────────────
     Görev 4 (Rapor Sayfa 28): breathLP'yi yalnızca düşük geçiren olarak
     kullanmak yerine, texturenin resonantFreq'inde bir "Resonant Peak"
     (Peaking EQ / yüksek-Q bandpass vurgulama) oluştur.

     Fizik:
       Peaking EQ @ resonantFreq (TEXTURE_MAP'ten):
         gain : +5dB   → o frekanstaki harmonikler öne çıkar
         Q    : 2.5    → dar tepe, sadece hedef harmonikleri vurgular

       Bu filtre breathLP'nin ÖNÜNE, velvetHS'in ARKASINA zincire eklenir:
         ... → velvetHS → resonantPeak → breathLP → comp → limiter → out

     Her startSound çağrısında texture'a özel resonantFreq ile ayarlanır.
     Runtime'da breathLP'nin cutoff'u hâlâ nefes döngüsüyle dalgalanır —
     resonantPeak sabittir, breathLP dinamiktir, ikisi tamamlayıcıdır.
  ══════════════════════════════════════════════════════════════════════ */
  var _resonantPeak = null;  /* Peaking EQ node — per-sound ayarlı */

  /* ── [YENİ v4.4] Hibrit Modülasyon state değişkenleri ─────────────── */
  var _saturator    = null;   /* WaveShaperNode — Tape Saturator (A) */
  var _reverbNode   = null;   /* ConvolverNode  — Uzamsal Reverb (C) */
  var _reverbDryGain = null;  /* Dry yolu gain node */
  var _reverbWetGain = null;  /* Wet yolu gain node */
  var _driftLFOs    = [];     /* Pitch Drift LFO node'ları (B) — stopAll'da temizlenir */
  var _driftDepth   = 0.08;   /* Hz cinsinden drift genliği — v4.6: ±0.12→±0.08 Hz (daha kararlı ton) */
  var _satDrive     = 0.18;   /* Saturator drive parametresi [0.0 – 1.0] — v4.6: 0.35→0.18 (cızırtı giderme) */
  var _reverbWetness = 0.28;  /* Reverb wet/dry oranı [0.0 – 1.0] */

  /* ══════════════════════════════════════════════════════════════════════
     [YENİ v4.4 — A] _buildSatCurve() — Tape Saturator Eğrisi
     ─────────────────────────────────────────────────────────────────────
     WaveShaperNode için Float32Array lookup tablosu.
     Algoritma: Chebyshev-blend soft-clip — analog bant doygunluğuna yakın.
       drive=0    → identity (kuru — tam şeffaf)
       drive=0.35 → hafif harmonik içerik, doğal "sıcaklık"
       drive=1.0  → güçlü doygunluk (meditasyon için kullanılmaz)
  ══════════════════════════════════════════════════════════════════════ */
  function _buildSatCurve(drive, samples) {
    samples = samples || 256;
    drive   = Math.max(0, Math.min(1, drive));
    var curve = new Float32Array(samples);
    var k     = drive * 12;
    for (var j = 0; j < samples; j++) {
      var x  = (2 * j / (samples - 1)) - 1;
      /* Soft-clip: (π + k)×x / (π + k×|x|) → 2./3. harmonik oluşturur */
      curve[j] = drive < 0.001
        ? x
        : ((Math.PI + k) * x) / (Math.PI + k * Math.abs(x));
    }
    return curve;
  }

  /* ══════════════════════════════════════════════════════════════════════
     [YENİ v4.4 — C] _buildImpulseResponse() — Sentetik Reverb IR
     ─────────────────────────────────────────────────────────────────────
     ConvolverNode için dosyasız, runtime'da üretilen Impulse Response.
     Şroeder + üstel gürültü yöntemi: early reflections + diffuse tail.

     durationSec : IR uzunluğu (2.4s → meditasyon odası)
     decay       : söndürme hızı — 2.2 = geniş ama netliği koruyan
  ══════════════════════════════════════════════════════════════════════ */
  function _buildImpulseResponse(ctx, durationSec, decay) {
    var sr      = ctx.sampleRate || 44100;
    var len     = Math.round(sr * (durationSec || 2.4));
    decay       = decay || 2.2;
    var buf     = ctx.createBuffer(2, len, sr);
    var earlyMs  = [17, 31, 43, 67, 83, 107];
    var earlyAmp = [0.6, 0.4, 0.3, 0.2, 0.15, 0.1];
    var preDelay = Math.round(sr * 0.012);  /* 12ms ön-gecikme — konum hissi */

    for (var ch = 0; ch < 2; ch++) {
      var d = buf.getChannelData(ch);

      /* Diffuse tail: üstel sönen beyaz gürültü */
      for (var i = 0; i < len; i++) {
        var phase = ch === 1 ? 0.011 : 0;  /* Sağ kanalda hafif faz kayması → genişlik */
        d[i] = (Math.random() * 2 - 1) * Math.exp(-(decay + phase) * (i / sr));
      }

      /* Early reflections */
      var earlyEnd = Math.round(sr * 0.08);
      earlyMs.forEach(function(ms, idx) {
        var pos = Math.round((ms / 1000) * sr);
        if (pos < earlyEnd && pos < len) {
          var amp = earlyAmp[idx] * (ch === 0 ? 1.0 : 0.88);
          d[pos] += amp;
          if (pos + 1 < len) d[pos + 1] += amp * 0.3;
        }
      });

      /* Pre-delay uygula */
      if (preDelay > 0) {
        for (var j = len - 1; j >= preDelay; j--) d[j] = d[j - preDelay];
        for (var k2 = 0; k2 < preDelay; k2++) d[k2] = 0;
      }
    }
    return buf;
  }

  /* ══════════════════════════════════════════════════════════════════════
     [YENİ v4.4 — B] startPitchDriftLFO() — Canlılık / Pitch Drift
     ─────────────────────────────────────────────────────────────────────
     Tüm synthBus osilatörlerine iki asimetrik, çok yavaş LFO bağlar.
     LFO 1 : 0.030Hz | LFO 2 : 0.047Hz (asal frekans — senkronize olmazlar)
     Depth : ±0.12Hz — insan ses kirişinin doğal titremesiyle eşdeğer.
     Sonuç : "makinenin mi çaldığını yoksa bir insan mı okuduğunu anlayamama"
  ══════════════════════════════════════════════════════════════════════ */
  function startPitchDriftLFO(ctx, oscillators) {
    if (!oscillators || oscillators.length === 0) return;

    /* LFO 1 — 0.030Hz */
    var lfo1   = ctx.createOscillator();
    var depth1 = ctx.createGain();
    lfo1.type            = 'sine';
    lfo1.frequency.value = 0.030;
    depth1.gain.value    = _driftDepth;

    /* LFO 2 — 0.047Hz (senkronize olmayan asal frekans) */
    var lfo2   = ctx.createOscillator();
    var depth2 = ctx.createGain();
    lfo2.type            = 'sine';
    lfo2.frequency.value = 0.047;
    depth2.gain.value    = _driftDepth * 0.6;  /* Biraz daha sessiz → asimetri */

    lfo1.connect(depth1);
    lfo2.connect(depth2);

    /* Her osilatörün frekans AudioParam'ına bağla */
    oscillators.forEach(function(osc) {
      if (!osc || typeof osc.frequency === 'undefined') return;
      try {
        depth1.connect(osc.frequency);
        depth2.connect(osc.frequency);
      } catch(e) {}
    });

    lfo1.start(ctx.currentTime);
    lfo2.start(ctx.currentTime + 0.007);  /* 7ms faz kaydırma → mükemmel senkrondan kaçın */

    _driftLFOs.push(lfo1, depth1, lfo2, depth2);

    console.info('[AudioEngine v4.4] Pitch Drift LFO aktif.',
      '\n  LFO 1: 0.030Hz | LFO 2: 0.047Hz | Depth: ±' + _driftDepth + 'Hz',
      '\n  Hedef osilatör sayısı: ' + oscillators.length
    );
  }

  /* ══════════════════════════════════════════════════════════════════════
     [v4.3] _applyResonantPeak() — Harmonik Canlandırıcı Filtre
  ══════════════════════════════════════════════════════════════════════ */
  function _applyResonantPeak(ctx, resonantFreq) {
    if (!resonantFreq || !_velvetHS || !_breathLP || !ctx) return;

    /* Eğer zaten varsa: sadece parametrelerini güncelle, node'u yeniden bağlama */
    if (_resonantPeak) {
      var now = ctx.currentTime;
      _resonantPeak.frequency.setValueAtTime(_resonantPeak.frequency.value, now);
      _resonantPeak.frequency.linearRampToValueAtTime(resonantFreq, now + 0.5);
      console.info('[AudioEngine v4.3] ResonantPeak güncellendi →', resonantFreq, 'Hz');
      return;
    }

    /* İlk çağrı: velvetHS → resonantPeak → breathLP zincirini kur */
    _resonantPeak = ctx.createBiquadFilter();
    _resonantPeak.type           = 'peaking';
    _resonantPeak.frequency.value = resonantFreq;
    _resonantPeak.Q.value        = 2.5;
    _resonantPeak.gain.value     = 5.0;

    try { _velvetHS.disconnect(_breathLP); } catch(e) {}
    _velvetHS.connect(_resonantPeak);
    _resonantPeak.connect(_breathLP);

    console.info('[AudioEngine v4.3] ResonantPeak zincire eklendi.',
      '| Freq:', resonantFreq, 'Hz | Q: 2.5 | Gain: +5dB',
      '\n  Zincir: velvetHS → resonantPeak →', resonantFreq, 'Hz → breathLP → comp → limiter'
    );
  }
  function loadOGG(ctx, filename) {
    var url = '/samples/' + filename;
    if (_bufferCache[url]) return Promise.resolve(_bufferCache[url]);
    return fetch(url)
      .then(function(res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.arrayBuffer();
      })
      .then(function(ab) {
        return new Promise(function(resolve, reject) { ctx.decodeAudioData(ab, resolve, reject); });
      })
      .then(function(buf) { _bufferCache[url] = buf; return buf; })
      .catch(function(err) { throw err; });
  }

  function startSampleLayer(ctx, filename, gain, xfDur) {
    return loadOGG(ctx, filename)
      .then(function(buffer) {
        var src   = ctx.createBufferSource();
        var gNode = ctx.createGain();
        src.buffer = buffer; src.loop = true;
        src.loopStart = 0; src.loopEnd = buffer.duration;
        gNode.gain.setValueAtTime(0, ctx.currentTime);
        gNode.gain.linearRampToValueAtTime(Math.max(0.1, Math.min(0.85, gain)), ctx.currentTime + xfDur);
        src.connect(gNode); gNode.connect(_textureBus);
        src.start(0); _sampleNodes.push(src);
        console.info('[AudioEngine v4.1] OGG →', filename);
        return true;
      })
      .catch(function(err) {
        console.warn('[AudioEngine v4.1] OGG yok:', filename, '→ Prosedürel sentez');
        return null;
      });
  }

  /* ══════════════════════════════════════════════════════════════════════
     KATMAN 3 — PROSEDÜREL DOĞA SENTEZİ
     RAIN  — 50-100 click/sn, 1-3ms, High-Pass 3000Hz+
     FIRE  — Pink Noise + çıtırtılı gain modülasyonu
     WIND  — Pink Noise + LFO (400-1100Hz)
     WAVES — Sinüs dalga buffer
  ══════════════════════════════════════════════════════════════════════ */

  /* Pink Noise buffer — Paul Kellet algoritması */
  function makePinkBuffer(ctx, durationSec) {
    var sr  = ctx.sampleRate || 44100;
    var len = Math.round(sr * durationSec);
    var buf = ctx.createBuffer(2, len, sr);
    for (var ch = 0; ch < 2; ch++) {
      var d = buf.getChannelData(ch);
      var b0=0,b1=0,b2=0,b3=0,b4=0,b5=0,b6=0;
      for (var i = 0; i < len; i++) {
        var w = Math.random()*2-1;
        b0=0.99886*b0+w*0.0555179; b1=0.99332*b1+w*0.0750759;
        b2=0.96900*b2+w*0.1538520; b3=0.86650*b3+w*0.3104856;
        b4=0.55000*b4+w*0.5329522; b5=-0.7616*b5-w*0.0168980;
        d[i]=(b0+b1+b2+b3+b4+b5+b6+w*0.5362)*0.11;
        b6=w*0.115926;
        d[i]=Math.max(-1,Math.min(1,d[i]));
      }
    }
    return buf;
  }

  /* RAIN */
  function startRainSynth(ctx, gain, xfDur) {
    var masterGain = ctx.createGain();
    masterGain.gain.setValueAtTime(0, ctx.currentTime);
    masterGain.gain.linearRampToValueAtTime(Math.min(0.75, gain), ctx.currentTime + xfDur);
    masterGain.connect(_textureBus);

    var pinkSrc = ctx.createBufferSource();
    var pinkHP  = ctx.createBiquadFilter();
    var pinkG   = ctx.createGain();
    pinkSrc.buffer = makePinkBuffer(ctx, 8); pinkSrc.loop = true;
    pinkHP.type = 'highpass'; pinkHP.frequency.value = 3000;
    pinkG.gain.value = 0.08;
    pinkSrc.connect(pinkHP); pinkHP.connect(pinkG); pinkG.connect(masterGain);
    pinkSrc.start(0); _synthNodes.push(pinkSrc);

    function scheduleClicks() {
      var rate     = 50 + Math.random() * 50;
      var interval = Math.round(1000 / rate);
      var timer = setInterval(function() {
        if (!_playing || !_ctx) { clearInterval(timer); return; }
        try {
          var clickCtx  = _ctx;
          var clickDur  = 0.001 + Math.random() * 0.002;
          var clickFreq = 3000 + Math.random() * 6000;
          var co = clickCtx.createOscillator();
          var cg = clickCtx.createGain();
          var cf = clickCtx.createBiquadFilter();
          co.type = 'sine'; co.frequency.value = clickFreq;
          cf.type = 'bandpass'; cf.frequency.value = clickFreq; cf.Q.value = 0.5;
          cg.gain.setValueAtTime(0.08, clickCtx.currentTime);
          cg.gain.exponentialRampToValueAtTime(0.0001, clickCtx.currentTime + clickDur);
          co.connect(cf); cf.connect(cg); cg.connect(masterGain);
          co.start(clickCtx.currentTime);
          co.stop(clickCtx.currentTime + clickDur + 0.002);
        } catch(e) {}
      }, interval);
      _clickTimers.push(timer);
    }
    scheduleClicks();
    console.info('[AudioEngine v4.1] Prosedürel Yağmur aktif');
  }

  /* FIRE */
  function startFireSynth(ctx, gain, xfDur) {
    var pinkSrc = ctx.createBufferSource();
    var bandPass = ctx.createBiquadFilter();
    var crackle  = ctx.createGain();
    var masterG  = ctx.createGain();

    pinkSrc.buffer = makePinkBuffer(ctx, 12); pinkSrc.loop = true;
    bandPass.type = 'bandpass'; bandPass.frequency.value = 800; bandPass.Q.value = 0.3;
    masterG.gain.setValueAtTime(0, ctx.currentTime);
    masterG.gain.linearRampToValueAtTime(Math.min(0.75, gain), ctx.currentTime + xfDur);
    masterG.connect(_textureBus);

    var flameLFO     = ctx.createOscillator();
    var flameLFOGain = ctx.createGain();
    flameLFO.type = 'sine'; flameLFO.frequency.value = 0.3 + Math.random()*0.3;
    flameLFOGain.gain.value = 0.35;
    flameLFO.connect(flameLFOGain); flameLFOGain.connect(crackle.gain);
    crackle.gain.value = 0.65;
    flameLFO.start(); _lfoNodes.push(flameLFO);

    var crackLFO     = ctx.createOscillator();
    var crackLFOGain = ctx.createGain();
    crackLFO.type = 'sawtooth'; crackLFO.frequency.value = 8 + Math.random()*6;
    crackLFOGain.gain.value = 0.08;
    crackLFO.connect(crackLFOGain); crackLFOGain.connect(crackle.gain);
    crackLFO.start(); _lfoNodes.push(crackLFO);

    pinkSrc.connect(bandPass); bandPass.connect(crackle); crackle.connect(masterG);
    pinkSrc.start(0); _synthNodes.push(pinkSrc);
    console.info('[AudioEngine v4.1] Prosedürel Ateş aktif');
  }

  /* WIND */
  function startWindSynth(ctx, gain, xfDur) {
    var pinkSrc = ctx.createBufferSource();
    var bandLP  = ctx.createBiquadFilter();
    var masterG = ctx.createGain();

    pinkSrc.buffer = makePinkBuffer(ctx, 10); pinkSrc.loop = true;
    bandLP.type = 'bandpass'; bandLP.frequency.value = 750; bandLP.Q.value = 0.6;
    masterG.gain.setValueAtTime(0, ctx.currentTime);
    masterG.gain.linearRampToValueAtTime(Math.min(0.75, gain), ctx.currentTime + xfDur);
    masterG.connect(_textureBus);

    var lfo     = ctx.createOscillator();
    var lfoGain = ctx.createGain();
    lfo.type = 'sine'; lfo.frequency.value = 0.12 + Math.random()*0.18;
    lfoGain.gain.value = 350;
    lfo.connect(lfoGain); lfoGain.connect(bandLP.frequency);
    lfo.start(); _lfoNodes.push(lfo);

    var lfo2     = ctx.createOscillator();
    var lfo2Gain = ctx.createGain();
    lfo2.type = 'sine'; lfo2.frequency.value = 0.04 + Math.random()*0.06;
    lfo2Gain.gain.value = 150;
    lfo2.connect(lfo2Gain); lfo2Gain.connect(bandLP.frequency);
    lfo2.start(); _lfoNodes.push(lfo2);

    pinkSrc.connect(bandLP); bandLP.connect(masterG);
    pinkSrc.start(0); _synthNodes.push(pinkSrc);
    console.info('[AudioEngine v4.1] Prosedürel Rüzgar aktif (400-1100Hz LFO)');
  }

  /* WAVES */
  function startWavesSynth(ctx, gain, xfDur) {
    var sr  = ctx.sampleRate || 44100;
    var len = Math.round(sr * _loopDur);
    var buf = ctx.createBuffer(2, len, sr);
    for (var ch = 0; ch < 2; ch++) {
      var d=buf.getChannelData(ch), p1=0,p2=0,p3=0;
      for (var i=0; i<len; i++) {
        p1+=(2*Math.PI*0.08)/sr; p2+=(2*Math.PI*0.19)/sr; p3+=(2*Math.PI*0.04)/sr;
        var sw=Math.sin(p3)*0.4+0.6;
        d[i]=Math.max(-1,Math.min(1,
          Math.sin(p1)*0.18*sw + Math.sin(p2)*0.09*sw + (Math.random()*2-1)*0.04*sw
        ));
      }
    }
    var src  = ctx.createBufferSource();
    var gNode= ctx.createGain();
    src.buffer=buf; src.loop=true;
    gNode.gain.setValueAtTime(0,ctx.currentTime);
    gNode.gain.linearRampToValueAtTime(Math.min(0.75,gain),ctx.currentTime+xfDur);
    src.connect(gNode); gNode.connect(_textureBus);
    src.start(0); _synthNodes.push(src);
    console.info('[AudioEngine v4.1] Prosedürel Dalgalar aktif');
  }

  /* Texture tipine göre prosedürel sentezleyici seç */
  function startProceduralSynth(ctx, textureName, gain, xfDur) {
    var gen = TEXTURE_TO_GEN[textureName] || 'waves';
    if      (gen === 'rain')     startRainSynth(ctx, gain, xfDur);
    else if (gen === 'fire')     startFireSynth(ctx, gain, xfDur);
    else if (gen === 'wind')     startWindSynth(ctx, gain, xfDur);
    else if (gen === 'binaural') startWindSynth(ctx, gain * 0.5, xfDur);
    else                         startWavesSynth(ctx, gain, xfDur);

    /* [YENİ v4.2] FM + Granular katmanlarını da başlat */
    _initProceduralNodes(ctx, textureName, gain, xfDur);
  }

  /* ══════════════════════════════════════════════════════════════════════
     [YENİ v4.2] _initProceduralNodes() — Rapor Bölüm 2.4 "Synthesized Nature"
     ─────────────────────────────────────────────────────────────────────
     FMSynthesizer + GranularEngine'i texture tipine göre başlatır ve
     ana textureBus'a bağlar. Pink Noise katmanının organik zenginleştiricisi
     olarak konumlanır — hiçbir zaman onun yerine geçmez (gain 0.15–0.25).

     Texture → FM Parametreleri:
       rain  → carrier 200Hz, ratio 3.2, index 4.0 (su damlacığı rezonansı)
       wind  → carrier  80Hz, ratio 1.8, index 6.5 (derin uğultu + titreme)
       fire  → carrier 150Hz, ratio 2.5, index 5.0 (organik çıtırtı spektrumu)

     Texture → Granular Parametreleri:
       rain  → buffer:'rain',   grainSize 60ms,  grainRate 16, scatter 0.8
       wind  → buffer:'wind',   grainSize 150ms, grainRate 9,  scatter 0.4
       fire  → buffer:'forest', grainSize 90ms,  grainRate 12, scatter 0.6
  ══════════════════════════════════════════════════════════════════════ */
  function _initProceduralNodes(ctx, textureName, gainBase, xfDur) {
    /* Guard: FMSynthesizer veya GranularEngine yüklü değilse sessizce geç */
    var hasFM      = (typeof window.FMSynthesizer    === 'function');
    var hasGranular= (typeof window.GranularEngine   === 'function');

    if (!hasFM && !hasGranular) {
      console.info('[AudioEngine v4.2] _initProceduralNodes: FMSynthesizer ve GranularEngine'
        + ' henüz yüklü değil — yalnızca Pink Noise katmanı aktif.');
      return;
    }

    var gen = TEXTURE_TO_GEN[textureName] || 'waves';

    /* Yalnızca desteklenen prosedürel tipler için çalış */
    if (gen !== 'rain' && gen !== 'wind' && gen !== 'fire') {
      return;
    }

    /* ── FM Sentezleyici Parametreleri ─────────────────────────────────
       Her texture için ayarlanmış carrier + modülatör konfigürasyonu.
       FM gain: 0.15 (Pink Noise baskın kalır — Rapor: "texture > synth")   */
    var FM_PRESETS = {
      rain: {
        carrierFreq    : 200,   /* Su sütunu rezonansı bölgesi */
        modulatorRatio : 3.2,   /* Harmonik 3. ve 4. oktav arası — damlacık */
        modulationIndex: 4.0,   /* Orta-yüksek FM derinliği — doğal değişim */
        volume         : 0.15,
        adsr: { attack: 2.5, decay: 1.0, sustain: 0.80, release: 3.0 },
      },
      wind: {
        carrierFreq    : 80,    /* Alt-bas gürültü temeli — rüzgar uğultusu */
        modulatorRatio : 1.8,   /* Yakın oran → yavaş titreme (LFO benzeri) */
        modulationIndex: 6.5,   /* Yüksek derinlik → geniş frekans sapması */
        volume         : 0.18,
        adsr: { attack: 4.0, decay: 2.0, sustain: 0.70, release: 5.0 },
      },
      fire: {
        carrierFreq    : 150,   /* Alev tını bölgesi */
        modulatorRatio : 2.5,   /* 2. ve 3. harmonik arası — çatırtı içeriği */
        modulationIndex: 5.0,   /* Güçlü FM — organik bozunma dokusu */
        volume         : 0.15,
        adsr: { attack: 1.5, decay: 1.5, sustain: 0.75, release: 2.5 },
      },
    };

    /* ── Granular Parametreleri ─────────────────────────────────────────
       Her texture için buffer tipi ve grain parametreleri.
       Granular gain: 0.20–0.25 — Pink Noise'a organik "parçacık" ekler.    */
    var GRAIN_PRESETS = {
      rain: {
        bufferType : 'rain',
        grainSize  : 60,    /* Kısa grainler → keskin damlacık dokusu */
        grainRate  : 16,    /* Yüksek yoğunluk → yoğun yağmur hissi */
        pitch      : 1.1,   /* Hafif tiz — yağmur sesi spektrumu */
        scatter    : 0.8,   /* Yüksek dağılım → rastgele damla pozisyonları */
        volume     : 0.20,
      },
      wind: {
        bufferType : 'wind',  /* GranularEngine generateBuffer('wind') */
        grainSize  : 150,   /* Uzun grainler → akıcı rüzgar dokusu */
        grainRate  : 9,     /* Seyrek — rüzgarın "soluk" karakteri */
        pitch      : 0.85,  /* Biraz derin — hava kütlesi ağırlığı */
        scatter    : 0.4,   /* Düşük dağılım → tutarlı akış */
        volume     : 0.22,
      },
      fire: {
        bufferType : 'forest', /* Organik tıkırtı malzemesi */
        grainSize  : 90,    /* Orta boy → ateş çıtırtısı uzunluğu */
        grainRate  : 12,    /* Orta yoğunluk → doğal alevlenme ritmi */
        pitch      : 1.3,   /* Tiz → kuru odun çıtırtısı */
        scatter    : 0.6,   /* Orta dağılım → sürprizli ama tempolu */
        volume     : 0.20,
      },
    };

    var fmPreset    = FM_PRESETS[gen];
    var grainPreset = GRAIN_PRESETS[gen];

    /* ── FM Sentezleyici Başlat ─────────────────────────────────────── */
    if (hasFM && fmPreset) {
      try {
        /* Eğer aynı texture için halihazırda bir FM varsa durdur */
        if (_proceduralFM[gen]) {
          try { _proceduralFM[gen].stop(); } catch(e2) {}
        }

        var fm = new window.FMSynthesizer(ctx, _textureBus, {
          carrierFreq    : fmPreset.carrierFreq,
          modulatorRatio : fmPreset.modulatorRatio,
          modulationIndex: fmPreset.modulationIndex,
          volume         : fmPreset.volume,
          binaural       : false,      /* Binaural zaten Katman 1'de — çakışma önleme */
          adsr           : fmPreset.adsr,
        });
        fm.start();
        _proceduralFM[gen] = fm;

        console.info('[AudioEngine v4.2] FMSynthesizer başladı.',
          '| Texture:', textureName,
          '| Carrier:', fmPreset.carrierFreq, 'Hz',
          '| ModRatio:', fmPreset.modulatorRatio,
          '| ModIndex:', fmPreset.modulationIndex,
          '| Vol:', fmPreset.volume
        );
      } catch(e) {
        console.warn('[AudioEngine v4.2] FMSynthesizer başlatma hatası:', e.message);
      }
    }

    /* ── GranularEngine Başlat ─────────────────────────────────────── */
    if (hasGranular && grainPreset) {
      try {
        /* Eğer aynı texture için halihazırda bir Granular varsa durdur */
        if (_proceduralGrain[gen]) {
          try { _proceduralGrain[gen].dispose(); } catch(e2) {}
        }

        var granular = new window.GranularEngine(ctx, _textureBus, {
          grainSize : grainPreset.grainSize,
          grainRate : grainPreset.grainRate,
          pitch     : grainPreset.pitch,
          scatter   : grainPreset.scatter,
          volume    : grainPreset.volume,
        });

        /* Texture tipine uygun dahili buffer üret */
        granular.generateBuffer(grainPreset.bufferType);
        granular.start();
        _proceduralGrain[gen] = granular;

        console.info('[AudioEngine v4.2] GranularEngine başladı.',
          '| Texture:', textureName,
          '| Buffer:', grainPreset.bufferType,
          '| GrainSize:', grainPreset.grainSize, 'ms',
          '| GrainRate:', grainPreset.grainRate, '/s',
          '| Scatter:', grainPreset.scatter,
          '| Vol:', grainPreset.volume
        );
      } catch(e) {
        console.warn('[AudioEngine v4.2] GranularEngine başlatma hatası:', e.message);
      }
    }
  }

  /* ══════════════════════════════════════════════════════════════════════
     [YENİ v4.2] stopProceduralNodes() — FM + Granular temizliği
     stopAll() tarafından çağrılır. Her örnekte .stop() + .dispose()
     çağrılarak Web Audio graph sızıntısı önlenir.
  ══════════════════════════════════════════════════════════════════════ */
  function stopProceduralNodes() {
    Object.keys(_proceduralFM).forEach(function(key) {
      try { _proceduralFM[key].stop(); } catch(e) {}
    });
    _proceduralFM = {};

    Object.keys(_proceduralGrain).forEach(function(key) {
      try { _proceduralGrain[key].dispose(); } catch(e) {}
    });
    _proceduralGrain = {};

    console.info('[AudioEngine v4.2] FM + Granular prosedürel node\'lar temizlendi.');
  }

  /* ══════════════════════════════════════════════════════════════════════
     [REVİZE v4.2] applyGranular() — Maestro v2 granularParams uygulayıcı
     ─────────────────────────────────────────────────────────────────────
     v4.1: Stub — yalnızca GranularEngine.setGrainSize() çağırırdı.
     v4.2: Aktif _proceduralGrain örneklerine setParam() ile uygular;
           eğer örnek yoksa _initProceduralNodes() üzerinden başlatır.

     Maestro v2 granularParams şeması:
       { grainSize, density (=grainRate), pitch, scatter, volume }
  ══════════════════════════════════════════════════════════════════════ */
  function applyGranular(params) {
    if (!params || !_ctx) return;

    /* Aktif tüm GranularEngine örneklerine parametre uygula */
    var hasActive = Object.keys(_proceduralGrain).length > 0;

    if (hasActive) {
      Object.keys(_proceduralGrain).forEach(function(key) {
        var gr = _proceduralGrain[key];
        if (!gr) return;
        try {
          if (typeof params.grainSize === 'number') gr.setParam('grainSize', Math.max(50, Math.min(200, params.grainSize)));
          if (typeof params.density   === 'number') gr.setParam('grainRate', Math.max(8,  Math.min(20,  params.density)));
          if (typeof params.pitch     === 'number') gr.setParam('pitch',     Math.max(0.5,Math.min(2.0, params.pitch)));
          if (typeof params.scatter   === 'number') gr.setParam('scatter',   Math.max(0,  Math.min(1,   params.scatter)));
          if (typeof params.volume    === 'number') gr.setParam('volume',    Math.max(0,  Math.min(0.4, params.volume)));
        } catch(e) {
          console.warn('[AudioEngine v4.2] GranularEngine.setParam hatası:', e.message);
        }
      });
      console.info('[AudioEngine v4.2] applyGranular → aktif örnekler güncellendi:', JSON.stringify(params));
    } else {
      /* Granular henüz başlamamış — _curGen'e göre başlat */
      console.info('[AudioEngine v4.2] applyGranular: aktif granular yok.'
        + ' Maestro params alındı, bir sonraki startSound\'da uygulanacak:', JSON.stringify(params));
    }
  }

  /* ══════════════════════════════════════════════════════════════════════
     ANA SES BAŞLATMA v4.3
  ══════════════════════════════════════════════════════════════════════ */
  function startSound(gen, base, beat, offset, maestro) {
    var ctx = getCtx();
    if (ctx.state === 'suspended') ctx.resume();
    ensureMaster(ctx);
    stopAll();

    var ambVol = window._prefVector
      ? (window._prefVector.getLayerGains ? window._prefVector.getLayerGains().ambient*0.85 : 0.60)
      : 0.60;
    var xfDur = window._prefVector
      ? (window._prefVector.getCrossfadeDuration ? window._prefVector.getCrossfadeDuration() : 1.5)
      : 1.5;

    /* Katman 1A: Binaural + Phi Harmonik katmanları */
    startBinauralLayer(ctx, base, beat);

    /* [YENİ v4.3] Katman 1B: Tremolo (AM) — beat frekansında genlik modülasyonu */
    startTremoloLayer(ctx, base, beat);

    /* Katman 2 & 3: Textures — _resolveTexture ile normalize edilmiş isim eşleme */
    var textures = (maestro && Array.isArray(maestro.textures) && maestro.textures.length > 0)
      ? maestro.textures
      : [{ name: (gen || 'ocean'), gain: ambVol }];

    var firstResonantFreq = null;  /* İlk texturenin resonantFreq'i zincire uygulanır */

    textures.forEach(function(t) {
      var tEntry   = _resolveTexture(t.name);   /* [YENİ v4.3] normalize + fallback */
      var filename = tEntry.file;
      var tGain    = typeof t.gain === 'number' ? t.gain : 0.5;

      /* İlk texture'ın resonantFreq'ini kaydet */
      if (firstResonantFreq === null && tEntry.resonantFreq) {
        firstResonantFreq = tEntry.resonantFreq;
      }

      if (filename) {
        startSampleLayer(ctx, filename, tGain, xfDur).then(function(ok) {
          if (ok === null) startProceduralSynth(ctx, t.name, tGain, xfDur);
        });
      } else {
        startProceduralSynth(ctx, t.name, tGain, xfDur);
      }
    });

    /* [YENİ v4.3] Resonant Peak — texture'ın harmonik bölgesini canlandır */
    if (firstResonantFreq) {
      setTimeout(function() {
        _applyResonantPeak(ctx, firstResonantFreq);
      }, 100);  /* 100ms: ensureMaster'dan sonra bağlantılar hazır */
    }

    /* Maestro v2: DSP profili uygula */
    if (maestro && maestro.dspProfile) {
      setTimeout(function() { applyDSPProfile(maestro.dspProfile); }, 200);
    }

    /* Maestro v2: Granular parametreler */
    if (maestro && maestro.granularParams) {
      applyGranular(maestro.granularParams);
    }

    /* Katman 5: Nefes-Filtre senkronu */
    var breath = (maestro && maestro.breath) ? maestro.breath : _currentBreath;
    if (maestro && maestro.breathPattern && !Array.isArray(maestro.breathPattern)) {
      breath = [
        maestro.breathPattern.inhale || 4,
        maestro.breathPattern.hold   || 2,
        maestro.breathPattern.exhale || 6,
      ];
    }
    _currentBreath = breath;
    startBreathCycle(breath);

    _curGen  = gen;
    _curBase = isFinite(base) ? base : 0;
    _curBeat = isFinite(beat) ? beat : 0;
    _startTime = ctx.currentTime;
    _updateUI(base, gen, maestro ? maestro.sceneName : null);
  }

  function _updateUI(base, gen, sceneName) {
    var lbl   = document.getElementById('freq-label');
    var badge = document.getElementById('freq-badge');
    if (lbl)   lbl.textContent = (base||'') + ' Hz · ' + (sceneName||gen||'') + (_curBand ? ' · ' + _curBand : '');
    if (badge) badge.classList.add('on');
    var wf = document.getElementById('waveform');
    if (wf) {
      if (!wf.children.length) {
        for (var i=0;i<12;i++) {
          var b=document.createElement('div'); b.className='wbar';
          b.style.setProperty('--dur',(0.4+Math.random()*0.6)+'s');
          b.style.setProperty('--del',(Math.random()*0.4)+'s');
          wf.appendChild(b);
        }
      }
      wf.querySelectorAll('.wbar').forEach(function(b){b.classList.add('on');});
    }
  }

  /* ══════════════════════════════════════════════════════════════════════
     GLOBAL API
  ══════════════════════════════════════════════════════════════════════ */
  window.togglePlay = function() {
    var btn  = document.getElementById('play-btn');
    var icon = document.getElementById('play-icon');
    var lbl  = document.getElementById('play-lbl');
    var wrap = document.querySelector('.breath-wrap');
    _playing = !_playing;
    if (icon) icon.textContent = _playing ? '⏸' : '▶';
    if (btn)  { btn.setAttribute('aria-pressed',String(_playing)); btn.classList.toggle('on',_playing); }
    if (lbl)  lbl.textContent = _playing ? 'Duraklat' : 'Frekansı Başlat';
    if (wrap) { wrap.classList.remove('breath-idle','breath-inhale'); wrap.classList.add(_playing?'breath-inhale':'breath-idle'); }

    if (_playing) {
      try {
        var gen='',base=0,beat=0;
        try { gen=localStorage.getItem('lastGen')||''; base=parseInt(localStorage.getItem('lastBase')||'0')||0; beat=parseFloat(localStorage.getItem('lastBeat')||'0')||0; } catch(e){}
        if (!gen||!base) {
          var mood='Sakin'; try{mood=localStorage.getItem('lastMood')||'Sakin';}catch(e){}
          var cfg=MOOD_MAP[mood]||MOOD_MAP['Sakin']; gen=cfg.gen; base=cfg.base; beat=cfg.beat;
        }
        startSound(gen,base,beat,_pauseOffset,null);
        if (window._feedbackCollector) try{window._feedbackCollector.startSession();}catch(e){}
      } catch(e) {
        _playing=false;
        if(icon)icon.textContent='▶';
        if(btn){btn.setAttribute('aria-pressed','false');btn.classList.remove('on');}
        if(lbl)lbl.textContent='Frekansı Başlat';
        console.warn('[togglePlay]',e);
      }
    } else {
      if(_ctx&&_startTime) _pauseOffset=(_ctx.currentTime-_startTime)%_loopDur;
      stopAll(); stopBreathCycle();
      if(_ctx) try{_ctx.suspend();}catch(e){}
      document.querySelectorAll('.wbar').forEach(function(b){b.classList.remove('on');});
      var badge2=document.getElementById('freq-badge'); if(badge2)badge2.classList.remove('on');
      if(window._feedbackCollector) try{window._feedbackCollector.endSession();}catch(e){}
    }
  };

  window.switchSound = function(gen, base, beat, label, maestro) {
    try { localStorage.setItem('lastGen',gen); localStorage.setItem('lastBase',base); localStorage.setItem('lastBeat',beat); } catch(e){}
    if(window._prefVector) try{window._prefVector.recordSoundChoice(gen,base,beat);}catch(e){}
    _pauseOffset = 0;

    if (_playing) {
      startSound(gen, base, beat, 0, maestro||null);
    } else {
      _playing = true;
      var btn=document.getElementById('play-btn'), icon=document.getElementById('play-icon');
      var lbl2=document.getElementById('play-lbl'), wrap=document.querySelector('.breath-wrap');
      if(icon)icon.textContent='⏸';
      if(btn){btn.setAttribute('aria-pressed','true');btn.classList.add('on');}
      if(lbl2)lbl2.textContent='Duraklat';
      if(wrap){wrap.classList.remove('breath-idle');wrap.classList.add('breath-inhale');}
      try { startSound(gen,base,beat,0,maestro||null); } catch(e){console.warn('[switchSound]',e);_playing=false;}
    }
    var lbl=document.getElementById('freq-label'), badge=document.getElementById('freq-badge');
    if(lbl)lbl.textContent=(base||'')+' Hz · '+(label||gen);
    if(badge){badge.classList.add('on');badge.style.opacity='1';}
  };

  /* applyMSD — Maestro JSON direkt giriş (v4.1: dspProfile + granularParams + breathPattern) */
  window.applyMSD = function(maestro) {
    if (!maestro||typeof maestro!=='object') return;

    /* FrequencyManager ile Solfeggio entegrasyonu */
    if (window.getFrequencyManager && maestro.solfeggioHz) {
      var fm = window.getFrequencyManager();
      fm.applyMSD(maestro);
    }

    var firstTex=(maestro.textures&&maestro.textures[0])?maestro.textures[0].name:
                 (maestro.texture||'ocean');
    var gen=TEXTURE_TO_GEN[firstTex]||'waves';
    var base=maestro.baseHz||maestro.solfeggioHz||432;
    var beat=maestro.binauralHz||7;

    window.switchSound(gen, base, beat, maestro.sceneName, maestro);

    /* [YENİ v4.4] Yan çıktı: Stable Audio / Suno için AI prompt üret */
    try {
      if (window.Sanctuary && window.Sanctuary.AudioEngine &&
          window.Sanctuary.AudioEngine.generateAIPrompt) {
        var aiPrompt = window.Sanctuary.AudioEngine.generateAIPrompt(maestro);
        /* Uygulamak isteyen geliştiriciler için window.lastAIPrompt'a kaydet */
        window.lastAIPrompt = aiPrompt;
      }
    } catch(e) {}

    console.info('[AudioEngine v4.4] applyMSD →', maestro.sceneName||'?',
      '| base:', base, 'Hz',
      '| beat:', beat, 'Hz',
      '| solfeggio:', maestro.solfeggioHz||'—',
      '| dspProfile:', maestro.dspProfile ? 'var' : 'yok',
      '| granular:', maestro.granularParams ? 'var' : 'yok',
      '| aiPrompt: window.lastAIPrompt'
    );
  };

  window.setSleepTimer = function(minutes) {
    if(window._sleepTimerRef)clearTimeout(window._sleepTimerRef);
    document.querySelectorAll('.stimer-btn').forEach(function(b){b.classList.remove('active','fading');});
    var ab=Array.from(document.querySelectorAll('.stimer-btn')).find(function(b){return b.textContent.trim()===minutes+'dk';});
    if(ab)ab.classList.add('active');
    var st=document.getElementById('stimer-status');
    if(st){st.textContent='⏰ '+minutes+' dk sonra duracak';st.className='active';}
    var fadeAt=(minutes-2)*60000, stopAt=minutes*60000;
    if(fadeAt>0)setTimeout(function(){
      if(_ctx&&_master){var n=_ctx.currentTime;_master.gain.setValueAtTime(_master.gain.value,n);_master.gain.linearRampToValueAtTime(0,n+120);}
      if(st){st.textContent='🌙 Ses kısılıyor...';st.className='fading';}
      if(ab)ab.classList.add('fading');
    },fadeAt);
    window._sleepTimerRef=setTimeout(function(){
      if(_playing)window.togglePlay();
      if(st){st.textContent='✓ Tamamlandı';st.className='';}
      document.querySelectorAll('.stimer-btn').forEach(function(b){b.classList.remove('active','fading');});
      window._sleepTimerRef=null;
    },stopAt);
  };

  window.cancelSleepTimer=function(){
    if(window._sleepTimerRef){clearTimeout(window._sleepTimerRef);window._sleepTimerRef=null;}
    document.querySelectorAll('.stimer-btn').forEach(function(b){b.classList.remove('active','fading');});
    var st=document.getElementById('stimer-status'); if(st){st.textContent='';st.className='';}
    if(_ctx&&_master&&_playing){var n=_ctx.currentTime;_master.gain.cancelScheduledValues(n);_master.gain.setValueAtTime(_master.gain.value,n);_master.gain.linearRampToValueAtTime(0.8,n+1);}
  };

  window.getFrequency    = function(){ return _curBase; };
  window.getMasterVolume = function(){ return _master?_master.gain.value:0.8; };
  window.setMasterVolume = function(vol){
    vol=Math.max(0,Math.min(1,vol));
    if(_master&&_ctx){var n=_ctx.currentTime;_master.gain.setValueAtTime(_master.gain.value,n);_master.gain.linearRampToValueAtTime(vol,n+0.3);}
  };

  window.applyRemoteState=function(p){
    if(!p)return;
    try{if(p.volume!==undefined)window.setMasterVolume(p.volume);if(p.gen&&p.base)window.switchSound(p.gen,p.base,p.beat||0);}catch(e){}
  };
  window.syncStart=function(ts){
    var d=Math.max(0,ts-Date.now());
    setTimeout(function(){if(!_playing)window.togglePlay();},d);
  };

  window.applyBiometricEffect=function(p){
    if(!p||!_ctx)return;
    var n=_ctx.currentTime, r=1.5;
    var SYNTH_HARD_CAP = 0.40;

    try{
      if(_master&&p.masterVolume!==undefined)
        _master.gain.linearRampToValueAtTime(Math.max(0.1,Math.min(1,p.masterVolume)),n+r);

      if(_eqLow&&p.eqLowBoost!==undefined)
        _eqLow.gain.linearRampToValueAtTime(Math.max(-6,Math.min(6,2+p.eqLowBoost)),n+r);
      if(_eqHigh&&p.eqHighCut!==undefined)
        _eqHigh.gain.linearRampToValueAtTime(Math.max(-6,Math.min(6,1.5+p.eqHighCut)),n+r);

      /* [YENİ] Biometrik stres → velvetHS gain'i de ayarla
         Yüksek stres → tizleri daha fazla kıs (daha sakinleştirici) */
      if (_velvetHS && p.tension !== undefined) {
        var tension = Math.max(0, Math.min(1, p.tension));
        /* tension 0.0 → -4dB, tension 1.0 → -9dB */
        var hsTarget = -4 - (tension * 5);
        _velvetHS.gain.setValueAtTime(_velvetHS.gain.value, n);
        _velvetHS.gain.linearRampToValueAtTime(hsTarget, n + r);
      }

      var tension = 0.0;
      if (p.tension !== undefined) {
        tension = Math.max(0, Math.min(1, p.tension));
      } else if (p.hrv !== undefined) {
        tension = Math.max(0, Math.min(1, 1 - ((p.hrv - 20) / 60)));
      }

      if (_synthBus || _textureBus) {
        var baseSynth   = _layerGains.synth;
        var rawSynth    = baseSynth - (tension * 0.20);
        var targetSynth = Math.min(SYNTH_HARD_CAP, Math.max(0.05, rawSynth));

        var baseTexture   = _layerGains.texture;
        var targetTexture = Math.min(1.0, Math.max(0.50, baseTexture + (tension * 0.15)));

        if (_synthBus) {
          _synthBus.gain.setValueAtTime(_synthBus.gain.value, n);
          _synthBus.gain.linearRampToValueAtTime(targetSynth, n + r);
        }
        if (_textureBus) {
          _textureBus.gain.setValueAtTime(_textureBus.gain.value, n);
          _textureBus.gain.linearRampToValueAtTime(targetTexture, n + r);
        }
        _layerGains.synth   = targetSynth;
        _layerGains.texture = targetTexture;

        console.info('[AudioEngine v4.1] Biometric → tension:',tension.toFixed(2),
          '| synth:',targetSynth.toFixed(2),'| texture:',targetTexture.toFixed(2),
          '| velvetHS:', (_velvetHS ? _velvetHS.gain.value.toFixed(1) + 'dB' : '—')
        );
      }
    }catch(e){console.warn('[applyBiometricEffect]',e);}
  };

  /* ── window.Sanctuary.AudioEngine namespace dışa aktarım ── */
  window.Sanctuary = window.Sanctuary || {};
  window.Sanctuary.AudioEngine = {
    play          : function(){ if(!_playing) window.togglePlay(); },
    pause         : function(){ if(_playing)  window.togglePlay(); },
    applyMSD      : window.applyMSD,
    switchSound   : window.switchSound,
    setVolume     : window.setMasterVolume,
    getVolume     : window.getMasterVolume,
    getFreq       : window.getFrequency,
    isPlaying     : function(){ return _playing; },
    getCurrentBand: function(){ return _curBand; },

    /* Maestro v2 DSP profili uygula */
    applyDSPProfile: applyDSPProfile,

    /* [REVİZE v4.2] GranularEngine parametrelerini runtime'da güncelle */
    applyGranular  : applyGranular,

    /* [v4.3] Texture haritasına erişim */
    resolveTexture: function(name) { return _resolveTexture(name); },
    getTextureMap : function() { return TEXTURE_MAP; },

    /* [v4.3] Resonant Peak runtime ayarı */
    setResonantPeak: function(freqHz, gainDb, q) {
      if (!_resonantPeak || !_ctx) return;
      var now = _ctx.currentTime;
      if (isFinite(freqHz)) _resonantPeak.frequency.setTargetAtTime(freqHz, now, 0.2);
      if (isFinite(gainDb)) _resonantPeak.gain.setTargetAtTime(Math.max(-6, Math.min(12, gainDb)), now, 0.2);
      if (isFinite(q))      _resonantPeak.Q.setTargetAtTime(Math.max(0.5, Math.min(10, q)), now, 0.2);
    },

    /* ── [YENİ v4.4] Hibrit Modülasyon runtime kontrolleri ── */

    /** Tape Saturator drive'ını runtime'da güncelle (0.0 = kuru, 1.0 = doygun) */
    setSaturation: function(drive) {
      _satDrive = Math.max(0, Math.min(1, drive));
      if (_saturator) {
        _saturator.curve = _buildSatCurve(_satDrive, 256);
        console.info('[AudioEngine v4.4] Saturator drive →', _satDrive);
      }
    },

    /** [6. ADIM] Maestro'dan gelen nefes pattern'ini LPF ile senkronize et.
     *  pattern: [inhale, hold, exhale] — örnek: [4, 2, 7]
     *  Nefes alırken cutoff → 3000Hz (parlaklık), verirken → 600Hz (derinlik).
     */
    updateFiltersByBreath: updateFiltersByBreath,

    /* ── [v4.7] setupSpatialReverb() — SanctuaryCore init() için alias ────
       createReverb({ dryWet: 0.25 }) kısa yolu.
       SanctuaryCore._runInitSequence() tarafından otomatik çağrılır.       */
    setupSpatialReverb: function() {
      return this.createReverb({ dryWet: 0.25, irLength: 2.4, decay: 2.2 });
    },

    /** [v4.4] Reverb wet/dry oranını runtime'da güncelle (0.0 = kuru, 0.8 = çok ıslak) */
    setReverbWetness: function(wet) {
      _reverbWetness = Math.max(0, Math.min(0.8, wet));
      if (_reverbWetGain && _ctx) {
        var now = _ctx.currentTime;
        _reverbWetGain.gain.setValueAtTime(_reverbWetGain.gain.value, now);
        _reverbWetGain.gain.linearRampToValueAtTime(_reverbWetness, now + 0.4);
        console.info('[AudioEngine v4.4] Reverb wetness →', _reverbWetness);
      }
    },

    setReverbWetness: function(wet) {
      _reverbWetness = Math.max(0, Math.min(0.8, wet));
      if (_reverbWetGain && _ctx) {
        var now = _ctx.currentTime;
        _reverbWetGain.gain.setValueAtTime(_reverbWetGain.gain.value, now);
        _reverbWetGain.gain.linearRampToValueAtTime(_reverbWetness, now + 0.4);
        console.info('[AudioEngine v4.4] Reverb wetness →', _reverbWetness);
      }
    },

    /* ── [v4.7] createReverb(options) ────────────────────────────────────
       Mevcut ConvolverNode altyapısını yapılandırır ve aktive eder.
       Zaten ensureMaster() içinde kurulu olduğundan yeni node oluşturmaz;
       dryWet oranını ayarlar ve reverb durumunu raporlar.

       options:
         dryWet   : 0.0–0.8  — varsayılan 0.25 (v4.7 standart)
         irLength : saniye   — IR buffer uzunluğu (varsayılan 2.4s)
         decay    : 0–5      — IR zayıflama sabiti (varsayılan 2.2)

       Kullanım:
         window.Sanctuary.AudioEngine.createReverb({ dryWet: 0.25 });
    ──────────────────────────────────────────────────────────────────── */
    createReverb: function(options) {
      var opts   = options || {};
      var dryWet = (typeof opts.dryWet === 'number') ? Math.max(0, Math.min(0.8, opts.dryWet)) : 0.25;

      /* IR'yi yeniden oluştur — uzunluk/decay değiştiyse */
      if (_reverbNode && _ctx) {
        var irLen   = opts.irLength || 2.4;
        var irDecay = opts.decay    || 2.2;
        _reverbNode.buffer = _buildImpulseResponse(_ctx, irLen, irDecay);
      }

      /* Wet gain'i 0.25'e set et */
      _reverbWetness = dryWet;
      if (_reverbWetGain && _ctx) {
        var now = _ctx.currentTime;
        _reverbWetGain.gain.setValueAtTime(_reverbWetGain.gain.value, now);
        _reverbWetGain.gain.linearRampToValueAtTime(_reverbWetness, now + 0.5);
      }

      console.info('[AudioEngine v4.7] createReverb: dryWet=' + dryWet +
        ' | IR=' + (opts.irLength || 2.4) + 's | decay=' + (opts.decay || 2.2));

      return { active: !!_reverbNode, dryWet: _reverbWetness };
    },

    /* ── [v4.7] loadSoulLayer(options) ───────────────────────────────────
       velvet_base_v1.mp3 dosyasını /samples/ klasöründen yükler ve
       textureBus üzerinde sürekli (loop) çalar.

       Dosya yoksa otomatik olarak prosedürel binaural fallback kullanır.
       Bu katman tüm sahnelerin altında "Ruh" (Soul) olarak yaşar.

       options:
         gain     : 0.0–1.0 — Soul katmanı seviyesi (varsayılan 0.18)
         samplesPath: string — /samples/ yolu (varsayılan '/samples/')

       Kullanım:
         window.Sanctuary.AudioEngine.loadSoulLayer({ gain: 0.18 });
    ──────────────────────────────────────────────────────────────────── */
    loadSoulLayer: function(options) {
      var opts  = options || {};
      var gain  = (typeof opts.gain === 'number') ? Math.max(0, Math.min(1, opts.gain)) : 0.18;
      var base  = opts.samplesPath || '/samples/';
      var url   = base + 'velvet_base_v1.mp3';
      var ctx   = getCtx();
      ensureMaster(ctx);

      /* Gain node — textureBus'a bağlı */
      var soulGain = ctx.createGain();
      soulGain.gain.value = 0;
      soulGain.connect(_textureBus);

      function _startSoulNode(buffer) {
        var src = ctx.createBufferSource();
        src.buffer = buffer;
        src.loop   = true;
        src.connect(soulGain);
        src.start(0);
        _sampleNodes.push(src);

        /* Fade-in: 3s */
        var now = ctx.currentTime;
        soulGain.gain.setValueAtTime(0, now);
        soulGain.gain.linearRampToValueAtTime(gain, now + 3);

        console.info('[AudioEngine v4.7] Soul Layer aktif: velvet_base_v1 | gain=' + gain);
      }

      /* Buffer cache kontrolü */
      if (_bufferCache[url]) {
        _startSoulNode(_bufferCache[url]);
        return;
      }

      /* Fetch & decode */
      fetch(url)
        .then(function(r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.arrayBuffer();
        })
        .then(function(ab) { return ctx.decodeAudioData(ab); })
        .then(function(buffer) {
          _bufferCache[url] = buffer;
          _startSoulNode(buffer);
        })
        .catch(function(err) {
          console.warn('[AudioEngine v4.7] velvet_base_v1.mp3 yüklenemedi, prosedürel fallback →', err.message);
          /* Fallback: binaural gen ile prosedürel Soul katmanı */
          _initProceduralNodes(ctx, 'binaural', gain, 2.0);
        });
    },
      _driftDepth = Math.max(0, Math.min(0.5, hz));
      /* Aktif LFO depth gain'lerini de güncelle */
      _driftLFOs.forEach(function(node) {
        if (node && node.gain) {
          node.gain.setValueAtTime(node.gain.value, _ctx ? _ctx.currentTime : 0);
          node.gain.linearRampToValueAtTime(_driftDepth, (_ctx ? _ctx.currentTime : 0) + 0.5);
        }
      });
    },

    /* ── [YENİ v4.4] YAN ÇIKTI: generateAIPrompt() ──────────────────────
       Maestro JSON → Stable Audio / Suno / Udio için metin komutu.

       Master Prompt yapısı:
         Deeply immersive cinematic [SceneName] drone,
         [BaseHz]Hz solfeggio root, lush analogue synth pads with organic pitch drift,
         heavy tape saturation for warmth, [Textures] background,
         [BinauralHz]Hz brainwave entrainment, slowly evolving harmonics,
         50 BPM, 44.1kHz high-fidelity.

       applyMSD() içinden otomatik çağrılır — console.info ile loglanır.
       İleride Stable Audio API entegrasyonunda bu prompt doğrudan gönderilebilir.
    ── */
    generateAIPrompt: function(maestro) {
      if (!maestro || typeof maestro !== 'object') return '';

      var sceneName  = maestro.sceneName  || 'Sanctuary Scene';
      var baseHz     = maestro.baseHz     || maestro.solfeggioHz || 432;
      var binauralHz = maestro.binauralHz || 6;

      /* Texture isimlerini virgüllü listeye dönüştür */
      var textureList = '';
      if (Array.isArray(maestro.textures) && maestro.textures.length > 0) {
        textureList = maestro.textures.map(function(t){ return t.name || ''; })
          .filter(Boolean).join(', ');
      } else if (maestro.texture) {
        textureList = String(maestro.texture);
      } else {
        textureList = 'nature ambient';
      }

      /* EEG band bilgisi */
      var bandLabel = _curBand || (
        binauralHz < 4  ? 'delta deep sleep' :
        binauralHz < 8  ? 'theta meditation' :
        binauralHz < 14 ? 'alpha relaxation' : 'low beta focus'
      );

      /* Mood tespiti — sahne adından */
      var nameLower = sceneName.toLowerCase();
      var moodDesc  = nameLower.includes('slumber') || nameLower.includes('sleep') || nameLower.includes('uyku')
        ? 'deep sleep'
        : nameLower.includes('focus') || nameLower.includes('odak')
        ? 'focus'
        : 'meditation';

      var prompt = [
        'Deeply immersive cinematic ' + moodDesc + ' drone,',
        baseHz + 'Hz solfeggio root frequency,',
        'lush analogue synth pads with organic pitch drift,',
        'heavy tape saturation for warmth,',
        textureList + ' background layers,',
        binauralHz + 'Hz brainwave entrainment (' + bandLabel + '),',
        'slowly evolving harmonics, 50 BPM sync,',
        'expansive spatial reverb, no percussion, no sharp transients,',
        '44.1kHz high-fidelity, earthy and grounding textures.',
        '// Scene: ' + sceneName,
      ].join(' ');

      console.info('[AudioEngine v4.4] AI Prompt üretildi:\n', prompt);
      return prompt;
    },

    getProceduralStatus: function() {
      return {
        fm     : Object.keys(_proceduralFM).reduce(function(acc, key) {
          var fm = _proceduralFM[key];
          acc[key] = fm ? { active: fm._active, carrierFreq: fm.params.carrierFreq } : null;
          return acc;
        }, {}),
        granular: Object.keys(_proceduralGrain).reduce(function(acc, key) {
          var gr = _proceduralGrain[key];
          acc[key] = gr ? { active: gr._active, grainSize: gr.params.grainSize, grainRate: gr.params.grainRate } : null;
          return acc;
        }, {}),
      };
    },

    initProceduralNodes: function(textureName, gainVal) {
      var ctx = getCtx();
      ensureMaster(ctx);
      _initProceduralNodes(ctx, textureName || _curGen || 'rain', gainVal || 0.5, 1.5);
    },

    updateLayerGains: function(synth, texture) {
      if (!_ctx) return;
      var s = Math.max(0, Math.min(1, synth));
      var t = Math.max(0, Math.min(1, texture));
      var now = _ctx.currentTime;
      if (_synthBus)   { _synthBus.gain.setValueAtTime(_synthBus.gain.value, now);   _synthBus.gain.linearRampToValueAtTime(s, now + 0.05); }
      if (_textureBus) { _textureBus.gain.setValueAtTime(_textureBus.gain.value, now); _textureBus.gain.linearRampToValueAtTime(t, now + 0.05); }
      _layerGains.synth   = s;
      _layerGains.texture = t;
    },

    setVelvetHighShelf: function(gainDb) {
      if (!_velvetHS || !_ctx) return;
      var safe = Math.max(-12, Math.min(0, gainDb));
      var now  = _ctx.currentTime;
      _velvetHS.gain.setValueAtTime(_velvetHS.gain.value, now);
      _velvetHS.gain.linearRampToValueAtTime(safe, now + 0.3);
      console.info('[AudioEngine v4.4] VelvetHS gain →', safe, 'dB');
    },

    getDSPStatus: function() {
      return {
        velvetHS_gain       : _velvetHS        ? _velvetHS.gain.value            : null,
        limiter_thresh      : _limiter         ? _limiter.threshold.value        : null,
        comp_thresh         : _comp            ? _comp.threshold.value           : null,
        eqLow_gain          : _eqLow           ? _eqLow.gain.value               : null,
        eqMid_gain          : _eqMid           ? _eqMid.gain.value               : null,
        eqHigh_gain         : _eqHigh          ? _eqHigh.gain.value              : null,
        breathLP_freq       : _breathLP        ? _breathLP.frequency.value       : null,
        master_gain         : _master          ? _master.gain.value              : null,
        /* [YENİ v4.4] */
        saturator_drive     : _satDrive,
        reverb_wetness      : _reverbWetness,
        drift_depth_hz      : _driftDepth,
        drift_lfo_count     : _driftLFOs.length,
        currentBand         : _curBand,
        isPlaying           : _playing,
        proceduralFM_count  : Object.keys(_proceduralFM).length,
        proceduralGrain_count: Object.keys(_proceduralGrain).length,
      };
    },
  };

  /* RoomManager wrapper */
  var _orig = window.switchSound;
  window.switchSound = function(gen,base,beat,label,maestro){
    window._lastGen=gen; window._lastBase=base; window._lastBeat=beat||0;
    if(_orig)_orig(gen,base,beat,label,maestro);
    if(window.RoomManager&&window.RoomManager.getRole&&window.RoomManager.getRole()==='host'){
      try{window.RoomManager.broadcastAudioState();}catch(e){}
    }
  };
  window.Sanctuary.AudioEngine.switchSound = window.switchSound;

  window._audioToggle      = window.togglePlay;
  window._audioSwitchSound = window.switchSound;
  window._audioSleepTimer  = window.setSleepTimer;

  console.info(
    '[AudioEngine v4.7 — AI Sanatçı Motoru] Hazır.',
    '\n  [A] Saturator  : WaveShaperNode drive=0.18 | oversample=2x',
    '\n  [B] Pitch Drift: LFO 0.030Hz + 0.047Hz | ±0.08Hz',
    '\n  [C] Reverb     : ConvolverNode 2.4s IR | wet=0.25 | createReverb() API',
    '\n  [D] AI Prompt  : generateAIPrompt() → Stable Audio uyumlu',
    '\n  [E] BioSync    : updateFiltersByBreath([4,2,7]) | setTargetAtTime τ=0.15',
    '\n  [F] Soul Layer : velvet_base_v1 | loadSoulLayer() | prosedürel fallback',
    '\n  v4.3 korundu   : TEXTURE_MAP 40+, Phi A/B/C, Tremolo AM, ResonantPeak, EEG Guard'
  );
})();