/**
 * Preload: renderer'a guvenli API sunar (contextBridge).
 * Kanal isimleri src/main/ipc.js ile tek kaynaktan gelir (drift olmaz).
 */
import { contextBridge, ipcRenderer } from 'electron';
import IPC from '../main/ipc.js';

const on = (channel) => (handler) => {
  const listener = (_event, payload) => handler(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('api', {
  getState: () => ipcRenderer.invoke(IPC.GET_STATE),
  getSettings: () => ipcRenderer.invoke(IPC.GET_SETTINGS),
  setSettings: (patch) => ipcRenderer.invoke(IPC.SET_SETTINGS, patch),

  start: (username) => ipcRenderer.invoke(IPC.START, username),
  stop: () => ipcRenderer.invoke(IPC.STOP),
  speakTest: (text) => ipcRenderer.invoke(IPC.SPEAK_TEST, text),

  skipCurrent: () => ipcRenderer.invoke(IPC.QUEUE_SKIP),
  clearQueue: () => ipcRenderer.invoke(IPC.QUEUE_CLEAR),
  removeQueued: (queueId) => ipcRenderer.invoke(IPC.QUEUE_REMOVE, queueId),
  speakNow: (queueId) => ipcRenderer.invoke(IPC.QUEUE_SPEAK_NOW, queueId),

  blockUser: (userId) => ipcRenderer.invoke(IPC.BLOCK_USER, userId),
  unblockUser: (userId) => ipcRenderer.invoke(IPC.UNBLOCK_USER, userId),
  simulate: (count) => ipcRenderer.invoke(IPC.SIMULATE, count),
  checkEngine: () => ipcRenderer.invoke(IPC.CHECK_ENGINE),
  openExternal: (url) => ipcRenderer.invoke(IPC.OPEN_EXTERNAL, url),

  // Yorum gecmisi
  searchHistory: (query) => ipcRenderer.invoke(IPC.HISTORY_SEARCH, query),
  clearHistory: () => ipcRenderer.invoke(IPC.HISTORY_CLEAR),

  // Otomatik guncelleme
  checkUpdates: () => ipcRenderer.invoke(IPC.UPDATE_CHECK),
  restartForUpdate: () => ipcRenderer.invoke(IPC.UPDATE_RESTART),
  onUpdate: on(IPC.EVT_UPDATE),

  // Ses yonetimi
  getVoices: () => ipcRenderer.invoke(IPC.VOICE_INSTALLED),
  getCatalog: (refresh) => ipcRenderer.invoke(IPC.VOICE_CATALOG, refresh),
  installVoice: (id) => ipcRenderer.invoke(IPC.VOICE_INSTALL, id),
  cancelVoice: (id) => ipcRenderer.invoke(IPC.VOICE_CANCEL, id),
  removeVoice: (id) => ipcRenderer.invoke(IPC.VOICE_REMOVE, id),
  importVoice: () => ipcRenderer.invoke(IPC.VOICE_IMPORT),
  setActiveVoice: (id) => ipcRenderer.invoke(IPC.VOICE_SET_ACTIVE, id),
  previewVoice: (id) => ipcRenderer.invoke(IPC.VOICE_PREVIEW, id),
  setEnglishVoice: (id) => ipcRenderer.invoke(IPC.VOICE_SET_ENGLISH, id),
  previewEnglishVoice: (id) => ipcRenderer.invoke(IPC.VOICE_PREVIEW_ENGLISH, id),
  getPaths: () => ipcRenderer.invoke(IPC.VOICE_PATHS),
  onVoiceProgress: on(IPC.EVT_VOICE_PROGRESS),
  onVoicesChanged: on(IPC.EVT_VOICES_CHANGED),

  onCommentQueued: on(IPC.EVT_COMMENT_QUEUED),
  onCommentSkipped: on(IPC.EVT_COMMENT_SKIPPED),
  onSpeechStart: on(IPC.EVT_SPEECH_START),
  onSpeechAudio: on(IPC.EVT_SPEECH_AUDIO),
  onSpeechSkipped: on(IPC.EVT_SPEECH_SKIPPED),
  onSpeechError: on(IPC.EVT_SPEECH_ERROR),
  onQueueCleared: on(IPC.EVT_QUEUE_CLEARED),
  onStatus: on(IPC.EVT_STATUS),
  onEngine: on(IPC.EVT_ENGINE),
  onStats: on(IPC.EVT_STATS),
  onLog: on(IPC.EVT_LOG),
  onSettings: on(IPC.EVT_SETTINGS)
});