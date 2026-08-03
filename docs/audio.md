# Аудио

## AudioEngine (`src/lib/audioEngine.ts`)

Две ответственности:

1. **Воспроизведение** через `<audio>` элемент: play/pause/seek, точный `currentTime`.
2. **Декодирование** MP3 в `AudioBuffer` через `AudioContext.decodeAudioData` — нужен для:
   - Точной длительности песни.
   - PCM для экспорта MP4 (через Mediabunny `AudioBufferSource`).
   - Расчёта пиков waveform.

`audioBuffer` — декодированный PCM, доступен после `load(file)`.

## Загрузка

`load(file)` — создаёт object URL для `<audio>`, декодирует файл в `AudioBuffer`. Длительность (`durationMs`) берётся из `AudioBuffer` или `<audio>.duration`.

## События

- `onAudioState(fn)` — play/pause.
- `onTime(fn)` — текущее время (RAF-цикл во время воспроизведения).

## Глобальный синглтон

`audioEngine` — единственный экземпляр, используется controls, preview, timeline, export.
