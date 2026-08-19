"""Build the LIGHT (fp16) variant of the phase-2 karaoke separation model.

Pipeline (original → fp16 → surgery → Cast sync):
  1. download the stock bdsqlsz export (fp32);
  2. convert to fp16 (onnxconverter-common, keep_io_types), with
     ScatterElements blocked — the CPU EP (and some WebGPU builds) can't run
     it in fp16 with reduction=add; it's tiny, fp32 there is fine;
  3. run the SAME graph surgery as the fp32 pipeline
     (eval/fix-karaoke-onnx.mjs: Einsum→MatMul, wide Split→binary trees);
  4. sync Cast nodes' `to` attribute with their OUTPUT edge type — the
     converter retypes edges but leaves the exporter's Cast attrs alone,
     which breaks ONNX Runtime's type checking.

Parity vs the hosted fp32 model (T=256, seeded input): maxAbsDiff 3.6e-4 on a
±0.18-range mask, meanAbsDiff 1.2e-7. Hosted as model_fp16.onnx in
Project42/mel-band-roformer-karaoke-webgpu (460 MB).

Usage (venv with onnx + onnxconverter-common; onnx-proto via npm):
    python eval/export-karaoke-fp16.py
Outputs into kfn/ (gitignored): karaoke-fp16.onnx.
"""
import os
import subprocess

import onnx
from onnx import TensorProto
from onnxconverter_common import float16
from onnxconverter_common.float16 import DEFAULT_OP_BLOCK_LIST

ORIG = 'https://huggingface.co/bdsqlsz/mel_band_roformer_karaoke_aufr33-ONNX/resolve/main/model.onnx'
OUT = 'kfn/karaoke-fp16.onnx'


def main() -> None:
    os.makedirs('kfn', exist_ok=True)
    orig_path = 'kfn/karaoke-aufr33.onnx'
    if not os.path.exists(orig_path):
        subprocess.run(['curl', '-sL', '-o', orig_path, ORIG], check=True)

    # --- 1. fp16 conversion (ScatterElements stays fp32: CPU/EP support). ---
    m = onnx.load(orig_path, load_external_data=False)
    m16 = float16.convert_float_to_float16(
        m, keep_io_types=True,
        op_block_list=set(DEFAULT_OP_BLOCK_LIST) | {'ScatterElements'},
    )
    converted = 'kfn/karaoke-orig-fp16.onnx'
    onnx.save_model(m16, converted, save_as_external_data=False)

    # --- 2. The same WebGPU-limit surgery as the fp32 pipeline. ---
    surgered = 'kfn/karaoke-orig-fp16-fixed.onnx'
    subprocess.run(['node', 'eval/fix-karaoke-onnx.mjs', converted, surgered], check=True)

    # --- 3. Sync Cast `to` attrs with their output edge declarations. ---
    m = onnx.load(surgered, load_external_data=False)
    g = m.graph
    types = {}
    for vi in list(g.value_info):
        types[vi.name] = vi.type.tensor_type.elem_type
    for i in g.input:
        types[i.name] = i.type.tensor_type.elem_type
    for o in g.output:
        types[o.name] = o.type.tensor_type.elem_type
    for init in g.initializer:
        types[init.name] = init.data_type
    fixed = 0
    for n in g.node:
        if n.op_type != 'Cast' or not n.output:
            continue
        to = next((a for a in n.attribute if a.name == 'to'), None)
        if to is None:
            continue
        out_t = types.get(n.output[0])
        if to.i == TensorProto.FLOAT and out_t == TensorProto.FLOAT16:
            to.i = TensorProto.FLOAT16
            fixed += 1
        elif to.i == TensorProto.FLOAT16 and out_t == TensorProto.FLOAT:
            to.i = TensorProto.FLOAT
            fixed += 1
    onnx.save_model(m, OUT, save_as_external_data=False)
    print(f'Cast attrs synced: {fixed}')
    print(f'done: {OUT} ({os.path.getsize(OUT) // (1024 * 1024)} MB)')


if __name__ == '__main__':
    main()
