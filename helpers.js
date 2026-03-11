
/* ── Eksik yardımcı fonksiyonlar ── */

/* Ekran geçişleri */
window.goSanctuary = function() {
  document.querySelectorAll('.screen').forEach(function(s){ s.classList.remove('on'); s.classList.add('off'); });
  var t = document.getElementById('screen-sanctuary');
  if (t) { t.classList.remove('off'); t.classList.add('on'); }
};
window.goBack = function() {
  document.querySelectorAll('.screen').forEach(function(s){ s.classList.remove('on'); s.classList.add('off'); });
  var analytics = document.getElementById('screen-analytics');
  var target = (analytics && analytics.classList.contains('on')) ? 'screen-sanctuary' : 'screen-mood';
  var t = document.getElementById(target);
  if (t) { t.classList.remove('off'); t.classList.add('on'); }
};
window.acceptDisclaimer = function(){
  var d=document.getElementById('legal-disclaimer');
  if(d)d.style.display='none';
  try{localStorage.setItem('disclaimerAccepted','true');}catch(e){}
};
window.clearData = function(){
  if(confirm('Tüm veriler silinecek. Emin misin?')){
    try{localStorage.clear();}catch(e){}
    window.showAnalytics && window.showAnalytics();
  }
};
window.closeHealthModal = function(ev){
  if(!ev||ev.target.id==='health-modal'){
    var m=document.getElementById('health-modal');if(m)m.style.display='none';
  }
};
window.copyHealthData = function(){
  var txt=document.getElementById('health-json-content');
  try{navigator.clipboard.writeText(txt?txt.textContent:'{}');}catch(e){}
  alert('Kopyalandı');
};
window.dismissBanner = function(){
  var b=document.getElementById('hp-banner');if(b)b.style.display='none';
};
window.dismissPWABanner = function(){
  var b=document.getElementById('pwa-banner');if(b)b.style.display='none';
};
window.exportHealth = function(){ alert('Sağlık verileri dışa aktarıldı.'); };
window.handlePurchase = function(){ alert('Premium satın alındı!'); window.closePaywall && window.closePaywall(); };
window.restorePurchase = function(){ alert('Satın alım geri yükleniyor...'); };
window.selectPlan = function(el){
  document.querySelectorAll('.pw-plan').forEach(function(p){p.classList.remove('sel');});
  el.classList.add('sel');
};
window.triggerPWAInstall = function(){ alert('PWA kurulumu başlatılıyor...'); };
window.updateTrialState = function(){
  var on=document.getElementById('pw-trial-toggle');
  var note=document.getElementById('pw-cta-note');
  if(note)note.textContent=on&&on.checked?'Deneme bittikten sonra $59.99/yıl.':'Hemen $59.99/yıl faturalandırılır.';
};
