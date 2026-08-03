/**
 * App entry point. Wires the three columns + timeline + topbar together and
 * manages a simple toast system.
 */
import './styles.css';
import { createTopbar } from './ui/controls';
import { createLyricsEditor } from './ui/lyricsEditor';
import { createPreview } from './ui/preview';
import { createStylePanel } from './ui/stylePanel';
import { createTimeline } from './ui/timeline';
import { canExport } from './lib/export';

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
  const topbar = createTopbar(toast);
  app.appendChild(topbar.root);

  // Main 3-column area
  const main = document.createElement('div');
  main.className = 'main';

  // Left: lyrics editor + help
  const left = document.createElement('div');
  left.className = 'col col-left';
  left.appendChild(createLyricsEditor().root);
  left.appendChild(helpCard());
  main.appendChild(left);

  // Center: preview + transport time
  const center = document.createElement('div');
  center.className = 'col col-center';
  center.appendChild(createPreview().wrap);
  main.appendChild(center);

  // Right: style/effects panel
  const right = document.createElement('div');
  right.className = 'col col-right';
  right.appendChild(createStylePanel().root);
  main.appendChild(right);

  app.appendChild(main);

  // Timeline at the bottom
  app.appendChild(createTimeline().root);
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
