import { h, api, guard, field, checkbox, toast, thumb, TYPE_LABEL } from '../lib.js';
import { createDesigner, loadDesignerData } from '../designer.js';

export async function overrideView(main, ctx) {
  const [channels, media, designerData] = await Promise.all([api.get('/api/channels'), api.get('/api/media'), loadDesignerData()]);
  const ready = media.filter((m) => m.status === 'ready');
  let kind = 'text';
  let target = 'all';
  let picked = null;

  const title = h('input', { type: 'text', maxlength: 200, placeholder: 'Game moved to the main gym', oninput: () => designer.update() });
  const body = h('textarea', { maxlength: 2000, placeholder: 'Optional details', oninput: () => designer.update() });
  const designer = createDesigner({
    data: designerData,
    canManage: ctx.can('settings.manage'),
    getText: () => ({ title: title.value, body: body.value }),
  });
  const minutes = h('input', { type: 'number', min: 1, max: 1440, placeholder: 'Until cleared', inputmode: 'numeric' });
  const sound = checkbox('Play sound (TV browsers may block this)', {});
  const channelBoxes = channels.map((c) => ({ c, box: h('input', { type: 'checkbox', value: c.id }) }));
  const contentEl = h('div', {});
  const targetEl = h('div', { hidden: true }, channelBoxes.map(({ c, box }) => h('label', { class: 'check' }, box, h('span', {}, c.name))));
  const activeEl = h('section', {});

  const seg = (options, get, set) => {
    const wrap = h('div', { class: 'seg', role: 'group' });
    const draw = () => wrap.replaceChildren(...options.map(([v, label]) => h('button', {
      type: 'button',
      class: get() === v ? 'on' : '',
      'aria-pressed': String(get() === v),
      onclick: () => {
        set(v);
        draw();
      },
    }, label)));
    draw();
    return wrap;
  };

  function drawContent() {
    if (kind === 'text') {
      contentEl.replaceChildren(designer.chips, field('Message', title), field('Details', body), designer.preview, designer.controls);
      return;
    }
    contentEl.replaceChildren(ready.length
      ? h('div', { class: 'list', style: 'max-height:280px;overflow:auto;margin-bottom:12px' }, ready.map((m) => h('label', { class: 'tile' },
          h('input', { type: 'radio', name: 'ov-media', checked: picked === m.id, onchange: () => { picked = m.id; } }),
          thumb(m),
          h('div', { class: 'grow' }, h('div', { class: 'title' }, m.name), h('div', { class: 'muted small' }, TYPE_LABEL[m.type])),
        )))
      : h('p', { class: 'muted' }, 'The library is empty.'));
  }

  async function drawActive() {
    const active = await api.get('/api/overrides');
    activeEl.replaceChildren(...(active.length ? [h('h2', {}, 'Active now'), h('div', { class: 'list' }, active.map((o) => h('div', { class: 'tile' },
      h('div', { class: 'grow' },
        h('div', { class: 'title' }, o.mediaName ?? o.title),
        h('div', { class: 'muted small' }, o.allChannels ? 'All channels' : channels.filter((c) => o.channelIds.includes(c.id)).map((c) => c.name).join(', '), o.endsAt ? `, ends ${new Date(o.endsAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ', until cleared'),
      ),
      h('button', { class: 'danger', onclick: () => guard(() => api.del(`/api/overrides/${o.id}`)) }, 'Clear'),
    )))] : []));
  }

  main.replaceChildren(
    h('div', { class: 'page-head' }, h('h1', {}, 'Override')),
    h('p', { class: 'muted' }, 'Takes over TVs right away, in place of their playlists.'),
    activeEl,
    h('form', {
      class: 'card',
      style: 'margin-top:12px',
      onsubmit: (e) => {
        e.preventDefault();
        guard(async () => {
          const payload = {
            allChannels: target === 'all',
            channelIds: channelBoxes.filter(({ box }) => box.checked).map(({ c }) => c.id),
            minutes: minutes.value || null,
            audio: sound.querySelector('input').checked,
          };
          if (kind === 'text') {
            payload.title = title.value;
            payload.body = body.value;
            payload.style = designer.getStyle();
          } else {
            if (!picked) throw new Error('Choose a library item.');
            payload.mediaId = picked;
          }
          await api.post('/api/overrides', payload);
          title.value = '';
          body.value = '';
          designer.update();
          toast('Override is live.');
        });
      },
    },
      h('h2', {}, 'What to show'),
      seg([['text', 'Quick message'], ['media', 'Library item']], () => kind, (v) => { kind = v; drawContent(); }),
      contentEl,
      h('h2', {}, 'Where'),
      seg([['all', 'All channels'], ['some', 'Selected']], () => target, (v) => { target = v; targetEl.hidden = v !== 'some'; }),
      targetEl,
      field('Minutes (blank runs until cleared)', minutes),
      sound,
      h('button', { type: 'submit', class: 'danger', style: 'width:100%;margin-top:8px' }, 'Push override now'),
    ),
  );
  drawContent();
  await drawActive();
  return {
    refresh: (s) => {
      if (s.includes('overrides')) guard(drawActive);
      if (s.includes('templates')) designer.reloadTemplates();
    },
  };
}
