/* netlify/functions/gemini.js — Maestro Schema v4.0
   Sanctuary v4: Genişletilmiş Recipe şeması
   • textureLevels: Rain/Fire/Wind için ayrı gain değerleri
   • filterSettings: cutoff + resonance (Q) Velvet profili
   • pulseRate: nefes döngüsü süresi (saniye)
   • preferenceContext: PreferenceVector client'tan gönderilirse prompt'a eklenir
   ─────────────────────────────────────────────────────────────────────
   FIX: gemini-2.5-flash thinking modu JSON'u kesiyor.
   Çözüm: thinkingConfig ile thinking kapatıldı.
   Fallback model: gemini-2.0-flash (thinking yok, hızlı)
*/

/* ── Safe Recipe (ses hiçbir zaman durmasın) ───────────────────────── */
const DEFAULT_MAESTRO = {
  sceneName     : 'Calm Breath',
  baseHz        : 432,
  binauralHz    : 4.0,
  textures      : [{name:'ocean',gain:0.60},{name:'wind',gain:0.25}],
  breath        : [4,4,8],
  textureLevels : { rain:0.0, fire:0.0, wind:0.25 },
  filterSettings: { cutoff:1800, resonance:0.6 },
  pulseRate     : 16,
};

const FALLBACK_TABLE = {
  /* ── İngilizce ── */
  'Anxious' :{sceneName:'Calm Breath',     baseHz:396, binauralHz:6.0,  textures:[{name:'ocean', gain:0.55},{name:'wind',   gain:0.30},{name:'zen',    gain:0.20}],breath:[4,4,8], textureLevels:{rain:0.0,fire:0.0,wind:0.30}, filterSettings:{cutoff:1600,resonance:0.8}, pulseRate:16},
  'Stressed':{sceneName:'Deep Peace',      baseHz:432, binauralHz:6.0,  textures:[{name:'rain',  gain:0.55},{name:'zen',    gain:0.25}],                          breath:[4,2,6], textureLevels:{rain:0.55,fire:0.0,wind:0.0}, filterSettings:{cutoff:1700,resonance:0.7}, pulseRate:12},
  'Tired'   :{sceneName:'Energy Renewal',  baseHz:528, binauralHz:10.0, textures:[{name:'forest',gain:0.50},{name:'wind',   gain:0.35},{name:'river',  gain:0.20}],breath:[5,2,5], textureLevels:{rain:0.0,fire:0.0,wind:0.35}, filterSettings:{cutoff:2000,resonance:0.5}, pulseRate:12},
  'Sad'     :{sceneName:'Light Breath',    baseHz:417, binauralHz:5.0,  textures:[{name:'ocean', gain:0.60},{name:'whisper',gain:0.25}],                          breath:[4,2,7], textureLevels:{rain:0.0,fire:0.0,wind:0.0},  filterSettings:{cutoff:1500,resonance:0.9}, pulseRate:13},
  'Calm'    :{sceneName:'Focus Flow',      baseHz:40,  binauralHz:7.0,  textures:[{name:'ocean', gain:0.45},{name:'zen',    gain:0.30}],                          breath:[4,4,4], textureLevels:{rain:0.0,fire:0.0,wind:0.0},  filterSettings:{cutoff:1900,resonance:0.5}, pulseRate:12},
  'Grateful':{sceneName:'Heart Resonance', baseHz:528, binauralHz:10.0, textures:[{name:'forest',gain:0.50},{name:'river',  gain:0.30}],                          breath:[5,3,6], textureLevels:{rain:0.0,fire:0.0,wind:0.0},  filterSettings:{cutoff:2100,resonance:0.4}, pulseRate:14},
  /* ── Türkçe ── */
  'Huzursuz':{sceneName:'Sakin Nefes',     baseHz:396, binauralHz:6.0,  textures:[{name:'ocean', gain:0.55},{name:'wind',   gain:0.30},{name:'zen',    gain:0.20}],breath:[4,4,8], textureLevels:{rain:0.0,fire:0.0,wind:0.30}, filterSettings:{cutoff:1600,resonance:0.8}, pulseRate:16},
  'Kaygılı' :{sceneName:'Derin Huzur',     baseHz:432, binauralHz:6.0,  textures:[{name:'rain',  gain:0.55},{name:'zen',    gain:0.25}],                          breath:[4,2,6], textureLevels:{rain:0.55,fire:0.0,wind:0.0}, filterSettings:{cutoff:1700,resonance:0.7}, pulseRate:12},
  'Yorgun'  :{sceneName:'Enerji Yenileme', baseHz:528, binauralHz:10.0, textures:[{name:'forest',gain:0.50},{name:'wind',   gain:0.35},{name:'river',  gain:0.20}],breath:[5,2,5], textureLevels:{rain:0.0,fire:0.0,wind:0.35}, filterSettings:{cutoff:2000,resonance:0.5}, pulseRate:12},
  'Mutsuz'  :{sceneName:'Işık Nefesi',     baseHz:417, binauralHz:5.0,  textures:[{name:'ocean', gain:0.60},{name:'whisper',gain:0.25}],                          breath:[4,2,7], textureLevels:{rain:0.0,fire:0.0,wind:0.0},  filterSettings:{cutoff:1500,resonance:0.9}, pulseRate:13},
  'Sakin'   :{sceneName:'Odak Akışı',      baseHz:40,  binauralHz:7.0,  textures:[{name:'ocean', gain:0.45},{name:'zen',    gain:0.30}],                          breath:[4,4,4], textureLevels:{rain:0.0,fire:0.0,wind:0.0},  filterSettings:{cutoff:1900,resonance:0.5}, pulseRate:12},
  'Minnettar':{sceneName:'Kalp Rezonansı', baseHz:528, binauralHz:10.0, textures:[{name:'forest',gain:0.50},{name:'river',  gain:0.30}],                          breath:[5,3,6], textureLevels:{rain:0.0,fire:0.0,wind:0.0},  filterSettings:{cutoff:2100,resonance:0.4}, pulseRate:14},
  /* ── Arapça ── */
  'قلق'  :{sceneName:'تنفس هادئ',    baseHz:396, binauralHz:6.0,  textures:[{name:'ocean', gain:0.55},{name:'wind',   gain:0.30}],breath:[4,4,8], textureLevels:{rain:0.0,fire:0.0,wind:0.30}, filterSettings:{cutoff:1600,resonance:0.8}, pulseRate:16},
  'مجهد' :{sceneName:'سلام عميق',    baseHz:432, binauralHz:6.0,  textures:[{name:'rain',  gain:0.55},{name:'zen',    gain:0.25}],breath:[4,2,6], textureLevels:{rain:0.55,fire:0.0,wind:0.0}, filterSettings:{cutoff:1700,resonance:0.7}, pulseRate:12},
  'متعب' :{sceneName:'تجديد الطاقة', baseHz:528, binauralHz:10.0, textures:[{name:'forest',gain:0.50},{name:'wind',   gain:0.35}],breath:[5,2,5], textureLevels:{rain:0.0,fire:0.0,wind:0.35}, filterSettings:{cutoff:2000,resonance:0.5}, pulseRate:12},
  'حزين' :{sceneName:'نفس النور',    baseHz:417, binauralHz:5.0,  textures:[{name:'ocean', gain:0.60},{name:'whisper',gain:0.25}],breath:[4,2,7], textureLevels:{rain:0.0,fire:0.0,wind:0.0},  filterSettings:{cutoff:1500,resonance:0.9}, pulseRate:13},
  'هادئ' :{sceneName:'تدفق التركيز', baseHz:40,  binauralHz:7.0,  textures:[{name:'ocean', gain:0.45},{name:'zen',    gain:0.30}],breath:[4,4,4], textureLevels:{rain:0.0,fire:0.0,wind:0.0},  filterSettings:{cutoff:1900,resonance:0.5}, pulseRate:12},
  'ممتنّ':{sceneName:'رنين القلب',   baseHz:528, binauralHz:10.0, textures:[{name:'forest',gain:0.50},{name:'river',  gain:0.30}],breath:[5,3,6], textureLevels:{rain:0.0,fire:0.0,wind:0.0},  filterSettings:{cutoff:2100,resonance:0.4}, pulseRate:14},
};

function getFallback(mood) {
  return FALLBACK_TABLE[mood] || DEFAULT_MAESTRO;
}

const ALLOWED_TEXTURES = new Set([
  'ocean','rain','forest','wind','fire','zen','whisper','river','night','white-noise'
]);

/* ── Genişletilmiş Doğrulama (v4 Recipe alanları dahil) ─────────────── */
function validateMaestro(d) {
  if (!d || typeof d !== 'object') return false;
  if (typeof d.baseHz !== 'number' || d.baseHz < 20 || d.baseHz > 2000) return false;
  if (typeof d.binauralHz !== 'number' || d.binauralHz < 0.5 || d.binauralHz > 40) return false;
  if (!Array.isArray(d.textures) || d.textures.length < 1) return false;
  for (const t of d.textures) {
    if (!t || typeof t.name !== 'string') return false;
    if (typeof t.gain !== 'number' || t.gain < 0 || t.gain > 1) return false;
    if (!ALLOWED_TEXTURES.has(t.name)) {
      console.warn('[validateMaestro] İzinsiz texture:', t.name, '— fallback tetiklenecek.');
      return false;
    }
  }
  if (!Array.isArray(d.breath) || d.breath.length < 2) return false;

  /* v4 alanları — zorunlu değil, yoksa default ile tamamla */
  if (d.filterSettings) {
    if (typeof d.filterSettings.cutoff !== 'number' ||
        d.filterSettings.cutoff < 200 || d.filterSettings.cutoff > 8000) return false;
    if (typeof d.filterSettings.resonance !== 'number' ||
        d.filterSettings.resonance < 0.1 || d.filterSettings.resonance > 3.0) return false;
  }
  if (d.pulseRate !== undefined &&
      (typeof d.pulseRate !== 'number' || d.pulseRate < 4 || d.pulseRate > 60)) return false;

  return true;
}

/* ── Eksik v4 alanlarını güvenli default ile tamamla ─────────────────── */
function enrichRecipe(d, mood) {
  const ref = getFallback(mood);
  if (!d.textureLevels) {
    /* textures listesinden otomatik türet */
    const tl = { rain:0.0, fire:0.0, wind:0.0 };
    (d.textures || []).forEach(t => {
      if (t.name === 'rain' || t.name === 'white-noise') tl.rain = t.gain;
      if (t.name === 'fire') tl.fire = t.gain;
      if (t.name === 'wind' || t.name === 'forest' || t.name === 'night') tl.wind = t.gain;
    });
    d.textureLevels = tl;
  }
  if (!d.filterSettings) d.filterSettings = ref.filterSettings || DEFAULT_MAESTRO.filterSettings;
  if (!d.pulseRate) {
    const b = d.breath || [4,2,6];
    d.pulseRate = b.reduce((a,c) => a+c, 0);
  }
  return d;
}

async function callGemini(apiKey, model, systemPrompt, thinkingBudget) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const body = {
    contents        : [{parts:[{text: systemPrompt}]}],
    generationConfig: {
      temperature    : 0.85,
      maxOutputTokens: 600,
    },
  };

  if (thinkingBudget !== undefined) {
    body.generationConfig.thinkingConfig = { thinkingBudget };
  }

  const response = await fetch(url, {
    method : 'POST',
    headers: {'Content-Type':'application/json'},
    body   : JSON.stringify(body),
  });

  const data = await response.json();
  return { response, data };
}

exports.handler = async function(event) {
  const headers = {
    'Content-Type'                : 'application/json',
    'Access-Control-Allow-Origin' : '*',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (event.httpMethod === 'OPTIONS') return {statusCode:204, headers, body:''};
  if (event.httpMethod !== 'POST')    return {statusCode:405, headers, body:JSON.stringify({error:'Method Not Allowed'})};

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.warn('[gemini.js] GEMINI_API_KEY yok');
    return {statusCode:200, headers, body:JSON.stringify(getFallback('Calm'))};
  }

  let userMood = '', userInput = '', preferenceContext = null;
  try {
    const body = JSON.parse(event.body || '{}');
    userMood          = body.mood  || body.prompt || '';
    userInput         = body.input || '';
    preferenceContext = body.preferenceContext || null;  /* Client'tan gelen PreferenceVector özeti */
  } catch(e) {}

  /* ── PreferenceVector bağlamı prompt'a eklenir ───────────────────── */
  let prefHint = '';
  if (preferenceContext) {
    const g = preferenceContext.preferredGen  || null;
    const b = preferenceContext.preferredBase || null;
    if (g || b) {
      prefHint = `\nUSER HISTORY: This user previously responded well to "${g || '?'}" textures at ${b || '?'}Hz. Align with or gently evolve from this preference.`;
    }
  }

  const systemPrompt = `You are a sound therapy composer for Sanctuary, a healing meditation app.
Mood: "${userMood}" | Note: "${userInput||'none'}"${prefHint}

TASK: Create a unique acoustic prescription. Reply with ONLY valid JSON, nothing else.

FORMAT:
{"sceneName":"EVOCATIVE_NAME","baseHz":396,"binauralHz":6.0,"textures":[{"name":"ocean","gain":0.55},{"name":"zen","gain":0.35}],"breath":[4,2,6],"textureLevels":{"rain":0.0,"fire":0.0,"wind":0.0},"filterSettings":{"cutoff":1700,"resonance":0.7},"pulseRate":12}

RULES — follow ALL of these strictly:

baseHz: Choose ONE Solfeggio frequency that matches the mood:
  174Hz=pain relief/grounding, 285Hz=healing tissue, 396Hz=releasing fear/anxiety,
  417Hz=change/trauma release, 432Hz=natural harmony, 528Hz=DNA repair/joy,
  639Hz=relationships/heart, 741Hz=expression/clarity, 852Hz=intuition, 963Hz=divine connection
  Also allowed: 40Hz=gamma/focus

binauralHz: Choose based on desired state:
  0.5-4.0=deep sleep(delta), 4.0-8.0=meditation/dream(theta),
  8.0-13.0=calm focus(alpha), 13.0-30.0=active focus(beta), 30.0-40.0=insight(gamma)
  Use DECIMAL values for variety (e.g. 6.3, 10.5, 4.8) — avoid always using round numbers.

textures: ALWAYS use 2-3 items. Mix contrasting textures for depth (e.g. fire+whisper, rain+zen).
  ONLY these names allowed: ocean, rain, forest, wind, fire, zen, whisper, river, night, white-noise
  gain: 0.1 to 0.75, use decimals like 0.45, 0.32 for natural variation.

breath: [inhale, hold, exhale] in seconds as integers. Match to mood:
  anxiety=longer exhale [4,2,7], energy=[5,2,5], sleep=[4,4,8], focus=[4,4,4]

textureLevels: Specify gain for each procedural engine separately:
  {"rain": 0.0-0.8, "fire": 0.0-0.6, "wind": 0.0-0.7}

filterSettings: Velvet profile — cutoff 800-3000Hz, resonance 0.3-1.5

pulseRate: Total breath cycle in seconds (inhale+hold+exhale sum).

sceneName: Create an evocative 2-3 word poetic name (e.g. "Midnight Forest", "Rising Dawn")

Be CREATIVE and VARIED — never repeat the same combination twice.`;

  try {
    /* ── Deneme 1: gemini-2.5-flash, thinking kapalı (budget=0) ── */
    console.log('[gemini.js] Deneme 1: gemini-2.5-flash (thinkingBudget:0)');
    let { response, data } = await callGemini(apiKey, 'gemini-2.5-flash', systemPrompt, 0);

    console.log('[gemini.js] status:', response.status);
    console.log('[gemini.js] raw:', JSON.stringify(data).substring(0, 400));

    let text = '';
    if (response.ok) {
      text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    }

    /* ── Deneme 2: 2.5-flash başarısızsa gemini-2.0-flash ── */
    if (!text || data?.candidates?.[0]?.finishReason === 'MAX_TOKENS') {
      console.warn('[gemini.js] Deneme 2: gemini-2.0-flash');
      const r2 = await callGemini(apiKey, 'gemini-2.0-flash', systemPrompt, undefined);
      console.log('[gemini.js] 2.0-flash raw:', JSON.stringify(r2.data).substring(0, 400));
      if (r2.response.ok) {
        text = r2.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      }
    }

    if (!text) {
      console.error('[gemini.js] İki model de boş döndü');
      return {statusCode:200, headers, body:JSON.stringify(getFallback(userMood))};
    }

    const clean = text.replace(/```json|```/gi, '').trim();
    console.log('[MAESTRO DEBUG] Gemini metin:', clean.substring(0, 300));

    let maestro;
    try {
      maestro = JSON.parse(clean);
    } catch(e) {
      console.error('[gemini.js] JSON parse hatası:', e.message, '| metin:', clean.substring(0, 150));
      return {statusCode:200, headers, body:JSON.stringify(getFallback(userMood))};
    }

    if (!validateMaestro(maestro)) {
      console.warn('[gemini.js] Geçersiz Maestro — fallback:', JSON.stringify(maestro).substring(0, 200));
      return {statusCode:200, headers, body:JSON.stringify(getFallback(userMood))};
    }

    /* Eksik v4 alanlarını tamamla */
    maestro = enrichRecipe(maestro, userMood);

    console.log('[gemini.js] ✅ Maestro v4 Onaylandı:', maestro.sceneName,
      '|', maestro.baseHz+'Hz /', maestro.binauralHz+'Hz binaural /',
      maestro.textures.length, 'texture | cutoff:', maestro.filterSettings.cutoff+'Hz');
    return {statusCode:200, headers, body:JSON.stringify(maestro)};

  } catch(e) {
    console.error('[gemini.js] fetch hatası:', e.message);
    return {statusCode:200, headers, body:JSON.stringify(getFallback(userMood))};
  }
};
