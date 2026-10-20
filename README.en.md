# FreeTiktokTTS

[Türkçe](README.md) | **English**

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL%20v3-blue.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/release/cemo702/FreeTiktokTTS?include_prereleases)](https://github.com/cemo702/FreeTiktokTTS/releases)
[![Buy me a coffee](https://img.shields.io/badge/Buy%20me%20a%20coffee-FF813F?logo=buy-me-a-coffee&logoColor=white)](https://buymeacoffee.com/cemo7028)

**A free desktop app that reads TikTok live stream comments aloud with a neural voice (Piper TTS) running entirely on your own computer. No cloud speech service is used — comment text never leaves your machine.**

<p align="center">
  <img src="docs/screenshots/main.png" alt="FreeTiktokTTS main screen — live comments in the queue, speech in progress" width="820">
</p>

## Screenshots

| Settings — voices, filters, history | About — updates & support |
|:---:|:---:|
| ![Settings tab — voices, filters and history settings](docs/screenshots/settings.png) | ![About tab — version, update and donate buttons](docs/screenshots/about.png) |

> Comments shown in the screenshots are demo data.

## Features

- 🔊 **Local TTS** — the [Piper](https://github.com/OHF-Voice/piper1-gpl) engine runs fully offline; every comment is voiced instantly — as fast as cloud services, but your audio never leaves your computer
- 🌍 **Automatic language detection** — comments starting with an English word or containing 2+ English words are read with the English voice; everything else is read in Turkish. Both engines stay warm side by side
- 🎁 **Event support** — gifts, subscribes and likes can be announced
- 🧹 **Advanced filters** — profanity masking (mask/\*\*\*/beep/skip), spam & repeat protection, per-user cooldown, blocklist/allowlist, regex rules, link/tag cleanup
- 📋 **Queue control** — ordered reading with adjustable pacing gaps, "read now" / "skip" buttons
- 💾 **Persistent comment history** — every comment (read and skipped, with reasons) is written to disk and searchable afterwards, with diacritics-insensitive search
- 🗣️ **Voice catalog** — dozens of Piper voices downloadable from Hugging Face; a separate voice can be picked for English
- 🔄 **Auto-update** — the app checks GitHub on launch and installs new releases on restart
- 🪶 **Lightweight** — UI + engine use ~500 MB of RAM; history runs off disk

## Install

1. Download the latest `FreeTiktokTTS-Setup-x.y.z.exe` from [**Releases**](https://github.com/cemo702/FreeTiktokTTS/releases)
2. Run the installer (per-user install, no admin rights required)
3. Open the app, type your TikTok username (without @) into **Publisher**, press **Start**

> Windows may show a SmartScreen warning on first run (unsigned installer): click **"More info" → "Run anyway"**. The app is open source — you can also [build it yourself](#building-for-developers).

Updates are automatic: the app checks on launch and installs the new version when restarted.

## System Requirements

- **OS:** Windows 10 / 11 (64-bit)
- **CPU:** any modern dual-core is enough — **no GPU required**, synthesis runs entirely on the CPU
- **RAM:** 4 GB recommended (app + engine use ~500 MB)
- **Disk:** ~1 GB free space (app ~600 MB + ~60 MB per voice model)
- **Internet:** required for the live stream feed; **synthesis is fully local** — comment text and audio are never sent to any cloud service

*Piper uses onnxruntime's CPU runtime; no graphics card, CUDA or special drivers are needed.*

## Building (for developers)

```bash
git clone https://github.com/cemo702/FreeTiktokTTS.git
cd FreeTiktokTTS
npm install          # engine + voice model installed idempotently (setup-voice.mjs)
npm run setup:voice  # completes anything missing (venv + model.onnx)
npm test             # 115+ tests
npm run dist         # produces the installer (dist/)
```

Build requirements: Node.js 20+, Python 3.10+ (for the venv), internet access (first run downloads the model + pip packages).

## Legal note

This project is **not affiliated with TikTok or ByteDance**. "TikTok" is a registered trademark of ByteDance Inc. The app uses the open-source [`tiktok-live-connector`](https://github.com/zerodytester/TikTok-Chat-Reader) library to read live events; no data other than the username you type is collected or sent.

## Credits

- [`tiktok-live-connector`](https://github.com/zerodytester/TikTok-Chat-Reader) — TikTok LIVE event stream (AGPL-3.0)
- [`piper1-gpl`](https://github.com/OHF-Voice/piper1-gpl) — fast, local neural TTS
- [99eren99/piper-turkish-tts](https://huggingface.co/99eren99/piper-turkish-tts) — bundled Turkish voice model
- [eSpeak NG](https://github.com/espeak-ng/espeak-ng) — phoneme generation
- [Electron](https://www.electronjs.org/) — desktop shell

## Support 💛

The app is free and always will be. If you'd like to support development:

[![Buy me a coffee](https://img.shields.io/badge/Buy%20me%20a%20coffee-FF813F?style=for-the-badge&logo=buy-me-a-coffee&logoColor=white)](https://buymeacoffee.com/cemo7028)
[![PayPal](https://img.shields.io/badge/PayPal-Donate-00457C?style=for-the-badge&logo=paypal&logoColor=white)](https://www.paypal.com/donate/?hosted_button_id=L5CEV9BV2EBUG)

## License

Released under the [GNU Affero General Public License v3.0 (AGPL-3.0)](LICENSE). In short: use it, change it, share it — but derivatives must stay under the same license.
