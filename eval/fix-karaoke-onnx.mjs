// Graph surgery: replace Einsum ops (which blow WebGPU's 10-storage-buffer
// shader limit) with equivalent Transpose/MatMul/Mul subgraphs.
//   'b h i d, b h j d -> b h i j'  → Transpose(B, 0,1,3,2) + MatMul
//   'b h i j, b h j d -> b h i d'  → MatMul
//   '..., f -> ... f'              → Mul (numpy trailing broadcast)
import { readFileSync, writeFileSync } from 'node:fs';
import protobuf from 'onnx-proto';
const onnxP = (protobuf.default ?? protobuf).onnx;

const inPath = process.argv[2] ?? 'kfn/karaoke-aufr33.onnx';  // HF: bdsqlsz/mel_band_roformer_karaoke_aufr33-ONNX
const outPath = process.argv[3] ?? 'kfn/karaoke-aufr33-fixed.onnx';
const model = onnxP.ModelProto.decode(readFileSync(inPath));
const graph = model.graph;

const EQ_QK = 'b h i d, b h j d -> b h i j';
const EQ_AV = 'b h i j, b h j d -> b h i d';
const EQ_MUL = '..., f -> ... f';

// Shared int64[1] constant == [1] for Unsqueeze axes inputs (opset 13+).
const AXIS1_INITIALIZER = '__axis1';
// Deduped small int64[] initializers for Split `split` inputs.
const initCache = new Map();
const int64Init = (values) => {
  const key = values.join(',');
  if (initCache.has(key)) return initCache.get(key);
  const name = `__i64_${initCache.size}`;
  graph.initializer.push(onnxP.TensorProto.create({
    name,
    dataType: onnxP.TensorProto.DataType.INT64,
    dims: [values.length],
    int64Data: values,
  }));
  initCache.set(key, name);
  return name;
};
graph.initializer.push(onnxP.TensorProto.create({
  name: AXIS1_INITIALIZER,
  dataType: onnxP.TensorProto.DataType.INT64,
  dims: [1],
  int64Data: [1],
}));

const newNode = (name, opType, inputs, outputs, attrs = []) =>
  onnxP.NodeProto.create({ name, opType, input: inputs, output: outputs, attribute: attrs });

const splitAttrInt = (node, name) => {
  const a = node.attribute.find((x) => x.name === name);
  return a ? a.i : null;
};

/**
 * Replace a many-output Split with a binary tree of 2-output Splits: each
 * kernel then binds ≤2 storage buffers (WebGPU caps at 10 per shader).
 * Uneven divisions pass explicit `split` size inputs (static counts).
 */
function splitTree(inputName, outNames, sizes, axis, nameBase, nodes) {
  if (outNames.length === 1) return; // parent already wrote directly to this name
  const half = Math.ceil(outNames.length / 2);
  const left = outNames.slice(0, half);
  const right = outNames.slice(half);
  const leftSizes = sizes ? sizes.slice(0, half) : null;
  const rightSizes = sizes ? sizes.slice(half) : null;
  const leftName = left.length === 1 ? left[0] : `${nameBase}_L`;
  const rightName = right.length === 1 ? right[0] : `${nameBase}_R`;
  const attrs = [onnxP.AttributeProto.create({ name: 'axis', type: onnxP.AttributeProto.AttributeType.INT, i: axis })];
  const inputs = [inputName];
  if (sizes) {
    inputs.push(int64Init([leftSizes.reduce((a, b) => a + b, 0), rightSizes.reduce((a, b) => a + b, 0)]));
  }
  nodes.push(newNode(`${nameBase}_sp`, 'Split', inputs, [leftName, rightName], attrs));
  splitTree(leftName, left, leftSizes, axis, `${nameBase}_L`, nodes);
  splitTree(rightName, right, rightSizes, axis, `${nameBase}_R`, nodes);
}

let replaced = 0;
let splitsFixed = 0;
const newNodes = [];
for (const node of graph.node) {
  if (node.opType === 'Split' && node.output.length > 10) {
    const axis = splitAttrInt(node, 'axis') ?? 0;
    // The original sizes live in the optional `split` input (uneven mel bands).
    const tensorI64 = (tp) => {
      if (!tp) return null;
      let vals = Array.from(tp.int64Data ?? [], Number);
      if (vals.length === 0 && tp.rawData?.length) {
        const dv = new DataView(tp.rawData.buffer, tp.rawData.byteOffset, tp.rawData.byteLength);
        vals = [];
        for (let o = 0; o + 8 <= dv.byteLength; o += 8) vals.push(Number(dv.getBigInt64(o, true)));
      }
      return vals.length ? vals : null;
    };
    // Sizes may live in an initializer OR a Constant node's output.
    const initTp = node.input[1] && graph.initializer.find((i) => i.name === node.input[1]);
    const constNode = node.input[1] && graph.node.find((n) => n.opType === 'Constant' && n.output.includes(node.input[1]));
    const constTp = constNode?.attribute.find((a) => a.name === 'value')?.t;
    let sizes = tensorI64(initTp) ?? tensorI64(constTp) ?? null;
    console.log('wide Split:', node.name, 'outputs:', node.output.length, 'inputs:', JSON.stringify(node.input), 'attrs:', node.attribute.map((a) => a.name + '=' + (a.i ?? '…')).join(','), 'sizes:', sizes ? sizes.length + ' entries, sum=' + sizes.reduce((a, b) => a + b, 0) : 'none');
    splitTree(node.input[0], [...node.output], sizes, axis, node.name || 'split', newNodes);
    splitsFixed++;
    continue;
  }
  if (node.opType !== 'Einsum') {
    newNodes.push(node);
    continue;
  }
  const eqAttr = node.attribute.find((a) => a.name === 'equation');
  const eq = eqAttr ? Buffer.from(eqAttr.s).toString('ascii').replace(/\s+/g, ' ').trim() : '';
  const [a, b, out] = [node.input[0], node.input[1], node.output[0]];
  if (eq === EQ_QK) {
    const tName = `${node.name || 'einsum'}_kt`;
    newNodes.push(newNode(`${node.name}_transpose`, 'Transpose', [b], [tName],
      [onnxP.AttributeProto.create({ name: 'perm', type: onnxP.AttributeProto.AttributeType.INTS, ints: [0, 1, 3, 2] })]));
    newNodes.push(newNode(node.name, 'MatMul', [a, tName], [out]));
  } else if (eq === EQ_AV) {
    newNodes.push(newNode(node.name, 'MatMul', [a, b], [out]));
  } else if (eq === EQ_MUL) {
    // '..., f -> ... f' with rank-1 A (verified empirically): outer product —
    // Unsqueeze A's tail so ONNX Mul's trailing broadcast produces [..., f].
    // opset 13+: Unsqueeze takes axes as a second INPUT (shared initializer).
    const aName = `${node.name || 'einsum'}_a`;
    newNodes.push(newNode(`${node.name}_unsqueeze`, 'Unsqueeze', [a, AXIS1_INITIALIZER], [aName]));
    newNodes.push(newNode(node.name, 'Mul', [aName, b], [out]));
  } else {
    throw new Error(`Unhandled Einsum equation: "${eq}"`);
  }
  replaced++;
}
graph.node = newNodes;
console.log(`replaced ${replaced} Einsum ops, rebuilt ${splitsFixed} wide Splits → ${outPath}`);
writeFileSync(outPath, onnxP.ModelProto.encode(model).finish());
