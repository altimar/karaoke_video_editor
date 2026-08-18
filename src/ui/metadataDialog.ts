/**
 * Song metadata dialog — artist, title, year and the other KaraFun `[General]`
 * fields. Edits a working copy; «Сохранить» applies it through the callback
 * (the caller mutates the store). Отмена / Esc / клик по фону — без изменений.
 *
 * The metadata also names exported files («Группа - Название».kfn/.mp4) and
 * round-trips through the KFN [General] section + the TITL/ARTS header blocks.
 */
import { Project, ProjectMetadata } from '../types';

interface MetaField {
  key: keyof ProjectMetadata;
  label: string;
  placeholder?: string;
}

const FIELDS: MetaField[] = [
  { key: 'artist', label: 'Группа / исполнитель', placeholder: 'Lumen' },
  { key: 'title', label: 'Название', placeholder: 'Буря' },
  { key: 'year', label: 'Год', placeholder: '2024' },
  { key: 'album', label: 'Альбом' },
  { key: 'composer', label: 'Композитор' },
  { key: 'comment', label: 'Комментарий' },
];

export function openMetadataDialog(project: Project, apply: (m: ProjectMetadata) => void): void {
  const draft: ProjectMetadata = { ...project.metadata };

  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';

  const modal = document.createElement('div');
  modal.className = 'modal';

  const header = document.createElement('div');
  header.className = 'modal-header';
  const title = document.createElement('div');
  title.className = 'modal-title';
  title.textContent = 'Метаданные песни';
  const closeBtn = document.createElement('button');
  closeBtn.className = 'modal-close';
  closeBtn.textContent = '✕';
  closeBtn.title = 'Закрыть';
  header.appendChild(title);
  header.appendChild(closeBtn);
  modal.appendChild(header);

  const body = document.createElement('div');
  body.className = 'modal-body';
  const form = document.createElement('div');
  form.className = 'meta-form';
  const inputs = new Map<keyof ProjectMetadata, HTMLInputElement>();
  for (const f of FIELDS) {
    const wrap = document.createElement('div');
    const label = document.createElement('label');
    label.textContent = f.label;
    label.htmlFor = `meta-${f.key}`;
    const input = document.createElement('input');
    input.type = 'text';
    input.id = `meta-${f.key}`;
    input.value = draft[f.key];
    if (f.placeholder) input.placeholder = f.placeholder;
    input.dataset.testid = `meta-${f.key}`;
    input.addEventListener('input', () => (draft[f.key] = input.value));
    wrap.appendChild(label);
    wrap.appendChild(input);
    form.appendChild(wrap);
    inputs.set(f.key, input);
  }
  body.appendChild(form);
  const hint = document.createElement('div');
  hint.className = 'feature-note';
  hint.textContent = 'Название файла экспорта: «Группа - Название».';
  body.appendChild(hint);
  modal.appendChild(body);

  const finish = (save: boolean): void => {
    if (save) apply({ ...draft });
    backdrop.remove();
    window.removeEventListener('keydown', onKey);
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') finish(false);
  };
  window.addEventListener('keydown', onKey);
  closeBtn.addEventListener('click', () => finish(false));
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) finish(false);
  });
  form.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finish(true);
  });

  const footer = document.createElement('div');
  footer.className = 'modal-footer';
  const cancel = document.createElement('button');
  cancel.textContent = 'Отмена';
  cancel.dataset.testid = 'meta-cancel';
  cancel.addEventListener('click', () => finish(false));
  const save = document.createElement('button');
  save.className = 'primary';
  save.textContent = 'Сохранить';
  save.dataset.testid = 'meta-save';
  save.addEventListener('click', () => finish(true));
  footer.appendChild(cancel);
  footer.appendChild(save);
  modal.appendChild(footer);

  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);
  inputs.get('artist')?.focus();
}
