/**
 * TTS motor hazirlik bekleme yardimcisi (test edilebilir, electron'suz).
 *
 * Amaclar:
 *  - "erken tiklama": motor henuz basliyorsa (ilk ~2 sn) hazir olana kadar bekle
 *  - "kesin basarisizlik": baslatma hatasi belli olursa zaman kaybetmeden don
 */
export async function waitForEngine({ isReady, isFailed }, { timeoutMs = 20_000, pollMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (isReady()) return true;
    if (typeof isFailed === 'function' && isFailed()) return false;
    if (Date.now() >= deadline) return Boolean(isReady());
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

export default waitForEngine;
