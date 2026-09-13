import assert from 'node:assert/strict';
import test from 'node:test';

import { deviceConnections, parseScaleFrame } from '../live.ts';

test('scale status frames are distinct from live weight frames', () => {
  assert.deepEqual(parseScaleFrame({ status: 'connected' }), { kind: 'status', connected: true });
  assert.deepEqual(parseScaleFrame({ status: 'disconnected' }), { kind: 'status', connected: false });
  assert.deepEqual(parseScaleFrame({ weight: 18.5, weightFlow: 2.1, battery: 84 }), {
    kind: 'snapshot',
    snapshot: { weight: 18.5, weightFlow: 2.1, battery: 84 }
  });
  assert.equal(parseScaleFrame({ weight: Number.NaN }), null);
  assert.equal(parseScaleFrame({ nope: true }), null);
});

test('device connection state is derived from connected hardware', () => {
  const connected = deviceConnections({
    devices: [
      { id: 'm1', name: 'DE1', type: 'machine', state: 'connected' },
      { id: 's1', name: 'Scale', type: 'scale', state: 'discovered' }
    ]
  });
  assert.deepEqual(connected, { machine: true, scale: false });

  assert.deepEqual(deviceConnections({ devices: [] }), { machine: false, scale: false });
  assert.equal(deviceConnections({ devices: 'not an array' }), null);
});
