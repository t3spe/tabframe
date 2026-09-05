import { describe, expect, test } from "bun:test";
import { backLink, fileViewerUrl, panelLink, readPageMode } from "./page-mode.ts";

const HASH = "c".repeat(64);

describe("the page's mode", () => {
  test("the dashboard, live and lending", () => {
    expect(readPageMode("")).toEqual({
      demo: false,
      panel: null,
      observeOnly: false,
      openFile: null,
      openRoot: null,
      pauseAtDone: 0,
      speed: 1,
      startWith: null,
      hold: false,
    });
  });
  test("an observer, the demo, and a panel tab lend nothing", () => {
    expect(readPageMode("?observe").observeOnly).toBe(true);
    expect(readPageMode("?demo=1").observeOnly).toBe(true);
    expect(readPageMode("?panel=ledger")).toMatchObject({ panel: "ledger", observeOnly: true });
    expect(readPageMode("?panel=nope").panel).toBeNull();
  });
  test("the demo's knobs", () => {
    expect(readPageMode("?demo=1&speed=12&pause=300&program=wordcount&hold=1")).toMatchObject({
      demo: true,
      speed: 12,
      pauseAtDone: 300,
      startWith: "wordcount",
      hold: true,
    });
    expect(readPageMode("?demo=1&speed=abc&pause=x&program=other")).toMatchObject({
      speed: 1,
      pauseAtDone: 0,
      startWith: null,
    });
  });
  test("the files tab opens on a pinned file and root only when both are well formed", () => {
    const m = readPageMode(`?panel=files&root=${HASH}&file=${HASH}&path=%2Fout%2F2%2F0&size=120`);
    expect(m.openRoot).toBe(HASH);
    expect(m.openFile).toEqual({ hash: HASH, path: "/out/2/0", size: 120 });
    expect(readPageMode(`?panel=files&file=${HASH}`).openFile).toBeNull(); // no path
    expect(readPageMode("?panel=files&root=short").openRoot).toBeNull();
    expect(readPageMode(`?panel=ledger&root=${HASH}`).openRoot).toBeNull();
  });
});

describe("links between tabs", () => {
  test("the way back drops the panel's keys and keeps the page's own", () => {
    expect(backLink("?observe=&panel=ledger")).toBe("/?observe=");
    expect(backLink(`?demo=1&speed=12&panel=files&root=${HASH}&file=${HASH}&path=x&size=1`)).toBe(
      "/?demo=1&speed=12",
    );
    expect(backLink("?panel=activity")).toBe("/");
  });
  test("a panel link carries the demo, or asks for an observer", () => {
    expect(panelLink("?demo=1&speed=12", "ledger", true)).toBe("/?demo=1&speed=12&panel=ledger");
    expect(panelLink("", "files", false)).toBe("/?observe=&panel=files");
    expect(panelLink("?observe&panel=ledger", "activity", false)).toBe("/?observe=&panel=activity");
  });
  test("a file viewer link pins the root, the file, its path, and a size when known", () => {
    const f = { path: "/out/2/0", hash: "a".repeat(64), size: 120 };
    const url = fileViewerUrl("?demo=1&speed=12", "b".repeat(64), f);
    const q = new URL(url, "http://x").searchParams;
    expect(q.get("demo")).toBe("1");
    expect(q.has("observe")).toBe(false);
    expect(q.get("panel")).toBe("files");
    expect(q.get("root")).toBe("b".repeat(64));
    expect(q.get("file")).toBe("a".repeat(64));
    expect(q.get("path")).toBe("/out/2/0");
    expect(q.get("size")).toBe("120");
    const live = new URL(fileViewerUrl("", "b".repeat(64), { ...f, size: 0 }), "http://x")
      .searchParams;
    expect(live.has("observe")).toBe(true);
    expect(live.has("size")).toBe(false);
  });
});
