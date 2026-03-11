/**
 * FrequencyManager.js — Sanctuary Harmonik Frekans Yönetimi v3
 * ─────────────────────────────────────────────────────────────────────────────
 * v3 Değişiklikleri (AudioEngine v4.3 entegrasyonu):
 *
 *   1. getPhiLayerSet(baseHz, count):
 *      AudioEngine v4.3 Katman A/B/C yapısıyla birebir uyumlu Phi harmonik seti.
 *      { layerA: [left,right], layerB: [phi1,phi2], layerC: [phi3,phi4] }
 *      gainMap ile her katmanın önerilen gain değeri de döner.
 *
 *   2. getTremoloParams(baseHz, beatHz):
 *      Tremolo (AM) katmanı için hazır parametre nesnesi.
 *      { carrierHz, lfoHz, depth, gain } — AudioEngine startTremoloLayer() ile uyumlu.
 *
 *   3. getResonantFreqForTexture(textureName):
 *      TEXTURE_MAP'teki resonantFreq değerlerini FrequencyManager'dan sorgula.
 *      AudioEngine _applyResonantPeak() için doğru frekansı döndürür.
 *
 *   4. getAMSeries(baseHz, beatHz):
 *      Phi harmonik serisi + tremolo parametrelerini + EEG band bilgisini
 *      tek bir nesnede birleştirir. applyMSD() → AudioEngine köprüsü için.
 *
 *   5. getPhiSeriesForCount(baseHz, count):
 *      getSolfeggioPhiHarmonics()'in alias'ı — AudioEngine v4.3 içinden
 *      direkt çağrılabilir, baseHz parametresi zorunlu.
 *
 * v2 API'leri korundu — tam geriye dönük uyumluluk.
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

/* ═══════════════════════════════════════════════════════════════
   SABİTLER
═══════════════════════════════════════════════════════════════ */

/** Altın Oran (φ) — Phi */
const PHI = 1.618033988749895;

/** İnsan kulağı frekans sınırları (Hz) */
const FREQ_MIN = 20;
const FREQ_MAX = 20000;

/** Varsayılan temel frekans */
const DEFAULT_BASE_FREQ = 432;

/**
 * 9 Solfeggio Frekansı — Rapor Sayfa 24 & Bölüm 5.4
 *
 * Her entry:
 *   hz       : Solfeggio temel değeri
 *   label    : İnsan-okunur isim
 *   effect   : Terapötik etki tanımı (Maestro UI açıklamaları için)
 *   brainwave: En uyumlu EEG bandı
 *   phiHarmonics: baseHz × φ^k (k = 0..7) — 8 harmonik çarpan dizisi
 *                 Dinamik olarak hesaplanır, burada açıklayıcı olarak listelendi
 */
const SOLFEGGIO_TABLE = {
  174: {
    hz       : 174,
    label    : 'Temel Güvenlik',
    effect   : 'Ağrı azaltma, güvenlik ve istikrar hissi, zemin enerji',
    brainwave: 'delta',
    moodMatch: ['deep_sleep', 'deep_meditation'],
    // Phi harmonikler: 174 × φ^0..7
    // [174, 281.5, 455.3, 736.6, 1191.3, 1927.0, 3117.3, 5041.3] (Hz)
    // AudioEngine'de kullanım: startBinauralLayer carrier frekansı
    carrierMin: 160,
    carrierMax: 200,
  },
  285: {
    hz       : 285,
    label    : 'Enerji Dokusu',
    effect   : 'Doku ve enerji alanı yenilenmesi, hücresel iyileşme desteği',
    brainwave: 'theta',
    moodMatch: ['stress_relief', 'deep_meditation'],
    carrierMin: 170,
    carrierMax: 210,
  },
  396: {
    hz       : 396,
    label    : 'Özgürleşme',
    effect   : 'Suçluluk ve korku serbest bırakma, kaygı azaltma, kök çakra',
    brainwave: 'theta',
    moodMatch: ['stress_relief', 'anxiety_acute', 'deep_sleep'],
    carrierMin: 180,
    carrierMax: 220,
  },
  417: {
    hz       : 417,
    label    : 'Değişim',
    effect   : 'Yeniden yapılanma ve değişim kolaylaştırma, blokaj açma',
    brainwave: 'alpha',
    moodMatch: ['stress_relief', 'focus'],
    carrierMin: 185,
    carrierMax: 215,
  },
  528: {
    hz       : 528,
    label    : 'İyileşme',
    effect   : 'DNA onarım rezonansı, kalp çakrası, dönüşüm ve mucize',
    brainwave: 'alpha',
    moodMatch: ['deep_meditation', 'stress_relief', 'energize'],
    carrierMin: 190,
    carrierMax: 220,
  },
  639: {
    hz       : 639,
    label    : 'Bağlantı',
    effect   : 'İlişki uyumu, sosyal uyum, kalp çakrası üst harmonik',
    brainwave: 'alpha',
    moodMatch: ['stress_relief', 'energize'],
    carrierMin: 195,
    carrierMax: 225,
  },
  741: {
    hz       : 741,
    label    : 'Arınma',
    effect   : 'Zihinsel netlik, problem çözme, toksin temizleme',
    brainwave: 'alpha',
    moodMatch: ['focus', 'energize'],
    carrierMin: 200,
    carrierMax: 230,
  },
  852: {
    hz       : 852,
    label    : 'Sezgi',
    effect   : 'Üçüncü göz aktivasyonu, sezgisel farkındalık, ruhsal uyandırma',
    brainwave: 'alpha',
    moodMatch: ['deep_meditation', 'focus'],
    carrierMin: 200,
    carrierMax: 235,
  },
  963: {
    hz       : 963,
    label    : 'Birlik',
    effect   : 'Taç çakrası, bilinç birliği, ilahi bağlantı',
    brainwave: 'theta',
    moodMatch: ['deep_meditation'],
    carrierMin: 205,
    carrierMax: 240,
  },
};

/**
 * EEG Bölge Tanımları — Rapor Sayfa 24 (Tablo 5.4)
 * Binaural beat Hz → Beyin dalgası bölgesi
 * Güvenlik sınırları: asla 2Hz altına düşme (epilepsi riski raporda belirtilmiş)
 */
const BRAINWAVE_BANDS = {
  delta    : { min: 2,  max: 4,  label: 'Delta',    effect: 'Derin uyku indüksiyonu' },
  theta    : { min: 4,  max: 8,  label: 'Theta',    effect: 'Derin meditasyon, yaratıcılık' },
  alpha    : { min: 8,  max: 14, label: 'Alpha',    effect: 'Stres azaltma, rahatlatma' },
  low_beta : { min: 14, max: 20, label: 'Low Beta', effect: 'Odaklanma, enerji' },
};

/** Just Intonation — Saf Mizaç oranları (v1 uyumluluğu için korundu) */
const JUST_INTONATION_RATIOS = [
  1/1,    // Unison
  9/8,    // Büyük ikili (Major 2nd)
  5/4,    // Büyük üçlü (Major 3rd)
  4/3,    // Dörtlü (Perfect 4th)
  3/2,    // Beşli (Perfect 5th)
  5/3,    // Büyük altılı (Major 6th)
  15/8,   // Büyük yedili (Major 7th)
  2/1,    // Oktav
];

/* ═══════════════════════════════════════════════════════════════
   FREQUENCY MANAGER SINIFI v3
═══════════════════════════════════════════════════════════════ */

/**
 * AudioEngine v4.3 TEXTURE_MAP'teki resonantFreq değerleri.
 * FrequencyManager bağımsız çalışabilmesi için kendi kopyasını tutar.
 * AudioEngine yüklenmeden önce de doğru frekans sorgulanabilir.
 */
const TEXTURE_RESONANT_FREQ = {
  'ocean': 180, 'river': 220, 'stream': 260, 'waves': 160, 'underwater': 120,
  'rain': 3200, 'drizzle': 4000, 'storm': 2800, 'white-noise': 2000, 'pink-noise': 1500,
  'forest': 600, 'wind': 500, 'night': 800, 'crickets': 4500, 'birds': 2200,
  'meadow': 900, 'leaves': 1200,
  'fire': 800, 'fireplace': 700, 'campfire': 850, 'embers': 650, 'calm embers': 600,
  'zen': 432, 'bowl': 432, 'singing-bowl': 528, 'tibetan': 396, 'temple': 417,
  'whisper': 2500, 'breath': 1800, 'asmr': 3000,
  'space': 80, 'cosmos': 60, 'void': 40, 'drone': 100, 'ambient': 300,
};

/**
 * AudioEngine v4.3 katman gain değerleri (Rapor: "sentezleyici < texture her zaman")
 * Katman A: temel binaural | B: Phi¹/² | C: Phi³/⁴
 */
const PHI_LAYER_GAINS = {
  layerA: 0.10,
  layerB: 0.035,
  layerC: 0.015,
};

/**
 * Tremolo (AM) varsayılan parametreleri — AudioEngine startTremoloLayer() ile eşleşir.
 */
const TREMOLO_DEFAULTS = {
  depth : 0.18,   /* Genlik modülasyon derinliği [0-1] */
  gain  : 0.08,   /* Katman toplam seviyesi */
};

class FrequencyManager {

  /**
   * @param {number} [baseFreq]  — Başlangıç temel frekansı (Hz).
   *                               GeminiAdapter'ın frequencySuggestion değeri
   *                               dışarıdan setBaseFreq() ile de atanabilir.
   */
  constructor(baseFreq) {
    this._baseFreq      = this._clamp(baseFreq || DEFAULT_BASE_FREQ);
    this._stepIndex     = 0;   // Just Intonation dizi adım sayacı
    this._phiIndex      = 0;   // Altın Oran üs sayacı
    this._mode          = 'just'; // 'just' | 'phi' | 'blend' | 'solfeggio'
    this._harmonicCache = [];
    this._activeSolfeggio = null; // Şu an aktif Solfeggio frekansı bilgisi
    this._rebuildCache();
  }

  /* ── Temel Frekans ─────────────────────────────────────────── */

  /**
   * GeminiAdapter'dan gelen frequencySuggestion'ı baseFreq olarak ayarla.
   * @param {number} freq — Hz
   */
  setBaseFreq(freq) {
    if (!isFinite(freq) || freq <= 0) {
      console.warn('[FrequencyManager] Geçersiz baseFreq, varsayılan kullanılıyor:', DEFAULT_BASE_FREQ);
      this._baseFreq = DEFAULT_BASE_FREQ;
    } else {
      this._baseFreq = this._clamp(freq);
    }
    this._stepIndex = 0;
    this._phiIndex  = 0;
    this._rebuildCache();
    console.info('[FrequencyManager] baseFreq güncellendi:', this._baseFreq, 'Hz');
  }

  /**
   * MSD (Musical Scene Descriptor) nesnesinden doğrudan baseFreq ata.
   * GeminiAdapter.generateScene() ve Maestro v2 çıktısıyla uyumludur.
   * @param {object} msd — { frequencySuggestion: number, solfeggioHz: number, ... }
   */
  applyMSD(msd) {
    if (!msd) return;
    // Maestro v2: solfeggioHz alanı varsa onu önceliklendir
    if (typeof msd.solfeggioHz === 'number') {
      const entry = this.getSolfeggioEntry(msd.solfeggioHz);
      if (entry) {
        this.setBaseFreq(entry.hz);
        this._activeSolfeggio = entry;
        console.info('[FrequencyManager] Maestro v2 Solfeggio seçildi:', entry.hz, 'Hz —', entry.label);
        return;
      }
    }
    // Fallback: frequencySuggestion
    if (typeof msd.frequencySuggestion === 'number') {
      this.setBaseFreq(msd.frequencySuggestion);
    }
  }

  get baseFreq()         { return this._baseFreq; }
  get activeSolfeggio()  { return this._activeSolfeggio; }

  /* ── Solfeggio API ─────────────────────────────────────────── */

  /**
   * Tüm Solfeggio tablosunu döndürür.
   * @returns {object} SOLFEGGIO_TABLE
   */
  getSolfeggioTable() {
    return SOLFEGGIO_TABLE;
  }

  /**
   * Verilen Hz değerine en yakın Solfeggio tablosu girdisini döndürür.
   * Maestro v2'den gelen solfeggioHz tam değer olmayabilir — tolerans: ±5Hz.
   * @param {number} hz
   * @returns {object|null} Solfeggio entry veya null
   */
  getSolfeggioEntry(hz) {
    if (!isFinite(hz)) return null;
    const keys = Object.keys(SOLFEGGIO_TABLE).map(Number);
    let nearest = null;
    let minDiff = Infinity;
    for (const key of keys) {
      const diff = Math.abs(key - hz);
      if (diff < minDiff) { minDiff = diff; nearest = key; }
    }
    // ±20Hz tolerans — Gemini'nin sayısal hassasiyeti için
    return (minDiff <= 20) ? SOLFEGGIO_TABLE[nearest] : null;
  }

  /**
   * Maestro v2 mood'una göre önerilen Solfeggio frekansını döndürür.
   * @param {string} mood — Maestro v2 mood değeri
   * @returns {object} Solfeggio entry (bulunamazsa 528Hz default)
   */
  getSolfeggioForMaestro(mood) {
    const entries = Object.values(SOLFEGGIO_TABLE);
    const match = entries.find(e => e.moodMatch.includes(mood));
    return match || SOLFEGGIO_TABLE[528];
  }

  /**
   * Verilen Solfeggio Hz için Phi tabanlı harmonik diziyi hesaplar.
   * f_k = solfeggioHz × φ^k  (k = 0..count-1)
   * Rapor Bölüm 5 — Altın Oran harmonik çarpanları.
   * @param {number} solfeggioHz — Solfeggio temel frekansı
   * @param {number} [count=8]   — Harmonik sayısı
   * @returns {number[]} Hz dizisi (işitsel sınırlar uygulanmış)
   */
  getSolfeggioPhiHarmonics(solfeggioHz, count) {
    count = Math.max(1, count || 8);
    const base = isFinite(solfeggioHz) ? solfeggioHz : this._baseFreq;
    const result = [];
    for (let k = 0; k < count; k++) {
      const f = base * Math.pow(PHI, k);
      if (f > FREQ_MAX) break; // İşitsel sınır aşıldıysa dizi burada kesilir
      result.push(this._clamp(f));
    }
    return result;
  }

  /**
   * Tüm 9 Solfeggio frekansı için Phi harmonik tablosunu döndürür.
   * AudioEngine startBinauralLayer'da harmonik zenginleştirme için.
   * @returns {object} { [hz]: number[] }
   */
  getAllSolfeggioPhiHarmonicsMap() {
    const map = {};
    for (const [key, entry] of Object.entries(SOLFEGGIO_TABLE)) {
      map[key] = this.getSolfeggioPhiHarmonics(entry.hz, 8);
    }
    return map;
  }

  /* ── Binaural Beat API ─────────────────────────────────────── */

  /**
   * EEG bölgesi adından güvenli binaural beat Hz aralığı döndürür.
   * Rapor Sayfa 24 Tablo 5.4 değerleri.
   * @param {string} bandName — 'delta' | 'theta' | 'alpha' | 'low_beta'
   * @returns {{ min: number, max: number, label: string, effect: string }}
   */
  getBrainwaveBand(bandName) {
    return BRAINWAVE_BANDS[bandName] || BRAINWAVE_BANDS.theta;
  }

  /**
   * Binaural beat için sol/sağ kanal frekans çifti döndürür.
   * EEG bölge validasyonu uygulanır:
   *   - Asla 2Hz altına düşmez (epilepsi güvenlik sınırı — Rapor Sayfa 24)
   *   - 20Hz üzerine çıkmaz
   *   - Carrier frekansı: Solfeggio entry'nin önerilen aralığında tutulur
   *
   * @param {number} beatHz     — İstenen binaural beat Hz (Maestro'dan gelir)
   * @param {number} [baseHz]   — Sol kulak carrier Hz (yoksa this._baseFreq)
   * @returns {{ left: number, right: number, beatHz: number, band: string }}
   */
  getBinauralPair(beatHz, baseHz) {
    // Güvenlik: 2Hz alt sınır (Rapor: "asla 2Hz altına — epilepsi riski")
    const BINAURAL_MIN = 2;
    const BINAURAL_MAX = 20;

    const beat = isFinite(beatHz) && beatHz > 0
      ? Math.max(BINAURAL_MIN, Math.min(BINAURAL_MAX, beatHz))
      : 6; // Theta orta değer varsayılan

    // Carrier frekansı — aktif Solfeggio entry'den al, yoksa baseFreq
    let carrier = isFinite(baseHz) && baseHz > 0 ? baseHz : this._baseFreq;
    if (this._activeSolfeggio) {
      // Carrier'ı Solfeggio'nun önerilen aralığında kıs
      const { carrierMin, carrierMax } = this._activeSolfeggio;
      carrier = Math.max(carrierMin, Math.min(carrierMax, carrier));
    }

    const left  = this._clamp(carrier);
    const right = this._clamp(left + beat);

    // EEG bandı teşhis et (loglama ve UI için)
    const band = this._detectBand(beat);

    return { left, right, beatHz: beat, band };
  }

  /**
   * Maestro v2 binauralHz değerinin hangi EEG bölgesine düştüğünü döndürür.
   * @param {number} hz
   * @returns {string} band adı
   */
  detectBrainwaveBand(hz) {
    return this._detectBand(hz);
  }

  /* ── Harmonik Mod (v1 uyumlu) ──────────────────────────────── */

  /**
   * Frekans üretim modunu ayarla.
   * @param {'just'|'phi'|'blend'|'solfeggio'} mode
   */
  setMode(mode) {
    if (['just', 'phi', 'blend', 'solfeggio'].includes(mode)) {
      this._mode = mode;
      this._stepIndex = 0;
      this._phiIndex  = 0;
    }
  }

  /* ── Frekans Üretici API ───────────────────────────────────── */

  /**
   * Bir sonraki harmonik frekansı döndürür.
   * @returns {number} Hz
   */
  getNextFrequency() {
    switch (this._mode) {
      case 'just'     : return this._nextJust();
      case 'phi'      : return this._nextPhi();
      case 'blend'    : return this._blendFrequency();
      case 'solfeggio': return this._nextSolfeggio();
      default         : return this._nextJust();
    }
  }

  /**
   * Tüm Just Intonation harmoniklerini dizi olarak döndürür.
   * @returns {number[]}
   */
  getHarmonicSeries() {
    return [...this._harmonicCache];
  }

  /**
   * Altın Oran serisi: f = baseFreq * φ^k  (k = 0..n-1)
   * @param {number} [count=8]
   * @returns {number[]}
   */
  getPhiSeries(count) {
    count = Math.max(1, count || 8);
    const result = [];
    for (let k = 0; k < count; k++) {
      const f = this._baseFreq * Math.pow(PHI, k);
      if (f > FREQ_MAX) break;
      result.push(this._clamp(f));
    }
    return result;
  }

  /* ── [YENİ v3] AudioEngine v4.3 Entegrasyon API'leri ────────────── */

  /**
   * AudioEngine v4.3 Katman A/B/C yapısıyla birebir uyumlu Phi harmonik seti.
   * { layerA, layerB, layerC, gainMap, panMap, series }
   * @param {number} baseHz  — Temel frekans (Maestro.baseHz)
   * @param {number} beatHz  — Binaural beat farkı (Maestro.binauralHz)
   * @returns {object}
   */
  getPhiLayerSet(baseHz, beatHz) {
    const pair   = this.getBinauralPair(beatHz, baseHz);
    const series = this.getSolfeggioPhiHarmonics(baseHz, 5);

    return {
      layerA : { left: pair.left, right: pair.right, beatHz: pair.beatHz, band: pair.band },
      layerB : {
        phi1: series[1] || this._clamp(baseHz * PHI),
        phi2: series[2] || this._clamp(baseHz * PHI * PHI),
      },
      layerC : {
        phi3: series[3] || this._clamp(baseHz * Math.pow(PHI, 3)),
        phi4: series[4] || this._clamp(baseHz * Math.pow(PHI, 4)),
      },
      gainMap: { ...PHI_LAYER_GAINS },
      panMap : { layerB: [-0.25, 0.25], layerC: [-0.55, 0.55] },
      series,
    };
  }

  /**
   * Tremolo (AM) katmanı için hazır parametre nesnesi.
   * AudioEngine v4.3 startTremoloLayer(ctx, baseHz, beatHz) ile uyumlu.
   * @param {number} baseHz — Carrier Hz
   * @param {number} beatHz — LFO Hz
   * @returns {{ carrierHz, lfoHz, depth, gain, band }}
   */
  getTremoloParams(baseHz, beatHz) {
    const safeBeat = Math.max(2, Math.min(20, isFinite(beatHz) && beatHz > 0 ? beatHz : 6));
    const carrier  = isFinite(baseHz) && baseHz > 0 ? this._clamp(baseHz) : this._baseFreq;
    return {
      carrierHz : carrier,
      lfoHz     : safeBeat,
      depth     : TREMOLO_DEFAULTS.depth,
      gain      : TREMOLO_DEFAULTS.gain,
      band      : this._detectBand(safeBeat),
    };
  }

  /**
   * Texture adına göre AudioEngine v4.3 Resonant Peak frekansını döndürür.
   * @param {string} textureName — ('fire', 'zen', 'rain', 'calm embers', vb.)
   * @returns {number} Hz
   */
  getResonantFreqForTexture(textureName) {
    if (!textureName) return 800;
    const key = String(textureName).toLowerCase().trim();
    return TEXTURE_RESONANT_FREQ[key] || 800;
  }

  /**
   * Phi harmonik serisi + tremolo parametreleri + EEG band bilgisini
   * tek nesnede döndürür. applyMSD() → AudioEngine köprüsü için.
   * @param {number} baseHz
   * @param {number} beatHz
   * @returns {{ phiLayers, tremolo, baseHz, beatHz, band, activeSolfeggio }}
   */
  getAMSeries(baseHz, beatHz) {
    return {
      phiLayers      : this.getPhiLayerSet(baseHz, beatHz),
      tremolo        : this.getTremoloParams(baseHz, beatHz),
      baseHz         : isFinite(baseHz) ? baseHz : this._baseFreq,
      beatHz         : isFinite(beatHz) ? beatHz : 6,
      band           : this._detectBand(isFinite(beatHz) ? beatHz : 6),
      activeSolfeggio: this._activeSolfeggio,
    };
  }

  /**
   * getSolfeggioPhiHarmonics() alias'ı — baseHz zorunlu, count varsayılan 5.
   * AudioEngine v4.3 startBinauralLayer() tarafından çağrılır.
   * @param {number} baseHz
   * @param {number} [count=5]
   * @returns {number[]}
   */
  getPhiSeriesForCount(baseHz, count) {
    return this.getSolfeggioPhiHarmonics(baseHz, count || 5);
  }

  /* ── Dahili Yardımcılar ────────────────────────────────────── */

  /** Just Intonation — sıradaki harmonik adım */
  _nextJust() {
    const ratio = JUST_INTONATION_RATIOS[this._stepIndex % JUST_INTONATION_RATIOS.length];
    this._stepIndex = (this._stepIndex + 1) % JUST_INTONATION_RATIOS.length;
    return this._clamp(this._baseFreq * ratio);
  }

  /** Altın Oran — bir sonraki üs adımı */
  _nextPhi() {
    const freq = this._clamp(this._baseFreq * Math.pow(PHI, this._phiIndex));
    this._phiIndex++;
    if (this._baseFreq * Math.pow(PHI, this._phiIndex) > FREQ_MAX) {
      this._phiIndex = 0;
    }
    return freq;
  }

  /**
   * Solfeggio modu — aktif solfeggioHz'in Phi harmoniklerini döngüler.
   * Mod 'solfeggio' seçildiğinde AudioEngine bu diziyi kullanır.
   */
  _nextSolfeggio() {
    const base = this._activeSolfeggio ? this._activeSolfeggio.hz : this._baseFreq;
    const series = this.getSolfeggioPhiHarmonics(base, 8);
    const freq = series[this._phiIndex % series.length];
    this._phiIndex = (this._phiIndex + 1) % series.length;
    return this._clamp(freq);
  }

  /** Blend — Just Intonation + Phi oranlarını ağırlıklı karıştır */
  _blendFrequency() {
    const justFreq = this._nextJust();
    const phiRatio = Math.pow(PHI, (this._phiIndex % 4));
    this._phiIndex = (this._phiIndex + 1) % 4;
    const blended  = justFreq * 0.7 + (this._baseFreq * phiRatio) * 0.3;
    return this._clamp(blended);
  }

  /** Harmonik önbelleği yeniden oluştur */
  _rebuildCache() {
    this._harmonicCache = JUST_INTONATION_RATIOS.map(r =>
      this._clamp(this._baseFreq * r)
    );
  }

  /** EEG bant tespiti */
  _detectBand(hz) {
    if (hz < 4)  return 'delta';
    if (hz < 8)  return 'theta';
    if (hz < 14) return 'alpha';
    return 'low_beta';
  }

  /**
   * İnsan kulağı sınırlarına (20Hz–20kHz) sıkıştır.
   * @param {number} freq
   * @returns {number}
   */
  _clamp(freq) {
    if (!isFinite(freq) || freq <= 0) return DEFAULT_BASE_FREQ;
    return Math.max(FREQ_MIN, Math.min(FREQ_MAX, freq));
  }
}

/* ═══════════════════════════════════════════════════════════════
   EXPORT — Browser global
═══════════════════════════════════════════════════════════════ */
window.FrequencyManager = FrequencyManager;

/** Tüm Solfeggio tablosuna global erişim (GeminiAdapter, UI bileşenleri için) */
window.SANCTUARY_SOLFEGGIO = SOLFEGGIO_TABLE;

/** Binaural bant tablosuna global erişim */
window.SANCTUARY_BRAINWAVE_BANDS = BRAINWAVE_BANDS;

/** [YENİ v3] TEXTURE_MAP resonantFreq değerleri — AudioEngine bağımsız erişim */
window.SANCTUARY_RESONANT_FREQ = TEXTURE_RESONANT_FREQ;

/** [YENİ v3] Phi katman gain değerleri */
window.SANCTUARY_PHI_LAYER_GAINS = PHI_LAYER_GAINS;

/** Singleton factory — tek örnek */
window.getFrequencyManager = (function () {
  let _instance = null;
  return function (baseFreq) {
    if (!_instance) _instance = new FrequencyManager(baseFreq);
    return _instance;
  };
})();

console.info(
  '[FrequencyManager v3] AudioEngine v4.3 entegrasyonu hazır.',
  '\n  Solfeggio    :', Object.keys(SOLFEGGIO_TABLE).join('Hz, ') + 'Hz',
  '\n  Phi (φ)      :', PHI.toFixed(6),
  '\n  [YENİ] getPhiLayerSet()          — Katman A/B/C birebir uyumlu Phi seti',
  '\n  [YENİ] getTremoloParams()         — Tremolo (AM) hazır parametre nesnesi',
  '\n  [YENİ] getResonantFreqForTexture()— Texture → Resonant Peak Hz',
  '\n  [YENİ] getAMSeries()              — Phi + Tremolo + EEG band tek objede',
  '\n  [YENİ] getPhiSeriesForCount()     — getSolfeggioPhiHarmonics() kisayolu',
  '\n  Texture sayısı:', Object.keys(TEXTURE_RESONANT_FREQ).length
);
