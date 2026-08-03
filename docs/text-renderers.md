# Система рендереров текста

## Интерфейс

Каждый режим анимации текста — независимый модуль, реализующий общий интерфейс `TextRenderer` (`src/lib/text_renderers/types.ts`):

- `id: Layout` — идентификатор режима (`'scroller'`).
- `label: string` — название для UI.
- `settings: RenderSettingSpec[]` — декларация настроек режима (для автогенерации контролов в UI).
- `render(ctx, timeMs, env, settings)` — отрисовать текстовый слой одного кадра. Фон уже нарисован оркестратором.

`RenderEnv` содержит предвычисленные данные: `project`, `timings` (массив `TimedSyllable`), `activeLineIndex`.

## Оркестратор

`src/lib/render.ts` — тонкий слой:
1. Рисует фон (`drawBackground`: цвет / градиент / картинка).
2. Вычисляет `timings = buildTimings(project)` и `activeLineIndex`.
3. Выбирает рендерер через `getRenderer(project.style.layout)`.
4. Мёрджит настройки рендерера с дефолтами и вызывает `renderer.render(...)`.

Сигнатура `renderFrame(ctx, timeMs, project)` не меняется — потребители (preview, export) не знают о модулях.

## Реестр

`src/lib/text_renderers/registry.ts`:
- `TEXT_RENDERERS: Record<Layout, TextRenderer>` — все рендереры по id.
- `RENDERER_LIST` — список для UI-селектора.
- `getRenderer(layout)` — выбор с фолбэком на `'scroller'`.
- `allDefaultSettings()` — дефолтные настройки всех рендереров.

## Как добавить новый режим

1. Создать модуль `src/lib/text_renderers/<name>.ts`, реализующий `TextRenderer`.
2. Добавить id в тип `Layout` (`src/types.ts`).
3. Зарегистрировать в `registry.ts` (`TEXT_RENDERERS` и `RENDERER_LIST`).
4. Добавить дефолтные настройки в `createDefaultProject()` (`src/types.ts`).
5. Оркестратор и UI подхватят автоматически.

## Общие хелперы (`helpers.ts`)

Layout-агностичные функции, используемые всеми рендерерами:

- `buildTimings(project)` → `TimedSyllable[]` — **только размеченные слоги** (инвариант: неразмеченные исключаются).
- `progress(ts, timeMs)` — степень заливки 0..1.
- `activeIndex(timings, timeMs)` — индекс активного слога.
- `layoutLine(ctx, timings, lineIndex, timeMs, activeLineIndex, style)` — раскладка слогов строки: позиции X, ширины, fill progress. Пробел между словами рисуется реальным пробелом (через `sep === ' '`), слэш — без отступа.
- `drawSyllable(ctx, ls, originX, cx, cy, style)` — отрисовка одного слога: базовый цвет → clipped highlight заливка → stroke → glow → active-анимация (scale/bounce).
- `lineOriginX(style, lineWidth, canvasWidth)` — X-позиция строки по выравниванию.
- `applyFont(ctx, style)` — установка шрифта.

## Настройки

Каждый рендерер декларирует свои настройки в `settings: RenderSettingSpec[]`. Значения хранятся в `project.rendererSettings[rendererId][key]`. UI (`stylePanel.ts`) автогенерирует контролы (числовые → слайдер, boolean → чекбокс) только для выбранного режима.

## Текущие режимы

### `scroller` — «Бегущая (вылет снизу)»
Кинотитры: N строк видно (настройка `visibleLines`, дефолт 8), текст едет снизу вверх с постоянной скоростью, заливка стартует на вертикальном центре (reading line). Строки распределены равномерно (`lineSpacing = height / N`). Скорость — глобальная константа для всей песни.
