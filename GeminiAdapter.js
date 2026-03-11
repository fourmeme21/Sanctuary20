/**
 * GeminiAdapter.js — Sanctuary AI Oracle v3 "Hibrit Maestro"
 * ─────────────────────────────────────────────────────────────────────────────
 * Netlify Function proxy üzerinden MAESTRO JSON döndürür.
 * Tek geçerli protokol: { baseHz, binauralHz, textures:[{name,gain}], breath:[i,h,e], sceneName }
 * Doğrulama başarılıysa objeye `velvetReady: true` bayrağı eklenir.
 * ─────────────────────────────────────────────────────────────────────────────
 */

(function (global) {
  'use strict';

  var PROXY_URL  = '/.netlify/functions/gemini';
  var TIMEOUT_MS = 10000;

  /* ══════════════════════════════════════════════════════════════════════════
     FUZZY MATCH MAP
     textures[].name içindeki serbest metin ifadelerini
     /samples/ klasöründeki gerçek dosya adlarıyla eşleştirir.
     Her anahtar kelime grubu aynı fiziksel dosyaya yönlendirilir.
  ══════════════════════════════════════════════════════════════════════════ */
  var TEXTURE_MAP = {
    /* ── Su / Okyanus ── */
    ocean      : 'ocean.mp3',
    sea        : 'ocean.mp3',
    wave       : 'ocean.mp3',
    waves      : 'ocean.mp3',
    shore      : 'ocean.mp3',
    water      : 'ocean.mp3',
    surf       : 'ocean.mp3',
    beach      : 'ocean.mp3',
    deniz      : 'ocean.mp3',
    okyanus    : 'ocean.mp3',
    dalga      : 'ocean.mp3',

    /* ── Yağmur ── */
    rain       : 'rain.mp3',
    drizzle    : 'rain.mp3',
    shower     : 'rain.mp3',
    rainfall   : 'rain.mp3',
    yağmur     : 'rain.mp3',
    yağış      : 'rain.mp3',

    /* ── Orman / Doğa ── */
    forest     : 'forest.mp3',
    woods      : 'forest.mp3',
    jungle     : 'forest.mp3',
    nature     : 'forest.mp3',
    trees      : 'forest.mp3',
    orman      : 'forest.mp3',
    doğa       : 'forest.mp3',
    ağaç       : 'forest.mp3',

    /* ── Rüzgar ── */
    wind       : 'wind.mp3',
    breeze     : 'wind.mp3',
    rüzgar     : 'wind.mp3',
    esinti     : 'wind.mp3',

    /* ── Ateş / Kıvılcım ── */
    fire       : 'fire.mp3',
    flame      : 'fire.mp3',
    crackling  : 'fire.mp3',
    fireplace  : 'fire.mp3',
    campfire   : 'fire.mp3',
    ateş       : 'fire.mp3',
    şömine     : 'fire.mp3',

    /* ── Zen / Meditasyon ── */
    zen        : 'zen-bowl.mp3',
    bowl       : 'zen-bowl.mp3',
    'singing bowl': 'zen-bowl.mp3',
    bell       : 'zen-bowl.mp3',
    gong       : 'zen-bowl.mp3',
    tibetan    : 'zen-bowl.mp3',
    meditasyon : 'zen-bowl.mp3',
    kase       : 'zen-bowl.mp3',

    /* ── Fısıltı / ASMR ── */
    whisper    : 'whisper.mp3',
    asmr       : 'whisper.mp3',
    fısıltı    : 'whisper.mp3',
    fısıldama  : 'whisper.mp3',

    /* ── Nehir / Dere ── */
    river      : 'river.mp3',
    stream     : 'river.mp3',
    creek      : 'river.mp3',
    brook      : 'river.mp3',
    nehir      : 'river.mp3',
    dere       : 'river.mp3',

    /* ── Gece / Çekirge ── */
    night      : 'night.mp3',
    cricket    : 'night.mp3',
    crickets   : 'night.mp3',
    cicada     : 'night.mp3',
    gece       : 'night.mp3',
    çekirge    : 'night.mp3',

    /* ── Beyaz / Pembe Gürültü ── */
    'white noise' : 'white-noise.mp3',
    'pink noise'  : 'pink-noise.mp3',
    noise         : 'white-noise.mp3',
    static        : 'white-noise.mp3',
    gürültü       : 'white-noise.mp3',

    /* ── Enstrüman → en yakın doğa sesine köprü ──
     * Gemini bazen prompt kısıtına rağmen enstrüman ismi üretebilir.
     * Bu map, o hallüsinasyonları sessizce gerçek dosyalara yönlendirir. */
    piano      : 'zen-bowl.mp3',
    guitar     : 'river.mp3',
    flute      : 'wind.mp3',
    harp       : 'river.mp3',
    violin     : 'zen-bowl.mp3',
    cello      : 'zen-bowl.mp3',
    drums      : 'fire.mp3',
    synth      : 'white-noise.mp3',

    /* ── Kuş / Hayvan ── */
    birds      : 'forest.mp3',
    bird       : 'forest.mp3',
    kuşlar     : 'forest.mp3',
    crickets   : 'night.mp3',

    /* ── Binaural (özel tip — AudioEngine'e yönlendirilir) ── */
    binaural   : '__binaural__',
    beat       : '__binaural__',
    theta      : '__binaural__',
    delta      : '__binaural__',
    alpha      : '__binaural__',
    gamma      : '__binaural__',
  };

  /**
   * Serbest metin → /samples/ dosya adı çözücü.
   * Küçük harf + boşluk normalize edilir; kısmi eşleşme denenir.
   * @param  {string} name — textures[].name değeri
   * @returns {string}     — dosya adı veya 'ambient.mp3' (varsayılan)
   */
  function resolveTexture(name) {
    if (!name || typeof name !== 'string') return 'ambient.mp3';
    var key = name.toLowerCase().trim();

    /* 1. Tam eşleşme */
    if (TEXTURE_MAP[key]) return TEXTURE_MAP[key];

    /* 2. Kısmi eşleşme — TEXTURE_MAP anahtarlarından biri `key` içinde geçiyor mu? */
    var keys = Object.keys(TEXTURE_MAP);
    for (var i = 0; i < keys.length; i++) {
      if (key.indexOf(keys[i]) !== -1 || keys[i].indexOf(key) !== -1) {
        return TEXTURE_MAP[keys[i]];
      }
    }

    /* 3. Eşleşme yoksa generic ambient */
    console.warn('[GeminiAdapter] FuzzyMatch eşleşme bulunamadı → ambient.mp3:', name);
    return 'ambient.mp3';
  }

  /* ══════════════════════════════════════════════════════════════════════════
     MAESTRO JSON DOĞRULAMA
     Yalnızca Maestro protokolü geçerlidir.
     Eski MSD alanları (frequencySuggestion, tempo, layers) reddedilir.
  ══════════════════════════════════════════════════════════════════════════ */
  function validateMaestro(obj) {
    if (!obj || typeof obj !== 'object')              return false;

    /* Zorunlu: baseHz */
    if (typeof obj.baseHz !== 'number' || obj.baseHz < 20 || obj.baseHz > 20000)
      return false;

    /* Zorunlu: binauralHz */
    if (typeof obj.binauralHz !== 'number' || obj.binauralHz < 0 || obj.binauralHz > 100)
      return false;

    /* Zorunlu: textures (en az 1 öğe) */
    if (!Array.isArray(obj.textures) || obj.textures.length < 1)
      return false;

    for (var i = 0; i < obj.textures.length; i++) {
      var t = obj.textures[i];
      if (!t || typeof t.name !== 'string')            return false;
      if (typeof t.gain !== 'number' || t.gain < 0 || t.gain > 1) return false;
    }

    /* Zorunlu: breath [inhale, hold, exhale] */
    if (!Array.isArray(obj.breath) || obj.breath.length < 3) return false;
    for (var j = 0; j < 3; j++) {
      if (typeof obj.breath[j] !== 'number' || obj.breath[j] < 0) return false;
    }

    return true;
  }

  /**
   * Ham API yanıtını Maestro formatına dönüştürmeye çalışır.
   * Eski MSD formatı gelirse otomatik köprüler.
   * @param {object} raw — API'den gelen ham JSON
   * @returns {object|null}
   */
  function normalizeMaestro(raw) {
    if (!raw || typeof raw !== 'object') return null;

    /* Zaten Maestro formatındaysa doğrudan döndür */
    if (validateMaestro(raw)) return raw;

    /* Eski MSD formatı köprüsü (frequencySuggestion tabanlı) */
    if (typeof raw.frequencySuggestion === 'number' && Array.isArray(raw.layers)) {
      console.warn('[GeminiAdapter] Eski MSD formatı algılandı — Maestro\'ya köprüleniyor.');
      var bp = raw.breathPattern || {};
      return {
        sceneName  : raw.sceneName    || 'Sanctuary',
        baseHz     : raw.frequencySuggestion,
        binauralHz : 7,
        textures   : raw.layers.map(function (l) {
          return { name: l.type || 'ambient', gain: typeof l.volume === 'number' ? l.volume : 0.5 };
        }),
        breath     : [
          bp.inhale || 4,
          bp.hold   || 2,
          bp.exhale || 6,
        ],
      };
    }

    return null;
  }

  /* ══════════════════════════════════════════════════════════════════════════
     FALLBACK TABLOSU — Maestro formatında
  ══════════════════════════════════════════════════════════════════════════ */
  var FALLBACK_TABLE = {
    /* İngilizce */
    'Anxious' : { sceneName:'Calm Breath',     baseHz:396, binauralHz:6,  textures:[{name:'ocean',gain:0.55},{name:'binaural',gain:0.25}], breath:[4,4,8]  },
    'Stressed': { sceneName:'Deep Peace',      baseHz:432, binauralHz:5,  textures:[{name:'rain', gain:0.60},{name:'binaural',gain:0.20}], breath:[4,2,6]  },
    'Tired'   : { sceneName:'Energy Renewal',  baseHz:528, binauralHz:10, textures:[{name:'forest',gain:0.50},{name:'zen',gain:0.30}],    breath:[5,2,5]  },
    'Sad'     : { sceneName:'Light Breath',    baseHz:417, binauralHz:5,  textures:[{name:'rain', gain:0.60},{name:'binaural',gain:0.30}], breath:[4,2,7]  },
    'Calm'    : { sceneName:'Focus Flow',      baseHz:40,  binauralHz:40, textures:[{name:'zen',  gain:0.45},{name:'binaural',gain:0.35}], breath:[4,4,4]  },
    'Grateful': { sceneName:'Heart Resonance', baseHz:528, binauralHz:10, textures:[{name:'ocean',gain:0.55},{name:'binaural',gain:0.30}], breath:[5,3,6]  },
    /* Türkçe */
    'Huzursuz': { sceneName:'Sakin Nefes',     baseHz:396, binauralHz:6,  textures:[{name:'ocean',gain:0.55},{name:'binaural',gain:0.25}], breath:[4,4,8]  },
    'Kaygılı' : { sceneName:'Derin Huzur',     baseHz:432, binauralHz:5,  textures:[{name:'rain', gain:0.60},{name:'binaural',gain:0.20}], breath:[4,2,6]  },
    'Yorgun'  : { sceneName:'Enerji Yenileme', baseHz:528, binauralHz:10, textures:[{name:'forest',gain:0.50},{name:'zen',gain:0.30}],    breath:[5,2,5]  },
    'Mutsuz'  : { sceneName:'Işık Nefesi',     baseHz:417, binauralHz:5,  textures:[{name:'rain', gain:0.60},{name:'binaural',gain:0.30}], breath:[4,2,7]  },
    'Sakin'   : { sceneName:'Odak Akışı',      baseHz:40,  binauralHz:40, textures:[{name:'zen',  gain:0.45},{name:'binaural',gain:0.35}], breath:[4,4,4]  },
    'Minnettar':{ sceneName:'Kalp Rezonansı',  baseHz:528, binauralHz:10, textures:[{name:'ocean',gain:0.55},{name:'binaural',gain:0.30}], breath:[5,3,6]  },
    /* Arapça */
    'قلق'    : { sceneName:'تنفس هادئ',    baseHz:396, binauralHz:6,  textures:[{name:'ocean',gain:0.55},{name:'binaural',gain:0.25}], breath:[4,4,8] },
    'مجهد'   : { sceneName:'سلام عميق',    baseHz:432, binauralHz:5,  textures:[{name:'rain', gain:0.60},{name:'binaural',gain:0.20}], breath:[4,2,6] },
    'متعب'   : { sceneName:'تجديد الطاقة', baseHz:528, binauralHz:10, textures:[{name:'forest',gain:0.50},{name:'zen',gain:0.30}],   breath:[5,2,5] },
    'حزين'   : { sceneName:'نفس النور',    baseHz:417, binauralHz:5,  textures:[{name:'rain', gain:0.60},{name:'binaural',gain:0.30}], breath:[4,2,7] },
    'هادئ'   : { sceneName:'تدفق التركيز', baseHz:40,  binauralHz:40, textures:[{name:'zen',  gain:0.45},{name:'binaural',gain:0.35}], breath:[4,4,4] },
    'ممتنّ'  : { sceneName:'رنين القلب',   baseHz:528, binauralHz:10, textures:[{name:'ocean',gain:0.55},{name:'binaural',gain:0.30}], breath:[5,3,6] },
  };

  var DEFAULT_MAESTRO = {
    sceneName  : 'Deep Calm',
    baseHz     : 432,
    binauralHz : 7,
    textures   : [{ name: 'ocean', gain: 0.60 }, { name: 'binaural', gain: 0.25 }],
    breath     : [4, 4, 8],
  };

  function getFallback(mood) {
    return FALLBACK_TABLE[mood] || DEFAULT_MAESTRO;
  }

  /**
   * Maestro objesini işle:
   * 1. textures[].name → gerçek dosya adına çözümle
   * 2. velvetReady: true bayrağını ekle
   */
  function enrichMaestro(maestro) {
    maestro.textures = maestro.textures.map(function (t) {
      return {
        name     : t.name,
        file     : resolveTexture(t.name),   /* /samples/xxx.mp3 */
        gain     : t.gain,
        isBinaural: resolveTexture(t.name) === '__binaural__',
      };
    });
    maestro.velvetReady = true;
    return maestro;
  }

  /* ══════════════════════════════════════════════════════════════════════════
     ANA SINIF
  ══════════════════════════════════════════════════════════════════════════ */
  function GeminiAdapter(config) {
    config = config || {};
    this._proxyUrl = config.proxyUrl || PROXY_URL;
    this._timeout  = config.timeout  || TIMEOUT_MS;
  }

  /**
   * Kullanıcı girdisine göre Maestro JSON üretir.
   * @param {string} userInput    — Kullanıcının yazdığı metin
   * @param {string} selectedMood — Seçilen ruh hali
   * @returns {Promise<MaestroJSON>}
   */
  GeminiAdapter.prototype.generateScene = function (userInput, selectedMood) {
    var self = this;

    return new Promise(function (resolve) {
      var controller = new AbortController();

      var timeoutId = setTimeout(function () {
        controller.abort();
        console.warn('[GeminiAdapter] Timeout — fallback devreye giriyor.');
        resolve(enrichMaestro(getFallback(selectedMood)));
      }, self._timeout);

      fetch(self._proxyUrl, {
        method : 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal : controller.signal,
        body   : JSON.stringify({ mood: selectedMood, input: userInput || '' }),
      })
        .then(function (res) {
          clearTimeout(timeoutId);
          if (!res.ok) throw new Error('HTTP ' + res.status);
          return res.json();
        })
        .then(function (raw) {
          console.log('[GeminiAdapter] Ham yanıt:', JSON.stringify(raw).substring(0, 200));

          /* Normalize et (eski format köprüsü dahil) */
          var maestro = normalizeMaestro(raw);

          if (!maestro) {
            console.warn('[GeminiAdapter] Maestro şeması doğrulanamadı — fallback. Gelen:', JSON.stringify(raw).substring(0, 150));
            return resolve(enrichMaestro(getFallback(selectedMood)));
          }

          /* Doku adlarını çöz + velvetReady bayrağı ekle */
          enrichMaestro(maestro);

          console.log('[GeminiAdapter] ✅ Maestro hazır:', maestro.sceneName,
            maestro.baseHz + 'Hz base /', maestro.binauralHz + 'Hz binaural',
            '| velvetReady:', maestro.velvetReady);

          resolve(maestro);
        })
        .catch(function (err) {
          clearTimeout(timeoutId);
          if (err.name === 'AbortError') return; /* timeout zaten handle edildi */
          console.error('[GeminiAdapter] Fetch hatası:', err.message);
          resolve(enrichMaestro(getFallback(selectedMood)));
        });
    });
  };

  /* ── Yardımcılar (test/debug için erişilebilir) ─────────────────────────── */
  GeminiAdapter.resolveTexture  = resolveTexture;
  GeminiAdapter.validateMaestro = validateMaestro;
  GeminiAdapter.TEXTURE_MAP     = TEXTURE_MAP;

  /* ── Global kayıt ────────────────────────────────────────────────────────── */
  global.GeminiAdapter = GeminiAdapter;

})(typeof window !== 'undefined' ? window : global);
