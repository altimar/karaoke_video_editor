/**
 * Vocal-bind dialog for the ⏱ auto-timing on an UNBOUND text track.
 *
 * The track's lyrics must be aligned against the right vocal; if the track
 * isn't bound to one yet, this dialog asks which vocal it belongs to — flat
 * buttons with the vocal track names (no dropdown). Choosing binds the track
 * (persistently) and resolves the promise with the role; cancelling or
 * closing resolves null and nothing changes.
 *
 * Enforces the one-vocal-one-track rule: if the picked vocal already carries
 * another text track, an inline error names it and the dialog stays open.
 */
import { AudioRole, AUDIO_ROLE_NAMES, Project, TextTrack } from '../types';

/** Vocal roles a text track may be bound to (contains vocals; minus never). */
export const BINDABLE_ROLES: AudioRole[] = ['lead', 'back', 'original'];

export interface VocalBindDialog {
  promise: Promise<AudioRole | null>;
  close: () => void;
}

export function openVocalBindDialog(project: Project, track: TextTrack): VocalBindDialog {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';

  const modal = document.createElement('div');
  modal.className = 'modal';

  const header = document.createElement('div');
  header.className = 'modal-header';
  const title = document.createElement('div');
  title.className = 'modal-title';
  title.textContent = 'Авторасстановка таймингов';
  const closeBtn = document.createElement('button');
  closeBtn.className = 'modal-close';
  closeBtn.textContent = '✕';
  closeBtn.title = 'Отмена';
  header.appendChild(title);
  header.appendChild(closeBtn);
  modal.appendChild(header);

  const body = document.createElement('div');
  body.className = 'modal-body';
  const msg = document.createElement('div');
  msg.textContent =
    `Текстовая дорожка «${track.name}» не связана с вокалом — ` +
    'автоматическая расстановка невозможна. Выберите вокальную дорожку:';
  body.appendChild(msg);

  const err = document.createElement('div');
  err.className = 'bind-error';
  err.style.display = 'none';
  body.appendChild(err);

  const btnRow = document.createElement('div');
  btnRow.className = 'bind-role-row';
  let resolveChoice: ((role: AudioRole | null) => void) | null = null;
  for (const role of BINDABLE_ROLES) {
    const btn = document.createElement('button');
    btn.textContent = AUDIO_ROLE_NAMES[role];
    btn.dataset.testid = `bind-vocal-${role}`;
    btn.addEventListener('click', () => {
      const rival = project.tracks.find(
        (t) => t.type === 'text' && t.id !== track.id && t.boundVocalRole === role,
      );
      if (rival) {
        err.textContent =
          `К вокальной дорожке «${AUDIO_ROLE_NAMES[role]}» уже привязана ` +
          `текстовая дорожка «${rival.name}». Сначала отвяжите её.`;
        err.style.display = '';
        return;
      }
      finish(role);
    });
    btnRow.appendChild(btn);
  }
  body.appendChild(btnRow);

  const footer = document.createElement('div');
  footer.className = 'modal-footer';
  const cancel = document.createElement('button');
  cancel.textContent = 'Отмена';
  cancel.dataset.testid = 'bind-vocal-cancel';
  footer.appendChild(cancel);
  modal.appendChild(body);
  modal.appendChild(footer);

  const done = (): void => {
    backdrop.remove();
    window.removeEventListener('keydown', onKey);
  };
  const finish = (role: AudioRole | null): void => {
    done();
    resolveChoice?.(role);
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') finish(null);
  };
  window.addEventListener('keydown', onKey);
  closeBtn.addEventListener('click', () => finish(null));
  cancel.addEventListener('click', () => finish(null));
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) finish(null);
  });

  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);

  const promise = new Promise<AudioRole | null>((resolve) => {
    resolveChoice = resolve;
  });
  return { promise, close: () => finish(null) };
}
