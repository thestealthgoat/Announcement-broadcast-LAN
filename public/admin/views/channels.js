import { h, api, guard, field, checkbox, toast, openDialog, thumb, TYPE_LABEL } from '../lib.js';

export async function channelsView(main, ctx) {
  const isAdmin = ctx.me.role === 'admin';
  const listEl = h('div', { class: 'list' });

  async function refresh() {
    const channels = await api.get('/api/channels');
    const visible = channels.filter((c) => c.canEdit);
    listEl.replaceChildren(...(visible.length
      ? visible.map((c) => h('a', { class: 'tile', href: `#/channels/${c.id}` },
          h('div', { class: 'grow' },
            h('div', { class: 'title' }, c.name),
            h('div', { class: 'muted small' }, `${c.itemCount} item${c.itemCount === 1 ? '' : 's'}, ${c.screenCount} TV${c.screenCount === 1 ? '' : 's'}`),
          ),
          h('span', { class: 'muted' }, '›'),
        ))
      : [h('p', { class: 'muted' }, 'You are not assigned to any channels yet. Ask your admin.')]));
  }

  main.replaceChildren(
    h('div', { class: 'page-head' }, h('h1', {}, 'Channels'),
      isAdmin && h('button', {
        class: 'primary',
        onclick: () => openDialog('New channel', (close) => {
          const name = h('input', { type: 'text', required: true, placeholder: 'Gym Lobby' });
          return h('form', {
            onsubmit: (e) => {
              e.preventDefault();
              guard(async () => {
                const c = await api.post('/api/channels', { name: name.value });
                close();
                location.hash = `#/channels/${c.id}`;
              });
            },
          },
            field('Name', name),
            h('p', { class: 'muted small' }, 'A channel is one playlist. Each TV plays one channel, and many TVs can share it.'),
            h('div', { class: 'dialog-foot' },
              h('button', { type: 'button', onclick: close }, 'Cancel'),
              h('button', { type: 'submit', class: 'primary' }, 'Create')),
          );
        }),
      }, 'New channel'),
    ),
    listEl,
  );
  await refresh();
  return { refresh: (s) => s.includes('channels') && guard(refresh) };
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const ALL_DAYS = 127;
const STATUS_LABEL = { on: 'On now', scheduled: 'Scheduled', ended: 'Ended' };
const STATUS_REFRESH_MS = 30000;

function formatDuration(seconds) {
  if (!seconds) return '';
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return m ? `${m}:${String(s).padStart(2, '0')}` : `${s}s`;
}

export async function channelView(main, ctx, id) {
  const isAdmin = ctx.me.role === 'admin';
  const channels = await guard(() => api.get('/api/channels'));
  const channel = channels?.find((c) => c.id === id);
  if (!channel || !channel.canEdit) {
    main.replaceChildren(h('h1', {}, 'Channel not found'), h('p', {}, h('a', { href: '#/channels' }, 'Back to channels')));
    return null;
  }
  const info = await guard(() => api.get('/api/info'));
  const tvUrl = `${info?.urls[0] ?? location.origin}/play/${channel.slug}`;
  const listEl = h('div', { class: 'list', style: 'margin-top:12px' });
  const open = new Set();
  let dragging = false;
  let items = [];
  // Times waiting for their other half. They can only be saved as a pair, and a refresh must not lose them.
  const timeDrafts = new Map();

  const save = (itemId, patch) => guard(() => api.patch(`/api/playlist-items/${itemId}`, patch));

  // Saves a schedule change and updates the row in place, because a re-render would close
  // a date or time picker. On a refusal, the field goes back to what is saved.
  async function saveSchedule(item, patch, revert) {
    const updated = await save(item.id, patch);
    if (!updated) {
      revert();
      return;
    }
    Object.assign(item, updated);
    listEl.querySelector(`[data-id="${item.id}"] [data-status]`)?.replaceWith(statusLine(item));
  }

  function scheduleSection(item) {
    const dateInput = (key) => {
      const input = h('input', {
        type: 'date',
        value: item[key] ?? '',
        onchange: () => {
          // Typing a year passes through values like 0002-11-01. Wait for the rest of it.
          if (input.value && input.value < '2000') return;
          const revert = () => { input.value = item[key] ?? ''; };
          saveSchedule(item, { [key]: input.value || null }, () => {
            // Still being typed in, so leave it until they move on.
            if (document.activeElement === input) input.addEventListener('blur', revert, { once: true });
            else revert();
          });
        },
      });
      return input;
    };

    const draft = timeDrafts.get(item.id);
    const timeHint = h('p', { class: 'muted small', hidden: !draft }, 'Add the other time to save this. Both are needed.');
    const commitTimes = () => {
      const [start, end] = [startTime.value, endTime.value];
      const waiting = !start !== !end;
      timeHint.hidden = !waiting;
      if (waiting) {
        timeDrafts.set(item.id, { startTime: start, endTime: end });
        return;
      }
      timeDrafts.delete(item.id);
      if (start === (item.startTime ?? '') && end === (item.endTime ?? '')) return;
      saveSchedule(item, { startTime: start || null, endTime: end || null }, () => {
        startTime.value = item.startTime ?? '';
        endTime.value = item.endTime ?? '';
      });
    };
    const startTime = h('input', { type: 'time', value: draft ? draft.startTime : item.startTime ?? '', onchange: commitTimes });
    const endTime = h('input', { type: 'time', value: draft ? draft.endTime : item.endTime ?? '', onchange: commitTimes });

    const dayOn = (i) => item.days === null || (item.days & (1 << i)) !== 0;
    const dayChecks = DAY_NAMES.map((_, i) => h('input', {
      type: 'checkbox',
      checked: dayOn(i),
      onchange: () => {
        const mask = dayChecks.reduce((sum, c, n) => sum + (c.checked ? 1 << n : 0), 0);
        saveSchedule(item, { days: mask === ALL_DAYS ? null : mask }, () => {
          dayChecks.forEach((c, n) => { c.checked = dayOn(n); });
        });
      },
    }));

    return h('fieldset', { class: 'schedule' },
      h('legend', {}, 'Schedule'),
      h('p', { class: 'muted small' }, 'Leave these empty to show this item all the time. Schedules follow the clock on the computer running Network Signage, not the TV.'),
      h('div', { class: 'row' }, field('Start date', dateInput('startDate')), field('End date', dateInput('endDate'))),
      h('div', { class: 'row', style: 'margin-top:8px' }, field('Start time', startTime), field('End time', endTime)),
      timeHint,
      h('p', { class: 'muted small', style: 'margin-top:8px' }, 'If the end time is earlier than the start time, it runs overnight and finishes the next morning.'),
      h('div', { class: 'days', role: 'group', 'aria-label': 'Days of the week' },
        DAY_NAMES.map((name, i) => h('label', { class: 'day' }, dayChecks[i], h('span', {}, name)))),
      h('button', {
        class: 'ghost',
        onclick: () => guard(async () => {
          timeDrafts.delete(item.id);
          const updated = await api.patch(`/api/playlist-items/${item.id}`, { startDate: null, endDate: null, startTime: null, endTime: null, days: null });
          Object.assign(item, updated);
          render();
          toast('Schedule cleared. This item now shows all the time.');
        }),
      }, 'Clear schedule'),
    );
  }

  function statusLine(item) {
    const m = item.media;
    const text = m.status === 'processing'
      ? `Converting${m.progress != null ? ` ${m.progress}%` : '…'}`
      : m.status === 'failed'
        ? (m.error ?? 'Failed')
        : [TYPE_LABEL[m.type], m.pages ? `${m.pages} pages` : null, m.type === 'video' && !item.duration ? formatDuration(m.duration) : item.duration ? `${item.duration}s` : null, item.audio ? 'sound on' : null, !item.enabled ? 'hidden' : null].filter(Boolean).join(' · ');
    return h('div', { class: `small ${m.status === 'failed' ? 'err' : 'muted'}`, 'data-status': '' },
      text, ' ',
      m.status === 'ready' && item.enabled && h('span', { class: `sched sched-${item.scheduleStatus}` }, STATUS_LABEL[item.scheduleStatus]),
    );
  }

  function settings(item) {
    const isVideo = item.media.type === 'video';
    const duration = h('input', {
      type: 'number', min: 1, step: 1, inputmode: 'numeric',
      value: item.duration ?? '',
      placeholder: isVideo ? 'Full length' : item.media.type === 'hls' ? '60' : '10',
      onchange: (e) => save(item.id, { duration: e.target.value === '' ? null : Number(e.target.value) }),
    });
    const transition = h('select', { onchange: (e) => save(item.id, { transition: e.target.value }) },
      ['cut', 'fade', 'slide'].map((t) => h('option', { value: t, selected: item.transition === t }, t[0].toUpperCase() + t.slice(1))));
    return h('div', { class: 'pl-settings' },
      h('div', { class: 'row', style: 'margin-top:8px' },
        field(item.media.type === 'pdf' ? 'Seconds per page' : 'Seconds on screen', duration),
        field('Transition', transition),
      ),
      h('div', { style: 'margin-top:8px' },
        (isVideo || item.media.type === 'hls') && checkbox('Play sound', {
          checked: item.audio,
          onchange: (e) => save(item.id, { audio: e.target.checked }),
        }),
        checkbox('Show this item', {
          checked: item.enabled,
          onchange: (e) => save(item.id, { enabled: e.target.checked }),
        }),
      ),
      scheduleSection(item),
      h('button', {
        class: 'ghost danger-text',
        style: 'margin-top:4px',
        onclick: () => guard(async () => {
          await api.del(`/api/playlist-items/${item.id}`);
          toast('Removed from channel. It is still in the library.');
          refresh();
        }),
      }, 'Remove from channel'),
    );
  }

  function row(item) {
    const m = item.media;
    const expanded = open.has(item.id);
    return h('div', { class: `pl-item${item.enabled ? '' : ' off'}`, 'data-id': item.id },
      h('div', { class: 'tile' },
        h('span', { class: 'handle', 'aria-label': 'Drag to reorder', title: 'Drag to reorder' }, '⠿'),
        thumb(m),
        h('div', { class: 'grow' }, h('div', { class: 'title' }, m.name), statusLine(item)),
        h('button', {
          class: 'ghost',
          'aria-expanded': String(expanded),
          onclick: () => {
            if (expanded) open.delete(item.id);
            else open.add(item.id);
            render();
          },
        }, expanded ? 'Close' : 'Edit'),
      ),
      expanded && settings(item),
    );
  }

  function render() {
    listEl.replaceChildren(...(items.length ? items.map(row) : [
      h('div', { class: 'card muted' }, 'This channel is empty. Add something from the library or upload a new file.'),
    ]));
  }

  async function refresh() {
    if (dragging || listEl.contains(document.activeElement) && document.activeElement.tagName !== 'BUTTON') return;
    items = await api.get(`/api/channels/${id}/items`);
    render();
  }

  // Statuses change with the clock, not just when someone edits something. Only the
  // status lines change here, so this is safe while someone is using a field.
  async function refreshStatuses() {
    const fresh = await api.get(`/api/channels/${id}/items`);
    for (const f of fresh) {
      const item = items.find((i) => i.id === f.id);
      if (!item || item.scheduleStatus === f.scheduleStatus) continue;
      item.scheduleStatus = f.scheduleStatus;
      listEl.querySelector(`[data-id="${item.id}"] [data-status]`)?.replaceWith(statusLine(item));
    }
  }

  function addFromLibrary() {
    openDialog('Add from library', (close) => {
      const body = h('div', { class: 'list' }, h('p', { class: 'muted' }, 'Loading…'));
      api.get('/api/media').then((media) => {
        const usable = media.filter((m) => m.status !== 'failed');
        body.replaceChildren(...(usable.length ? usable.map((m) => h('button', {
          class: 'tile',
          style: 'width:100%;text-align:left;font-weight:400',
          onclick: () => guard(async () => {
            items = await api.post(`/api/channels/${id}/items`, { mediaId: m.id });
            render();
            toast(`Added ${m.name}.`);
          }),
        }, thumb(m), h('div', { class: 'grow' }, h('div', { class: 'title' }, m.name), h('div', { class: 'muted small' }, TYPE_LABEL[m.type])), h('span', { class: 'muted' }, 'Add'))) : [
          h('p', { class: 'muted' }, 'The library is empty.'),
        ]));
      });
      return [body, h('div', { class: 'dialog-foot' }, h('button', { onclick: close }, 'Done'))];
    });
  }

  const frame = h('iframe', { src: `/play/${channel.slug}?preview=1`, title: `Live preview of ${channel.name}` });
  const previewBox = h('div', { class: 'preview' }, frame);
  const scale = () => {
    frame.style.transform = `scale(${previewBox.clientWidth / 1280})`;
  };
  const observer = new ResizeObserver(scale);
  observer.observe(previewBox);

  main.replaceChildren(
    h('div', { class: 'page-head' },
      h('div', {}, h('a', { href: '#/channels', class: 'small' }, '‹ Channels'), h('h1', {}, channel.name)),
      isAdmin && h('div', { class: 'actions' },
        h('button', {
          onclick: () => guard(async () => {
            const next = prompt('Channel name', channel.name);
            if (next) {
              await api.patch(`/api/channels/${id}`, { name: next });
              location.reload();
            }
          }),
        }, 'Rename'),
        h('button', {
          class: 'danger-text',
          onclick: () => guard(async () => {
            if (confirm(`Delete ${channel.name}? TVs on this channel will go back to showing a pairing code. Library items stay.`)) {
              await api.del(`/api/channels/${id}`);
              location.hash = '#/channels';
            }
          }),
        }, 'Delete'),
      ),
    ),
    h('section', { class: 'card' },
      h('h2', {}, 'Live preview'),
      previewBox,
      h('p', { class: 'muted small', style: 'margin:.6rem 0 0' }, 'TV address: ', h('span', { class: 'code' }, tvUrl)),
    ),
    h('div', { class: 'actions' },
      h('button', { class: 'primary', onclick: addFromLibrary }, 'Add from library'),
      h('a', { class: 'btn', href: `#/upload?channel=${id}` }, 'Upload to this channel'),
    ),
    listEl,
  );

  await refresh();
  const statusTimer = setInterval(() => refreshStatuses().catch(() => {}), STATUS_REFRESH_MS);
  const sortable = window.Sortable.create(listEl, {
    handle: '.handle',
    animation: 150,
    onStart: () => { dragging = true; },
    onEnd: () => {
      dragging = false;
      const ids = [...listEl.querySelectorAll('[data-id]')].map((el) => Number(el.dataset.id));
      guard(async () => {
        items = await api.put(`/api/channels/${id}/order`, { ids });
      });
    },
  });

  return {
    refresh: (s) => (s.includes('channels') || s.includes('media')) && guard(refresh),
    destroy: () => {
      clearInterval(statusTimer);
      sortable.destroy();
      observer.disconnect();
    },
  };
}
