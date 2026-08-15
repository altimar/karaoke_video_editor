// Parse the local ONNX protobuf and print graph input/output shapes.
import { readFileSync } from 'node:fs';
import protobuf from 'onnx-proto';

const ModelProto = (protobuf.default ?? protobuf).onnx.ModelProto;
const buf = readFileSync(process.argv[2] ?? 'kfn/karaoke-aufr33.onnx');
const model = ModelProto.decode(buf);
const graph = model.graph;

const dimStr = (t) =>
  (t.type?.tensorType?.shape?.dim ?? []).map((d) =>
    d.dimParam ?? d.dimValue ?? '?',
  ).join('×') || 'scalar';

console.log('opset:', model.opsetImport.map((o) => `${o.domain || 'ai.onnx'}:${o.version}`).join(', '));
console.log('nodes:', graph.node.length, 'initializers:', graph.initializer.length);
for (const inp of graph.input) {
  if (!graph.initializer.some((i) => i.name === inp.name)) {
    console.log('INPUT ', inp.name, `[${dimStr(inp)}]`);
  }
}
for (const out of graph.output) {
  console.log('OUTPUT', out.name, `[${dimStr(out)}]`);
}
// Op type census — helps spot WebGPU-unsupported ops.
const ops = {};
for (const n of graph.node) ops[n.opType] = (ops[n.opType] ?? 0) + 1;
console.log('ops:', Object.entries(ops).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(' '));
