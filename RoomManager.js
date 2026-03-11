/* ═══════════════════════════════════════════════════════════════════════
   RoomManager.js — Sanctuary v2 (Host-Centric + Yüksek Hassasiyetli Sync)
   ─────────────────────────────────────────────────────────────────────
   Adım 3.1 — Yüksek hassasiyetli ses senkronizasyonu
   • Host: AudioEngine currentTime + Scene + PreferenceVector yayını
   • Client: latencyCompensation ile ms hassasiyetinde eşleşme
   • Biyometrik paylaşım: Host stressLevel → tüm client AudioEngine'leri
   • Resilience: bağlantı kopunca Standalone mod, son tercihler korunur
   ═══════════════════════════════════════════════════════════════════════ */
(function() {
  'use strict';

  var _userId          = _genId();
  var _role            = null;
  var _activeRoom      = null;
  var _peers           = {};
  var _channels        = {};
  var _rooms           = [];
  var _lastKnownState  = null;
  var _bioShareEnabled = false;
  var _pingLog         = {};

  var _bc = (typeof BroadcastChannel !== 'undefined')
    ? new BroadcastChannel('sanctuary_room') : null;

  function _genId()   { return Math.random().toString(36).slice(2,8).toUpperCase(); }
  function _genCode() { return Math.random().toString(36).slice(2,7).toUpperCase(); }

  function _signal(type, data) {
    if (_bc) _bc.postMessage({ type:type, from:_userId, data:data });
  }

  if (_bc) {
    _bc.onmessage = function(e) {
      var m = e.data;
      if (!m || m.from === _userId) return;
      if (m.type === 'offer')     _handleOffer(m.from, m.data);
      if (m.type === 'answer')    _handleAnswer(m.from, m.data);
      if (m.type === 'candidate') _handleIce(m.from, m.data);
      if (m.type === 'joinReq')   _handleJoinRequest(m.from, m.data);
    };
  }

  /* ── WebRTC ─────────────────────────────────────────────────────────── */
  function _createPeer(peerId, initiator) {
    if (_peers[peerId]) return _peers[peerId];
    var pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    });
    _peers[peerId] = pc;

    pc.onicecandidate = function(e) {
      if (e.candidate) _signal('candidate', { to:peerId, candidate:e.candidate });
    };
    pc.ondatachannel = function(e) { _setupChannel(peerId, e.channel); };

    pc.onconnectionstatechange = function() {
      if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
        console.warn('[RM] Bağlantı koptu:', peerId, '— Standalone mod aktif');
        _enterStandaloneMode();
        delete _channels[peerId];
        delete _peers[peerId];
        _updatePanel();
      }
    };

    if (initiator) {
      var ch = pc.createDataChannel('sanctuary');
      _setupChannel(peerId, ch);
      pc.createOffer()
        .then(function(o){ return pc.setLocalDescription(o); })
        .then(function(){ _signal('offer', { to:peerId, sdp:pc.localDescription }); })
        .catch(function(e){ console.warn('[RM] offer err', e); });
    }
    return pc;
  }

  function _setupChannel(peerId, ch) {
    _channels[peerId] = ch;
    ch.onopen  = function() {
      console.info('[RM] Kanal açık:', peerId);
      _pingLog[peerId] = { rtt: 0 };
      _measureLatency(peerId);
      _updatePanel();
    };
    ch.onclose = function() { delete _channels[peerId]; _updatePanel(); };
    ch.onmessage = function(e) {
      try { _handleRemoteCommand(JSON.parse(e.data), peerId); } catch(err){}
    };
  }

  function _handleOffer(from, data) {
    var pc = _createPeer(from, false);
    pc.setRemoteDescription(new RTCSessionDescription(data.sdp))
      .then(function(){ return pc.createAnswer(); })
      .then(function(a){ return pc.setLocalDescription(a); })
      .then(function(){ _signal('answer', { to:from, sdp:pc.localDescription }); })
      .catch(function(e){ console.warn('[RM] answer err', e); });
  }
  function _handleAnswer(from, data) {
    var pc = _peers[from];
    if (pc) pc.setRemoteDescription(new RTCSessionDescription(data.sdp)).catch(function(){});
  }
  function _handleIce(from, data) {
    var pc = _peers[from];
    if (pc && data.candidate)
      pc.addIceCandidate(new RTCIceCandidate(data.candidate)).catch(function(){});
  }
  function _handleJoinRequest(from, data) {
    if (_role !== 'host') return;
    if (_activeRoom && _activeRoom.members.length < _activeRoom.capacity) {
      _activeRoom.members.push({ id:from, name:data.name||'Dinleyici' });
      _createPeer(from, true);
      _updatePanel();
    }
  }

  /* ── Latency Ölçümü ─────────────────────────────────────────────── */
  function _measureLatency(peerId) {
    var ch = _channels[peerId];
    if (!ch || ch.readyState !== 'open') return;
    var sentAt = performance.now();
    try { ch.send(JSON.stringify({ action:'ping', ts: sentAt })); } catch(e) {}
    if (!_pingLog[peerId]) _pingLog[peerId] = {};
    _pingLog[peerId].sentAt = sentAt;
  }

  function _getRTT(peerId) {
    return (_pingLog[peerId] && _pingLog[peerId].rtt) ? _pingLog[peerId].rtt : 80;
  }

  /* ── Host: Yüksek Hassasiyetli Ses Durumu Yayını ─────────────────── */
  function broadcastAudioState() {
    if (_role !== 'host') return;

    var ae  = window.Sanctuary && window.Sanctuary.AudioEngine;
    var engineTime = 0;
    try {
      if (window._audioCtx) engineTime = window._audioCtx.currentTime;
    } catch(e) {}

    var state = {
      gen          : window._lastGen   || '',
      base         : window._lastBase  || 0,
      beat         : window._lastBeat  || 0,
      volume       : ae ? ae.getVolume() : (window._masterVolume || 0.8),
      engineTime   : engineTime,
      wallClock    : performance.now(),
      sceneName    : window._lastSceneName || null,
      preferenceVec: window.PreferenceVector ? {
        preferredGen  : window.PreferenceVector.preferredGen,
        preferredBase : window.PreferenceVector.preferredBase,
        layerGains    : window.PreferenceVector.layerGains,
      } : null,
    };

    if (_bioShareEnabled) {
      var adp = window.AdaptiveEngine;
      if (adp && typeof adp.getLastData === 'function') {
        var bio = adp.getLastData();
        if (bio) {
          state.hostBiometrics = { stress: bio.stress, bpm: bio.bpm, hrv: bio.hrv };
        }
      }
    }

    _lastKnownState = state;

    var cmd = JSON.stringify({ action:'applyRemoteState', data:state, ts:Date.now() });
    Object.values(_channels).forEach(function(ch) {
      if (ch.readyState === 'open') { try { ch.send(cmd); } catch(e) {} }
    });
  }

  /* ── Client: Komut İşleyici ──────────────────────────────────────── */
  function _handleRemoteCommand(cmd, peerId) {

    if (cmd.action === 'ping') {
      var ch = _channels[peerId];
      if (ch && ch.readyState === 'open') {
        try { ch.send(JSON.stringify({ action:'pong', ts: cmd.ts })); } catch(e) {}
      }
      return;
    }
    if (cmd.action === 'pong') {
      var rtt = performance.now() - cmd.ts;
      if (!_pingLog[peerId]) _pingLog[peerId] = {};
      _pingLog[peerId].rtt = rtt;
      _updatePanel();
      return;
    }

    if (cmd.action === 'applyRemoteState') {
      var d = cmd.data;
      _lastKnownState = d;

      /* Latency compensated sync */
      var rtt      = peerId ? _getRTT(peerId) : 80;
      var oneWayMs = rtt / 2;

      if (d.gen && d.base) {
        var startAt = Date.now() + Math.max(0, oneWayMs);
        if (typeof window.syncStart === 'function') {
          window.syncStart(startAt);
        }
        if (typeof window.switchSound === 'function') {
          window.switchSound(d.gen, d.base, d.beat || 0, d.sceneName || null, null);
        }
      }

      if (d.volume !== undefined && ae) {
        ae.setVolume(d.volume);
      }

      if (d.preferenceVec) {
        window.PreferenceVector = window.PreferenceVector || {};
        Object.assign(window.PreferenceVector, d.preferenceVec);
        var ae = window.Sanctuary && window.Sanctuary.AudioEngine;
        if (ae && d.preferenceVec.layerGains) {
          var lg = d.preferenceVec.layerGains;
          if (typeof ae.updateLayerGains === 'function')
            ae.updateLayerGains(lg.synth, lg.texture);
        }
      }

      if (d.hostBiometrics) {
        var ae2 = window.Sanctuary && window.Sanctuary.AudioEngine;
        if (ae2 && typeof ae2.applyBiometricEffect === 'function') {
          ae2.applyBiometricEffect({ tension: d.hostBiometrics.stress, hrv: d.hostBiometrics.hrv });
        }
        console.info('[RM] Co-regulation → host stress:', d.hostBiometrics.stress);
      }

      console.info('[RM] Sync uygulandı | RTT:', rtt.toFixed(1) + 'ms');
    }

    if (cmd.action === 'syncStart') {
      window.syncStart && window.syncStart(cmd.data.timestamp);
    }
    if (cmd.action === 'syncStop') {
      if (window._playing) window.togglePlay && window.togglePlay();
    }
  }

  /* ── Standalone Mod ─────────────────────────────────────────────── */
  function _enterStandaloneMode() {
    if (!_lastKnownState) return;
    if (_lastKnownState.preferenceVec) {
      window.PreferenceVector = window.PreferenceVector || {};
      Object.assign(window.PreferenceVector, _lastKnownState.preferenceVec);
    }
    var ae = window.Sanctuary && window.Sanctuary.AudioEngine;
    if (ae && !ae.isPlaying() && _lastKnownState.gen && _lastKnownState.base) {
      ae.play && ae.play();
    }
    _showNotif('📡 Bağlantı kesildi — müzik devam ediyor');
  }

  /* ── Public: Oda Kur ─────────────────────────────────────────────── */
  function createRoom(name, category, capacity) {
    _role = 'host';
    _activeRoom = {
      id      : _genId(),
      code    : _genCode(),
      name    : name || 'Sanctuary Odası',
      category: category || 'meditasyon',
      capacity: capacity || 8,
      hostId  : _userId,
      members : [{ id:_userId, name:'Sen (Host)', isHost:true }],
    };
    _rooms.unshift(_activeRoom);
    _showPanel();
    _updatePanel();
    window._rmBroadcastInterval = setInterval(broadcastAudioState, 2000);
    window._rmPingInterval = setInterval(function() {
      Object.keys(_channels).forEach(_measureLatency);
    }, 10000);
    console.info('[RM] Oda kuruldu:', _activeRoom.code);
    return _activeRoom;
  }

  /* ── Public: Odaya Katıl ─────────────────────────────────────────── */
  function joinRoom(code) {
    var room = _rooms.find(function(r){ return r.code === code.toUpperCase(); });
    if (!room) {
      _signal('joinReq', { code:code.toUpperCase(), name:'Dinleyici' });
      _activeRoom = { code:code.toUpperCase(), name:'Bağlanıyor...', members:[] };
      _role = 'listener';
      _showPanel();
      return;
    }
    _role = 'listener';
    _activeRoom = room;
    room.members.push({ id:_userId, name:'Dinleyici' });
    _createPeer(room.hostId, true);
    _showPanel();
    _updatePanel();
  }

  /* ── Public: Ayrıl ───────────────────────────────────────────────── */
  function leaveRoom() {
    clearInterval(window._rmBroadcastInterval);
    clearInterval(window._rmPingInterval);
    Object.values(_peers).forEach(function(pc){ try{pc.close();}catch(e){} });
    _peers={}; _channels={}; _activeRoom=null; _role=null;
    _hidePanel();
  }

  function broadcastCommand(action, data) {
    var cmd = JSON.stringify({ action:action, data:data, ts:Date.now() });
    Object.values(_channels).forEach(function(ch){
      if (ch.readyState==='open') { try{ ch.send(cmd); }catch(e){} }
    });
  }

  function setBioShare(enabled) {
    _bioShareEnabled = !!enabled;
    console.info('[RM] Biyometrik paylaşım:', _bioShareEnabled ? 'açık' : 'kapalı');
  }

  /* ── Panel UI ────────────────────────────────────────────────────── */
  function _showPanel() {
    var p = document.getElementById('room-panel');
    if (p) p.classList.add('active');
    var roleEl = document.getElementById('room-panel-role');
    if (roleEl) roleEl.textContent = _role === 'host' ? '👑 Yönetici' : '🎧 Dinleyici';
    var codeEl = document.getElementById('room-panel-code');
    if (codeEl && _activeRoom) codeEl.textContent = _activeRoom.code;
    _updatePanel();
  }

  function _hidePanel() {
    var p = document.getElementById('room-panel');
    if (p) p.classList.remove('active');
  }

  function _updatePanel() {
    if (!_activeRoom) return;
    var listEl = document.getElementById('room-panel-members');
    if (listEl) {
      listEl.innerHTML = (_activeRoom.members||[]).map(function(m){
        return '<div class="rp-member"><span class="rp-dot'+(m.isHost?' host':'')+'"></span>'+
               '<span>'+(m.name||'Kullanıcı')+'</span></div>';
      }).join('');
    }
    var qEl = document.getElementById('room-panel-quality');
    if (qEl) {
      var open = Object.values(_channels).filter(function(c){return c.readyState==='open';}).length;
      var rtts = Object.values(_pingLog).map(function(p){ return p.rtt||0; }).filter(Boolean);
      var avgRtt = rtts.length ? Math.round(rtts.reduce(function(a,b){return a+b;},0)/rtts.length) : null;
      qEl.textContent = open > 0
        ? '🟢 ' + open + ' bağlı' + (avgRtt ? ' · ' + avgRtt + 'ms' : '')
        : (_role === 'host' ? '⚪ Dinleyici bekleniyor' : '⚪ Bağlanıyor...');
    }
  }

  function _showNotif(msg) {
    var el = document.createElement('div');
    el.textContent = msg;
    el.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);'
      + 'background:rgba(6,10,24,0.95);border:1px solid rgba(201,169,110,0.25);'
      + 'border-radius:20px;padding:8px 18px;font-size:11px;color:rgba(201,169,110,0.8);'
      + 'letter-spacing:1px;z-index:901;pointer-events:none;opacity:0;transition:opacity 0.4s;';
    document.body.appendChild(el);
    setTimeout(function(){ el.style.opacity='1'; }, 50);
    setTimeout(function(){ el.style.opacity='0';
      setTimeout(function(){ if(el.parentNode)el.remove(); }, 400); }, 4000);
  }

  function getPublicRooms(filter) {
    if (!filter || filter === 'all') return _rooms;
    return _rooms.filter(function(r){ return r.category === filter; });
  }

  window.RoomManager = {
    createRoom         : createRoom,
    joinRoom           : joinRoom,
    leaveRoom          : leaveRoom,
    broadcastCommand   : broadcastCommand,
    broadcastAudioState: broadcastAudioState,
    getPublicRooms     : getPublicRooms,
    setBioShare        : setBioShare,
    getRole            : function(){ return _role; },
    getActiveRoom      : function(){ return _activeRoom; },
    getUserId          : function(){ return _userId; },
    getLatency         : function(peerId){ return peerId ? _getRTT(peerId) : _pingLog; },
  };

  console.info('[RoomManager v2] Host-Centric Sync hazır. userId:', _userId);
})();
