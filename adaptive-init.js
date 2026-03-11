
/* ── PreferenceVector + FeedbackCollector Başlatma ── */
(function() {
  function _initAdaptive() {
    if (window.PreferenceVector) {
      window._prefVector = new window.PreferenceVector();
    }
    if (window.FeedbackCollector && window._prefVector) {
      window._feedbackCollector = new window.FeedbackCollector(window._prefVector);
    }

    /* pickMood'u wrap et — mood seçimini kaydet */
    var _origPickMood = window.pickMood;
    window.pickMood = function(el) {
      if (_origPickMood) _origPickMood(el);
      var mood = el && el.getAttribute('data-mood');
      if (mood) {
        if (window._prefVector) window._prefVector.recordMoodChoice(mood);
        if (window._feedbackCollector) window._feedbackCollector.recordMoodChoice(mood);
        try { localStorage.setItem('lastMood', mood); } catch(e){}
      }
    };

    /* Play/pause oturum takibi — togglePlay'i patch et */
    var _playBtn = document.getElementById('play-btn');
    if (_playBtn) {
      _playBtn.addEventListener('click', function() {
        var isOn = _playBtn.classList.contains('on');
        if (!isOn) {
          /* Durdu → az önce durakladı */
          if (window._feedbackCollector) window._feedbackCollector.endSession();
        } else {
          /* Başladı */
          var mood = null;
          try { mood = localStorage.getItem('lastMood'); } catch(e){}
          if (window._feedbackCollector) window._feedbackCollector.startSession(mood);
        }
      }, true); /* capture=true: togglePlay'den sonra çalışır */
    }

    console.info('[Sanctuary] Adaptif sistem hazır. Vektör:', 
      window._prefVector ? window._prefVector.toJSON() : 'yok');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() { setTimeout(_initAdaptive, 200); });
  } else {
    setTimeout(_initAdaptive, 200);
  }
})();
