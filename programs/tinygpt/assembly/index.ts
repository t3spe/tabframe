// Tiny GPT (WP6.5): a character-level transformer predicting the next byte, its whole forward pass
// in this module. The weights come from the bundle (/in/weights.bin, int8 with one f32 scale per
// tensor, exported by programs/tinygpt/train/train.py); one task is one continuation — a prompt,
// a token count — decoded greedily, so the same bytes come out of every core (redundancy on
// verifies it). Plan: one stage, one task per prompt in the params; the output is UTF-8 text.
//
// The model: byte vocabulary, context 128, 4 layers, 4 heads, width 128, pre-norm, GELU (tanh
// form), learned positions, tied output embedding. Everything is f32 arithmetic in a fixed order.
import {
  ByteReader,
  ByteWriter,
  done,
  emit,
  fs,
  log,
  readPlanInput,
  readRunInput,
  stage,
} from "@tabframe/sdk-as/assembly/index";
export { alloc } from "@tabframe/sdk-as/assembly/index";

const MAGIC: u32 = 0x54475054;
const WEIGHTS = "/in/weights.bin";
const MAX_PROMPTS = 64;

// ---- plan ---------------------------------------------------------------------------------------

export function plan(ptr: usize, len: i32): usize {
  const input = readPlanInput(ptr, len);
  if (input.stage == 1) {
    // Stage 1: one task gathers every continuation into the text the dashboard shows.
    const c = stage("collect");
    c.task(new ByteWriter().u32(<u32>input.params.getI32("count", 0)).toBytes());
    return emit(c.toBytes());
  }
  if (input.stage != 0) return emit(done(null));
  const prompts = input.params.getString("prompts", "Call me Ishmael").split("|");
  const tokens = <u32>input.params.getI32("tokens", 96);
  const s = stage("generate");
  let count = 0;
  for (let i = 0; i < prompts.length && count < MAX_PROMPTS; i++) {
    const p = prompts[i].trim();
    if (p.length == 0) continue;
    s.task(new ByteWriter().str(p).u32(tokens).toBytes());
    count++;
  }
  if (count == 0) s.task(new ByteWriter().str("Call me Ishmael").u32(tokens).toBytes());
  return emit(s.toBytes());
}

// ---- the model ----------------------------------------------------------------------------------

class Tensor {
  data: Float32Array;
  constructor(data: Float32Array) {
    this.data = data;
  }
}

class Model {
  vocab: i32 = 0;
  ctx: i32 = 0;
  layers: i32 = 0;
  heads: i32 = 0;
  width: i32 = 0;
  symbols: Uint8Array = new Uint8Array(0);
  tok: Float32Array = new Float32Array(0);
  pos: Float32Array = new Float32Array(0);
  // Per layer, in order: ln1.w ln1.b qkv.w qkv.b proj.w proj.b ln2.w ln2.b fc.w fc.b out.w out.b
  layerTensors: Array<Float32Array> = new Array<Float32Array>();
  lnfW: Float32Array = new Float32Array(0);
  lnfB: Float32Array = new Float32Array(0);
}

let model: Model | null = null;

/** Read one int8 tensor (f32 scale, u32 count, count bytes) into f32. */
function readTensor(r: ByteReader): Float32Array {
  const scale = r.f32();
  const count = <i32>r.u32();
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) out[i] = <f32>(<i8>r.u8()) * scale;
  return out;
}

function loadModel(): Model {
  if (model !== null) return model as Model;
  const bytes = fs.read(WEIGHTS);
  if (bytes === null) abort("weights missing: /in/weights.bin is not in the bundle");
  const r = new ByteReader(bytes as Uint8Array);
  if (r.u32() != MAGIC) abort("not a tinygpt weights file");
  const version = r.u32();
  if (version != 1) abort("unsupported weights version");
  const m = new Model();
  m.vocab = <i32>r.u32();
  m.ctx = <i32>r.u32();
  m.layers = <i32>r.u32();
  m.heads = <i32>r.u32();
  m.width = <i32>r.u32();
  m.symbols = new Uint8Array(m.vocab);
  for (let i = 0; i < m.vocab; i++) m.symbols[i] = r.u8();
  m.tok = readTensor(r);
  m.pos = readTensor(r);
  for (let l = 0; l < m.layers; l++) {
    for (let t = 0; t < 12; t++) m.layerTensors.push(readTensor(r));
  }
  m.lnfW = readTensor(r);
  m.lnfB = readTensor(r);
  model = m;
  return m;
}

/** y = W x + b for W stored [out, in] row-major (torch's Linear layout). */
function linear(w: Float32Array, b: Float32Array, x: Float32Array, y: Float32Array, outDim: i32, inDim: i32): void {
  for (let o = 0; o < outDim; o++) {
    let s: f32 = 0;
    const row = o * inDim;
    for (let i = 0; i < inDim; i++) s += w[row + i] * x[i];
    y[o] = s + b[o];
  }
}

function layerNorm(x: Float32Array, w: Float32Array, b: Float32Array, y: Float32Array, n: i32): void {
  let mean: f32 = 0;
  for (let i = 0; i < n; i++) mean += x[i];
  mean /= <f32>n;
  let variance: f32 = 0;
  for (let i = 0; i < n; i++) {
    const d = x[i] - mean;
    variance += d * d;
  }
  variance /= <f32>n;
  const inv = <f32>1.0 / <f32>Math.sqrt(<f64>variance + 1e-5);
  for (let i = 0; i < n; i++) y[i] = (x[i] - mean) * inv * w[i] + b[i];
}

function gelu(x: f32): f32 {
  // The tanh approximation torch uses with approximate="tanh".
  const c: f32 = 0.7978845608028654; // sqrt(2/pi)
  const inner = c * (x + <f32>0.044715 * x * x * x);
  return <f32>0.5 * x * (<f32>1.0 + <f32>Math.tanh(<f64>inner));
}

/** One continuation: the prompt's symbols then `tokens` greedy steps. Returns all symbol ids. */
function generate(m: Model, prompt: Uint8Array, tokens: i32): Int32Array {
  const width = m.width;
  const heads = m.heads;
  const hd = width / heads;
  const ctx = m.ctx;
  const total = <i32>Math.min(<f64>(prompt.length + tokens), <f64>ctx);
  const ids = new Int32Array(prompt.length + tokens);
  // Symbol lookup: byte → id (bytes not in the vocabulary map to the first symbol).
  const lookup = new Int32Array(256);
  for (let i = 0; i < m.vocab; i++) lookup[m.symbols[i]] = i;
  for (let i = 0; i < prompt.length; i++) ids[i] = lookup[prompt[i]];
  // KV cache per layer: [ctx][width]
  const kCache = new Array<Float32Array>(m.layers);
  const vCache = new Array<Float32Array>(m.layers);
  for (let l = 0; l < m.layers; l++) {
    kCache[l] = new Float32Array(ctx * width);
    vCache[l] = new Float32Array(ctx * width);
  }
  const x = new Float32Array(width);
  const h = new Float32Array(width);
  const qkv = new Float32Array(3 * width);
  const att = new Float32Array(width);
  const tmp = new Float32Array(width);
  const ff = new Float32Array(4 * width);
  const scores = new Float32Array(ctx);
  const logits = new Float32Array(m.vocab);
  const scale = <f32>(1.0 / Math.sqrt(<f64>hd));
  let produced = 0;
  const limit = prompt.length + tokens;
  // Positions run 0..total-1; once the context is full the window slides (the cache is rebuilt
  // from the last ctx-1 symbols), which keeps the code simple at a cost only past 128 symbols.
  let start = 0;
  let t = 0; // position within the window
  let i = 0; // index into ids
  while (i < limit) {
    if (t == ctx) {
      // Slide: recompute from the last ctx/2 symbols.
      start = i - ctx / 2;
      t = 0;
      i = start;
    }
    const id = ids[i];
    for (let j = 0; j < width; j++) x[j] = m.tok[id * width + j] + m.pos[t * width + j];
    for (let l = 0; l < m.layers; l++) {
      const base = l * 12;
      const ln1w = m.layerTensors[base + 0];
      const ln1b = m.layerTensors[base + 1];
      const qkvW = m.layerTensors[base + 2];
      const qkvB = m.layerTensors[base + 3];
      const projW = m.layerTensors[base + 4];
      const projB = m.layerTensors[base + 5];
      const ln2w = m.layerTensors[base + 6];
      const ln2b = m.layerTensors[base + 7];
      const fcW = m.layerTensors[base + 8];
      const fcB = m.layerTensors[base + 9];
      const outW = m.layerTensors[base + 10];
      const outB = m.layerTensors[base + 11];
      layerNorm(x, ln1w, ln1b, h, width);
      linear(qkvW, qkvB, h, qkv, 3 * width, width);
      const kc = kCache[l];
      const vc = vCache[l];
      for (let j = 0; j < width; j++) {
        kc[t * width + j] = qkv[width + j];
        vc[t * width + j] = qkv[2 * width + j];
      }
      // Attention per head over positions 0..t.
      for (let hh = 0; hh < heads; hh++) {
        const off = hh * hd;
        let maxScore: f32 = -3.4e38;
        for (let p = 0; p <= t; p++) {
          let s: f32 = 0;
          for (let d = 0; d < hd; d++) s += qkv[off + d] * kc[p * width + off + d];
          s *= scale;
          scores[p] = s;
          if (s > maxScore) maxScore = s;
        }
        let sum: f32 = 0;
        for (let p = 0; p <= t; p++) {
          const e = <f32>Math.exp(<f64>(scores[p] - maxScore));
          scores[p] = e;
          sum += e;
        }
        for (let d = 0; d < hd; d++) {
          let acc: f32 = 0;
          for (let p = 0; p <= t; p++) acc += scores[p] * vc[p * width + off + d];
          att[off + d] = acc / sum;
        }
      }
      linear(projW, projB, att, tmp, width, width);
      for (let j = 0; j < width; j++) x[j] += tmp[j];
      layerNorm(x, ln2w, ln2b, h, width);
      linear(fcW, fcB, h, ff, 4 * width, width);
      for (let j = 0; j < 4 * width; j++) ff[j] = gelu(ff[j]);
      linear(outW, outB, ff, tmp, width, 4 * width);
      for (let j = 0; j < width; j++) x[j] += tmp[j];
    }
    // Next symbol: only needed once we are past the prompt (or at its last symbol).
    if (i >= prompt.length - 1 && i + 1 < limit) {
      layerNorm(x, m.lnfW, m.lnfB, h, width);
      let best = 0;
      let bestV: f32 = -3.4e38;
      for (let v = 0; v < m.vocab; v++) {
        let s: f32 = 0;
        const row = v * width;
        for (let j = 0; j < width; j++) s += m.tok[row + j] * h[j];
        logits[v] = s;
        if (s > bestV) {
          bestV = s;
          best = v;
        }
      }
      if (i + 1 >= prompt.length) {
        ids[i + 1] = best;
        produced++;
      }
    }
    i++;
    t++;
  }
  return ids;
}

// ---- run ------------------------------------------------------------------------------------------

export function run(ptr: usize, len: i32): usize {
  const task = readRunInput(ptr, len);
  if (task.stage == 1) return emit(collect());
  const r = new ByteReader(task.input);
  const prompt = r.str();
  const tokens = <i32>r.u32();
  const m = loadModel();
  const promptBytes = Uint8Array.wrap(String.UTF8.encode(prompt));
  const ids = generate(m, promptBytes, tokens);
  const out = new Uint8Array(ids.length);
  for (let i = 0; i < ids.length; i++) out[i] = m.symbols[ids[i]];
  log(`${prompt.length} prompt bytes, ${tokens} tokens, ${m.layers} layers × ${m.width}`);
  return emit(out);
}

/** Stage 1: the stage-0 outputs, in task order, joined into one text. */
function collect(): Uint8Array {
  const names = fs.list("/out/0/");
  // fs.list returns paths; keep them in task order by index.
  const parts = new Array<Uint8Array>();
  for (let i = 0; i < names.length; i++) {
    const bytes = fs.read(`/out/0/${i}`);
    if (bytes === null) break;
    parts.push(bytes as Uint8Array);
  }
  let total = 0;
  for (let i = 0; i < parts.length; i++) total += parts[i].length + 2;
  const out = new Uint8Array(total);
  let at = 0;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    out.set(p, at);
    at += p.length;
    out[at++] = 10; // newline
    out[at++] = 10;
  }
  return out;
}
