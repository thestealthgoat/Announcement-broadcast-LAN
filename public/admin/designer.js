// The announcement designer, shared by the text announcement dialogs and the Override page.
// Its preview is a TV-sized frame running the player's own stylesheet and slide-render.js,
// scaled down to fit, so it shows what a TV shows.
import { h, api, guard, field, checkbox, toast } from './lib.js';

const SIZE_LABEL = { small: 'Small', medium: 'Medium', large: 'Large', huge: 'Extra large' };
const LOGO_LABEL = { 'bottom-left': 'Bottom left', 'bottom-right': 'Bottom right', 'top-left': 'Top left', 'top-right': 'Top right', hidden: 'Hidden' };
const ALIGN_LABEL = { left: 'Left', center: 'Center', right: 'Right' };
const DEFAULT_DIM = 60; // Dark enough that white text on any picture passes the contrast check.
const FRAME_WIDTH = 1920;

export async function loadDesignerData() {
  const [templates, media, branding] = await Promise.all([api.get('/api/slide-templates'), api.get('/api/media'), api.get('/api/branding')]);
  return {
    templates: templates.templates,
    clock: templates.clock,
    branding,
    images: media.filter((m) => m.type === 'image' && m.status === 'ready').map((m) => ({ id: m.id, name: m.name, src: m.src })),
  };
}

function swatchBackground(style, branding) {
  const bg = style.background;
  if (bg?.type === 'gradient') return `linear-gradient(to bottom right, ${bg.from}, ${bg.to})`;
  return bg?.type === 'solid' ? bg.color : branding.primaryColor;
}

function seg(options, get, set) {
  const wrap = h('div', { class: 'seg', role: 'group' });
  const draw = () => wrap.replaceChildren(...options.map(([v, label]) => h('button', {
    type: 'button',
    class: get() === v ? 'on' : '',
    'aria-pressed': String(get() === v),
    onclick: () => set(v),
  }, label)));
  draw();
  wrap.draw = draw;
  return wrap;
}

// data comes from loadDesignerData. getText returns the words to preview, as { title, body }.
// A page places the returned parts itself, so that its own text boxes can sit between them.
export function createDesigner({ data, initial = null, getText, canManage = false, readOnly = false }) {
  const { branding, images } = data;
  let { templates } = data;
  const Slide = window.SignageSlide;
  const Schedule = window.SignageSchedule;
  const clockOffset = (Schedule.parseWall(data.clock) ?? Date.now()) - Date.now();

  // A deleted picture or template is left out, because the server would refuse it on save.
  const clean = (s) => {
    const out = { ...s };
    if (out.image && !images.some((i) => i.id === out.image)) delete out.image;
    if (out.template && !templates.some((t) => t.id === out.template)) delete out.template;
    return out;
  };
  let style = clean(initial ?? {});
  let changed = !!initial && JSON.stringify(style) !== JSON.stringify(initial);

  const effective = {
    color: () => (style.background?.type === 'solid' ? style.background.color : style.background?.from ?? branding.primaryColor),
    gradientEnd: () => (style.background?.type === 'gradient' ? style.background.to : '#111827'),
    text: () => style.textColor ?? branding.textColor,
    accent: () => style.accentColor ?? branding.accentColor,
  };

  // ---------- preview ----------

  const frame = h('iframe', { src: '/player/slide-preview.html', title: 'Preview of how this looks on a TV', tabindex: '-1', class: 'slide-frame' });
  const previewEl = h('div', { class: 'slide-preview' }, frame);
  const warning = h('p', { class: 'warn-text small', role: 'status', hidden: true });
  let view = null;
  let fontApplied = false;
  let clock = null;

  const wire = () => {
    const picture = images.find((i) => i.id === style.image);
    return picture ? { ...style, imageUrl: picture.src } : style;
  };

  function drawPreview() {
    const win = frame.contentWindow;
    const layer = win?.document?.getElementById('layer');
    if (!layer || !win.SignageSlide) return;
    if (!fontApplied) {
      win.SignageSlide.applyFont(win.document, branding);
      fontApplied = true;
    }
    const { title, body } = getText();
    view = win.SignageSlide.render(
      { title: title || 'Your message here', body, style: wire() },
      branding,
      { now: () => Date.now() + clockOffset },
    );
    layer.replaceChildren(view.el);
    view.fit();
  }

  function refresh() {
    drawPreview();
    const message = Slide.contrastWarning(wire(), branding);
    warning.textContent = message ?? '';
    warning.hidden = !message;
    drawChips();
    syncControls();
  }

  // A frame reloads whenever it is put back on the page, so this runs each time it comes back.
  frame.addEventListener('load', () => {
    fontApplied = false;
    drawPreview();
    if (clock) return;
    clock = setInterval(() => {
      if (previewEl.isConnected) return view?.tick();
      clearInterval(clock);
      clock = null;
      return undefined;
    }, 1000);
  });
  new ResizeObserver(() => {
    const scale = previewEl.clientWidth / FRAME_WIDTH;
    frame.style.transform = `scale(${scale})`;
  }).observe(previewEl);

  const edit = (patch) => {
    style = { ...style, ...patch };
    for (const k of Object.keys(style)) if (style[k] === undefined || style[k] === null) delete style[k];
    changed = true;
    refresh();
  };

  // ---------- templates ----------

  const chips = h('div', { class: 'tpl-chips', role: 'group', 'aria-label': 'Templates' });
  const general = () => templates.find((t) => t.builtin && !Object.keys(t.style).length);

  function drawChips() {
    const selected = style.template ?? (Object.keys(style).length ? null : general()?.id);
    chips.replaceChildren(...templates.map((t) => h('button', {
      type: 'button',
      class: `tpl-chip${t.id === selected ? ' on' : ''}`,
      'aria-pressed': String(t.id === selected),
      disabled: readOnly,
      onclick: () => {
        // The picked template replaces the look. A countdown already set stays, unless the template has its own.
        style = clean({ ...(style.countdown ? { countdown: style.countdown } : {}), ...t.style, template: t.id });
        changed = true;
        refresh();
      },
    },
      h('span', { class: 'tpl-swatch', style: `background:${swatchBackground(t.style, branding)};color:${t.style.textColor ?? branding.textColor}` }, 'Aa'),
      h('span', { class: 'tpl-name' }, t.name),
    )));
  }

  // ---------- controls ----------

  const colorInput = (label, get, set) => {
    const input = h('input', { type: 'color', disabled: readOnly, oninput: (e) => set(e.target.value) });
    return { input, get, el: field(label, input) };
  };
  const selectInput = (label, options, get, set) => {
    const input = h('select', { disabled: readOnly, onchange: (e) => set(e.target.value) }, options.map(([v, text]) => h('option', { value: v }, text)));
    return { input, get, el: field(label, input) };
  };

  const setColor = (value) => {
    if (style.background?.type === 'gradient') edit({ background: { type: 'gradient', from: value, to: style.background.to } });
    else edit({ background: { type: 'solid', color: value } });
  };
  const background = colorInput('Background', effective.color, setColor);
  const gradientEnd = colorInput('Fades to', effective.gradientEnd, (v) => edit({ background: { type: 'gradient', from: effective.color(), to: v } }));
  const bgKind = seg(
    [['solid', 'Color'], ['gradient', 'Gradient']],
    () => (style.background?.type === 'gradient' ? 'gradient' : 'solid'),
    (v) => edit({ background: v === 'gradient' ? { type: 'gradient', from: effective.color(), to: effective.gradientEnd() } : { type: 'solid', color: effective.color() } }),
  );
  const picture = selectInput(
    'Background picture',
    [['', 'No picture'], ...images.map((i) => [i.id, i.name])],
    () => style.image ?? '',
    (v) => edit({ image: v || null, dim: v ? style.dim ?? DEFAULT_DIM : null }),
  );
  const dim = h('input', { type: 'range', min: 0, max: Slide.OPTIONS.maxDim, step: 5, disabled: readOnly, oninput: (e) => edit({ dim: Number(e.target.value) }) });
  const dimField = field('Darken the picture', dim);
  const textColor = colorInput('Text', effective.text, (v) => edit({ textColor: v }));
  const accent = colorInput('Accent line', effective.accent, (v) => edit({ accentColor: v }));
  const sizes = Slide.OPTIONS.sizes.map((s) => [s, SIZE_LABEL[s]]);
  const titleSize = selectInput('Title size', sizes, () => style.titleSize ?? 'medium', (v) => edit({ titleSize: v }));
  const bodySize = selectInput('Message size', sizes, () => style.bodySize ?? 'medium', (v) => edit({ bodySize: v }));
  const logo = selectInput('Logo', Slide.OPTIONS.logo.map((l) => [l, LOGO_LABEL[l]]), () => style.logo ?? 'bottom-left', (v) => edit({ logo: v }));
  const alignSeg = seg(Slide.OPTIONS.align.map((a) => [a, ALIGN_LABEL[a]]), () => style.align ?? 'center', (v) => edit({ align: v }));

  const countdownInput = h('input', { type: 'datetime-local', disabled: readOnly, oninput: (e) => { if (e.target.value) edit({ countdown: e.target.value }); } });
  const countdownField = field('Count down to (on the host computer\'s clock)', countdownInput);
  const countdownCheck = checkbox('Show a countdown', {
    disabled: readOnly,
    onchange: (e) => {
      if (!e.target.checked) return edit({ countdown: null });
      const start = Schedule.formatWall(Date.now() + clockOffset + 3600000).slice(0, 16);
      return edit({ countdown: start });
    },
  });
  const countdownBox = countdownCheck.querySelector('input');

  const syncables = [background, gradientEnd, picture, textColor, accent, titleSize, bodySize, logo];

  function syncControls() {
    for (const c of syncables) if (c.input !== document.activeElement) c.input.value = c.get();
    gradientEnd.el.hidden = style.background?.type !== 'gradient';
    dimField.hidden = !style.image;
    if (dim !== document.activeElement) dim.value = style.dim ?? DEFAULT_DIM;
    bgKind.draw();
    alignSeg.draw();
    countdownBox.checked = !!style.countdown;
    countdownField.hidden = !style.countdown;
    if (countdownInput !== document.activeElement) countdownInput.value = (style.countdown ?? '').slice(0, 16);
  }

  // ---------- saved templates, for people who manage settings ----------

  const manageEl = h('div', { class: 'tpl-manage' });

  async function reloadTemplates() {
    templates = (await api.get('/api/slide-templates')).templates;
    style = clean(style);
    drawManage();
    refresh();
  }

  function drawManage() {
    if (!canManage) return;
    const newName = h('input', { type: 'text', maxlength: 60, placeholder: 'Name for this look', 'aria-label': 'Template name' });
    const save = () => guard(async () => {
      const made = await api.post('/api/slide-templates', { name: newName.value, style });
      style = { ...style, template: made.id };
      changed = true;
      toast('Template saved.');
      await reloadTemplates();
    });
    newName.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault(); // Enter here saves the template, not the form around it.
        save();
      }
    });
    manageEl.replaceChildren(
      h('h3', {}, 'Save this look as a template'),
      h('div', { class: 'row' }, newName, h('button', { type: 'button', onclick: save }, 'Save template')),
      ...templates.filter((t) => !t.builtin).map((t) => {
        const name = h('input', { type: 'text', maxlength: 60, value: t.name, 'aria-label': `Name of ${t.name}` });
        return h('div', { class: 'row tpl-row' },
          name,
          h('button', {
            type: 'button',
            onclick: () => guard(async () => {
              await api.patch(`/api/slide-templates/${t.id}`, { name: name.value });
              toast('Template renamed.');
              await reloadTemplates();
            }),
          }, 'Rename'),
          h('button', {
            type: 'button',
            class: 'danger-text',
            onclick: () => guard(async () => {
              if (!confirm(`Delete the template ${t.name}? Announcements already using its look stay as they are.`)) return;
              await api.del(`/api/slide-templates/${t.id}`);
              await reloadTemplates();
            }),
          }, 'Delete'),
        );
      }),
    );
  }

  const controlsEl = h('details', { class: 'designer-more' },
    h('summary', {}, 'Change the look'),
    h('div', { class: 'designer-controls' },
      bgKind,
      h('div', { class: 'row' }, background.el, gradientEnd.el, textColor.el, accent.el),
      picture.el,
      dimField,
      h('div', { class: 'row' }, titleSize.el, bodySize.el),
      h('div', { class: 'small', style: 'font-weight:600;margin-bottom:4px' }, 'Alignment'),
      alignSeg,
      logo.el,
      countdownCheck,
      countdownField,
      manageEl,
    ),
  );

  drawManage();
  refresh();

  return {
    chips,
    preview: h('div', { class: 'designer-preview' }, previewEl, warning),
    controls: controlsEl,
    // Redraw with new words, or with templates someone else just changed.
    update: drawPreview,
    reloadTemplates: () => guard(reloadTemplates),
    // Null when nothing was touched, so an item with no design keeps having none.
    getStyle: () => (changed ? (Object.keys(style).length ? { ...style } : null) : initial),
  };
}
