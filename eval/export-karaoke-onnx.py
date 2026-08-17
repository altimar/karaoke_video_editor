#!/usr/bin/env python
"""
Clean ONNX export of the aufr33/viperx karaoke MelBandRoformer from the
original training checkpoint (kfn/mel_band_roformer_karaoke_aufr33.ckpt).

Reproduces the host-STFT contract of the bdsqlsz export (input
stft_features [batch, frames, 4100] frames-major packed, output mask
[batch, stems, 2050, frames, 2]) by wrapping the checkpoint's
MelBandRoformer between its STFT and iSTFT: band gather -> band_split ->
transformers -> ALL mask estimators -> scatter + band-overlap averaging.

Everything between the wrapper's input and output mirrors
models/bs_roformer/mel_band_roformer.py::forward verbatim (minus torch.stft
/ torch.istft / loss plumbing), so the export stays faithful to the trained
graph. CPU-only: the Attend path degrades to explicit matmul+softmax
attention (no flash on CPU), which is what exports cleanly.

Usage:
  eval/.venv/bin/python eval/export-karaoke-onnx.py [out.onnx] [--frames 1101] [--half]
"""
import sys
import inspect
import yaml
import torch
from torch import nn

sys.path.insert(0, 'eval/msst')
from models.bs_roformer.mel_band_roformer import MelBandRoformer  # noqa: E402

CKPT = 'kfn/mel_band_roformer_karaoke_aufr33.ckpt'
CONFIG = 'kfn/config_mel_band_roformer_karaoke.yaml'


def load_model() -> MelBandRoformer:
    cfg = yaml.load(open(CONFIG), Loader=yaml.UnsafeLoader)  # !!python/tuple tags
    model_cfg = dict(cfg['model'])
    state = torch.load(CKPT, map_location='cpu', weights_only=False)
    n_stems = len({k.split('.')[1] for k in state if k.startswith('mask_estimators.')})
    model_cfg['num_stems'] = n_stems
    # Keep only kwargs the constructor actually accepts.
    sig = set(inspect.signature(MelBandRoformer.__init__).parameters)
    kwargs = {k: v for k, v in model_cfg.items() if k in sig}
    print(f'num_stems={n_stems}, ctor kwargs: {sorted(kwargs)}')
    m = MelBandRoformer(**kwargs)
    missing, unexpected = m.load_state_dict(state, strict=False)
    # Non-persistent buffers (freq_indices etc.) are regenerated, not stored.
    real_missing = [k for k in missing if 'freq_indices' not in k and 'num_' not in k]
    assert not real_missing, f'missing weights: {real_missing[:5]}'
    assert not unexpected, f'unexpected: {unexpected[:5]}'
    m.eval()
    return m


class HostSTFTMaskHead(nn.Module):
    """stft_features [b, t, 4100] -> averaged masks [b, n, 2050, t, 2]."""

    def __init__(self, m: MelBandRoformer):
        super().__init__()
        self.m = m

    def forward(self, stft_features: torch.Tensor) -> torch.Tensor:
        m = self.m
        # fp32 in / fp32 out even when the whole network runs in half: the
        # caller's contract is a float32 tensor interface (see --half).
        stft_features = stft_features.to(next(self.m.parameters()).dtype)
        b, t, last = stft_features.shape
        fs = last // 2  # packed (freq × stereo) axis = 2050; last = fs × complex

        # [b, t, (f s) c] -> [b, (f s), t, c]  (f-major packing, like packStft)
        x = stft_features.reshape(b, t, fs, 2).permute(0, 2, 1, 3)
        # band gather (with mel overlaps), then fold complex into features
        x = x[:, m.freq_indices]
        x = x.permute(0, 2, 1, 3).reshape(b, t, -1)

        x = m.band_split(x)

        store = [None] * len(m.layers)
        for i, transformer_block in enumerate(m.layers):
            if len(transformer_block) == 3:
                linear_transformer, time_transformer, freq_transformer = transformer_block
                shp0 = x.shape  # [b, t, f, d]
                x = linear_transformer(x.reshape(shp0[0], shp0[1] * shp0[2], shp0[3])).reshape(shp0)
            else:
                time_transformer, freq_transformer = transformer_block
            if m.skip_connection:
                for j in range(i):
                    x = x + store[j]
            # time axis: attend per frequency band — pack [b, f, t, d] -> [b*f, t, d]
            x = x.permute(0, 2, 1, 3)
            shp = x.shape
            x = time_transformer(x.reshape(shp[0] * shp[1], shp[2], shp[3])).reshape(shp)
            # freq axis: attend per time step — pack [b, t, f, d] -> [b*t, f, d]
            x = x.permute(0, 2, 1, 3)
            shp = x.shape
            x = freq_transformer(x.reshape(shp[0] * shp[1], shp[2], shp[3])).reshape(shp)
            # loop invariant: x leaves the iteration in [b, t, f, d]
            if m.skip_connection:
                store[i] = x

        heads = list(m.mask_estimators)
        n = len(heads)
        masks = torch.stack([fn(x) for fn in heads], dim=1)      # [b, n, t, F*2]
        f_gathered = masks.shape[-1] // 2
        masks = masks.reshape(b, n, t, f_gathered, 2).permute(0, 1, 3, 2, 4)  # [b, n, F, t, 2]

        # scatter into the full packed (f s) axis and average band overlaps
        full = torch.zeros(b, n, fs, t, 2, dtype=masks.dtype)
        scatter_indices = m.freq_indices.view(1, 1, -1, 1, 1).expand(b, n, -1, t, 2)
        masks_summed = full.scatter_add(2, scatter_indices, masks)
        denom = m.num_bands_per_freq.repeat_interleave(2).clamp(min=1e-4 if masks.dtype == torch.float16 else 1e-8)
        return (masks_summed / denom.view(1, 1, fs, 1, 1)).to(torch.float32)


def main() -> None:
    out_path = 'kfn/karaoke-clean-fp32.onnx'
    frames = 1101
    argv = sys.argv[1:]
    half = '--half' in argv
    if half:
        argv.remove('--half')
        out_path = 'kfn/karaoke-clean-fp16.onnx'
    if argv and not argv[0].startswith('--'):
        out_path = argv.pop(0)
    if '--frames' in argv:
        frames = int(argv[argv.index('--frames') + 1])

    model = load_model()
    wrapper = HostSTFTMaskHead(model).eval()
    if half:
        # RMSNorm is F.normalize(x, dim=-1): the sum of squares over ~8k
        # feature dims OVERFLOWS fp16 range (65504) on vocal-heavy inputs →
        # Inf → x/Inf = exact zeros → a silent all-zero mask. Keep the norm
        # reduction in fp32 (cast in/out); everything else stays fp16.
        import torch.nn.functional as F
        from models.bs_roformer.mel_band_roformer import RMSNorm as MBRMSNorm

        def _rms_norm_fp32(self, x: torch.Tensor) -> torch.Tensor:
            dtype = x.dtype
            x = F.normalize(x.float(), dim=-1) * self.scale
            return x.to(dtype) * self.gamma

        MBRMSNorm.forward = _rms_norm_fp32  # type: ignore[method-assign]
        wrapper = wrapper.half()

    # Smoke-test the wrapper (shape + finite range). The numeric fidelity
    # check runs later: the exported ONNX vs the bdsqlsz reference model on
    # the same input (they share the exact contract).
    torch.manual_seed(0)
    dummy = torch.randn(1, frames, 4100) * 0.05
    with torch.no_grad():
        ours = wrapper(dummy)
        print('wrapper out:', tuple(ours.shape), 'range',
              float(ours.min()), float(ours.max()))
        assert ours.shape == (1, len(model.mask_estimators), 2050, frames, 2)
        assert torch.isfinite(ours).all()

    torch.onnx.export(
        wrapper,
        (dummy,),
        out_path,
        input_names=['stft_features'],
        output_names=['mask'],
        dynamic_axes={
            'stft_features': {0: 'batch_size', 1: 'num_frames'},
            'mask': {0: 'batch_size', 3: 'num_frames'},
        },
        opset_version=17,
        dynamo=False,
    )
    print('exported ->', out_path)


if __name__ == '__main__':
    main()
