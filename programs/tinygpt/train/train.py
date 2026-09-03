#!/usr/bin/env python3
"""Train a tiny character-level GPT on the word-count corpus and export it for the WASM program.

    python3 programs/tinygpt/train/train.py [--steps 3000] [--out programs/tinygpt/in]

Writes `weights.bin` (int8 tensors with per-tensor scales, a fixed header, the vocabulary) into the
program's bundle inputs, and `train/reference.json` (greedy continuations for a few prompts, computed by this script's own forward
pass with the *dequantised* weights — what the WASM module must reproduce token for token, up to
f32 rounding). CPU only; a few minutes.

The architecture is the smallest GPT that still reads like language after minutes of training:
byte vocabulary (the bytes that occur in the corpus), context 128, 4 layers, 4 heads, width 128,
GELU (tanh form), pre-norm, learned positions, tied output embedding — about 0.8 M parameters.
"""
import argparse
import json
import math
import struct
import sys
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

ROOT = Path(__file__).resolve().parents[3]
CORPUS = ROOT / "programs" / "wordcount" / "in" / "corpus.txt"
CTX, LAYERS, HEADS, WIDTH = 128, 4, 4, 128
MAGIC = 0x54475054  # "TGPT"


class Block(nn.Module):
    def __init__(self):
        super().__init__()
        self.ln1 = nn.LayerNorm(WIDTH)
        self.qkv = nn.Linear(WIDTH, 3 * WIDTH)
        self.proj = nn.Linear(WIDTH, WIDTH)
        self.ln2 = nn.LayerNorm(WIDTH)
        self.fc = nn.Linear(WIDTH, 4 * WIDTH)
        self.out = nn.Linear(4 * WIDTH, WIDTH)

    def forward(self, x):
        b, t, c = x.shape
        h = self.ln1(x)
        q, k, v = self.qkv(h).split(WIDTH, dim=2)
        q = q.view(b, t, HEADS, c // HEADS).transpose(1, 2)
        k = k.view(b, t, HEADS, c // HEADS).transpose(1, 2)
        v = v.view(b, t, HEADS, c // HEADS).transpose(1, 2)
        att = (q @ k.transpose(-2, -1)) / math.sqrt(c // HEADS)
        mask = torch.tril(torch.ones(t, t, device=x.device)).view(1, 1, t, t)
        att = att.masked_fill(mask == 0, float("-inf"))
        att = F.softmax(att, dim=-1)
        y = (att @ v).transpose(1, 2).contiguous().view(b, t, c)
        x = x + self.proj(y)
        x = x + self.out(F.gelu(self.fc(self.ln2(x)), approximate="tanh"))
        return x


class TinyGPT(nn.Module):
    def __init__(self, vocab):
        super().__init__()
        self.tok = nn.Embedding(vocab, WIDTH)
        self.pos = nn.Embedding(CTX, WIDTH)
        self.blocks = nn.ModuleList([Block() for _ in range(LAYERS)])
        self.lnf = nn.LayerNorm(WIDTH)
        self.vocab = vocab

    def forward(self, idx):
        b, t = idx.shape
        x = self.tok(idx) + self.pos(torch.arange(t, device=idx.device))
        for blk in self.blocks:
            x = blk(x)
        x = self.lnf(x)
        return x @ self.tok.weight.t()  # tied output embedding


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--steps", type=int, default=3000)
    ap.add_argument("--batch", type=int, default=32)
    ap.add_argument("--lr", type=float, default=3e-3)
    ap.add_argument("--out", default=str(ROOT / "programs" / "tinygpt" / "in"))
    ap.add_argument("--seed", type=int, default=1)
    args = ap.parse_args()
    torch.manual_seed(args.seed)
    np.random.seed(args.seed)

    data = CORPUS.read_bytes()
    vocab_bytes = sorted(set(data))
    stoi = {b: i for i, b in enumerate(vocab_bytes)}
    ids = torch.tensor([stoi[b] for b in data], dtype=torch.long)
    n = len(ids)
    split = int(n * 0.95)
    train, val = ids[:split], ids[split:]
    print(f"corpus {n} bytes, vocabulary {len(vocab_bytes)} symbols, train {split}, val {n - split}")

    model = TinyGPT(len(vocab_bytes))
    params = sum(p.numel() for p in model.parameters())
    print(f"parameters {params}")
    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, betas=(0.9, 0.95), weight_decay=0.1)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=args.steps, eta_min=args.lr / 10)

    def batch(src):
        ix = torch.randint(0, len(src) - CTX - 1, (args.batch,))
        x = torch.stack([src[i : i + CTX] for i in ix])
        y = torch.stack([src[i + 1 : i + CTX + 1] for i in ix])
        return x, y

    model.train()
    for step in range(1, args.steps + 1):
        x, y = batch(train)
        logits = model(x)
        loss = F.cross_entropy(logits.view(-1, logits.size(-1)), y.view(-1))
        opt.zero_grad(set_to_none=True)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        opt.step()
        sched.step()
        if step % 200 == 0 or step == 1:
            model.eval()
            with torch.no_grad():
                vx, vy = batch(val)
                vl = F.cross_entropy(model(vx).view(-1, logits.size(-1)), vy.view(-1)).item()
            model.train()
            print(f"step {step} train {loss.item():.3f} val {vl:.3f}", flush=True)

    model.eval()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    export(model, vocab_bytes, out / "weights.bin")
    reference(model, vocab_bytes, stoi, Path(__file__).resolve().parent / "reference.json")


def quantize(t: torch.Tensor):
    """Symmetric int8 with one f32 scale per tensor: q = round(x / scale), scale = max|x| / 127."""
    a = t.detach().float().cpu().numpy().astype(np.float32)
    scale = float(np.max(np.abs(a))) / 127.0 if a.size else 1.0
    if scale == 0.0:
        scale = 1.0
    q = np.clip(np.round(a / scale), -127, 127).astype(np.int8)
    return q, np.float32(scale)


def tensors(model):
    """The tensors in export order, each 2-D or 1-D (Linear weights as [out, in], torch's layout)."""
    yield "tok", model.tok.weight
    yield "pos", model.pos.weight
    for i, blk in enumerate(model.blocks):
        yield f"b{i}.ln1.w", blk.ln1.weight
        yield f"b{i}.ln1.b", blk.ln1.bias
        yield f"b{i}.qkv.w", blk.qkv.weight
        yield f"b{i}.qkv.b", blk.qkv.bias
        yield f"b{i}.proj.w", blk.proj.weight
        yield f"b{i}.proj.b", blk.proj.bias
        yield f"b{i}.ln2.w", blk.ln2.weight
        yield f"b{i}.ln2.b", blk.ln2.bias
        yield f"b{i}.fc.w", blk.fc.weight
        yield f"b{i}.fc.b", blk.fc.bias
        yield f"b{i}.out.w", blk.out.weight
        yield f"b{i}.out.b", blk.out.bias
    yield "lnf.w", model.lnf.weight
    yield "lnf.b", model.lnf.bias


def export(model, vocab_bytes, path: Path):
    """Header, vocabulary, then every tensor as (scale f32, int8 values) in export order.

    Layout (little-endian): u32 magic, u32 version=1, u32 vocab, u32 ctx, u32 layers, u32 heads,
    u32 width, then `vocab` bytes of symbol values, then per tensor: f32 scale, u32 count, count×i8.
    Biases and layer-norm parameters are quantised the same way; the dequantised values are what
    the reference uses, so the WASM module and the reference see the same numbers.
    """
    parts = [struct.pack("<7I", MAGIC, 1, len(vocab_bytes), CTX, LAYERS, HEADS, WIDTH), bytes(vocab_bytes)]
    total = 0
    for name, t in tensors(model):
        q, scale = quantize(t)
        parts.append(struct.pack("<fI", float(scale), q.size))
        parts.append(q.tobytes(order="C"))
        total += q.size
    path.write_bytes(b"".join(parts))
    print(f"wrote {path} ({path.stat().st_size} bytes, {total} weights)")


def dequantised_model(model):
    """The model with every tensor replaced by its dequantised int8 value: the reference."""
    import copy
    m = copy.deepcopy(model)
    with torch.no_grad():
        for name, t in tensors(m):
            q, scale = quantize(t)
            t.copy_(torch.from_numpy(q.astype(np.float32) * scale))
    m.eval()
    return m


def reference(model, vocab_bytes, stoi, path: Path):
    """Greedy continuations of a few prompts with the dequantised weights, as symbol indices."""
    m = dequantised_model(model)
    prompts = ["Call me Ishmael", "The whale", "It was", "Ahab"]
    out = []
    with torch.no_grad():
        for p in prompts:
            ids = [stoi[b] for b in p.encode("utf-8") if b in stoi]
            gen = []
            for _ in range(24):
                x = torch.tensor([ids[-CTX:]], dtype=torch.long)
                nxt = int(torch.argmax(m(x)[0, -1]).item())
                ids.append(nxt)
                gen.append(nxt)
            text = bytes(vocab_bytes[i] for i in gen).decode("utf-8", errors="replace")
            prompt_ids = [stoi[b] for b in p.encode("utf-8") if b in stoi]
            logits = m(torch.tensor([prompt_ids], dtype=torch.long))[0, -1].tolist()
            out.append({"prompt": p, "promptIds": prompt_ids, "logits": logits, "greedy": gen, "text": text})
            print(f"  {p!r} → {text!r}")
    path.write_text(json.dumps(out, indent=1) + "\n")
    print(f"wrote {path}")


if __name__ == "__main__":
    sys.exit(main())
