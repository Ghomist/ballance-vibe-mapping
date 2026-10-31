// 调用 Blender（命令行、后台模式）的公共函数
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));

export function findBlender() {
  if (process.env.BLENDER) return process.env.BLENDER;
  const cands = ['D:/Blender/blender.exe'];
  for (const v of ['5.0', '4.5', '4.4', '4.3', '4.2']) cands.push(`C:/Program Files/Blender Foundation/Blender ${v}/blender.exe`);
  return cands.find((p) => existsSync(p)) ?? 'blender';
}

export const ASSETS_BLEND = process.env.BALLANCE_ASSETS ?? 'D:/BlenderLibrary/BallanceAssets/BallanceAssets.blend';
export const TEXTURES = process.env.BALLANCE_TEXTURES ?? 'D:/Ballance/Textures';

/** 用 Blender + BBP 把场景描述生成 .blend / .nmo。返回 Blender 的输出日志 */
export function buildScene(sceneJson, { blend, nmo } = {}) {
  const args = ['-b', '--python', join(ROOT, 'scripts/blender/build_scene.py'), '--', sceneJson, '--assets', ASSETS_BLEND, '--textures', TEXTURES];
  if (blend) args.push('--blend', blend);
  if (nmo) args.push('--nmo', nmo);
  return new Promise((resolve, reject) => {
    execFile(findBlender(), args, { maxBuffer: 64 << 20 }, (err, stdout, stderr) => {
      const log = `${stdout}\n${stderr}`;
      if (err || /Traceback|Error:/.test(stdout)) reject(Object.assign(new Error('Blender 生成失败'), { log }));
      else resolve(log);
    });
  });
}
