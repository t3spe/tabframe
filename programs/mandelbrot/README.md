# mandelbrot

Renders one 2048×1280 frame of the Mandelbrot set as 640 tiles of 64×64 pixels (32 columns by 20
rows), with smooth escape-time colouring and a palette that cycles every 48 iterations. It is the
machine's default loop: while anyone watches, frame follows frame and the preset advances each time.

## How it works

- **Stage 0, `render`.** `plan` emits 640 tasks over a declared 2048×1280 canvas, ordered from the
  centre outwards so the picture fills from the middle. Each task's input is 54 bytes: the centre and
  scale of the view (three f64), the iteration limit, the canvas size, the palette and supersampling
  factor, and the tile's rectangle. `run` writes `w × h × 4` bytes of RGBA, alpha always 255.
- **Stage 1.** `plan` ends the execution with a follow-up: `{ preset: (preset + 1) mod 8, palette }`,
  which is how the loop advances one preset per frame.
- Interior points short-circuit through the cardioid and period-2 bulb tests and a periodicity check;
  each preset's `maxIter` and supersampling are paced so a worst-case tile stays under the two-second
  deadline floor in a browser (`ss² × maxIter` around 7000).
- Pure f64 arithmetic and AssemblyScript's own `Math`: identical bytes on every core, which is what
  the redundancy toggle verifies.

## Parameters

| Name | Meaning | Default |
|---|---|---|
| `preset` | which view, wrapped modulo 8: overview, seahorse valley, elephant valley, triple spiral, antenna minibrot, double spiral, Feigenbaum point, Julia island | `0` |
| `palette` | `ocean`, `fire`, or `mono`; anything else is `ocean` | `"ocean"` |

No inputs under `in/`; no filesystem use; the only import is `env.abort`; memory maximum 256 pages.

## Checked by

`goldens.json` holds the sha-256 of every tile for the default parameters, plus CPU time per tile
(`mise run goldens`; `--all --sample 16` times every preset). `packages/sdk-as/test/mandelbrot.test.ts`
checks the module's shape, the plan's geometry and ordering, the palettes, and every 40th tile
against the goldens; the control plane's end-to-end test, the browser suite's money shot, and the
churn simulation compare against the same hashes.
