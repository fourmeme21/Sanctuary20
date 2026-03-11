/* sanctuary-bundle.js — auto-generated */
'use strict';

/* === AudioEngine === */
/**
 * AudioEngine.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Singleton-pattern, DOM-bağımsız, React Native / Expo uyumlu ses motoru.
 *
 * Kullanım (Web / React Native WebView):
 *   import AudioEngine from './AudioEngine';
 *   const engine = AudioEngine.getInstance();
 *   await engine.initialize();
 *   await engine.play();
 *
 * React Native (expo-av / react-native-track-player):
 *   Bu dosya Web Audio API'yi doğrudan kullanır fakat tüm I/O noktaları
 *   `NativeAdapter` interface'i üzerinden geçer — platforma özel adapter'ı
 *   inject ederek native modüllere geçiş yapılabilir.
 * ─────────────────────────────────────────────────────────────────────────────
 */


/* ═══════════════════════════════════════════════════════════════
   SECTION 1 — SABİTLER
═══════════════════════════════════════════════════════════════ */

const AUDIO_CONFIG = {
  DEFAULT_MASTER_VOLUME: 0.8,
  MAX_TRACK_VOLUME: 0.5,
  FFT_SIZE: 256,
  SMOOTHING: 0.8,
  MAX_LAYERS: 3,
  CROSSFADE_DURATION: 2.5,   // saniye — gapless geçiş süresi
  FADE_IN_DURATION: 1.5,     // saniye
  FADE_OUT_DURATION: 1.5,    // saniye
  PRELOAD_BUFFER_SECONDS: 4, // buffer önceden doldurulacak süre
  LOOP_GAP_THRESHOLD: 0.05,  // sn — loop seam tespit eşiği
};

/* ═══════════════════════════════════════════════════════════════
   SECTION 2 — NATIVE ADAPTER (platform soyutlama katmanı)
   React Native'de expo-av veya react-native-track-player ile
   değiştirilebilir. Web'de Web Audio API kullanılır.
═══════════════════════════════════════════════════════════════ */

class WebAudioAdapter {
  /**
   * AudioContext döndürür.
   * React Native tarafında bu metod override edilip
   * expo-av Sound nesnesi veya AVAudioSession başlatılabilir.
   */
  createContext() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) throw new Error('[AudioEngine] Web Audio API desteklenmiyor.');
    return new Ctx();
  }

  async resumeContext(ctx) {
    if (ctx && ctx.state === 'suspended') {
      await ctx.resume();
    }
  }

  async suspendContext(ctx) {
    if (ctx && ctx.state === 'running') {
      await ctx.suspend();
    }
  }

  async closeContext(ctx) {
    if (ctx) await ctx.close();
  }

  /**
   * Native tarafta bu metod `expo-av Audio.Sound.createAsync(uri)` çağrısı
   * yapan bir wrapper ile değiştirilebilir.
   */
  async loadAudioFile(ctx, uri) {
    const response = await fetch(uri);
    const arrayBuffer = await response.arrayBuffer();
    return ctx.decodeAudioData(arrayBuffer);
  }
}

/* ═══════════════════════════════════════════════════════════════
   SECTION 3 — PRELOAD CACHE
   Ses dosyalarını önceden buffer'a alır, tekrar fetch etmez.
═══════════════════════════════════════════════════════════════ */

class PreloadCache {
  constructor() {
    /** @type {Map<string, AudioBuffer>} */
    this._cache = new Map();
    /** @type {Map<string, Promise<AudioBuffer>>} */
    this._pending = new Map();
  }

  has(uri) {
    return this._cache.has(uri);
  }

  get(uri) {
    return this._cache.get(uri) || null;
  }

  /**
   * Ses dosyasını asenkron olarak yükler ve cache'e alır.
   * Eş zamanlı çağrılar aynı Promise'i paylaşır (request coalescing).
   *
   * @param {AudioContext} ctx
   * @param {string} uri
   * @param {WebAudioAdapter} adapter
   * @returns {Promise<AudioBuffer>}
   */
  async load(ctx, uri, adapter) {
    if (this._cache.has(uri)) return this._cache.get(uri);
    if (this._pending.has(uri)) return this._pending.get(uri);

    const promise = adapter.loadAudioFile(ctx, uri).then((buffer) => {
      this._cache.set(uri, buffer);
      this._pending.delete(uri);
      return buffer;
    }).catch((err) => {
      this._pending.delete(uri);
      throw err;
    });

    this._pending.set(uri, promise);
    return promise;
  }

  /**
   * Birden fazla URI'yi paralel olarak preload eder.
   *
   * @param {AudioContext} ctx
   * @param {string[]} uris
   * @param {WebAudioAdapter} adapter
   */
  async preloadMany(ctx, uris, adapter) {
    await Promise.allSettled(uris.map((uri) => this.load(ctx, uri, adapter)));
  }

  clear() {
    this._cache.clear();
    this._pending.clear();
  }
}

/* ═══════════════════════════════════════════════════════════════
   SECTION 4 — AUDIO LAYER
   Her bir ses katmanını (ambient, binaural beat, vb.) yönetir.
   Gapless loop + çatırtısız crossfade destekler.
═══════════════════════════════════════════════════════════════ */

/** @typedef {'idle'|'playing'|'paused'|'stopped'} LayerState */

class AudioLayer {
  /**
   * @param {string} id      — benzersiz katman adı
   * @param {string} type    — 'granular' | 'binaural' | 'file'
   * @param {object} params  — katman parametreleri
   */
  constructor(id, type, params = {}) {
    this.id = id;
    this.type = type;
    this.params = { volume: 0.5, pitch: 1.0, ...params };

    /** @type {AudioContext|null} */
    this._ctx = null;
    /** @type {GainNode|null} */
    this.gainNode = null;
    /** @type {AudioBufferSourceNode|null} — aktif kaynak */
    this._source = null;
    /** @type {AudioBufferSourceNode|null} — loop seam için hazırlanan kaynak */
    this._nextSource = null;
    /** @type {AudioWorkletNode|null} */
    this._workletNode = null;
    /** @type {AudioBuffer|null} */
    this._buffer = null;

    /** @type {LayerState} */
    this._state = 'idle';
    this._startTime = 0;
    this._pauseOffset = 0;
  }

  /* ── Başlatma ─────────────────────────────────────────────── */

  /**
   * @param {AudioContext} ctx
   * @param {GainNode} masterGain   — çıkışın bağlanacağı ana gain düğümü
   * @param {AudioBuffer|null} buffer — önceden preload edilmiş buffer (opsiyonel)
   */
  async initialize(ctx, masterGain, buffer = null) {
    this._ctx = ctx;
    this._buffer = buffer;

    this.gainNode = ctx.createGain();
    this.gainNode.gain.value = this.params.volume * AUDIO_CONFIG.MAX_TRACK_VOLUME;
    this.gainNode.connect(masterGain);

    if (this.type === 'granular' || this.type === 'binaural') {
      try {
        await this._initWorklet();
      } catch {
        this._initFallbackGenerator();
      }
    } else if (this.type === 'file' && this._buffer) {
      this._prepareBufferSource(this._buffer);
    }

    this._state = 'idle';
  }

  /* ── Worklet (Web / PWA) ──────────────────────────────────── */

  async _initWorklet() {
    const code = WORKLET_PROCESSOR_CODE;
    const blob = new Blob([code], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    await this._ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);

    this._workletNode = new AudioWorkletNode(this._ctx, 'ambient-processor');
    this._workletNode.port.postMessage({
      type: 'init',
      generator: this.params.generator || 'wind',
      sampleRate: this._ctx.sampleRate,
    });
    this._workletNode.connect(this.gainNode);
  }

  /* ── Fallback (AudioWorklet desteklenmeyen ortamlar) ─────── */

  _initFallbackGenerator() {
    const sampleRate = this._ctx.sampleRate;
    const bufferSize = sampleRate * AUDIO_CONFIG.PRELOAD_BUFFER_SECONDS;
    const buffer = this._ctx.createBuffer(2, bufferSize, sampleRate);

    for (let ch = 0; ch < 2; ch++) {
      const data = buffer.getChannelData(ch);
      this._fillGeneratorData(data, ch);
    }

    this._buffer = buffer;
    this._prepareBufferSource(buffer);
  }

  _fillGeneratorData(data, channel) {
    const gen = this.params.generator || 'wind';
    for (let i = 0; i < data.length; i++) {
      const t = i / this._ctx.sampleRate;
      switch (gen) {
        case 'rain':
          data[i] = (Math.random() * 2 - 1) * 0.25;
          break;
        case 'waves':
          data[i] = Math.sin(2 * Math.PI * 0.12 * t) * 0.18 + (Math.random() * 2 - 1) * 0.08;
          break;
        case 'binaural': {
          // Sol/sağ kanal frekans farkı ile binaural beat oluştur
          const baseFreq = this.params.baseFreq || 200;
          const beatFreq = this.params.beatFreq || 10;
          const chFreq = channel === 0 ? baseFreq : baseFreq + beatFreq;
          data[i] = Math.sin(2 * Math.PI * chFreq * t) * 0.12;
          break;
        }
        case 'fire':
          data[i] = (Math.random() * 2 - 1) * 0.15 * (0.8 + Math.sin(t * 3) * 0.2);
          break;
        default: // wind
          data[i] = (Math.random() * 2 - 1) * 0.15 * Math.abs(Math.sin(t * 0.5));
          break;
      }
    }
  }

  /* ── Buffer Source ────────────────────────────────────────── */

  _prepareBufferSource(buffer, startOffset = 0) {
    const src = this._ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    src.loopStart = 0;
    src.loopEnd = buffer.duration;
    src.playbackRate.value = this.params.pitch || 1.0;
    src.connect(this.gainNode);
    src.offset = startOffset;
    this._source = src;
    return src;
  }

  /* ── Oynatma Kontrolü ─────────────────────────────────────── */

  /**
   * Sesi başlatır. Eğer daha önce duraklattıysa kaldığı yerden devam eder.
   * @param {number} [when=0] — AudioContext zamanı (crossfade için kullanılır)
   */
  play(when = 0) {
    if (this._state === 'playing') return;

    const offset = this._pauseOffset;

    if (this._workletNode) {
      this._workletNode.port.postMessage({ type: 'play' });
    } else if (this._source) {
      // BufferSourceNode tek kullanımlık; pause→play için yeniden oluştur
      if (this._state === 'paused' && this._buffer) {
        this._prepareBufferSource(this._buffer, offset);
      }
      this._source.start(when, offset);
      this._startTime = this._ctx.currentTime - offset + when;
    }

    this._state = 'playing';
  }

  /**
   * Sesi duraklatır (konum kaydedilir).
   */
  pause() {
    if (this._state !== 'playing') return;
    this._pauseOffset = (this._ctx.currentTime - this._startTime) % (this._buffer?.duration || 1);

    if (this._workletNode) {
      this._workletNode.port.postMessage({ type: 'pause' });
    } else if (this._source) {
      this._source.stop();
      this._source = null;
    }

    this._state = 'paused';
  }

  /**
   * Sesi tamamen durdurur (konum sıfırlanır).
   */
  stop() {
    try {
      if (this._workletNode) {
        this._workletNode.port.postMessage({ type: 'stop' });
        this._workletNode.disconnect();
        this._workletNode = null;
      }
      if (this._source) {
        this._source.stop();
        this._source.disconnect();
        this._source = null;
      }
      if (this._nextSource) {
        this._nextSource.stop();
        this._nextSource.disconnect();
        this._nextSource = null;
      }
    } catch { /* bilerek yoksay — zaten durmuş olabilir */ }

    this._state = 'stopped';
    this._pauseOffset = 0;
  }

  /* ── Volume / Fade ────────────────────────────────────────── */

  /**
   * Anlık ses seviyesi değişimi.
   * @param {number} value — 0..1
   */
  setVolume(value) {
    this.params.volume = value;
    if (this.gainNode) {
      this.gainNode.gain.setTargetAtTime(
        value * AUDIO_CONFIG.MAX_TRACK_VOLUME,
        this._ctx.currentTime,
        0.05,
      );
    }
  }

  /**
   * Yumuşak fade animasyonu.
   * @param {number} targetVolume — 0..1
   * @param {number} duration     — saniye
   */
  fadeTo(targetVolume, duration = AUDIO_CONFIG.CROSSFADE_DURATION) {
    if (!this.gainNode) return;
    const now = this._ctx.currentTime;
    this.gainNode.gain.cancelScheduledValues(now);
    this.gainNode.gain.setValueAtTime(this.gainNode.gain.value, now);
    this.gainNode.gain.linearRampToValueAtTime(
      targetVolume * AUDIO_CONFIG.MAX_TRACK_VOLUME,
      now + duration,
    );
    this.params.volume = targetVolume;
  }

  /**
   * Fade-in (0 → hedef volume).
   */
  fadeIn(targetVolume = this.params.volume, duration = AUDIO_CONFIG.FADE_IN_DURATION) {
    if (!this.gainNode) return;
    const now = this._ctx.currentTime;
    this.gainNode.gain.cancelScheduledValues(now);
    this.gainNode.gain.setValueAtTime(0, now);
    this.gainNode.gain.linearRampToValueAtTime(
      targetVolume * AUDIO_CONFIG.MAX_TRACK_VOLUME,
      now + duration,
    );
  }

  /**
   * Fade-out (mevcut → 0). Promise, fade tamamlanınca resolve olur.
   * @returns {Promise<void>}
   */
  fadeOut(duration = AUDIO_CONFIG.FADE_OUT_DURATION) {
    return new Promise((resolve) => {
      if (!this.gainNode) { resolve(); return; }
      const now = this._ctx.currentTime;
      this.gainNode.gain.cancelScheduledValues(now);
      this.gainNode.gain.setValueAtTime(this.gainNode.gain.value, now);
      this.gainNode.gain.linearRampToValueAtTime(0, now + duration);
      setTimeout(resolve, duration * 1000);
    });
  }

  /* ── Parametre güncelleme ─────────────────────────────────── */

  setParameter(param, value) {
    this.params[param] = value;
    if (this._workletNode) {
      this._workletNode.port.postMessage({ type: 'param', [param]: value });
    }
    if (param === 'pitch' && this._source) {
      this._source.playbackRate.setTargetAtTime(value, this._ctx.currentTime, 0.1);
    }
  }

  /* ── Durum sorgusu ────────────────────────────────────────── */

  get isPlaying() { return this._state === 'playing'; }
  get isPaused()  { return this._state === 'paused';  }
  get isStopped() { return this._state === 'stopped' || this._state === 'idle'; }
}

/* ═══════════════════════════════════════════════════════════════
   SECTION 5 — AUDIO WORKLET PROCESSOR KODU
   (inline blob olarak yüklenir — harici dosya gerektirmez)
═══════════════════════════════════════════════════════════════ */

const WORKLET_PROCESSOR_CODE = /* js */ `
class AmbientProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super(options);
    this.generator = 'wind';
    this.phase = 0;
    this.active = true;
    this.port.onmessage = ({ data }) => {
      if (data.type === 'init')  { this.generator = data.generator || 'wind'; }
      if (data.type === 'param') { Object.assign(this, data); }
      if (data.type === 'stop')  { this.active = false; }
      if (data.type === 'play')  { this.active = true; }
      if (data.type === 'pause') { this.active = false; }
    };
  }

  process(inputs, outputs) {
    const out = outputs[0];
    for (let ch = 0; ch < out.length; ch++) {
      const channel = out[ch];
      for (let i = 0; i < channel.length; i++) {
        if (!this.active) { channel[i] = 0; continue; }
        switch (this.generator) {
          case 'rain':   channel[i] = (Math.random() * 2 - 1) * 0.22; break;
          case 'waves':  channel[i] = Math.sin(this.phase * 0.0008) * 0.18 + (Math.random() * 2 - 1) * 0.06; break;
          case 'fire':   channel[i] = (Math.random() * 2 - 1) * 0.14 * (0.8 + Math.sin(this.phase * 0.003) * 0.2); break;
          default:       channel[i] = (Math.random() * 2 - 1) * 0.14 * Math.abs(Math.sin(this.phase * 0.0002));
        }
        this.phase++;
      }
    }
    return true;
  }
}
registerProcessor('ambient-processor', AmbientProcessor);
`;

/* ═══════════════════════════════════════════════════════════════
   SECTION 6 — AUDIO ENGINE (Singleton)
═══════════════════════════════════════════════════════════════ */

class AudioEngine {
  constructor() {
    if (AudioEngine._instance) return AudioEngine._instance;
    AudioEngine._instance = this;

    /** @type {AudioContext|null} */
    this._ctx = null;
    /** @type {GainNode|null} */
    this._masterGain = null;
    /** @type {AnalyserNode|null} */
    this._analyser = null;
    /** @type {Map<string, AudioLayer>} */
    this._layers = new Map();
    /** @type {boolean} */
    this.isInitialized = false;
    /** @type {Promise<void>|null} */
    this._initPromise = null;
    /** @type {boolean} */
    this._playing = false;

    /* Background audio state */
    this._appInBackground = false;
    this._backgroundVolume = 0.4;  // arka planda düşürülen volume

    this._adapter = new WebAudioAdapter();
    this._preloadCache = new PreloadCache();

    /* Session tracking */
    this._sessionStart = null;

    /* Event listeners */
    this._listeners = new Map();

    this._attachAppStateListeners();
  }

  /** Singleton erişim noktası */
  static getInstance() {
    if (!AudioEngine._instance) new AudioEngine();
    return AudioEngine._instance;
  }

  /* ── Başlatma ─────────────────────────────────────────────── */

  /**
   * AudioContext'i başlatır. Kullanıcı etkileşiminden sonra çağrılmalıdır.
   * İkinci çağrı idempotent'tir.
   */
  async initialize() {
    if (this.isInitialized) return;
    if (this._initPromise) return this._initPromise;

    this._initPromise = (async () => {
      try {
        this._ctx = this._adapter.createContext();
        await this._adapter.resumeContext(this._ctx);

        /* Master gain zinciri: Layer → masterGain → analyser → destination */
        this._masterGain = this._ctx.createGain();
        this._masterGain.gain.value = AUDIO_CONFIG.DEFAULT_MASTER_VOLUME;

        this._analyser = this._ctx.createAnalyser();
        this._analyser.fftSize = AUDIO_CONFIG.FFT_SIZE;
        this._analyser.smoothingTimeConstant = AUDIO_CONFIG.SMOOTHING;

        this._masterGain.connect(this._analyser);
        this._analyser.connect(this._ctx.destination);

        this.isInitialized = true;
        this._emit('initialized');
      } catch (err) {
        this._initPromise = null;
        throw err;
      } finally {
        this._initPromise = null;
      }
    })();

    return this._initPromise;
  }

  async _ensureReady() {
    if (!this.isInitialized) await this.initialize();
    await this._adapter.resumeContext(this._ctx);
  }

  /* ── Preload ──────────────────────────────────────────────── */

  /**
   * Ses dosyalarını önceden buffer'a alır.
   * Uygulama açılışında veya sahne geçişi öncesinde çağrılmalıdır.
   *
   * @param {string[]} uris — ses dosyası URL'leri
   */
  async preload(uris = []) {
    await this._ensureReady();
    await this._preloadCache.preloadMany(this._ctx, uris, this._adapter);
    this._emit('preloadComplete', { uris });
  }

  /* ── Sahne yükleme ────────────────────────────────────────── */

  /**
   * Bir "scene script"i yükler. Mevcut katmanlar crossfade ile geçiş yapar.
   *
   * Script formatı:
   * {
   *   scene: string,
   *   tracks: [{ id, type, generator, parameters, uri? }],
   *   mix: { masterVolume, trackVolumes[] }
   * }
   *
   * @param {object} script
   * @param {{ crossfade?: boolean, crossfadeDuration?: number }} options
   */
  async loadScript(script, options = {}) {
    if (!script?.tracks) throw new Error('[AudioEngine] Geçersiz script formatı.');
    await this._ensureReady();

    const {
      crossfade = true,
      crossfadeDuration = AUDIO_CONFIG.CROSSFADE_DURATION,
    } = options;

    /* 1. Yeni katmanları hazırla (preload dahil) */
    const incoming = await this._buildLayers(script);

    if (crossfade && this._layers.size > 0 && this._playing) {
      await this._crossfadeTo(incoming, crossfadeDuration);
    } else {
      await this._stopAllLayers();
      this._layers = incoming;
      if (script.mix?.masterVolume != null) {
        this._masterGain.gain.value = script.mix.masterVolume;
      }
      if (this._playing) this._startAllLayers();
    }

    this._emit('scriptLoaded', { scene: script.scene, trackCount: incoming.size });
    return script;
  }

  /**
   * Script'ten AudioLayer Map'i oluşturur (henüz başlatmaz).
   * @private
   */
  async _buildLayers(script) {
    const limit = Math.min(script.tracks.length, AUDIO_CONFIG.MAX_LAYERS);
    const map = new Map();

    for (let i = 0; i < limit; i++) {
      const track = script.tracks[i];
      const id = track.id || track.generator || `track_${i}`;

      /* Buffer preload (file tipi katmanlar için) */
      let buffer = null;
      if (track.uri) {
        buffer = this._preloadCache.has(track.uri)
          ? this._preloadCache.get(track.uri)
          : await this._preloadCache.load(this._ctx, track.uri, this._adapter);
      }

      const volume = script.mix?.trackVolumes?.[i] ?? track.parameters?.volume ?? 0.5;
      const layer = new AudioLayer(id, track.type || 'granular', { ...track.parameters, volume });
      await layer.initialize(this._ctx, this._masterGain, buffer);

      map.set(id, layer);
    }

    return map;
  }

  /* ── Crossfade ────────────────────────────────────────────── */

  /**
   * Mevcut katmanları fade-out, yeni katmanları fade-in ile geçiş yapar.
   * "Patlama" / "çıtırtı" olmaması için her katman ayrı gain eğrisiyle yönetilir.
   * @private
   */
  async _crossfadeTo(incomingMap, duration) {
    const outgoing = this._layers;

    /* Önce yeni katmanları sıfır volume'dan başlat */
    incomingMap.forEach((layer) => {
      layer.gainNode.gain.setValueAtTime(0, this._ctx.currentTime);
      layer.play();
    });

    /* Paralel fade: eski → 0, yeni → hedef */
    await Promise.all([
      ...Array.from(outgoing.values()).map((layer) =>
        layer.fadeOut(duration).then(() => layer.stop()),
      ),
      ...Array.from(incomingMap.values()).map((layer) =>
        layer.fadeIn(layer.params.volume, duration),
      ),
    ]);

    this._layers = incomingMap;
  }

  /* ── Oynatma Kontrolleri ──────────────────────────────────── */

  /**
   * Sesi oynatır. İlk çağrıda AudioContext başlatılır.
   */
  async play() {
    await this._ensureReady();
    if (this._playing) return;

    this._startAllLayers();
    this._playing = true;
    this._sessionStart = Date.now();
    this._emit('play');
  }

  /**
   * Sesi duraklatır (konum korunur).
   */
  async pause() {
    if (!this._playing) return;
    this._layers.forEach((layer) => layer.pause());
    await this._adapter.suspendContext(this._ctx);
    this._playing = false;
    this._emit('pause');
  }

  /**
   * Sesi durdurur (konum sıfırlanır). Seans kaydedilir.
   * @returns {{ duration: number }} — seans bilgisi
   */
  async stop() {
    const sessionInfo = this._finalizeSession();
    await this._stopAllLayers();
    await this._adapter.suspendContext(this._ctx);
    this._playing = false;
    this._emit('stop', sessionInfo);
    return sessionInfo;
  }

  /**
   * Play/pause toggle — UI düğmesi için pratik kısayol.
   */
  async togglePlay() {
    if (this._playing) {
      await this.pause();
    } else {
      await this.play();
    }
    return this._playing;
  }

  /* ── Volume / Fade ────────────────────────────────────────── */

  /**
   * Master volume'u ayarlar (0..1).
   * @param {number} value
   */
  setMasterVolume(value) {
    if (!this._masterGain) return;
    const clamped = Math.max(0, Math.min(1, value));
    this._masterGain.gain.setTargetAtTime(clamped, this._ctx?.currentTime ?? 0, 0.05);
    this._emit('volumeChange', { master: clamped });
  }

  /**
   * Tek bir katmanın ses seviyesini ayarlar.
   * @param {string} layerId
   * @param {number} value   — 0..1
   */
  setLayerVolume(layerId, value) {
    const layer = this._layers.get(layerId);
    if (layer) layer.setVolume(value);
  }

  /**
   * Tüm sesi kademeli olarak kapatır (sleep timer için).
   * @param {number} duration — saniye
   */
  async fadeOutAll(duration = 3) {
    if (!this._masterGain || !this._ctx) return;
    const now = this._ctx.currentTime;
    this._masterGain.gain.cancelScheduledValues(now);
    this._masterGain.gain.setValueAtTime(this._masterGain.gain.value, now);
    this._masterGain.gain.linearRampToValueAtTime(0, now + duration);
    return new Promise((resolve) => setTimeout(resolve, duration * 1000));
  }

  /**
   * Katman parametresi günceller (pitch, intensity vb.).
   * @param {string} layerId
   * @param {string} param
   * @param {number|string} value
   */
  setLayerParameter(layerId, param, value) {
    const layer = this._layers.get(layerId);
    if (layer) layer.setParameter(param, value);
  }

  /* ── Analiz verisi ────────────────────────────────────────── */

  /**
   * Visualizer için anlık frekans verisi döndürür.
   * @returns {{ frequencies: number[], peak: number, average: number }|null}
   */
  getAudioData() {
    if (!this._analyser) return null;
    try {
      const data = new Uint8Array(this._analyser.frequencyBinCount);
      this._analyser.getByteFrequencyData(data);
      let sum = 0, peak = 0;
      for (let i = 0; i < data.length; i++) {
        sum += data[i];
        if (data[i] > peak) peak = data[i];
      }
      return {
        frequencies: Array.from(data),
        peak: peak / 255,
        average: (sum / data.length) / 255,
      };
    } catch {
      return null;
    }
  }

  /* ── Durum sorgulama ─────────────────────────────────────── */

  get isPlaying()     { return this._playing; }
  get masterVolume()  { return this._masterGain?.gain.value ?? 0; }
  get activeLayers()  { return Array.from(this._layers.keys()); }
  get contextState()  { return this._ctx?.state ?? 'closed'; }

  /* ── Background Audio ────────────────────────────────────── */

  /**
   * Uygulama arka plana geçtiğinde çağrılır.
   * React Native'de AppState listener'ı ile bağlantılandırılır.
   */
  handleAppBackground() {
    if (this._appInBackground) return;
    this._appInBackground = true;

    // Arka planda volume'u düşür (pil tasarrufu + diğer uygulamalar için)
    if (this._masterGain && this._ctx) {
      this._masterGain.gain.setTargetAtTime(
        this._backgroundVolume,
        this._ctx.currentTime,
        0.3,
      );
    }
    this._emit('background');
  }

  /**
   * Uygulama ön plana döndüğünde çağrılır.
   */
  async handleAppForeground() {
    if (!this._appInBackground) return;
    this._appInBackground = false;

    await this._adapter.resumeContext(this._ctx);
    if (this._masterGain && this._ctx) {
      this._masterGain.gain.setTargetAtTime(
        AUDIO_CONFIG.DEFAULT_MASTER_VOLUME,
        this._ctx.currentTime,
        0.3,
      );
    }
    this._emit('foreground');
  }

  _attachAppStateListeners() {
    if (typeof document === 'undefined') return;

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        this.handleAppBackground();
      } else {
        this.handleAppForeground();
      }
    });

    // React Native WebView mesajlarını da dinle
    if (typeof window !== 'undefined') {
      const handler = (event) => {
        try {
          const data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
          if (data?.type === 'APP_STATE_CHANGE') {
            if (data.state === 'background') this.handleAppBackground();
            if (data.state === 'active')     this.handleAppForeground();
          }
        } catch { /* yoksay */ }
      };
      window.addEventListener('message', handler);
      document.addEventListener('message', handler);
    }
  }

  /* ── Seans yönetimi ──────────────────────────────────────── */

  _finalizeSession() {
    if (!this._sessionStart) return { duration: 0 };
    const duration = Math.floor((Date.now() - this._sessionStart) / 1000);
    this._sessionStart = null;
    return { duration, timestamp: new Date().toISOString() };
  }

  /* ── Dahili yardımcılar ───────────────────────────────────── */

  _startAllLayers() {
    this._layers.forEach((layer) => {
      if (!layer.isPlaying) layer.play();
    });
  }

  async _stopAllLayers() {
    this._layers.forEach((layer) => layer.stop());
    this._layers.clear();
  }

  /* ── Olay sistemi (EventEmitter benzeri) ─────────────────── */

  /**
   * Olay dinleyicisi ekler.
   * @param {string} event
   * @param {Function} callback
   * @returns {Function} — unsubscribe fonksiyonu
   */
  on(event, callback) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(callback);
    return () => this._listeners.get(event)?.delete(callback);
  }

  _emit(event, payload) {
    this._listeners.get(event)?.forEach((cb) => {
      try { cb(payload); } catch (err) { console.warn('[AudioEngine] Listener error:', err); }
    });
  }

  /* ── Temizleme ────────────────────────────────────────────── */

  /**
   * Tüm kaynakları serbest bırakır. Uygulama kapanırken çağrılmalıdır.
   */
  async dispose() {
    await this._stopAllLayers();
    this._preloadCache.clear();
    await this._adapter.closeContext(this._ctx);
    this._ctx = null;
    this._masterGain = null;
    this._analyser = null;
    this.isInitialized = false;
    this._playing = false;
    this._listeners.clear();
    AudioEngine._instance = null;
    this._emit('disposed');
  }
}

/** @type {AudioEngine|null} */
AudioEngine._instance = null;

/* ═══════════════════════════════════════════════════════════════
   SECTION 7 — MEVCUT audioOrchestrator İLE UYUMLULUK KÖPRÜSÜ
   app.js'deki mevcut çağrıları kırmadan drop-in replacement sağlar.
═══════════════════════════════════════════════════════════════ */

/**
 * Eski `audioOrchestrator` API'sini yeni AudioEngine üzerine yönlendirir.
 * `app.js` içinde:
 *   const audioOrchestrator = createLegacyAdapter();
 * satırıyla mevcut kodu sıfır değişiklikle çalıştırabilirsiniz.
 */
function createLegacyAdapter() {
  const engine = AudioEngine.getInstance();

  return {
    get isInitialized()   { return engine.isInitialized; },
    get masterGain()      { return engine._masterGain; },
    get analyser()        { return engine._analyser; },

    initialize:           ()           => engine.initialize(),
    loadScript:           (script)     => engine.loadScript(script),
    startAllLayers:       ()           => engine._startAllLayers(),
    stopAllLayers:        ()           => engine._stopAllLayers(),
    togglePlay:           ()           => engine.togglePlay(),
    setTrackVolume:       (id, vol)    => engine.setLayerVolume(id, vol),
    updateTrackParameter: (id, p, v)   => engine.setLayerParameter(id, p, v),
    getAudioData:         ()           => engine.getAudioData(),
    stopAndSaveSession:   ()           => Promise.resolve(engine._finalizeSession()),
    dispose:              ()           => engine.dispose(),
  };
}

/* ═══════════════════════════════════════════════════════════════
   EXPORTS
═══════════════════════════════════════════════════════════════ */

// ES Module

// CommonJS / React Native Metro Bundler uyumluluğu
if (typeof module !== 'undefined') {
  module.exports = AudioEngine;
  module.exports.AudioEngine = AudioEngine;
  module.exports.AudioLayer = AudioLayer;
  module.exports.PreloadCache = PreloadCache;
  module.exports.WebAudioAdapter = WebAudioAdapter;
  module.exports.createLegacyAdapter = createLegacyAdapter;
  module.exports.AUDIO_CONFIG = AUDIO_CONFIG;
}

/* === StateManager === */
/**
 * StateManager.js
 * ================
 * Ambient AI Ses Orkestrasyonu uygulaması için merkezi state yönetim sınıfı.
 *
 * Tasarım ilkeleri:
 *  - Observer Pattern  → subscribe/notify ile reaktif UI güncellemeleri
 *  - Persistence       → StorageAdapter üzerinden otomatik hydration & persist
 *  - Security Layer    → Premium ve kısıtlı içerik için doğrulama katmanı
 *  - Zero DOM          → Hiçbir document/window referansı yok; saf iş mantığı
 *  - Portable          → Zustand/Redux'a taşınabilir slice yapısı
 *
 * Kullanım:
 *   const manager = new StateManager(storageAdapter);
 *   await manager.hydrate();
 *   const unsub = manager.subscribe('playing', (val) => updateUI(val));
 *   manager.setPlaying(true);
 *   unsub(); // aboneliği kaldır
 */

// ─── Tip Sabitleri ────────────────────────────────────────────────────────────

/** @enum {string} */
const Mood = Object.freeze({
  NEUTRAL:    'neutral',
  FOCUS:      'odaklanma',
  RELAX:      'rahatlama',
  MEDITATION: 'meditasyon',
  SLEEP:      'uyku',
});

/** @enum {string} */
const PremiumPlan = Object.freeze({
  NONE:  'none',
  BASIC: 'basic',
  PRO:   'pro',
});

/** @enum {string} */
const BillingCycle = Object.freeze({
  MONTHLY: 'monthly',
  YEARLY:  'yearly',
});

// ─── Varsayılan (Initial) State ───────────────────────────────────────────────

const DEFAULT_STATE = Object.freeze({
  // ── Oynatma ──────────────────────────────────────────────────────────────
  playing:              false,
  currentScene:         'sessiz orman',
  audioTracks:          [],           // [{ name, volume, parameters }]
  masterVolume:         0.8,
  intensity:            0.5,

  // ── Ruh Hali ─────────────────────────────────────────────────────────────
  selectedMood:         Mood.NEUTRAL,

  // ── Seans ────────────────────────────────────────────────────────────────
  sessionStartTime:     null,         // epoch ms | null
  currentSessionDuration: 0,          // saniye

  // ── Uyku Zamanlayıcı ─────────────────────────────────────────────────────
  isTimerActive:        false,
  sleepTimer:           null,         // dakika | null
  sleepTimerEnd:        null,         // epoch ms | null

  // ── Premium & Abonelik ────────────────────────────────────────────────────
  isPremium:            false,
  premiumPlan:          PremiumPlan.NONE,
  billingCycle:         BillingCycle.MONTHLY,
  premiumExpiresAt:     null,         // ISO string | null

  // ── Kullanıcı Tercihleri ──────────────────────────────────────────────────
  bannerDismissed:      false,
  apiKey:               '',           // Gemini API key (şifreli saklanmalı)
  language:             'tr-TR',

  // ── Uygulama Meta ─────────────────────────────────────────────────────────
  isInitialized:        false,
  lastOpenDate:         null,         // ISO string | null
});

// ─── Kalıcı Saklanacak Key'ler ────────────────────────────────────────────────
// Sadece bu key'ler StorageAdapter'a yazılır; audioContext gibi runtime
// nesneler kasıtlı olarak hariç tutulmuştur.

const PERSISTED_KEYS = new Set([
  'selectedMood',
  'isPremium',
  'premiumPlan',
  'billingCycle',
  'premiumExpiresAt',
  'bannerDismissed',
  'apiKey',
  'language',
  'masterVolume',
  'lastOpenDate',
]);

// ─── Kısıtlı İçerik Tanımları ─────────────────────────────────────────────────
// { [sceneName]: minPlan }
const CONTENT_PERMISSIONS = {
  'derin_odak_pro':   PremiumPlan.PRO,
  'binaural_beats':   PremiumPlan.BASIC,
  'uyku_hipnozu':     PremiumPlan.BASIC,
  'aktif_meditasyon': PremiumPlan.BASIC,
};

// Plan hiyerarşisi (yüksek index = daha yüksek erişim)
const PLAN_RANK = {
  [PremiumPlan.NONE]:  0,
  [PremiumPlan.BASIC]: 1,
  [PremiumPlan.PRO]:   2,
};

// ─── StorageAdapter Arayüzü ───────────────────────────────────────────────────
/**
 * StateManager, bağımlılık enjeksiyonu yoluyla herhangi bir storage
 * implementasyonunu kabul eder. Bu sayede localStorage, AsyncStorage
 * (React Native) veya şifreli storage kolayca takılabilir.
 *
 * @typedef {Object} StorageAdapter
 * @property {function(string): Promise<string|null>} get
 * @property {function(string, string): Promise<void>} set
 * @property {function(string): Promise<void>} remove
 */

// ─── Ana Sınıf ────────────────────────────────────────────────────────────────

class StateManager {
  /** @type {Object} */
  #state;

  /**
   * Anahtar bazlı abone Map'i.
   * Her key için birden fazla listener desteklenir.
   * @type {Map<string, Set<Function>>}
   */
  #keyListeners;

  /**
   * Her state değişikliğinde çağrılan global listener'lar.
   * @type {Set<Function>}
   */
  #globalListeners;

  /** @type {StorageAdapter|null} */
  #storage;

  /** @type {Map<string, ReturnType<typeof setTimeout>>} */
  #persistDebounceTimers;

  /** @type {Set<ReturnType<typeof setTimeout>>} */
  #timers;

  /** @type {boolean} */
  #hydrated;

  /**
   * @param {StorageAdapter|null} storageAdapter
   *   null geçilirse persistence devre dışı kalır (test ortamı için kullanışlı).
   */
  constructor(storageAdapter = null) {
    this.#state                = { ...DEFAULT_STATE };
    this.#keyListeners         = new Map();
    this.#globalListeners      = new Set();
    this.#storage              = storageAdapter;
    this.#persistDebounceTimers = new Map();
    this.#timers               = new Set();
    this.#hydrated             = false;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // BÖLÜM 1 — Temel get / set
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Bir state değerini okur.
   * @template {keyof DEFAULT_STATE} K
   * @param {K} key
   * @returns {typeof DEFAULT_STATE[K]}
   */
  get(key) {
    return this.#state[key];
  }

  /**
   * Ham state değeri atar; doğrulama veya persistence OLMADAN.
   * Dahili kullanım içindir; dışarıdan çağırmaktan kaçının.
   * @private
   */
  #rawSet(key, value) {
    const prev = this.#state[key];
    if (Object.is(prev, value)) return; // değişim yoksa notify etme

    this.#state[key] = value;
    this.#notify(key, value, prev);

    if (PERSISTED_KEYS.has(key)) {
      this.#schedulePersist(key, value);
    }
  }

  /**
   * State'in anlık kopyasını döndürür (immutable snapshot).
   * @returns {Readonly<typeof DEFAULT_STATE>}
   */
  getSnapshot() {
    return Object.freeze({ ...this.#state });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // BÖLÜM 2 — Observer / Pub-Sub
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Belirli bir key için reaktif abone olur.
   *
   * @param {string} key          State anahtarı (örn: 'playing')
   * @param {Function} listener   (newValue, prevValue) => void
   * @returns {Function}          Aboneliği iptal eden fonksiyon (unsubscribe)
   *
   * @example
   *   const off = stateManager.subscribe('playing', (val) => setIcon(val));
   *   // ... temizleme sırasında:
   *   off();
   */
  subscribe(key, listener) {
    if (!this.#keyListeners.has(key)) {
      this.#keyListeners.set(key, new Set());
    }
    this.#keyListeners.get(key).add(listener);

    return () => {
      this.#keyListeners.get(key)?.delete(listener);
    };
  }

  /**
   * Tüm state değişikliklerini dinler.
   *
   * @param {Function} listener  ({ key, newValue, prevValue }) => void
   * @returns {Function}         Aboneliği iptal eden fonksiyon
   */
  subscribeAll(listener) {
    this.#globalListeners.add(listener);
    return () => this.#globalListeners.delete(listener);
  }

  /**
   * Birden fazla key'i tek listener ile dinler.
   *
   * @param {string[]} keys
   * @param {Function} listener
   * @returns {Function} Tüm abonelikleri iptal eden fonksiyon
   */
  subscribeMany(keys, listener) {
    const unsubs = keys.map((k) => this.subscribe(k, listener));
    return () => unsubs.forEach((fn) => fn());
  }

  /**
   * @private
   */
  #notify(key, newValue, prevValue) {
    // Key-specific listeners
    this.#keyListeners.get(key)?.forEach((fn) => {
      try { fn(newValue, prevValue); }
      catch (err) { console.error(`[StateManager] Listener hatası (${key}):`, err); }
    });

    // Global listeners
    this.#globalListeners.forEach((fn) => {
      try { fn({ key, newValue, prevValue }); }
      catch (err) { console.error('[StateManager] Global listener hatası:', err); }
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // BÖLÜM 3 — Persistence (Hydration & Persist)
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Uygulama başlatıldığında storage'dan state'i geri yükler.
   * DOMContentLoaded öncesinde bir kez çağrılmalıdır.
   *
   * @returns {Promise<void>}
   */
  async hydrate() {
    if (!this.#storage) {
      this.#hydrated = true;
      return;
    }

    const loadPromises = [...PERSISTED_KEYS].map(async (key) => {
      try {
        const raw = await this.#storage.get(`state:${key}`);
        if (raw !== null && raw !== undefined) {
          const parsed = this.#deserialize(key, raw);
          this.#state[key] = parsed; // notify olmadan doğrudan yaz
        }
      } catch (err) {
        console.warn(`[StateManager] Hydration hatası (${key}):`, err);
      }
    });

    await Promise.all(loadPromises);

    // Süresi dolmuş premium aboneliği temizle
    this.#validatePremiumExpiry();

    this.#hydrated = true;
    this.#notify('isInitialized', true, false);
    this.#state.isInitialized = true;
  }

  /**
   * @private
   * Debounced persist — aynı key için art arda set çağrılarında
   * sadece son değer kaydedilir (16ms gecikme).
   */
  #schedulePersist(key, value) {
    if (!this.#storage) return;

    const existing = this.#persistDebounceTimers.get(key);
    if (existing) clearTimeout(existing);

    const id = setTimeout(async () => {
      this.#persistDebounceTimers.delete(key);
      try {
        await this.#storage.set(`state:${key}`, this.#serialize(key, value));
      } catch (err) {
        console.error(`[StateManager] Persist hatası (${key}):`, err);
      }
    }, 16);

    this.#persistDebounceTimers.set(key, id);
  }

  /** @private */
  #serialize(key, value) {
    return JSON.stringify(value);
  }

  /** @private */
  #deserialize(key, raw) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }

  /**
   * Tüm kalıcı state'i storage'dan siler.
   * @returns {Promise<void>}
   */
  async clearPersistedState() {
    if (!this.#storage) return;
    await Promise.all(
      [...PERSISTED_KEYS].map((k) => this.#storage.remove(`state:${k}`).catch(() => {}))
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // BÖLÜM 4 — Oynatma & Ses Kontrolü
  // ══════════════════════════════════════════════════════════════════════════

  setPlaying(value) {
    this.#rawSet('playing', Boolean(value));
  }

  setCurrentScene(scene) {
    if (typeof scene !== 'string' || !scene.trim()) {
      throw new TypeError('[StateManager] Geçersiz sahne adı');
    }
    this.#rawSet('currentScene', scene.trim());
  }

  setAudioTracks(tracks) {
    if (!Array.isArray(tracks)) {
      throw new TypeError('[StateManager] audioTracks bir dizi olmalıdır');
    }
    this.#rawSet('audioTracks', tracks);
  }

  updateTrackVolume(trackName, volume) {
    const clampedVol = Math.min(1, Math.max(0, volume));
    const tracks = this.#state.audioTracks.map((t) =>
      t.name === trackName ? { ...t, volume: clampedVol } : t
    );
    this.#rawSet('audioTracks', tracks);
  }

  setMasterVolume(volume) {
    const clamped = Math.min(1, Math.max(0, volume));
    this.#rawSet('masterVolume', clamped);
  }

  setIntensity(value) {
    const clamped = Math.min(1, Math.max(0, value));
    this.#rawSet('intensity', clamped);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // BÖLÜM 5 — Ruh Hali
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * @param {Mood[keyof Mood]} mood
   */
  setSelectedMood(mood) {
    const validMoods = Object.values(Mood);
    if (!validMoods.includes(mood)) {
      throw new RangeError(
        `[StateManager] Geçersiz mood: "${mood}". Geçerli değerler: ${validMoods.join(', ')}`
      );
    }
    this.#rawSet('selectedMood', mood);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // BÖLÜM 6 — Seans Yönetimi
  // ══════════════════════════════════════════════════════════════════════════

  startSession() {
    const now = Date.now();
    this.#rawSet('sessionStartTime', now);
    this.#rawSet('currentSessionDuration', 0);
  }

  /**
   * Seansı bitirir ve süreyi hesaplayıp döndürür.
   * @returns {{ duration: number, mood: string, scene: string, date: string } | null}
   */
  endSession() {
    const start = this.#state.sessionStartTime;
    if (!start) return null;

    const duration = Math.floor((Date.now() - start) / 1000);
    this.#rawSet('currentSessionDuration', duration);
    this.#rawSet('sessionStartTime', null);

    return {
      duration,
      mood:  this.#state.selectedMood,
      scene: this.#state.currentScene,
      date:  new Date().toISOString(),
    };
  }

  /**
   * Aktif seans süresini sorgular (oynarken).
   * @returns {number} Saniye cinsinden geçen süre
   */
  getCurrentSessionDuration() {
    const start = this.#state.sessionStartTime;
    if (!start) return 0;
    return Math.floor((Date.now() - start) / 1000);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // BÖLÜM 7 — Uyku Zamanlayıcı
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Uyku zamanlayıcısını başlatır.
   * @param {number} minutes - 1-180 arası bir değer
   * @param {function(): void} onExpire - Süre dolduğunda çağrılır (DOM-free callback)
   * @param {number} [maxMinutes=180]
   */
  setSleepTimer(minutes, onExpire, maxMinutes = 180) {
    if (!Number.isFinite(minutes) || minutes <= 0 || minutes > maxMinutes) {
      throw new RangeError(`[StateManager] Geçersiz zamanlayıcı süresi: ${minutes}`);
    }

    this.cancelSleepTimer();

    const endTime = Date.now() + minutes * 60 * 1000;

    this.#rawSet('isTimerActive', true);
    this.#rawSet('sleepTimer', minutes);
    this.#rawSet('sleepTimerEnd', endTime);

    const timerId = setTimeout(() => {
      this.#rawSet('isTimerActive', false);
      this.#rawSet('sleepTimer', null);
      this.#rawSet('sleepTimerEnd', null);
      this.#timers.delete(timerId);

      if (typeof onExpire === 'function') {
        try { onExpire(); }
        catch (err) { console.error('[StateManager] onExpire hatası:', err); }
      }
    }, minutes * 60 * 1000);

    this.#timers.add(timerId);
    return timerId;
  }

  cancelSleepTimer() {
    this.#rawSet('isTimerActive', false);
    this.#rawSet('sleepTimer', null);
    this.#rawSet('sleepTimerEnd', null);
  }

  /**
   * Kalan zamanlayıcı süresini saniye olarak döndürür.
   * @returns {number}
   */
  getRemainingTimerSeconds() {
    const end = this.#state.sleepTimerEnd;
    if (!end) return 0;
    return Math.max(0, Math.floor((end - Date.now()) / 1000));
  }

  // ══════════════════════════════════════════════════════════════════════════
  // BÖLÜM 8 — Premium & Güvenlik Katmanı
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Premium aboneliği aktif eder.
   *
   * @param {object} params
   * @param {PremiumPlan[keyof PremiumPlan]} params.plan
   * @param {BillingCycle[keyof BillingCycle]} params.billingCycle
   * @param {string|null} [params.expiresAt] - ISO date string
   * @param {string} [params.receiptToken]   - Sunucu tarafı doğrulama için
   * @throws {Error} Plan doğrulama başarısız olursa
   */
  setPremiumStatus({ plan, billingCycle, expiresAt = null, receiptToken = '' }) {
    // — Temel doğrulama —
    if (!Object.values(PremiumPlan).includes(plan)) {
      throw new RangeError(`[StateManager] Geçersiz plan: ${plan}`);
    }
    if (!Object.values(BillingCycle).includes(billingCycle)) {
      throw new RangeError(`[StateManager] Geçersiz fatura döngüsü: ${billingCycle}`);
    }
    if (plan === PremiumPlan.NONE) {
      throw new Error('[StateManager] setPremiumStatus ile NONE plan kurulamaz. revokePremium kullanın.');
    }

    // — İmzalı token kontrolü (stub; gerçek uygulamada sunucu isteği) —
    if (!this.#validatePurchaseToken(receiptToken)) {
      console.warn('[StateManager] Receipt token doğrulanamadı, offline geçiş yapılıyor.');
    }

    this.#rawSet('isPremium', true);
    this.#rawSet('premiumPlan', plan);
    this.#rawSet('billingCycle', billingCycle);
    this.#rawSet('premiumExpiresAt', expiresAt);
  }

  /**
   * Premium aboneliği iptal eder / geri alır.
   */
  revokePremium() {
    this.#rawSet('isPremium', false);
    this.#rawSet('premiumPlan', PremiumPlan.NONE);
    this.#rawSet('premiumExpiresAt', null);
  }

  /**
   * Kullanıcının belirli bir içeriğe erişim iznini kontrol eder.
   *
   * @param {string} contentId   - CONTENT_PERMISSIONS içindeki bir key
   * @returns {{ allowed: boolean, reason: string }}
   *
   * @example
   *   const { allowed, reason } = stateManager.checkContentAccess('binaural_beats');
   *   if (!allowed) showPaywall(reason);
   */
  checkContentAccess(contentId) {
    const requiredPlan = CONTENT_PERMISSIONS[contentId];

    // Kayıtlı kısıtlama yoksa herkese açık içerik
    if (!requiredPlan) {
      return { allowed: true, reason: '' };
    }

    if (!this.#state.isPremium) {
      return {
        allowed: false,
        reason: `Bu içerik premium üyelik gerektiriyor (${requiredPlan}).`,
      };
    }

    const userRank     = PLAN_RANK[this.#state.premiumPlan] ?? 0;
    const requiredRank = PLAN_RANK[requiredPlan] ?? 0;

    if (userRank < requiredRank) {
      return {
        allowed: false,
        reason: `Bu içerik ${requiredPlan} planı gerektiriyor. Mevcut planınız: ${this.#state.premiumPlan}.`,
      };
    }

    // Süre dolmuşsa erişimi kapat
    if (this.#isPremiumExpired()) {
      this.revokePremium();
      return { allowed: false, reason: 'Premium aboneliğinizin süresi dolmuş.' };
    }

    return { allowed: true, reason: '' };
  }

  /**
   * Kısıtlı bir sahneye geçmeden önce erişim kontrolü yapar.
   * İzin yoksa Error fırlatır; izin varsa sahneyi set eder.
   *
   * @param {string} scene
   * @throws {Error} Erişim reddedilirse
   */
  unlockContent(scene) {
    const { allowed, reason } = this.checkContentAccess(scene);
    if (!allowed) {
      throw new Error(`[StateManager] Erişim reddedildi — ${reason}`);
    }
    this.setCurrentScene(scene);
  }

  /** @private */
  #validatePurchaseToken(token) {
    // Gerçek uygulamada: backend'e /verify-receipt isteği atılır.
    // Burada minimum bir format kontrolü yapılır.
    return typeof token === 'string' && token.length > 0;
  }

  /** @private */
  #validatePremiumExpiry() {
    const expiresAt = this.#state.premiumExpiresAt;
    if (expiresAt && new Date(expiresAt) < new Date()) {
      this.#state.isPremium    = false;
      this.#state.premiumPlan  = PremiumPlan.NONE;
      this.#state.premiumExpiresAt = null;
    }
  }

  /** @private */
  #isPremiumExpired() {
    const exp = this.#state.premiumExpiresAt;
    return exp ? new Date(exp) < new Date() : false;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // BÖLÜM 9 — Kullanıcı Tercihleri
  // ══════════════════════════════════════════════════════════════════════════

  setBannerDismissed(value) {
    this.#rawSet('bannerDismissed', Boolean(value));
  }

  setApiKey(key) {
    if (typeof key !== 'string') {
      throw new TypeError('[StateManager] API key string olmalıdır');
    }
    this.#rawSet('apiKey', key);
  }

  setLanguage(lang) {
    this.#rawSet('language', lang);
  }

  setBillingCycle(cycle) {
    if (!Object.values(BillingCycle).includes(cycle)) {
      throw new RangeError(`[StateManager] Geçersiz fatura döngüsü: ${cycle}`);
    }
    this.#rawSet('billingCycle', cycle);
  }

  setLastOpenDate(isoString = new Date().toISOString()) {
    this.#rawSet('lastOpenDate', isoString);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // BÖLÜM 10 — Timer & Kaynak Yönetimi
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Harici timer ID'lerini StateManager'a kaydeder.
   * dispose() çağrıldığında otomatik olarak temizlenir.
   * @param {ReturnType<typeof setTimeout>} timerId
   */
  registerTimer(timerId) {
    this.#timers.add(timerId);
  }

  /**
   * Tüm kayıtlı timer'ları temizler.
   */
  clearAllTimers() {
    this.#timers.forEach((id) => {
      clearTimeout(id);
      clearInterval(id);
    });
    this.#timers.clear();
  }

  /**
   * Tüm kaynakları serbest bırakır.
   * Uygulama kapanırken veya component unmount'ta çağrılmalıdır.
   */
  dispose() {
    this.clearAllTimers();
    this.#persistDebounceTimers.forEach((id) => clearTimeout(id));
    this.#persistDebounceTimers.clear();
    this.#keyListeners.clear();
    this.#globalListeners.clear();
  }

  // ══════════════════════════════════════════════════════════════════════════
  // BÖLÜM 11 — Debug / DevTools
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Geliştirme ortamında state'i konsola basar.
   */
  debug() {
    console.group('[StateManager] Mevcut State');
    console.table(this.#state);
    console.groupEnd();
  }

  /**
   * Redux DevTools veya benzeri araçlarla entegrasyon için
   * state'i serileştirilebilir bir obje olarak döndürür.
   * @returns {object}
   */
  toPlainObject() {
    return { ...this.#state };
  }
}

// ─── Singleton Factory (isteğe bağlı) ────────────────────────────────────────
// Uygulamanın tek bir StateManager örneği kullanmasını garanti eder.

let _instance = null;

/**
 * @param {StorageAdapter|null} [storageAdapter]
 * @returns {StateManager}
 */
function getStateManager(storageAdapter = null) {
  if (!_instance) {
    _instance = new StateManager(storageAdapter);
  }
  return _instance;
}

/**
 * Yalnızca test ortamında singleton'ı sıfırlamak için kullanılır.
 * @internal
 */
function _resetStateManagerSingleton() {
  _instance?.dispose();
  _instance = null;
}

/* === RoomManager === */
/**
 * RoomManager.js
 * Oda Yönetim Sistemi - StateManager ile tam entegre çalışır.
 * ES6+ / Saf JavaScript — Framework bağımlılığı yok.
 */


// ─── Yardımcı: Benzersiz Oda ID Üretici ────────────────────────────────────
function generateRoomId(type = 'GRUP') {
  const prefix = type === 'private' ? 'PRIV' : type === 'guru' ? 'GURU' : 'GRUP';
  const today  = new Date();
  const datePart = String(today.getMonth() + 1).padStart(2, '0') +
                   String(today.getDate()).padStart(2, '0');           // MMDD
  const chars  = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const rand   = Array.from({ length: 4 }, () =>
    chars[Math.floor(Math.random() * chars.length)]).join('');
  return `${prefix}-${datePart}-${rand}`;                             // Örn: GRUP-0303-X9K2
}

// ─── Oda Şeması (factory) ──────────────────────────────────────────────────
function createRoomSchema({
  type     = 'public',
  name     = 'İsimsiz Oda',
  hostId,
  capacity = 10,
  password = null,
  category = 'genel',
} = {}) {
  return {
    id:           generateRoomId(type),
    type,                          // 'private' | 'public' | 'guru'
    name,
    hostId,
    participants: [],              // kullanıcı ID dizisi
    capacity,
    password: type === 'private' ? (password ?? null) : null,
    category,
    isActive:     true,
    createdAt:    Date.now(),
  };
}

// ─── LocalStorage Mock-Sync Katmanı ────────────────────────────────────────
const LS_KEY = 'rm_rooms_sync';

const mockSync = {
  /** Tüm odaları localStorage'dan oku */
  read() {
    try {
      return JSON.parse(localStorage.getItem(LS_KEY) || '{}');
    } catch {
      return {};
    }
  },
  /** Tüm odaları localStorage'a yaz (cross-tab sync) */
  write(rooms) {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(rooms));
    } catch (e) {
      console.warn('[RoomManager] localStorage yazma hatası:', e);
    }
  },
  /** Tek bir odayı güncelle */
  upsert(room) {
    const all = this.read();
    all[room.id] = room;
    this.write(all);
  },
  /** Tek bir odayı sil */
  remove(roomId) {
    const all = this.read();
    delete all[roomId];
    this.write(all);
  },
};

// ─── RoomManager Singleton ─────────────────────────────────────────────────
class RoomManager {
  constructor() {
    if (RoomManager._instance) return RoomManager._instance;
    RoomManager._instance = this;

    this._state = getStateManager();

    // StateManager'da 'rooms' anahtarı yoksa başlat
    if (!this._state.get('rooms')) {
      this._state.set('rooms', {});
    }

    // Sayfa açılırken localStorage'dan odaları çek (diğer sekme verileri)
    this._hydrateFromStorage();

    // Cross-tab değişikliklerini dinle
    window.addEventListener('storage', (e) => {
      if (e.key === LS_KEY) this._hydrateFromStorage();
    });
  }

  // ── İç yardımcılar ────────────────────────────────────────────────────────

  _hydrateFromStorage() {
    const stored = mockSync.read();
    this._state.set('rooms', stored);
  }

  _getRooms() {
    return { ...(this._state.get('rooms') || {}) };
  }

  _saveRoom(room) {
    const rooms = this._getRooms();
    rooms[room.id] = room;
    this._state.set('rooms', rooms);
    mockSync.upsert(room);
  }

  _deleteRoom(roomId) {
    const rooms = this._getRooms();
    delete rooms[roomId];
    this._state.set('rooms', rooms);
    mockSync.remove(roomId);
  }

  _currentUser() {
    return this._state.get('currentUser') || null;
  }

  // ── Genel API ─────────────────────────────────────────────────────────────

  /**
   * createRoom(options)
   * Yeni bir oda oluşturur. Yalnızca isPremium:true kullanıcılar oda kurabilir.
   * @param {object} options - { type, name, capacity, password, category }
   * @returns {{ success: boolean, room?: object, error?: string }}
   */
  createRoom(options = {}) {
    const user = this._currentUser();

    if (!user) {
      return { success: false, error: 'Oda oluşturmak için giriş yapmalısınız.' };
    }
    if (!user.isPremium) {
      return { success: false, error: 'Oda oluşturma özelliği yalnızca Premium üyelere açıktır.' };
    }

    const room = createRoomSchema({ ...options, hostId: user.id });
    this._saveRoom(room);

    console.info(`[RoomManager] Oda oluşturuldu: ${room.id} (${room.name})`);
    return { success: true, room };
  }

  /**
   * joinRoom(roomId, password?)
   * Mevcut kullanıcıyı belirtilen odaya ekler.
   * @returns {{ success: boolean, room?: object, error?: string }}
   */
  joinRoom(roomId, password = null) {
    const user = this._currentUser();
    if (!user) return { success: false, error: 'Giriş yapmanız gerekiyor.' };

    const rooms = this._getRooms();
    const room  = rooms[roomId];

    if (!room)          return { success: false, error: 'Oda bulunamadı.' };
    if (!room.isActive) return { success: false, error: 'Bu oda artık aktif değil.' };

    if (room.participants.includes(user.id)) {
      return { success: false, error: 'Zaten bu odadasınız.' };
    }
    if (room.participants.length >= room.capacity) {
      return { success: false, error: 'Oda kapasitesi dolu.' };
    }
    if (room.type === 'private' && room.password && room.password !== password) {
      return { success: false, error: 'Şifre yanlış.' };
    }

    room.participants = [...room.participants, user.id];
    this._saveRoom(room);

    console.info(`[RoomManager] ${user.id} → ${roomId} odasına katıldı.`);
    return { success: true, room };
  }

  /**
   * leaveRoom(roomId)
   * Mevcut kullanıcıyı odadan çıkarır.
   * Odada kimse kalmadıysa oda tamamen silinir.
   * @returns {{ success: boolean, deleted?: boolean, error?: string }}
   */
  leaveRoom(roomId) {
    const user = this._currentUser();
    if (!user) return { success: false, error: 'Giriş yapmanız gerekiyor.' };

    const rooms = this._getRooms();
    const room  = rooms[roomId];

    if (!room) return { success: false, error: 'Oda bulunamadı.' };

    room.participants = room.participants.filter(id => id !== user.id);

    if (room.participants.length === 0) {
      // Oda boşaldı → tamamen temizle
      this._deleteRoom(roomId);
      console.info(`[RoomManager] ${roomId} odası boşaldı ve silindi.`);
      return { success: true, deleted: true };
    }

    // Host ayrıldıysa yeni host ata
    if (room.hostId === user.id) {
      room.hostId = room.participants[0];
    }

    this._saveRoom(room);
    console.info(`[RoomManager] ${user.id} → ${roomId} odasından ayrıldı.`);
    return { success: true, deleted: false, room };
  }

  /**
   * getPublicRooms(category?)
   * Aktif ve herkese açık odaları döner.
   * @param {string} [category] - Opsiyonel kategori filtresi
   * @returns {object[]}
   */
  getPublicRooms(category = null) {
    const rooms = this._getRooms();
    return Object.values(rooms).filter(room =>
      room.isActive &&
      room.type === 'public' &&
      (!category || room.category === category)
    );
  }

  /**
   * getRoomById(roomId)
   * ID'ye göre tek oda döner.
   */
  getRoomById(roomId) {
    return this._getRooms()[roomId] || null;
  }

  /**
   * getAllRooms()
   * Debug / admin amaçlı: tüm odaları döner.
   */
  getAllRooms() {
    return Object.values(this._getRooms());
  }
}

// ─── Singleton Export ───────────────────────────────────────────────────────
const roomManagerInstance = new RoomManager();


/* === main-room-additions === */
/* =============================================================
   main-room-additions.js
   Sanctuary Oda Sistemi — UI mantığı
   main.js içindeki init() tarafından initRoomUI() çağrısıyla başlatılır.
   ============================================================= */


// ── Durum
let currentFilter = 'all';
let roomCapacity  = 5;
let roomType      = 'public';

// ── Skeleton render
function renderSkeletons(count = 3) {
  const grid = document.getElementById('roomsGrid');
  if (!grid) return;
  grid.innerHTML = Array.from({ length: count }, () => `
    <div class="skeleton-card">
      <div style="display:flex;justify-content:space-between;margin-bottom:14px">
        <div class="skeleton sk-line short"></div>
        <div class="skeleton sk-circle"></div>
      </div>
      <div class="skeleton sk-line long" style="margin-bottom:8px"></div>
      <div class="skeleton sk-line mid" style="margin-bottom:20px"></div>
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div class="skeleton sk-circle"></div>
        <div class="skeleton sk-line" style="width:60px;height:8px"></div>
      </div>
    </div>
  `).join('');
}

// ── Empty state render
function renderEmptyState() {
  const grid = document.getElementById('roomsGrid');
  if (!grid) return;
  grid.innerHTML = `
    <div class="empty-state">
      <div class="empty-icon">🌙</div>
      <p class="empty-title">Henüz aktif oda yok</p>
      <p class="empty-sub">Sessizliği birlikte deneyimleyelim — ilk odayı sen başlat!</p>
      <button class="btn-start-first" onclick="openCreateModal()">İlk Odayı Başlat 🚀</button>
    </div>
  `;
}

// ── Oda kartı HTML üret
function buildRoomCard(room) {
  const fillPct  = Math.round((room.current / room.capacity) * 100);
  const initials = room.hostName.slice(0, 2).toUpperCase();
  const privateIcon = room.type === 'private'
    ? `<span class="badge-private">
         <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
           <rect x="3" y="11" width="18" height="11" rx="2"/>
           <path d="M7 11V7a5 5 0 0110 0v4"/>
         </svg>
         Özel
       </span>`
    : '';
  return `
    <div class="room-card"
         data-room-id="${room.id}"
         data-category="${room.category}"
         data-lang="${room.lang}"
         onclick="joinRoom('${room.id}')">
      <div class="card-top">
        <span class="badge-live"><span class="dot"></span>CANLI</span>
        ${privateIcon}
      </div>
      <p class="room-name">${room.name}</p>
      <p class="room-category">${room.category}</p>
      <div class="card-footer">
        <div class="host-info">
          <div class="host-avatar">${initials}</div>
          <span class="host-name">${room.hostName}</span>
        </div>
        <div class="capacity-bar-wrap">
          <p class="capacity-text">${room.current}/${room.capacity}</p>
          <div class="capacity-bar">
            <div class="capacity-fill" style="width:${fillPct}%"></div>
          </div>
        </div>
      </div>
    </div>
  `;
}

// ── RoomManager'dan gelen verileri render et
function renderRooms(rooms) {
  const grid = document.getElementById('roomsGrid');
  if (!grid) return;
  if (!rooms || rooms.length === 0) { renderEmptyState(); return; }

  const filtered = currentFilter === 'all'
    ? rooms
    : rooms.filter(r => r.category === currentFilter || r.lang === currentFilter);

  if (filtered.length === 0) { renderEmptyState(); return; }
  grid.innerHTML = filtered.map(buildRoomCard).join('');
}

// ── Oda katıl (RoomManager.joinRoom bağlantı noktası)
function joinRoom(roomId) {
  // TODO: RoomManager.joinRoom(roomId)
  console.log('[Sanctuary] Joining room:', roomId);
}

// ── Modal aç/kapat
function openCreateModal() {
  const modal = document.getElementById('createRoomModal');
  if (!modal) return;
  modal.classList.add('open');
  document.body.style.overflow = 'hidden';
  setTimeout(() => {
    const nameInput = document.getElementById('roomName');
    if (nameInput) nameInput.focus();
  }, 350);
}
function closeCreateModal() {
  const modal = document.getElementById('createRoomModal');
  if (!modal) return;
  modal.classList.remove('open');
  document.body.style.overflow = '';
}

// ── Oda oluştur submit (RoomManager.createRoom bağlantı noktası)
async function submitCreateRoom() {
  const nameInput = document.getElementById('roomName');
  const name = nameInput ? nameInput.value.trim() : '';
  if (!name) { if (nameInput) nameInput.focus(); return; }

  const payload = {
    name,
    type:     roomType,
    capacity: roomCapacity,
    category: document.getElementById('roomCategory').value,
    password: roomType === 'private'
      ? document.getElementById('roomPassword').value
      : null,
  };

  // TODO: RoomManager.createRoom(payload)
  console.log('[Sanctuary] Creating room:', payload);
  closeCreateModal();
  renderSkeletons();
  // Sonra: const rooms = await RoomManager.getRooms(); renderRooms(rooms);
}

// ── Event listeners — güvenli bağlama
function bindRoomEvents() {
  const btnOpen   = document.getElementById('btnOpenCreateModal');
  const btnClose  = document.getElementById('btnCloseModal');
  const btnSubmit = document.getElementById('btnSubmitRoom');
  const btnCapDec = document.getElementById('btnCapDec');
  const btnCapInc = document.getElementById('btnCapInc');
  const modal     = document.getElementById('createRoomModal');
  const filterBar = document.getElementById('roomFilterBar');

  if (btnOpen)   btnOpen.addEventListener('click', openCreateModal);
  if (btnClose)  btnClose.addEventListener('click', closeCreateModal);
  if (btnSubmit) btnSubmit.addEventListener('click', submitCreateRoom);

  if (modal) {
    modal.addEventListener('click', e => {
      if (e.target === e.currentTarget) closeCreateModal();
    });
  }

  if (btnCapDec) {
    btnCapDec.addEventListener('click', () => {
      if (roomCapacity > 2) {
        roomCapacity--;
        document.getElementById('capValue').textContent = roomCapacity;
      }
    });
  }
  if (btnCapInc) {
    btnCapInc.addEventListener('click', () => {
      if (roomCapacity < 20) {
        roomCapacity++;
        document.getElementById('capValue').textContent = roomCapacity;
      }
    });
  }

  // Tip toggle
  document.querySelectorAll('.type-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.type-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      roomType = btn.dataset.type;
      const pf = document.getElementById('passwordField');
      if (pf) pf.classList.toggle('visible', roomType === 'private');
    });
  });

  // Filter chips
  if (filterBar) {
    filterBar.addEventListener('click', e => {
      const chip = e.target.closest('.filter-chip');
      if (!chip) return;
      document.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      currentFilter = chip.dataset.filter;
      // TODO: renderRooms(await RoomManager.getRooms());
      console.log('[Sanctuary] Filter changed:', currentFilter);
    });
  }
}

// ── Public init — main.js'teki init() tarafından çağrılır
function initRoomUI() {
  bindRoomEvents();
  renderSkeletons(3);

  // Simüle gecikme — gerçek uygulamada: const rooms = await RoomManager.getRooms();
  await new Promise(r => setTimeout(r, 1800));

  const mockRooms = [
    { id:'r1', name:'Derin Uyku Seansı 🌙', category:'uyku',       lang:'tr', type:'public',  hostName:'Ayşe K.',  current:4, capacity:8  },
    { id:'r2', name:'Focus Flow · Lo-fi',    category:'odak',       lang:'en', type:'public',  hostName:'Max R.',   current:2, capacity:10 },
    { id:'r3', name:'Sabah Meditasyonu',     category:'meditasyon', lang:'tr', type:'private', hostName:'Mert S.',  current:6, capacity:6  },
  ];

  renderRooms(mockRooms);
}

/* === main === */
/**
 * main.js — Sanctuary Ana Giriş Noktası
 * ═══════════════════════════════════════════════════════════════════════════
 * AudioEngine ve StateManager'ı birbirine bağlar.
 * DOM manipülasyonu minimumda tutulmuş; tüm iş mantığı iki motora delege edilir.
 *
 * Mimari:
 *  1. Initialization  → StorageAdapter, StateManager, hydrate()
 *  2. State-UI Binding → subscribe() ile reaktif UI güncellemeleri
 *  3. Event Handling  → HTML inline onclick'leri window.* fonksiyonlarına bağlar
 *  4. Mood & Scene    → Mood seçimi → AudioEngine.loadScript() + crossfade
 *  5. Timer & Breath  → Uyku zamanlayıcı + 4-7-8 nefes döngüsü
 *  6. Skeleton Reveal → Her şey hazır olduğunda revealContent() çağrısı
 * ═══════════════════════════════════════════════════════════════════════════
 */


/* ──────────────────────────────────────────────────────────────────────────
   BÖLÜM 1 — StorageAdapter (localStorage wrapper)
   StateManager'a enjekte edilir. React Native'de AsyncStorage ile değiştirin.
────────────────────────────────────────────────────────────────────────── */

const localStorageAdapter = {
  get: async (key) => {
    try { return window.localStorage.getItem(key); }
    catch { return null; }
  },
  set: async (key, value) => {
    try { window.localStorage.setItem(key, value); }
    catch { /* storage dolu veya erişim yok */ }
  },
  remove: async (key) => {
    try { window.localStorage.removeItem(key); }
    catch { /* yoksay */ }
  },
};

/* ──────────────────────────────────────────────────────────────────────────
   BÖLÜM 2 — MOOD VERİSİ & SAHNE SCRIPT'LERİ
   Her mood için AudioEngine.loadScript()'e uygun scene script tanımları.
────────────────────────────────────────────────────────────────────────── */

/**
 * Mood adı → { emoji, label, scene, message, frequency, script }
 * `script` → AudioEngine.loadScript() beklediği formata uygun nesne
 */
const MOOD_CATALOG = {
  'Huzursuz': {
    emoji: '🌊',
    label: 'Huzursuz',
    scene: 'ocean_calm',
    freqLabel: '432 Hz — Deniz Dalgaları',
    message: 'Huzursuzluk enerjini fark et. Şimdi sadece nefes al ve dalgaların sesine bırak kendini.',
    breathPattern: { inhale: 4, hold: 4, exhale: 6, label: '4 · 4 · 6 — Denge Nefesi' },
    script: {
      scene: 'ocean_calm',
      tracks: [
        { id: 'waves',    type: 'granular', generator: 'waves',    parameters: { volume: 0.7 } },
        { id: 'binaural', type: 'granular', generator: 'binaural', parameters: { volume: 0.4, baseFreq: 200, beatFreq: 8 } },
      ],
      mix: { masterVolume: 0.8, trackVolumes: [0.7, 0.4] },
    },
  },
  'Yorgun': {
    emoji: '🌙',
    label: 'Yorgun',
    scene: 'deep_sleep',
    freqLabel: '396 Hz — Derin Dinlenme',
    message: 'Bedenin sana bir şey söylüyor: dinlenme vakti. Gözlerini kapat, her şeyi bırak.',
    breathPattern: { inhale: 4, hold: 7, exhale: 8, label: '4 · 7 · 8 — Uyku Nefesi' },
    script: {
      scene: 'deep_sleep',
      tracks: [
        { id: 'wind',     type: 'granular', generator: 'wind',     parameters: { volume: 0.5 } },
        { id: 'binaural', type: 'granular', generator: 'binaural', parameters: { volume: 0.45, baseFreq: 180, beatFreq: 3 } },
      ],
      mix: { masterVolume: 0.75, trackVolumes: [0.5, 0.45] },
    },
  },
  'Kaygılı': {
    emoji: '🌪',
    label: 'Kaygılı',
    scene: 'forest_calm',
    freqLabel: '528 Hz — Kaygı Giderici',
    message: 'Kaygı geçici. Şu an güvendesin. Ormandaki sessizliğe katıl, adım adım nefes al.',
    breathPattern: { inhale: 4, hold: 1, exhale: 8, label: '4 · 1 · 8 — Sakinleştirici' },
    script: {
      scene: 'forest_calm',
      tracks: [
        { id: 'wind',     type: 'granular', generator: 'wind',     parameters: { volume: 0.6 } },
        { id: 'rain',     type: 'granular', generator: 'rain',     parameters: { volume: 0.25 } },
        { id: 'binaural', type: 'granular', generator: 'binaural', parameters: { volume: 0.4, baseFreq: 210, beatFreq: 10 } },
      ],
      mix: { masterVolume: 0.8, trackVolumes: [0.6, 0.25, 0.4] },
    },
  },
  'Mutsuz': {
    emoji: '🌧',
    label: 'Mutsuz',
    scene: 'rainy_comfort',
    freqLabel: '417 Hz — Duygusal Dönüşüm',
    message: 'Mutsuzluğun geçerli. Yağmurun sesini duy — bazen hissetmek en cesur eylemdir.',
    breathPattern: { inhale: 5, hold: 2, exhale: 7, label: '5 · 2 · 7 — Şefkat Nefesi' },
    script: {
      scene: 'rainy_comfort',
      tracks: [
        { id: 'rain',     type: 'granular', generator: 'rain',     parameters: { volume: 0.65 } },
        { id: 'binaural', type: 'granular', generator: 'binaural', parameters: { volume: 0.35, baseFreq: 190, beatFreq: 6 } },
      ],
      mix: { masterVolume: 0.75, trackVolumes: [0.65, 0.35] },
    },
  },
  'Sakin': {
    emoji: '🕯',
    label: 'Sakin',
    scene: 'candlelight',
    freqLabel: '963 Hz — Bilinç Genişletme',
    message: 'Harika bir yer. Sakinliğini koru, derinleştir. İçindeki ateşi hisset.',
    breathPattern: { inhale: 4, hold: 4, exhale: 4, label: '4 · 4 · 4 — Kutu Nefesi' },
    script: {
      scene: 'candlelight',
      tracks: [
        { id: 'fire',     type: 'granular', generator: 'fire',     parameters: { volume: 0.55 } },
        { id: 'binaural', type: 'granular', generator: 'binaural', parameters: { volume: 0.4, baseFreq: 220, beatFreq: 10 } },
      ],
      mix: { masterVolume: 0.8, trackVolumes: [0.55, 0.4] },
    },
  },
  'Minnettar': {
    emoji: '✨',
    label: 'Minnettar',
    scene: 'golden_light',
    freqLabel: '741 Hz — İfade & Minnet',
    message: 'Minnettarlık en güçlü ilaçtır. Bu hissi tut, büyüt, etrafındakilere yansıt.',
    breathPattern: { inhale: 6, hold: 2, exhale: 6, label: '6 · 2 · 6 — Minnet Nefesi' },
    script: {
      scene: 'golden_light',
      tracks: [
        { id: 'waves',    type: 'granular', generator: 'waves',    parameters: { volume: 0.4 } },
        { id: 'binaural', type: 'granular', generator: 'binaural', parameters: { volume: 0.5, baseFreq: 230, beatFreq: 12 } },
      ],
      mix: { masterVolume: 0.8, trackVolumes: [0.4, 0.5] },
    },
  },
};

/** Premium ses kartları için katalog */
const PREMIUM_SOUNDS = [
  { id: 'binaural_beats',   icon: '🎛️', name: 'Binaural Beats',   sub: '40 Hz Gama Odaklanma', isPremium: true },
  { id: 'uyku_hipnozu',     icon: '🌙', name: 'Uyku Hipnozu',      sub: '3 Hz Delta Dalgaları',  isPremium: true },
  { id: 'aktif_meditasyon', icon: '🧘', name: 'Aktif Meditasyon',  sub: '8 Hz Alfa Derinliği',  isPremium: true },
  { id: 'derin_odak_pro',   icon: '🔬', name: 'Derin Odak Pro',    sub: '14 Hz Beta Odağı',     isPremium: true, requiresPro: true },
];

/* ──────────────────────────────────────────────────────────────────────────
   BÖLÜM 3 — UYGULAMA BAŞLATMA
────────────────────────────────────────────────────────────────────────── */

const state   = getStateManager(localStorageAdapter);
const engine  = AudioEngine.getInstance();

/* ── Global köprü: RoomManager ve main-room-additions bu nesnelere erişebilir ── */
window._sanctuaryState  = state;
window._sanctuaryEngine = engine;

/** Aktif zamanlayıcı ve nefes interval ID'lerini tutar */
const _timers = {
  sleepCountdown: null,   // setInterval — uyku sayacı UI güncelleyici
  breathLoop: null,       // setTimeout zinciri — nefes döngüsü
  sessionTick: null,      // setInterval — seans süresi sayacı
  waveform: null,         // requestAnimationFrame döngüsü
};

/** Nefes döngüsü aktif mi? */
let _breathActive = false;

/* ──────────────────────────────────────────────────────────────────────────
   BÖLÜM 4 — STATE-UI BINDING (Reaktif Arayüz)
   Tüm UI güncellemeleri bu subscribe bloklarında merkeze alınır.
────────────────────────────────────────────────────────────────────────── */

function setupStateBindings() {
  /* ── playing → play/pause butonu ── */
  state.subscribe('playing', (isPlaying) => {
    const btn  = document.getElementById('play-btn');
    const icon = document.getElementById('play-icon');
    const lbl  = document.getElementById('play-lbl');
    if (!btn) return;

    btn.setAttribute('aria-pressed', String(isPlaying));
    if (isPlaying) {
      icon.textContent = '⏸';
      lbl.textContent  = 'Duraklat';
      btn.classList.add('playing');
      startWaveformLoop();
    } else {
      icon.textContent = '▶';
      lbl.textContent  = 'Frekansı Başlat';
      btn.classList.remove('playing');
      stopWaveformLoop();
    }
  });

  /* ── selectedMood → chip aktif sınıfı + badge + mesaj ── */
  state.subscribe('selectedMood', (mood) => {
    // Önce tüm chip'lerden active sınıfını temizle
    document.querySelectorAll('.mood-chip').forEach((el) =>
      el.classList.remove('active')
    );

    // Eşleşen chip'e active ekle
    const activeChip = document.querySelector(`.mood-chip[data-mood="${mood}"]`);
    if (activeChip) activeChip.classList.add('active');

    // Sanctuary ekranındaki badge'i güncelle
    const moodData = MOOD_CATALOG[mood];
    if (moodData) {
      const emojiEl = document.getElementById('s-emoji');
      const moodEl  = document.getElementById('s-mood');
      const msgEl   = document.getElementById('s-message');
      const freqEl  = document.getElementById('freq-label');

      if (emojiEl) emojiEl.textContent = moodData.emoji;
      if (moodEl)  moodEl.textContent  = moodData.label;
      if (msgEl)   msgEl.textContent   = moodData.message;
      if (freqEl)  freqEl.textContent  = moodData.freqLabel;

      // Nefes pattern güncelle
      updateBreathGuide(moodData.breathPattern.label);
    }
  });

  /* ── isTimerActive → uyku zamanlayıcı UI ── */
  state.subscribe('isTimerActive', (active) => {
    const cancelBtn = document.getElementById('stimer-cancel-btn');
    if (cancelBtn) cancelBtn.style.display = active ? 'inline-flex' : 'none';

    if (active) {
      startSleepCountdownUI();
    } else {
      stopSleepCountdownUI();
    }
  });

  /* ── bannerDismissed → HP banner ── */
  state.subscribe('bannerDismissed', (dismissed) => {
    const banner = document.getElementById('hp-banner');
    if (banner) banner.style.display = dismissed ? 'none' : '';
  });

  /* ── isPremium → premium rozet güncellemeleri ── */
  state.subscribe('isPremium', () => {
    renderPremiumSounds();
  });

  /* ── activeMood → tüm modüllere (Detox dahil) yansıt ── */
  state.subscribe('activeMood', (mood) => {
    // Detox modülü aktifse mevcut mood bilgisini al (çakışma yok, sadece state)
    if (window.DetoxModule?.isActive?.()) {
      console.info('[main] activeMood değişti (Detox aktif):', mood);
    }
  });
}

/* ──────────────────────────────────────────────────────────────────────────
   BÖLÜM 5 — MOOD & SCENE LOGIC
────────────────────────────────────────────────────────────────────────── */

/**
 * Kullanıcı bir mood chip'ine tıkladığında çağrılır.
 * StateManager'ı günceller, AudioEngine için sahneyi hazırlar (preload).
 * @param {HTMLElement} el — tıklanan .mood-chip elementi
 */
window.pickMood = function pickMood(el) {
  const mood = el?.dataset?.mood;
  if (!mood || !MOOD_CATALOG[mood]) return;

  // Önceki aktif chip'i kaldır
  document.querySelectorAll('.mood-chip').forEach((c) => c.classList.remove('active'));
  el.classList.add('active');

  // ── State senkronizasyonu: activeMood'u StateManager'a kaydet (Mood state sync fix) ──
  try {
    state.set('activeMood', mood);
    state.setCurrentScene(MOOD_CATALOG[mood].scene);
  } catch { /* yoksay */ }

  // UI'yı doğrudan güncelleyelim (selectedMood enum uyumsuzluğunu bypass ederek)
  _applyMoodToUI(mood);

  // Sahneyi önceden preload et (ses dosyaları olmadığından burada mock)
  // Gerçek ses dosyaları olduğunda: engine.preload([moodData.script.tracks.map(t => t.uri)])
};

/**
 * StateManager enum kısıtlaması olmaksızın mood UI'sını uygular.
 * @private
 */
function _applyMoodToUI(mood) {
  const moodData = MOOD_CATALOG[mood];
  if (!moodData) return;

  const emojiEl = document.getElementById('s-emoji');
  const moodEl  = document.getElementById('s-mood');
  const msgEl   = document.getElementById('s-message');
  const freqEl  = document.getElementById('freq-label');

  if (emojiEl) emojiEl.textContent = moodData.emoji;
  if (moodEl)  moodEl.textContent  = moodData.label;
  if (msgEl)   msgEl.textContent   = moodData.message;
  if (freqEl)  freqEl.textContent  = moodData.freqLabel;

  updateBreathGuide(moodData.breathPattern.label);

  // Aktif sahneyi StateManager'a kaydet
  state.set('activeMood', mood);
}

/**
 * Sanctuary ekranına geçiş + ses sahnesi yükleme.
 * play/pause ile tetikleneceği için burada sadece sahne hazırlığı yapılır.
 */
window.goSanctuary = function goSanctuary() {
  const mood = state.get('activeMood') ||
    document.querySelector('.mood-chip.active')?.dataset?.mood ||
    'Sakin';

  if (!state.get('activeMood')) _applyMoodToUI(mood);

  // Ekran geçişi
  switchScreen('screen-sanctuary');

  // AI Oracle skeleton'ını kısa süre sonra kaldır
  setTimeout(() => {
    const sk = document.getElementById('ai-oracle-skeleton');
    const ct = document.getElementById('ai-oracle-content');
    if (sk) sk.style.display = 'none';
    if (ct) ct.style.display = 'block';
  }, 600);

  // Seans başlat
  state.startSession();
};

/* ──────────────────────────────────────────────────────────────────────────
   BÖLÜM 6 — PLAY / PAUSE
────────────────────────────────────────────────────────────────────────── */

/**
 * Play/Pause toggle — HTML butona bağlı.
 * İlk çağrıda AudioContext başlatılır ve sahne yüklenir.
 */
window.togglePlay = async function togglePlay() {
  try {
    // AudioContext ilk kez kullanıcı etkileşimiyle başlatılır
    if (!engine.isInitialized) {
      await engine.initialize();
    }

    const mood = state.get('activeMood') || 'Sakin';
    const moodData = MOOD_CATALOG[mood];

    if (!engine.isPlaying) {
      // Sahne yükle + crossfade ile başlat
      if (moodData?.script) {
        await engine.loadScript(moodData.script, { crossfade: true });
      }
      await engine.play();
      state.setPlaying(true);

      // Nefes döngüsünü başlat
      if (moodData?.breathPattern) {
        startBreathCycle(moodData.breathPattern);
      }
    } else {
      await engine.pause();
      state.setPlaying(false);
      stopBreathCycle();
    }
  } catch (err) {
    console.error('[main] togglePlay hatası:', err);
    showFallbackNotice('Ses başlatılamadı, tekrar deneyin.');
  }
};

/* ──────────────────────────────────────────────────────────────────────────
   BÖLÜM 7 — WAVEFORM VİZUALİZER
────────────────────────────────────────────────────────────────────────── */

function startWaveformLoop() {
  const container = document.getElementById('waveform');
  if (!container || _timers.waveform) return;

  // Waveform bar'larını oluştur (ilk kez)
  if (!container.children.length) {
    for (let i = 0; i < 20; i++) {
      const bar = document.createElement('div');
      bar.className = 'wf-bar';
      container.appendChild(bar);
    }
  }

  const bars = container.querySelectorAll('.wf-bar');

  function tick() {
    const data = engine.getAudioData();
    bars.forEach((bar, i) => {
      let height;
      if (data?.frequencies) {
        const step = Math.floor(data.frequencies.length / bars.length);
        height = 4 + (data.frequencies[i * step] / 255) * 36;
      } else {
        height = 4 + Math.random() * 20; // fallback animasyon
      }
      bar.style.height = `${height}px`;
    });
    _timers.waveform = requestAnimationFrame(tick);
  }

  _timers.waveform = requestAnimationFrame(tick);
}

function stopWaveformLoop() {
  if (_timers.waveform) {
    cancelAnimationFrame(_timers.waveform);
    _timers.waveform = null;
  }
  // Barları sıfırla
  document.querySelectorAll('.wf-bar').forEach((bar) => {
    bar.style.height = '4px';
  });
}

/* ──────────────────────────────────────────────────────────────────────────
   BÖLÜM 8 — NEFES (BREATHING) DÖNGÜSÜ
────────────────────────────────────────────────────────────────────────── */

/**
 * 4-7-8 veya mood'a özgü nefes döngüsünü başlatır.
 * @param {{ inhale: number, hold: number, exhale: number, label: string }} pattern
 */
function startBreathCycle(pattern) {
  stopBreathCycle();
  _breathActive = true;

  const bCore  = document.getElementById('b-core');
  const guide  = document.getElementById('breath-guide');

  /**
   * Her aşamayı sırayla çalıştıran recursive setTimeout zinciri.
   * setInterval yerine setTimeout kullanılır; gecikme sürüklenmesi engellenir.
   */
  function runPhase(phase) {
    if (!_breathActive) return;

    switch (phase) {
      case 'inhale':
        if (guide) guide.textContent = `Nefes Al — ${pattern.inhale} saniye`;
        if (bCore) {
          bCore.style.transition = `transform ${pattern.inhale}s ease-in-out`;
          bCore.style.transform  = 'scale(1.35)';
        }
        _timers.breathLoop = setTimeout(() => runPhase('hold'), pattern.inhale * 1000);
        break;

      case 'hold':
        if (pattern.hold > 0) {
          if (guide) guide.textContent = `Tut — ${pattern.hold} saniye`;
          if (bCore) {
            bCore.style.transition = `transform 0.3s ease`;
            bCore.style.transform  = 'scale(1.35)';
          }
          _timers.breathLoop = setTimeout(() => runPhase('exhale'), pattern.hold * 1000);
        } else {
          runPhase('exhale');
        }
        break;

      case 'exhale':
        if (guide) guide.textContent = `Nefes Ver — ${pattern.exhale} saniye`;
        if (bCore) {
          bCore.style.transition = `transform ${pattern.exhale}s ease-in-out`;
          bCore.style.transform  = 'scale(1)';
        }
        _timers.breathLoop = setTimeout(() => runPhase('inhale'), pattern.exhale * 1000);
        break;
    }
  }

  runPhase('inhale');
}

function stopBreathCycle() {
  _breathActive = false;
  if (_timers.breathLoop) {
    clearTimeout(_timers.breathLoop);
    _timers.breathLoop = null;
  }
  const guide = document.getElementById('breath-guide');
  if (guide) guide.textContent = 'Hazır olduğunda butona dokun';

  const bCore = document.getElementById('b-core');
  if (bCore) {
    bCore.style.transition = 'transform 0.5s ease';
    bCore.style.transform  = 'scale(1)';
  }
}

function updateBreathGuide(text) {
  const guide = document.getElementById('breath-guide');
  // Sadece nefes aktif değilken güncelle
  if (guide && !_breathActive) {
    guide.textContent = text || 'Hazır olduğunda butona dokun';
  }
}

/* ──────────────────────────────────────────────────────────────────────────
   BÖLÜM 9 — UYKU ZAMANLAYICI
────────────────────────────────────────────────────────────────────────── */

/**
 * Uyku zamanlayıcısını başlatır.
 * @param {number} minutes
 */
window.setSleepTimer = function setSleepTimer(minutes) {
  // StateManager zamanlayıcıyı yönetir; süresi dolunca onExpire callback'i çalışır
  state.setSleepTimer(minutes, async () => {
    // Zamanlayıcı sona erdi → sesi kapat
    await engine.fadeOutAll(4);
    await engine.pause();
    state.setPlaying(false);
    stopBreathCycle();

    const statusEl = document.getElementById('stimer-status');
    if (statusEl) statusEl.textContent = 'İyi geceler 🌙';
  });

  // Aktif butonu vurgula
  document.querySelectorAll('.stimer-btn').forEach((btn) => {
    btn.classList.remove('active');
    if (parseInt(btn.textContent) === minutes) btn.classList.add('active');
  });
};

window.cancelSleepTimer = function cancelSleepTimer() {
  state.cancelSleepTimer();

  document.querySelectorAll('.stimer-btn').forEach((btn) => btn.classList.remove('active'));
  const statusEl = document.getElementById('stimer-status');
  if (statusEl) statusEl.textContent = '';
};

/** setInterval ile her saniye kalan süreyi ekranda günceller */
function startSleepCountdownUI() {
  stopSleepCountdownUI();

  _timers.sleepCountdown = setInterval(() => {
    const remaining = state.getRemainingTimerSeconds();
    const statusEl  = document.getElementById('stimer-status');
    if (!statusEl) return;

    if (remaining <= 0) {
      stopSleepCountdownUI();
      return;
    }

    const m = Math.floor(remaining / 60).toString().padStart(2, '0');
    const s = (remaining % 60).toString().padStart(2, '0');
    statusEl.textContent = `⏱ ${m}:${s}`;
  }, 1000);
}

function stopSleepCountdownUI() {
  if (_timers.sleepCountdown) {
    clearInterval(_timers.sleepCountdown);
    _timers.sleepCountdown = null;
  }
}

/* ──────────────────────────────────────────────────────────────────────────
   BÖLÜM 10 — EKRAN GEÇİŞLERİ
────────────────────────────────────────────────────────────────────────── */

/**
 * Hedef ekranı 'on' yapar, diğerlerini 'off' yapar.
 * @param {string} screenId
 */
function switchScreen(screenId) {
  document.querySelectorAll('.screen').forEach((s) => {
    s.className = s.id === screenId ? 'screen on' : 'screen off';
  });
  window.scrollTo(0, 0);
}

window.goBack = function goBack() {
  const current = document.querySelector('.screen.on');
  if (current?.id === 'screen-analytics') {
    switchScreen('screen-sanctuary');
  } else {
    // Sanctuary → Mood ekranına dön
    if (engine.isPlaying) {
      engine.pause().then(() => state.setPlaying(false));
      stopBreathCycle();
    }
    const session = state.endSession();
    if (session) saveSessionToStorage(session);
    switchScreen('screen-mood');
  }
};

window.showAnalytics = function showAnalytics() {
  renderAnalytics();
  switchScreen('screen-analytics');
};

/* ──────────────────────────────────────────────────────────────────────────
   BÖLÜM 10b — SEKME GEÇIŞLERI (Ses / Günlük / Premium)
────────────────────────────────────────────────────────────────────────── */

/**
 * Sanctuary içindeki sekme panellerini değiştirir.
 * @param {string} tabId — 'tab-audio' | 'tab-journal' | 'tab-premium'
 */
window.switchTab = function switchTab(tabId) {
  // Tüm panelleri gizle
  document.querySelectorAll('.tab-panel').forEach((panel) => {
    panel.classList.remove('active');
  });

  // Tüm butonlardan active sınıfını ve aria-selected'ı kaldır
  document.querySelectorAll('.tab-item').forEach((btn) => {
    btn.classList.remove('active');
    btn.setAttribute('aria-selected', 'false');
  });

  // Hedef paneli göster (.active class ekle)
  const activePanel = document.getElementById(tabId);
  if (activePanel) activePanel.classList.add('active');

  // İlgili butona active ekle
  const btnId = 'tab-btn-' + tabId.replace('tab-', '');
  const activeBtn = document.getElementById(btnId);
  if (activeBtn) {
    activeBtn.classList.add('active');
    activeBtn.setAttribute('aria-selected', 'true');
  }

  // Günlük sekmesi açıldığında tarihi güncelle ve önceki girişleri yükle
  if (tabId === 'tab-journal') {
    _updateJournalDate();
    _renderJournalEntries();
  }
};

/* ──────────────────────────────────────────────────────────────────────────
   BÖLÜM 10c — GÜNLÜK (Journal) FONKSİYONLARI
────────────────────────────────────────────────────────────────────────── */

function _updateJournalDate() {
  const el = document.getElementById('journal-date');
  if (!el) return;
  const now = new Date();
  el.textContent = now.toLocaleDateString('tr-TR', { weekday: 'long', day: 'numeric', month: 'long' });
}

function _renderJournalEntries() {
  const list = document.getElementById('journal-entries-list');
  if (!list) return;

  let entries = [];
  try {
    entries = JSON.parse(window.localStorage.getItem('sanctuary_journal') || '[]');
  } catch { entries = []; }

  if (!entries.length) {
    list.innerHTML = '<p class="journal-empty">Henüz kayıtlı giriş yok. İlk notunu yaz ✨</p>';
    return;
  }

  list.innerHTML = entries.slice(-5).reverse().map((e) => `
    <div class="journal-entry">
      <span class="journal-entry-date">${e.date}</span>
      <p class="journal-entry-text">${e.text.replace(/</g, '&lt;')}</p>
    </div>
  `).join('');
}

window.saveJournalEntry = function saveJournalEntry() {
  const textarea = document.getElementById('journal-textarea');
  const status   = document.getElementById('journal-save-status');
  if (!textarea) return;

  const text = textarea.value.trim();
  if (!text) {
    if (status) { status.textContent = 'Önce bir şeyler yaz 🖊'; setTimeout(() => { status.textContent = ''; }, 2000); }
    return;
  }

  let entries = [];
  try { entries = JSON.parse(window.localStorage.getItem('sanctuary_journal') || '[]'); }
  catch { entries = []; }

  const now = new Date();
  entries.push({
    text,
    date: now.toLocaleDateString('tr-TR', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }),
    mood: state.get('activeMood') || '',
  });

  try { window.localStorage.setItem('sanctuary_journal', JSON.stringify(entries)); }
  catch { /* storage dolu */ }

  textarea.value = '';
  if (status) { status.textContent = '✓ Kaydedildi'; setTimeout(() => { status.textContent = ''; }, 2500); }
  _renderJournalEntries();
};

/* ──────────────────────────────────────────────────────────────────────────
   BÖLÜM 11 — HP BANNER
────────────────────────────────────────────────────────────────────────── */

window.dismissBanner = function dismissBanner() {
  state.setBannerDismissed(true);
  const banner = document.getElementById('hp-banner');
  if (banner) banner.style.display = 'none';
};

/* ──────────────────────────────────────────────────────────────────────────
   BÖLÜM 12 — PREMIUM SESLER (Premium Sounds Grid)
────────────────────────────────────────────────────────────────────────── */

function renderPremiumSounds() {
  const grid = document.getElementById('premium-sounds-grid');
  if (!grid) return;

  grid.innerHTML = '';
  PREMIUM_SOUNDS.forEach((sound) => {
    const { allowed } = state.checkContentAccess(sound.id);
    const card = document.createElement('div');
    card.className = `s-sound-card${allowed ? '' : ' locked'}`;
    card.innerHTML = `
      <span class="s-sound-ic">${sound.icon}</span>
      <span class="s-sound-nm">${sound.name}</span>
      <span class="s-sound-sub">${sound.sub}</span>
      ${!allowed ? '<span class="s-sound-lock">🔒</span>' : ''}
    `;
    card.addEventListener('click', () => {
      if (!allowed) {
        openPaywall();
      } else {
        loadPremiumSound(sound.id);
      }
    });
    grid.appendChild(card);
  });

  if (typeof window.revealPremiumSounds === 'function') {
    window.revealPremiumSounds();
  }
}

async function loadPremiumSound(soundId) {
  const script = buildPremiumScript(soundId);
  if (!script) return;

  if (!engine.isInitialized) await engine.initialize();
  await engine.loadScript(script, { crossfade: true });
  if (!engine.isPlaying) {
    await engine.play();
    state.setPlaying(true);
  }
}

function buildPremiumScript(soundId) {
  const scripts = {
    binaural_beats:   { scene: 'binaural_beats',   tracks: [{ id: 'binaural', type: 'granular', generator: 'binaural', parameters: { volume: 0.6, baseFreq: 200, beatFreq: 40 } }], mix: { masterVolume: 0.8 } },
    uyku_hipnozu:     { scene: 'uyku_hipnozu',      tracks: [{ id: 'binaural', type: 'granular', generator: 'binaural', parameters: { volume: 0.55, baseFreq: 180, beatFreq: 3 } }, { id: 'wind', type: 'granular', generator: 'wind', parameters: { volume: 0.4 } }], mix: { masterVolume: 0.75 } },
    aktif_meditasyon: { scene: 'aktif_meditasyon',  tracks: [{ id: 'binaural', type: 'granular', generator: 'binaural', parameters: { volume: 0.5, baseFreq: 200, beatFreq: 8 } }, { id: 'waves', type: 'granular', generator: 'waves', parameters: { volume: 0.5 } }], mix: { masterVolume: 0.8 } },
    derin_odak_pro:   { scene: 'derin_odak_pro',    tracks: [{ id: 'binaural', type: 'granular', generator: 'binaural', parameters: { volume: 0.6, baseFreq: 200, beatFreq: 14 } }, { id: 'fire', type: 'granular', generator: 'fire', parameters: { volume: 0.3 } }], mix: { masterVolume: 0.8 } },
  };
  return scripts[soundId] || null;
}

/* ──────────────────────────────────────────────────────────────────────────
   BÖLÜM 13 — AI ORACLE
────────────────────────────────────────────────────────────────────────── */

window.generateAIFreq = async function generateAIFreq() {
  const input  = document.getElementById('ai-input');
  const result = document.getElementById('ai-result');
  const text   = document.getElementById('ai-result-text');
  const freq   = document.getElementById('ai-result-freq');
  const btn    = document.getElementById('ai-generate-btn');
  const proc   = document.getElementById('ai-processing');

  if (!input?.value.trim()) return;

  const apiKey = state.get('apiKey');

  // Processing overlay
  if (proc) proc.style.display = 'flex';
  if (btn)  btn.disabled = true;

  try {
    let oracleMessage = '';
    let freqRec = '';

    if (apiKey) {
      // Gerçek API çağrısı
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: `Sen Sanctuary uygulamasının AI Oracle'ısın. Kullanıcı şunu söylüyor: "${input.value}". Kısa, teselli edici bir mesaj ver ve hangi ses frekansının yardımcı olacağını öner (Hz değeri ile). Türkçe yanıtla.` }] }],
        }),
      });
      const data = await res.json();
      oracleMessage = data?.candidates?.[0]?.content?.parts?.[0]?.text || fallbackOracle(input.value);
      freqRec = extractFreqFromText(oracleMessage);
    } else {
      // API key yoksa fallback
      oracleMessage = fallbackOracle(input.value);
      freqRec = '432 Hz — Evrensel Uyum';
    }

    if (text)   text.textContent  = oracleMessage;
    if (freq)   freq.textContent  = `🎵 Önerilen: ${freqRec}`;
    if (result) result.style.display = 'block';

  } catch (err) {
    console.warn('[main] AI Oracle hatası:', err);
    if (text) text.textContent = fallbackOracle(input.value);
    if (result) result.style.display = 'block';
  } finally {
    if (proc) proc.style.display = 'none';
    if (btn)  btn.disabled = false;
  }
};

function fallbackOracle(input) {
  const lower = input.toLowerCase();
  if (lower.includes('kaygı') || lower.includes('endişe') || lower.includes('korku')) {
    return 'Kaygın, seni korumaya çalışıyor. Şu an güvendesin. 528 Hz frekansı zihnini yumuşatacak.';
  }
  if (lower.includes('yorgun') || lower.includes('uyku')) {
    return 'Bedenin dinlenmeyi hak ediyor. 396 Hz ile derin bir uyku yolculuğuna çık.';
  }
  if (lower.includes('mutsuz') || lower.includes('üzgün')) {
    return 'Hislerin geçerli. 417 Hz dönüşüm frekansı kalp ağırlığını hafifletir.';
  }
  return 'İçinden geçenler değerli. 432 Hz evrensel uyum frekansı şu an en iyi eşlikçin.';
}

function extractFreqFromText(text) {
  const match = text.match(/(\d{3,4})\s*Hz/i);
  return match ? `${match[1]} Hz` : '432 Hz — Evrensel Uyum';
}

/* ──────────────────────────────────────────────────────────────────────────
   BÖLÜM 14 — ANALİTİK
────────────────────────────────────────────────────────────────────────── */

function saveSessionToStorage(session) {
  try {
    const sessions = JSON.parse(localStorage.getItem('sanctuary:sessions') || '[]');
    sessions.push(session);
    // Son 90 seans sakla
    if (sessions.length > 90) sessions.splice(0, sessions.length - 90);
    localStorage.setItem('sanctuary:sessions', JSON.stringify(sessions));
  } catch { /* yoksay */ }
}

function loadSessions() {
  try {
    return JSON.parse(localStorage.getItem('sanctuary:sessions') || '[]');
  } catch { return []; }
}

function renderAnalytics() {
  const sessions = loadSessions();
  const totalMin = Math.floor(sessions.reduce((acc, s) => acc + (s.duration || 0), 0) / 60);

  // Streak hesapla
  const streak = calculateStreak(sessions);

  const sessEl  = document.getElementById('stat-sessions');
  const minEl   = document.getElementById('stat-minutes');
  const strEl   = document.getElementById('stat-streak');

  if (sessEl) sessEl.textContent = sessions.length;
  if (minEl)  minEl.textContent  = totalMin;
  if (strEl)  strEl.textContent  = streak;

  // Son 7 günlük canvas grafiği
  renderAnalyticsChart(sessions);

  // Mood log listesi
  renderMoodLog(sessions);
}

function calculateStreak(sessions) {
  if (!sessions.length) return 0;
  const days = new Set(sessions.map((s) => new Date(s.date || 0).toDateString()));
  let streak = 0;
  const today = new Date();
  for (let i = 0; i < 365; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    if (days.has(d.toDateString())) { streak++; } else break;
  }
  return streak;
}

function renderAnalyticsChart(sessions) {
  const canvas = document.getElementById('analytics-canvas');
  if (!canvas) return;
  const ctx2d = canvas.getContext('2d');
  const W = canvas.offsetWidth || 300;
  const H = 120;
  canvas.width = W;

  // Son 7 gün
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - (6 - i));
    return d.toDateString();
  });

  const counts = days.map((d) =>
    sessions.filter((s) => new Date(s.date || 0).toDateString() === d).length
  );

  const max   = Math.max(...counts, 1);
  const barW  = (W - 20) / 7;
  const pad   = 10;

  ctx2d.clearRect(0, 0, W, H);

  days.forEach((d, i) => {
    const barH = (counts[i] / max) * (H - 30);
    const x    = pad + i * barW + barW * 0.2;
    const y    = H - 20 - barH;

    const grad = ctx2d.createLinearGradient(0, y, 0, H - 20);
    grad.addColorStop(0, 'rgba(201,169,110,0.9)');
    grad.addColorStop(1, 'rgba(201,169,110,0.2)');

    ctx2d.fillStyle = grad;
    ctx2d.beginPath();
    ctx2d.roundRect(x, y, barW * 0.6, barH, 4);
    ctx2d.fill();

    // Gün etiketi
    ctx2d.fillStyle = 'rgba(255,255,255,0.4)';
    ctx2d.font = '9px -apple-system, sans-serif';
    ctx2d.textAlign = 'center';
    const label = ['Pz', 'Pt', 'Sa', 'Ça', 'Pe', 'Cu', 'Ct'][new Date(d).getDay()];
    ctx2d.fillText(label, x + barW * 0.3, H - 5);
  });
}

function renderMoodLog(sessions) {
  const list = document.getElementById('mood-log-list');
  if (!list) return;

  const recent = sessions.slice(-10).reverse();
  list.innerHTML = recent.length
    ? recent.map((s) => {
        const moodData = MOOD_CATALOG[s.mood] || { emoji: '🌿', label: s.mood || 'Bilinmiyor' };
        const dur = s.duration ? `${Math.floor(s.duration / 60)} dk` : '—';
        const date = s.date ? new Date(s.date).toLocaleDateString('tr-TR', { day: 'numeric', month: 'short' }) : '';
        return `<div class="mood-log-item">
          <span class="ml-emoji">${moodData.emoji}</span>
          <span class="ml-mood">${moodData.label}</span>
          <span class="ml-dur">${dur}</span>
          <span class="ml-date">${date}</span>
        </div>`;
      }).join('')
    : '<p style="opacity:0.4;text-align:center;padding:20px 0;">Henüz oturum yok</p>';
}

window.clearData = function clearData() {
  if (!confirm('Tüm veriler silinecek. Emin misin?')) return;
  try { localStorage.removeItem('sanctuary:sessions'); } catch { }
  state.clearPersistedState().then(() => renderAnalytics());
};

/* ──────────────────────────────────────────────────────────────────────────
   BÖLÜM 15 — PAYWALL & SATIN ALMA
────────────────────────────────────────────────────────────────────────── */

function openPaywall() {
  const overlay = document.getElementById('paywall-overlay');
  if (overlay) overlay.style.display = 'flex';
}

window.closePaywall = function closePaywall() {
  const overlay = document.getElementById('paywall-overlay');
  if (overlay) overlay.style.display = 'none';
};

window.selectPlan = function selectPlan(el) {
  document.querySelectorAll('.pw-plan').forEach((p) => p.classList.remove('sel'));
  el.classList.add('sel');
  updateTrialState();
};

window.updateTrialState = function updateTrialState() {
  const toggle  = document.getElementById('pw-trial-toggle');
  const ctaBtn  = document.getElementById('pw-cta-btn');
  const ctaNote = document.getElementById('pw-cta-note');
  const plan    = document.querySelector('.pw-plan.sel')?.dataset?.plan || 'yearly';
  const trial   = toggle?.checked;

  const prices = { monthly: '$9.99/ay', yearly: '$59.99/yıl', lifetime: '$199' };

  if (ctaBtn) ctaBtn.textContent = trial ? 'Ücretsiz Dene — 7 Gün' : `Şimdi Al — ${prices[plan] || ''}`;
  if (ctaNote) {
    ctaNote.textContent = trial
      ? `Deneme bittikten sonra ${prices[plan] || ''} olarak faturalandırılır.`
      : 'İstediğin zaman iptal edebilirsin.';
  }
};

window.handlePurchase = function handlePurchase() {
  // Gerçek uygulamada: App Store / Play Store satın alma akışı başlatılır.
  // Burada mock olarak premium aktif edilir.
  const plan = document.querySelector('.pw-plan.sel')?.dataset?.plan === 'lifetime' ? 'pro' : 'basic';
  try {
    state.setPremiumStatus({
      plan,
      billingCycle: 'yearly',
      receiptToken: 'mock_token_' + Date.now(),
    });
    renderPremiumSounds();
    closePaywall();
    alert('🎉 Sanctuary Premium aktif edildi!');
  } catch (err) {
    console.warn('[main] Premium aktivasyon hatası:', err);
  }
};

window.restorePurchase = function restorePurchase() {
  alert('Satın alım geri yükleme: Gerçek uygulamada App Store/Play Store sorgulanır.');
};

/* ──────────────────────────────────────────────────────────────────────────
   BÖLÜM 16 — SAĞLIK UYGULAMASI VERİSİ
────────────────────────────────────────────────────────────────────────── */

window.exportHealth = function exportHealth() {
  const sessions = loadSessions();
  const healthData = sessions.map((s) => ({
    type:      'HKCategoryTypeIdentifierMindfulSession',
    startDate: s.date,
    endDate:   new Date(new Date(s.date).getTime() + (s.duration || 0) * 1000).toISOString(),
    value:     'HKCategoryValueMindfulSessionTypeUnspecified',
    metadata:  { mood: s.mood, scene: s.scene },
  }));

  const jsonEl = document.getElementById('health-json-content');
  if (jsonEl) jsonEl.textContent = JSON.stringify({ HealthData: healthData }, null, 2);

  const modal = document.getElementById('health-modal');
  if (modal) modal.style.display = 'flex';
};

window.closeHealthModal = function closeHealthModal(e) {
  if (!e || e.target === document.getElementById('health-modal')) {
    document.getElementById('health-modal').style.display = 'none';
  }
};

window.copyHealthData = function copyHealthData() {
  const text = document.getElementById('health-json-content')?.textContent;
  if (text) navigator.clipboard?.writeText(text).then(() => alert('Kopyalandı!'));
};

/* ──────────────────────────────────────────────────────────────────────────
   BÖLÜM 17 — YASAL UYARI
────────────────────────────────────────────────────────────────────────── */

window.acceptDisclaimer = function acceptDisclaimer() {
  const disc = document.getElementById('legal-disclaimer');
  if (disc) disc.style.display = 'none';
  localStorage.setItem('sanctuary:disclaimer', '1');
};

function checkDisclaimer() {
  if (!localStorage.getItem('sanctuary:disclaimer')) {
    const disc = document.getElementById('legal-disclaimer');
    if (disc) disc.style.display = 'flex';
  }
}

/* ──────────────────────────────────────────────────────────────────────────
   BÖLÜM 18 — PWA INSTALL
────────────────────────────────────────────────────────────────────────── */

let _deferredPrompt = null;

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  _deferredPrompt = e;
  const banner = document.getElementById('pwa-banner');
  if (banner) banner.style.display = 'flex';
});

window.triggerPWAInstall = async function triggerPWAInstall() {
  if (!_deferredPrompt) return;
  _deferredPrompt.prompt();
  await _deferredPrompt.userChoice;
  _deferredPrompt = null;
  dismissPWABanner();
};

window.dismissPWABanner = function dismissPWABanner() {
  const banner = document.getElementById('pwa-banner');
  if (banner) banner.style.display = 'none';
};

/* ──────────────────────────────────────────────────────────────────────────
   BÖLÜM 19 — YARDIMCI FONKSIYONLAR
────────────────────────────────────────────────────────────────────────── */

/* ── ODA SİSTEMİ KÖPRÜ FONKSİYONLARI ─────────────────────────────────────
   RoomManager ↔ main-room-additions.js arasındaki gerçek veri köprüsü.
   HTML inline handler'lar window.loadRooms ve window.joinRoom'u çağırır.
────────────────────────────────────────────────────────────────────────── */

/**
 * Herkese açık odaları RoomManager'dan çeker ve renderRooms'a iletir.
 * localStorage'da kayıtlı oda yoksa mock seed odaları enjekte eder
 * (geliştirme / demo modu için).
 * @param {string|null} [category] — opsiyonel kategori filtresi
 */
async function loadRooms(category = null) {
  let rooms = RoomManager.getPublicRooms(category);

  // Gerçek oda yoksa demo seed'leri göster (production'da kaldırın)
  if (rooms.length === 0) {
    rooms = [
      { id: 'r1', name: 'Derin Uyku Seansı 🌙', category: 'uyku',       lang: 'tr', type: 'public', hostName: 'Ayşe K.',  current: 4, capacity: 8  },
      { id: 'r2', name: 'Focus Flow · Lo-fi',    category: 'odak',       lang: 'en', type: 'public', hostName: 'Max R.',   current: 2, capacity: 10 },
      { id: 'r3', name: 'Sabah Meditasyonu ☀️',  category: 'meditasyon', lang: 'tr', type: 'public', hostName: 'Mert S.',  current: 3, capacity: 6  },
    ].map(seed => ({
      ...seed,
      participants: Array.from({ length: seed.current }, (_, i) => `mock_user_${i}`),
      isActive: true,
      createdAt: Date.now(),
      hostId: `host_${seed.id}`,
      password: null,
    }));
  }

  renderRooms(rooms);
  return rooms;
}

/**
 * Oda katılım köprüsü — RoomManager.joinRoom() çağrısı yapar.
 * Katılım başarılıysa StateManager üzerinden activeMood sync'lenir.
 * @param {string} roomId
 * @param {string|null} [password]
 */
window.joinRoom = function joinRoom(roomId, password = null) {
  // currentUser mock (gerçek auth entegre edilene kadar)
  const user = state.get('currentUser') || { id: 'guest_' + Date.now(), isPremium: false };

  // State'e geçici kullanıcı yaz (RoomManager._currentUser() için)
  if (!state.get('currentUser')) {
    try { state.set('currentUser', user); } catch { /* yoksay */ }
  }

  const result = RoomManager.joinRoom(roomId, password);

  if (result.success) {
    console.info('[main] Odaya katılındı:', roomId);
    // Aktif mood'u state üzerinden tüm modüllere yansıt
    const currentMood = state.get('activeMood') || 'Sakin';
    try { state.set('activeMood', currentMood); } catch { /* yoksay */ }
  } else {
    console.warn('[main] Odaya katılım başarısız:', result.error);
    showFallbackNotice(result.error || 'Odaya katılınamadı.');
  }
};

function showFallbackNotice(msg) {
  const notice = document.getElementById('fallback-notice');
  const text   = document.getElementById('fallback-notice-text');
  if (text)   text.textContent = msg || 'Default Zen modu aktif — 432 Hz';
  if (notice) {
    notice.style.display = 'flex';
    setTimeout(() => { if (notice) notice.style.display = 'none'; }, 4000);
  }
}

/* ──────────────────────────────────────────────────────────────────────────
   BÖLÜM 20 — BAŞLATMA (DOMContentLoaded)
────────────────────────────────────────────────────────────────────────── */

async function init() {
  try {
    // 1. StateManager'ı hydrate et (localStorage'dan önceki state'i geri yükle)
    await state.hydrate();

    // 2. Reaktif UI binding'leri kur
    setupStateBindings();

    // 3. Banner önceki oturumda kapatıldıysa gizle
    if (state.get('bannerDismissed')) {
      const banner = document.getElementById('hp-banner');
      if (banner) banner.style.display = 'none';
    }

    // 4. Son seçilen mood'u (varsa) geri yükle
    const savedScene = state.get('currentScene');
    const restoredMood = Object.keys(MOOD_CATALOG).find(
      (k) => MOOD_CATALOG[k].scene === savedScene
    );
    if (restoredMood) {
      const chip = document.querySelector(`.mood-chip[data-mood="${restoredMood}"]`);
      if (chip) chip.classList.add('active');
      state.set('activeMood', restoredMood);
    }

    // 5. Son açılış tarihini güncelle
    state.setLastOpenDate();

    // 6. Premium sesler grid'ini render et
    renderPremiumSounds();

    // 7. AudioEngine'i kullanıcı etkileşimi için hazır tut (initialize çağrılmaz;
    //    initialize() ilk togglePlay() veya loadScript() çağrısında tetiklenir)
    engine.on('initialized', () => {
      console.info('[main] AudioEngine hazır');
    });

    engine.on('play',  () => console.info('[main] Ses oynatılıyor'));
    engine.on('pause', () => console.info('[main] Ses duraklatıldı'));
    engine.on('stop',  (info) => {
      if (info?.duration) saveSessionToStorage({ ...state.endSession?.() || {}, ...info });
    });

    // 8. Yasal uyarıyı kontrol et
    checkDisclaimer();

    // 9. Oda sistemini başlat — RoomManager UI bağlantıları ve ilk oda yüklemesi
    await initRoomUI();

    // 10. Skeleton reveal — tüm sistemler hazır
    if (typeof window.revealContent === 'function') {
      window.revealContent();
    } else {
      // Fallback: manuel reveal
      const sk   = document.getElementById('mood-grid-skeleton');
      const grid = document.getElementById('mood-grid');
      if (sk)   sk.style.display   = 'none';
      if (grid) grid.style.display = 'grid';
    }

    /* ── Oda UI olaylarını main-room-additions.js'e delege et ────────────────
       openCreateModal, closeCreateModal ve joinRoom fonksiyonları
       import edilmiş veya köprülenmiş olup window.* aracılığıyla
       HTML inline handler'larına açılır.
       loadRooms: RoomManager.getPublicRooms() köprüsü (BÖLÜM 19'da tanımlı)
       Bu sayede main.js oda mantığından tamamen ayrışır.
    ───────────────────────────────────────────────────────────────────────── */
    window.openCreateModal  = openCreateModal;
    window.closeCreateModal = closeCreateModal;
    window.loadRooms        = loadRooms;   // BÖLÜM 19'daki RoomManager köprüsü

    console.info('[main] Sanctuary başlatıldı ✓');

  } catch (err) {
    console.error('[main] Başlatma hatası:', err);
    showFallbackNotice('Sistem başlatılırken bir hata oluştu.');
  }
}

// DOM hazır olduğunda başlat
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

// Uygulama kapanırken kaynakları temizle
window.addEventListener('beforeunload', () => {
  stopBreathCycle();
  stopSleepCountdownUI();
  stopWaveformLoop();
  engine.dispose().catch(() => {});
  state.dispose();
});
/* ============================================================
   SANCTUARY — Digital Detox (Cooldown Mode)
   EKLEME YERİ: main.js dosyasının EN SONUNA yapıştır
   (window.addEventListener('beforeunload',...) bloğunun hemen ardından)

   BAĞIMLILIKLAR (main.js ile tam uyumlu):
   - state  : getStateManager() ile oluşturulmuş StateManager örneği
   - engine : AudioEngine.getInstance() ile oluşturulmuş AudioEngine örneği
   Her ikisi de bu dosyada zaten tanımlı; window.* ataması gerekmez.
   ============================================================ */

(function () {
  'use strict';

  /* ──────────────────────────────────────────────
     0. Güvenli Yardımcılar
  ────────────────────────────────────────────── */
  const $ = (sel, ctx = document) => ctx.querySelector(sel);
  const log = (...args) => console.log('[Detox]', ...args);

  /* ──────────────────────────────────────────────
     1. Yapılandırma
  ────────────────────────────────────────────── */
  const CONFIG = {
    DETOX_DURATION_SEC : 5 * 60,   // Varsayılan: 5 dakika (saniye)
    LONG_PRESS_MS      : 3000,     // Çıkış için basılı tutma süresi
    TARGET_FREQ_HZ     : 9,        // Alpha/Theta: 9 Hz
    NATURE_VOLUME_MAX  : 0.15,
    PARTICLE_COUNT     : 22,
    MESSAGES: [
      'Dijital dünyadan uzaklaş ve nefesine odaklan.',
      'Şu an burada olman yeterli.',
      'Her nefes, bir yeni başlangıç.',
      'Zihnin dinlenmeyi hak ediyor.',
      'Sessizlik de bir sestir.',
    ],
  };

  /* Detoks sahne scripti — engine.loadScript() formatına uygun */
  const DETOX_SCENE_SCRIPT = {
    scene: 'detox_deep',
    tracks: [
      { id: 'rain',     type: 'granular', generator: 'rain',     parameters: { volume: 0.35 } },
      { id: 'binaural', type: 'granular', generator: 'binaural', parameters: { volume: 0.45, baseFreq: 200, beatFreq: CONFIG.TARGET_FREQ_HZ } },
    ],
    mix: { masterVolume: 0.35, trackVolumes: [0.35, 0.45] },
  };

  /* ──────────────────────────────────────────────
     2. DOM Referansları
  ────────────────────────────────────────────── */
  const DOM = {
    trigger      : $('#cooldownTrigger'),
    overlay      : $('#detoxOverlay'),
    particles    : $('#detoxParticles'),
    breathPhase  : $('#breathPhase'),
    timerDisplay : $('#detoxTimerDisplay'),
    timerFill    : $('#detoxTimerFill'),
    message      : $('#detoxMessage'),
    exitBtn      : $('#detoxExitBtn'),
    exitProgress : $('#detoxExitProgress'),
  };

  /* ──────────────────────────────────────────────
     3. Dahili Durum
  ────────────────────────────────────────────── */
  const _ds = {
    isActive        : false,
    remainingSec    : CONFIG.DETOX_DURATION_SEC,
    timerInterval   : null,
    breathInterval  : null,
    msgInterval     : null,
    longPressStart  : null,
    rafId           : null,
    prevMasterVol   : null,
    prevFreq        : null,
    wasPlaying      : false,
  };

  /* ──────────────────────────────────────────────
     4. StateManager Köprüsü
     main.js'deki `state` nesnesini kullanır.
     StateManager henüz yüklenmemişse güvenle atlar.
  ────────────────────────────────────────────── */
  function _stateSet(key, value) {
    try {
      if (typeof state !== 'undefined' && typeof state.set === 'function') {
        state.set(key, value);
        log('StateManager →', key, ':', value);
      }
    } catch (e) {
      log('StateManager yazma hatası (yoksayıldı):', e);
    }
  }

  function _stateGet(key) {
    try {
      if (typeof state !== 'undefined' && typeof state.get === 'function') {
        return state.get(key);
      }
    } catch { /* yoksay */ }
    return undefined;
  }

  /* ──────────────────────────────────────────────
     5. Low-Power Mode
  ────────────────────────────────────────────── */
  function enableLowPower() {
    document.documentElement.classList.add('low-power');
    log('Low-power: ON');
  }

  function disableLowPower() {
    document.documentElement.classList.remove('low-power');
    log('Low-power: OFF');
  }

  /* ──────────────────────────────────────────────
     6. AudioEngine Köprüsü
     main.js'deki `engine` (AudioEngine.getInstance()) kullanılır.
     engine henüz başlatılmamışsa initialize() çağrılır.
     engine yoksa tüm ses işlemleri sessizce atlanır.
  ────────────────────────────────────────────── */
  async function audioDetoxEnter() {
    try {
      if (typeof engine === 'undefined' || !engine) return;

      // AudioContext henüz başlatılmamışsa başlat
      if (!engine.isInitialized) {
        await engine.initialize();
      }

      // Önceki durumu sakla
      _ds.wasPlaying = !!engine.isPlaying;
      _ds.prevMasterVol = typeof engine.getMasterVolume === 'function'
        ? engine.getMasterVolume()
        : null;

      // Mevcut frekansı sakla (varsa)
      if (typeof engine.getFrequency === 'function') {
        _ds.prevFreq = engine.getFrequency();
      }

      // Detoks sahnesini yükle (crossfade ile)
      await engine.loadScript(DETOX_SCENE_SCRIPT, { crossfade: true });

      // Oynatmayı başlat (yoksa)
      if (!engine.isPlaying) await engine.play();

      // Master ses seviyesini detoks moduna indir
      if (typeof engine.setMasterVolume === 'function') {
        engine.setMasterVolume(0.35);
      }

      // Frekansı 9 Hz'e çek (varsa)
      if (typeof engine.setFrequency === 'function') {
        engine.setFrequency(CONFIG.TARGET_FREQ_HZ);
      } else if (typeof engine.setBinauralFrequency === 'function') {
        engine.setBinauralFrequency(CONFIG.TARGET_FREQ_HZ);
      }

      // Doğa ses kanalını düşür (varsa)
      if (typeof engine.fadeVolumeTo === 'function') {
        engine.fadeVolumeTo('nature', CONFIG.NATURE_VOLUME_MAX, 3000);
      }

      log('AudioEngine → detox sahne yüklendi (9 Hz, master 0.35)');
    } catch (e) {
      log('AudioEngine detox giriş hatası (yoksayıldı):', e);
    }
  }

  async function audioDetoxExit() {
    try {
      if (typeof engine === 'undefined' || !engine) return;

      // Oynatmayı durdur
      if (engine.isPlaying) await engine.pause();

      // Önceki mood sahnesini geri yükle
      const activeMood = state.get('activeMood') || 'Sakin';
      const prevScript = MOOD_CATALOG?.[activeMood]?.script;
      if (prevScript) {
        await engine.loadScript(prevScript, { crossfade: true });
        if (_ds.wasPlaying) await engine.play();
      }

      // Ses seviyesini geri al
      if (_ds.prevMasterVol !== null && typeof engine.setMasterVolume === 'function') {
        engine.setMasterVolume(_ds.prevMasterVol);
      }

      // Frekansı geri al
      if (_ds.prevFreq !== null) {
        if (typeof engine.setFrequency === 'function') {
          engine.setFrequency(_ds.prevFreq);
        } else if (typeof engine.setBinauralFrequency === 'function') {
          engine.setBinauralFrequency(_ds.prevFreq);
        }
      }

      // Doğa ses kanalını geri al
      if (typeof engine.fadeVolumeTo === 'function') {
        engine.fadeVolumeTo('nature', 0.7, 3000);
      }

      log('AudioEngine → önceki sahneye dönüldü');
    } catch (e) {
      log('AudioEngine detox çıkış hatası (yoksayıldı):', e);
    }
  }

  /* ──────────────────────────────────────────────
     7. Parçacık Arka Planı
  ────────────────────────────────────────────── */
  function createParticles() {
    if (!DOM.particles) return;
    DOM.particles.innerHTML = '';
    for (let i = 0; i < CONFIG.PARTICLE_COUNT; i++) {
      const p = document.createElement('div');
      p.className = 'detox-particle';
      p.style.cssText = `
        left: ${Math.random() * 100}%;
        width: ${1 + Math.random() * 3}px;
        height: ${1 + Math.random() * 3}px;
        animation-duration: ${8 + Math.random() * 18}s;
        animation-delay: ${Math.random() * 15}s;
        opacity: ${0.1 + Math.random() * 0.3};
      `;
      DOM.particles.appendChild(p);
    }
  }

  /* ──────────────────────────────────────────────
     8. Nefes Döngüsü
  ────────────────────────────────────────────── */
  const BREATH_PHASES = [
    { label: 'Nefes Al',  duration: 4000 },
    { label: 'Tut',        duration: 1000 },
    { label: 'Nefes Ver', duration: 4000 },
    { label: 'Tut',        duration: 1000 },
  ];

  function startDetoxBreathCycle() {
    let idx = 0;
    function nextPhase() {
      if (!_ds.isActive) return;
      const phase = BREATH_PHASES[idx % BREATH_PHASES.length];
      if (DOM.breathPhase) {
        DOM.breathPhase.style.opacity = '0';
        setTimeout(() => {
          if (DOM.breathPhase) {
            DOM.breathPhase.textContent = phase.label;
            DOM.breathPhase.style.opacity = '1';
          }
        }, 300);
      }
      idx++;
      _ds.breathInterval = setTimeout(nextPhase, phase.duration);
    }
    nextPhase();
  }

  function stopDetoxBreathCycle() {
    clearTimeout(_ds.breathInterval);
  }

  /* ──────────────────────────────────────────────
     9. Geri Sayım Sayacı
  ────────────────────────────────────────────── */
  function formatTime(sec) {
    const m = String(Math.floor(sec / 60)).padStart(2, '0');
    const s = String(sec % 60).padStart(2, '0');
    return `${m}:${s}`;
  }

  function updateDetoxTimer() {
    if (!_ds.isActive) return;
    const ratio = _ds.remainingSec / CONFIG.DETOX_DURATION_SEC;
    if (DOM.timerDisplay) DOM.timerDisplay.textContent = formatTime(_ds.remainingSec);
    if (DOM.timerFill)    DOM.timerFill.style.transform = `scaleX(${ratio})`;

    if (_ds.remainingSec <= 0) { endDetox(true); return; }
    _ds.remainingSec--;
  }

  function startDetoxTimer() {
    _ds.remainingSec = CONFIG.DETOX_DURATION_SEC;
    updateDetoxTimer();
    _ds.timerInterval = setInterval(updateDetoxTimer, 1000);
  }

  function stopDetoxTimer() {
    clearInterval(_ds.timerInterval);
  }

  /* ──────────────────────────────────────────────
     10. Mesaj Döngüsü
  ────────────────────────────────────────────── */
  function startMsgCycle() {
    let idx = 1;
    _ds.msgInterval = setInterval(() => {
      if (!_ds.isActive || !DOM.message) return;
      DOM.message.style.opacity = '0';
      setTimeout(() => {
        if (DOM.message) {
          DOM.message.textContent = CONFIG.MESSAGES[idx % CONFIG.MESSAGES.length];
          DOM.message.style.opacity = '1';
          idx++;
        }
      }, 600);
    }, 12000);
  }

  function stopMsgCycle() {
    clearInterval(_ds.msgInterval);
  }

  /* ──────────────────────────────────────────────
     11. Uzun Basma (Long Press) — 3 saniyelik kilit
  ────────────────────────────────────────────── */
  const CIRCUMFERENCE = 2 * Math.PI * 26; // ~163.4

  function resetExitProgress() {
    if (DOM.exitProgress) DOM.exitProgress.style.strokeDashoffset = CIRCUMFERENCE;
    if (DOM.exitBtn) DOM.exitBtn.classList.remove('is-pressing');
  }

  function startLongPress() {
    if (!DOM.exitBtn || !DOM.exitProgress) return;
    DOM.exitBtn.classList.add('is-pressing');
    _ds.longPressStart = Date.now();

    function tick() {
      if (!_ds.longPressStart) return;
      const elapsed = Date.now() - _ds.longPressStart;
      const ratio   = Math.min(elapsed / CONFIG.LONG_PRESS_MS, 1);
      DOM.exitProgress.style.strokeDashoffset = CIRCUMFERENCE * (1 - ratio);

      if (ratio >= 1) {
        cancelLongPress(false);
        endDetox(false);
      } else {
        _ds.rafId = requestAnimationFrame(tick);
      }
    }
    _ds.rafId = requestAnimationFrame(tick);
  }

  function cancelLongPress(reset = true) {
    _ds.longPressStart = null;
    if (_ds.rafId) { cancelAnimationFrame(_ds.rafId); _ds.rafId = null; }
    if (reset) resetExitProgress();
  }

  function bindExitButton() {
    if (!DOM.exitBtn) return;
    DOM.exitBtn.addEventListener('mousedown',   startLongPress);
    DOM.exitBtn.addEventListener('mouseup',     () => cancelLongPress(true));
    DOM.exitBtn.addEventListener('mouseleave',  () => cancelLongPress(true));
    DOM.exitBtn.addEventListener('touchstart',  (e) => { e.preventDefault(); startLongPress(); }, { passive: false });
    DOM.exitBtn.addEventListener('touchend',    () => cancelLongPress(true));
    DOM.exitBtn.addEventListener('touchcancel', () => cancelLongPress(true));
  }

  /* ──────────────────────────────────────────────
     12. ESC Engeli
  ────────────────────────────────────────────── */
  function blockEsc(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      log('ESC engellendi — çıkış için 3 sn basılı tut.');
    }
  }

  /* ──────────────────────────────────────────────
     13. Detox Başlat / Bitir
  ────────────────────────────────────────────── */
  function startDetox() {
    if (_ds.isActive) return;
    log('Detox başlatılıyor...');

    _ds.isActive = true;
    _stateSet('isDetoxActive', true);

    enableLowPower();           // ← document.documentElement.classList.add('low-power')
    audioDetoxEnter();          // ← engine.loadScript(DETOX_SCENE_SCRIPT) + frekans köprüsü
    createParticles();

    if (DOM.overlay) {
      DOM.overlay.removeAttribute('aria-hidden');
      DOM.overlay.classList.add('is-active');
    }

    if (DOM.message) DOM.message.textContent = CONFIG.MESSAGES[0];

    startDetoxTimer();
    startDetoxBreathCycle();
    startMsgCycle();
    resetExitProgress();
    document.addEventListener('keydown', blockEsc);

    // main.js nefes döngüsünü durdur (çakışma engeli)
    if (typeof stopBreathCycle === 'function') stopBreathCycle();

    log('Detox aktif ✓');
  }

  function endDetox(timerCompleted = false) {
    if (!_ds.isActive) return;
    log('Detox bitiyor...', timerCompleted ? '(süre doldu)' : '(kullanıcı)');

    stopDetoxTimer();
    stopDetoxBreathCycle();
    stopMsgCycle();
    document.removeEventListener('keydown', blockEsc);

    if (DOM.overlay) {
      DOM.overlay.setAttribute('aria-hidden', 'true');
      DOM.overlay.classList.remove('is-active');
    }

    _ds.isActive = false;
    _stateSet('isDetoxActive', false);

    disableLowPower();
    audioDetoxExit();
    resetExitProgress();

    if (DOM.trigger) DOM.trigger.focus();
    log('Detox tamamlandı ✓');
  }

  /* ──────────────────────────────────────────────
     14. Tetikleyici Buton
  ────────────────────────────────────────────── */
  function bindTrigger() {
    if (!DOM.trigger) { log('Uyarı: #cooldownTrigger bulunamadı.'); return; }
    DOM.trigger.addEventListener('click', startDetox);
  }

  /* ──────────────────────────────────────────────
     15. Başlatma
  ────────────────────────────────────────────── */
  function detoxInit() {
    // Önceki oturumda aktif kalmış olabilecek detox durumunu sıfırla
    if (_stateGet('isDetoxActive')) {
      log('Önceki oturumda aktif detox bulundu, sıfırlanıyor...');
      _stateSet('isDetoxActive', false);
    }

    bindTrigger();
    bindExitButton();

    // Sayacı göster (başlatmadan)
    if (DOM.timerDisplay) DOM.timerDisplay.textContent = formatTime(CONFIG.DETOX_DURATION_SEC);
    if (DOM.timerFill)    DOM.timerFill.style.transform = 'scaleX(1)';

    log('Digital Detox modülü hazır ✓');
  }

  // DOM hazırsa hemen çalıştır, değilse bekle
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', detoxInit);
  } else {
    detoxInit();
  }

  /* ──────────────────────────────────────────────
     16. Genel API — window.DetoxModule
     Diğer modüllerden erişmek için:
       window.DetoxModule.start()
       window.DetoxModule.end()
       window.DetoxModule.isActive()
  ────────────────────────────────────────────── */
  window.DetoxModule = {
    start    : startDetox,
    end      : endDetox,
    isActive : () => _ds.isActive,
  };

})();
/* ══════════════════════════════════════
   RIPPLE (Su Dalgasi) Tiklama Efekti
   Modelden bagimsiz — hemen calisir
══════════════════════════════════════ */
(function() {
  'use strict';

  function createRipple(clientX, clientY) {
    var SIZE = 120;
    var el = document.createElement('div');
    el.className = 'ripple-circle';
    el.style.cssText = [
      'left:' + clientX + 'px',
      'top:' + clientY + 'px',
      'width:' + SIZE + 'px',
      'height:' + SIZE + 'px'
    ].join(';');
    document.body.appendChild(el);
    // Remove after animation completes
    el.addEventListener('animationend', function() {
      if (el.parentNode) el.parentNode.removeChild(el);
    });
  }

  function onPointerDown(e) {
    var x = e.touches ? e.touches[0].clientX : e.clientX;
    var y = e.touches ? e.touches[0].clientY : e.clientY;
    // Don't create ripple on interactive elements (button, a, textarea, input)
    var tag = (e.target && e.target.tagName) ? e.target.tagName.toLowerCase() : '';
    if (tag === 'textarea' || tag === 'input' || tag === 'select') return;
    createRipple(x, y);
  }

  document.addEventListener('mousedown', onPointerDown, { passive: true });
  document.addEventListener('touchstart', onPointerDown, { passive: true });
})();
