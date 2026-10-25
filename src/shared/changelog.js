/**
 * Surum gecmisi: Hakkinda sekmesinde gosterilir (en yeniden eskiye).
 *
 * Yeni surum cikarken bu listenin EN USTUNE bir girdi eklenir.
 * test/changelog.test.js, en ust girdinin surumunu package.json surumuyle
 * eslesmeye zorlar: surumu artirip changelog girdisi eklemeyi unutursan
 * test patlar.
 *
 * Girdi bicimi:
 *   { version: 'x.y.z', date: 'YYYY-MM-DD', tr: ['madde', ...], en: ['item', ...] }
 */
export const CHANGELOG = [
  {
    version: '1.3.1',
    date: '2026-10-25',
    tr: [
      'Sürüm geçmişi sağ kolona taşındı: artık Güncellemeler kartının içinde, güncelleme durumunun altında listeleniyor; uzayan geçmiş kartın içinde kayıyor'
    ],
    en: [
      'Version history moved to the right column: now listed inside the Updates card below the update status; long histories scroll within the card'
    ]
  },
  {
    version: '1.3.0',
    date: '2026-10-24',
    tr: [
      'Hakkında sekmesinde sürüm geçmişi (changelog) eklendi',
      'Hakkında: Güncellemeler kartı sağda panelin dibine kadar uzuyor; Hakkında kartı bağış bölümünün altına taşındı',
      'Settings: Ses yönetimi kartı boy olarak kısaltıldı; Arayüz/Interface bölümü sol kolonda ses yönetiminin altına alındı; Piper kataloğu sağ kolonu dolduruyor'
    ],
    en: [
      'Added version history (changelog) in the About tab',
      'About: Updates card now stretches to the bottom on the right; About card moved below the donation section',
      'Settings: Voice manager card compacted; Interface section moved below it in the left column; Piper catalog fills the right column'
    ]
  },
  {
    version: '1.2.3',
    date: '2026-10-24',
    tr: [
      'Yayın kapanınca eski yorumların tekrar okunması giderildi',
      'Yorumlar TikTok mesaj numarasına göre tekilleştiriliyor (yeniden bağlanmada gelen tekrar paketleri okunmaz)',
      'Yayın bitince birikmiş kuyruk temizlenir, "Durdur" kuyruğu boşaltır',
      'Yeniden bağlanma denemeleri arasında eski bağlantılar düzgün kapatılıyor (hayalet olaylar bitti)'
    ],
    en: [
      'Fixed old comments being re-read after the live stream ended',
      'Comments are deduplicated by TikTok message ID (replayed packets on reconnect are ignored)',
      'Pending queue is cleared when the stream ends; "Stop" also clears the queue',
      'Old connections are properly closed between reconnect attempts (no more ghost events)'
    ]
  },
  {
    version: '1.2.2',
    date: '2026-10-23',
    tr: [
      'Settings ve Hakkında sekmelerinde sağdaki ölü boşluk kaldırıldı (iki kolonlu kart yerleşimi)'
    ],
    en: [
      'Removed the dead space on the right of the Settings and About tabs (two-column card grid)'
    ]
  },
  {
    version: '1.2.1',
    date: '2026-10-19',
    tr: [
      'Hakkında, Settings sekmesinden ayrı kendi sekmesi oldu',
      'Büyük bağış butonları: Buy me a coffee ve PayPal'
    ],
    en: [
      'About became its own tab, separate from Settings',
      'Large donation buttons: Buy me a coffee and PayPal'
    ]
  },
  {
    version: '1.2.0',
    date: '2026-10-19',
    tr: [
      'Açık kaynak ilk sürüm (AGPL-3.0 lisansı)',
      'Otomatik güncelleme: yeni sürümler uygulama içinden kurulur',
      'Türkçe ve İngilizce README, Hakkında kartı'
    ],
    en: [
      'First open-source release (AGPL-3.0 license)',
      'Automatic updates: new versions install from within the app',
      'Turkish and English README, About card'
    ]
  }
];

export default CHANGELOG;
