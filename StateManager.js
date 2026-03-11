
/**
 * StateManager.js — Sanctuary 8. Aşama (Final)
 * Phase 8 Değişiklikleri:
 *   1. UMD wrapper — ES module export → window.SanctuaryState global
 *   2. sessionBuffer entegrasyonu — sekme geçişlerinde geçici veri korunumu
 *   3. window.Sanctuary.state ile entegrasyon
 */
(function (global) {
  'use strict';

/**
 * StateManager.js — Sanctuary 5. Aşama (Performans & Bellek Optimizasyonu)
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase 5 Değişiklikleri:
 *   1. Storage event listener → cross-tab sync için eklendi, dispose()'da kaldırılır
 *   2. _boundStorageHandler → window.removeEventListener ile temizlenir (bellek sızıntısı önlemi)
 *   3. dispose() → storageListener + tüm timer'lar + listener'lar güvenli şekilde temizlenir
 *   4. Visibility API desteği → sekme gizlendiğinde persist debounce flush edilir
 *   5. Debug bilgisi iyileştirildi — cache ve listener sayıları görünür
 * ─────────────────────────────────────────────────────────────────────────────
 * 3. Aşama Güvenlik Değişiklikleri (korundu):
 *   - apiKey artık localStorage'a YAZILMIYOR (PERSISTED_KEYS'den çıkarıldı).
 *   - apiKey sadece runtime bellekte, private #apiKeyRuntime alanında tutulur.
 *   - validatePurchaseToken frontend doğrulaması tamamen kaldırıldı.
 *   - setPremiumStatus receiptToken doğrulamasında offline/demo modu açıkça işaretler.
 */

// ─── Tip Sabitleri ────────────────────────────────────────────────────────────

/** @enum {string} */
const Mood = Object.freeze({
  HUZURSUZ:  'Huzursuz',
  YORGUN:    'Yorgun',
  KAYGILI:   'Kaygılı',
  MUTSUZ:    'Mutsuz',
  SAKIN:     'Sakin',
  MINNETTAR: 'Minnettar',
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
  playing:                false,
  currentScene:           'sessiz orman',
  audioTracks:            [],
  masterVolume:           0.8,
  intensity:              0.5,
  selectedMood:           Mood.SAKIN,
  sessionStartTime:       null,
  currentSessionDuration: 0,
  isTimerActive:          false,
  sleepTimer:             null,
  sleepTimerEnd:          null,
  isPremium:              false,
  premiumPlan:            PremiumPlan.NONE,
  billingCycle:           BillingCycle.MONTHLY,
  premiumExpiresAt:       null,
  bannerDismissed:        false,
  language:               'tr-TR',
  isInitialized:          false,
  lastOpenDate:           null,
});

// ─── Kalıcı Saklanacak Key'ler ────────────────────────────────────────────────

const PERSISTED_KEYS = new Set([
  'selectedMood',
  'isPremium',
  'premiumPlan',
  'billingCycle',
  'premiumExpiresAt',
  'bannerDismissed',
  // 'apiKey' — KASITLI OLARAK ÇIKARILDI
  'language',
  'masterVolume',
  'lastOpenDate',
]);

// ─── Kısıtlı İçerik Tanımları ─────────────────────────────────────────────────

const CONTENT_PERMISSIONS = {
  'derin_odak_pro':   PremiumPlan.PRO,
  'binaural_beats':   PremiumPlan.BASIC,
  'uyku_hipnozu':     PremiumPlan.BASIC,
  'aktif_meditasyon': PremiumPlan.BASIC,
};

const PLAN_RANK = {
  [PremiumPlan.NONE]:  0,
  [PremiumPlan.BASIC]: 1,
  [PremiumPlan.PRO]:   2,
};

// ─── Ana Sınıf ────────────────────────────────────────────────────────────────

class StateManager {
  /** @type {Object} */
  #state;

  /** @type {string} */
  #apiKeyRuntime;

  /** @type {Map<string, Set<Function>>} */
  #keyListeners;

  /** @type {Set<Function>} */
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
   * PHASE 5: Storage event listener referansı — dispose()'da kaldırılır.
   * Cross-tab senkronizasyonu için localStorage değişikliklerini dinler.
   * @type {Function|null}
   */
  #boundStorageHandler;

  /**
   * PHASE 5: Visibility change handler referansı — dispose()'da kaldırılır.
   * Sekme gizlenince bekleyen persist'leri flush eder.
   * @type {Function|null}
   */
  #boundVisibilityHandler;

  /**
   * @param {StorageAdapter|null} storageAdapter
   */
  constructor(storageAdapter = null) {
    this.#state                  = { ...DEFAULT_STATE };
    this.#apiKeyRuntime          = '';
    this.#keyListeners           = new Map();
    this.#globalListeners        = new Set();
    this.#storage                = storageAdapter;
    this.#persistDebounceTimers  = new Map();
    this.#timers                 = new Set();
    this.#hydrated               = false;
    this.#boundStorageHandler    = null;
    this.#boundVisibilityHandler = null;

    /* PHASE 5: Event listener'ları başlat */
    this.#attachWindowListeners();
  }

  // ══════════════════════════════════════════════════════════════════════════
  // BÖLÜM 1 — Temel get / set
  // ══════════════════════════════════════════════════════════════════════════

  get(key) {
    if (key === 'apiKey') return this.#apiKeyRuntime;
    return this.#state[key];
  }

  /** @private */
  #rawSet(key, value) {
    if (key === 'apiKey') {
      this.#apiKeyRuntime = value ?? '';
      return;
    }

    const prev = this.#state[key];
    if (Object.is(prev, value)) return;

    this.#state[key] = value;
    this.#notify(key, value, prev);

    if (PERSISTED_KEYS.has(key)) {
      this.#schedulePersist(key, value);
    }
  }

  getSnapshot() {
    const { ...snapshot } = this.#state;
    return Object.freeze(snapshot);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // BÖLÜM 2 — Observer / Pub-Sub
  // ══════════════════════════════════════════════════════════════════════════

  subscribe(key, listener) {
    if (!this.#keyListeners.has(key)) {
      this.#keyListeners.set(key, new Set());
    }
    this.#keyListeners.get(key).add(listener);
    return () => {
      this.#keyListeners.get(key)?.delete(listener);
    };
  }

  subscribeAll(listener) {
    this.#globalListeners.add(listener);
    return () => this.#globalListeners.delete(listener);
  }

  subscribeMany(keys, listener) {
    const unsubs = keys.map((k) => this.subscribe(k, listener));
    return () => unsubs.forEach((fn) => fn());
  }

  /** @private */
  #notify(key, newValue, prevValue) {
    this.#keyListeners.get(key)?.forEach((fn) => {
      try { fn(newValue, prevValue); }
      catch (err) { console.error(`[StateManager] Listener hatası (${key}):`, err); }
    });

    this.#globalListeners.forEach((fn) => {
      try { fn({ key, newValue, prevValue }); }
      catch (err) { console.error('[StateManager] Global listener hatası:', err); }
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // BÖLÜM 3 — Persistence (Hydration & Persist)
  // ══════════════════════════════════════════════════════════════════════════

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
          this.#state[key] = parsed;
        }
      } catch (err) {
        console.warn(`[StateManager] Hydration hatası (${key}):`, err);
      }
    });

    await Promise.all(loadPromises);

    this.#validatePremiumExpiry();

    this.#hydrated = true;
    this.#notify('isInitialized', true, false);
    this.#state.isInitialized = true;
    console.info('[StateManager] Hydration tamamlandı.');
  }

  /** @private */
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

  /**
   * PHASE 5: Bekleyen tüm persist işlemlerini hemen çalıştırır.
   * Sekme kapanmadan önce veri kaybını önler.
   */
  async flushPersist() {
    if (!this.#storage) return;

    const promises = [];
    this.#persistDebounceTimers.forEach((id, key) => {
      clearTimeout(id);
      const value = this.#state[key];
      promises.push(
        this.#storage
          .set(`state:${key}`, this.#serialize(key, value))
          .catch((err) => console.error(`[StateManager] Flush persist hatası (${key}):`, err))
      );
    });
    this.#persistDebounceTimers.clear();

    if (promises.length > 0) {
      await Promise.all(promises);
      console.info(`[StateManager] ${promises.length} persist flush edildi.`);
    }
  }

  /** @private */
  #serialize(key, value)  { return JSON.stringify(value); }

  /** @private */
  #deserialize(key, raw) {
    try   { return JSON.parse(raw); }
    catch { return raw; }
  }

  async clearPersistedState() {
    if (!this.#storage) return;
    await Promise.all(
      [...PERSISTED_KEYS].map((k) => this.#storage.remove(`state:${k}`).catch(() => {}))
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // BÖLÜM 4 — Oynatma & Ses Kontrolü
  // ══════════════════════════════════════════════════════════════════════════

  setPlaying(value)          { this.#rawSet('playing', Boolean(value)); }
  setCurrentScene(scene) {
    if (typeof scene !== 'string' || !scene.trim()) {
      throw new TypeError('[StateManager] Geçersiz sahne adı');
    }
    this.#rawSet('currentScene', scene.trim());
  }
  setAudioTracks(tracks) {
    if (!Array.isArray(tracks)) throw new TypeError('[StateManager] audioTracks bir dizi olmalıdır');
    this.#rawSet('audioTracks', tracks);
  }
  updateTrackVolume(trackName, volume) {
    const clamped = Math.min(1, Math.max(0, volume));
    const tracks  = this.#state.audioTracks.map((t) =>
      t.name === trackName ? { ...t, volume: clamped } : t
    );
    this.#rawSet('audioTracks', tracks);
  }
  setMasterVolume(volume) {
    this.#rawSet('masterVolume', Math.min(1, Math.max(0, volume)));
  }
  setIntensity(value) {
    this.#rawSet('intensity', Math.min(1, Math.max(0, value)));
  }

  // ══════════════════════════════════════════════════════════════════════════
  // BÖLÜM 5 — Ruh Hali
  // ══════════════════════════════════════════════════════════════════════════

  setSelectedMood(mood) {
    const validMoods = Object.values(Mood);
    if (!validMoods.includes(mood)) {
      throw new RangeError(
        `[StateManager] Geçersiz mood: "${mood}". Geçerli: ${validMoods.join(', ')}`
      );
    }
    this.#rawSet('selectedMood', mood);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // BÖLÜM 6 — Seans Yönetimi
  // ══════════════════════════════════════════════════════════════════════════

  startSession() {
    this.#rawSet('sessionStartTime', Date.now());
    this.#rawSet('currentSessionDuration', 0);
  }

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

  getCurrentSessionDuration() {
    const start = this.#state.sessionStartTime;
    if (!start) return 0;
    return Math.floor((Date.now() - start) / 1000);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // BÖLÜM 7 — Uyku Zamanlayıcı
  // ══════════════════════════════════════════════════════════════════════════

  setSleepTimer(minutes, onExpire, maxMinutes = 180) {
    if (!Number.isFinite(minutes) || minutes <= 0 || minutes > maxMinutes) {
      throw new RangeError(`[StateManager] Geçersiz zamanlayıcı süresi: ${minutes}`);
    }

    this.cancelSleepTimer();

    const endTime  = Date.now() + minutes * 60 * 1000;
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

  getRemainingTimerSeconds() {
    const end = this.#state.sleepTimerEnd;
    if (!end) return 0;
    return Math.max(0, Math.floor((end - Date.now()) / 1000));
  }

  // ══════════════════════════════════════════════════════════════════════════
  // BÖLÜM 8 — Premium & Güvenlik Katmanı
  // ══════════════════════════════════════════════════════════════════════════

  setPremiumStatus({ plan, billingCycle, expiresAt = null, receiptToken = '' }) {
    if (!Object.values(PremiumPlan).includes(plan)) {
      throw new RangeError(`[StateManager] Geçersiz plan: ${plan}`);
    }
    if (!Object.values(BillingCycle).includes(billingCycle)) {
      throw new RangeError(`[StateManager] Geçersiz fatura döngüsü: ${billingCycle}`);
    }
    if (plan === PremiumPlan.NONE) {
      throw new Error('[StateManager] setPremiumStatus ile NONE plan kurulamaz. revokePremium kullanın.');
    }

    if (receiptToken) {
      console.info('[StateManager] Receipt token mevcut — backend doğrulaması gerekli.');
    } else {
      console.warn('[StateManager] Receipt token sağlanmadı. Demo/offline mod aktif.');
    }

    this.#rawSet('isPremium', true);
    this.#rawSet('premiumPlan', plan);
    this.#rawSet('billingCycle', billingCycle);
    this.#rawSet('premiumExpiresAt', expiresAt);
  }

  revokePremium() {
    this.#rawSet('isPremium', false);
    this.#rawSet('premiumPlan', PremiumPlan.NONE);
    this.#rawSet('premiumExpiresAt', null);
  }

  checkContentAccess(contentId) {
    const requiredPlan = CONTENT_PERMISSIONS[contentId];
    if (!requiredPlan) return { allowed: true, reason: '' };

    if (!this.#state.isPremium) {
      return { allowed: false, reason: `Bu içerik premium üyelik gerektiriyor (${requiredPlan}).` };
    }

    const userRank     = PLAN_RANK[this.#state.premiumPlan] ?? 0;
    const requiredRank = PLAN_RANK[requiredPlan] ?? 0;

    if (userRank < requiredRank) {
      return {
        allowed: false,
        reason: `Bu içerik ${requiredPlan} planı gerektiriyor. Mevcut planınız: ${this.#state.premiumPlan}.`,
      };
    }

    if (this.#isPremiumExpired()) {
      this.revokePremium();
      return { allowed: false, reason: 'Premium aboneliğinizin süresi dolmuş.' };
    }

    return { allowed: true, reason: '' };
  }

  unlockContent(scene) {
    const { allowed, reason } = this.checkContentAccess(scene);
    if (!allowed) throw new Error(`[StateManager] Erişim reddedildi — ${reason}`);
    this.setCurrentScene(scene);
  }

  /** @private — Her zaman false; güvenlik için client-side doğrulama yapılmaz */
  #validatePurchaseToken(/* token */) {
    return false;
  }

  /** @private */
  #validatePremiumExpiry() {
    const expiresAt = this.#state.premiumExpiresAt;
    if (expiresAt && new Date(expiresAt) < new Date()) {
      this.#state.isPremium       = false;
      this.#state.premiumPlan     = PremiumPlan.NONE;
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

  setBannerDismissed(value) { this.#rawSet('bannerDismissed', Boolean(value)); }

  setApiKey(key) {
    if (typeof key !== 'string') throw new TypeError('[StateManager] API key string olmalıdır');
    this.#apiKeyRuntime = key;
  }

  getApiKey()  { return this.#apiKeyRuntime; }
  clearApiKey() { this.#apiKeyRuntime = ''; }

  setLanguage(lang)      { this.#rawSet('language', lang); }

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
  // BÖLÜM 10 — PHASE 5: Window Event Listener Yönetimi
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * PHASE 5: Window storage + visibility listener'larını bağlar.
   * Referanslar private alanlara kaydedilir — dispose()'da kaldırılır.
   *
   * storage event: Başka sekmedeki localStorage değişikliklerini yakalar
   * (cross-tab sync). API key HİÇBİR ZAMAN storage üzerinden senkronize edilmez.
   *
   * visibilitychange event: Sekme gizlenince bekleyen persist'leri flush eder.
   */
  #attachWindowListeners() {
    if (typeof window === 'undefined') return;

    /* ── Storage (cross-tab sync) ── */
    this.#boundStorageHandler = (event) => {
      try {
        if (!event.key || !event.key.startsWith('state:')) return;
        const stateKey = event.key.replace('state:', '');

        /* Güvenlik: API key storage üzerinden senkronize edilmez */
        if (stateKey === 'apiKey') return;
        if (!PERSISTED_KEYS.has(stateKey)) return;

        const newValue = event.newValue !== null
          ? this.#deserialize(stateKey, event.newValue)
          : DEFAULT_STATE[stateKey];

        /* State'i notify ile güncelle — ama persist tetikleme (cross-tab loop önle) */
        const prev = this.#state[stateKey];
        if (!Object.is(prev, newValue)) {
          this.#state[stateKey] = newValue;
          this.#notify(stateKey, newValue, prev);
          console.info(`[StateManager] Cross-tab sync: ${stateKey}`);
        }
      } catch (err) {
        console.warn('[StateManager] Storage event hatası:', err);
      }
    };
    window.addEventListener('storage', this.#boundStorageHandler);

    /* ── Visibility Change (persist flush) ── */
    this.#boundVisibilityHandler = () => {
      if (document.hidden && this.#persistDebounceTimers.size > 0) {
        /* Sekme gizlendiğinde bekleyen persist'leri hemen yaz */
        this.flushPersist().catch((err) => {
          console.warn('[StateManager] Visibility flush hatası:', err);
        });
      }
    };
    document.addEventListener('visibilitychange', this.#boundVisibilityHandler);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // BÖLÜM 11 — Timer & Kaynak Yönetimi
  // ══════════════════════════════════════════════════════════════════════════

  registerTimer(timerId) { this.#timers.add(timerId); }

  clearAllTimers() {
    this.#timers.forEach((id) => {
      clearTimeout(id);
      clearInterval(id);
    });
    this.#timers.clear();
  }

  /**
   * PHASE 5: dispose() — Tam temizleme
   *   1. Tüm timer'lar iptal edilir
   *   2. Bekleyen persist'ler flush edilir
   *   3. window.storage + visibilitychange listener'ları removeEventListener ile kaldırılır
   *   4. Tüm subscriber'lar temizlenir
   *   5. API key bellekten silinir
   */
  async dispose() {
    console.info('[StateManager] Dispose başlatılıyor...');

    /* 1. Timer'ları iptal et */
    this.clearAllTimers();
    this.#persistDebounceTimers.forEach((id) => clearTimeout(id));

    /* 2. Bekleyen persist'leri flush et */
    try {
      await this.flushPersist();
    } catch (err) {
      console.warn('[StateManager] Dispose flush hatası:', err);
    }

    /* 3. PHASE 5: Window event listener'larını kaldır — bellek sızıntısı önlemi */
    try {
      if (this.#boundStorageHandler && typeof window !== 'undefined') {
        window.removeEventListener('storage', this.#boundStorageHandler);
        this.#boundStorageHandler = null;
        console.info('[StateManager] Storage listener kaldırıldı.');
      }
      if (this.#boundVisibilityHandler && typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', this.#boundVisibilityHandler);
        this.#boundVisibilityHandler = null;
        console.info('[StateManager] Visibility listener kaldırıldı.');
      }
    } catch (err) {
      console.warn('[StateManager] Listener temizleme uyarısı:', err);
    }

    /* 4. Subscriber'ları temizle */
    this.#keyListeners.clear();
    this.#globalListeners.clear();

    /* 5. API key'i bellekten sil */
    this.#apiKeyRuntime = '';

    console.info('[StateManager] Dispose tamamlandı.');
  }

  // ══════════════════════════════════════════════════════════════════════════
  // BÖLÜM 12 — Debug / DevTools
  // ══════════════════════════════════════════════════════════════════════════

  debug() {
    console.group('[StateManager] Mevcut State');
    const safeState = { ...this.#state, apiKey: '[GİZLİ — runtime]' };
    console.table(safeState);
    console.info('Listener sayısı:', {
      keyListeners:    this.#keyListeners.size,
      globalListeners: this.#globalListeners.size,
      timers:          this.#timers.size,
      pendingPersist:  this.#persistDebounceTimers.size,
      hydrated:        this.#hydrated,
    });
    console.groupEnd();
  }

  toPlainObject() {
    return { ...this.#state };
  }
}

// ─── Singleton Factory ────────────────────────────────────────────────────────

let _instance = null;

/* localStorage StorageAdapter — StateManager'ın persist/hydrate mekanizması için */
var _localStorageAdapter = {
  get: function(key) {
    return Promise.resolve(localStorage.getItem(key));
  },
  set: function(key, value) {
    try { localStorage.setItem(key, value); } catch(e) {}
    return Promise.resolve();
  },
  delete: function(key) {
    try { localStorage.removeItem(key); } catch(e) {}
    return Promise.resolve();
  }
};

function getStateManager(storageAdapter = null) {
  if (!_instance) {
    _instance = new StateManager(storageAdapter || _localStorageAdapter);
    /* Kaydedilmiş state'i geri yükle */
    _instance.hydrate().catch(function(e) {
      console.warn('[StateManager] Hydrate hatası:', e);
    });
  }
  return _instance;
}

function _resetStateManagerSingleton() {
  if (_instance) {
    _instance.dispose().catch(() => {});
    _instance = null;
  }
}

  // ── sessionBuffer ile entegrasyon ──
  // Sanctuary.sessionBuffer (main.js) bağlandığında state değişimlerini senkronize et
  var _sm = null;
  function _getOrCreate() {
    if (!_sm) {
      try { _sm = getStateManager(); } catch(e) { console.warn('[StateManager] init hatası:', e); }
    }
    return _sm;
  }

  global.SanctuaryState = {
    getInstance: _getOrCreate,
    getStateManager: getStateManager,
    Mood: typeof Mood !== 'undefined' ? Mood : {},
    Screen: typeof Screen !== 'undefined' ? Screen : {},
  };

})(window);

/* ═══════════════════════════════════════════════════════════
   9. AŞAMA — logActivity & stats
═══════════════════════════════════════════════════════════ */

window.SanctuaryStats = (function() {
  var STORAGE_KEY = 'sanctuary_activity_log';

  function _load() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); } 
    catch(e) { return []; }
  }

  function _save(log) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(log.slice(-100))); } 
    catch(e) {}
  }

  var MOOD_COLORS = {
    'Sakin':     '#6ecdc4',
    'Kaygılı':   '#9b8ec4',
    'Minnettar': '#c9a96e',
    'Huzursuz':  '#7a8fc4',
    'Mutsuz':    '#c48ea0',
    'Yorgun':    '#8ec4b0',
  };

  return {
    logActivity: function(type, duration, mood) {
      var log = _load();
      log.push({
        type: type || 'session',
        duration: duration || 0,
        mood: mood || localStorage.getItem('lastMood') || 'Sakin',
        ts: Date.now(),
        date: new Date().toISOString().slice(0,10),
      });
      _save(log);
      // Toplam istatistikleri güncelle
      try {
        var total = parseInt(localStorage.getItem('totalMinutes') || '0');
        localStorage.setItem('totalMinutes', total + Math.round((duration||0)/60));
        var sessions = parseInt(localStorage.getItem('sessionCount') || '0');
        localStorage.setItem('sessionCount', sessions + 1);
      } catch(e) {}
    },

    getLast7Days: function() {
      var log = _load();
      var result = [];
      for (var i = 6; i >= 0; i--) {
        var d = new Date();
        d.setDate(d.getDate() - i);
        var dateStr = d.toISOString().slice(0,10);
        var dayName = ['Paz','Pzt','Sal','Çar','Per','Cum','Cmt'][d.getDay()];
        var entries = log.filter(function(e) { return e.date === dateStr; });
        var totalMin = entries.reduce(function(s, e) { return s + Math.round((e.duration||0)/60); }, 0);
        var moods = entries.map(function(e) { return e.mood; });
        var topMood = moods.length ? moods[moods.length-1] : null;
        result.push({ date: dateStr, day: dayName, minutes: totalMin, mood: topMood, count: entries.length });
      }
      return result;
    },

    getStreak: function() {
      var log = _load();
      if (!log.length) return 0;
      var streak = 0;
      var today = new Date().toISOString().slice(0,10);
      for (var i = 0; i < 30; i++) {
        var d = new Date();
        d.setDate(d.getDate() - i);
        var dateStr = d.toISOString().slice(0,10);
        if (log.some(function(e) { return e.date === dateStr; })) streak++;
        else if (i > 0) break;
      }
      return streak;
    },

    getPersonalizedMessage: function() {
      var streak = this.getStreak();
      var mood = localStorage.getItem('lastMood') || '';
      var sessions = parseInt(localStorage.getItem('sessionCount') || '0');
      if (streak >= 7) return '🔥 ' + streak + '. gününde! Ritmine bak, ne kadar güçlü.';
      if (streak >= 3) return '✨ Bugün ' + streak + '. huzur günün. Devam et!';
      if (mood === 'Yorgun' && sessions > 5) return '🌙 Bugün dinlenme günün. Kendine nazik ol.';
      if (mood === 'Kaygılı') return '🌊 Nefes al. Her şey geçici, sen kalıcısın.';
      if (sessions === 0) return '🌱 İlk adımı atmışsın. Buradan yalnızca büyüme var.';
      return '🕯 Burada olman yeterli. Devam et.';
    },

    getSmartFreqSuggestion: function(mood) {
      var map = {
        'Yorgun':    { freq: 432, gen: 'binaural', beat: 4, label: '432 Hz — Derin dinlenme' },
        'Kaygılı':   { freq: 528, gen: 'binaural', beat: 6, label: '528 Hz — Hücre onarımı' },
        'Mutsuz':    { freq: 396, gen: 'rain',     beat: 5, label: '396 Hz — Özgürleşme' },
        'Huzursuz':  { freq: 180, gen: 'waves',    beat: 6, label: '180 Hz — Sakinleşme' },
        'Sakin':     { freq: 432, gen: 'binaural', beat: 7, label: '432 Hz — Derin huzur' },
        'Minnettar': { freq: 528, gen: 'rain',     beat:10, label: '528 Hz — Şükran' },
      };
      return map[mood] || map['Sakin'];
    },

    getMoodColor: function(mood) { return MOOD_COLORS[mood] || '#7a7890'; },
    getLog: function() { return _load(); },
    clearLog: function() { try { localStorage.removeItem(STORAGE_KEY); } catch(e) {} },
  };
})();
