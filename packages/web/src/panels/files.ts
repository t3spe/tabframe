// The files panel: the filesystem behind the execution's root (or a root the reader chose), grouped
// by origin, every byte fetched from the store by hash.
import type { ClusterState } from "../cluster-state.ts";
import { el, focusedDatum, refocus } from "../dom.ts";
import { fmtBytes, short } from "../format.ts";
import { fileViewerUrl } from "../page-mode.ts";
import { type FileEntry, groupFiles, listFiles, parseManifest } from "../result.ts";
import type { PanelContext } from "./context.ts";
import { renderPreview } from "./preview.ts";

export function renderFiles(ctx: PanelContext, state: ClusterState): void {
  const { els, cache, deps, selection } = ctx;
  const exec = state.execution;
  const root = selection.browsingRoot ?? exec?.root ?? null;
  // The selection is not part of the signature: a click changes a class, never the list.
  const sig = JSON.stringify([root, selection.browsingRoot, exec?.executionId, cache.version]);
  if (!ctx.changed("files", sig)) return;
  els.filesRoot.textContent = root ? short(root, 16) : "—";
  els.filesRoot.title = root ?? "";
  els.filesSummary.textContent = root
    ? `root ${short(root, 12)} · fetching the manifest…`
    : exec
      ? "no filesystem yet: the first stage has not folded"
      : "no execution";
  const focusedPath = focusedDatum(els.files, "path");
  els.files.replaceChildren();
  if (!root) {
    els.files.append(
      el("p", "muted", exec ? "no filesystem yet: the first stage has not folded" : "no execution"),
    );
    renderPreview(ctx, state);
    return;
  }
  const bytes = cache.get(root);
  if (bytes === "pending") {
    els.files.append(el("p", "muted", "fetching the manifest…"));
    return;
  }
  if (bytes === "error" || bytes === null) {
    els.files.append(el("p", "bad", "the manifest could not be fetched"));
    return;
  }
  let files: FileEntry[];
  try {
    files = listFiles(parseManifest(bytes));
  } catch {
    els.files.append(el("p", "bad", "not a filesystem manifest"));
    return;
  }
  const groups = groupFiles(files);
  const total = files.reduce((n, f) => n + f.size, 0);
  els.filesSummary.textContent = `root ${short(root, 12)} · ${files.length} files · ${fmtBytes(total)} · every byte fetched from the store by hash`;
  els.files.append(
    el(
      "div",
      "muted small",
      `${files.length} files · ${fmtBytes(total)}${selection.browsingRoot ? " · browsing a chosen root" : ""}`,
    ),
  );
  if (deps.panelMode === "files" && exec) {
    // The files tab cannot see the stage strip: the stages' roots are offered here instead.
    const roots = el("div", "muted small");
    roots.append("roots: ");
    for (const s of exec.stages) {
      if (!s.root) continue;
      const b = el("button", "small", `stage ${s.stage}`);
      b.type = "button";
      b.dataset.rootStage = String(s.stage);
      b.title = s.root;
      b.onclick = () => ctx.browseRoot(s.root);
      roots.append(b, " ");
    }
    els.files.append(roots);
  }
  if (selection.browsingRoot) {
    const follow = el("button", "small", "follow the execution");
    follow.type = "button";
    follow.onclick = () => ctx.browseRoot(null);
    els.files.append(follow);
  }
  for (const g of groups) {
    const section = el("div", "file-group");
    section.append(
      el("div", "file-group-head mono", `${g.label} · ${g.files.length} · ${fmtBytes(g.bytes)}`),
    );
    const list = el("ul", "plain files");
    for (const f of g.files) {
      const isSelected = selection.file?.hash === f.hash && selection.file.path === f.path;
      const li = el("li", `file${isSelected ? " selected" : ""}`);
      li.dataset.path = f.path;
      li.dataset.hash = f.hash;
      li.title = `${f.hash} · click to see the bytes here`;
      // The name shows the file here, in the preview box; the small arrow opens it in its own tab.
      const name = el("span", "mono open-file", f.path);
      const tab = el("a", "open-file-tab", "↗");
      tab.href = fileViewerUrl(location.search, root, f);
      tab.target = "_blank";
      tab.rel = "noreferrer";
      tab.title = `open ${f.path} in its own tab`;
      tab.onclick = (ev) => ev.stopPropagation();
      const meta = el("span", "muted", ` ${fmtBytes(f.size)} · ${short(f.hash, 8)} `);
      meta.append(tab);
      li.append(name, meta);
      li.onclick = () => ctx.selectFile(isSelected && selection.file?.hash === f.hash ? null : f);
      // Reachable by keyboard: a row is a button.
      li.tabIndex = 0;
      li.setAttribute("role", "button");
      li.onkeydown = (ev) => {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          li.click();
        }
      };
      list.append(li);
    }
    section.append(list);
    els.files.append(section);
  }
  renderPreview(ctx, state);
  refocus(els.files, "path", focusedPath);
}
