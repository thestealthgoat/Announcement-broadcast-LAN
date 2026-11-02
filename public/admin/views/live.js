import { h, api, guard, field, openDialog } from '../lib.js';

const STATUS = {
  live: 'On air',
  idle: 'Waiting for a signal',
  off: 'Turned off',
  error: 'Has a problem',
};
const INPUT_LABEL = {
  rtmp: 'RTMP, from OBS or vMix',
  srt: 'SRT, from OBS or vMix',
  device: 'Capture card or camera on this computer',
};

function addressBlock(feed) {
  if (!feed.address) return h('div', { class: 'small' }, 'Capture device: ', feed.device, feed.audioDevice ? `, sound from ${feed.audioDevice}` : '');
  if (feed.input === 'rtmp') {
    return h('div', { class: 'small' },
      h('div', {}, 'Server: ', h('span', { class: 'code' }, feed.address.url)),
      h('div', {}, 'Stream key: ', h('span', { class: 'code' }, feed.address.key)),
    );
  }
  return h('div', { class: 'small' }, 'Address: ', h('span', { class: 'code' }, feed.address.url));
}

export async function liveView(main) {
  const listEl = h('div', { class: 'list' });

  function feedCard(feed) {
    return h('div', { class: 'card', style: 'margin-bottom:0' },
      h('div', { style: 'display:flex;align-items:center;gap:10px;margin-bottom:8px' },
        h('span', { class: `dot${feed.status === 'live' ? ' on' : ''}`, style: feed.status === 'error' ? 'background:var(--danger)' : undefined }),
        h('div', { style: 'flex:1;min-width:0' },
          h('div', { style: 'font-weight:600;overflow-wrap:anywhere' }, feed.name),
          h('div', { class: 'muted small' }, STATUS[feed.status] ?? feed.status),
        ),
        h('button', { onclick: () => guard(() => dialog(feed)) }, 'Edit'),
      ),
      feed.message && h('p', { class: 'err', role: 'alert' }, feed.message),
      addressBlock(feed),
      feed.encoderLabel && h('div', { class: 'muted small', style: 'margin-top:4px' }, `Encoder: ${feed.encoderLabel}`),
    );
  }

  async function refresh() {
    const feeds = await api.get('/api/live-feeds');
    listEl.replaceChildren(...(feeds.length
      ? feeds.map(feedCard)
      : [h('p', { class: 'muted' }, 'No live feeds yet. Add one to show OBS, vMix, or a capture card on your TVs.')]));
  }

  async function dialog(feed) {
    const options = await api.get('/api/live-feeds/options');
    const offered = Object.keys(INPUT_LABEL).filter((k) => options.inputs[k] || feed?.input === k);

    openDialog(feed ? `Edit ${feed.name}` : 'New live feed', (close) => {
      const name = h('input', { type: 'text', required: true, maxlength: 120, value: feed?.name ?? '' });
      const input = h('select', {}, offered.map((k) => h('option', { value: k, selected: feed?.input === k }, INPUT_LABEL[k])));
      const port = h('input', { type: 'number', min: 1024, max: 65535, inputmode: 'numeric', required: true });
      const portField = h('div', {}, field('Port', port));
      const device = h('select', {}, options.devices.video.map((d) => h('option', { value: d, selected: feed?.device === d }, d)));
      if (feed?.device && !options.devices.video.includes(feed.device)) {
        device.append(h('option', { value: feed.device, selected: true }, `${feed.device} (not connected)`));
      }
      const audio = h('select', {},
        h('option', { value: '' }, 'No sound'),
        options.devices.audio.map((d) => h('option', { value: d, selected: feed?.audioDevice === d }, d)));
      const deviceFields = h('div', {}, field('Capture device', device), field('Sound', audio));
      const bestLabel = options.encoders.find((e) => e.id === options.best)?.label;
      const encoder = h('select', {},
        h('option', { value: 'auto' }, bestLabel ? `Automatic: ${bestLabel}` : 'Automatic'),
        options.encoders.map((e) => h('option', { value: e.id, selected: feed?.encoderPreference === e.id }, e.label)));
      const mbps = h('input', {
        type: 'number', min: options.maxBitrate.min / 1000, max: options.maxBitrate.max / 1000, step: 0.5, inputmode: 'decimal', required: true,
        value: (feed?.maxBitrate ?? options.maxBitrate.default) / 1000,
      });
      const enabled = h('input', { type: 'checkbox', checked: feed ? feed.enabled : true });

      const sync = () => {
        const isDevice = input.value === 'device';
        deviceFields.hidden = !isDevice;
        portField.hidden = isDevice;
        port.required = !isDevice;
        device.required = isDevice;
        if (!isDevice) port.value = feed?.input === input.value ? feed.port : options.suggestedPorts[input.value];
      };
      input.addEventListener('change', sync);
      sync();

      return h('form', {
        onsubmit: (e) => {
          e.preventDefault();
          guard(async () => {
            const isDevice = input.value === 'device';
            const payload = {
              name: name.value,
              input: input.value,
              encoderPreference: encoder.value,
              maxBitrate: Math.round(Number(mbps.value) * 1000),
              enabled: enabled.checked,
              ...(isDevice ? { device: device.value, audioDevice: audio.value || null } : { port: Number(port.value) }),
            };
            if (feed) await api.patch(`/api/live-feeds/${feed.id}`, payload);
            else await api.post('/api/live-feeds', payload);
            close();
            refresh();
          });
        },
      },
        field('Name', name),
        field('Where the video comes from', input),
        portField,
        deviceFields,
        field('Video encoder', encoder),
        field('Maximum quality, in Mbps', mbps),
        h('p', { class: 'muted small' }, 'Every TV showing this feed downloads this much. 6 Mbps suits most networks.'),
        h('label', { class: 'check' }, enabled, h('span', {}, 'Feed is turned on')),
        h('div', { class: 'dialog-foot' },
          feed && h('button', {
            type: 'button',
            class: 'danger-text left',
            onclick: () => guard(async () => {
              if (!confirm(`Delete ${feed.name}? It will come off every channel.`)) return;
              await api.del(`/api/media/${feed.id}`);
              close();
              refresh();
            }),
          }, 'Delete'),
          h('button', { type: 'button', onclick: close }, 'Cancel'),
          h('button', { type: 'submit', class: 'primary' }, 'Save'),
        ),
      );
    });
  }

  main.replaceChildren(
    h('div', { class: 'page-head' }, h('h1', {}, 'Live Feeds'),
      h('button', { class: 'primary', onclick: () => guard(() => dialog(null)) }, 'New live feed')),
    h('p', { class: 'muted' }, 'A live feed appears in the Library, so anyone can add it to their channels. It only shows on TVs while it is on air. Never forward these ports on your router.'),
    listEl,
  );
  await refresh();
  return {
    refresh: (s) => {
      if (s.includes('live') && !document.querySelector('dialog[open]')) guard(refresh);
    },
  };
}
