/* =============================================================
   main-room-additions.js
   Sanctuary Oda Sistemi — UI mantığı
   main.js içindeki init() tarafından initRoomUI() çağrısıyla başlatılır.
   ============================================================= */

'use strict';

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
export function renderRooms(rooms) {
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
export function openCreateModal() {
  const modal = document.getElementById('createRoomModal');
  if (!modal) return;
  modal.classList.add('open');
  document.body.style.overflow = 'hidden';
  setTimeout(() => {
    const nameInput = document.getElementById('roomName');
    if (nameInput) nameInput.focus();
  }, 350);
}
export function closeCreateModal() {
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
export async function initRoomUI() {
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
