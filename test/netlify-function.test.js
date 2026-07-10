const test = require('node:test');
const assert = require('node:assert/strict');
const { handler } = require('../netlify/functions/resolve');

test('Netlify function rejects unsupported methods', async () => {
  const result = await handler({ httpMethod: 'GET' });
  assert.equal(result.statusCode, 405);
});

test('Netlify function validates input', async () => {
  const result = await handler({
    httpMethod: 'POST',
    body: JSON.stringify({ url: 'https://example.com/job/1' })
  });
  assert.equal(result.statusCode, 400);
  assert.match(JSON.parse(result.body).error, /does not look/);
});
