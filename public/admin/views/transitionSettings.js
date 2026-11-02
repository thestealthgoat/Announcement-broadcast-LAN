import { h, field } from '../lib.js';

// The same script the TVs run, so the preview shows what the TV will do.
const T = window.SignageTransitions;

const TYPES = [
  { value: 'cut', label: 'Cut', help: 'Cut: the new item appears straight away.' },
  { value: 'fade', label: 'Fade', help: 'Fade: the new item fades in over the old one.' },
  { value: 'slide', label: 'Slide', help: 'Slide: the new item comes in from the right as the old one leaves to the left.' },
  { value: 'push', label: 'Push', help: 'Push: like Slide, but you pick the direction. Both items move together.' },
  { value: 'wipe', label: 'Wipe', help: 'Wipe: the old item stays still while a moving edge reveals the new one. Older TVs show a fade instead.' },
  { value: 'zoom', label: 'Zoom', help: 'Zoom: the new item grows into place over the old one.' },
];
const TYPE_LABEL = Object.fromEntries(TYPES.map((t) => [t.value, t.label]));
const DIRECTION_LABEL = { left: 'To the left', right: 'To the right', up: 'Upward', down: 'Downward' };
const SPEED_LABEL = { fast: 'Fast', normal: 'Normal', slow: 'Slow' };

const typeOf = (style) => style?.split('-')[0] ?? '';
const directionOf = (style) => style?.split('-')[1] ?? T.DIRECTIONS[0];
const hasDirection = (type) => type === 'push' || type === 'wipe';

function describe(style) {
  const direction = style.split('-')[1];
  return direction ? `${TYPE_LABEL[typeOf(style)]}, ${DIRECTION_LABEL[direction].toLowerCase()}` : TYPE_LABEL[style];
}

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// A small box that plays a transition between two sample panels. People who ask their device
// for less motion see the panels swap with no movement. TVs have no such setting.
function previewBox() {
  const panel = (first) => h('div', { class: `transition-panel ${first ? 'first' : 'second'}` }, first ? 'Item 1' : 'Item 2');
  let first = true;
  let shown = panel(true);
  const stage = h('div', { class: 'transition-stage', 'data-transition-preview': '' }, shown);
  return {
    stage,
    play(style, ms) {
      first = !first;
      const incoming = panel(first);
      const outgoing = shown;
      stage.append(incoming); // later in the box means on top
      shown = incoming;
      const wait = reducedMotion() ? 0 : T.begin(incoming, outgoing, style, ms);
      if (!wait) {
        outgoing.remove();
        return;
      }
      setTimeout(() => {
        outgoing.remove();
        if (shown === incoming) T.settle(incoming);
      }, wait + 100);
    },
  };
}

// Transition controls for one item or a channel's default. `inherited` is what plays with nothing
// chosen, and only items have one. `save` gets { style, speed }, with null meaning nothing chosen,
// and says whether it worked.
export function transitionSettings({ legend, intro, style, speed, inherited, save }) {
  let saved = { style: style ?? null, speed: speed ?? null };

  const noneLabel = (text) => h('option', { value: '' }, text);
  const typeSelect = h('select', {}, inherited
    ? noneLabel(`Same as channel (${describe(inherited.style)})`)
    : noneLabel('Not set (each item keeps its own)'),
    TYPES.map((t) => h('option', { value: t.value }, t.label)));
  const directionSelect = h('select', {}, T.DIRECTIONS.map((d) => h('option', { value: d }, DIRECTION_LABEL[d])));
  const speedSelect = h('select', {}, inherited
    ? noneLabel(`Same as channel (${SPEED_LABEL[T.speedName(inherited.ms)] ?? `${inherited.ms} ms`})`)
    : noneLabel('Not set (Normal)'),
    Object.keys(T.SPEEDS).map((s) => h('option', { value: s }, SPEED_LABEL[s])));

  const directionField = field('Direction', directionSelect);
  const speedField = field('Speed', speedSelect);
  const help = h('p', { class: 'muted small' });
  const preview = previewBox();
  const reducedNote = h('p', { class: 'muted small', hidden: !reducedMotion() },
    'Your device is set to reduce motion, so this preview only swaps the panels. TVs still play the transition.');

  const chosen = () => {
    const type = typeSelect.value;
    return {
      style: !type ? null : hasDirection(type) ? `${type}-${directionSelect.value}` : type,
      speed: speedSelect.value || null,
    };
  };
  // What the preview plays: the choices here, falling back the same way the server does.
  const playing = () => {
    const c = chosen();
    return T.resolve({ style: c.style, ms: c.speed ? T.SPEEDS[c.speed] : null }, inherited);
  };

  function showChoices() {
    const type = typeSelect.value;
    const { style: plays } = playing();
    directionField.hidden = !hasDirection(type);
    speedField.hidden = plays === 'cut';
    help.textContent = TYPES.find((t) => t.value === typeOf(plays))?.help ?? '';
  }

  function show(nextStyle, nextSpeed) {
    saved = { style: nextStyle ?? null, speed: nextSpeed ?? null };
    typeSelect.value = typeOf(saved.style);
    directionSelect.value = directionOf(saved.style);
    speedSelect.value = saved.speed ?? '';
    showChoices();
  }

  async function changed() {
    showChoices();
    const { style: plays, ms } = playing();
    preview.play(plays, ms);
    const wanted = chosen();
    if (await save(wanted)) saved = wanted;
    else show(saved.style, saved.speed);
  }
  for (const select of [typeSelect, directionSelect, speedSelect]) select.addEventListener('change', changed);

  const root = h('fieldset', { class: 'transition-settings' },
    h('legend', {}, legend),
    intro && h('p', { class: 'muted small' }, intro),
    h('div', { class: 'row' }, field('Type', typeSelect), directionField, speedField),
    help,
    preview.stage,
    h('button', {
      type: 'button',
      onclick: () => {
        const { style: plays, ms } = playing();
        preview.play(plays, ms);
      },
    }, 'Play preview'),
    reducedNote,
  );
  show(saved.style, saved.speed);
  // A refresh must not overwrite a choice someone is making right now.
  root.show = (nextStyle, nextSpeed) => {
    if (!root.contains(document.activeElement) || document.activeElement.tagName === 'BUTTON') show(nextStyle, nextSpeed);
  };
  return root;
}
