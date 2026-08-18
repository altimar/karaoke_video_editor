"""Export the multilingual MMS forced aligner → single-file ONNX (fp32), then
fp16-convert it. Input: input_values [B,T] float32 @16 kHz → logits [B,F,31]
(31-token lowercase romanized vocab, `<blank>`=0, no word separator).

Model: MahmoudAshraf/mms-300m-1130-forced-aligner — HF-transformers conversion
of torchaudio's MMS_FA (facebook/mms-300m trained for alignment on 1130
languages). Text must be uroman-romanized before tokenization (see
src/lib/alignment/romanize.ts). License of the weights: CC-BY-NC-4.0.

Usage (venv with torch, transformers, onnx, onnxruntime, onnxscript,
onnxconverter-common):
    python eval/export-mms-align.py
Outputs (into kfn/, gitignored): mms-300m-align.onnx (+fp16).
Uploaded to HF: Project42/mms-300m-align.
"""
import numpy as np
import onnx
import onnxruntime as ort
import torch
from onnxconverter_common import float16
from transformers import Wav2Vec2ForCTC

OUT = 'kfn/mms-300m-align.onnx'
OUT16 = 'kfn/mms-300m-align-fp16.onnx'

model = Wav2Vec2ForCTC.from_pretrained('MahmoudAshraf/mms-300m-1130-forced-aligner')
model.eval()
assert model.config.vocab_size == 31, model.config.vocab_size


class Core(torch.nn.Module):
    def __init__(self, m):
        super().__init__()
        self.m = m

    def forward(self, input_values):
        return self.m(input_values=input_values).logits


core = Core(model)
dummy = torch.randn(1, 16000, dtype=torch.float32) * 0.1
with torch.no_grad():
    ref = core(dummy).numpy()

torch.onnx.export(
    core, dummy, OUT,
    input_names=['input_values'], output_names=['logits'],
    dynamic_axes={'input_values': {0: 'batch', 1: 'time'}, 'logits': {0: 'batch', 1: 'frames'}},
    opset_version=17, do_constant_folding=True, dynamo=False,
)

# The exporter may write external data — embed into one file (<2 GB).
m = onnx.load(OUT, load_external_data=True)
onnx.save_model(m, OUT, save_as_external_data=False)

# Parity fp32.
x = dummy.numpy()
got = ort.InferenceSession(OUT, providers=['CPUExecutionProvider']).run(None, {'input_values': x})[0]
diff = float(np.abs(ref - got).max())
print('torch vs onnx maxAbsDiff:', diff)
assert diff < 1e-2

# fp16 conversion (fp32 I/O preserved).
m16 = float16.convert_float_to_float16(onnx.load(OUT), keep_io_types=True)
onnx.save_model(m16, OUT16, save_as_external_data=False)
a = ort.InferenceSession(OUT, providers=['CPUExecutionProvider']).run(None, {'input_values': x})[0]
b = ort.InferenceSession(OUT16, providers=['CPUExecutionProvider']).run(None, {'input_values': x})[0]
print('fp32 vs fp16 maxAbsDiff:', float(np.abs(a - b).max()))
print('done:', OUT, OUT16)
