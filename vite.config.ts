import { defineConfig } from 'vite';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export default defineConfig({
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: 'three', test: /node_modules[\\/]three[\\/]/, priority: 10 },
          ],
        },
      },
    },
  },
  plugins: [{
    name: 'local-render-evidence',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__evidence', async (req, res) => {
        if (req.method !== 'POST' || !req.headers.host?.startsWith('127.0.0.1:')) { res.statusCode = 405; res.end(); return; }
        let body = '';
        for await (const chunk of req) { body += chunk; if (body.length > 12000000) { res.statusCode = 413; res.end(); return; } }
        try {
          const { name, data } = JSON.parse(body);
          if (!/^[a-z0-9-]+\.png$/.test(name) || !data.startsWith('data:image/png;base64,')) throw new Error('Invalid evidence');
          await writeFile(resolve('evidence', name), Buffer.from(data.slice(22), 'base64'));
          res.end('saved');
        } catch { res.statusCode = 400; res.end('invalid capture'); }
      });
    },
  }],
});
