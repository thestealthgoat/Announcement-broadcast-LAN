import { h, api } from '../lib.js';

// TVs lay a page out at this size, so the preview does too and then shrinks the picture to fit.
const TV_WIDTH = 1920;

// Shows a page the way a TV does: same frame settings, same white background, same layout size.
export function createWebPreview() {
  const status = h('p', { class: 'small web-preview-status', role: 'status' });
  const stage = h('div', { class: 'web-preview-stage' });
  const el = h('div', { class: 'web-preview', hidden: true }, status, stage);
  let current = 0;

  const fit = () => {
    const frame = stage.firstElementChild;
    if (frame) frame.style.transform = `scale(${stage.clientWidth / TV_WIDTH})`;
  };
  const observer = new ResizeObserver(fit);
  observer.observe(stage);

  const say = (text, state) => {
    status.textContent = text;
    status.dataset.state = state;
    el.hidden = false;
  };

  return {
    el,
    clear() {
      current += 1;
      stage.replaceChildren();
      el.hidden = true;
    },
    // Resolves to the check's status, or 'invalid' if there is nothing a TV could show.
    async show(address) {
      const mine = ++current;
      stage.replaceChildren();
      say('Checking this page…', 'busy');
      let result;
      try {
        result = await api.post('/api/media/url/check', { url: address });
      } catch (err) {
        if (mine === current) say(err.message, 'bad');
        return 'invalid';
      }
      if (mine !== current) return result.status;
      say(result.message, result.status === 'ok' || result.status === 'stream' ? 'good' : 'bad');
      if (!result.previewable) return result.status;
      const frame = document.createElement('iframe');
      frame.title = 'Preview of how this page looks on a TV';
      frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms');
      frame.setAttribute('allow', 'autoplay');
      frame.setAttribute('scrolling', 'no');
      frame.src = result.url;
      stage.replaceChildren(frame);
      fit();
      return result.status;
    },
  };
}
