// The page exposes its state on `window.tabframe` for the probes; declared once for `page.evaluate` callbacks.
interface Window {
  tabframe?: { state: { machine: unknown; sleeping: unknown; rotation: unknown } };
}
