import os from 'node:os';

export const SERVICE_TYPE = 'network-signage';
const STOP_WAIT_MS = 1000;

// A failed send (network down, macOS Local Network permission off) can pass, so it only gets
// noted. A failed bind cannot, and bonjour-service leaves that emitter without a listener, which
// would crash the process.
export async function realBonjour(onFatal, onTransient = () => {}, options = {}) {
  const { default: Bonjour } = await import('bonjour-service');
  const instance = new Bonjour(options, onTransient);
  instance.server.mdns.on('error', onFatal);
  return instance;
}

function serviceName() {
  const host = os.hostname().split('.')[0];
  return host ? `Network Signage on ${host}` : 'Network Signage';
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
export function createDiscovery({ port, version, log, createBonjour = realBonjour, name = serviceName() }) {
  let instance = null;
  let address = null;
  let stopped = false;
  let queue = Promise.resolve();

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

  function onError(err) {
    report(err);
    enqueue(teardown); // Stays down until the address changes or the app restarts.
  }

  async function publish() {
    await teardown();
    if (stopped) return;
    instance = await createBonjour(onError, (err) => log?.debug?.({ err }, 'An mDNS reply could not be sent'));
    const service = instance.publish({ name, type: SERVICE_TYPE, port: port(), txt: { version }, disableIPv6: true });
    service?.on?.('error', onError);
  }

  return {
    sync(next) {
      if (stopped || !next || next === address) return queue;
      address = next;
      return enqueue(publish);
    },
    stop() {
      stopped = true;
      return enqueue(teardown);
    },
  };
}
