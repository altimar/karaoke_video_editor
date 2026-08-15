// Numeric check: original vs einsum-fixed graph on the same random input (CPU).
import ort from 'onnxruntime-node';
const run = async (path) => {
  const s = await ort.InferenceSession.create(path, { executionProviders: ['cpu'] });
  const T = 192;
  const data = new Float32Array(T * 4100);
  let seed = 7;
  for (let i = 0; i < data.length; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; data[i] = (seed / 0x7fffffff - 0.5) * 0.2; }
  const out = await s.run({ [s.inputNames[0]]: new ort.Tensor('float32', data, [1, T, 4100]) });
  return out[s.outputNames[0]].data;
};
const a = await run('kfn/karaoke-aufr33.onnx');
const b = await run('kfn/karaoke-aufr33-fixed.onnx');
let maxDiff = 0;
for (let i = 0; i < a.length; i++) maxDiff = Math.max(maxDiff, Math.abs(a[i] - b[i]));
console.log(`outputs: ${a.length} values, maxAbsDiff=${maxDiff.toExponential(3)} ${maxDiff < 1e-4 ? '✅ identical' : '❌ MISMATCH'}`);
