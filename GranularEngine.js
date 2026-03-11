/**
 * GranularEngine.js v4.2 — Sanctuary Granular Sentez Motoru
 * ─────────────────────────────────────────────────────────────────────────────
 * Rastgele grain (ses parçacığı) üreterek organik, "bulutsu" ses dokusu sağlar.
 * Grain boyutu: 50–200ms | Yoğunluk: 8–20 grain/saniye
 *
 * v4.2 Değişiklikleri (AudioEngine v4.2 entegrasyonu):
 * ├─ [YENİ] generateBuffer(): 'waves' tipine ek olarak 'rain' ve 'fire' desteği
 * │         rain  → düzensiz darbe + yüksek frekanslı gürültü patlamaları
 * │         fire  → orta-bant gürültü + çıtırtı modülasyonu
 * ├─ [YENİ] setDensity(): grainRate için alias (Maestro v2 uyumu)
 * ├─ [YENİ] getStatus(): aktif grain sayısı + parametre snapshot
 * └─ [DÜZELTME] _spawnGrain(): gain envelope Hann penceresi ile iyileştirildi
 * ─────────────────────────────────────────────────────────────────────────────
 */

class GranularEngine {
  /**
   * @param {AudioContext} ctx
   * @param {AudioNode}    destination  — bağlanacak hedef node
   * @param {object}       params
   * @param {number}       params.grainSize    — ms (50–200)
   * @param {number}       params.grainRate    — grain/saniye (8–20)
   * @param {number}       params.pitch        — playback hızı (0.5–2.0)
   * @param {number}       params.scatter      — pozisyon rastgeleliği (0–1)
   * @param {number}       params.volume       — çıkış seviyesi (0–1)
   */
  constructor(ctx, destination, params = {}) {
    this._ctx         = ctx;
    this._destination = destination;
    this._buffer      = null;
    this._active      = false;
    this._grainTimer  = null;
    this._grains      = [];          // aktif grain node'ları

    this.params = {
      grainSize : Math.max(50,  Math.min(200, params.grainSize || 120)),  // ms
      grainRate : Math.max(8,   Math.min(20,  params.grainRate || 12)),   // /s
      pitch     : Math.max(0.5, Math.min(2.0, params.pitch     || 1.0)),
      scatter   : Math.max(0,   Math.min(1,   params.scatter   || 0.5)),
      volume    : Math.max(0,   Math.min(1,   params.volume    || 0.6)),
    };

    /* Master gain */
    this._masterGain = ctx.createGain();
    this._masterGain.gain.value = this.params.volume;
    this._masterGain.connect(destination);
  }

  /* ── Buffer yükle (PCM veya generate) ────────────────────────────────── */
  setBuffer(buffer) {
    this._buffer = buffer;
    return this;
  }

  /**
   * Doğal ses tipi için dahili buffer üret.
   * @param {'waves'|'wind'|'rain'|'forest'|'fire'} type
   */
  generateBuffer(type = 'wind') {
    const ctx = this._ctx;
    const sr  = ctx.sampleRate;
    const dur = 4;                         // 4 saniyelik temel malzeme
    const buf = ctx.createBuffer(2, sr * dur, sr);

    for (let ch = 0; ch < 2; ch++) {
      const d     = buf.getChannelData(ch);
      let   phase = 0;

      for (let i = 0; i < d.length; i++) {
        const t = i / sr;
        let v = 0;

        switch (type) {
          case 'waves':
            phase += (2 * Math.PI * 0.08) / sr;
            v = Math.sin(phase) * 0.3
              + Math.sin(phase * 2.1 + 0.5) * 0.15
              + (Math.random() * 2 - 1) * 0.05;
            break;

          case 'rain':
            // [v4.2] Yağmur: düzensiz yüksek frekans patlamaları + zemin gürültüsü
            // Damla darbeleri: 17.3Hz + 31.7Hz bileşeni → düzensiz ritim
            v = (Math.random() * 2 - 1) * 0.3
              * (0.6 + Math.sin(t * 17.3) * 0.4);
            // Ek yüksek frekans çıtırtısı (3kHz+ bölgesini zenginleştirir)
            v += (Math.random() * 2 - 1) * 0.12
              * Math.pow(Math.max(0, Math.sin(t * 31.7 + 0.8)), 3);
            break;

          case 'forest':
            phase += (2 * Math.PI * 0.05) / sr;
            v = Math.sin(phase) * 0.1
              + (Math.random() * 2 - 1) * 0.2
              * Math.abs(Math.sin(t * 0.3));
            break;

          case 'fire':
            // [v4.2] Ateş: orta-bant bant geçişli gürültü + çıtırtı modülasyonu
            // Alev titremesi: 0.3-0.6Hz bileşeni
            phase += (2 * Math.PI * 0.4) / sr;
            v = (Math.random() * 2 - 1) * 0.28
              * (0.5 + Math.abs(Math.sin(phase)) * 0.5);
            // Çıtırtı darbesi: seyrek yüksek genlikli anlık patlama
            if (Math.random() < 0.003) {
              v += (Math.random() * 2 - 1) * 0.6;
            }
            break;

          default: // wind
            phase += (2 * Math.PI * 0.15) / sr;
            v = (Math.random() * 2 - 1) * 0.25
              * (0.5 + Math.abs(Math.sin(phase)));
        }

        d[i] = isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0;
      }
    }

    this._buffer = buf;
    return this;
  }

  /* ── [YENİ v4.2] setDensity() — Maestro v2 'density' alanı alias'ı ──────── */
  /**
   * grainRate için Maestro v2 uyumlu alias.
   * @param {number} density — grain/saniye (8–20)
   */
  setDensity(density) {
    this.setParam('grainRate', Math.max(8, Math.min(20, density)));
  }

  /* ── [YENİ v4.2] getStatus() — Anlık durum snapshot'ı ───────────────────── */
  getStatus() {
    return {
      active     : this._active,
      grainCount : this._grains.length,
      params     : Object.assign({}, this.params),
      hasBuffer  : !!this._buffer,
    };
  }

  /* ── Başlat ───────────────────────────────────────────────────────────── */
  start() {
    if (this._active) return;
    if (!this._buffer) {
      console.warn('[GranularEngine] Buffer yok — wind buffer üretiliyor.');
      this.generateBuffer('wind');
    }
    this._active = true;
    this._scheduleGrain();
  }

  /* ── Durdur ───────────────────────────────────────────────────────────── */
  stop() {
    this._active = false;
    if (this._grainTimer) {
      clearTimeout(this._grainTimer);
      this._grainTimer = null;
    }
    /* Aktif grain'leri fade out ile kapat */
    const now = this._ctx.currentTime;
    this._grains.forEach((g) => {
      try {
        g.gain.gain.setValueAtTime(g.gain.gain.value, now);
        g.gain.gain.linearRampToValueAtTime(0, now + 0.05);
        g.source.stop(now + 0.06);
      } catch { /* zaten durmuş */ }
    });
    this._grains = [];
  }

  /* ── Parametre güncelle ───────────────────────────────────────────────── */
  setParam(key, value) {
    if (!(key in this.params)) return;
    this.params[key] = value;
    if (key === 'volume' && this._masterGain) {
      const now = this._ctx.currentTime;
      this._masterGain.gain.setValueAtTime(this._masterGain.gain.value, now);
      this._masterGain.gain.linearRampToValueAtTime(value, now + 0.2);
    }
  }

  /* ── Temizlik ─────────────────────────────────────────────────────────── */
  dispose() {
    this.stop();
    try { this._masterGain.disconnect(); } catch { /* ok */ }
  }

  /* ────────────────────────────────────────────────────────────────────────
   * ÖZEL METODLAR
   * ──────────────────────────────────────────────────────────────────────── */

  _scheduleGrain() {
    if (!this._active) return;

    this._spawnGrain();

    /* Bir sonraki grain zamanı: 1000ms / grainRate ± %30 jitter */
    const interval    = 1000 / this.params.grainRate;
    const jitter      = interval * 0.3 * (Math.random() * 2 - 1);
    const nextMs      = Math.max(20, interval + jitter);

    this._grainTimer = setTimeout(() => this._scheduleGrain(), nextMs);
  }

  _spawnGrain() {
    if (!this._buffer || !this._ctx) return;

    const ctx    = this._ctx;
    const buf    = this._buffer;
    const now    = ctx.currentTime;

    /* Grain süresi: 50–200ms */
    const durMs  = this.params.grainSize * (0.7 + Math.random() * 0.6);
    const durSec = Math.max(0.05, Math.min(0.2, durMs / 1000));

    /* Başlangıç pozisyonu: buffer boyunca rastgele, scatter ile dağıtılmış */
    const maxOffset  = Math.max(0, buf.duration - durSec);
    const baseOffset = maxOffset * 0.5;
    const scatterAmt = maxOffset * this.params.scatter * 0.5;
    const offset     = Math.max(0, baseOffset + (Math.random() * 2 - 1) * scatterAmt);

    /* Kaynak */
    const src = ctx.createBufferSource();
    src.buffer             = buf;
    src.playbackRate.value = this.params.pitch * (0.9 + Math.random() * 0.2);

    /* [v4.2 DÜZELTME] Grain zarf: Hann penceresi benzeri üç nokta
       fadeTime = durSec * %25 (önceki %30'dan daha yumuşak geçiş)
       Peak gain = 0.85 (önceki 0.8'den hafif yüksek — granular dolgunluğu) */
    const gainNode = ctx.createGain();
    const fadeTime = Math.min(durSec * 0.25, 0.025);
    gainNode.gain.setValueAtTime(0, now);
    gainNode.gain.linearRampToValueAtTime(0.85, now + fadeTime);
    gainNode.gain.setValueAtTime(0.85, now + durSec - fadeTime);
    gainNode.gain.linearRampToValueAtTime(0, now + durSec);

    src.connect(gainNode);
    gainNode.connect(this._masterGain);

    src.start(now, offset, durSec);

    /* Grain kaydı — temizlik için */
    const grainRef = { source: src, gain: gainNode };
    this._grains.push(grainRef);
    src.onended = () => {
      this._grains = this._grains.filter((g) => g !== grainRef);
      try { gainNode.disconnect(); } catch { /* ok */ }
    };
  }
}

/* ── Export ───────────────────────────────────────────────────────────────── */
if (typeof module !== 'undefined') {
  module.exports = GranularEngine;
} else {
  window.GranularEngine = GranularEngine;
}
