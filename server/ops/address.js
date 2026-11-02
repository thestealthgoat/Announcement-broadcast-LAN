const LAST_KEY = 'ops.lanAddress';
const NOTICE_KEY = 'ops.addressNotice';

// Remembers the host's primary LAN address and raises a notice when it changes.
export function createAddressWatcher({ db, now, onChange = () => {} }) {
  return {
    check(address) {
      if (!address) return; // A dropped network is not a new address.
      const last = db.getSetting(LAST_KEY, null);
      if (last === address) return;
      db.setSetting(LAST_KEY, address);
      if (!last) return; // First run has nothing to compare with.
      const from = db.getSetting(NOTICE_KEY, null)?.from ?? last;
      // Back on the address the TVs already use, so there is nothing left to fix.
      db.setSetting(NOTICE_KEY, from === address ? null : { from, to: address, at: now() });
      onChange();
    },
    notice: () => db.getSetting(NOTICE_KEY, null),
    dismiss() {
      db.setSetting(NOTICE_KEY, null);
      onChange();
    },
  };
}
