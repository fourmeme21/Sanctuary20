/* ═══════════════════════════════════════════════════════════════════════
   FirebaseManager.js — Sanctuary v4
   ─────────────────────────────────────────────────────────────────────
   Adım 6.1 — Cloud Entegrasyonu & Firestore Sync
   • PreferenceVector → Firestore user_preferences (conflict resolution)
   • Global session history → LearningEngine merge
   • RoomManager → active_rooms Firestore mirror
   • Anonymous / authenticated UID tüm telemetri için bağlanır
   ─────────────────────────────────────────────────────────────────────
   Başlatma (index.html, diğer script'lerden SONRA):
     <script src="https://www.gstatic.com/firebasejs/10.x.x/firebase-app-compat.js"></script>
     <script src="https://www.gstatic.com/firebasejs/10.x.x/firebase-auth-compat.js"></script>
     <script src="https://www.gstatic.com/firebasejs/10.x.x/firebase-firestore-compat.js"></script>
     <script src="FirebaseManager.js"></script>
   Ardından:
     FirebaseManager.init({ apiKey:'...', projectId:'...', ... });
   ═══════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  /* ── Durum ───────────────────────────────────────────────────────── */
  var _db          = null;
  var _auth        = null;
  var _uid         = null;          /* Aktif kullanıcı UID */
  var _initialized = false;
  var _prefSyncTimer = null;
  var _activeRoomRef = null;        /* Firestore'daki aktif oda referansı */

  /* Affinity değişikliğinin "anlamlı" sayılması için minimum delta */
  var AFFINITY_DELTA_MIN = 0.08;
  var PREF_DEBOUNCE_MS   = 5000;    /* Art arda gelenleri 5sn biriktir */

  /* ══════════════════════════════════════════════════════════════════
     INIT
  ══════════════════════════════════════════════════════════════════ */
  function init(firebaseConfig) {
    if (_initialized) return;

    if (!window.firebase) {
      console.error('[FirebaseManager] firebase SDK yüklenmemiş.');
      return;
    }

    if (!firebase.apps.length) {
      firebase.initializeApp(firebaseConfig);
    }

    _db   = firebase.firestore();
    _auth = firebase.auth();

    /* Çevrimdışı kalıcılık — Firestore offline cache */
    _db.enablePersistence({ synchronizeTabs: true })
      .catch(function(err) {
        if (err.code !== 'failed-precondition' && err.code !== 'unimplemented') {
          console.warn('[FirebaseManager] Offline persistence hatası:', err.code);
        }
      });

    _initialized = true;
    _initAuth();
    console.info('[FirebaseManager v4] Başlatıldı. Proje:', firebaseConfig.projectId);
  }

  /* ══════════════════════════════════════════════════════════════════
     AUTH — Anonymous / Signed-in UID yönetimi
  ══════════════════════════════════════════════════════════════════ */
  function _initAuth() {
    _auth.onAuthStateChanged(function(user) {
      if (user) {
        _uid = user.uid;
        console.info('[FirebaseManager] Auth:', user.isAnonymous ? 'Anonim' : 'Kayıtlı', '| UID:', _uid);
        _onUserReady();
      } else {
        /* Kullanıcı yoksa anonim oturum aç */
        _auth.signInAnonymously().catch(function(err) {
          console.warn('[FirebaseManager] Anonim giriş hatası:', err.message);
        });
      }
    });
  }

  function _onUserReady() {
    _loadGlobalSessionHistory();
    _watchPreferenceConflicts();

    /* LearningEngine'e UID'yi bildir */
    if (window.LearningEngine && typeof window.LearningEngine.setUid === 'function') {
      window.LearningEngine.setUid(_uid);
    }
    window._sanctuaryUid = _uid;
  }

  /* ── Kullanıcı upgrade: anonim → gerçek hesap ── */
  function linkWithGoogle() {
    if (!_auth) return Promise.reject('Auth hazır değil');
    var provider = new firebase.auth.GoogleAuthProvider();
    return _auth.currentUser.linkWithPopup(provider)
      .then(function(result) {
        _uid = result.user.uid;
        console.info('[FirebaseManager] Google hesabına bağlandı:', _uid);
        return _uid;
      });
  }

  /* ══════════════════════════════════════════════════════════════════
     PREFERENCE VECTOR SYNC
  ══════════════════════════════════════════════════════════════════ */

  /**
   * syncPreferenceVector(vector)
   * LearningEngine anlamlı bir affinity değişikliği tespit ettiğinde çağırır.
   * Debounce ile art arda yazma önlenir.
   */
  function syncPreferenceVector(vector) {
    if (!_db || !_uid) {
      console.warn('[FirebaseManager] syncPreferenceVector: DB veya UID hazır değil.');
      return;
    }
    if (_prefSyncTimer) clearTimeout(_prefSyncTimer);
    _prefSyncTimer = setTimeout(function() {
      _pushPreferenceVector(vector || window.PreferenceVector);
    }, PREF_DEBOUNCE_MS);
  }

  function _pushPreferenceVector(vector) {
    if (!vector) return;

    var payload = {
      preferredGen  : vector.preferredGen  || null,
      preferredBase : vector.preferredBase || null,
      layerGains    : vector.layerGains    || null,
      affinityMap   : vector.affinityMap   || null,
      updatedAt     : firebase.firestore.FieldValue.serverTimestamp(),
      uid           : _uid,
    };

    var docRef = _db.collection('user_preferences').doc(_uid);
    docRef.set(payload, { merge: true })
      .then(function() {
        console.info('[FirebaseManager] PreferenceVector Firestore\'a yazıldı.');
      })
      .catch(function(err) {
        console.warn('[FirebaseManager] Preference yazma hatası:', err.message);
      });
  }

  /* ── Conflict Resolution: yerel vs. cloud ── */
  function _watchPreferenceConflicts() {
    if (!_db || !_uid) return;

    _db.collection('user_preferences').doc(_uid)
      .onSnapshot(function(doc) {
        if (!doc.exists) return;
        var cloud = doc.data();
        var local = window.PreferenceVector;

        if (!cloud || !cloud.updatedAt) return;

        var cloudTs = cloud.updatedAt.toMillis ? cloud.updatedAt.toMillis() : 0;
        var localTs = (local && local.lastUpdated) ? local.lastUpdated : 0;

        if (cloudTs > localTs) {
          /* Cloud daha yeni → yerel'i güncelle */
          window.PreferenceVector = window.PreferenceVector || {};
          if (cloud.preferredGen)  window.PreferenceVector.preferredGen  = cloud.preferredGen;
          if (cloud.preferredBase) window.PreferenceVector.preferredBase = cloud.preferredBase;
          if (cloud.layerGains)    window.PreferenceVector.layerGains    = cloud.layerGains;
          if (cloud.affinityMap)   window.PreferenceVector.affinityMap   = cloud.affinityMap;
          window.PreferenceVector.lastUpdated = cloudTs;

          /* AudioEngine'e layer gains uygula */
          var ae = window.Sanctuary && window.Sanctuary.AudioEngine;
          if (ae && cloud.layerGains && typeof ae.updateLayerGains === 'function') {
            ae.updateLayerGains(cloud.layerGains.synth, cloud.layerGains.texture);
          }
          console.info('[FirebaseManager] Cloud preference uygulandı (daha yeni).');
        }
        /* local daha yeniyse cloud'a yaz */
        else if (localTs > cloudTs && local) {
          _pushPreferenceVector(local);
        }
      }, function(err) {
        console.warn('[FirebaseManager] Preference watch hatası:', err.message);
      });
  }

  /* ── LearningEngine hook: anlamlı affinity değişikliği ── */
  function onAffinityChange(key, oldScore, newScore) {
    var delta = Math.abs((newScore || 0) - (oldScore || 0));
    if (delta >= AFFINITY_DELTA_MIN) {
      syncPreferenceVector(window.PreferenceVector);
    }
  }

  /* ══════════════════════════════════════════════════════════════════
     GLOBAL SESSION HISTORY
  ══════════════════════════════════════════════════════════════════ */
  function _loadGlobalSessionHistory() {
    if (!_db || !_uid) return;

    _db.collection('sessions')
      .where('uid', '==', _uid)
      .orderBy('startedAt', 'desc')
      .limit(50)
      .get()
      .then(function(snapshot) {
        var sessions = [];
        snapshot.forEach(function(doc) { sessions.push(doc.data()); });

        if (!sessions.length) return;

        /* LearningEngine'e merge et */
        if (window.LearningEngine && typeof window.LearningEngine.mergeSessionHistory === 'function') {
          window.LearningEngine.mergeSessionHistory(sessions);
          console.info('[FirebaseManager] ' + sessions.length + ' global oturum LearningEngine\'e merge edildi.');
        } else {
          /* LearningEngine merge API'si yoksa window'a park et */
          window._cloudSessionHistory = sessions;
          console.info('[FirebaseManager] ' + sessions.length + ' oturum window._cloudSessionHistory\'e yüklendi.');
        }
      })
      .catch(function(err) {
        console.warn('[FirebaseManager] Session history yükleme hatası:', err.message);
      });
  }

  /**
   * logSession(data)
   * LearningEngine veya AdaptiveEngine tarafından oturum bitişinde çağrılır.
   */
  function logSession(data) {
    if (!_db || !_uid) return;
    var payload = Object.assign({}, data, {
      uid      : _uid,
      startedAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    _db.collection('sessions').add(payload)
      .catch(function(err) {
        console.warn('[FirebaseManager] Session log hatası:', err.message);
      });
  }

  /* ══════════════════════════════════════════════════════════════════
     GLOBAL ROOM DIRECTORY
  ══════════════════════════════════════════════════════════════════ */

  /**
   * registerRoom(room)
   * RoomManager.createRoom() sonrası çağrılır.
   * active_rooms koleksiyonuna oda meta verisi yazılır.
   */
  function registerRoom(room) {
    if (!_db || !_uid || !room) return;

    var payload = {
      roomId     : room.id       || null,
      roomCode   : room.code     || null,
      roomName   : room.name     || 'Sanctuary Odası',
      category   : room.category || 'meditasyon',
      capacity   : room.capacity || 8,
      memberCount: (room.members || []).length,
      hostUid    : _uid,
      createdAt  : firebase.firestore.FieldValue.serverTimestamp(),
      active     : true,
    };

    _activeRoomRef = _db.collection('active_rooms').doc(room.id);
    _activeRoomRef.set(payload)
      .then(function() {
        console.info('[FirebaseManager] Oda Firestore\'a kaydedildi:', room.code);
      })
      .catch(function(err) {
        console.warn('[FirebaseManager] Oda kayıt hatası:', err.message);
      });
  }

  /**
   * updateRoomMemberCount(count)
   * Üye sayısı değiştiğinde RoomManager tarafından çağrılır.
   */
  function updateRoomMemberCount(count) {
    if (!_activeRoomRef) return;
    _activeRoomRef.update({ memberCount: count }).catch(function(){});
  }

  /**
   * closeRoom()
   * RoomManager.leaveRoom() çağrısında host tarafından tetiklenir.
   */
  function closeRoom() {
    if (!_activeRoomRef) return;
    _activeRoomRef.update({ active: false, closedAt: firebase.firestore.FieldValue.serverTimestamp() })
      .then(function() {
        console.info('[FirebaseManager] Oda kapatıldı.');
        _activeRoomRef = null;
      })
      .catch(function(){});
  }

  /**
   * getActiveRooms(category, callback)
   * Ana ekranın "oda listesi" için public active_rooms'u çeker.
   */
  function getActiveRooms(category, callback) {
    if (!_db) { callback([]); return; }
    var query = _db.collection('active_rooms').where('active', '==', true);
    if (category && category !== 'all') {
      query = query.where('category', '==', category);
    }
    query.orderBy('createdAt', 'desc').limit(20)
      .get()
      .then(function(snapshot) {
        var rooms = [];
        snapshot.forEach(function(doc) { rooms.push(doc.data()); });
        callback(rooms);
      })
      .catch(function(err) {
        console.warn('[FirebaseManager] Active rooms getirme hatası:', err.message);
        callback([]);
      });
  }

  /* ══════════════════════════════════════════════════════════════════
     TELEMETRY — Biometric shift logu (isteğe bağlı)
  ══════════════════════════════════════════════════════════════════ */
  function logBiometricShift(entry) {
    if (!_db || !_uid) return;
    _db.collection('biometric_logs').add(
      Object.assign({}, entry, { uid: _uid })
    ).catch(function(){});
  }

  /* ══════════════════════════════════════════════════════════════════
     PUBLIC API
  ══════════════════════════════════════════════════════════════════ */
  window.FirebaseManager = {
    init                  : init,
    linkWithGoogle        : linkWithGoogle,
    syncPreferenceVector  : syncPreferenceVector,
    onAffinityChange      : onAffinityChange,
    logSession            : logSession,
    registerRoom          : registerRoom,
    updateRoomMemberCount : updateRoomMemberCount,
    closeRoom             : closeRoom,
    getActiveRooms        : getActiveRooms,
    logBiometricShift     : logBiometricShift,
    getUid                : function() { return _uid; },
    isReady               : function() { return _initialized && !!_uid; },
  };

  console.info('[FirebaseManager v4] Modül yüklendi. init() ile başlatın.');
})();
