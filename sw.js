// ═══════════════════════════════════════════════════════════════════════════
//  Sanctuary — Service Worker  (sw.js)  v4
//  Velvet Audio Engine + PWA Offline Deneyimi
//
//  Değişiklikler (v4):
//    1. CACHE_NAME: sanctuary-v4 — eski önbellekler temizlenir
//    2. AUDIO_ASSETS: OGG formatına güncellendi (AudioEngine v4 ile uyumlu)
//    3. Network-First: Netlify/Gemini API istekleri + API_CACHE fallback
//    4. Offline Fallback Scene: v4 Recipe formatı (432Hz/Ocean)
//    5. Range Request: _handleAudioRequest güçlendirildi (iOS/mobile seek)
//    6. VALID_CACHES: API_CACHE de dahil edildi
// ═══════════════════════════════════════════════════════════════════════════

/* ─── Versiyon ──────────────────────────────────────────────────────────── */
const CACHE_VERSION = 'v4';
const CACHE_NAME    = `sanctuary-${CACHE_VERSION}`;   /* Ana uygulama kabuğu */
const AUDIO_CACHE   = `sanctuary-audio-${CACHE_VERSION}`;
const FONT_CACHE    = `sanctuary-fonts-${CACHE_VERSION}`;
const API_CACHE     = `sanctuary-api-${CACHE_VERSION}`;  /* Maestro recipe önbelleği */

/* ─── Offline Fallback Scene (v4 Recipe formatı) ────────────────────────── */
const OFFLINE_RECIPE = {
  sceneName     : 'Çevrimdışı Huzur',
  baseHz        : 432,
  binauralHz    : 4.0,
  textures      : [{name:'ocean', gain:0.60}, {name:'wind', gain:0.25}],
  breath        : [4, 4, 8],
  textureLevels : { rain:0.0, fire:0.0, wind:0.25 },
  filterSettings: { cutoff:1800, resonance:0.6 },
  pulseRate     : 16,
};

/* ─── Uygulama Kabuğu (App Shell) ───────────────────────────────────────── */
const CORE_ASSETS = [
  '/',
  '/index.html',
  '/style.css',
  '/main.js',
  '/main-room-additions.js',
  '/RoomManager.js',
  '/StateManager.js',
  '/AudioEngine.js',
  '/AdaptiveEngine.js',
  '/LearningEngine.js',
  '/MaestroClient.js',
  '/GranularEngine.js',
  '/FMSynthesizer.js',
  '/GeminiAdapter.js',
  '/SceneInterpreter.js',
  '/FeedbackCollector.js',
  '/PreferenceVector.js',
  '/offline-fallback.json',
  '/manifest.json',
];

/* ─── Ses Dosyaları (OGG — AudioEngine v4) ─────────────────────────────── */
const AUDIO_ASSETS = [
  /* ── Procedural engine samples (v4 OGG) ── */
  '/audio/ocean.ogg',
  '/audio/rain.ogg',
  '/audio/forest.ogg',
  '/audio/fire.ogg',
  '/audio/zen-bowl.ogg',

  /* ── Fallback MP3 (eski cihaz uyumluluğu) ── */
  '/audio/ocean.mp3',
  '/audio/rain.mp3',
  '/audio/forest.mp3',
  '/audio/fire.mp3',
  '/audio/zen-bowl.mp3',

  /* ── Ambient / Binaural ── */
  '/audio/binaural-alpha.mp3',
  '/audio/binaural-theta.mp3',
  '/audio/brown-noise.mp3',
  '/audio/white-noise.mp3',
  '/audio/pink-noise.mp3',
];

/* ─── Font Origins ──────────────────────────────────────────────────────── */
const FONT_ORIGINS = [
  'https://fonts.googleapis.com',
  'https://fonts.gstatic.com',
];

/* ─── Netlify & Gemini API Origins ─────────────────────────────────────── */
const API_ORIGINS = [
  '/.netlify/functions/',
  'https://generativelanguage.googleapis.com',
];

function _isApiRequest(url) {
  return API_ORIGINS.some(function(o) { return url.href.includes(o); });
}

/* ═══════════════════════════════════════════════════════════════════════════
   INSTALL
═══════════════════════════════════════════════════════════════════════════ */
self.addEventListener('install', function(event) {
  console.log('[SW] sanctuary-v4 yükleniyor...');

  event.waitUntil(
    Promise.all([
      /* 1. App Shell */
      caches.open(CACHE_NAME).then(function(cache) {
        return cache.addAll(CORE_ASSETS).catch(function(err) {
          console.warn('[SW] Core asset önbellek hatası:', err);
        });
      }),

      /* 2. Offline fallback JSON (v4 Recipe) */
      caches.open(CACHE_NAME).then(function(cache) {
        return cache.put(
          '/offline-fallback.json',
          new Response(JSON.stringify(OFFLINE_RECIPE), {
            headers: { 'Content-Type': 'application/json' }
          })
        );
      }),

      /* 3. Ses dosyaları */
      caches.open(AUDIO_CACHE).then(function(cache) {
        return _precacheAudio(cache);
      }),

    ]).then(function() {
      console.log('[SW] Install tamamlandı — sanctuary-v4');
      return self.skipWaiting();
    })
  );
});

/* ═══════════════════════════════════════════════════════════════════════════
   ACTIVATE — Eski önbellekleri temizle (v1–v3, legacy adlar dahil)
═══════════════════════════════════════════════════════════════════════════ */
self.addEventListener('activate', function(event) {
  console.log('[SW] sanctuary-v4 aktive ediliyor...');

  const VALID_CACHES = [CACHE_NAME, AUDIO_CACHE, FONT_CACHE, API_CACHE];

  event.waitUntil(
    caches.keys().then(function(cacheNames) {
      return Promise.all(
        cacheNames
          .filter(function(name) {
            return name.startsWith('sanctuary-') && !VALID_CACHES.includes(name);
          })
          .map(function(name) {
            console.log('[SW] Eski önbellek siliniyor:', name);
            return caches.delete(name);
          })
      );
    }).then(function() {
      console.log('[SW] Activate tamamlandı. Aktif önbellekler:', VALID_CACHES);
      return self.clients.claim();
    })
  );
});

/* ═══════════════════════════════════════════════════════════════════════════
   FETCH — İstek yönlendirme stratejileri
═══════════════════════════════════════════════════════════════════════════ */
self.addEventListener('fetch', function(event) {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  /* Cross-origin: sadece font ve Gemini API hariç atla */
  const isLocal     = req.url.startsWith(self.location.origin);
  const isFontOrig  = FONT_ORIGINS.some(function(o) { return req.url.startsWith(o); });
  const isApiOrig   = _isApiRequest(url);
  if (!isLocal && !isFontOrig && !isApiOrig) return;

  /* ── 1. API: Netlify functions + Gemini → Network-First + API_CACHE fallback ── */
  if (isApiOrig) {
    event.respondWith(_handleApiRequest(req));
    return;
  }

  /* ── 2. Ses dosyaları → Cache-First + Range Request ── */
  if (_isAudioRequest(url)) {
    event.respondWith(_handleAudioRequest(req));
    return;
  }

  /* ── 3. Fontlar → Cache-First ── */
  if (_isFontRequest(url)) {
    event.respondWith(_handleFontRequest(req));
    return;
  }

  /* ── 4. Navigasyon → Network-First + offline /index.html ── */
  if (req.destination === 'document') {
    event.respondWith(_handleDocumentRequest(req));
    return;
  }

  /* ── 5. Uygulama kabuğu → Stale-While-Revalidate ── */
  event.respondWith(_handleAssetRequest(req));
});

/* ═══════════════════════════════════════════════════════════════════════════
   STRATEJİ FONKSİYONLARI
═══════════════════════════════════════════════════════════════════════════ */

/**
 * Network-First for API (Maestro / Gemini)
 * Ağ başarısızsa API_CACHE'den aynı URL'nin son başarılı yanıtını döner.
 * O da yoksa OFFLINE_RECIPE döner — ses asla durmasın.
 */
function _handleApiRequest(req) {
  return caches.open(API_CACHE).then(function(cache) {
    return fetch(req.clone(), { signal: AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined })
      .then(function(response) {
        if (response && response.ok) {
          /* Başarılı yanıtı önbelleğe yaz (gelecek offline için) */
          cache.put(req, response.clone()).catch(function(){});
        }
        return response;
      })
      .catch(function(err) {
        console.warn('[SW] API ağ hatası — önbellekten deneyin:', err.message);
        return cache.match(req).then(function(cached) {
          if (cached) {
            console.info('[SW] API cache fallback kullanılıyor:', req.url);
            return cached;
          }
          /* Son çare: OFFLINE_RECIPE */
          console.info('[SW] API offline fallback: OFFLINE_RECIPE');
          return new Response(JSON.stringify(OFFLINE_RECIPE), {
            status : 200,
            headers: { 'Content-Type': 'application/json' },
          });
        });
      });
  });
}

/**
 * Cache-First for Audio — Range Request (partial content) desteğiyle.
 * iOS ve mobile cihazlar seek için Range istekleri gönderir.
 * Önbellekteki tam dosyadan partial response üretilir.
 */
function _handleAudioRequest(req) {
  return caches.open(AUDIO_CACHE).then(function(cache) {
    return cache.match(req.url).then(function(cached) {  /* URL ile eşleştir, Range header'ı yoksay */
      if (cached) {
        /* Range isteği varsa önbellekten partial response üret */
        const rangeHeader = req.headers.get('Range');
        if (rangeHeader) {
          return _buildRangeResponse(cached, rangeHeader);
        }
        return cached;
      }

      /* Önbellekte yok — tam dosyayı ağdan al ve kaydet */
      console.info('[SW] Audio ağdan yükleniyor:', req.url);
      return fetch(new Request(req.url), { cache: 'force-cache' })
        .then(function(response) {
          if (!response || response.status !== 200) return response;
          cache.put(req.url, response.clone()).catch(function(err) {
            console.warn('[SW] Audio önbellek yazma hatası:', err);
          });
          /* İlk istek Range'li gelebilir */
          const rangeHeader = req.headers.get('Range');
          if (rangeHeader) {
            return _buildRangeResponse(response, rangeHeader);
          }
          return response;
        })
        .catch(function(err) {
          console.error('[SW] Audio ağ hatası:', err.message);
          return new Response('', { status:503, statusText:'Audio offline unavailable' });
        });
    });
  });
}

/**
 * Range Request → Partial Response (206)
 * Önbellekteki tam ArrayBuffer'dan istenen byte aralığını keser.
 */
function _buildRangeResponse(response, rangeHeader) {
  return response.clone().arrayBuffer().then(function(buffer) {
    const total  = buffer.byteLength;
    const match  = /bytes=(\d*)-(\d*)/.exec(rangeHeader);
    if (!match) return response;  /* Geçersiz Range → tam dosyayı dön */

    const start  = match[1] ? parseInt(match[1]) : 0;
    const end    = match[2] ? parseInt(match[2]) : total - 1;
    const chunk  = buffer.slice(start, end + 1);
    const mime   = response.headers.get('Content-Type') || 'audio/ogg';

    return new Response(chunk, {
      status : 206,
      headers: {
        'Content-Type'  : mime,
        'Content-Range' : `bytes ${start}-${end}/${total}`,
        'Content-Length': String(chunk.byteLength),
        'Accept-Ranges' : 'bytes',
      },
    });
  }).catch(function() {
    return response;  /* ArrayBuffer parse başarısızsa tam yanıtı dön */
  });
}

/**
 * Cache-First for Fonts
 */
function _handleFontRequest(req) {
  return caches.open(FONT_CACHE).then(function(cache) {
    return cache.match(req).then(function(cached) {
      if (cached) return cached;
      return fetch(req).then(function(response) {
        if (!response || response.status !== 200 || response.type === 'opaque') return response;
        cache.put(req, response.clone());
        return response;
      }).catch(function() {
        return new Response('', { status:503 });
      });
    });
  });
}

/**
 * Network-First for Documents
 */
function _handleDocumentRequest(req) {
  return fetch(req).then(function(response) {
    if (!response || !response.ok) throw new Error('Document network error');
    caches.open(CACHE_NAME).then(function(cache) { cache.put(req, response.clone()); });
    return response;
  }).catch(function() {
    return caches.match(req).then(function(cached) {
      return cached || caches.match('/index.html');
    });
  });
}

/**
 * Stale-While-Revalidate for App Shell Assets
 */
function _handleAssetRequest(req) {
  return caches.open(CACHE_NAME).then(function(cache) {
    return cache.match(req).then(function(cached) {
      const networkFetch = fetch(req, { cache:'no-cache' }).then(function(response) {
        if (response && response.status === 200) cache.put(req, response.clone());
        return response;
      }).catch(function() { return null; });

      if (cached) {
        networkFetch.catch(function(){});  /* arka planda güncelle */
        return cached;
      }
      return networkFetch.then(function(response) {
        return response || new Response('Not Found', { status:404 });
      });
    });
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   YARDIMCI FONKSİYONLAR
═══════════════════════════════════════════════════════════════════════════ */

function _isAudioRequest(url) {
  const ext = url.pathname.split('.').pop().toLowerCase();
  return ['mp3','ogg','wav','m4a','aac','flac','webm'].includes(ext) ||
         url.pathname.startsWith('/audio/');
}

function _isFontRequest(url) {
  const ext = url.pathname.split('.').pop().toLowerCase();
  return ['woff','woff2','ttf','otf','eot'].includes(ext) ||
         FONT_ORIGINS.some(function(o) { return url.origin === new URL(o).origin; });
}

function _precacheAudio(cache) {
  var loaded = 0, failed = 0, total = AUDIO_ASSETS.length;
  var promises = AUDIO_ASSETS.map(function(url) {
    return fetch(url, { cache:'force-cache' })
      .then(function(response) {
        if (!response || response.status !== 200) {
          failed++;
          console.warn('[SW] Audio önbelleğe alınamadı (HTTP ' + response.status + '):', url);
          return;
        }
        loaded++;
        return cache.put(url, response);
      })
      .catch(function(err) {
        failed++;
        console.warn('[SW] Audio önbelleğe alınamadı:', url, err.message);
      });
  });
  return Promise.all(promises).then(function() {
    console.info('[SW] Ses önbelleği: ' + loaded + '/' + total + ' yüklendi, ' + failed + ' hata.');
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   MESSAGE — Ana uygulama ile iletişim
═══════════════════════════════════════════════════════════════════════════ */
self.addEventListener('message', function(event) {
  if (!event.data) return;
  switch (event.data.type) {

    case 'GET_CACHE_VERSION':
      event.ports[0] && event.ports[0].postMessage({
        type   : 'CACHE_VERSION',
        version: CACHE_VERSION,
        caches : [CACHE_NAME, AUDIO_CACHE, FONT_CACHE, API_CACHE],
      });
      break;

    case 'CLEAR_ALL_CACHES':
      caches.keys().then(function(names) {
        return Promise.all(names.map(function(n) { return caches.delete(n); }));
      }).then(function() {
        console.info('[SW] Tüm önbellekler temizlendi.');
        event.ports[0] && event.ports[0].postMessage({ type:'CACHES_CLEARED' });
      });
      break;

    case 'EVICT_AUDIO':
      if (event.data.url) {
        caches.open(AUDIO_CACHE).then(function(cache) {
          return cache.delete(event.data.url);
        }).then(function(deleted) {
          console.info('[SW] Audio evict:', event.data.url, deleted);
        });
      }
      break;

    case 'PRECACHE_AUDIO':
      caches.open(AUDIO_CACHE).then(function(cache) {
        return _precacheAudio(cache);
      });
      break;
  }
});
