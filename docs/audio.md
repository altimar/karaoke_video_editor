# Аудио

## Роли аудиодорожек

Проект содержит три фиксированные аудиодорожки (роли): **оригинал** (reference, для записи таймингов), **минус** (instrumental — микшируется в экспорт видео) и **бэк** (бэк-вокал — тоже в экспорт). Роли заданы в модели (`AudioTrack.role: 'original' | 'minus' | 'back'`); имена фиксированы и не редактируются. Аудио в роль загружается кликом по её шапке в таймлайне (пустая → диалог загрузки).

Сырые байты аудио хранятся ВНЕ проекта (в `audioLoader`); дорожка хранит только `audioFileName` + `volumeAutomation`.

## AudioEngine (`src/lib/audioEngine.ts`) — мульти-голос

Каждая загруженная роль — «голос» (voice): `<audio>` → `MediaElementSource` → `GainNode` → общий `ctx.destination`. Голоса суммируются на destination. Один общий `AudioContext`.

- `loadBytes(role, bytes, filename)` — загрузить/заменить аудио в роли.
- `clear(role)` — выгрузить аудио роли (слот остаётся).
- `getBuffer(role)` — декодированный `AudioBuffer` роли (для экспорта/waveform).
- `applyVolumeAutomation(role, points)` — огибающая громкости роли (gain применяется каждый кадр RAF).

### Режимы воспроизведения

Два режима выбирают, какие голоса звучат:
- **playback** (`play()`): минус + бэк (если хоть один загружен), иначе оригинал. Используется кнопкой «Пуск».
- **record** (`playForRecord()`): оригинал (если загружен), иначе минус + бэк. Используется записью таймингов.

Все стартующие голоса начинают одновременно из одной позиции. `currentTimeMs`/`durationMs` — по первому голосу активного набора.

## audioLoader (`src/lib/audioLoader.ts`)

Мост между UI и моделью: `loadAudioIntoRole(role, file)` (декодирует + хранит байты + обновляет `audioFileName`), `clearAudioRole(role)`, `getAudioBytesMap()` (для экспорта — байты по ролям).

## События

- `onAudioState(fn)` — play/pause.
- `onTime(fn)` — текущее время (RAF-цикл во время воспроизведения).

## Глобальный синглтон

`audioEngine` — единственный экземпляр, используется controls, preview, timeline, export.
