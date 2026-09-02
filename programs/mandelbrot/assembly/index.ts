// Mandelbrot: the machine's default program (design §5.6). One stage of 640 tiles per frame, RGBA
// output with smooth coloring, and a follow-up that advances to the next preset so the default
// loop never runs out of work. Pure f64 arithmetic plus AssemblyScript's own Math: deterministic
// everywhere, and no NaN can reach the output.
import {
  ByteReader,
  ByteWriter,
  done,
  emit,
  Params,
  readPlanInput,
  readRunInput,
  stage,
} from "@tabframe/sdk-as/assembly/index";

export { alloc } from "@tabframe/sdk-as/assembly/index";

const CANVAS_W: u32 = 2048;
const CANVAS_H: u32 = 1280;
const TILE: u32 = 64;
const COLS: u32 = CANVAS_W / TILE; // 32
const ROWS: u32 = CANVAS_H / TILE; // 20
const ESCAPE2: f64 = 256.0; // |z|² beyond which the orbit has escaped (R = 16)
const CYCLE: f64 = 48.0; // iterations per palette cycle

class Preset {
  constructor(
    public name: string,
    public cx: f64,
    public cy: f64,
    public width: f64,
    public maxIter: u32,
    /** Supersampling factor per axis: ss² orbits per pixel. Cost scales with ss², so it is the pacing knob for regions that escape fast. */
    public ss: u8,
  ) {}
}

// Widths are in complex-plane units across the 2048-pixel canvas; maxIter and ss are tuned so one
// core takes about a minute per frame (measurements in the WP document).
const PRESETS: Preset[] = [
  new Preset("overview", -0.75, 0.0, 3.5, 6000, 2),
  new Preset("seahorse valley", -0.7436, 0.1314, 0.003, 13000, 6),
  new Preset("elephant valley", 0.2755, 0.006, 0.01, 1200, 2),
  new Preset("triple spiral", -0.088, 0.654, 0.005, 6500, 4),
  new Preset("antenna minibrot", -1.7549, 0.0, 0.01, 750, 2),
  new Preset("double spiral", -0.1607, 1.0376, 0.0003, 30000, 4),
  new Preset("feigenbaum", -1.4012, 0.0, 0.002, 9000, 5),
  new Preset("julia island", -1.7688, -0.0017, 0.00001, 3400, 3),
];

const PALETTES: string[] = ["ocean", "fire", "mono"];

function paletteId(name: string): u8 {
  for (let i = 0; i < PALETTES.length; i++) if (PALETTES[i] == name) return <u8>i;
  return 0;
}

// Centre-out ordering: tiles closest to the canvas centre first, so the image grows from the middle.
let tileDist: Float64Array = new Float64Array(0);

function byDistance(a: i32, b: i32): i32 {
  const da = tileDist[a];
  const db = tileDist[b];
  if (da < db) return -1;
  if (da > db) return 1;
  return a - b;
}

export function plan(ptr: usize, len: i32): usize {
  const input = readPlanInput(ptr, len);
  let preset = input.params.getI32("preset", 0) % PRESETS.length;
  if (preset < 0) preset += PRESETS.length;
  const paletteName = input.params.getString("palette", "ocean");
  const palette = paletteId(paletteName);

  if (input.stage != 0) {
    const next = new Params();
    next.setI32("preset", (preset + 1) % PRESETS.length);
    next.setString("palette", PALETTES[palette]);
    return emit(done(next));
  }

  const p = PRESETS[preset];
  const scale = p.width / <f64>CANVAS_W;
  const count = <i32>(COLS * ROWS);
  tileDist = new Float64Array(count);
  const order = new Array<i32>(count);
  for (let i = 0; i < count; i++) {
    const col = <f64>(i % <i32>COLS);
    const row = <f64>(i / <i32>COLS);
    const dx = col * <f64>TILE + <f64>TILE / 2.0 - <f64>CANVAS_W / 2.0;
    const dy = row * <f64>TILE + <f64>TILE / 2.0 - <f64>CANVAS_H / 2.0;
    tileDist[i] = dx * dx + dy * dy;
    order[i] = i;
  }
  order.sort(byDistance);

  const s = stage("render").canvas(CANVAS_W, CANVAS_H);
  for (let k = 0; k < count; k++) {
    const i = order[k];
    const x = <i32>((i % <i32>COLS) * <i32>TILE);
    const y = <i32>((i / <i32>COLS) * <i32>TILE);
    const w = new ByteWriter(64);
    w.f64(p.cx).f64(p.cy).f64(scale).u32(p.maxIter).u32(CANVAS_W).u32(CANVAS_H).u8(palette).u8(p.ss);
    w.i32(x).i32(y).i32(<i32>TILE).i32(<i32>TILE);
    s.taskAt(w.toBytes(), x, y, <i32>TILE, <i32>TILE);
  }
  return emit(s.toBytes());
}

// Palette stops: five RGB anchors, interpolated linearly over t in [0, 1).
const STOPS: StaticArray<f64> = [
  // ocean
  0.00, 0.02, 0.10, 0.02, 0.40, 0.80, 0.55, 0.90, 1.00, 0.95, 0.98, 0.90, 0.10, 0.30, 0.70,
  // fire
  0.05, 0.00, 0.00, 0.60, 0.05, 0.00, 1.00, 0.55, 0.00, 1.00, 0.95, 0.40, 0.30, 0.00, 0.00,
  // mono
  0.02, 0.02, 0.02, 0.35, 0.35, 0.35, 0.75, 0.75, 0.75, 1.00, 1.00, 1.00, 0.20, 0.20, 0.20,
];

function channel(palette: i32, stop: i32, c: i32): f64 {
  return STOPS[palette * 15 + stop * 3 + c];
}

// Supersampling: ss² orbits per pixel, colors averaged. It antialiases the boundary and spreads
// compute evenly across tiles, which keeps interior tiles under the scheduler's deadline floor.

/** Packed 0x00RRGGBB for one sample point, or 0 for an interior point. */
function sample(cr: f64, ci: f64, maxIter: u32, palette: i32): u32 {
  let zr = 0.0;
  let zi = 0.0;
  let zr2 = 0.0;
  let zi2 = 0.0;
  let n: u32 = 0;
  while (n < maxIter && zr2 + zi2 <= ESCAPE2) {
    zi = 2.0 * zr * zi + ci;
    zr = zr2 - zi2 + cr;
    zr2 = zr * zr;
    zi2 = zi * zi;
    n++;
  }
  if (n >= maxIter) return 0;
  // Smooth iteration count; log2 arguments are > 0 because the orbit escaped past R² = 256.
  const mu = <f64>n + 1.0 - Math.log2(0.5 * Math.log2(zr2 + zi2));
  let t = mu / CYCLE;
  t = t - Math.floor(t);
  const pos = t * 4.0;
  let stop = <i32>Math.floor(pos);
  if (stop > 3) stop = 3;
  const f = pos - <f64>stop;
  let packed: u32 = 0;
  for (let c = 0; c < 3; c++) {
    const a = channel(palette, stop, c);
    const b = channel(palette, stop + 1, c);
    const v = <u32>((a + (b - a) * f) * 255.0 + 0.5);
    packed = (packed << 8) | (v > 255 ? 255 : v);
  }
  return packed;
}

export function run(ptr: usize, len: i32): usize {
  const task = readRunInput(ptr, len);
  const r = new ByteReader(task.input);
  const cx = r.f64();
  const cy = r.f64();
  const scale = r.f64();
  const maxIter = r.u32();
  const canvasW = r.u32();
  const canvasH = r.u32();
  const palette = <i32>r.u8();
  let SS = <i32>r.u8();
  if (SS < 1) SS = 1;
  if (SS > 8) SS = 8;
  const tx = r.i32();
  const ty = r.i32();
  const tw = r.i32();
  const th = r.i32();

  const out = new Uint8Array(tw * th * 4);
  const halfW = <f64>canvasW / 2.0;
  const halfH = <f64>canvasH / 2.0;
  const sub = scale / <f64>SS;
  const samples = <u32>(SS * SS);
  let o = 0;
  for (let py = 0; py < th; py++) {
    for (let px = 0; px < tw; px++) {
      let rSum: u32 = 0;
      let gSum: u32 = 0;
      let bSum: u32 = 0;
      for (let sy = 0; sy < SS; sy++) {
        const ci = cy - ((<f64>(ty + py) - halfH) * scale + (<f64>sy + 0.5) * sub);
        for (let sx = 0; sx < SS; sx++) {
          const cr = cx + (<f64>(tx + px) - halfW) * scale + (<f64>sx + 0.5) * sub;
          const packed = sample(cr, ci, maxIter, palette);
          rSum += (packed >> 16) & 255;
          gSum += (packed >> 8) & 255;
          bSum += packed & 255;
        }
      }
      out[o] = <u8>((rSum + samples / 2) / samples);
      out[o + 1] = <u8>((gSum + samples / 2) / samples);
      out[o + 2] = <u8>((bSum + samples / 2) / samples);
      out[o + 3] = 255;
      o += 4;
    }
  }
  return emit(out);
}
