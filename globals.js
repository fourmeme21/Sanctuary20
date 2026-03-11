
/* ── Global fonksiyon atamaları ── */
window.pickMood = function(el) {
  var mood  = el.getAttribute('data-mood');
  var emoji = el.querySelector('.ic').textContent;
  document.querySelectorAll('.mood-chip').forEach(function(c){ c.classList.remove('sel'); });
  el.classList.add('sel');
  var me=document.getElementById('s-emoji'), mm=document.getElementById('s-mood');
  if(me) me.textContent=emoji;
  if(mm) mm.textContent=mood;
  var msgs={
    'Huzursuz':'Huzursuzluk geçici bir misafir gibidir. Nefes al, buradasın.',
    'Yorgun':'Dinlenmek bir lüks değil, ihtiyaçtır. Kendine izin ver.',
    'Kaygılı':'Kaygı, zihninin seni koruma çabası. Şimdi güvendesin.',
    'Mutsuz':'Her duygu geçer. Bu da geçecek. Burada seninleyim.',
    'Sakin':'Sakinlik senin doğal halin. Onu koruyalım.',
    'Minnettar':'Minnettarlık kalbi açar, dünyayı aydınlatır.'
  };
  var msgEl=document.getElementById('s-message');
  if(msgEl) msgEl.textContent=msgs[mood]||'';
  var bgMap={
    'Huzursuz':'teal','Yorgun':'violet','Kaygılı':'sky',
    'Mutsuz':'rose','Sakin':'teal','Minnettar':'gold'
  };
  if(typeof window.setBgMood==='function') window.setBgMood(bgMap[mood]||'teal');
  /* StateManager'a kaydet */
  try {
    var sm = (typeof getStateManager === 'function') ? getStateManager() : null;
    if (sm && typeof sm.setSelectedMood === 'function') sm.setSelectedMood(mood);
  } catch(e) {}
  try {
    localStorage.setItem('lastMood',mood);
    localStorage.setItem('lastEmoji',emoji);
    localStorage.removeItem('lastGen');
    localStorage.removeItem('lastBase');
    localStorage.removeItem('lastBeat');
  } catch(e) {}
};

window.openPaywall = function(){
  var o=document.getElementById('paywall-overlay');
  if(!o) return;
  o.style.display='flex';
  requestAnimationFrame(function(){ o.classList.add('show'); });
  document.body.style.overflow='hidden';
};

window.closePaywall = function(){
  var o=document.getElementById('paywall-overlay');
  if(!o) return;
  o.classList.remove('show');
  setTimeout(function(){ o.style.display='none'; document.body.style.overflow=''; }, 400);
};

window.saveJournalEntry = function(){
  var ta=document.getElementById('journal-textarea');
  var text=ta?ta.value.trim():'';
  if(!text) return;
  try{
    localStorage.setItem('lastJournal',text);
    localStorage.setItem('lastJournalDate',new Date().toISOString());
  }catch(e){}
  var st=document.getElementById('journal-save-status');
  if(st){st.textContent='✓ Kaydedildi';setTimeout(function(){st.textContent='';},2000);}
};

/* ══════════════════════════════════════════════════════════════════════════
   generateAIFreq — GeminiAdapter üzerinden GERÇEK API çağrısı
   ─────────────────────────────────────────────────────────────────────────
   Eski sahte keyword-match fonksiyonu TAMAMEN kaldırıldı.
   Artık:
     1. GeminiAdapter.generateScene() → Maestro JSON
     2. SceneInterpreter.interpret()  → audioScript + cssCommands + uiCommands
     3. SceneInterpreter.apply()      → AudioEngine + DOM
   ══════════════════════════════════════════════════════════════════════════ */
window.generateAIFreq = function() {
  /* Girdi alanı */
  var input = document.getElementById('ai-input');
  if (!input || !input.value.trim()) {
    if (input) {
      input.style.borderColor = 'rgba(255,100,100,0.5)';
      setTimeout(function(){ input.style.borderColor = ''; }, 1500);
    }
    if (window.SanctuaryToast) {
      window.SanctuaryToast.warning('Lütfen bir niyet veya ruh hali yazın.', 'Boş İstek');
    }
    return;
  }

  var userInput = input.value.trim();

  /* Aktif ruh halini StateManager veya DOM'dan al */
  var selectedMood = 'Calm';
  try {
    var sm = (typeof getStateManager === 'function') ? getStateManager() : null;
    if (sm && typeof sm.getSelectedMood === 'function') {
      selectedMood = sm.getSelectedMood() || selectedMood;
    } else {
      var moodEl = document.getElementById('s-mood');
      if (moodEl && moodEl.textContent.trim()) selectedMood = moodEl.textContent.trim();
    }
  } catch(e) {}

  /* GeminiAdapter kontrolü */
  if (typeof window.GeminiAdapter === 'undefined') {
    console.error('[generateAIFreq] GeminiAdapter yüklenmedi!');
    if (window.SanctuaryToast) {
      window.SanctuaryToast.error('AI motoru hazır değil. Lütfen sayfayı yenileyin.', 'Sistem Hatası');
    }
    return;
  }

  /* SceneInterpreter kontrolü */
  if (typeof window.SceneInterpreter === 'undefined') {
    console.error('[generateAIFreq] SceneInterpreter yüklenmedi!');
    if (window.SanctuaryToast) {
      window.SanctuaryToast.error('Sahne yorumlayıcı hazır değil. Lütfen sayfayı yenileyin.', 'Sistem Hatası');
    }
    return;
  }

  /* UI: Buton loading durumu */
  var btn = document.getElementById('ai-generate-btn');
  var restoreBtn = null;
  if (btn && window.SanctuaryLoading) {
    restoreBtn = window.SanctuaryLoading.setButtonLoading(btn, 'Oracle düşünüyor…');
  } else if (btn) {
    btn.disabled = true;
    btn.textContent = '✦ Düşünüyor...';
    restoreBtn = function() {
      btn.disabled = false;
      btn.textContent = "✦ Oracle'ı Uyandır";
    };
  }

  /* AI Oracle processing overlay */
  if (window.SanctuaryAiUI) {
    window.SanctuaryAiUI.showProcessing();
  }

  /* ── GeminiAdapter çağrısı ── */
  var adapter = new window.GeminiAdapter();

  adapter.generateScene(userInput, selectedMood)
    .then(function(maestro) {
      /* Overlay kapat */
      if (window.SanctuaryAiUI) window.SanctuaryAiUI.hideProcessing();
      if (restoreBtn) restoreBtn();

      /* Maestro'yu yorumla */
      var result = window.SceneInterpreter.interpret(maestro);
      if (!result) {
        console.error('[generateAIFreq] SceneInterpreter yorumlayamadı:', maestro);
        if (window.SanctuaryToast) {
          window.SanctuaryToast.error('Sahne yorumlanamadı. Tekrar deneyin.', 'Oracle Hatası');
        }
        return;
      }

      /* AudioEngine instance'ını al */
      var engine = null;
      try {
        if (typeof AudioEngine !== 'undefined' && AudioEngine.getInstance) {
          engine = AudioEngine.getInstance();
        }
      } catch(e) {}

      /* Nefes döngüsü DOM elemanları */
      var breathWrap = document.getElementById('breath-circle') || document.querySelector('.breath-wrap');
      var guideEl    = document.getElementById('breath-guide')  || document.querySelector('.breath-guide');

      /* Komutları uygula */
      window.SceneInterpreter.apply(result, {
        engine    : engine,
        breathWrap: breathWrap,
        guideEl   : guideEl,
      });

      /* Başarı bildirimi */
      if (window.SanctuaryToast) {
        window.SanctuaryToast.success(
          maestro.sceneName + ' · ' + maestro.baseHz + ' Hz',
          '✦ Oracle Aktif'
        );
      }

      /* LocalStorage güncelle */
      try {
        localStorage.setItem('lastBase', maestro.baseHz);
        localStorage.setItem('lastBeat', maestro.binauralHz);
        localStorage.setItem('lastGen', 'binaural');
      } catch(e) {}

      console.info('[generateAIFreq] ✅ Pipeline tamamlandı:',
        maestro.sceneName, '| velvetReady:', maestro.velvetReady);
    })
    .catch(function(err) {
      if (window.SanctuaryAiUI) window.SanctuaryAiUI.hideProcessing();
      if (restoreBtn) restoreBtn();
      console.error('[generateAIFreq] Pipeline hatası:', err);
      if (window.SanctuaryToast) {
        window.SanctuaryToast.error('AI Oracle bir hatayla karşılaştı.', 'Oracle Hatası');
      }
    });
};

window.showAnalytics = function(){
  var sessions=parseInt(localStorage.getItem('sessionCount')||'0');
  var minutes=parseInt(localStorage.getItem('totalMinutes')||'0');
  var streak=parseInt(localStorage.getItem('currentStreak')||'0');
  var s=document.getElementById('stat-sessions');
  var m=document.getElementById('stat-minutes');
  var st=document.getElementById('stat-streak');
  if(s)s.textContent=sessions;
  if(m)m.textContent=minutes;
  if(st)st.textContent=streak;
  document.querySelectorAll('.screen').forEach(function(sc){sc.classList.remove('on');sc.classList.add('off');});
  var t=document.getElementById('screen-analytics');
  if(t){t.classList.remove('off');t.classList.add('on');}
  requestAnimationFrame(function(){
    var canvas=document.getElementById('analytics-canvas');
    if(!canvas)return;
    var ctx=canvas.getContext('2d'),W=canvas.offsetWidth||300,H=120;
    canvas.width=W;canvas.height=H;
    var days=['Pzt','Sal','Çar','Per','Cum','Cmt','Paz'];
    var vals=days.map(function(){return Math.floor(Math.random()*40);});
    vals[6]=minutes%40;
    var max=Math.max.apply(null,vals.concat([1]));
    ctx.clearRect(0,0,W,H);
    var barW=W/7*0.6,gap=W/7;
    days.forEach(function(day,i){
      var x=gap*i+gap*0.2,bh=(vals[i]/max)*(H-24),y=H-bh-20;
      var g=ctx.createLinearGradient(0,y,0,H-20);
      g.addColorStop(0,'rgba(201,169,110,0.8)');
      g.addColorStop(1,'rgba(201,169,110,0.15)');
      ctx.fillStyle=g;ctx.beginPath();
      if(ctx.roundRect)ctx.roundRect(x,y,barW,bh,4);else ctx.rect(x,y,barW,bh);
      ctx.fill();
      ctx.fillStyle='rgba(122,120,144,0.7)';ctx.font='9px sans-serif';
      ctx.textAlign='center';ctx.fillText(day,x+barW/2,H-4);
    });
  });
};
