import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { lanAddresses } from '../lan.js';

export const SERVICE_TYPE = 'network-signage';
const STOP_WAIT_MS = 1000;
const ID_KEY = 'ops.serverId';
const MAX_LABEL_BYTES = 63; // DNS's limit on one part of a name
const MAX_NAME_TRIES = 9;
const RETRY_MS = 60 * 1000;
const MAX_RETRY_MS = 15 * 60 * 1000;

// A failed send (network down, macOS Local Network permission off) can pass, so it only gets
// noted. A failed bind cannot, and bonjour-service leaves that emitter without a listener, which
// would crash the process.
export async function realBonjour(onFatal, onTransient = () => {}, options = {}) {
  const { default: Bonjour } = await import('bonjour-service');
  const instance = new Bonjour(options, onTransient);
  instance.server.mdns.on('error', onFatal);
  return instance;
}

// Who this server is, whatever its hostname or address becomes. It lives in the settings table,
// so a backup restored onto a new computer keeps it and TVs can follow.
export function serverId(db) {
  let id = db.getSetting(ID_KEY, null);
  if (!id) {
    id = randomUUID();
    db.setSetting(ID_KEY, id);
  }
  return id;
}

function serviceName() {
  const host = os.hostname().split('.')[0];
  return host ? `Network Signage on ${host}` : 'Network Signage';
}

// macOS's hostname already ends in .local and Windows's has no domain at all, and NsdManager and
// others look up exactly what the SRV record names.
export function hostName(hostname = os.hostname()) {
  const label = hostname.split('.')[0].replace(/[^A-Za-z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, MAX_LABEL_BYTES);
  return `${label || 'network-signage'}.local`;
}

export function uniqueName(name, attempt) {
  const suffix = attempt > 1 ? ` (${attempt})` : '';
  let stem = name;
  while (Buffer.byteLength(stem + suffix) > MAX_LABEL_BYTES) stem = stem.slice(0, -1);
  return stem + suffix;
}

// bonjour-service has no option for this, and would otherwise publish every interface's address,
// including the virtual ones lan.js leaves out (vmnet, docker, vEthernet). NsdManager hands the app
// just one of them, so a wrong one could be what a TV saves.
function limitAddresses(service, addresses) {
  if (typeof service.records !== 'function') return;
  const all = service.records.bind(service);
  service.records = () => [
    ...all().filter((r) => r.type !== 'A' && r.type !== 'AAAA'),
    ...addresses().map((ip) => service.RecordA(service, ip)),
  ];
}

const settle = (run) => new Promise((resolve) => {
  const timer = setTimeout(resolve, STOP_WAIT_MS);
  const done = () => {
    clearTimeout(timer);
    resolve();
  };
  try {
    run(done);
  } catch {
    done();
  }
});

// Publishes the server for the kiosk app. Nothing in here may ever stop the server, so every
// failure, now or later, ends up in the log. The records carry the host's addresses, so a new
// address means publishing again.
export function createDiscovery({
  port, version, log, id = null, now = Date.now, addresses = lanAddresses,
  createBonjour = realBonjour, name = serviceName(), host = hostName(),
}) {
  let instance = null;
  let address = null;
  let stopped = false;
  let queue = Promise.resolve();
  let failures = 0;
  let retryAt = 0;
  let lastFailed = null;

  const report = (err) => log?.warn?.({ err }, 'Could not publish the server on the network');

  const enqueue = (fn) => {
    queue = queue.then(fn).catch(report);
    return queue;
  };

  async function teardown() {
    const current = instance;
    instance = null;
    if (!current) return;
    await settle((done) => current.unpublishAll(done));
    await settle((done) => current.destroy(done));
  }

  // Later ticks try again, waiting longer each time so a network that stays broken can't cause a storm.
  function markDown(err) {
    report(err);
    address = null;
    failures += 1;
    retryAt = now() + Math.min(RETRY_MS * 2 ** (failures - 1), MAX_RETRY_MS);
  }

  function announce(current, attempt) {
    const service = current.publish({
      name: uniqueName(name, attempt), type: SERVICE_TYPE, port: port(), host, disableIPv6: true,
      txt: id ? { version, id } : { version },
    });
    if (!service) return;
    limitAddresses(service, addresses); // In time: the records are read after the probe, never sooner.
    service.on?.('error', (err) => onLibraryError(current, err));
    service.on?.('up', () => {
      if (current === instance) failures = 0;
    });
    // bonjour-service's probe calls this when the name is taken, then only writes to the console.
    // Its own stop would also send a goodbye under that name, telling every TV the other host has
    // gone. Turning the service off first means nothing is said about it.
    service.stop = () => {
      service.activated = false;
      if (current !== instance || stopped) return;
      if (attempt >= MAX_NAME_TRIES) {
        report(new Error(`The name "${name}" and its numbered variants are all in use on this network`));
        return;
      }
      enqueue(() => {
        if (current === instance && !stopped) announce(current, attempt + 1);
      });
    };
  }

  async function publish() {
    await teardown();
    if (stopped || !address) return;
    try {
      let created = null;
      let early = null;
      const onFatal = (err) => {
        if (created) onLibraryError(created, err);
        else early = err;
      };
      created = await createBonjour(onFatal, (err) => log?.debug?.({ err }, 'An mDNS reply could not be sent'));
      instance = created;
      if (early) onLibraryError(created, early);
      else announce(created, 1);
    } catch (err) {
      markDown(err);
      await teardown();
    }
  }

  function onLibraryError(current, err) {
    // An instance already replaced says nothing about the new one, and one failure can report repeatedly.
    if (current !== instance || current === lastFailed) return;
    lastFailed = current;
    markDown(err);
    enqueue(teardown);
  }

  return {
    sync(next) {
      if (stopped) return queue;
      if (!next) {
        address = null; // The network dropped. When it returns, publish again even on the same address.
        return queue;
      }
      if (next === address || now() < retryAt) return queue;
      address = next;
      return enqueue(publish);
    },
    // After sleep, other devices may have forgotten this service, and the sockets may be dead.
    republish() {
      address = null;
      retryAt = 0;
    },
    stop() {
      stopped = true;
      return enqueue(teardown);
    },
  };
}
