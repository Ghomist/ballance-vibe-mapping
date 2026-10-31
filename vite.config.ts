import { defineConfig, type Plugin } from 'vite';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error 纯 JS 模块
import { buildScene } from './scripts/blender.mjs';

/** 开发服务器上的导出接口：浏览器把场景描述 POST 过来，本机 Blender + BBP 生成 .nmo / .blend 后返回 */
function exportApi(): Plugin {
  return {
    name: 'bvm-export',
    configureServer(server) {
      server.middlewares.use('/api/export', (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; res.end(); return; }
        const format = new URL(req.url ?? '', 'http://x').searchParams.get('format') === 'blend' ? 'blend' : 'nmo';
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', async () => {
          const dir = mkdtempSync(join(tmpdir(), 'bvm-'));
          try {
            const scene = join(dir, 'scene.json');
            const out = join(dir, `map.${format}`);
            writeFileSync(scene, Buffer.concat(chunks));
            await buildScene(scene, format === 'blend' ? { blend: out } : { nmo: out });
            res.setHeader('Content-Type', 'application/octet-stream');
            res.end(readFileSync(out));
          } catch (e) {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.end((e as { log?: string }).log ?? String(e));
          } finally {
            rmSync(dir, { recursive: true, force: true });
          }
        });
      });
    },
  };
}

export default defineConfig({ plugins: [exportApi()] });
