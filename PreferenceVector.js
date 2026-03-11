/**
 * PreferenceVector.js — Sanctuary Tercih Vektörü (Rapor 6.2)
 * ─────────────────────────────────────────────────────────────────────────────
 * Ses katmanlarının birbirleriyle dengeli çalmasını sağlayan merkezi ayar.
 * Kullanıcı etkileşimlerine göre kademeli olarak güncellenir.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Vektör yapısı:
 *   tempoPreference   : 0–1  (0=yavaş/sakin, 1=hızlı/enerjik)
 *   natureIntensity   : 0–1  (ambient ses yoğunluğu)
 *   binauralIntensity : 0–1  (binaural beat yoğunluğu)
 *   masterVolume      : 0–1  (genel ses seviyesi)
 *   preferredGen      : string (en çok seçilen generator)
 *   sessionCount      : number
 *   totalMinutes      : number
 */

class PreferenceVector {
  constructor() {
    /* Varsayılan denge değerleri */
    this._defaults = {
      tempoPreference   : 0.4,   // sakin tarafa yakın
      natureIntensity   : 0.65,  // orta-yüksek doğa sesi
      binauralIntensity : 0.30,  // düşük-orta binaural
      masterVolume      : 0.75,
      preferredGen      : 'waves',
      sessionCount      : 0,
      totalMinutes      : 0,
      genCounts         : {},
      moodCounts        : {},
    };

    this._v = Object.assign({}, this._defaults);
    this._load();
  }

  /* ── Getter'lar ────────────────────────────────────────────────────────── */
  get tempoPreference()    { return this._v.tempoPreference; }
  get natureIntensity()    { return this._v.natureIntensity; }
  get binauralIntensity()  { return this._v.binauralIntensity; }
  get masterVolume()       { return this._v.masterVolume; }
  get preferredGen()       { return this._v.preferredGen; }

  /**
   * Ses katmanları için hesaplanmış gain değerlerini döndür.
   * AudioEngine bu değerleri kullanarak katmanları dengeler.
   */
  getLayerGains() {
    return {
      ambient : Math.max(0.3, Math.min(0.9, this._v.natureIntensity)),
      binaural: Math.max(0.0, Math.min(0.5, this._v.binauralIntensity)),
      master  : Math.max(0.4, Math.min(1.0, this._v.masterVolume)),
    };
  }

  /**
   * Crossfade süresini tempoPreference'a göre hesapla.
   * Sakin kullanıcı → uzun geçiş, enerjik → kısa
   */
  getCrossfadeDuration() {
    return 0.8 + (1 - this._v.tempoPreference) * 2.2; // 0.8s – 3.0s
  }

  /* ── Güncelleme metodları ──────────────────────────────────────────────── */

  recordSoundChoice(gen, base, beat) {
    // Generator sayacı
    this._v.genCounts[gen] = (this._v.genCounts[gen] || 0) + 1;

    // En çok seçilen generator
    const top = Object.entries(this._v.genCounts)
      .sort((a,b) => b[1]-a[1])[0];
    if (top) this._v.preferredGen = top[0];

    // Binaural seçildiyse binauralIntensity artır
    if (beat > 0) {
      this._v.binauralIntensity = this._lerp(this._v.binauralIntensity, 0.5, 0.1);
    } else {
      this._v.binauralIntensity = this._lerp(this._v.binauralIntensity, 0.2, 0.05);
    }

    // Ateş/fırtına → enerjik, dalgalar/yağmur → sakin
    const energyMap = { fire:0.7, storm:0.8, waves:0.3, rain:0.3, wind:0.4, binaural:0.35 };
    const energy = energyMap[gen] || 0.4;
    this._v.tempoPreference = this._lerp(this._v.tempoPreference, energy, 0.08);

    this._save();
  }

  recordVolumeChange(value, layer) {
    if (layer === 'master' || !layer) {
      this._v.masterVolume = Math.max(0.2, Math.min(1.0, value));
    } else if (layer === 'ambient') {
      this._v.natureIntensity = Math.max(0.1, Math.min(1.0, value));
    } else if (layer === 'binaural') {
      this._v.binauralIntensity = Math.max(0.0, Math.min(0.6, value));
    }
    this._save();
  }

  recordMoodChoice(mood) {
    this._v.moodCounts[mood] = (this._v.moodCounts[mood] || 0) + 1;

    // Mood → tempo ve yoğunluk etkisi
    const moodMap = {
      'Kaygılı' : { tempo:0.2, nature:0.7 },
      'Huzursuz': { tempo:0.3, nature:0.65 },
      'Yorgun'  : { tempo:0.25, nature:0.6 },
      'Mutsuz'  : { tempo:0.2, nature:0.7 },
      'Sakin'   : { tempo:0.4, nature:0.6 },
      'Minnettar':{ tempo:0.45, nature:0.65 },
    };
    const effect = moodMap[mood];
    if (effect) {
      this._v.tempoPreference  = this._lerp(this._v.tempoPreference,  effect.tempo,  0.1);
      this._v.natureIntensity  = this._lerp(this._v.natureIntensity,  effect.nature, 0.1);
    }
    this._save();
  }

  recordSession(durationSec) {
    this._v.sessionCount++;
    this._v.totalMinutes += durationSec / 60;

    // Uzun oturum → mevcut ayarlar işe yarıyor, küçük pekiştirme
    if (durationSec > 300) { // 5 dakikadan uzun
      this._v.natureIntensity  = this._lerp(this._v.natureIntensity,  0.65, 0.05);
    }
    this._save();
  }

  reinforceCurrentSettings() {
    // Olumlu geri bildirim: mevcut ayarları merkeze doğru hafifçe çek
    this._v.natureIntensity  = this._lerp(this._v.natureIntensity,  0.65, 0.1);
    this._v.binauralIntensity= this._lerp(this._v.binauralIntensity, 0.3,  0.1);
    this._save();
  }

  attenuateCurrentSettings() {
    // Olumsuz geri bildirim: varsayılana doğru çek
    this._v.natureIntensity  = this._lerp(this._v.natureIntensity,  this._defaults.natureIntensity,  0.2);
    this._v.binauralIntensity= this._lerp(this._v.binauralIntensity, this._defaults.binauralIntensity, 0.2);
    this._save();
  }

  /* ── Sıfırla ──────────────────────────────────────────────────────────── */
  reset() {
    this._v = Object.assign({}, this._defaults);
    this._save();
  }

  /* ── Tüm vektörü getir ────────────────────────────────────────────────── */
  toJSON() {
    return Object.assign({}, this._v);
  }

  /* ────────────────────────────────────────────────────────────────────────
   * ÖZEL
   * ──────────────────────────────────────────────────────────────────────── */

  _lerp(current, target, rate) {
    return current + (target - current) * rate;
  }

  _save() {
    try {
      localStorage.setItem('sanctuary_pref_vector', JSON.stringify(this._v));
    } catch(e) { /* ok */ }
  }

  _load() {
    try {
      const raw = localStorage.getItem('sanctuary_pref_vector');
      if (raw) {
        const saved = JSON.parse(raw);
        // Sadece bilinen anahtarları yükle
        Object.keys(this._defaults).forEach(k => {
          if (saved[k] !== undefined) this._v[k] = saved[k];
        });
      }
    } catch(e) { /* ok */ }
  }
}

/* ── Export ───────────────────────────────────────────────────────────────── */
if (typeof module !== 'undefined') {
  module.exports = PreferenceVector;
} else {
  window.PreferenceVector = PreferenceVector;
}
