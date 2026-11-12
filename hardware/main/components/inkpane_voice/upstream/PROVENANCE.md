# Vendored xiaozhi-esp32 sources

The files under `upstream/` are copied from the [xiaozhi-esp32](https://github.com/78/xiaozhi-esp32)
project (MIT, see `LICENSE.xiaozhi`), commit `39d23aee5b8682f77bbdf9cdc66799456b5ad408`
(2026-10-24, local checkout `C:\Users\zhang\Documents\esp_idf_projects\xiaozhi-esp32`).

They implement the mature parts of the voice stack so InkPane does not
re-implement AFE/MultiNet/Opus/WebSocket framing:

| Local path | Upstream path |
| --- | --- |
| `audio/audio_codec.{h,cc}` | `main/audio/audio_codec.*` |
| `audio/audio_engine.h` | `main/audio/audio_engine.h` |
| `audio/audio_service.{h,cc}` | `main/audio/audio_service.*` |
| `audio/audio_debugger.{h,cc}` | `main/audio/audio_debugger.*` |
| `audio/fixed_queue.h` | `main/audio/fixed_queue.h` |
| `audio/codecs/es8311_audio_codec.{h,cc}` | `main/audio/codecs/es8311_audio_codec.*` |
| `audio/engines/afe_audio_engine.{h,cc}` | `main/audio/engines/afe_audio_engine.*` |
| `audio/wake_words/custom_wake_word.{h,cc}` | `main/audio/wake_words/custom_wake_word.*` |
| `audio/wake_words/wake_word_audio_cache.{h,cc}` | `main/audio/wake_words/wake_word_audio_cache.*` |
| `audio/wake_word.h` | `main/audio/wake_word.h` |
| `protocols/protocol.{h,cc}` | `main/protocols/protocol.*` |
| `protocols/websocket_protocol.{h,cc}` | `main/protocols/websocket_protocol.*` |

## Deliberate divergences

Every change is limited to removing xiaozhi framework dependencies or to
routes that InkPane owns. The audio DSP / Opus / AFE logic itself is unchanged.

1. `audio_codec.*`: dropped `board.h`; volume uses the local `Settings` shim.
2. `audio_service.*`: dropped `board.h`/Ogg demuxer/`PlaySound` (InkPane has no
   OGG sound assets); decoder resampling uses the stored `codec_`; added
   `ReloadWakeWords()` for runtime custom wake words; `EnableVoiceProcessing()`
   takes `reset_decoder=false` so barge-in can start the microphone without
   dropping the reply that is still queued.
3. `afe_audio_engine.*`: added `ReloadWakeWords()`; the rest of the AFE
   pipeline (FD low-cost, server AEC, VAD, PSRAM allocation policy) is untouched.
4. `custom_wake_word.*`: removed the `Assets`/`index.json` and Kconfig command
   sources. Wake phrases now come from `port/voice_identity.h`, which voice_app
   fills from the console/provisioning config; added `ReloadCommands()`.
5. `protocol.cc`: `AddTextFontCapabilities()` is a no-op (InkPane uses a fixed
   1-bit font, no glyph push).
6. `websocket_protocol.*`: replaced the xiaozhi `Board`/`Network`/`Settings`/
   `SystemInfo`/`Lang`/`Application::Schedule` glue with `port/web_socket.h` and
   `port/voice_identity.h`; added `SetConfig(url, token, version)`; hello still
   advertises `mcp` and, with `CONFIG_USE_SERVER_AEC`, `aec`.
7. `es8311_audio_codec.*`: optional virtual playback reference for barge-in.
   The board has one microphone, so the codec keeps a ring of the PCM written to
   the speaker and returns interleaved `[mic, reference]` frames; the AFE then
   runs its normal FD AEC. Enabled by `CONFIG_INKPANE_VOICE_BARGE_IN`.

## Capability macros

`components/inkpane_voice/CMakeLists.txt` defines the xiaozhi Kconfig symbols
that the copied code expects:

```
CONFIG_USE_AUDIO_PROCESSOR=1   # AFE uplink + VAD
CONFIG_USE_SERVER_AEC=1        # advertise server-side AEC timestamps
CONFIG_USE_DEVICE_AEC=0        # no hardware reference; barge-in synthesises one
CONFIG_SEND_WAKE_WORD_DATA=0   # do not upload pre-roll audio
```

## Updating from upstream

1. Copy the files above from the new xiaozhi commit.
2. Re-apply the six divergences. `git diff` against the previous copy makes
   the port surface explicit.
3. Keep `LICENSE.xiaozhi` and update the commit hash in this file.
4. Build both firmware modes and run the host tests; a successful build is not
   audio validation.
