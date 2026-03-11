/* ══════════════════════════════════════════════════════════════
   PerformanceMonitor.js — Sanctuary Adım 12
   Sekme arka planda → GPU minimizasyonu
   ══════════════════════════════════════════════════════════════ */
(function() {
  'use strict';

  var _hidden = false;

  document.addEventListener('visibilitychange', function() {
    _hidden = document.hidden;
    if (_hidden) {
      /* Sekme arka plana geçti — visualizer durdur */
      if (window.VisualizerEngine) window.VisualizerEngine.stop();
      console.info('[PerformanceMonitor] Arka plan — visualizer durduruldu');
    } else {
      /* Sekme öne geldi — visualizer başlat */
      if (window.VisualizerEngine && window._playing) window.VisualizerEngine.start();
      console.info('[PerformanceMonitor] Ön plan — visualizer başlatıldı');
    }
  });

  function isHidden() { return _hidden; }

  window.PerformanceMonitor = { isHidden: isHidden };
  console.info('[PerformanceMonitor] Adım 12 hazır');
})();