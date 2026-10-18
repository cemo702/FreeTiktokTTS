/**
 * Arayuz mantigi: sekmeler, i18n, ses yonetimi (Settings), canli yorum ekrani.
 */
import { AudioEngine } from './audio-engine.js';
import { createTranslator, resolveLanguage, LANGUAGES } from '../shared/i18n.js';

const $ = (id) => document.getElementById(id);
const audio = new AudioEngine();

const state = {
  settings: null,
  comments: [],
  maxComments: 400,
  filter: 'all',
  search: '',
  historyMode: false,    // true: liste gecmis arama sonuclarini gosterir
  historyResults: [],
  historyTotal: 0,
  appVersion: null,
  speaking: new Map(),
  pendingAudio: null,
  voices: [],
  activeVoiceId: null,
  englishVoiceId: null,
  catalog: { entries: [] },
  catalogFilters: { search: '', language: '', quality: '', onlyInstalled: false },
  installing: new Map() // id -> { percent, phase, speed }
};

/* ------------------------------------------------------------------ */
/* i18n                                                                  */
/* ------------------------------------------------------------------ */
let t = createTranslator('tr');

function applyTranslations(root = document) {
  document.documentElement.lang = t.lang;
  for (const el of root.querySelectorAll('[data-i18n]')) {
    el.textContent = t(el.dataset.i18n);
  }
  for (const el of root.querySelectorAll('[data-i18n-placeholder]')) {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  }
  for (const el of root.querySelectorAll('[data-i18n-title]')) {
    el.title = t(el.dataset.i18nTitle);
  }
  document.title = t('app.title');
}

/* ------------------------------------------------------------------ */
/* ses motoru                                                            */
/* ------------------------------------------------------------------ */
audio.onStateChange = ({ limiterActive }) => {
  $('limiterBadge').classList.toggle('hidden', !limiterActive);
};

let peakHold = 0;
let peakAt = 0;
setInterval(() => {
  if (!audio.ready) return;
  const { rms, peak } = audio.level();
  const db = 20 * Math.log10(Math.max(rms, 0.0001));
  const norm = Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
  $('meterFill').style.width = `${norm}%`;
  $('meterFill').classList.toggle('hot', db > -3);

  const now = performance.now();
  if (peak >= peakHold || now - peakAt > 1200) {
    peakHold = peak;
    peakAt = now;
  }
  $('meterPeak').style.left = `${Math.min(100, peakHold * 100)}%`;
  $('meterPeak').classList.toggle('clip', peakHold >= 0.995);
}, 60);

audio.onStreamEnd = (queueId) => {
  const text = state.speaking.get(queueId);
  state.speaking.delete(queueId);
  const row = state.comments.find((c) => c.queueId === queueId);
  if (row) {
    row.status = 'spoken';
    renderComments();
  }
  $('nowPlaying').textContent = text ? t('footer.done', { text }) : t('footer.idle');
};

/* ------------------------------------------------------------------ */
/* volume: 0 - %300, ince ayar                                           */
/* ------------------------------------------------------------------ */
const volumeSlider = $('volume');
const volumeNumber = $('volumeNumber');
const MAX_VOLUME = 300;
let volumeSaveTimer = null;
let lastVolumeChangeAt = 0;

function applyVolume(percent, { save = true, fromNumber = false } = {}) {
  const value = Math.min(MAX_VOLUME, Math.max(0, Number(percent) || 0));
  audio.setVolume(value);
  volumeSlider.value = String(value);
  if (!(fromNumber && document.activeElement === volumeNumber)) volumeNumber.value = String(value);
  $('volumeDb').textContent = value <= 0 ? '−∞ dB' : `${(AudioEngine.toDb(value) >= 0 ? '+' : '')}${AudioEngine.toDb(value).toFixed(1)} dB`;
  volumeSlider.style.background = `linear-gradient(90deg, var(--accent) 0%, var(--accent) ${(value / MAX_VOLUME) * 100}%, #2a3444 ${(value / MAX_VOLUME) * 100}%, #2a3444 100%)`;
  lastVolumeChangeAt = performance.now();
  if (save) {
    clearTimeout(volumeSaveTimer);
    volumeSaveTimer = setTimeout(() => api.setSettings({ volumePercent: value }), 250);
  }
}

volumeSlider.addEventListener('input', () => applyVolume(volumeSlider.value));
volumeNumber.addEventListener('input', () => applyVolume(volumeNumber.value, { fromNumber: true }));
volumeNumber.addEventListener('change', () => applyVolume(volumeNumber.value, { fromNumber: true }));

volumeSlider.addEventListener('keydown', (event) => {
  const current = Number(volumeSlider.value);
  const step = event.shiftKey ? 0.1 : 0.5;
  const map = {
    ArrowLeft: -step, ArrowDown: -step, ArrowRight: step, ArrowUp: step,
    PageDown: -5, PageUp: 5
  };
  if (event.key in map) {
    event.preventDefault();
    applyVolume(current + map[event.key]);
  } else if (event.key === 'Home') {
    event.preventDefault();
    applyVolume(0);
  } else if (event.key === 'End') {
    event.preventDefault();
    applyVolume(MAX_VOLUME);
  }
});
volumeSlider.addEventListener('wheel', (event) => {
  event.preventDefault();
  const step = event.shiftKey ? 0.1 : 1;
  applyVolume(Number(volumeSlider.value) + (event.deltaY < 0 ? step : -step));
}, { passive: false });
volumeSlider.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  applyVolume(100);
});

/* ------------------------------------------------------------------ */
/* ayar formu <-> main                                                  */
/* ------------------------------------------------------------------ */
const TEXT_SETTINGS = ['username'];
const TEXTAREA_LISTS = ['profanityWords', 'regexRules'];
const NUMBER_SETTINGS = ['maxPerMinute', 'queueMax', 'minLength', 'minLetters', 'maxLength'];
const CHECK_SETTINGS = ['blockProfanityUsers', 'readShortComments', 'speakUsername', 'onlyTurkish', 'ignoreOwn', 'readGifts', 'queueAll', 'englishRouting', 'keepBothEngines', 'historyEnabled'];

function bindSettings() {
  // Yayinci adi: yazarken de kaydedilir (Baslat'a basmadan kapatilsa da hatirlansin)
  let usernameTimer = null;
  const saveUsername = (immediate = false) => {
    const value = ($('username').value || '').trim().replace(/^@/, '');
    clearTimeout(usernameTimer);
    if (immediate) {
      api.setSettings({ username: value });
      return;
    }
    usernameTimer = setTimeout(() => api.setSettings({ username: value }), 400);
  };
  for (const key of TEXT_SETTINGS) {
    $(key)?.addEventListener('change', () => saveUsername(true));
    $(key)?.addEventListener('input', () => saveUsername());
    $(key)?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); saveUsername(true); $(key)?.blur(); }
    });
  }
  for (const key of TEXTAREA_LISTS) {
    $(key).addEventListener('change', () => {
      api.setSettings({ [key]: $(key).value.split('\n').map((s) => s.trim()).filter(Boolean) });
    });
  }
  for (const key of NUMBER_SETTINGS) {
    $(key).addEventListener('change', () => api.setSettings({ [key]: Number($(key).value) }));
  }
  for (const key of CHECK_SETTINGS) {
    $(key).addEventListener('change', () => api.setSettings({ [key]: $(key).checked }));
  }

  // Slider yardimcisi: format sadece etiketi gunceller, kaydetme TEK sefer yapilir.
  // (Ikinci bir setSettings cagrisi eski degeri geri yazip slideri zorluyordu.)
  const slider = (id, key, format, toValue = (v) => v) => {
    $(id).addEventListener('input', () => {
      const value = Number($(id).value);
      format?.(value);
      api.setSettings({ [key]: toValue(value) });
    });
  };
  slider('lengthScale', 'lengthScale', (v) => { $('speedValue').textContent = `${v.toFixed(2)}×`; });
  slider('minGapSec', 'minGapMs', (v) => { $('gapValue').textContent = `${v.toFixed(1)} sn`; }, (v) => Math.round(v * 1000));
  slider('userCooldownSec', 'userCooldownSec', (v) => { $('cooldownValue').textContent = `${v} sn`; });
  slider('duplicateWindowSec', 'duplicateWindowSec', (v) => { $('duplicateValue').textContent = `${v} sn`; });

  $('maskToken').addEventListener('change', () => api.setSettings({ maskToken: $('maskToken').value }));
  $('blockedUsers').addEventListener('change', () => {
    api.setSettings({ blockedUsers: $('blockedUsers').value.split(/[\s,]+/).filter(Boolean) });
  });
  $('profanityFilterEnabled').addEventListener('change', (e) => {
    toggleProfanityUI(e.target.checked);
    api.setSettings({ profanityFilterEnabled: e.target.checked });
  });
  $('autoStart').addEventListener('change', (e) => {
    $('autoStartState').textContent = e.target.checked ? t('profanity.on') : t('profanity.off');
    $('autoStartState').style.color = e.target.checked ? 'var(--ok)' : 'var(--muted)';
    api.setSettings({ autoStart: e.target.checked });
  });
  $('lastUsername').addEventListener('change', () => {
    const value = $('lastUsername').value.trim().replace(/^@/, '');
    api.setSettings({ username: value });
    if ($('username') !== activeControl) $('username').value = value;
  });
  $('profanityAction').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-value]');
    if (!button) return;
    for (const b of $('profanityAction').querySelectorAll('button')) b.classList.toggle('active', b === button);
    api.setSettings({ profanityAction: button.dataset.value });
  });
  $('mentionMode').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-value]');
    if (!button) return;
    for (const b of $('mentionMode').querySelectorAll('button')) b.classList.toggle('active', b === button);
    api.setSettings({ cleanup: { ...(state.settings?.cleanup ?? {}), mentionMode: button.dataset.value } });
  });
  $('stripBrackets').addEventListener('change', () => {
    api.setSettings({ cleanup: { ...(state.settings?.cleanup ?? {}), stripBrackets: $('stripBrackets').checked } });
  });
}

function toggleProfanityUI(enabled) {
  $('profanityState').textContent = enabled ? t('profanity.on') : t('profanity.off');
  $('profanityState').style.color = enabled ? 'var(--ok)' : 'var(--muted)';
  $('profanityControls').classList.toggle('pasif', !enabled);
  for (const el of $('profanityControls').querySelectorAll('button, input, textarea')) el.disabled = !enabled;
  for (const b of $('profanityAction').querySelectorAll('button')) {
    b.classList.toggle('active', enabled && b.dataset.value === state.settings?.profanityAction);
  }
}

/** Kullanicinin su an etkilesimde oldugu alan (ayarlar yankisi bunu ezmesin). */
let activeControl = null;
function trackActiveControl() {
  const isField = (el) => el instanceof HTMLElement && el.matches('input, select, textarea');
  document.addEventListener('pointerdown', (e) => { if (isField(e.target)) activeControl = e.target; });
  document.addEventListener('pointerup', () => { setTimeout(() => { activeControl = null; }, 80); });
  document.addEventListener('focusin', (e) => { if (isField(e.target)) activeControl = e.target; });
}

/** Ayar formunu doldurur; su an kullaniciyla ugrasilan alana dokunmaz. */
function setField(id, value) {
  const el = $(id);
  if (el && el !== activeControl) el.value = value;
}

function fillSettings(settings) {
  state.settings = settings;

  for (const key of TEXT_SETTINGS) if ($(key)) setField(key, settings[key] ?? '');
  for (const key of TEXTAREA_LISTS) if ($(key)) setField(key, (settings[key] ?? []).join('\n'));
  for (const key of NUMBER_SETTINGS) if ($(key)) setField(key, String(settings[key] ?? 0));
  for (const key of CHECK_SETTINGS) if ($(key)) $(key).checked = Boolean(settings[key]);

  setField('maskToken', settings.maskToken ?? '***');
  setField('blockedUsers', (settings.blockedUsers ?? []).join(' '));
  setField('lastUsername', settings.username ?? '');
  $('autoStart').checked = settings.autoStart !== false;
  $('autoStartState').textContent = settings.autoStart !== false ? t('profanity.on') : t('profanity.off');
  $('autoStartState').style.color = settings.autoStart !== false ? 'var(--ok)' : 'var(--muted)';

  setField('lengthScale', String(settings.lengthScale ?? 1));
  $('speedValue').textContent = `${Number(settings.lengthScale ?? 1).toFixed(2)}×`;
  setField('minGapSec', String((settings.minGapMs ?? 2000) / 1000));
  $('gapValue').textContent = `${((settings.minGapMs ?? 2000) / 1000).toFixed(1)} sn`;
  setField('userCooldownSec', String(settings.userCooldownSec ?? 5));
  $('cooldownValue').textContent = `${settings.userCooldownSec ?? 5} sn`;
  setField('duplicateWindowSec', String(settings.duplicateWindowSec ?? 20));
  $('duplicateValue').textContent = `${settings.duplicateWindowSec ?? 20} sn`;

  for (const b of $('profanityAction').querySelectorAll('button')) {
    b.classList.toggle('active', b.dataset.value === settings.profanityAction);
  }
  for (const b of $('mentionMode').querySelectorAll('button')) {
    b.classList.toggle('active', b.dataset.value === (settings.cleanup?.mentionMode ?? 'read'));
  }
  $('stripBrackets').checked = settings.cleanup?.stripBrackets !== false;
  $('profanityFilterEnabled').checked = settings.profanityFilterEnabled !== false;
  toggleProfanityUI(settings.profanityFilterEnabled !== false);

  const recentlyChanged = performance.now() - lastVolumeChangeAt < 900;
  if (!recentlyChanged) applyVolume(settings.volumePercent ?? 100, { save: false });
}

/* ------------------------------------------------------------------ */
/* yorum listesi                                                        */
/* ------------------------------------------------------------------ */
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function visibleComments() {
  const term = state.search.toLowerCase();
  return state.comments.filter((c) => {
    if (state.filter === 'queued' && !['queued', 'speaking'].includes(c.status)) return false;
    if (state.filter === 'skipped' && c.status !== 'skipped') return false;
    if (state.filter === 'profanity' && !c.profanity) return false;
    if (term && !`${c.userName} ${c.text} ${c.spokenText ?? ''}`.toLowerCase().includes(term)) return false;
    return true;
  });
}

function renderComments() {
  const list = $('commentList');
  if (state.historyMode) {
    renderHistoryRows();
    return;
  }
  $('historyInfo').classList.add('hidden');
  const rows = visibleComments();
  if (!rows.length) {
    list.innerHTML = `<div class="comment skipped"><div class="what">${escapeHtml(t('comments.empty'))}</div></div>`;
    return;
  }
  list.innerHTML = rows.slice(-120).map((c) => {
    const badges = [];
    if (c.profanity) badges.push(`<span class="badge profanity">${escapeHtml(t('badge.profanity', { words: c.profanity.matched.join(', ') }))}</span>`);
    if (c.beep) badges.push(`<span class="badge beep">${escapeHtml(t('badge.beep'))}</span>`);
    if (c.status === 'queued') badges.push(`<span class="badge">${escapeHtml(t('badge.queue', { n: c.position ?? '?' }))}</span>`);
    if (c.status === 'speaking') badges.push(`<span class="badge">${escapeHtml(t('badge.speaking'))}</span>`);
    if (c.status === 'spoken') badges.push(`<span class="badge">${escapeHtml(t('badge.spoken'))}</span>`);
    if (c.status === 'skipped' && c.reason) badges.push(`<span class="badge reason">${escapeHtml(t(`reason.${c.reason}`))}</span>`);

    const actions = [];
    if (c.queueId > 0 && c.status === 'queued') {
      actions.push(`<button data-act="now" data-id="${c.queueId}">${escapeHtml(t('action.now'))}</button>`);
      actions.push(`<button data-act="drop" data-id="${c.queueId}">${escapeHtml(t('action.drop'))}</button>`);
    }
    if (c.userId) actions.push(`<button data-act="block" data-user="${escapeHtml(c.userId)}">${escapeHtml(t('action.block'))}</button>`);

    const say = c.spokenText ? `<div class="say">${escapeHtml(c.spokenText)}</div>` : '';
    return `
      <article class="comment ${c.status}">
        <div class="who">@${escapeHtml(c.userName || c.userId || 'anon')}</div>
        <div class="row-actions">${actions.join('')}</div>
        <div class="what">${escapeHtml(c.text)}</div>
        ${say}
        ${badges.length ? `<div class="badges">${badges.join('')}</div>` : ''}
      </article>`;
  }).join('');
  list.scrollTop = list.scrollHeight;
}

function addComment(comment) {
  state.comments.push(comment);
  if (state.comments.length > state.maxComments) state.comments.splice(0, state.comments.length - state.maxComments);
  renderComments();
}

/* --- gecmis arama sonuclari: salt okunur satirlar (en yeni ustte) --- */
function renderHistoryRows() {
  const list = $('commentList');
  const info = $('historyInfo');
  info.textContent = t('comments.historyResults', { n: state.historyTotal });
  info.classList.remove('hidden');
  if (!state.historyResults.length) {
    list.innerHTML = `<div class="comment skipped"><div class="what">${escapeHtml(t('comments.historyEmpty'))}</div></div>`;
    return;
  }
  const statusLabels = {
    spoken: t('metric.spoken'),
    skipped: t('metric.skipped'),
    dropped: t('metric.dropped'),
    queued: t('metric.queue')
  };
  list.innerHTML = state.historyResults.map((c) => `
    <article class="comment history ${escapeHtml(c.status)}">
      <div class="when">${escapeHtml(new Date(c.at).toLocaleString())}</div>
      <div class="who">@${escapeHtml(c.userName || c.userId || 'anon')}</div>
      <div class="what">${escapeHtml(c.text)}</div>
      ${c.spokenText && c.spokenText !== c.text ? `<div class="say">${escapeHtml(c.spokenText)}</div>` : ''}
      <div class="badges">
        <span class="badge">${escapeHtml(statusLabels[c.status] ?? String(c.status ?? ''))}</span>
        ${c.status === 'skipped' && c.reason ? `<span class="badge reason">${escapeHtml(t(`reason.${c.reason}`))}</span>` : ''}
      </div>
    </article>`).join('');
  list.scrollTop = 0;
}

function exitHistoryMode() {
  state.historyMode = false;
  state.historyResults = [];
  state.historyTotal = 0;
  $('historyInfo').classList.add('hidden');
}

/* ------------------------------------------------------------------ */
/* kuyruk listesi                                                       */
/* ------------------------------------------------------------------ */
function renderQueue(snapshot) {
  const items = snapshot.queue ?? [];
  if (!items.length) {
    $('queueList').innerHTML = `<div class="queue-item"><span class="txt" style="color:var(--muted)">${escapeHtml(t('queue.empty'))}</span></div>`;
    return;
  }
  $('queueList').innerHTML = items.slice(0, 12).map((item, index) => `
    <div class="queue-item">
      <span class="pos">${index + 1}</span>
      <span class="txt">${escapeHtml(item.text)}</span>
      <button data-act="now" data-id="${item.id}">${escapeHtml(t('action.now'))}</button>
      <button data-act="drop" data-id="${item.id}">${escapeHtml(t('action.drop'))}</button>
    </div>`).join('');
}

/* ------------------------------------------------------------------ */
/* SETTINGS: sesler + arayuz dili                                       */
/* ------------------------------------------------------------------ */
function formatSize(bytes) {
  const n = Number(bytes) || 0;
  if (!n) return '—';
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Ic durum kodlari -> i18n anahtarlari. */
const STATUS_KEYS = {
  kapali: 'status.closed',
  baglaniyor: 'status.connecting',
  canli: 'status.live',
  bekliyor: 'status.waiting',
  hata: 'status.error'
};
const statusText = (code) => t(STATUS_KEYS[code] ?? 'status.closed');

/** Izleyici sayisi henuz alinmadiysa arayuzde kisa cizgi goster. */
function renderViewerCount(value) {
  $('mViewers').textContent = typeof value === 'number' && Number.isFinite(value) ? String(value) : '—';
}

function voiceLabel(voice) {
  const name = voice.label ?? voice.catalogId ?? voice.id;
  const native = voice.language?.native ?? '';
  const english = voice.language?.english ?? '';
  const lang = t.lang === 'en' ? english : native;
  const lower = String(name).toLowerCase();
  // Etiket zaten dil adini iceriyorsa tekrar eklemeyelim
  const hasLang = [native, english].some((v) => v && lower.includes(String(v).toLowerCase()));
  return hasLang || !lang ? name : `${lang} · ${name}`;
}

function originLabel(voice) {
  if (voice.origin === 'bundled') return t('settings.originBundled');
  if (voice.catalogId?.includes('/')) return t('settings.originLocal');
  return t('settings.originUser');
}

function renderActiveVoices() {
  const select = $('activeVoice');
  const voices = state.voices;
  select.innerHTML = voices.map((v) => {
    const speakers = v.speakers?.length
      ? t('settings.speakerCount', { n: v.speakers.length })
      : t('settings.noSpeakers');
    return `<option value="${escapeHtml(v.id)}" ${v.id === state.activeVoiceId ? 'selected' : ''} ${v.valid ? '' : 'disabled'}>${escapeHtml(voiceLabel(v))} — ${speakers} · ${escapeHtml(originLabel(v))}</option>`;
  }).join('') || `<option value="">${escapeHtml(t('settings.noVoices'))}</option>`;

  const active = voices.find((v) => v.id === state.activeVoiceId);
  const speakerField = $('speakerField');
  if (active?.speakers?.length > 1) {
    speakerField.classList.remove('hidden');
    $('activeSpeaker').innerHTML = active.speakers.map((s) => {
      // Bazi modellerde konusmaci adi sadece sayi (orn. mls: "28")
      const label = /^\d+$/.test(s.name) ? t('settings.speakerN', { n: s.name }) : s.name;
      return `<option value="${s.id}" ${Number(state.settings?.speakerId ?? 0) === s.id ? 'selected' : ''}>${escapeHtml(label)}</option>`;
    }).join('');
  } else {
    speakerField.classList.add('hidden');
  }

  if (active) {
    const bits = [`${active.sampleRate ?? '?'} Hz`];
    if (active.espeakVoice) bits.push(`espeak: ${active.espeakVoice}`);
    if (active.speakers?.length) bits.push(t('settings.speakerCount', { n: active.speakers.length }));
    $('voiceStatus').textContent = `${voiceLabel(active)} · ${bits.join(' · ')}`;
  } else {
    $('voiceStatus').textContent = t('settings.noVoices');
  }
  updateVoiceChip(active);
}

function updateVoiceChip(active) {
  const chip = $('voiceChip');
  if (!active) {
    chip.textContent = t('settings.noVoices');
    chip.classList.add('muted');
    return;
  }
  const lang = t.lang === 'en' ? (active.language?.english ?? '') : (active.language?.native ?? '');
  chip.textContent = `🎙 ${lang || active.id} · ${active.sampleRate ?? '?'} Hz`;
}

function renderCatalog() {
  const { search, language, quality, onlyInstalled } = state.catalogFilters;
  const term = search.trim().toLowerCase();
  const entries = state.catalog.entries.filter((e) => {
    if (onlyInstalled && !e.installed) return false;
    if (language && e.language.code !== language) return false;
    if (quality && e.quality !== quality) return false;
    if (!term) return true;
    return `${e.id} ${e.name} ${e.language.native} ${e.language.english} ${e.language.code}`
      .toLowerCase().includes(term);
  });

  const list = $('catalogList');
  if (!entries.length) {
    list.innerHTML = `<div class="catalog-empty">${escapeHtml(t('settings.emptyCatalog'))}</div>`;
    return;
  }

  list.innerHTML = entries.slice(0, 200).map((e) => {
    const progress = state.installing.get(e.id);
    const speakers = e.numSpeakers > 1 ? t('settings.speakerCount', { n: e.numSpeakers }) : t('settings.noSpeakers');
    const langName = t.lang === 'en' ? e.language.english : e.language.native;
    const buttons = [];
    if (progress) {
      buttons.push(`<button data-act="cancel" data-id="${escapeHtml(e.id)}">${escapeHtml(t('btn.cancel'))}</button>`);
    } else if (e.installed) {
      buttons.push(`<button data-act="preview" data-id="${escapeHtml(e.id)}">${escapeHtml(t('btn.preview'))}</button>`);
      if (e.id !== state.activeVoiceId) buttons.push(`<button data-act="use" data-id="${escapeHtml(e.id)}">${escapeHtml(t('btn.use'))}</button>`);
    } else {
      buttons.push(`<button data-act="install" data-id="${escapeHtml(e.id)}">${escapeHtml(t('btn.install'))}</button>`);
    }
    const bar = progress
      ? `<div class="dl"><div class="dl-fill" style="width:${Math.round(progress.percent ?? 0)}%"></div></div>`
      : '';

    return `
      <div class="catalog-row">
        <div class="voice-name">${escapeHtml(langName)} · ${escapeHtml(e.name)}</div>
        <div class="voice-meta">
          <span class="pill">${escapeHtml(e.quality)}</span>
          <span>${escapeHtml(formatSize(e.sizeBytes))}</span>
          <span>${escapeHtml(speakers)}</span>
          ${e.installed ? `<span class="pill ok">${escapeHtml(t('settings.installed'))}</span>` : ''}
        </div>
        <div class="voice-buttons">${buttons.join('')}</div>
        ${bar}
      </div>`;
  }).join('');
}

function renderLanguageOptions() {
  const select = $('uiLanguage');
  const systemLang = resolveLanguage('system');
  const systemName = LANGUAGES.find((l) => l.code === systemLang)?.label ?? systemLang;
  const options = [
    { value: 'tr', label: t('settings.language.tr') },
    { value: 'en', label: t('settings.language.en') },
    { value: 'system', label: t('settings.language.system', { lang: systemName }) }
  ];
  const current = state.settings?.uiLanguage ?? 'tr';
  select.innerHTML = options.map((o) => `<option value="${o.value}" ${o.value === current ? 'selected' : ''}>${escapeHtml(o.label)}</option>`).join('');
}

function renderCatalogFilters() {
  const entries = state.catalog.entries;
  const languages = new Map();
  for (const e of entries) {
    if (!languages.has(e.language.code)) {
      languages.set(e.language.code, t.lang === 'en' ? e.language.english : e.language.native);
    }
  }
  const langSelect = $('voiceLanguage');
  langSelect.innerHTML = `<option value="">${escapeHtml(t('settings.allLanguages'))}</option>`
    + [...languages.entries()].sort((a, b) => a[1].localeCompare(b[1]))
      .map(([code, name]) => `<option value="${code}" ${code === state.catalogFilters.language ? 'selected' : ''}>${escapeHtml(name)}</option>`).join('');

  const qualities = [...new Set(entries.map((e) => e.quality))].sort();
  const qSelect = $('voiceQuality');
  qSelect.innerHTML = `<option value="">${escapeHtml(t('settings.allQualities'))}</option>`
    + qualities.map((q) => `<option value="${q}" ${q === state.catalogFilters.quality ? 'selected' : ''}>${q}</option>`).join('');

  const unique = languages.size;
  $('catalogInfo').textContent = t('settings.catalogInfo', { count: entries.length, languages: unique });
}

/* ------------------------------------------------------------------ */
/* main olaylari                                                        */
/* ------------------------------------------------------------------ */
function playPayload(payload) {
  try {
    const bytes = payload.pcm instanceof Uint8Array ? payload.pcm : new Uint8Array(payload.pcm);
    audio.createStream(payload.queueId, payload.sampleRate);
    audio.current.push(bytes);
    audio.current.finish();
    if (payload.queueId === -1) setLog(t('log.testPlayed', { seconds: payload.durationSec.toFixed(2) }), 'ok');
    if (payload.voiceLabel) setLog(`${payload.voiceLabel}: ${payload.durationSec.toFixed(2)} sn`, 'ok');
  } catch (err) {
    setLog(t('log.playError', { message: err.message }), 'error');
  }
}

function wireMainEvents() {
  api.onCommentQueued((c) => addComment({
    id: c.id, queueId: c.queueId, userId: c.userId, userName: c.userName, text: c.text,
    spokenText: c.spokenText, status: 'queued', position: c.position, profanity: c.profanity, beep: c.beep
  }));

  api.onCommentSkipped((c) => addComment({
    id: c.id, userId: c.userId, userName: c.userName, text: c.text,
    status: 'skipped', reason: c.reason, profanity: c.profanity
  }));

  api.onSpeechStart((e) => {
    const row = state.comments.find((c) => c.queueId === e.queueId);
    if (row) row.status = 'speaking';
    state.speaking.set(e.queueId, e.text);
    $('nowPlaying').textContent = t('footer.speaking', { text: e.text });
    renderComments();
  });

  api.onSpeechSkipped((e) => {
    state.speaking.delete(e.queueId);
    const row = state.comments.find((c) => c.queueId === e.queueId);
    if (row) row.status = 'skipped';
    $('nowPlaying').textContent = t('footer.idle');
    renderComments();
  });

  api.onSpeechError((e) => setLog(t('log.speechError', { message: e.message }), 'error'));

  api.onSpeechAudio((payload) => {
    if (!audio.ready) {
      state.pendingAudio = { payload, at: Date.now() };
      return;
    }
    playPayload(payload);
  });

  api.onStatus((status) => {
    state.sourceStatus = status.status;
    const badge = $('statusBadge');
    badge.className = `status ${status.status}`;
    $('statusText').textContent = statusText(status.status);
    renderViewerCount(status.viewerCount);
    $('btnStart').disabled = status.status === 'canli' || status.status === 'baglaniyor';
    $('btnStop').disabled = status.status === 'kapali';
  });

  api.onStats((snapshot) => {
    state.snapshot = snapshot;
    const s = snapshot.stats;
    $('mSpoken').textContent = s.spoken;
    $('mSkipped').textContent = s.skipped;
    $('mDropped').textContent = s.dropped ?? 0;
    $('mQueue').textContent = snapshot.queueLength;
    $('mLatency').textContent = s.lastLatencyMs === null ? '–' : `${s.lastLatencyMs} ms`;
    $('mSynth').textContent = s.avgSynthMs === null || s.avgSynthMs === undefined ? '–' : `${s.avgSynthMs} ms`;
    renderQueue(snapshot);
  });

  api.onLog((entry) => setLog(entry.message, entry.level === 'error' ? 'error' : 'info'));
  api.onSettings((settings) => {
    const dilDegisti = settings.uiLanguage !== state.settings?.uiLanguage;
    state.settings = settings;
    if (dilDegisti) {
      t = createTranslator(resolveLanguage(settings.uiLanguage));
      relocalize();
    } else {
      fillSettings(settings);
      renderLanguageOptions();
    }
  });

  api.onEngine((info) => {
    const el = $('engineState');
    $('btnTest').disabled = !info.ready;
    if (info.ready) {
      el.textContent = t('engine.ready', { rate: info.sampleRate });
      el.className = 'subtitle ok';
    } else {
      el.textContent = `${t('engine.notReady')}${info.error ? `: ${info.error}` : ''}`;
      el.className = 'subtitle error';
    }
  });

  api.onVoiceProgress((p) => {
    if (p.phase === 'done') {
      state.installing.delete(p.id);
      renderCatalog();
      return;
    }
    if (p.phase === 'cancelled') {
      state.installing.delete(p.id);
      renderCatalog();
      return;
    }
    state.installing.set(p.id, { percent: p.percent ?? 0, phase: p.phase, speed: p.bytesPerSec ?? 0 });
    renderCatalog();
  });

  api.onVoicesChanged(() => refreshVoices());
}

async function refreshVoices() {
  const result = await api.getVoices();
  state.voices = result.voices ?? [];
  state.activeVoiceId = result.activeId ?? state.activeVoiceId;
  state.englishVoiceId = result.englishId ?? state.englishVoiceId;
  renderActiveVoices();
  renderEnglishVoice();
  if (state.catalog.entries.length) renderCatalog();
}

/** Ingilizce motor icin ses secimi (kurulu seslerden en-ailesi + digerleri). */
function englishCandidates() {
  const voices = (state.voices ?? []).filter((v) => v.valid);
  const en = voices.filter((v) => v.language?.family === 'en' || String(v.espeakVoice ?? '').toLowerCase().startsWith('en'));
  const rest = voices.filter((v) => !en.includes(v));
  return [...en, ...rest];
}

function renderEnglishVoice() {
  const select = $('englishVoice');
  const candidates = englishCandidates();
  select.innerHTML = candidates.map((v) => (
    `<option value="${escapeHtml(v.id)}" ${v.id === state.englishVoiceId ? 'selected' : ''}>${escapeHtml(voiceLabel(v))}</option>`
  )).join('') || `<option value="">${escapeHtml(t('settings.noEnglishVoice'))}</option>`;
  const current = candidates.find((v) => v.id === state.englishVoiceId);
  $('englishVoiceStatus').textContent = current
    ? `${voiceLabel(current)} · ${current.sampleRate ?? '?'} Hz`
    : t('settings.noEnglishVoice');
}

async function loadCatalog({ refresh = false } = {}) {
  $('catalogInfo').textContent = t('settings.catalogInfo', { count: '…', languages: '…' });
  const result = await api.getCatalog(refresh);
  state.catalog.entries = result.entries ?? [];
  if (state.catalog.entries.length) {
    renderCatalogFilters();
    renderCatalog();
  } else {
    $('catalogInfo').textContent = result.error ?? t('settings.emptyCatalog');
    $('catalogList').innerHTML = `<div class="catalog-empty">${escapeHtml(result.error ?? '')}</div>`;
  }
}

/* ------------------------------------------------------------------ */
/* butonlar / klavye / sekmeler                                          */
/* ------------------------------------------------------------------ */
function switchTab(name) {
  for (const btn of document.querySelectorAll('.tab-btn')) btn.classList.toggle('active', btn.dataset.tab === name);
  for (const panel of document.querySelectorAll('.tab-panel')) panel.classList.toggle('active', panel.id === `tab-${name}`);
}

function wireControls() {
  for (const btn of document.querySelectorAll('.tab-btn')) {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  }
  $('voiceChip').addEventListener('click', () => switchTab('settings'));

  $('btnStart').addEventListener('click', async () => {
    await audio.init();
    const username = $('username').value.trim();
    if (!username) {
      setLog(t('log.enterStreamer'), 'error');
      return;
    }
    setLog(t('log.connecting', { user: username }));
    const result = await api.start(username);
    if (!result.ok) setLog(result.error ?? t('log.connectFailed'), 'error');
  });

  $('btnStop').addEventListener('click', async () => {
    audio.stopCurrent();
    await api.stop();
    setLog(t('log.stopped'));
  });

  $('btnTest').addEventListener('click', async () => {
    await audio.init();
    try {
      const result = await api.speakTest($('testText').value);
      if (result && result.ok === false) setLog(result.error ?? t('log.engineNotReady'), 'error');
    } catch (err) {
      setLog(err.message, 'error');
    }
  });

  $('btnSkip').addEventListener('click', async () => {
    audio.stopCurrent();
    await api.skipCurrent();
  });

  $('btnClear').addEventListener('click', async () => {
    const { removed } = await api.clearQueue();
    setLog(t('log.queueCleared', { n: removed }));
  });

  $('btnSimulate').addEventListener('click', async () => {
    await audio.init();
    await api.simulate(10);
    setLog(t('log.simulated'));
  });

  $('filterState').addEventListener('change', (e) => {
    state.filter = e.target.value;
    if (state.historyMode) exitHistoryMode();
    renderComments();
  });
  $('filterInput').addEventListener('input', (e) => {
    state.search = e.target.value;
    const query = state.search.trim();
    $('btnHistorySearch').classList.toggle('hidden', query.length < 2);
    if (query.length < 2 && state.historyMode) exitHistoryMode();
    renderComments();
  });
  $('btnHistorySearch').addEventListener('click', async () => {
    const query = state.search.trim();
    if (query.length < 2) return;
    const result = await api.searchHistory(query);
    if (!result?.ok) return;
    state.historyMode = true;
    state.historyResults = result.entries ?? [];
    state.historyTotal = result.total ?? 0;
    renderComments();
  });

  $('btnClearHistory').addEventListener('click', async () => {
    await api.clearHistory();
    setLog(t('log.historyCleared'));
    exitHistoryMode();
    renderComments();
  });

  /* --- Hakkında / otomatik guncelleme --- */
  $('btnSource').addEventListener('click', () => api.openExternal('https://github.com/cemo702/FreeTiktokTTS'));
  $('btnDonatePaypal').addEventListener('click', () => api.openExternal('https://www.paypal.com/donate/?hosted_button_id=L5CEV9BV2EBUG'));
  $('btnDonateBmc').addEventListener('click', () => api.openExternal('https://buymeacoffee.com/cemo7028'));
  $('btnCheckUpdate').addEventListener('click', async () => {
    setUpdateStatus({ state: 'checking' });
    setUpdateStatus(await api.checkUpdates());
  });
  $('btnRestartUpdate').addEventListener('click', () => api.restartForUpdate());
  api.onUpdate((info) => setUpdateStatus(info));

  /* --- sesler --- */
  $('activeVoice').addEventListener('change', async (e) => {
    const id = e.target.value;
    if (!id) return; // gecersiz/boş secim
    const result = await api.setActiveVoice(id);
    if (!result.ok) setLog(result.error ?? '', 'error');
    else state.activeVoiceId = id;
    await refreshVoices();
  });
  $('activeSpeaker').addEventListener('change', (e) => api.setSettings({ speakerId: Number(e.target.value) }));

  $('btnImportVoice').addEventListener('click', async () => {
    await audio.init();
    const result = await api.importVoice();
    if (result.ok) await refreshVoices();
  });
  $('btnPreviewVoice').addEventListener('click', async () => {
    await audio.init();
    const result = await api.previewVoice(state.activeVoiceId);
    if (!result?.ok && result?.error) setLog(result.error, 'error');
  });
  $('englishVoice').addEventListener('change', async (e) => {
    const id = e.target.value;
    if (!id) return;
    const result = await api.setEnglishVoice(id);
    if (!result.ok) setLog(result.error ?? '', 'error');
    else state.englishVoiceId = id;
    await refreshVoices();
  });
  $('btnPreviewEnglish').addEventListener('click', async () => {
    await audio.init();
    const result = await api.previewEnglishVoice(state.englishVoiceId || null);
    if (!result?.ok && result?.error) setLog(result.error, 'error');
  });
  $('btnInstallEnglish').addEventListener('click', async () => {
    state.installing.set('en_US-lessac-medium', { percent: 0 });
    renderCatalog();
    const result = await api.installVoice('en_US-lessac-medium');
    state.installing.delete('en_US-lessac-medium');
    if (!result.ok && !result.cancelled) setLog(result.error ?? '', 'error');
    if (result.ok) await api.setEnglishVoice(result.voice.id);
    await refreshVoices();
    renderCatalog();
  });
  $('btnRefreshCatalog').addEventListener('click', () => loadCatalog({ refresh: true }));

  $('voiceSearch').addEventListener('input', (e) => {
    state.catalogFilters.search = e.target.value;
    renderCatalog();
  });
  $('voiceLanguage').addEventListener('change', (e) => { state.catalogFilters.language = e.target.value; renderCatalog(); });
  $('voiceQuality').addEventListener('change', (e) => { state.catalogFilters.quality = e.target.value; renderCatalog(); });
  $('voiceOnlyInstalled').addEventListener('change', (e) => { state.catalogFilters.onlyInstalled = e.target.checked; renderCatalog(); });

  $('catalogList').addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-act]');
    if (!button) return;
    const { act, id } = button.dataset;
    if (act === 'install') {
      state.installing.set(id, { percent: 0 });
      renderCatalog();
      const result = await api.installVoice(id);
      state.installing.delete(id);
      if (result.ok) await refreshVoices();
      renderCatalog();
    } else if (act === 'cancel') {
      await api.cancelVoice(id);
    } else if (act === 'use') {
      const result = await api.setActiveVoice(id);
      if (result.ok) state.activeVoiceId = id;
      await refreshVoices();
    } else if (act === 'preview') {
      await audio.init();
      await api.previewVoice(id);
    }
  });

  $('uiLanguage').addEventListener('change', async (e) => {
    await api.setSettings({ uiLanguage: e.target.value });
  });

  // satir ici butonlar (olay delegasyonu) — yorum listesi + kuyruk
  document.addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-act]');
    if (!button || button.closest('#catalogList')) return;
    const { act, id, user } = button.dataset;
    if (act === 'now') await api.speakNow(Number(id));
    if (act === 'drop') {
      await api.removeQueued(Number(id));
      const row = state.comments.find((c) => c.queueId === Number(id));
      if (row) row.status = 'skipped';
      renderComments();
    }
    if (act === 'block') {
      await api.blockUser(user);
      setLog(t('log.blocked', { user }));
    }
  });

  document.addEventListener('keydown', (event) => {
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (event.code === 'Space') {
      event.preventDefault();
      api.skipCurrent();
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      applyVolume(Math.min(MAX_VOLUME, Number($('volume').value) + 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      applyVolume(Math.max(0, Number($('volume').value) - 1));
    }
  });
}

function setLog(message, level = 'info') {
  const el = $('logLine');
  el.textContent = message;
  el.className = `log-line ${level === 'error' ? 'error' : level === 'ok' ? 'ok' : ''}`;
}

/** Guncelleme durumu metnini ve "yeniden baslat" dugmesini senkronlar. */
const UPDATE_LABELS = {
  checking: 'about.updateChecking',
  latest: 'about.updateLatest',
  dev: 'about.updateDev',
  downloading: 'about.updateDownloading',
  ready: 'about.updateReady',
  error: 'about.updateError'
};

function setUpdateStatus(info) {
  const el = $('updateStatus');
  const btn = $('btnRestartUpdate');
  const key = UPDATE_LABELS[info?.state] ?? 'about.updateError';
  el.textContent = t(key, { percent: info?.percent ?? 0, version: info?.version ?? '' });
  btn.classList.toggle('hidden', info?.state !== 'ready');
}

/** Dil degistiginde tum ekrani (statik + dinamik) yeniden cevirir. */
function relocalize() {
  applyTranslations();
  if (state.settings) fillSettings(state.settings);
  renderLanguageOptions();
  renderActiveVoices();
  renderEnglishVoice();
  if (state.catalog.entries.length) {
    renderCatalogFilters();
    renderCatalog();
  }
  renderComments();
  renderQueue(state.snapshot ?? { queue: [] });
  if (state.appVersion) $('aboutVersion').textContent = t('about.versionLabel', { version: state.appVersion });
  if (state.sourceStatus) {
    $('statusText').textContent = statusText(state.sourceStatus);
  }
}

/* ------------------------------------------------------------------ */
/* baslat                                                                */
/* ------------------------------------------------------------------ */
async function boot() {
  const state0 = await api.getState();

  t = createTranslator(resolveLanguage(state0.settings.uiLanguage));
  applyTranslations();

  // Motor durumu: acilista butonu senkronla (motor olayi pencere acilmadan gitmis olabilir)
  $('btnTest').disabled = !state0.engine?.ready;

  wireControls();
  trackActiveControl();
  bindSettings();
  wireMainEvents();
  fillSettings(state0.settings);
  renderComments();
  renderLanguageOptions();
  window.__tts = { audio, state, api, t: () => t };

  if (state0.source?.status) {
    state.sourceStatus = state0.source.status;
    $('statusText').textContent = statusText(state0.source.status);
    $('statusBadge').className = `status ${state0.source.status}`;
    renderViewerCount(state0.source.viewerCount);
  }
  renderQueue(state0.snapshot ?? { queue: [] });
  state.appVersion = state0.version ?? null;
  $('aboutVersion').textContent = t('about.versionLabel', { version: state.appVersion ?? '?' });

  state.voices = state0.voices ?? [];
  state.activeVoiceId = state0.activeVoiceId ?? null;
  renderActiveVoices();
  renderEnglishVoice();

  await refreshVoices();
  loadCatalog();

  /**
   * Ses motorunu ETKILESIM BEKLEMEDEN kur (main'de autoplay-policy anahtari
   * ayarli). Baglanilan yayindan gelen ilk yorum aninda okunur.
   */
  const initAudio = async () => {
    await audio.init();
    applyVolume(state.settings?.volumePercent ?? 100, { save: false });
    if (state.pendingAudio) {
      const pending = state.pendingAudio;
      state.pendingAudio = null;
      if (Date.now() - pending.at < 30_000) playPayload(pending.payload);
    }
  };
  await initAudio();
  if (!audio.ready || audio.ctx?.state !== 'running') {
    document.addEventListener('click', initAudio, { once: true });
    document.addEventListener('keydown', initAudio, { once: true });
  }
  setInterval(() => {
    if (audio.ctx?.state === 'suspended') audio.resume().catch(() => {});
  }, 2_000);
}

boot();