import { mkdir, rm, copyFile, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { verifyGrid, makeIdentityKnots } from '../src/shared/bilinear.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 构建：
 * 1. 自检——恒等网格必须通过校核且 J_min = 1；局部不翻折但全局重叠的螺旋网
 *    必须被拒绝（首项证据 = 单元 (0,0) 与 (0,3)，不输出标记），
 *    防止把损坏的数学模块打进产物；
 * 2. 组装 dist/public（页面 + 共享数学模块），并生成带 SHA-256 的构建清单。
 */
export async function build() {
  const probe = verifyGrid({
    rows: 2,
    cols: 2,
    knots: makeIdentityKnots(2, 2),
    markers: [{ u: 0.5, v: 0.5 }, { u: 1, v: 1 }, { u: 2, v: 2 }],
  });
  if (!probe.ok || probe.minJacobian.value !== 1) {
    throw new Error('构建自检失败：恒等网格校核未通过');
  }

  // 重叠探针：2×4 螺旋网（半径 5/10/15 × 方向 (1,0)、(0,-1)、(-1,0)、(0,1)、(3/5,-4/5)）
  const dirs = [[1, 0], [0, -1], [-1, 0], [0, 1], [3 / 5, -4 / 5]];
  const spiral = verifyGrid({
    rows: 2,
    cols: 4,
    knots: [5, 10, 15].map((R) => dirs.map(([dx, dy]) => ({ x: R * dx, y: R * dy }))),
    markers: [{ u: 0.5, v: 0.5 }, { u: 23 / 6, v: 0.5 }, { u: 2, v: 1.5 }],
  });
  const fo = spiral.overlap && spiral.overlap.firstOverlap;
  const expected = fo && fo.a.r === 0 && fo.a.c === 0 && fo.b.r === 0 && fo.b.c === 3;
  if (spiral.ok || !expected || spiral.markers !== null) {
    throw new Error('构建自检失败：全局重叠网格未被拒绝');
  }

  const srcPublic = path.join(ROOT, 'src', 'public');
  const distPublic = path.join(ROOT, 'dist', 'public');
  await rm(path.join(ROOT, 'dist'), { recursive: true, force: true });
  await mkdir(path.join(distPublic, 'shared'), { recursive: true });

  const files = [
    ['index.html', path.join(srcPublic, 'index.html'), path.join(distPublic, 'index.html')],
    ['app.js', path.join(srcPublic, 'app.js'), path.join(distPublic, 'app.js')],
    ['styles.css', path.join(srcPublic, 'styles.css'), path.join(distPublic, 'styles.css')],
    ['shared/bilinear.js', path.join(ROOT, 'src', 'shared', 'bilinear.js'), path.join(distPublic, 'shared', 'bilinear.js')],
  ];

  const manifest = { builtAt: new Date().toISOString(), files: {} };
  for (const [name, from, to] of files) {
    await copyFile(from, to);
    const buf = await readFile(to);
    manifest.files[name] = {
      bytes: buf.length,
      sha256: createHash('sha256').update(buf).digest('hex'),
    };
  }
  await writeFile(path.join(ROOT, 'dist', 'build-manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`[build] dist/ 已生成（${files.length} 个文件），构建自检通过`);
  return manifest;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  build().catch((err) => {
    console.error('[build] 失败:', err.message);
    process.exit(1);
  });
}
