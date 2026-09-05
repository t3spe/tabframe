// DOM helpers shared by the page's views. No state, no framework.

/** The one element a selector names, or a throw: a page whose markup is missing a hook must not half-mount. */
export const $ = <T extends Element>(sel: string, root: ParentNode = document): T => {
  const found = root.querySelector<T>(sel);
  if (!found) throw new Error(`missing element ${sel}`);
  return found;
};

/** An element with an optional class and text. */
export const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

/** A block of text with inline nodes after it. */
export function line(text: string, ...rest: Node[]): HTMLDivElement {
  const div = document.createElement("div");
  div.append(text, ...rest);
  return div;
}

/** A `<code>` that wraps anywhere, so a 64-hex hash never widens its box. */
export function code(text: string, id?: string): HTMLElement {
  const c = document.createElement("code");
  c.textContent = text;
  if (id) c.id = id;
  c.style.overflowWrap = "anywhere";
  return c;
}

/** The `data-<key>` of the focused element inside `root`, so a rebuild can hand focus back. */
export function focusedDatum(root: HTMLElement, key: string): string | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !root.contains(active)) return null;
  return active.closest<HTMLElement>(`[data-${key}]`)?.dataset[key] ?? null;
}

/** Give focus back to the row a keyboard user was on before the list was rebuilt. */
export function refocus(root: HTMLElement, key: string, value: string | null): void {
  if (value === null) return;
  root.querySelector<HTMLElement>(`[data-${key}="${value}"]`)?.focus();
}
