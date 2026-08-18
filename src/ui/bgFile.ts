/**
 * Shared background-file loading (image or MP4), used by BOTH entry points:
 * the timeline's quick canvas-row picker and the «Фон» settings card in the
 * style panel. Loading auto-switches `bgType` to 'image'/'video'.
 */
import { loadBgVideo } from '../lib/backgroundVideo';
import { invalidateBgImageCache } from '../lib/render';
import { store } from '../state/store';
import type { ToastFn } from './controls';

export async function applyBgFile(f: File, toast: ToastFn): Promise<void> {
  const isVideo = f.type.startsWith('video/') || /\.mp4$/i.test(f.name);
  if (isVideo) {
    const bytes = new Uint8Array(await f.arrayBuffer());
    await loadBgVideo(bytes);
    store.mutate((p) => {
      p.background.bgType = 'video';
      p.background.bgVideoFileName = f.name;
    });
  } else {
    const dataUrl = await new Promise<string>((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result));
      r.onerror = () => rej(r.error);
      r.readAsDataURL(f);
    }).catch(() => null);
    if (!dataUrl) {
      toast('Не удалось прочитать файл фона', 'err');
      return;
    }
    store.mutate((p) => {
      p.background.bgType = 'image';
      p.background.bgImageDataUrl = dataUrl;
    });
    invalidateBgImageCache();
  }
}
