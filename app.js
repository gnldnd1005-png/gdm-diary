import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY, VAPID_PUBLIC_KEY, FAMILY_EMAIL } from './config.js';

const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const SLOTS = ['breakfast', 'lunch', 'dinner', 'bedtime'];
const SLOT_NAME = { fasting: '공복', breakfast: '아침', lunch: '점심', dinner: '저녁', snack: '간식', bedtime: '취침 전' };
const KETONE_LABEL = { 0: '음성 (-)', 5: '± 양성 (5)', 15: '+ 양성 (15)', 50: '++ 양성 (50)', 100: '+++ 양성 (100)' };
const KETONE_OPTIONS = ['', '0', '5', '15', '50', '100'];
const KETONE_DISPLAY = { '': '선택 안 함', '0': '음성 (-)', '5': '± (5 mg/dL)', '15': '+ (15 mg/dL)', '50': '++ (50 mg/dL)', '100': '+++ (100 mg/dL)' };
// 대한당뇨병학회 임신성당뇨 혈당 목표 (병원 지시가 다르면 설정에서 변경)
const DEFAULTS = { fasting: 95, post1h: 140, post2h: 120, low: 60, postHours: 2, mealAlarm: true, fastingAlarm: '07:00' };
const STATUS_LABEL = { ok: '✓ 정상', high: '▲ 초과', low: '▼ 낮음' };

const state = {
  user: null,
  view: 'day',
  day: todayStr(),
  entries: [],
  weekStart: mondayOf(todayStr()),
  week: [],
  settings: { ...DEFAULTS },
  edit: null,
  pushOn: false,
};

const $app = document.getElementById('app');
const $sheet = document.getElementById('sheet');
const $viewer = document.getElementById('viewer');
const $tip = document.getElementById('tip');
const $toast = document.getElementById('toast');

/* ---------- 유틸 ---------- */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function pad(n) { return String(n).padStart(2, '0'); }
function ymd(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function todayStr() { return ymd(new Date()); }
function parseDay(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
function addDays(s, n) { const d = parseDay(s); d.setDate(d.getDate() + n); return ymd(d); }
function mondayOf(s) { const d = parseDay(s); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return ymd(d); }
const WD = '일월화수목금토';
function dayLabel(s) { const d = parseDay(s); return `${d.getMonth() + 1}월 ${d.getDate()}일 (${WD[d.getDay()]})`; }
function shortDay(s) { const d = parseDay(s); return `${d.getMonth() + 1}/${d.getDate()} ${WD[d.getDay()]}`; }
function hhmm(iso) { if (!iso) return ''; const d = new Date(iso); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }
function nowHHMM() { return hhmm(new Date().toISOString()); }
function toIso(day, time) {
  if (!time) return null;
  const [h, m] = time.split(':').map(Number);
  const d = parseDay(day);
  d.setHours(h, m, 0, 0);
  return d.toISOString();
}
function duration(mins) { const h = Math.floor(mins / 60), m = mins % 60; return h ? `${h}시간${m ? ` ${m}분` : ''}` : `${m}분`; }

function toast(msg) {
  $toast.textContent = msg;
  $toast.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { $toast.hidden = true; }, 2600);
}

/* ---------- 판정 ---------- */
function targetFor(e) {
  const s = state.settings;
  if (e.slot === 'fasting') return s.fasting;
  if (e.slot === 'bedtime') return s.fasting;
  return e.post_hours === 1 ? s.post1h : s.post2h;
}
function status(e) {
  if (e.glucose == null) return null;
  if (e.glucose < state.settings.low) return 'low';
  return e.glucose < targetFor(e) ? 'ok' : 'high';
}
function badge(e) {
  const st = status(e);
  return st ? `<span class="badge ${st}">${STATUS_LABEL[st]}</span>` : '';
}
function preStatus(e) {
  if (e.pre_glucose == null) return null;
  if (e.pre_glucose < state.settings.low) return 'low';
  return e.pre_glucose < state.settings.fasting ? 'ok' : 'high';
}
function preBadge(e) {
  const st = preStatus(e);
  return st ? `<span class="badge ${st}">${STATUS_LABEL[st]}</span>` : '';
}

/* ---------- 사진 ---------- */
const urlCache = new Map();
async function signUrls(paths) {
  const need = [...new Set(paths.filter((p) => p && !urlCache.has(p)))];
  if (!need.length) return;
  const { data } = await sb.storage.from('photos').createSignedUrls(need, 60 * 60 * 6);
  data?.forEach((r) => { if (r.signedUrl) urlCache.set(r.path, r.signedUrl); });
}

function compress(file, max = 1600) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const u = URL.createObjectURL(file);
    img.onload = () => {
      const r = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * r);
      c.height = Math.round(img.height * r);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(u);
      c.toBlob((b) => (b ? resolve(b) : reject(new Error('이미지 변환 실패'))), 'image/jpeg', 0.82);
    };
    img.onerror = () => { URL.revokeObjectURL(u); reject(new Error('이미지를 열 수 없어요')); };
    img.src = u;
  });
}

async function uploadPhoto(file, day) {
  const blob = await compress(file);
  const path = `${day}/${crypto.randomUUID()}.jpg`;
  const { error } = await sb.storage.from('photos').upload(path, blob, { contentType: 'image/jpeg' });
  if (error) throw error;
  return path;
}

function thumb(path) {
  const src = path && urlCache.get(path);
  return src ? `<img class="thumb" src="${src}" alt="" data-action="photo" data-src="${src}">` : '';
}

/* ---------- 데이터 ---------- */
async function loadSettings() {
  const { data } = await sb.from('settings').select('data').eq('id', 1).maybeSingle();
  state.settings = { ...DEFAULTS, ...(data?.data || {}) };
}

async function loadDay() {
  const { data, error } = await sb.from('entries').select('*').eq('day', state.day).order('created_at');
  if (error) return toast(error.message);
  state.entries = data;
  await signUrls(data.flatMap((e) => [e.food_photo, e.pre_glucose_photo, e.glucose_photo]));
}

async function loadWeek() {
  const { data, error } = await sb.from('entries').select('*')
    .gte('day', state.weekStart).lte('day', addDays(state.weekStart, 6));
  if (error) return toast(error.message);
  state.week = data;
  if (state.view === 'meals') await signUrls(data.map((e) => e.food_photo));
}

/* ---------- 알림 예약 ---------- */
async function syncMealReminder(e) {
  if (e.slot === 'fasting' || e.slot === 'bedtime') return;
  const key = `meal-${e.id}`;
  const due = e.meal_at && new Date(new Date(e.meal_at).getTime() + (e.post_hours || 2) * 3600e3);
  if (!state.settings.mealAlarm || !due || e.glucose != null || due < Date.now()) {
    await sb.from('reminders').delete().eq('key', key).eq('sent', false);
    return;
  }
  await sb.from('reminders').upsert({
    key,
    due_at: due.toISOString(),
    title: '🩸 식후 혈당 잴 시간이에요',
    body: `${SLOT_NAME[e.slot]} 식사(${hhmm(e.meal_at)}) 후 ${e.post_hours}시간이 됐어요.`,
    sent: false,
  }, { onConflict: 'key' });
}

async function ensureFastingReminders() {
  const t = state.settings.fastingAlarm;
  if (!t) return;
  const rows = [];
  for (const d of [todayStr(), addDays(todayStr(), 1)]) {
    const due = new Date(toIso(d, t));
    if (due > Date.now()) {
      rows.push({ key: `fasting-${d}`, due_at: due.toISOString(), title: '☀️ 공복 혈당 잴 시간이에요', body: '일어나서 아무것도 먹기 전에 측정해 주세요.' });
    }
  }
  if (rows.length) await sb.from('reminders').upsert(rows, { onConflict: 'key', ignoreDuplicates: true });
}

/* ---------- 푸시 ---------- */
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent);
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

function b64ToBytes(b64) {
  const s = atob((b64 + '='.repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

async function refreshPushState() {
  if (!pushSupported()) { state.pushOn = false; return; }
  const reg = await navigator.serviceWorker.ready;
  state.pushOn = !!(await reg.pushManager.getSubscription());
}

async function enablePush() {
  if (!pushSupported()) {
    return toast(isIOS() ? '아이폰은 공유 버튼 → "홈 화면에 추가" 후, 홈 화면 아이콘으로 열어야 알림을 켤 수 있어요.' : '이 브라우저는 알림을 지원하지 않아요.');
  }
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return toast('알림 권한이 거부됐어요. 휴대폰 설정에서 허용해 주세요.');
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(VAPID_PUBLIC_KEY) });
  const j = sub.toJSON();
  const { error } = await sb.from('push_subs').upsert({ endpoint: j.endpoint, sub: j, device: navigator.userAgent.slice(0, 150) }, { onConflict: 'endpoint' });
  if (error) return toast('알림 등록 실패: ' + error.message);
  state.pushOn = true;
  toast('이 기기에서 알림을 받아요');
  render();
}

async function disablePush() {
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (sub) {
    await sb.from('push_subs').delete().eq('endpoint', sub.endpoint);
    await sub.unsubscribe();
  }
  state.pushOn = false;
  toast('이 기기 알림을 껐어요');
  render();
}

async function testPush() {
  const { error } = await sb.from('reminders').insert({ key: `test-${Date.now()}`, due_at: new Date().toISOString(), title: '🔔 테스트 알림', body: '알림이 잘 와요!' });
  toast(error ? '실패: ' + error.message : '1분 안에 알림이 와요');
}

/* ---------- 가족 링크 ---------- */
// 링크 #k=코드 로 열면 공용 계정으로 자동 로그인
const KEY_STORE = 'gdm-family-key';
function storedKey() { try { return localStorage.getItem(KEY_STORE); } catch { return null; } }
function familyKey() {
  const m = location.hash.match(/k=([^&]+)/);
  return m ? decodeURIComponent(m[1]) : storedKey();
}
function familyLink() { return `${location.origin}${location.pathname}#k=${encodeURIComponent(familyKey() || '')}`; }

async function signInWithKey(key) {
  if (!key) return false;
  const { error } = await sb.auth.signInWithPassword({ email: FAMILY_EMAIL, password: key });
  if (error) return false;
  try { localStorage.setItem(KEY_STORE, key); } catch { /* 저장 안 돼도 세션은 유지 */ }
  return true;
}

async function copyLink() {
  try {
    await navigator.clipboard.writeText(familyLink());
    toast('가족 링크를 복사했어요. 카톡으로 보내 주세요.');
  } catch {
    prompt('아래 링크를 복사하세요', familyLink());
  }
}

/* ---------- 화면: 코드 입력 ---------- */
function loginView() {
  return `<section class="login">
    <div class="logo">🩸</div>
    <h1>혈당일기</h1>
    <p class="muted">가족 링크로 열어 주세요.<br>링크가 안 되면 링크의 <b>k=</b> 뒤 코드를 넣어 주세요.</p>
    <form id="login-form">
      <label>가족 코드<input type="text" name="code" autocomplete="off" autocapitalize="off" spellcheck="false" required></label>
      <button class="primary" type="submit">열기</button>
    </form>
  </section>`;
}

/* ---------- 화면: 하루 ---------- */
function pendingText(e) {
  if (e.slot !== 'fasting' && e.slot !== 'bedtime' && e.meal_at) {
    const due = new Date(new Date(e.meal_at).getTime() + (e.post_hours || 2) * 3600e3);
    const left = Math.round((due - Date.now()) / 60000);
    if (left > 0) return `⏰ ${hhmm(due.toISOString())} 측정 (${duration(left)} 남음)`;
    return `⏰ 측정 시간 ${hhmm(due.toISOString())} 지났어요`;
  }
  return '혈당 미입력';
}

function card(slot, e) {
  const name = SLOT_NAME[slot];
  if (!e) {
    return `<button class="card empty" data-action="edit" data-slot="${slot}">
      <span class="slot">${name}</span><span class="muted">탭해서 기록하기</span></button>`;
  }
  const meal = slot !== 'fasting' && slot !== 'bedtime';
  let elapsed = '';
  if (meal && e.meal_at && e.glucose_at) {
    const m = Math.round((new Date(e.glucose_at) - new Date(e.meal_at)) / 60000);
    if (m > 0) elapsed = ` (식후 ${duration(m)})`;
  }
  const mealRow = meal ? `<div class="row">
      <span class="ico">🍽</span>
      <div class="grow"><div class="sub">식사${e.meal_at ? ' ' + hhmm(e.meal_at) : ''}</div>
      <div class="food">${e.food ? esc(e.food) : '<span class="muted">메뉴 미입력</span>'}</div></div>
      ${thumb(e.food_photo)}</div>` : '';
  const preGlLabel = slot === 'breakfast' ? '공복' : '식전';
  const preGlRow = meal && e.pre_glucose != null
    ? `<div class="row">
        <span class="ico">🩸</span>
        <div class="grow"><div class="sub">${preGlLabel}${e.pre_glucose_at ? ' · ' + hhmm(e.pre_glucose_at) : ''}</div>
        <div><b class="num">${e.pre_glucose}</b><span class="unit">mg/dL</span> ${preBadge(e)}</div></div>
        ${thumb(e.pre_glucose_photo)}</div>`
    : '';
  const value = e.glucose != null
    ? `<b class="num">${e.glucose}</b><span class="unit">mg/dL</span> ${badge(e)}`
    : `<span class="muted">${pendingText(e)}</span>`;
  const glSubLabel = meal ? `식후 ${e.post_hours || 2}시간 기준` : slot === 'bedtime' ? '취침 전' : '공복';
  const glRow = `<div class="row">
      <span class="ico">🩸</span>
      <div class="grow"><div class="sub">${glSubLabel}${e.glucose_at ? ' · ' + hhmm(e.glucose_at) : ''}${elapsed}</div>
      <div>${value}</div></div>
      ${thumb(e.glucose_photo)}</div>`;
  const ketoneRow = slot === 'breakfast' && e.ketone != null
    ? `<div class="row"><span class="ico">🧪</span><div class="grow"><div class="sub">케톤 (소변)</div>
        <div>${KETONE_LABEL[e.ketone] ?? e.ketone}</div></div></div>`
    : '';
  const exRow = meal && e.exercise != null
    ? `<div class="ex ${e.exercise ? 'on' : ''}">${e.exercise ? `🚶 식후 운동 ${e.exercise_min ? e.exercise_min + '분' : '했어요'}` : '식후 운동 안 했어요'}</div>` : '';
  return `<div class="card ${status(e) || ''}" data-action="edit" data-slot="${slot}" data-id="${e.id}">
    <div class="slot">${name}</div>${mealRow}${preGlRow}${glRow}${ketoneRow}${exRow}${e.memo ? `<div class="memo">${esc(e.memo)}</div>` : ''}</div>`;
}

function dayView() {
  const find = (k) => state.entries.find((e) => e.slot === k);
  const snacks = state.entries.filter((e) => e.slot === 'snack');
  const isToday = state.day === todayStr();
  return `<header class="top">
      <button class="nav" data-action="prev" aria-label="이전 날">‹</button>
      <div class="title"><b>${dayLabel(state.day)}</b>${isToday ? '<span class="muted">오늘</span>' : '<button class="link" data-action="today">오늘로</button>'}</div>
      <button class="nav" data-action="next" aria-label="다음 날">›</button>
    </header>
    <section class="list">
      ${SLOTS.map((k) => card(k, find(k))).join('')}
      ${snacks.map((e) => card('snack', e)).join('')}
      <button class="add" data-action="edit" data-slot="snack">+ 간식 추가</button>
    </section>`;
}

/* ---------- 화면: 통계 ---------- */
function chart(slot, days, field = 'glucose') {
  const s = state.settings;
  const W = 320, H = 140, pl = 34, pr = 12, pt = 12, pb = 24;
  const isPre = field === 'pre_glucose';
  const pts = days.map((d, i) => {
    const e = state.week.find((x) => x.day === d && x.slot === slot && x[field] != null);
    return e ? { i, e, v: e[field] } : null;
  }).filter(Boolean);
  if (!pts.length) return `<p class="muted" style="font-size:13px;text-align:center;padding:16px 0">기록 없음</p>`;
  const target = isPre || slot === 'fasting' || slot === 'bedtime' ? s.fasting : (s.postHours === 1 ? s.post1h : s.post2h);
  const vals = pts.map((p) => p.v);
  const lo = Math.floor((Math.min(target, ...vals) - 20) / 20) * 20;
  const hi = Math.ceil((Math.max(target, ...vals) + 20) / 20) * 20;
  const x = (i) => pl + (i * (W - pl - pr)) / 6;
  const y = (v) => pt + ((hi - v) / (hi - lo)) * (H - pt - pb);
  const step = (hi - lo) > 120 ? 40 : 20;
  let grid = '';
  for (let v = lo; v <= hi; v += step) {
    grid += `<line x1="${pl}" x2="${W - pr}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${pl - 6}" y="${y(v) + 3.5}" class="axis" text-anchor="end">${v}</text>`;
  }
  const xl = days.map((d, i) => `<text x="${x(i)}" y="${H - 6}" class="axis" text-anchor="middle">${WD[parseDay(d).getDay()]}</text>`).join('');
  const line = pts.length > 1 ? `<polyline points="${pts.map((p) => `${x(p.i)},${y(p.v)}`).join(' ')}" class="series"/>` : '';
  const dots = pts.map((p) => {
    const st = isPre ? preStatus(p.e) : status(p.e);
    const tip = `${shortDay(p.e.day)} ${p.v} mg/dL${st ? ' · ' + STATUS_LABEL[st] : ''}`;
    return `<circle cx="${x(p.i)}" cy="${y(p.v)}" r="5" class="dot ${st || 'ok'}"/>
      <circle cx="${x(p.i)}" cy="${y(p.v)}" r="16" class="hit" data-tip="${esc(tip)}"/>`;
  }).join('');
  return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img">
    ${grid}${xl}
    <line x1="${pl}" x2="${W - pr}" y1="${y(target)}" y2="${y(target)}" class="target"/>
    <text x="${W - pr}" y="${y(target) - 5}" class="axis" text-anchor="end">목표 ${target} 미만</text>
    ${line}${dots}</svg>`;
}

function weekHeader() {
  const end = addDays(state.weekStart, 6);
  return `<header class="top">
      <button class="nav" data-action="wprev" aria-label="이전 주">‹</button>
      <div class="title"><b>${shortDay(state.weekStart)} ~ ${shortDay(end)}</b>
        ${state.weekStart === mondayOf(todayStr()) ? '<span class="muted">이번 주</span>' : '<button class="link" data-action="wthis">이번 주로</button>'}</div>
      <button class="nav" data-action="wnext" aria-label="다음 주">›</button>
    </header>`;
}

// 식후 운동한 식사 vs 안 한 식사의 식후 혈당 비교
function exercisePanel() {
  const post = state.week.filter((e) => e.slot !== 'fasting' && e.slot !== 'bedtime' && e.glucose != null && e.exercise != null);
  if (!post.length) {
    return `<div class="panel"><div class="panel-head"><b>🚶 식후 운동</b><span class="muted">기록 없음</span></div>
      <p class="hint">식사를 기록할 때 식후 운동 여부를 남기면, 운동한 날과 안 한 날의 혈당을 비교해 드려요.</p></div>`;
  }
  const grp = (v) => {
    const g = post.filter((e) => e.exercise === v);
    if (!g.length) return { n: 0 };
    return {
      n: g.length,
      avg: Math.round(g.reduce((a, e) => a + e.glucose, 0) / g.length),
      ok: Math.round((g.filter((e) => status(e) === 'ok').length / g.length) * 100),
    };
  };
  const yes = grp(true), no = grp(false);
  const withMin = post.filter((e) => e.exercise && e.exercise_min);
  const avgMin = withMin.length ? Math.round(withMin.reduce((a, e) => a + e.exercise_min, 0) / withMin.length) : null;
  const col = (label, r) => `<div class="tile"><span class="muted">${label} · ${r.n}회</span>
    <b>${r.n ? r.avg : '–'}<small>${r.n ? 'mg/dL' : ''}</small></b><span class="muted">${r.n ? `목표 달성 ${r.ok}%` : '기록 없음'}</span></div>`;
  let note = '';
  if (yes.n && no.n) {
    const d = no.avg - yes.avg;
    note = `<p class="hint">${d > 0 ? `운동한 식사가 평균 <b>${d}</b> 낮았어요.` : d < 0 ? `이번 주는 운동한 식사가 평균 ${-d} 높았어요.` : '평균이 같았어요.'} (식후 혈당 평균)</p>`;
  }
  return `<div class="panel"><div class="panel-head"><b>🚶 식후 운동별 식후 혈당</b>${avgMin ? `<span class="muted">평균 운동 ${avgMin}분</span>` : ''}</div>
    <div class="tiles two-col">${col('운동 함', yes)}${col('운동 안 함', no)}</div>${note}</div>`;
}

/* ---------- 화면: 주간 식단 ---------- */
// 먹은 시각 순, 시각이 없으면 끼니 기본 시각으로
const MEAL_ORDER = { breakfast: '08:00', lunch: '12:00', dinner: '18:00', snack: '23:59' };
const mealKey = (e) => (e.meal_at ? hhmm(e.meal_at) : MEAL_ORDER[e.slot]);
function mealLine(e) {
  const st = status(e);
  const gl = e.glucose != null ? `<span class="cell ${st}">${e.glucose}${st === 'high' ? ' ▲' : st === 'low' ? ' ▼' : ''}</span>` : '';
  return `<div class="meal-line" data-action="goto" data-day="${e.day}">
    <span class="meal-slot">${SLOT_NAME[e.slot]}${e.meal_at ? `<small>${hhmm(e.meal_at)}</small>` : ''}</span>
    <div class="grow">
      <div class="food">${e.food ? esc(e.food) : '<span class="muted">메뉴 미입력</span>'}</div>
      <div class="meal-meta">${gl}${e.exercise ? `<span class="ex-ico">🚶${e.exercise_min ? ' ' + e.exercise_min + '분' : ''}</span>` : ''}</div>
    </div>${thumb(e.food_photo)}</div>`;
}

function mealsView() {
  const days = [...Array(7)].map((_, i) => addDays(state.weekStart, i));
  const meals = state.week.filter((e) => e.slot !== 'fasting' && e.slot !== 'bedtime')
    .sort((a, b) => mealKey(a).localeCompare(mealKey(b)));
  const exCount = meals.filter((e) => e.exercise).length;
  const high = meals.filter((e) => status(e) === 'high');
  const dayBlocks = days.map((d) => {
    const list = meals.filter((e) => e.day === d);
    const isToday = d === todayStr();
    return `<div class="panel day-block">
      <div class="panel-head" data-action="goto" data-day="${d}"><b>${shortDay(d)}${isToday ? ' · 오늘' : ''}</b><span class="link">기록 보기 ›</span></div>
      ${list.length ? list.map(mealLine).join('') : '<p class="muted">식사 기록 없음</p>'}</div>`;
  }).join('');
  const highPanel = high.length ? `<div class="panel">
      <div class="panel-head"><b>⚠️ 식후 혈당이 높았던 식사</b><span class="muted">${high.length}회</span></div>
      ${high.map((e) => `<div class="meal-line" data-action="goto" data-day="${e.day}">
        <span class="meal-slot">${shortDay(e.day)}<small>${SLOT_NAME[e.slot]}</small></span>
        <div class="grow"><div class="food">${e.food ? esc(e.food) : '<span class="muted">메뉴 미입력</span>'}</div></div>
        <span class="cell high">${e.glucose} ▲</span></div>`).join('')}</div>` : '';
  return `${weekHeader()}
    <section class="list">
      <div class="tiles">
        <div class="tile"><span class="muted">식사 기록</span><b>${meals.length}<small>끼</small></b></div>
        <div class="tile"><span class="muted">식후 운동</span><b>${exCount}<small>회</small></b></div>
        <div class="tile"><span class="muted">혈당 초과</span><b>${high.length}<small>끼</small></b></div>
      </div>
      ${dayBlocks}
      ${highPanel}
    </section>`;
}

function statsView() {
  const days = [...Array(7)].map((_, i) => addDays(state.weekStart, i));
  const measured = state.week.filter((e) => e.glucose != null);
  const preMeasured = state.week.filter((e) => e.pre_glucose != null);
  const count = (st) => measured.filter((e) => status(e) === st).length;
  const preCount = (st) => preMeasured.filter((e) => preStatus(e) === st).length;
  const totalOk = count('ok') + preCount('ok');
  const totalAll = measured.length + preMeasured.length;
  const okRate = totalAll ? Math.round((totalOk / totalAll) * 100) : null;

  // 케톤 패널
  const kEntries = state.week.filter((e) => e.slot === 'breakfast' && e.ketone != null);
  const kPos = kEntries.filter((e) => e.ketone > 0);
  const kDots = days.map((d) => {
    const e = kEntries.find((x) => x.day === d);
    if (!e) return `<div class="k-dot"><div class="k-wd">${WD[parseDay(d).getDay()]}</div><div class="k-v muted">–</div></div>`;
    const pos = e.ketone > 0;
    const sym = { 5: '±', 15: '+', 50: '++', 100: '+++' };
    return `<div class="k-dot ${pos ? 'pos' : 'neg'}">
      <div class="k-wd">${WD[parseDay(d).getDay()]}</div>
      <div class="k-v">${pos ? (sym[e.ketone] ?? '+') : '음성'}</div>
    </div>`;
  }).join('');
  const ketonePanel = `<div class="panel">
    <div class="panel-head"><b>🧪 케톤 (소변)</b><span class="muted">${kEntries.length ? `양성 ${kPos.length}일 · 음성 ${kEntries.length - kPos.length}일` : '기록 없음'}</span></div>
    ${kEntries.length ? `<div class="ketone-week">${kDots}</div>` : '<p class="hint">아침 카드에서 케톤을 입력하면 여기서 볼 수 있어요.</p>'}
    ${kPos.length ? `<p class="hint" style="color:var(--high-ink)">이번 주 ${kPos.length}일 양성 — 탄수화물 섭취량을 확인해 주세요.</p>` : ''}
  </div>`;

  // 그리드 표
  const glCell = (d, slot) => {
    const e = state.week.find((x) => x.day === d && x.slot === slot && x.glucose != null);
    if (!e) return '<td class="muted">–</td>';
    const st = status(e);
    return `<td><span class="cell ${st}">${e.glucose}${st === 'high' ? '▲' : st === 'low' ? '▼' : ''}</span></td>`;
  };
  const preCell = (d, slot) => {
    const e = state.week.find((x) => x.day === d && x.slot === slot && x.pre_glucose != null);
    if (!e) return '<td class="muted">–</td>';
    const st = preStatus(e);
    return `<td><span class="cell ${st}">${e.pre_glucose}${st === 'high' ? '▲' : st === 'low' ? '▼' : ''}</span></td>`;
  };
  const kCell = (d) => {
    const e = state.week.find((x) => x.day === d && x.slot === 'breakfast' && x.ketone != null);
    if (!e) return '<td class="muted">–</td>';
    return `<td><span class="cell ${e.ketone > 0 ? 'high' : 'ok'}">${e.ketone > 0 ? '양성' : '음성'}</span></td>`;
  };
  const rows = days.map((d) => `<tr data-action="goto" data-day="${d}">
    <th>${shortDay(d)}</th>
    ${kCell(d)}${preCell(d, 'breakfast')}${glCell(d, 'breakfast')}
    ${preCell(d, 'lunch')}${glCell(d, 'lunch')}
    ${preCell(d, 'dinner')}${glCell(d, 'dinner')}
    ${glCell(d, 'bedtime')}
  </tr>`).join('');

  // 차트
  const mkChart = (title, slot, field = 'glucose') => {
    const v = state.week.filter((e) => e.slot === slot && e[field] != null);
    const avg = v.length ? Math.round(v.reduce((a, e) => a + e[field], 0) / v.length) : null;
    const over = v.filter((e) => (field === 'glucose' ? status(e) : preStatus(e)) === 'high').length;
    return `<div class="panel"><div class="panel-head"><b>${title}</b>
      <span class="muted">${avg != null ? `평균 ${avg} · 초과 ${over}회` : '기록 없음'}</span></div>
      ${chart(slot, days, field)}</div>`;
  };
  const charts = [
    mkChart('공복 혈당', 'breakfast', 'pre_glucose'),
    mkChart('아침 식후', 'breakfast'),
    mkChart('점심 식전', 'lunch', 'pre_glucose'),
    mkChart('점심 식후', 'lunch'),
    mkChart('저녁 식전', 'dinner', 'pre_glucose'),
    mkChart('저녁 식후', 'dinner'),
    mkChart('취침 전', 'bedtime'),
  ].join('');

  return `${weekHeader()}
    <section class="list">
      <div class="tiles">
        <div class="tile"><span class="muted">측정 횟수</span><b>${totalAll}<small>회</small></b></div>
        <div class="tile"><span class="muted">목표 달성</span><b>${okRate ?? '–'}<small>${okRate != null ? '%' : ''}</small></b></div>
        <div class="tile"><span class="muted">초과</span><b>${count('high') + preCount('high')}<small>회</small></b></div>
      </div>
      ${ketonePanel}
      ${exercisePanel()}
      <div class="panel"><div style="overflow-x:auto"><table class="grid-table">
        <thead><tr><th></th><th>케톤</th><th>공복</th><th>아침↑</th><th>점↓</th><th>점↑</th><th>저↓</th><th>저↑</th><th>취침</th></tr></thead>
        <tbody>${rows}</tbody></table></div>
        <p class="hint">↓ 식전 &nbsp; ↑ 식후 &nbsp;· 날짜를 누르면 그날 기록으로 이동해요.</p></div>
      ${charts}
    </section>`;
}

/* ---------- 화면: 설정 ---------- */
function settingsView() {
  const s = state.settings;
  const num = (k, label) => `<label>${label}<input type="number" inputmode="numeric" name="${k}" value="${s[k]}"></label>`;
  return `<header class="top"><div class="title"><b>설정</b></div></header>
    <section class="list">
      <form class="panel" id="settings-form">
        <h3>혈당 목표 (미만이면 정상)</h3>
        <div class="two">${num('fasting', '공복')}${num('low', '저혈당 경고 (미만)')}</div>
        <div class="two">${num('post1h', '식후 1시간')}${num('post2h', '식후 2시간')}</div>
        <h3>식후 측정 기준</h3>
        <div class="seg">
          <label><input type="radio" name="postHours" value="1" ${s.postHours === 1 ? 'checked' : ''}><span>식후 1시간</span></label>
          <label><input type="radio" name="postHours" value="2" ${s.postHours === 2 ? 'checked' : ''}><span>식후 2시간</span></label>
        </div>
        <p class="hint">식후 시간은 보통 <b>식사 시작</b> 시각부터 셉니다. 병원 안내에 맞춰 주세요.</p>
        <h3>알림 시간</h3>
        <label class="check"><input type="checkbox" name="mealAlarm" ${s.mealAlarm ? 'checked' : ''}> 식사 기록 후 측정 시간에 알림</label>
        <label>공복 혈당 알림 (비우면 끔)<input type="time" name="fastingAlarm" value="${s.fastingAlarm || ''}"></label>
        <button class="primary" type="submit">설정 저장</button>
        <p class="hint">목표·알림 설정은 부부가 함께 씁니다.</p>
      </form>

      <div class="panel">
        <h3>이 기기 알림</h3>
        <p>${state.pushOn ? '✅ 이 기기로 알림을 받고 있어요.' : '🔕 이 기기는 알림을 받지 않아요.'}</p>
        <div class="btns">
          ${state.pushOn
            ? '<button data-action="push-test">테스트 알림</button><button data-action="push-off">알림 끄기</button>'
            : '<button class="primary" data-action="push-on">이 기기 알림 켜기</button>'}
        </div>
        <p class="hint">알림을 켠 모든 기기(남편 폰 포함)로 함께 와요.${isIOS() ? '<br>아이폰: Safari 공유 버튼 → "홈 화면에 추가" 후 홈 화면 아이콘으로 열어야 알림이 됩니다.' : ''}</p>
      </div>

      <div class="panel">
        <h3>데이터</h3>
        <div class="btns"><button data-action="csv">전체 기록 엑셀(CSV) 받기</button></div>
      </div>

      <div class="panel">
        <h3>가족 링크</h3>
        <p>이 링크로 열면 바로 기록 화면이 나와요. 두 분만 갖고 계세요.</p>
        <div class="btns"><button data-action="copy-link">가족 링크 복사</button></div>
      </div>
    </section>`;
}

/* ---------- 입력 시트 ---------- */
function photoField(kind) {
  const ed = state.edit;
  const label = kind === 'food' ? '음식 사진' : kind === 'pre_glucose' ? '식전 혈당계 사진' : '식후 혈당계 사진';
  const src = ed[kind + 'Preview'] || (ed[kind + '_photo'] && urlCache.get(ed[kind + '_photo']));
  return `<div class="photo-field" data-kind="${kind}">
    ${src ? `<img src="${src}" alt="" data-action="photo" data-src="${src}"><button type="button" class="link" data-action="photo-remove" data-kind="${kind}">사진 삭제</button>` : ''}
    <label class="btn">📷 ${src ? '사진 바꾸기' : label + ' 추가'}<input type="file" accept="image/*" hidden data-kind="${kind}"></label>
  </div>`;
}

function openSheet(slot, id) {
  const e = id ? state.entries.find((x) => x.id === id) : slot !== 'snack' ? state.entries.find((x) => x.slot === slot) : null;
  state.edit = {
    slot, id: e?.id || null, day: state.day, orig: e || null,
    food_photo: e?.food_photo || null, pre_glucose_photo: e?.pre_glucose_photo || null, glucose_photo: e?.glucose_photo || null,
    foodFile: null, pre_glucoseFile: null, glucoseFile: null,
    foodPreview: null, pre_glucosePreview: null, glucosePreview: null,
  };
  const meal = slot !== 'fasting' && slot !== 'bedtime';
  const ph = e?.post_hours || state.settings.postHours;
  const mealTime = e ? hhmm(e.meal_at) : nowHHMM();
  const glTime = e ? hhmm(e.glucose_at) : (meal ? '' : nowHHMM());
  $sheet.innerHTML = `<div class="overlay" data-action="close-sheet"></div>
    <form class="sheet" id="entry-form">
      <div class="sheet-head"><b>${dayLabel(state.day)} · ${SLOT_NAME[slot]}</b><button type="button" class="nav" data-action="close-sheet" aria-label="닫기">✕</button></div>
      ${meal ? `<fieldset><legend>🍽 식사</legend>
        <label>식사 시작 시각<input type="time" name="meal_time" value="${mealTime}"></label>
        <label>무엇을 먹었나요<textarea name="food" rows="2" placeholder="예) 현미밥 반 공기, 된장국, 계란말이">${esc(e?.food)}</textarea></label>
        ${photoField('food')}
        <div class="field"><span>🚶 식후 운동 (걷기 등)</span>
          <div class="seg">
            <label><input type="radio" name="exercise" value="yes" ${e?.exercise === true ? 'checked' : ''}><span>했어요</span></label>
            <label><input type="radio" name="exercise" value="no" ${e?.exercise === false ? 'checked' : ''}><span>안 했어요</span></label>
          </div>
          <div class="ex-min" ${e?.exercise === true ? '' : 'hidden'}>
            ${[10, 15, 20, 30].map((m) => `<button type="button" class="chip ${e?.exercise_min === m ? 'on' : ''}" data-action="ex-min" data-min="${m}">${m}분</button>`).join('')}
            <label class="min-input"><input type="number" inputmode="numeric" name="exercise_min" min="1" max="300" value="${e?.exercise_min ?? ''}" placeholder="직접">분</label>
          </div></div>
      </fieldset>` : ''}
      <fieldset><legend>🩸 혈당</legend>
        ${meal ? `<div class="two">
          <label>${slot === 'breakfast' ? '공복 혈당 (mg/dL)' : '식전 혈당 (mg/dL)'}<input type="number" inputmode="numeric" name="pre_glucose" min="20" max="600" value="${e?.pre_glucose ?? ''}" placeholder="선택"></label>
          <label>${slot === 'breakfast' ? '공복 시각' : '식전 시각'}<input type="time" name="pre_glucose_time" value="${e ? hhmm(e.pre_glucose_at) : ''}"></label>
        </div>
        ${photoField('pre_glucose')}
        <div class="seg">
          <label><input type="radio" name="post_hours" value="1" ${ph === 1 ? 'checked' : ''}><span>식후 1시간</span></label>
          <label><input type="radio" name="post_hours" value="2" ${ph === 2 ? 'checked' : ''}><span>식후 2시간</span></label></div>` : ''}
        <div class="two">
          <label>${meal ? '식후 혈당 (mg/dL)' : '혈당 (mg/dL)'}<input type="number" inputmode="numeric" name="glucose" min="20" max="600" value="${e?.glucose ?? ''}" placeholder="${meal ? '측정 후 입력' : ''}"></label>
          <label>측정 시각<input type="time" name="glucose_time" value="${glTime}"></label>
        </div>
        ${photoField('glucose')}
        ${slot === 'breakfast' ? `<label>케톤 (소변 검사)<select name="ketone">
          <option value="">선택 안 함</option>
          <option value="0" ${e?.ketone === 0 ? 'selected' : ''}>음성 (-)</option>
          <option value="5" ${e?.ketone === 5 ? 'selected' : ''}>± (5 mg/dL) 양성</option>
          <option value="15" ${e?.ketone === 15 ? 'selected' : ''}>+ (15 mg/dL) 양성</option>
          <option value="50" ${e?.ketone === 50 ? 'selected' : ''}>++ (50 mg/dL) 양성</option>
          <option value="100" ${e?.ketone === 100 ? 'selected' : ''}>+++ (100 mg/dL) 양성</option>
        </select></label>` : ''}
      </fieldset>
      <label>메모<textarea name="memo" rows="2" placeholder="컨디션, 특이사항">${esc(e?.memo)}</textarea></label>
      ${meal ? '<p class="hint">식사만 먼저 저장해 두면, 측정 시간에 알림이 와요. 혈당은 나중에 다시 눌러 입력하세요.</p>' : ''}
      <div class="actions">
        ${e ? '<button type="button" class="danger" data-action="delete">삭제</button>' : ''}
        <button type="submit" class="primary">저장</button>
      </div>
    </form>`;
  document.body.classList.add('locked');
}

function closeSheet() {
  $sheet.innerHTML = '';
  state.edit = null;
  document.body.classList.remove('locked');
}

async function saveEntry(form) {
  const ed = state.edit;
  const fd = new FormData(form);
  const meal = ed.slot !== 'fasting' && ed.slot !== 'bedtime';
  const btn = form.querySelector('[type=submit]');
  btn.disabled = true;
  btn.textContent = '저장 중…';
  try {
    const g = fd.get('glucose');
    const row = { day: ed.day, slot: ed.slot, memo: fd.get('memo').trim() || null };
    row.glucose = g === '' ? null : Math.round(Number(g));
    let gt = fd.get('glucose_time');
    if (row.glucose != null && !gt) gt = nowHHMM();
    row.glucose_at = row.glucose != null || gt ? toIso(ed.day, gt) : null;
    if (meal) {
      row.meal_at = toIso(ed.day, fd.get('meal_time'));
      row.food = fd.get('food').trim() || null;
      row.post_hours = Number(fd.get('post_hours') || state.settings.postHours);
      row.food_photo = ed.foodFile ? await uploadPhoto(ed.foodFile, ed.day) : ed.food_photo;
      const ex = fd.get('exercise');
      const mins = Math.round(Number(fd.get('exercise_min'))) || null;
      row.exercise = ex === 'yes' || (ex == null && mins) ? true : ex === 'no' ? false : null;
      row.exercise_min = row.exercise ? mins : null;
      const pg = fd.get('pre_glucose');
      row.pre_glucose = pg === '' || pg == null ? null : Math.round(Number(pg));
      const pgt = fd.get('pre_glucose_time');
      row.pre_glucose_at = row.pre_glucose != null || pgt ? toIso(ed.day, pgt || null) : null;
      row.pre_glucose_photo = ed.pre_glucoseFile ? await uploadPhoto(ed.pre_glucoseFile, ed.day) : ed.pre_glucose_photo;
    }
    if (ed.slot === 'breakfast') {
      const k = fd.get('ketone');
      row.ketone = k === '' || k == null ? null : parseFloat(k);
    }
    row.glucose_photo = ed.glucoseFile ? await uploadPhoto(ed.glucoseFile, ed.day) : ed.glucose_photo;

    const write = (r) => (ed.id
      ? sb.from('entries').update({ ...r, updated_at: new Date().toISOString() }).eq('id', ed.id)
      : sb.from('entries').insert(r)).select().single();
    let { data: saved, error } = await write(row);
    // DB에 운동 칸이 아직 없으면 그 칸만 빼고 저장
    for (const col of ['exercise_min', 'exercise', 'ketone', 'pre_glucose_at', 'pre_glucose', 'pre_glucose_photo']) {
      if (error && (error.message || '').includes(col) && col in row) {
        delete row[col];
        if (col === 'exercise') delete row.exercise_min;
        ({ data: saved, error } = await write(row));
      }
    }
    if (error) throw error.code === '23505' ? new Error('다른 기기에서 이미 기록했어요. 화면을 새로고침해 주세요.') : error;

    const old = [ed.orig?.food_photo, ed.orig?.pre_glucose_photo, ed.orig?.glucose_photo]
      .filter((p) => p && p !== saved.food_photo && p !== saved.pre_glucose_photo && p !== saved.glucose_photo);
    if (old.length) await sb.storage.from('photos').remove(old);
    await syncMealReminder(saved);

    closeSheet();
    await loadDay();
    render();
    toast('저장했어요');
  } catch (err) {
    toast('저장 실패: ' + err.message);
    btn.disabled = false;
    btn.textContent = '저장';
  }
}

async function deleteEntry() {
  const ed = state.edit;
  if (!ed?.id) return;
  const btn = $sheet.querySelector('[data-action=delete]');
  if (btn.dataset.confirm !== '1') {
    btn.dataset.confirm = '1';
    btn.textContent = '한 번 더 누르면 삭제';
    return;
  }
  const { error } = await sb.from('entries').delete().eq('id', ed.id);
  if (error) return toast('삭제 실패: ' + error.message);
  const photos = [ed.orig?.food_photo, ed.orig?.pre_glucose_photo, ed.orig?.glucose_photo].filter(Boolean);
  if (photos.length) await sb.storage.from('photos').remove(photos);
  await sb.from('reminders').delete().eq('key', `meal-${ed.id}`).eq('sent', false);
  closeSheet();
  await loadDay();
  render();
  toast('삭제했어요');
}

/* ---------- CSV ---------- */
async function exportCsv() {
  const { data, error } = await sb.from('entries').select('*').order('day').order('created_at');
  if (error) return toast(error.message);
  const order = { fasting: 0, breakfast: 1, lunch: 2, dinner: 3, snack: 4 };
  data.sort((a, b) => a.day.localeCompare(b.day) || order[a.slot] - order[b.slot]);
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = ['날짜', '구분', '식사시각', '메뉴', '식전혈당(mg/dL)', '식전시각', '식후운동', '측정기준', '혈당(mg/dL)', '측정시각', '판정', '케톤(mmol/L)', '메모'];
  const lines = data.map((e) => [
    e.day, SLOT_NAME[e.slot], hhmm(e.meal_at), e.food,
    e.pre_glucose ?? '', e.pre_glucose_at ? hhmm(e.pre_glucose_at) : '',
    e.exercise == null ? '' : e.exercise ? (e.exercise_min ? `${e.exercise_min}분` : '함') : '안 함',
    e.slot === 'fasting' ? '공복' : e.slot === 'bedtime' ? '취침 전' : `식후 ${e.post_hours || 2}시간`,
    e.glucose, hhmm(e.glucose_at), status(e) ? STATUS_LABEL[status(e)].slice(2) : '', e.ketone ?? '', e.memo,
  ].map(q).join(','));
  const blob = new Blob(['﻿' + [head.map(q).join(','), ...lines].join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `혈당기록_${todayStr()}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* ---------- 렌더 ---------- */
function render() {
  if (!state.user) { $app.innerHTML = loginView(); return; }
  const views = { day: dayView, meals: mealsView, stats: statsView, settings: settingsView };
  const body = (views[state.view] || dayView)();
  const tab = (v, ico, label) => `<button class="${state.view === v ? 'on' : ''}" data-action="tab" data-view="${v}"><span>${ico}</span>${label}</button>`;
  $app.innerHTML = `<main>${body}</main>
    <nav class="tabs">${tab('day', '📝', '기록')}${tab('meals', '🍱', '식단')}${tab('stats', '📊', '통계')}${tab('settings', '⚙️', '설정')}</nav>`;
}

async function refresh() {
  if (!state.user) return render();
  if (state.view === 'day') await loadDay();
  if (state.view === 'stats' || state.view === 'meals') await loadWeek();
  if (state.view === 'settings') await refreshPushState();
  render();
}

/* ---------- 이벤트 ---------- */
document.addEventListener('click', async (ev) => {
  const el = ev.target.closest('[data-action]');
  if (!el) return;
  const a = el.dataset.action;
  switch (a) {
    case 'photo':
      ev.stopPropagation();
      $viewer.innerHTML = `<img src="${el.dataset.src}" alt="">`;
      $viewer.hidden = false;
      return;
    case 'edit': return openSheet(el.dataset.slot, el.dataset.id);
    case 'close-sheet': return closeSheet();
    case 'delete': return deleteEntry();
    case 'ex-min': {
      const f = el.form;
      f.elements.exercise_min.value = el.dataset.min;
      f.querySelector('input[name=exercise][value=yes]').checked = true;
      f.querySelectorAll('.ex-min .chip').forEach((c) => c.classList.toggle('on', c === el));
      return;
    }
    case 'photo-remove': {
      const k = el.dataset.kind;
      Object.assign(state.edit, { [k + 'File']: null, [k + 'Preview']: null, [k + '_photo']: null });
      $sheet.querySelector(`.photo-field[data-kind=${k}]`).outerHTML = photoField(k);
      return;
    }
    case 'prev': state.day = addDays(state.day, -1); return refresh();
    case 'next': state.day = addDays(state.day, 1); return refresh();
    case 'today': state.day = todayStr(); return refresh();
    case 'wprev': state.weekStart = addDays(state.weekStart, -7); return refresh();
    case 'wnext': state.weekStart = addDays(state.weekStart, 7); return refresh();
    case 'wthis': state.weekStart = mondayOf(todayStr()); return refresh();
    case 'goto': state.day = el.dataset.day; state.view = 'day'; return refresh();
    case 'tab': state.view = el.dataset.view; window.scrollTo(0, 0); return refresh();
    case 'push-on': return enablePush().catch((e) => toast('알림 켜기 실패: ' + e.message));
    case 'push-off': return disablePush();
    case 'push-test': return testPush();
    case 'csv': return exportCsv();
    case 'copy-link': return copyLink();
  }
});

$viewer.addEventListener('click', () => { $viewer.hidden = true; $viewer.innerHTML = ''; });

document.addEventListener('change', (ev) => {
  const inp = ev.target;
  if (inp.name === 'exercise') {
    const box = inp.form.querySelector('.ex-min');
    box.hidden = inp.value !== 'yes';
    if (box.hidden) inp.form.elements.exercise_min.value = '';
  }
  if (inp.type === 'file' && inp.dataset.kind && state.edit) {
    const k = inp.dataset.kind;
    const file = inp.files[0];
    if (!file) return;
    Object.assign(state.edit, { [k + 'File']: file, [k + 'Preview']: URL.createObjectURL(file) });
    $sheet.querySelector(`.photo-field[data-kind=${k}]`).outerHTML = photoField(k);
  }
});

// 혈당을 입력하면 측정 시각이 비어 있을 때 지금 시각으로 채움
document.addEventListener('input', (ev) => {
  if (ev.target.name === 'exercise_min') {
    const v = ev.target.value;
    ev.target.form.querySelectorAll('.ex-min .chip').forEach((c) => c.classList.toggle('on', c.dataset.min === v));
  }
  if (ev.target.name === 'glucose') {
    const t = ev.target.form.elements.glucose_time;
    if (t && !t.value && ev.target.value) t.value = nowHHMM();
  }
  if (ev.target.name === 'pre_glucose') {
    const t = ev.target.form?.elements.pre_glucose_time;
    if (t && !t.value && ev.target.value) t.value = nowHHMM();
  }
});

document.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  if (f.id === 'entry-form') return saveEntry(f);
  if (f.id === 'login-form') {
    const code = new FormData(f).get('code').trim().replace(/^.*k=/, '');
    if (!(await signInWithKey(code))) toast('코드가 맞지 않아요');
    return;
  }
  if (f.id === 'settings-form') {
    const fd = new FormData(f);
    const prevAlarm = state.settings.fastingAlarm;
    const n = (k) => Number(fd.get(k)) || DEFAULTS[k];
    state.settings = {
      ...state.settings,
      fasting: n('fasting'), low: n('low'), post1h: n('post1h'), post2h: n('post2h'),
      postHours: Number(fd.get('postHours')) || 2,
      mealAlarm: fd.get('mealAlarm') === 'on',
      fastingAlarm: fd.get('fastingAlarm') || '',
    };
    const { error } = await sb.from('settings').update({ data: state.settings }).eq('id', 1);
    if (error) return toast('저장 실패: ' + error.message);
    if (prevAlarm !== state.settings.fastingAlarm) {
      await sb.from('reminders').delete().like('key', 'fasting-%').eq('sent', false);
      await ensureFastingReminders();
    }
    toast('설정을 저장했어요');
  }
});

// 차트 툴팁
function showTip(el) {
  $tip.textContent = el.dataset.tip;
  $tip.hidden = false;
  const r = el.getBoundingClientRect();
  const w = $tip.offsetWidth;
  const left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2));
  $tip.style.left = left + 'px';
  $tip.style.top = (r.top + window.scrollY - $tip.offsetHeight - 4) + 'px';
}
document.addEventListener('pointerover', (ev) => { const el = ev.target.closest?.('[data-tip]'); if (el) showTip(el); });
document.addEventListener('pointerout', (ev) => { if (ev.target.closest?.('[data-tip]')) $tip.hidden = true; });
document.addEventListener('pointerdown', (ev) => { const el = ev.target.closest?.('[data-tip]'); if (el) showTip(el); else $tip.hidden = true; });

// 앱으로 돌아오면 최신 데이터로
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.user && !state.edit) {
    if (state.day !== todayStr() && state.view === 'day' && Date.now() - (state.hiddenAt || 0) > 3 * 3600e3) state.day = todayStr();
    refresh();
    ensureFastingReminders();
  } else if (document.visibilityState === 'hidden') {
    state.hiddenAt = Date.now();
  }
});

// 남은 시간 표시 갱신
setInterval(() => { if (state.user && state.view === 'day' && !state.edit) render(); }, 60000);

/* ---------- 시작 ---------- */
let realtime = null;
async function onSignedIn(user) {
  state.user = user;
  await loadSettings();
  await refresh();
  ensureFastingReminders();
  if (!realtime) {
    // 다른 사람이 기록하면 바로 반영
    realtime = sb.channel('entries')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'entries' }, () => { if (!state.edit) refresh(); })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'settings' }, async () => { await loadSettings(); if (!state.edit) render(); })
      .subscribe();
  }
}

if (SUPABASE_URL.includes('YOUR_PROJECT')) {
  $app.innerHTML = '<p class="boot">아직 Supabase 연결 설정 전이에요.</p>';
} else {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
  sb.auth.getSession().then(async ({ data }) => {
    if (!data.session && !(await signInWithKey(familyKey()))) render();
  });
  sb.auth.onAuthStateChange((event, session) => {
    const user = session?.user || null;
    // 콜백 안에서 바로 supabase를 호출하면 멈출 수 있어 다음 틱으로 미룸
    if (user && state.user?.id !== user.id) setTimeout(() => onSignedIn(user), 0);
    else if (!user && event !== 'INITIAL_SESSION') {
      state.user = null;
      if (realtime) { sb.removeChannel(realtime); realtime = null; }
      render();
    }
  });
}
