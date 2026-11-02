import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer, setupAdmin } from './helpers.js';

const active = async (admin) => (await admin.get('/api/overrides')).data.map((o) => o.title);

test('deleting the only channel of an override clears it, and leaves every other override alone', async (t) => {
  const { base } = await startServer(t);
  const admin = await setupAdmin(base);
  const [main] = (await admin.get('/api/channels')).data;
  const gym = (await admin.post('/api/channels', { name: 'Gym' })).data;
  const hall = (await admin.post('/api/channels', { name: 'Hall' })).data;

  await admin.post('/api/overrides', { title: 'Only gym', channelIds: [gym.id] });
  await admin.post('/api/overrides', { title: 'Gym and hall', channelIds: [gym.id, hall.id] });
  await admin.post('/api/overrides', { title: 'Everywhere', allChannels: true });
  await admin.post('/api/overrides', { title: 'Only main', channelIds: [main.id] });
  assert.equal((await active(admin)).length, 4);

  assert.equal((await admin.del(`/api/channels/${gym.id}`)).status, 200);
  assert.deepEqual((await active(admin)).sort(), ['Everywhere', 'Gym and hall', 'Only main']);
  const shared = (await admin.get('/api/overrides')).data.find((o) => o.title === 'Gym and hall');
  assert.deepEqual(shared.channelIds, [hall.id], 'it carries on for the channel it still has');

  assert.equal((await admin.del(`/api/channels/${hall.id}`)).status, 200);
  assert.deepEqual((await active(admin)).sort(), ['Everywhere', 'Only main']);
});
