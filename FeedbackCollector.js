/**
 * FeedbackCollector.js — Sanctuary Adaptif Geribildirim Toplayıcı
 * ─────────────────────────────────────────────────────────────────────────────
 * Kullanıcı etkileşimlerini kaydeder ve PreferenceVector'ü günceller.
 * ─────────────────────────────────────────────────────────────────────────────
 */

class FeedbackCollector {
  constructor(preferenceVector) {
    this._pref        = preferenceVector; // PreferenceVector referansı
    this._sessionStart= null;
    this._events      = [];               // ham olay listesi
    this._flushTimer  = null;

    // Önceki oturumları yükle
    this._load();
  }

  /* ── Oturum başlat ─────────────────────────────────────────────────────── */
  startSession(mood) {
    this._sessionStart = Date.now();
    this._log('session_start', { mood });
  }

  /* ── Oturum bitir ──────────────────────────────────────────────────────── */
  endSession() {
    if (!this._sessionStart) return;
    const duration = Math.round((Date.now() - this._sessionStart) / 1000);
    this._log('session_end', { duration });
    this._sessionStart = null;

    // 10 saniyeden uzun oturumları tercih vektörüne yansıt
    if (duration > 10) {
      this._pref.recordSession(duration);
    }
    this._flush();
  }

  /* ── Ses kartı seçimi ──────────────────────────────────────────────────── */
  recordSoundChoice(gen, base, beat, mood) {
    this._log('sound_choice', { gen, base, beat, mood });
    this._pref.recordSoundChoice(gen, base, beat);
    this._scheduleFlush();
  }

  /* ── Ses seviyesi değişimi ─────────────────────────────────────────────── */
  recordVolumeChange(value, layer) {
    this._log('volume_change', { value, layer });
    this._pref.recordVolumeChange(value, layer);
    this._scheduleFlush();
  }

  /* ── Mood seçimi ───────────────────────────────────────────────────────── */
  recordMoodChoice(mood) {
    this._log('mood_choice', { mood });
    this._pref.recordMoodChoice(mood);
    this._scheduleFlush();
  }

  /* ── Geri bildirim (thumbs up/down) ───────────────────────────────────── */
  recordFeedback(type, context) {
    this._log('feedback', { type, context }); // type: 'positive'|'negative'
    if (type === 'positive') this._pref.reinforceCurrentSettings();
    if (type === 'negative') this._pref.attenuateCurrentSettings();
    this._scheduleFlush();
  }

  /* ── Ham olayları getir ────────────────────────────────────────────────── */
  getEvents(limit = 50) {
    return this._events.slice(-limit);
  }

  /* ── İstatistik özeti ─────────────────────────────────────────────────── */
  getSummary() {
    const totalSessions = this._events.filter(e => e.type === 'session_end').length;
    const totalDuration = this._events
      .filter(e => e.type === 'session_end')
      .reduce((s, e) => s + (e.data.duration || 0), 0);
    const soundChoices  = this._events.filter(e => e.type === 'sound_choice');
    const topGen = soundChoices.length > 0
      ? Object.entries(
          soundChoices.reduce((acc, e) => {
            acc[e.data.gen] = (acc[e.data.gen] || 0) + 1; return acc;
          }, {})
        ).sort((a,b) => b[1]-a[1])[0][0]
      : null;

    return { totalSessions, totalDuration, topGen, eventCount: this._events.length };
  }

  /* ── Temizlik ─────────────────────────────────────────────────────────── */
  destroy() {
    if (this._flushTimer) clearTimeout(this._flushTimer);
    this._flush();
  }

  /* ────────────────────────────────────────────────────────────────────────
   * ÖZEL
   * ──────────────────────────────────────────────────────────────────────── */

  _log(type, data) {
    this._events.push({ type, data, ts: Date.now() });
    // Bellek sınırı: son 500 olay
    if (this._events.length > 500) this._events.shift();
  }

  _scheduleFlush() {
    if (this._flushTimer) clearTimeout(this._flushTimer);
    this._flushTimer = setTimeout(() => this._flush(), 3000);
  }

  _flush() {
    try {
      localStorage.setItem('sanctuary_events',
        JSON.stringify(this._events.slice(-100))); // son 100 olayı sakla
    } catch(e) { /* localStorage dolu olabilir */ }
  }

  _load() {
    try {
      const raw = localStorage.getItem('sanctuary_events');
      if (raw) this._events = JSON.parse(raw);
    } catch(e) { this._events = []; }
  }
}

/* ── Export ───────────────────────────────────────────────────────────────── */
if (typeof module !== 'undefined') {
  module.exports = FeedbackCollector;
} else {
  window.FeedbackCollector = FeedbackCollector;
}
