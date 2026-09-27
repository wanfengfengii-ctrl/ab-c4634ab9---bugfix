import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.js';

const ident = (rows, cols) =>
  Array.from({ length: rows + 1 }, (_, i) =>
    Array.from({ length: cols + 1 }, (_, j) => ({ x: j, y: i })));

async function withServer(fn) {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('健康检查与校核 API', async () => {
  await withServer(async (base) => {
    const h = await fetch(`${base}/healthz`);
    assert.equal(h.status, 200);
    const hb = await h.json();
    assert.equal(hb.status, 'ok');
    assert.ok(typeof hb.uptimeSeconds === 'number');

    const res = await fetch(`${base}/api/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        rows: 2, cols: 2, knots: ident(2, 2),
        markers: [{ u: 0.5, v: 0.5 }, { u: 1, v: 1 }, { u: 1.5, v: 1.5 }],
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.minJacobian.value, 1);
    assert.equal(body.markers.length, 3);
  });
});

test('API 错误处理：方法不允许与非法 JSON', async () => {
  await withServer(async (base) => {
    const get = await fetch(`${base}/api/verify`);
    assert.equal(get.status, 405);

    const bad = await fetch(`${base}/api/verify`, { method: 'POST', body: 'not json' });
    assert.equal(bad.status, 400);

    const empty = await fetch(`${base}/api/verify`, { method: 'POST', body: '{}' });
    assert.equal(empty.status, 200);
    const eb = await empty.json();
    assert.equal(eb.ok, false);
    assert.equal(eb.stage, 'validation');
  });
});

test('API：全局重叠网格被拒绝，首项证据稳定，不输出标记', async () => {
  // 2×4 螺旋网：半径 5/10/15 × 方向 (1,0)、(0,-1)、(-1,0)、(0,1)、(3/5,-4/5)
  const dirs = [[1, 0], [0, -1], [-1, 0], [0, 1], [3 / 5, -4 / 5]];
  const knots = [5, 10, 15].map((R) => dirs.map(([dx, dy]) => ({ x: R * dx, y: R * dy })));
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        rows: 2, cols: 4, knots,
        markers: [{ u: 0.5, v: 0.5 }, { u: 23 / 6, v: 0.5 }, { u: 2, v: 1.5 }],
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.firstFailure, null); // 局部判定全部通过
    assert.deepEqual(body.overlap.firstOverlap, { a: { r: 0, c: 0 }, b: { r: 0, c: 3 } });
    assert.equal(body.markers, null);
  });
});

test('静态文件：不存在的路径返回 404，路径穿越被拒绝', async () => {
  await withServer(async (base) => {
    const missing = await fetch(`${base}/no-such-file.js`);
    assert.equal(missing.status, 404);
    const traversal = await fetch(`${base}/..%2F..%2Fpackage.json`);
    assert.ok([403, 404].includes(traversal.status));
  });
});
