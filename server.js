const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { resolveJobrightUrl } = require('./src/resolver');

const PORT = Number(process.env.PORT || 3000);
const PUBLIC = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'POST' && url.pathname === '/api/resolve') {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 10_000) req.destroy();
    });
    req.on('end', async () => {
      try {
        const { url: jobrightUrl } = JSON.parse(raw || '{}');
        const result = await resolveJobrightUrl(jobrightUrl);
        json(res, 200, result);
      } catch (error) {
        const status = error.code === 'BAD_URL' ? 400 : 422;
        json(res, status, { error: error.message || 'Could not resolve that posting.' });
      }
    });
    return;
  }

  if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });
  const requested = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const file = path.normalize(path.join(PUBLIC, requested));
  if (!file.startsWith(PUBLIC)) return json(res, 404, { error: 'Not found' });
  fs.readFile(file, (error, data) => {
    if (error) return json(res, 404, { error: 'Not found' });
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

if (require.main === module) server.listen(PORT, () => console.log(`Right to Source → http://localhost:${PORT}`));
module.exports = server;
