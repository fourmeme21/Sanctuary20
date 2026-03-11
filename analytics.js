
/* ═══════════════════════════════════════════════════════════════
   10. AŞAMA — Senkronize Odalar, Avatar Aura, Reaksiyonlar
═══════════════════════════════════════════════════════════════ */

/* ── Oda Render (RoomManager entegreli) ── */
window.renderRooms = function(filter) {
  var grid = document.getElementById('roomsGrid');
  if (!grid) return;
  var rm = window.RoomManager;
  if (!rm) return;

  var rooms = rm.getPublicRooms(filter || 'all');
  grid.innerHTML = '';

  if (!rooms.length) {
    grid.innerHTML = '<div class="empty-state"><div class="empty-icon">🌙</div><p class="empty-title">Bu kategoride oda yok</p><p class="empty-sub">İlk odayı sen kur!</p></div>';
    return;
  }

  var catLabels = {odak:'🎯 Odak', uyku:'😴 Uyku', meditasyon:'🧘 Meditasyon', doga:'🌿 Doğa', genel:'✨ Genel'};

  rooms.forEach(function(room) {
    var card = rm.buildRoomCard(room);
    var pct = Math.round(card.capacityFill * 100);
    var initials = card.hostName.split(' ').map(function(w){ return w[0]||''; }).join('').slice(0,2).toUpperCase();

    var el = document.createElement('div');
    el.className = 'room-card';
    el.setAttribute('data-room-id', card.id);
    el.innerHTML =
      '<div class="card-top">' +
        '<span class="badge-live"><span class="dot"></span>LIVE</span>' +
        (card.isPrivate ? '<span class="badge-private">🔒 Özel</span>' : '') +
      '</div>' +
      '<div class="room-name">' + card.name + '</div>' +
      '<div class="room-category">' + (catLabels[card.category]||card.category) + '</div>' +
      '<div class="room-auras" id="auras-' + card.id + '">' + _buildAuras(room) + '</div>' +
      '<div class="card-footer">' +
        '<div class="host-info">' +
          '<div class="host-avatar">' + initials + '</div>' +
          '<span class="host-name">' + card.hostName + '</span>' +
        '</div>' +
        '<div class="capacity-bar-wrap">' +
          '<div class="capacity-text">' + card.current + '/' + card.capacity + ' kişi</div>' +
          '<div class="capacity-bar"><div class="capacity-fill" style="width:' + pct + '%"></div></div>' +
        '</div>' +
      '</div>' +
      '<div class="room-reactions" id="reactions-' + card.id + '"></div>';

    el.addEventListener('click', function(e) {
      if (e.target.classList.contains('reaction-btn')) return;
      window.openRoomModal && window.openRoomModal(card.id);
    });

    grid.appendChild(el);
  });
};

function _buildAuras(room) {
  var html = '';
  var shown = room.participants.slice(0,5);
  shown.forEach(function(uid, i) {
    var breathing = window.RoomManager && window.RoomManager.isBreathing(uid);
    html += '<div class="aura-dot' + (breathing ? ' breathing' : '') + '" title="' + uid + '"></div>';
  });
  if (room.participants.length > 5) {
    html += '<div class="aura-dot aura-more">+' + (room.participants.length-5) + '</div>';
  }
  return html;
}

/* ── Oda Modal ── */
window.openRoomModal = function(roomId) {
  var rm = window.RoomManager;
  if (!rm) return;
  var room = rm.getRoomById(roomId);
  if (!room) return;

  var modal = document.getElementById('room-modal');
  if (!modal) {
    modal = _createRoomModal();
    document.body.appendChild(modal);
  }

  var card = rm.buildRoomCard(room);
  modal.querySelector('.rm-title').textContent = card.name;
  modal.querySelector('.rm-host').textContent = '🎙 Host: ' + card.hostName;
  modal.querySelector('.rm-count').textContent = card.current + '/' + card.capacity + ' katılımcı';
  modal.setAttribute('data-room-id', roomId);

  // Ses senkronizasyonu
  var cfg = room.audioConfig || {};
  var freqEl = modal.querySelector('.rm-freq');
  if (freqEl) freqEl.textContent = cfg.base ? cfg.base + ' Hz · ' + (cfg.gen||'') : '—';

  modal.style.display = 'flex';
  requestAnimationFrame(function(){ modal.classList.add('show'); });
  document.body.style.overflow = 'hidden';

  // Odaya katılınca sesi senkronize et
  var joinBtn = modal.querySelector('.rm-join-btn');
  if (joinBtn) {
    joinBtn.onclick = function() {
      var res = rm.joinRoom(roomId);
      if (res.success && res.room.audioConfig && window.switchSound) {
        var a = res.room.audioConfig;
        window.switchSound(a.gen, a.base, a.beat, a.label||'');
        try{localStorage.setItem('lastGen',a.gen);localStorage.setItem('lastBase',a.base);localStorage.setItem('lastBeat',a.beat);}catch(e){}
      }
      window.closeRoomModal && window.closeRoomModal();
    };
  }
};

function _createRoomModal() {
  var m = document.createElement('div');
  m.id = 'room-modal';
  m.className = 'modal-overlay';
  m.style.display = 'none';
  m.innerHTML =
    '<div class="modal-sheet room-modal-sheet">' +
      '<div class="modal-handle-bar"></div>' +
      '<div class="rm-header">' +
        '<h3 class="rm-title"></h3>' +
        '<button class="modal-close-btn" onclick="window.closeRoomModal()">✕</button>' +
      '</div>' +
      '<div class="rm-meta">' +
        '<span class="rm-host"></span>' +
        '<span class="rm-count"></span>' +
      '</div>' +
      '<div class="rm-freq-wrap">🎵 <span class="rm-freq"></span></div>' +
      '<div class="rm-reaction-bar">' +
        '<button class="reaction-btn" onclick="window.sendReaction(\'❤️\')">❤️</button>' +
        '<button class="reaction-btn" onclick="window.sendReaction(\'✨\')">✨</button>' +
        '<button class="reaction-btn" onclick="window.sendReaction(\'🙏\')">🙏</button>' +
        '<button class="reaction-btn" onclick="window.sendReaction(\'🌊\')">🌊</button>' +
        '<button class="reaction-btn" onclick="window.sendReaction(\'🔥\')">🔥</button>' +
      '</div>' +
      '<button class="rm-join-btn cta-btn">✦ Odaya Katıl</button>' +
    '</div>';
  m.addEventListener('click', function(e){ if(e.target===m) window.closeRoomModal(); });
  return m;
}

window.closeRoomModal = function() {
  var m = document.getElementById('room-modal');
  if (!m) return;
  m.classList.remove('show');
  setTimeout(function(){ m.style.display='none'; document.body.style.overflow=''; }, 350);
};

/* ── Floating Reaksiyon Sistemi ── */
window.sendReaction = function(emoji) {
  var container = document.getElementById('reaction-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'reaction-container';
    container.style.cssText = 'position:fixed;bottom:120px;left:0;right:0;pointer-events:none;z-index:9999;';
    document.body.appendChild(container);
  }

  for (var i = 0; i < 3; i++) {
    (function(delay) {
      setTimeout(function() {
        var el = document.createElement('div');
        el.className = 'floating-reaction';
        el.textContent = emoji;
        el.style.left = (20 + Math.random() * 60) + '%';
        el.style.animationDuration = (1.5 + Math.random() * 1) + 's';
        container.appendChild(el);
        setTimeout(function(){ if(el.parentNode) el.parentNode.removeChild(el); }, 3000);
      }, delay);
    })(i * 200);
  }
};

/* ── Filtre bar güncelle ── */
(function() {
  function _initRooms() {
    window.renderRooms('all');
    var bar = document.getElementById('roomFilterBar');
    if (bar) {
      bar.addEventListener('click', function(e) {
        var chip = e.target.closest('.filter-chip');
        if (!chip) return;
        bar.querySelectorAll('.filter-chip').forEach(function(c){ c.classList.remove('active'); });
        chip.classList.add('active');
        window.renderRooms(chip.getAttribute('data-filter'));
      });
    }

    // RoomManager event'lerini dinle
    if (window.RoomManager) {
      window.RoomManager.on('audio_sync', function(data) {
        // Host ses değiştirdi — bildirim göster
        var toast = document.getElementById('notif-toast');
        if (toast) {
          var t = toast.querySelector('.nt-title');
          var b = toast.querySelector('.nt-body');
          if (t) t.textContent = '🎵 Host sesi güncelledi';
          if (b) b.textContent = (data.audioConfig.base||'') + ' Hz · ' + (data.audioConfig.gen||'');
          toast.classList.add('show');
          setTimeout(function(){ toast.classList.remove('show'); }, 3000);
        }
      });

      window.RoomManager.on('host_changed', function(data) {
        window.renderRooms && window.renderRooms('all');
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _initRooms);
  } else {
    setTimeout(_initRooms, 300);
  }
})();

/* ── Oda Oluşturma Modal Submit ── */
(function() {
  var _origSubmit = document.getElementById('btnSubmitRoom');
  function _hookSubmit() {
    var btn = document.getElementById('btnSubmitRoom');
    if (!btn || btn._phase10) return;
    btn._phase10 = true;
    btn.addEventListener('click', function() {
      var name = (document.getElementById('roomName')||{}).value;
      if (!name || !name.trim()) { var ni=document.getElementById('roomName'); if(ni)ni.focus(); return; }
      var category = (document.getElementById('roomCategory')||{}).value || 'genel';
      var isPriv = !!(document.querySelector('.type-btn.selected') && document.querySelector('.type-btn.selected').getAttribute('data-type')==='private');
      var cap = parseInt((document.getElementById('capValue')||{}).textContent||'10') || 10;
      var pwd = isPriv ? ((document.getElementById('roomPassword')||{}).value||'') : null;

      var res = window.RoomManager && window.RoomManager.createRoom({
        type: isPriv ? 'private' : 'public',
        name: name.trim(),
        hostId: 'user_local',
        capacity: cap,
        password: pwd,
        category: category,
        audioConfig: {gen:'binaural', base:432, beat:7},
      });

      window.renderRooms && window.renderRooms('all');
      var modal = document.getElementById('createRoomModal');
      if (modal) modal.style.display = 'none';
      var ni = document.getElementById('roomName'); if(ni) ni.value='';
    });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _hookSubmit);
  } else {
    setTimeout(_hookSubmit, 500);
  }
})();

