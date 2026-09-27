/**
 * 冒烟验收：健康检查 + 校核样例（通过 /api/verify，与浏览器页面共用同一数学模块）。
 * 用法：node scripts/smoke.js [baseURL]   （默认 http://127.0.0.1:8080，可用 SMOKE_BASE_URL 覆盖）
 * 全部通过退出码 0，否则退出码 1。
 */

const base = (process.argv[2] || process.env.SMOKE_BASE_URL || 'http://127.0.0.1:8080').replace(/\/+$/, '');

let failures = 0;
function check(cond, label, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  —— ' + extra : ''}`);
  if (!cond) failures++;
}
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

const ident = (rows, cols) =>
  Array.from({ length: rows + 1 }, (_, i) =>
    Array.from({ length: cols + 1 }, (_, j) => ({ x: j, y: i })));

async function postVerify(spec) {
  const res = await fetch(`${base}/api/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(spec),
  });
  return { status: res.status, body: await res.json() };
}

/* 1) 健康检查（重试等待服务就绪） */
let health = null;
for (let i = 0; i < 30 && !health; i++) {
  try {
    const r = await fetch(`${base}/healthz`);
    if (r.ok) health = await r.json();
  } catch { /* 服务尚未就绪，继续等待 */ }
  if (!health) await new Promise((r) => setTimeout(r, 1000));
}
check(!!health && health.status === 'ok', '健康检查 GET /healthz', JSON.stringify(health));

/* 2) 样例 A：恒等网格 —— 通过，J_min = 1，标记原样换算 */
{
  const { status, body } = await postVerify({
    rows: 2, cols: 2, knots: ident(2, 2),
    markers: [{ u: 0.5, v: 0.5 }, { u: 1.5, v: 1.5 }, { u: 2, v: 1 }],
  });
  check(status === 200 && body.ok === true, '样例A：恒等网格校核通过');
  check(body.minJacobian && body.minJacobian.value === 1, '样例A：全网最小雅可比 = 1', JSON.stringify(body.minJacobian));
  const m = body.markers || [];
  check(
    m.length === 3 && near(m[0].x, 0.5) && near(m[0].y, 0.5) && near(m[1].x, 1.5) && near(m[2].x, 2) && near(m[2].y, 1),
    '样例A：标记换算位置正确', JSON.stringify(m),
  );
  check(body.edges && body.edges.continuous === true && body.edges.edgeCount === 4, '样例A：相邻单元共享边连续');
}

/* 3) 样例 B：翻折 —— 首项失败证据 = 单元(0,0) 角点 C1，J = -1，且不输出标记 */
{
  const k = ident(2, 2);
  k[1][1] = { x: -1, y: -1 };
  const { body } = await postVerify({
    rows: 2, cols: 2, knots: k,
    markers: [{ u: 0.5, v: 0.5 }, { u: 1, v: 1 }, { u: 1.5, v: 0.5 }],
  });
  const f = body.firstFailure || {};
  const cell = f.cell || {};
  check(
    body.ok === false && f.type === 'fold' && cell.r === 0 && cell.c === 0 && f.corner === 1 && f.jacobian === -1,
    '样例B：翻折首项证据（行优先单元 + 固定角点序）', JSON.stringify(f),
  );
  check(body.markers === null, '样例B：失败时不输出纹样换算位置');
}

/* 4) 样例 C：退化 —— 首项失败证据 = 单元(0,0) 角点 C1，J = 0 */
{
  const k = ident(2, 2);
  k[1][1] = { x: 2, y: 0 };
  const { body } = await postVerify({
    rows: 2, cols: 2, knots: k,
    markers: [{ u: 0.5, v: 0.5 }, { u: 1, v: 1 }, { u: 1.5, v: 0.5 }],
  });
  const f = body.firstFailure || {};
  const cell = f.cell || {};
  check(
    body.ok === false && f.type === 'degenerate' && cell.r === 0 && cell.c === 0 && f.corner === 1 && f.jacobian === 0,
    '样例C：退化首项证据', JSON.stringify(f),
  );
  check(body.markers === null, '样例C：失败时不输出纹样换算位置');
}

/* 5) 样例 D：无效坐标 —— 非整数网结被拒绝 */
{
  const k = ident(2, 2);
  k[0][1] = { x: 0.5, y: 0 };
  const { body } = await postVerify({
    rows: 2, cols: 2, knots: k,
    markers: [{ u: 0.5, v: 0.5 }, { u: 1, v: 1 }, { u: 1.5, v: 1.5 }],
  });
  check(
    body.ok === false && body.stage === 'validation' && Array.isArray(body.errors) && body.errors.length > 0,
    '样例D：无效坐标被拒绝', JSON.stringify(body.errors && body.errors[0]),
  );
  check(body.markers === null, '样例D：无效输入不输出纹样位置');
}

/* 6) 样例 E：全局重叠 —— 2×4 径向网格局部不翻折，但单元 (0,0) 与 (0,3) 正面积重叠 */
{
  const dirs = [[1, 0], [0, -1], [-1, 0], [0, 1], [3 / 5, -4 / 5]];
  const knots = [5, 10, 15].map((R) => dirs.map(([dx, dy]) => ({ x: R * dx, y: R * dy })));
  const { body } = await postVerify({
    rows: 2, cols: 4, knots,
    markers: [{ u: 0.5, v: 0.5 }, { u: 23 / 6, v: 0.5 }, { u: 2, v: 1.5 }],
  });
  check(
    body.ok === false && body.firstFailure === null && Array.isArray(body.cells)
    && body.cells.every((cell) => cell.ok),
    '样例E：各单元局部判定均通过（重叠非翻折所致）',
  );
  const o = (body.overlaps && body.overlaps.first) || {};
  check(
    body.ok === false && o.a && o.a.r === 0 && o.a.c === 0 && o.b && o.b.r === 0 && o.b.c === 3,
    '样例E：首项全局重叠证据 = 单元对 (0,0)-(0,3)', JSON.stringify(body.overlaps && body.overlaps.first),
  );
  check(body.markers === null, '样例E：重叠时不输出纹样换算位置');
}

/* 7) 样例 F：2×4 不重叠网格 —— 通过，标记正常换算 */
{
  const { body } = await postVerify({
    rows: 2, cols: 4, knots: ident(2, 4),
    markers: [{ u: 0.5, v: 0.5 }, { u: 23 / 6, v: 0.5 }, { u: 2, v: 1.5 }],
  });
  check(
    body.ok === true && body.overlaps && body.overlaps.disjoint === true && body.overlaps.pairCount === 0,
    '样例F：2×4 不重叠网格校核通过（无全局重叠）',
  );
  const m = body.markers || [];
  check(
    m.length === 3 && near(m[0].x, 0.5) && near(m[0].y, 0.5)
    && near(m[1].x, 23 / 6) && near(m[1].y, 0.5) && near(m[2].x, 2) && near(m[2].y, 1.5),
    '样例F：标记换算位置正确', JSON.stringify(m),
  );
}

if (failures) {
  console.error(`\n冒烟验收未通过：${failures} 项失败`);
  process.exit(1);
}
console.log('\n冒烟验收通过：健康检查 + 全部校核样例');
