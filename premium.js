
/* ══════════════════════════════════════════════════
   SANCTUARY — GENERATIVE BACKGROUND ENGINE
   Metaball Field + Ribbon Waves + Sparkles + Ripples
   + CSS Floating Particles
══════════════════════════════════════════════════ */
(function() {
  'use strict';

  var CV = document.getElementById('gen-canvas');
  if (!CV) return;
  var CX = CV.getContext('2d');

  var cvRgb     = [110, 205, 196];
  var _cvRgbNow = [110, 205, 196];
  var cvBeat    = 7;
  var cvTime    = 0;
  var ripples   = [];
  var MAX_RIPPLES = 14;

  var BLOBS = (function() {
    var a = [];
    for (var i = 0; i < 9; i++) {
      a.push({
        x: 0.08 + Math.random() * 0.84,
        y: 0.08 + Math.random() * 0.84,
        vx: (Math.random() - 0.5) * 0.00040,
        vy: (Math.random() - 0.5) * 0.00040,
        r:  0.042 + Math.random() * 0.044,
        ph: Math.random() * Math.PI * 2
      });
    }
    return a;
  })();

  function resizeCV() {
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    CV.width  = window.innerWidth  * dpr;
    CV.height = window.innerHeight * dpr;
    CV.style.width  = window.innerWidth  + 'px';
    CV.style.height = window.innerHeight + 'px';
    CX.scale(dpr, dpr);
  }
  window.addEventListener('resize', resizeCV);
  resizeCV();

  function lerp(a, b, t) { return a + (b - a) * t; }

  var _lastTs = 0;
  function renderLoop(ts) {
    requestAnimationFrame(renderLoop);
    var dt = Math.min((ts - _lastTs) / 16.67, 3);
    _lastTs = ts;
    var W = window.innerWidth, H = window.innerHeight;

    _cvRgbNow[0] = lerp(_cvRgbNow[0], cvRgb[0], 0.018 * dt);
    _cvRgbNow[1] = lerp(_cvRgbNow[1], cvRgb[1], 0.018 * dt);
    _cvRgbNow[2] = lerp(_cvRgbNow[2], cvRgb[2], 0.018 * dt);
    var r = _cvRgbNow[0]|0, g = _cvRgbNow[1]|0, b = _cvRgbNow[2]|0;

    cvTime += 0.005 * dt * (0.42 + cvBeat / 22);

    CX.fillStyle = 'rgba(5,5,7,0.05)';
    CX.fillRect(0, 0, W, H);

    BLOBS.forEach(function(bl) {
      var p = 0.88 + 0.12 * Math.sin(cvTime * 1.1 + bl.ph);
      bl.x += bl.vx * p * dt;
      bl.y += bl.vy * p * dt;
      if (bl.x < 0.02 || bl.x > 0.98) { bl.vx *= -1; bl.x = Math.max(0.02, Math.min(0.98, bl.x)); }
      if (bl.y < 0.02 || bl.y > 0.98) { bl.vy *= -1; bl.y = Math.max(0.02, Math.min(0.98, bl.y)); }
    });

    var step = 22;
    for (var px = 0; px < W; px += step) {
      for (var py = 0; py < H; py += step) {
        var field = 0;
        BLOBS.forEach(function(bl) {
          var dx = (px/W) - bl.x, dy = (py/H) - bl.y;
          var rr = bl.r * (1 + 0.18 * Math.sin(cvTime * cvBeat * 0.11 + bl.ph));
          field += (rr*rr)/(dx*dx+dy*dy+1e-5);
        });
        if (field > 0.011 && field < 0.11) {
          var tt = Math.min((field-0.011)/0.099, 1);
          CX.fillStyle = 'rgba('+r+','+g+','+b+','+(tt*0.13)+')';
          CX.fillRect(px - step*0.5, py - step*0.5, step, step);
        }
      }
    }

    for (var ri = 0; ri < 3; ri++) {
      var yBase = H*(0.16+ri*0.24), ampW = H*(0.050+ri*0.015);
      var freq = cvBeat*0.064+ri*0.22, ph = cvTime*(1+ri*0.35)+ri*1.6;
      CX.beginPath();
      for (var x = 0; x <= W; x += 6) {
        var y = yBase
          + Math.sin(x/W*Math.PI*freq*4+ph)*ampW
          + Math.sin(x/W*Math.PI*freq*1.8-ph*0.65)*ampW*0.38
          + Math.sin(x/W*Math.PI*freq*0.85+ph*1.4)*ampW*0.18;
        if (x===0) CX.moveTo(x,y); else CX.lineTo(x,y);
      }
      CX.strokeStyle = 'rgba('+r+','+g+','+b+','+(0.033-ri*0.005)+')';
      CX.lineWidth = 1.3+ri*0.3;
      CX.stroke();
    }

    if (Math.random() < 0.07) {
      var spx = Math.random()*W, spy = Math.random()*H, spr = 0.5+Math.random()*2;
      CX.beginPath(); CX.arc(spx,spy,spr,0,Math.PI*2);
      CX.fillStyle='rgba('+r+','+g+','+b+','+(0.015+Math.random()*0.045)+')'; CX.fill();
    }

    var glR = Math.min(W,H)*0.24;
    var glA = 0.020+0.007*Math.sin(cvTime*0.8);
    var grad = CX.createRadialGradient(W*0.5,H*0.5,0,W*0.5,H*0.5,glR);
    grad.addColorStop(0,'rgba('+r+','+g+','+b+','+glA+')');
    grad.addColorStop(1,'rgba('+r+','+g+','+b+',0)');
    CX.beginPath(); CX.arc(W*0.5,H*0.5,glR,0,Math.PI*2);
    CX.fillStyle=grad; CX.fill();

    for (var i = ripples.length-1; i >= 0; i--) {
      var rp = ripples[i];
      rp.rad += 3.6*dt; rp.alpha -= 0.011*dt;
      if (rp.alpha <= 0) { ripples.splice(i,1); continue; }
      for (var ring=0; ring<3; ring++) {
        var rrr = rp.rad - ring*24;
        if (rrr <= 0) continue;
        CX.beginPath(); CX.arc(rp.x,rp.y,rrr,0,Math.PI*2);
        CX.strokeStyle='rgba('+r+','+g+','+b+','+(rp.alpha*(1-ring*0.32))+')';
        CX.lineWidth=1.1-ring*0.26; CX.stroke();
      }
      var gd=CX.createRadialGradient(rp.x,rp.y,0,rp.x,rp.y,rp.rad*0.4);
      gd.addColorStop(0,'rgba('+r+','+g+','+b+','+(rp.alpha*0.26)+')');
      gd.addColorStop(1,'rgba('+r+','+g+','+b+',0)');
      CX.beginPath(); CX.arc(rp.x,rp.y,rp.rad*0.4,0,Math.PI*2);
      CX.fillStyle=gd; CX.fill();
    }
  }
  requestAnimationFrame(renderLoop);

  function spawnRipple(x,y) {
    if (ripples.length >= MAX_RIPPLES) ripples.shift();
    ripples.push({x:x, y:y, rad:0, alpha:0.75});
  }

  document.addEventListener('mousedown', function(e) { spawnRipple(e.clientX, e.clientY); });
  document.addEventListener('mousemove', function(e) { if(e.buttons && Math.random()<0.15) spawnRipple(e.clientX,e.clientY); });
  document.addEventListener('touchstart', function(e) {
    Array.prototype.forEach.call(e.touches, function(t){ spawnRipple(t.clientX,t.clientY); });
  }, {passive:true});
  document.addEventListener('touchmove', function(e) {
    if(Math.random()<0.25) Array.prototype.forEach.call(e.touches, function(t){ spawnRipple(t.clientX,t.clientY); });
  }, {passive:true});

  /* CSS floating particles */
  var colors=['rgba(110,205,196,0.6)','rgba(155,142,196,0.5)','rgba(201,169,110,0.55)','rgba(255,255,255,0.28)'];
  for (var pi=0; pi<16; pi++) {
    var el=document.createElement('div');
    el.className='bg-particle';
    var sz=1.5+Math.random()*3, left=Math.random()*100;
    var dur=14+Math.random()*22, del=-(Math.random()*dur);
    var drift=(Math.random()-0.5)*110;
    var col=colors[Math.floor(Math.random()*colors.length)];
    el.style.cssText='width:'+sz+'px;height:'+sz+'px;left:'+left+'vw;bottom:-10px;background:'+col+';box-shadow:0 0 '+(sz*3)+'px '+col+';--drift:'+drift+'px;animation-duration:'+dur+'s;animation-delay:'+del+'s';
    document.body.appendChild(el);
  }

  /* Mood rengi API — window.setBgMood('violet') */
  var MOOD_COLORS={teal:[110,205,196],violet:[155,142,196],gold:[201,169,110],rose:[210,130,140],sky:[100,180,230]};
  window.setBgMood=function(name){
    var c=MOOD_COLORS[name]; if(c){ cvRgb=c.slice(); cvBeat={teal:7,violet:10,gold:6,rose:8,sky:5}[name]||7; }
  };
})();
