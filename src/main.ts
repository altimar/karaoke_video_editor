/**
 * App entry point. Wires the three columns + timeline + topbar together and
 * manages a simple toast system.
 */
import './styles.css';
import { createTopbar } from './ui/controls';
import { openNewProjectWizard } from './ui/newProjectWizard';
import { createLyricsEditor } from './ui/lyricsEditor';
import { createPreview } from './ui/preview';
import { createStylePanel } from './ui/stylePanel';
import { createTimeline } from './ui/timeline';
import { createPropsSheet } from './ui/propsSheet';
import { canExport } from './lib/export';
import { peekBgFilmstrip } from './lib/bgThumbnails';
import { setAlignmentModel } from './lib/forcedAlign';
import { resolveAlignModelOverride } from './lib/alignment/models';
import { store } from './state/store';
import { audioEngine } from './lib/audioEngine';
import { getAudioTracks } from './types';

function toast(msg: string, kind: 'ok' | 'err' | 'info' = 'info'): void {
  const node = document.createElement('div');
  node.className = `toast ${kind === 'info' ? '' : kind}`;
  node.textContent = msg;
  document.body.appendChild(node);
  setTimeout(() => {
    node.style.opacity = '0';
    node.style.transition = 'opacity .3s';
    setTimeout(() => node.remove(), 320);
  }, 2600);
}

function main(): void {
  const app = document.getElementById('app')!;

  // Topbar
  // The wizard needs the timeline's auto-align runner; the timeline is created
  // below, so the button's callback goes through a late-bound ref.
  let runAutoAlign: (trackId: string) => Promise<void> = async () => {};
  const topbar = createTopbar(toast, () =>
    openNewProjectWizard({ toast, runAutoAlign: (id) => runAutoAlign(id) }),
  );
  app.appendChild(topbar.root);

  // Build the column components once. Their root nodes are MOVED between the
  // desktop columns and the mobile props-sheet as the viewport changes (a DOM
  // move preserves listeners/state, so the same instances work in both layouts).
  const lyrics = createLyricsEditor();
  const style = createStylePanel(toast);
  const preview = createPreview();

  // Main 3-column area
  const main = document.createElement('div');
  main.className = 'main';

  // Left: lyrics editor + help
  const left = document.createElement('div');
  left.className = 'col col-left';
  left.appendChild(lyrics.root);
  left.appendChild(helpCard());
  main.appendChild(left);

  // Center: preview + transport time
  const center = document.createElement('div');
  center.className = 'col col-center';
  center.appendChild(preview.wrap);
  main.appendChild(center);

  // Right: style/effects panel
  const right = document.createElement('div');
  right.className = 'col col-right';
  right.appendChild(style.root);
  main.appendChild(right);

  app.appendChild(main);

  // --- Mobile props-sheet + FAB ---
  // The lyrics & style nodes are stashed in a modal sheet reached via a floating
  // button; on desktop they live in their columns instead. applyLayout() is the
  // SOLE owner of where these nodes live — it mounts them into either the
  // desktop columns or the sheet's panels, so there's no ordering ambiguity.
  const propsSheet = createPropsSheet();
  document.body.appendChild(propsSheet.root);

  // Timeline at the bottom. The Фон pseudo-row is selectable like a track:
  // its "settings" are the background card in the style panel (on mobile the
  // sheet opens right away so the selection is visible).
  const timeline = createTimeline(toast, {
    onBackgroundSelected: () => {
      style.showBackground();
      if (window.matchMedia('(max-width: 900px)').matches) propsSheet.open();
    },
    onTrackSelected: () => style.showTrack(),
  });
  runAutoAlign = timeline.runAutoAlign;
  app.appendChild(timeline.root);

  const fab = document.createElement('button');
  fab.className = 'props-fab';
  fab.textContent = '✏️ Свойства';
  fab.title = 'Свойства активной дорожки';
  fab.addEventListener('click', () => propsSheet.open());
  document.body.appendChild(fab);

  /** Move a node into a new parent only if it isn't already there. */
  function mount(node: HTMLElement, newParent: HTMLElement): void {
    if (node.parentElement !== newParent) newParent.appendChild(node);
  }

  function applyLayout(isMobile: boolean): void {
    if (isMobile) {
      propsSheet.close();
      mount(lyrics.root, propsSheet.lyricsPanel);
      mount(style.root, propsSheet.stylePanel);
    } else {
      propsSheet.close();
      // Lyrics first in the left column (before the help card).
      if (lyrics.root.parentElement !== left) left.insertBefore(lyrics.root, left.firstChild);
      mount(style.root, right);
    }
  }
  const mq = window.matchMedia('(max-width: 900px)');
  applyLayout(mq.matches);
  mq.addEventListener('change', (e) => applyLayout(e.matches));

  // Keep each audio voice's gain in sync with its track's volume automation,
  // and its mute/solo flags in sync with the model.
  store.subscribe(() => {
    const p = store.getProject();
    for (const at of getAudioTracks(p)) {
      audioEngine.applyVolumeAutomation(at.role, at.volumeAutomation);
      audioEngine.setMuteSolo(at.role, at.muted, at.solo);
    }
  });

  // E2E test hook (Playwright): read-only access to the app state & audio
  // engine from page.evaluate, so tests can assert on the project model
  // instead of scraping DOM.
  const hooks = window as unknown as {
    __store: typeof store;
    __audioEngine: typeof audioEngine;
    __bgFilmstrip: typeof peekBgFilmstrip;
    __setAlignModelFull: (preset: 'en' | 'multi' | null, url?: string, cacheName?: string) => void;
  };
  hooks.__store = store;
  hooks.__audioEngine = audioEngine;
  hooks.__bgFilmstrip = peekBgFilmstrip;
  hooks.__setAlignModelFull = (preset, url, cacheName) =>
    setAlignmentModel(preset ? resolveAlignModelOverride(preset, url, cacheName) : null);
}

function helpCard(): HTMLElement {
  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = `
    <h2>Как пользоваться</h2>
    <div class="hint">
      1. <b>Загрузить MP3</b> и ввести текст (слоги делятся по пробелам и <kbd>/</kbd>, строки — переносами; знаки препинания остаются при словах).<br/>
      2. Нажать <b>Запись таймингов</b>, слушать и бить <kbd>Пробел</kbd> на каждый слог.<br/>
      3. Подправить маркеры на таймлайне (перетаскивание) и стиль справа.<br/>
      4. <b>Скачать MP4</b> — рендер в видео с вашим аудио.<br/><br/>
      <kbd>Пробел</kbd> — пуск/пауза (вне записи). <kbd>Shift</kbd>+колесо — зум таймлайна.
    </div>
    <div class="feature-note ${canExport() ? '' : 'bad'}">
      ${canExport()
        ? '✓ Браузер поддерживает экспорт в MP4 (WebCodecs).'
        : '✗ Экспорт в MP4 недоступен — откройте в Chrome или Edge.'}
    </div>
  `;
  return card;
}

main();
