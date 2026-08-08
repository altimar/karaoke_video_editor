# Архитектура

## Обзор

Браузерное приложение для создания караоке-видео. Полностью клиентское — без сервера и без ffmpeg. Пользователь загружает MP3 и один или несколько текстов (дорожек), разбивает текст на слоги, отснимает тайминги в такт музыке, настраивает стиль каждой дорожки и экспортирует MP4.

## Поток данных

```
MP3 ──→ AudioEngine ──→ AudioBuffer (декодированный PCM)
                          │
Текст ──→ parseLyrics ──→ Lines[] ──→ TextTrack ──→ Store (Project)
                          │             (lines +      (tracks[] + background)
                     mergeTimings       TextStyle +     │
                     (перенос при        rendererSettings)  ├─→ Preview (RAF → renderFrame → canvas)
                      редактировании)    │               ├─→ Timeline (canvas, drag маркеров; полоса на дорожку)
                          │              └─── active ──→  ├─→ StylePanel (per-track + project контролы)
                     Space → timing                        └─→ Export (renderFrame кадр-за-кадром → MP4)
                     (съёмка, активная дорожка)
```

## Дорожки

Проект содержит массив дорожек разных типов (`Project.tracks: Track[]`). `Track` — дискриминированный union с полем `type`:

- **Текстовые** (`TextTrack`, `type: 'text'`): свой текст (`lines`), свой текстовый стиль (`TextStyle`), свои настройки рендерера (`rendererSettings`). Рендерятся поверх общего фона, в порядке массива, и могут перекрываться.
- **Аудио** (`AudioTrack`, `type: 'audio'`): фиксированная `role` (`'original' | 'lead' | 'minus' | 'back'`), ссылка на источник (`audioFileName`, пусто = нет аудио) и огибающая громкости (`volumeAutomation`). Сырые байты аудио хранятся ВНЕ проекта (в `audioLoader`); дорожка хранит только роль + имя файла + automation. Аудиодорожки не рендерятся в кадр видео. Проект всегда содержит все четыре роли; «оригинал» — для записи таймингов, «минус»+«бэк» — микшируются в экспорт видео, «вокал» (lead) — звучит в редакторе, но в экспорт не попадает.

Ровно одна дорожка **активна** (`project.activeTrackId`) — любого типа. Общий фон (`Background`), разрешение и FPS живут на уровне проекта.

## Ключевой инвариант: WYSIWYG

**Одна функция `renderFrame(ctx, timeMs, project)`** рисует кадр и для превью, и для экспорта. Она рисует общий фон один раз, затем в цикле проходит по всем дорожкам и рендерит каждую **текстовую** дорожку своим рендерером (аудиодорожки пропускаются — у них нет визуального представления в кадре). Это гарантирует, что видео = превью пиксель-в-пиксель. Не создавай раздельной логики отрисовки.

## Ключевой инвариант: неразмеченные слоги не рендерятся

Только слоги с `startMs !== null` попадают в `buildTimings` (для каждой дорожки отдельно) → в кадр. Неразмеченные слоги невидимы в превью и видео, не появляются на таймлайне. Это **намеренно** — см. комментарий `!!! IMPORTANT` в `buildTimings`.

## Ключевой инвариант: перенос таймингов

При редактировании текста тайминги переносятся **позиционно** по глобальному плоскому индексу всех слогов **дорожки** (через границы строк), в пределах активной дорожки. См. `docs/lyrics-and-timings.md`.

## Модульная система рендереров текста

Текстовый слой каждой дорожки рендерится **модулями** — по одному на режим анимации (`scroller`, `classic`). Каждый модуль реализует общий интерфейс `TextRenderer` и регистрируется в реестре; архитектура поддерживает добавление новых режимов. Оркестратор `render.ts` рисует общий фон один раз, затем в цикле по дорожкам выбирает модуль по `track.style.layout` и делегирует ему отрисовку этой дорожки. См. `docs/text-renderers.md`.

## Карта файлов

```
src/
  main.ts                  — сборка приложения, toast-система
  types.ts                 — модели данных: Project, TextTrack, TextStyle, Background, Syllable, Line
  state/store.ts           — мини-реактивный стор (subscribe/mutate/setProject)
  lib/
    render.ts              — ОРКЕСТРАТОР: общий фон + цикл по дорожкам + renderFrame
    audioEngine.ts         — мульти-голосовое воспроизведение по ролям (оригинал/вокал/минус/бэк), декодирование
    audioLoader.ts         — мост UI↔модель: загрузка/очистка аудио в роль, хранение байтов для экспорта
    timing.ts              — контроллер съёмки таймингов активной дорожки (Space → startMs)
    textParser.ts          — парсер текста, сериализация, mergeTimings, flatSyllables
    waveform.ts            — расчёт пиков waveform из AudioBuffer (кешируется)
    export.ts              — экспорт MP4: WebCodecs + Mediabunny, качество, прогресс
    exportErrors.ts        — общие ошибки экспорта (ExportError, ExportCanceledError)
    kfnExport.ts           — экспорт KaraFun (.kfn): дорожки → бинарный контейнер + Song.ini
    kfnImport.ts           — импорт KaraFun (.kfn): парсинг контейнера → проект + аудио
    projectFile.ts         — файл проекта .karaokeproject (ZIP-контейнер: JSON + медиа)
    syllabification/
      types.ts             — интерфейс Syllabifier, detectLanguage
      registry.ts          — реестр слогоделителей по языкам
      russian.ts           — слогоделение для русского
      english.ts           — для английского (compound-префиксы, словарь исключений)
      german.ts            — для немецкого
      index.ts             — syllabifyText: детект языка + разбиение текста
    text_renderers/
      types.ts             — интерфейс TextRenderer, RenderEnv (одна дорожка), RenderSettingSpec
      helpers.ts           — общие хелперы: buildTimings(lines, durationMs), layoutLine, drawSyllable
      registry.ts          — реестр рендереров, getRenderer, дефолты настроек
      scroller.ts          — режим «бегущая» (кинотитры)
      classic.ts           — режим «классическое караоке» (фиксированные слоты)
  ui/
    controls.ts            — верхняя панель: загрузка MP3, play/pause, запись, экспорт
    lyricsEditor.ts        — редактор текста активной дорожки + переключатель дорожек (add/remove)
    preview.ts             — canvas-превью с RAF-циклом
    timeline/              — таймлайн (модульный): оркестратор (index) + стратегии дорожек (textView, audioView)
    stylePanel.ts          — панель: per-track (шрифт/цвета/обводка/раскладка) + project (фон/FPS/разрешение)
    exportDialog.ts        — модальный диалог экспорта (выбор качества, прогресс)
scripts/                   — Node-тесты (esbuild + fake-ctx / jsdom)
```

## Стек

- **Vite + vanilla TypeScript** — без фреймворков, нативный DOM.
- **Mediabunny** — мьюксинг MP4 (H.264 + AAC) через WebCodecs.
- **Тесты** — Node-скрипты, бандлятся через esbuild, jsdom для DOM-тестов.
- **Браузер** — Chrome/Edge (WebCodecs для экспорта).
