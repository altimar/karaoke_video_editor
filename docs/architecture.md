# Архитектура

## Обзор

Браузерное приложение для создания караоке-видео. Полностью клиентское — без сервера и без ffmpeg. Пользователь загружает MP3 и текст, разбивает текст на слоги, отснимает тайминги в такт музыке, настраивает стиль и экспортирует MP4.

## Поток данных

```
MP3 ──→ AudioEngine ──→ AudioBuffer (декодированный PCM)
                          │
Текст ──→ parseLyrics ──→ Lines[] ──→ Store (Project)
                          │               │
                     mergeTimings         │
                     (перенос при         ├──→ Preview (RAF → renderFrame → canvas)
                      редактировании)     ├──→ Timeline (canvas, drag маркеров)
                          │               ├──→ StylePanel (контролы → store)
                     Space → timing       └──→ Export (renderFrame кадр-за-кадром → MP4)
                     (съёмка)
```

## Ключевой инвариант: WYSIWYG

**Одна функция `renderFrame(ctx, timeMs, project)`** рисует кадр и для превью, и для экспорта. Это гарантирует, что видео = превью пиксель-в-пиксель. Не создавай раздельной логики отрисовки.

## Ключевой инвариант: неразмеченные слоги не рендерятся

Только слоги с `startMs !== null` попадают в `buildTimings` → в кадр. Неразмеченные слоги невидимы в превью и видео, не появляются на таймлайне. Это **намеренно** — см. комментарий `!!! IMPORTANT` в `buildTimings`.

## Ключевой инвариант: перенос таймингов

При редактировании текста тайминги переносятся **позиционно** по глобальному плоскому индексу всех слогов песни (через границы строк). См. `docs/lyrics-and-timings.md`.

## Модульная система рендереров текста

Текстовый слой рендерится **модулями** — по одному на режим анимации (сейчас один: `scroller`). Каждый модуль реализует общий интерфейс `TextRenderer` и регистрируется в реестре; архитектура поддерживает добавление новых режимов. Оркестратор `render.ts` выбирает модуль по `project.style.layout` и делегирует ему отрисовку. См. `docs/text-renderers.md`.

## Карта файлов

```
src/
  main.ts                  — сборка приложения, toast-система
  types.ts                 — модели данных: Project, Style, Syllable, Line, Layout
  state/store.ts           — мини-реактивный стор (subscribe/mutate/setProject)
  lib/
    render.ts              — ОРКЕСТРАТОР: фон + выбор рендерера + renderFrame
    audioEngine.ts         — загрузка MP3, воспроизведение, декодирование в AudioBuffer
    timing.ts              — контроллер съёмки таймингов (Space → startMs)
    textParser.ts          — парсер текста, сериализация, mergeTimings, flatSyllables
    waveform.ts            — расчёт пиков waveform из AudioBuffer (кешируется)
    export.ts              — экспорт MP4: WebCodecs + Mediabunny, качество, прогресс
    kfnExport.ts           — экспорт KaraFun (.kfn): бинарный контейнер + Song.ini
    kfnImport.ts           — импорт KaraFun (.kfn): парсинг контейнера → проект + аудио
    syllabification/
      types.ts             — интерфейс Syllabifier, detectLanguage
      registry.ts          — реестр слогоделителей по языкам
      russian.ts           — слогоделение для русского
      english.ts           — для английского (compound-префиксы, словарь исключений)
      german.ts            — для немецкого
      index.ts             — syllabifyText: детект языка + разбиение текста
    text_renderers/
      types.ts             — интерфейс TextRenderer, RenderEnv, RenderSettingSpec
      helpers.ts           — общие хелперы: buildTimings, layoutLine, drawSyllable
      registry.ts          — реестр рендереров, getRenderer, дефолты настроек
      scroller.ts          — режим «бегущая» (кинотитры)
  ui/
    controls.ts            — верхняя панель: загрузка MP3, play/pause, запись, экспорт
    lyricsEditor.ts        — редактор текста (textarea), парсинг на лету, mergeTimings
    preview.ts             — canvas-превью с RAF-циклом
    timeline.ts            — таймлайн: 3 строки, маркеры, drag, waveform, playhead
    stylePanel.ts          — панель стилей (in-place обновления, автогенерация настроек)
    exportDialog.ts        — модальный диалог экспорта (выбор качества, прогресс)
scripts/                   — Node-тесты (esbuild + fake-ctx / jsdom)
```

## Стек

- **Vite + vanilla TypeScript** — без фреймворков, нативный DOM.
- **Mediabunny** — мьюксинг MP4 (H.264 + AAC) через WebCodecs.
- **Тесты** — Node-скрипты, бандлятся через esbuild, jsdom для DOM-тестов.
- **Браузер** — Chrome/Edge (WebCodecs для экспорта).
