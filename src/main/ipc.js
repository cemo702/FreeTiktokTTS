/**
 * IPC kanal sabitleri (main <-> preload <-> renderer).
 * Tek kaynak: iki tarafta da ayni isimler kullanilir.
 */
export const IPC = {
  // renderer -> main (invoke)
  GET_STATE: 'app:get-state',
  GET_SETTINGS: 'settings:get',
  SET_SETTINGS: 'settings:set',
  START: 'source:start',
  STOP: 'source:stop',
  SPEAK_TEST: 'tts:speak-test',
  QUEUE_SKIP: 'queue:skip-current',
  QUEUE_CLEAR: 'queue:clear',
  QUEUE_REMOVE: 'queue:remove',
  QUEUE_SPEAK_NOW: 'queue:speak-now',
  BLOCK_USER: 'users:block',
  UNBLOCK_USER: 'users:unblock',
  SIMULATE: 'dev:simulate',
  OPEN_EXTERNAL: 'shell:open-external',
  CHECK_ENGINE: 'tts:check',

  // Yorum gecmisi (kalici saklama + arama)
  HISTORY_SEARCH: 'history:search',
  HISTORY_CLEAR: 'history:clear',

  // Otomatik guncelleme (electron-updater)
  UPDATE_CHECK: 'update:check',
  UPDATE_RESTART: 'update:restart',

  // Ses yonetimi (Settings sekmesi)
  VOICE_INSTALLED: 'voice:installed',
  VOICE_CATALOG: 'voice:catalog',
  VOICE_INSTALL: 'voice:install',
  VOICE_CANCEL: 'voice:cancel',
  VOICE_REMOVE: 'voice:remove',
  VOICE_IMPORT: 'voice:import',
  VOICE_SET_ACTIVE: 'voice:set-active',
  VOICE_PREVIEW: 'voice:preview',
  VOICE_SET_ENGLISH: 'voice:set-english',
  VOICE_PREVIEW_ENGLISH: 'voice:preview-english',
  VOICE_PATHS: 'voice:paths',

  // main -> renderer (send)
  EVT_COMMENT: 'evt:comment',
  EVT_COMMENT_SKIPPED: 'evt:comment-skipped',
  EVT_COMMENT_QUEUED: 'evt:comment-queued',
  EVT_SPEECH_START: 'evt:speech-start',
  EVT_SPEECH_AUDIO: 'evt:speech-audio',
  EVT_SPEECH_SKIPPED: 'evt:speech-skipped',
  EVT_SPEECH_ERROR: 'evt:speech-error',
  EVT_QUEUE_CLEARED: 'evt:queue-cleared',
  EVT_STATUS: 'evt:status',
  EVT_ENGINE: 'evt:engine',
  EVT_STATS: 'evt:stats',
  EVT_LOG: 'evt:log',
  EVT_SETTINGS: 'evt:settings',
  EVT_UPDATE: 'evt:update',
  EVT_VOICE_PROGRESS: 'evt:voice-progress',
  EVT_VOICES_CHANGED: 'evt:voices-changed'
};

export default IPC;