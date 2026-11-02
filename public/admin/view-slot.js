// Holds the view on screen. A page can take a while to load, and someone can move on meanwhile. A
// view that finishes after that is destroyed instead of taking over, so its timers end.
export function createViewSlot(ctx) {
  let latest = 0;
  return async function showView(render) {
    const seq = ++latest;
    ctx.view?.destroy?.();
    ctx.view = null; // anything arriving before the next view is ready has nothing stale to call
    let view;
    try {
      view = (await render()) ?? null;
    } catch (err) {
      if (seq === latest) throw err;
      return; // nobody is looking at that page any more
    }
    if (seq === latest) ctx.view = view;
    else view?.destroy?.();
  };
}
