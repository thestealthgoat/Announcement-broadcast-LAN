import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { startServer, setupAdmin, makeEditor, player } from './helpers.js';
import { isActive, status, problem, wallClock, parseWall, formatWall } from '../server/schedule.js';

const SUN = 1, MON = 2, TUE = 4, WED = 8, THU = 16, FRI = 32, SAT = 64;
const on = (schedule, wall) => isActive(schedule, wall);

// 2026-11-02 is a Monday.
test('no schedule means always on, whatever the clock says', () => {
  assert.equal(on(null, '2026-11-02T12:00'), true);
  assert.equal(on(undefined, '2026-11-02T12:00'), true);
  assert.equal(on({}, '2026-11-02T12:00'), true);
  assert.equal(on({ startDate: null, endDate: null, startTime: null, endTime: null, days: null }, '2026-11-02T12:00'), true);
  assert.equal(on(null, 'not a clock'), true);
});

test('date bounds include both the first and the last day', () => {
  const s = { startDate: '2026-11-02', endDate: '2026-11-04' };
  assert.equal(on(s, '2026-11-01T23:59'), false);
  assert.equal(on(s, '2026-11-02T00:00'), true);
  assert.equal(on(s, '2026-11-04T23:59'), true);
  assert.equal(on(s, '2026-11-05T00:00'), false);
  assert.equal(on({ startDate: '2026-11-02' }, '2030-01-01T00:00'), true, 'no end date');
  assert.equal(on({ endDate: '2026-11-02' }, '2001-01-01T00:00'), true, 'no start date');
  assert.equal(on({ startDate: '2026-11-02', endDate: '2026-11-02' }, '2026-11-02T08:00'), true, 'a single day');
});

test('a daytime window starts on its start minute and stops on its end minute', () => {
  const s = { startTime: '09:00', endTime: '17:00' };
  assert.equal(on(s, '2026-11-02T08:59'), false);
  assert.equal(on(s, '2026-11-02T09:00'), true);
  assert.equal(on(s, '2026-11-02T16:59:59'), true);
  assert.equal(on(s, '2026-11-02T17:00'), false);
});

test('an overnight window crosses midnight', () => {
  const s = { startTime: '22:00', endTime: '02:00' };
  assert.equal(on(s, '2026-11-02T21:59'), false);
  assert.equal(on(s, '2026-11-02T22:00'), true);
  assert.equal(on(s, '2026-11-02T23:59'), true);
  assert.equal(on(s, '2026-11-03T00:00'), true);
  assert.equal(on(s, '2026-11-03T01:59'), true);
  assert.equal(on(s, '2026-11-03T02:00'), false);
  assert.equal(on(s, '2026-11-03T12:00'), false);
});

test('the days rule looks at the day an overnight window starts', () => {
  const friday = { startTime: '22:00', endTime: '02:00', days: FRI }; // Friday night into Saturday
  assert.equal(on(friday, '2026-11-06T23:00'), true, 'Friday night');
  assert.equal(on(friday, '2026-11-07T01:00'), true, 'early Saturday still belongs to Friday');
  assert.equal(on(friday, '2026-11-07T23:00'), false, 'Saturday night has no window');
  assert.equal(on(friday, '2026-11-06T01:00'), false, 'early Friday belongs to Thursday');
  const week = { startTime: '22:00', endTime: '02:00', days: SAT };
  assert.equal(on(week, '2026-11-08T01:00'), true, 'early Sunday belongs to Saturday, across the week boundary');
});

test('date bounds apply to the day an overnight window starts', () => {
  const s = { startTime: '22:00', endTime: '02:00', startDate: '2026-11-02', endDate: '2026-11-03' };
  assert.equal(on(s, '2026-11-02T01:00'), false, 'that window started the day before the first day');
  assert.equal(on(s, '2026-11-02T23:00'), true);
  assert.equal(on(s, '2026-11-04T01:00'), true, 'the window from the last day runs into the next morning');
  assert.equal(on(s, '2026-11-04T23:00'), false);
  // Across a month and a year.
  assert.equal(on({ startTime: '22:00', endTime: '02:00', endDate: '2026-12-31' }, '2027-01-01T01:00'), true);
  assert.equal(on({ startTime: '22:00', endTime: '02:00', startDate: '2027-01-01' }, '2027-01-01T01:00'), false);
});

test('day masks use Sunday = 1 through Saturday = 64', () => {
  const week = ['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07'];
  [SUN, MON, TUE, WED, THU, FRI, SAT].forEach((bit, i) => {
    week.forEach((date, j) => assert.equal(on({ days: bit }, `${date}T12:00`), i === j, `${bit} on ${date}`));
  });
  assert.equal(on({ days: MON | WED }, '2026-11-02T12:00'), true);
  assert.equal(on({ days: MON | WED }, '2026-11-03T12:00'), false);
  assert.equal(on({ days: 127 }, '2026-11-03T12:00'), true);
  assert.equal(on({ days: null }, '2026-11-03T12:00'), true);
});

test('leap days are real days only in leap years', () => {
  assert.equal(problem({ startDate: '2028-02-29' }), null);
  assert.ok(problem({ startDate: '2026-02-29' }));
  assert.ok(problem({ startDate: '2100-02-29' }), 'centuries are not leap years');
  assert.equal(problem({ startDate: '2000-02-29' }), null);
  assert.equal(on({ startDate: '2028-02-29', endDate: '2028-02-29' }, '2028-02-29T12:00'), true);
  assert.equal(on({ startDate: '2028-02-29', endDate: '2028-02-29' }, '2028-03-01T00:00'), false);
  // An overnight window from the leap day ends on March 1; from Feb 28 it ends on the leap day.
  assert.equal(on({ startTime: '22:00', endTime: '02:00', startDate: '2028-02-29', endDate: '2028-02-29' }, '2028-03-01T01:00'), true);
  assert.equal(on({ startTime: '22:00', endTime: '02:00', startDate: '2028-02-28', endDate: '2028-02-28' }, '2028-02-29T01:00'), true);
  assert.equal(on({ startTime: '22:00', endTime: '02:00', days: FRI }, '2027-03-06T01:00'), true, 'Mar 6 2027 is a Saturday');
});

test('malformed schedules and clocks fail safely: the item stays off and nothing throws', () => {
  const wall = '2026-11-02T12:00';
  for (const bad of [
    { startDate: 'soon' }, { endDate: '2026-13-01' }, { startDate: '2026-02-30' }, { startDate: 20261102 },
    { startDate: '2026-11-02', endDate: '2026-11-01' },
    { startTime: '09:00' }, { endTime: '09:00' }, { startTime: '24:00', endTime: '25:00' }, { startTime: '9:00', endTime: '10:00' },
    { startTime: '09:00', endTime: '09:00' },
    { days: 0 }, { days: 128 }, { days: -1 }, { days: 1.5 }, { days: '5' }, { days: {} },
    'nonsense', 7, [],
  ]) {
    assert.equal(on(bad, wall), false, JSON.stringify(bad));
    assert.ok(problem(bad), JSON.stringify(bad));
    assert.equal(status(bad, wall), 'ended', JSON.stringify(bad));
  }
  for (const badClock of [null, undefined, '', 'tomorrow', '2026-02-30T12:00', '2026-11-02T25:00', 1234]) {
    assert.equal(on({ startTime: '00:00', endTime: '23:59' }, badClock), false, String(badClock));
    assert.equal(parseWall(badClock), null, String(badClock));
  }
});

test('wall-clock behavior ignores time zones and daylight saving', () => {
  const original = process.env.TZ;
  try {
    for (const zone of ['America/New_York', 'Pacific/Auckland', 'Asia/Tokyo', 'UTC']) {
      process.env.TZ = zone;
      // 02:30 does not exist on Mar 8 2026 in New York, and 01:30 happens twice on Nov 1. Schedules do not care.
      assert.equal(on({ startTime: '02:00', endTime: '03:00' }, '2026-03-08T02:30'), true, zone);
      assert.equal(on({ startTime: '01:00', endTime: '02:00', days: SUN }, '2026-11-01T01:30'), true, zone);
      for (const wall of ['2026-03-08T02:30:00', '2026-11-01T01:30:00', '2028-02-29T23:59:59']) {
        assert.equal(formatWall(parseWall(wall)), wall, `${zone} ${wall}`);
      }
      // A TV keeps following the host from one received clock, whatever its own clock or zone says.
      const tvNow = Date.UTC(2031, 0, 1); // this TV is years out
      const offset = parseWall('2026-11-01T23:59:30') - tvNow;
      assert.equal(formatWall(tvNow + 45000 + offset), '2026-11-02T00:00:15', zone);
    }
    // The host's clock is read in the host's own zone: both 01:30s on the fall-back night.
    process.env.TZ = 'America/New_York';
    assert.equal(wallClock(new Date('2026-11-01T05:30:00Z')), '2026-11-01T01:30:00');
    assert.equal(wallClock(new Date('2026-11-01T06:30:00Z')), '2026-11-01T01:30:00');
    process.env.TZ = 'Asia/Tokyo';
    assert.equal(wallClock(new Date('2026-11-01T20:00:05Z')), '2026-11-02T05:00:05');
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
});

test('status says On now, Scheduled, or Ended', () => {
  const wall = '2026-11-02T12:00'; // Monday noon
  assert.equal(status(null, wall), 'on');
  assert.equal(status({ startDate: '2026-11-01', endDate: '2026-11-02' }, wall), 'on');
  assert.equal(status({ startDate: '2026-11-03' }, wall), 'scheduled');
  assert.equal(status({ endDate: '2026-11-01' }, wall), 'ended');
  assert.equal(status({ startTime: '13:00', endTime: '14:00' }, wall), 'scheduled', 'later today');
  assert.equal(status({ startTime: '10:00', endTime: '11:00' }, wall), 'scheduled', 'tomorrow');
  assert.equal(status({ days: TUE }, wall), 'scheduled');
  assert.equal(status({ startTime: '10:00', endTime: '11:00', endDate: '2026-11-02' }, wall), 'ended', 'today was the last window');
  assert.equal(status({ startTime: '13:00', endTime: '14:00', endDate: '2026-11-02' }, wall), 'scheduled', 'the last window is still to come');
  assert.equal(status({ days: FRI, endDate: '2026-11-05' }, wall), 'ended', 'no Friday is left before the last day');
  assert.equal(status({ days: THU, endDate: '2026-11-05' }, wall), 'scheduled', 'one Thursday is left');
  assert.equal(status({ days: MON, startDate: '2026-11-03', endDate: '2026-11-08' }, wall), 'ended', 'the range holds no Monday');
  assert.equal(status({ startTime: '22:00', endTime: '02:00', endDate: '2026-11-01' }, '2026-11-02T01:00'), 'on', 'running from the last day');
  assert.equal(status({ startTime: '22:00', endTime: '02:00', endDate: '2026-11-01' }, '2026-11-02T03:00'), 'ended');
});

test('the same file works as a plain browser script', () => {
  const file = path.join(import.meta.dirname, '..', 'public', 'player', 'schedule.js');
  const browser = {};
  browser.window = browser;
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), browser);
  assert.equal(browser.SignageSchedule.isActive({ days: 2 }, '2026-11-02T12:00'), true);
  assert.equal(browser.SignageSchedule.isActive({ days: 4 }, '2026-11-02T12:00'), false);
});

// ---------- the API ----------

async function oneItem(admin, base = {}) {
  const [main] = (await admin.get('/api/channels')).data;
  const media = (await admin.post('/api/media/text', { title: 'Lunch', body: 'Soup', ...base })).data;
  const items = (await admin.post(`/api/channels/${main.id}/items`, { mediaId: media.id })).data;
  return { main, media, item: items[items.length - 1] };
}

test('saving a schedule: it round-trips, merges with what is there, and clears', async (t) => {
  const { base } = await startServer(t);
  const admin = await setupAdmin(base);
  const { item } = await oneItem(admin);
  assert.deepEqual(
    [item.startDate, item.endDate, item.startTime, item.endTime, item.days, item.scheduleStatus],
    [null, null, null, null, null, 'on'],
    'new items run all the time',
  );

  let r = await admin.patch(`/api/playlist-items/${item.id}`, {
    startDate: '2020-01-01', endDate: '2099-12-31', startTime: '00:00', endTime: '23:59', days: 127,
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.startDate, '2020-01-01');
  assert.equal(r.data.endDate, '2099-12-31');
  assert.equal(r.data.startTime, '00:00');
  assert.equal(r.data.endTime, '23:59');
  assert.equal(r.data.days, 127);

  r = await admin.patch(`/api/playlist-items/${item.id}`, { days: MON | FRI });
  assert.equal(r.data.days, MON | FRI);
  assert.equal(r.data.startDate, '2020-01-01', 'other fields stay');

  r = await admin.patch(`/api/playlist-items/${item.id}`, { duration: 5 });
  assert.equal(r.data.duration, 5);
  assert.equal(r.data.days, MON | FRI, 'other settings leave the schedule alone');

  // Blank is the same as null, because cleared form fields send ''.
  r = await admin.patch(`/api/playlist-items/${item.id}`, { startDate: '', endDate: null, startTime: '', endTime: null, days: null });
  assert.equal(r.status, 200);
  assert.deepEqual([r.data.startDate, r.data.endDate, r.data.startTime, r.data.endTime, r.data.days], [null, null, null, null, null]);
});

test('bad schedules are refused with a plain-language reason, and nothing is saved', async (t) => {
  const { base } = await startServer(t);
  const admin = await setupAdmin(base);
  const { item } = await oneItem(admin);
  const url = `/api/playlist-items/${item.id}`;
  await admin.patch(url, { startDate: '2026-06-10', days: MON });

  const cases = [
    [{ startDate: '2026-02-30' }, /start date/i],
    [{ startDate: '2026-13-01' }, /start date/i],
    [{ endDate: '11/02/2026' }, /end date/i],
    [{ endDate: 20261102 }, /end date/i],
    [{ endDate: '2026-06-09' }, /before the start date/i],
    [{ startDate: '2026-06-12', endDate: '2026-06-11' }, /before the start date/i],
    [{ startTime: '09:00' }, /both/i],
    [{ endTime: '09:00' }, /both/i],
    [{ startTime: '24:00', endTime: '01:00' }, /start time/i],
    [{ startTime: '9:00', endTime: '10:00' }, /start time/i],
    [{ startTime: '09:00', endTime: '09:60' }, /end time/i],
    [{ startTime: '09:00', endTime: '09:00' }, /same/i],
    [{ days: 0 }, /at least one day/i],
    [{ days: 128 }, /days/i],
    [{ days: -1 }, /days/i],
    [{ days: 1.5 }, /days/i],
    [{ days: '5' }, /days/i],
  ];
  for (const [body, why] of cases) {
    const r = await admin.patch(url, { ...body, duration: 99 });
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.match(r.data.error, why, JSON.stringify(body));
  }
  const [saved] = (await admin.get(`/api/channels/${item.channelId}/items`)).data;
  assert.equal(saved.startDate, '2026-06-10');
  assert.equal(saved.endDate, null);
  assert.equal(saved.days, MON);
  assert.equal(saved.duration, null, 'a refused change saves nothing at all');

  await admin.patch(url, { startTime: '09:00', endTime: '17:00' });
  const r = await admin.patch(url, { endTime: '' });
  assert.equal(r.status, 400, 'clearing one time of a pair is refused');
  assert.match(r.data.error, /both/i);
  assert.equal((await admin.patch(url, { startTime: '', endTime: '' })).status, 200);
  assert.equal((await admin.patch(url, { startTime: '22:00', endTime: '02:00' })).status, 200, 'overnight is fine');
});

test('editors can schedule only on their assigned channels', async (t) => {
  const { base } = await startServer(t);
  const admin = await setupAdmin(base);
  const { main, item } = await oneItem(admin);
  const gym = (await admin.post('/api/channels', { name: 'Gym' })).data;
  const gymMedia = (await admin.post('/api/media/text', { title: 'Hoops' })).data;
  const gymItem = (await admin.post(`/api/channels/${gym.id}/items`, { mediaId: gymMedia.id })).data[0];

  const editor = await makeEditor(admin, base, 'eddie', { channelIds: [gym.id] });
  const ok = await editor.patch(`/api/playlist-items/${gymItem.id}`, { days: SAT });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.days, SAT);

  const no = await editor.patch(`/api/playlist-items/${item.id}`, { days: SAT });
  assert.equal(no.status, 403);
  const [untouched] = (await admin.get(`/api/channels/${main.id}/items`)).data;
  assert.equal(untouched.days, null);

  const anon = await fetch(`${base}/api/playlist-items/${item.id}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ days: SAT }),
  });
  assert.equal(anon.status, 401);
});

test('item rows report status using the host clock', async (t) => {
  const { base } = await startServer(t);
  const admin = await setupAdmin(base);
  const { item } = await oneItem(admin);
  const url = `/api/playlist-items/${item.id}`;
  const statusOf = async (patch) => (await admin.patch(url, patch)).data.scheduleStatus;
  assert.equal(await statusOf({ startDate: '2099-01-01', endDate: null }), 'scheduled');
  assert.equal(await statusOf({ startDate: '2000-01-01', endDate: '2000-01-02' }), 'ended');
  assert.equal(await statusOf({ startDate: '2000-01-01', endDate: '2099-01-02' }), 'on');
});

// ---------- over a real socket ----------

test('state messages carry each slide\'s schedule and the host clock', async (t) => {
  const { base, port } = await startServer(t);
  const admin = await setupAdmin(base);
  const { main, item } = await oneItem(admin);
  const p = player(port);
  await p.open;
  t.after(() => p.close());
  p.send({ type: 'hello', deviceId: 'device-sched', slug: main.slug });
  const first = await p.next((m) => m.type === 'state');
  assert.equal(first.slides[0].schedule, null, 'no schedule by default');

  const before = wallClock();
  assert.match(first.clock, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
  assert.ok(Math.abs(parseWall(first.clock) - parseWall(before)) < 5000, 'the clock is the host\'s wall clock');

  await admin.patch(`/api/playlist-items/${item.id}`, { startDate: '2099-01-01', startTime: '22:00', endTime: '02:00', days: FRI | SAT });
  const next = await p.next((m) => m.type === 'state' && m.slides[0]?.schedule);
  assert.deepEqual(next.slides[0].schedule, { startDate: '2099-01-01', endDate: null, startTime: '22:00', endTime: '02:00', days: FRI | SAT });
  assert.equal(next.slides.length, 1, 'inactive items still reach the TV, which decides for itself');

  await admin.patch(`/api/playlist-items/${item.id}`, { startDate: null, startTime: null, endTime: null, days: null });
  const cleared = await p.next((m) => m.type === 'state' && m.slides[0] && !m.slides[0].schedule);
  assert.equal(cleared.slides[0].schedule, null);
});

test('a disabled item stays out even with a schedule; overrides have no schedule', async (t) => {
  const { base, port } = await startServer(t);
  const admin = await setupAdmin(base);
  const { main, media, item } = await oneItem(admin);
  await admin.patch(`/api/playlist-items/${item.id}`, { days: SAT, enabled: false });
  const p = player(port);
  await p.open;
  t.after(() => p.close());
  p.send({ type: 'hello', deviceId: 'device-off1', slug: main.slug });
  assert.deepEqual((await p.next((m) => m.type === 'state')).slides, []);

  await admin.post('/api/overrides', { mediaId: media.id, allChannels: true });
  const fromMedia = await p.next((m) => m.type === 'state' && m.override);
  assert.equal(fromMedia.override.slides[0].schedule, null, 'even when the library item is scheduled elsewhere');
  assert.ok(fromMedia.clock);
});

test('PDF pages inherit their item\'s schedule', async (t) => {
  const { server, base, port } = await startServer(t);
  const admin = await setupAdmin(base);
  const { main, media, item } = await oneItem(admin);
  server.db.run("UPDATE media SET type = 'pdf', pages = 3, name = 'Menu' WHERE id = ?", media.id);
  const schedule = { startDate: '2026-01-01', endDate: '2099-01-01', startTime: '08:00', endTime: '10:00', days: MON };
  await admin.patch(`/api/playlist-items/${item.id}`, schedule);
  const p = player(port);
  await p.open;
  t.after(() => p.close());
  p.send({ type: 'hello', deviceId: 'device-pdf1', slug: main.slug });
  const s = await p.next((m) => m.type === 'state');
  assert.equal(s.slides.length, 3);
  for (const slide of s.slides) assert.deepEqual(slide.schedule, schedule);
  assert.equal(new Set(s.slides.map((x) => x.key)).size, 3);
});
