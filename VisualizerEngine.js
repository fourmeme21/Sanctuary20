/* ══════════════════════════════════════════════════════════════
   VisualizerEngine.js — Sanctuary v4.7 — AI Sanatçı Motoru
   AnalyserNode → Canvas görselleştirme
   + startBreathing(pattern): #breath-bubble biyometrik animasyon
   ══════════════════════════════════════════════════════════════ */
(function() {
  'use strict';

  var _canvas    = null;
  var _ctx       = null;
  var _analyser  = null;
  var _dataArray = null;
  var _rafId     = null;
  var _active    = false;
  var _mood      = 'default';

  var MOOD_COLORS = {
    'default'   : { primary: '#4ecdc4', secondary: '#c9a96e', bg: 'rgba(7,7,26,0)' },
    'huzursuz'  : { primary: '#ff6b6b', secondary: '#c9a96e', bg: 'rgba(7,7,26,0)' },
    'yorgun'    : { primary: '#6c63ff', secondary: '#9896b8', bg: 'rgba(7,7,26,0)' },
    'mutlu'     : { primary: '#ffd93d', secondary: '#c9a96e', bg: 'rgba(7,7,26,0)' },
    'odaklan'   : { primary: '#4ecdc4', secondary: '#6c63ff', bg: 'rgba(7,7,26,0)' },
    'uyu'       : { primary: '#9896b8', secondary: '#4ecdc4', bg: 'rgba(7,7,26,0)' },
    /* [v4.7] Reverb aktifken kullanılan akışkan/uzamsal mod */
    'ethereal'  : { primary: '#a0c4ff', secondary: '#bdb2ff', bg: 'rgba(4,4,20,0)' },
  };

  function init(canvasId, analyserNode) {
    _canvas   = document.getElementById(canvasId);
    if (!_canvas) return;
    _ctx      = _canvas.getContext('2d');
    _analyser = analyserNode;
    if (_analyser) {
      _analyser.fftSize = 256;
      _dataArray = new Uint8Array(_analyser.frequencyBinCount);
    }
    _resize();
    window.addEventListener('resize', _resize);
    console.info('[VisualizerEngine] Başlatıldı');
  }

  function _resize() {
    if (!_canvas) return;
    _canvas.width  = _canvas.offsetWidth  * (window.devicePixelRatio || 1);
    _canvas.height = _canvas.offsetHeight * (window.devicePixelRatio || 1);
    _ctx.scale(window.devicePixelRatio || 1, window.devicePixelRatio || 1);
  }

  function start() {
    if (_active) return;
    _active = true;
    _draw();
  }

  function stop() {
    _active = false;
    if (_rafId) { cancelAnimationFrame(_rafId); _rafId = null; }
    if (_ctx && _canvas) _ctx.clearRect(0, 0, _canvas.offsetWidth, _canvas.offsetHeight);
  }

  function setMood(mood) {
    _mood = (mood || 'default').toLowerCase();
  }

  /* [v4.7] Ethereal mod için yumuşatılmış avg — hızlı geçişleri bastırır */
  var _avgSmooth  = 0.3;
  var _frameCount = 0;   /* RAF sayacı — ethereal frame-skip için */

  function _draw() {
    if (!_active || !_canvas || !_ctx) return;
    _rafId = requestAnimationFrame(_draw);
    _frameCount++;

    var W = _canvas.offsetWidth;
    var H = _canvas.offsetHeight;
    var cx = W / 2, cy = H / 2;
    var colors = MOOD_COLORS[_mood] || MOOD_COLORS['default'];
    var isEthereal = (_mood === 'ethereal');

    /* [v4.7] Ethereal: her 5 kareden 3'ünü atla → ~%40 yavaşlama (60fps → 36fps)
       Parçacıklar daha ağır, daha akışkan hareket eder.                      */
    if (isEthereal && (_frameCount % 5 < 2)) return;

    /* [v4.7] Ethereal: canvas blur filtresi — uzamsal derinlikle eşleşen sis */
    _ctx.filter = isEthereal ? 'blur(0.8px)' : 'none';

    _ctx.clearRect(0, 0, W, H);

    /* Frekans verisi */
    var avg = 0.3;
    if (_analyser && _dataArray) {
      _analyser.getByteFrequencyData(_dataArray);
      var sum = 0;
      for (var i = 0; i < _dataArray.length; i++) sum += _dataArray[i];
      avg = sum / (_dataArray.length * 255);
    } else {
      /* Ethereal modda çok daha yavaş sinüs — akışkan, yüzen his */
      var breathRate = isEthereal ? 5000 : 2000;
      avg = 0.25 + Math.sin(Date.now() / breathRate) * (isEthereal ? 0.06 : 0.1);
    }

    /* [v4.7] Ethereal: avg'yi lerp ile yumuşat → ani geçişler yok */
    if (isEthereal) {
      var lerpFactor = 0.015; /* Çok yavaş takip — 'akışkan' hissiyat */
      _avgSmooth += (avg - _avgSmooth) * lerpFactor;
      avg = _avgSmooth;
    } else {
      _avgSmooth = avg;
    }

    /* Nefes alan halkalar */
    /* [v4.7] Ethereal: daha fazla halka, daha geniş, daha şeffaf */
    var rings = isEthereal ? 6 : 4;
    for (var r = 0; r < rings; r++) {
      var progress = r / rings;
      /* Ethereal: halkalar %30 daha geniş, daha yavaş büyür */
      var radiusScale = isEthereal ? 0.95 : 0.7;
      var avgScale    = isEthereal ? 28   : 40;
      var radius   = 30 + progress * Math.min(cx, cy) * radiusScale + avg * avgScale;
      /* Ethereal: daha düşük alpha — transparan, bulanık katmanlar */
      var alphaBase = isEthereal ? 0.22 : 0.35;
      var alpha    = (1 - progress) * alphaBase * (0.6 + avg * 0.8);
      var color    = r % 2 === 0 ? colors.primary : colors.secondary;

      _ctx.beginPath();
      _ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      _ctx.strokeStyle = color + Math.round(alpha * 255).toString(16).padStart(2,'0');
      /* Ethereal: çizgi kalınlığı daha ince — neredeyse görünmez */
      _ctx.lineWidth   = isEthereal ? (0.8 - progress * 0.5) : (1.2 - progress * 0.6);
      _ctx.stroke();
    }

    /* Merkez nokta */
    /* Ethereal: merkez noktası daha büyük ama daha şeffaf — diffuse glow */
    var dotMultiplier = isEthereal ? 14 : 8;
    var dotR = 4 + avg * dotMultiplier;
    var gradRadius = isEthereal ? dotR * 3 : dotR * 2;
    var grad = _ctx.createRadialGradient(cx, cy, 0, cx, cy, gradRadius);
    var coreAlpha = isEthereal ? '88' : 'cc';
    grad.addColorStop(0, colors.primary + coreAlpha);
    grad.addColorStop(isEthereal ? 0.5 : 1, colors.primary + '00');
    if (isEthereal) grad.addColorStop(1, colors.secondary + '00');
    _ctx.beginPath();
    _ctx.arc(cx, cy, dotR, 0, Math.PI * 2);
    _ctx.fillStyle = grad;
    _ctx.fill();
  }

  /* ══════════════════════════════════════════════════════════════════════
     [6. ADIM] NEFES BALONU ANİMASYONU — startBreathing(pattern)
     ─────────────────────────────────────────────────────────────────────
     Maestro'dan gelen [4, 2, 7] pattern'ine göre #breath-bubble
     elementine CSS scale animasyonu uygular.

     Nefes alırken (4s)  : scale → 1.35, mavi-beyaz parlaklık (ses parlar)
     Nefes tutarken (2s) : scale sabit, hafif puls
     Nefes verirken (7s) : scale → 0.88, lacivert derinleşme (ses derinleşir)

     AudioEngine.updateFiltersByBreath() ile otomatik senkronize:
       LPF cutoff: 3000Hz (inhale) ↔ 600Hz (exhale)
  ══════════════════════════════════════════════════════════════════════ */
  var _breathTimer   = null;
  var _breathPattern = [4, 2, 7];
  var _breathRunning = false;
  var _breathPhase   = 'idle';
  var _breathCycle   = 0;

  var BREATH_SCALE = { inhale: 1.35, hold: 1.35, exhale: 0.88, idle: 1.0 };

  var BREATH_STYLE = {
    inhale : {
      bg  : 'rgba(100,180,255,0.85)',
      glow: '0 0 40px 16px rgba(100,180,255,0.50), 0 0 80px 32px rgba(80,160,255,0.25)',
      ease: 'cubic-bezier(0.25,0.46,0.45,0.94)',
    },
    hold : {
      bg  : 'rgba(130,195,255,0.80)',
      glow: '0 0 36px 14px rgba(120,190,255,0.45)',
      ease: 'ease',
    },
    exhale : {
      bg  : 'rgba(40,80,180,0.70)',
      glow: '0 0 24px 8px rgba(40,80,200,0.35), 0 0 50px 20px rgba(30,60,180,0.15)',
      ease: 'cubic-bezier(0.55,0.06,0.68,0.19)',
    },
    idle : {
      bg  : 'rgba(60,100,200,0.65)',
      glow: '0 0 20px 8px rgba(60,100,200,0.30)',
      ease: 'ease',
    },
  };

  function _applyBubblePhase(phase, durationS) {
    var el = document.getElementById('breath-bubble');
    if (!el) return;

    var s   = BREATH_STYLE[phase] || BREATH_STYLE.idle;

    /* CSS değişkenlerinden süre oku — varsa JS argümanını geçersiz kılar.
       Tanımlı değilse durationS fallback'e düşer.
       CSS: --inhale-duration: 4s; --hold-duration: 2s; --exhale-duration: 7s; */
    var cssVarMap = { inhale: '--inhale-duration', hold: '--hold-duration', exhale: '--exhale-duration', idle: null };
    var cssVarName = cssVarMap[phase];
    var dur = durationS;
    if (cssVarName) {
      var cssVal = getComputedStyle(document.documentElement).getPropertyValue(cssVarName).trim();
      if (cssVal) {
        var parsed = parseFloat(cssVal);
        if (!isNaN(parsed)) dur = parsed;
      }
    }
    dur = Math.max(0.2, dur);

    el.style.transition = [
      'transform '        + dur         + 's ' + s.ease,
      'box-shadow '       + dur         + 's ' + s.ease,
      'background-color ' + (dur * 0.6) + 's ease',
    ].join(', ');
    el.style.transform       = 'scale(' + (BREATH_SCALE[phase] || 1.0) + ')';
    el.style.boxShadow       = s.glow;
    el.style.backgroundColor = s.bg;
    el.setAttribute('data-breath-phase', phase);

    /* CSS değişkenleri — HUD ve dış stiller okuyabilir */
    document.documentElement.style.setProperty('--breath-phase', phase);
    document.documentElement.style.setProperty('--breath-scale', String(BREATH_SCALE[phase] || 1.0));

    /* #breath-label varsa güncelle */
    var lbl = document.getElementById('breath-label');
    if (lbl) {
      lbl.textContent = { inhale:'Nefes Al', hold:'Tut', exhale:'Bırak', idle:'' }[phase] || '';
      lbl.setAttribute('data-phase', phase);
    }
  }

  function _breathStep() {
    if (!_breathRunning) return;

    var inhale = _breathPattern[0];
    var hold   = _breathPattern[1];
    var exhale = _breathPattern[2];

    /* INHALE */
    _breathPhase = 'inhale';
    _applyBubblePhase('inhale', inhale);

    /* HOLD */
    _breathTimer = setTimeout(function() {
      if (!_breathRunning) return;
      _breathPhase = 'hold';
      _applyBubblePhase('hold', hold || 0.3);

      /* EXHALE */
      _breathTimer = setTimeout(function() {
        if (!_breathRunning) return;
        _breathPhase = 'exhale';
        _applyBubblePhase('exhale', exhale);

        /* Sonraki döngü */
        _breathTimer = setTimeout(function() {
          if (!_breathRunning) return;
          _breathCycle++;
          _breathStep();
        }, exhale * 1000 - 50);

      }, hold * 1000);
    }, inhale * 1000 - 50);
  }

  /**
   * startBreathing(pattern)
   * @param {number[]} pattern  [inhale, hold, exhale] — Maestro: [4, 2, 7]
   *
   * Örnek:
   *   window.VisualizerEngine.startBreathing([4, 2, 7]);
   */
  function startBreathing(pattern) {
    if (Array.isArray(pattern) && pattern.length >= 3) {
      _breathPattern = [
        Math.max(1, Number(pattern[0]) || 4),
        Math.max(0, Number(pattern[1]) || 2),
        Math.max(1, Number(pattern[2]) || 7),
      ];
    } else {
      _breathPattern = [4, 2, 7];
    }

    /* Zaten çalışıyorsa sadece pattern güncelle */
    if (_breathRunning) {
      console.info('[VisualizerEngine] Pattern güncellendi →', _breathPattern);
      return;
    }

    _breathRunning = true;
    _breathCycle   = 0;

    /* AudioEngine LPF senkronu — varsa otomatik bağla */
    try {
      var ae = window.Sanctuary && window.Sanctuary.AudioEngine;
      if (ae && typeof ae.updateFiltersByBreath === 'function') {
        ae.updateFiltersByBreath(_breathPattern);
      }
      console.warn('[VisualizerEngine] AudioEngine senkron hatası:', e); }

    _applyBubblePhase('idle', 0.3);
    setTimeout(_breathStep, 150);
  }

  /** stopBreathing() — Animasyonu durdurur */
  function stopBreathing() {
    _breathRunning = false;
    _breathPhase   = 'idle';
    if (_breathTimer) { clearTimeout(_breathTimer); _breathTimer = null; }
    _applyBubblePhase('idle', 0.8);
  }

  /** getBreathState() — SanctuaryCore HUD için anlık durum */
  function getBreathState() {
    return {
      phase   : _breathPhase,
      cycle   : _breathCycle,
      pattern : _breathPattern.slice(),
      running : _breathRunning,
      scale   : BREATH_SCALE[_breathPhase] || 1.0,
    };
  }

  window.VisualizerEngine = {
    init           : init,
    start          : start,
    stop           : stop,
    setMood        : setMood,
    startBreathing : startBreathing,
    stopBreathing  : stopBreathing,
    getBreathState : getBreathState,
  };

  console.info('[VisualizerEngine v4.7 — AI Sanatçı Motoru] Canvas + BiyoSync + Ethereal hazır');
})();
