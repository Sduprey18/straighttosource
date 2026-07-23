const { resolveJobrightUrl } = require('../../src/resolver');

const response = (statusCode, body) => ({
  statusCode,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  },
  body: JSON.stringify(body)
});

exports.handler = async event => {
  if (event.httpMethod !== 'POST') {
    return response(405, { error: 'Method not allowed' });
  }

  try {
    const payload = JSON.parse(event.body || '{}');
    const result = await resolveJobrightUrl(payload.url);
    return response(200, result);
  } catch (error) {
    const status = error.code === 'BAD_URL' ? 400 : error.code === 'JOB_CLOSED' ? 410 : 422;
    return response(status, { error: error.message || 'Could not resolve that posting.' });
  }
};
