const test = require('node:test');
const assert = require('node:assert/strict');
const { extractCandidates, extractTitle, resolveJobrightUrl } = require('../src/resolver');

test('ranks an ATS job URL above unrelated links', () => {
  const html = '<a href="https://example.com/blog">x</a><script>{"applyUrl":"https:\\/\\/boards.greenhouse.io\\/acme\\/jobs\\/123"}</script>';
  assert.equal(extractCandidates(html)[0].url, 'https://boards.greenhouse.io/acme/jobs/123');
});

test('extracts and cleans the Jobright title', () => {
  assert.equal(extractTitle('<meta property="og:title" content="Designer @ Acme | Jobright.ai">'), 'Designer @ Acme');
});

test('rejects non-Jobright input', async () => {
  await assert.rejects(() => resolveJobrightUrl('https://example.com/job/1'), /does not look/);
});

test('resolves a Simplify posting through its direct click redirect', async () => {
  const fakeFetch = async url => {
    assert.match(String(url), /simplify\.jobs\/jobs\/click\/702c05a8/);
    return { status:307, headers:{ get:name => name === 'location' ? 'https://jobs.ashbyhq.com/january/job-id/application?utm_source=Simplify' : null } };
  };
  const result = await resolveJobrightUrl('https://simplify.jobs/p/702c05a8-f884-4a1b-ae93-29a370a5442f/Software-Engineer', fakeFetch);
  assert.equal(result.url, 'https://jobs.ashbyhq.com/january/job-id/application?utm_source=Simplify');
  assert.equal(result.source, 'jobs.ashbyhq.com');
});

test('resolves a posting from embedded page data', async () => {
  const fakeFetch = async () => ({ ok:true, text:async () => '<title>Engineer | Jobright.ai</title><script>https://jobs.lever.co/acme/abc</script>' });
  const result = await resolveJobrightUrl('https://jobright.ai/jobs/info/abc', fakeFetch);
  assert.equal(result.url, 'https://jobs.lever.co/acme/abc');
});

test('falls back to an official employer search result', async () => {
  let calls = 0;
  const fakeFetch = async url => {
    calls++;
    if (calls === 1) return { ok:true, text:async () => `<title>Software Engineer @ Acme | Jobright.ai</title><script id="job-posting" type="application/ld+json">{"title":"Software Engineer","hiringOrganization":{"name":"Acme","sameAs":"https://acme.com"}}</script>` };
    if (String(url).includes('boards-api') || String(url).includes('lever.co') || String(url).includes('ashbyhq')) return { ok:false, status:404 };
    return { ok:true, text:async () => `<a href="https://careers.acme.com/jobs/software-engineer/">Job</a><a href="https://indeed.com/viewjob?id=1">Noise</a>` };
  };
  const result = await resolveJobrightUrl('https://jobright.ai/jobs/info/abc', fakeFetch);
  assert.equal(result.url, 'https://careers.acme.com/jobs/software-engineer/');
});

test('does not return a search-results page when a provider is unavailable', async () => {
  let calls = 0;
  const fakeFetch = async () => {
    calls++;
    if (calls === 1) return { ok:true, text:async () => `<title>Engineer @ Acme | Jobright.ai</title><script id="job-posting" type="application/ld+json">{"title":"Engineer","hiringOrganization":{"name":"Acme","sameAs":"https://acme.com"}}</script>` };
    return { ok:false, status:429, text:async () => '' };
  };
  await assert.rejects(
    () => resolveJobrightUrl('https://jobright.ai/jobs/info/abc', fakeFetch),
    /could not be verified/
  );
});

test('resolves dynamically through a public ATS board', async () => {
  const fakeFetch = async url => {
    if (String(url).includes('jobright.ai/jobs/info')) return { ok:true, text:async () => `<title>Software Engineer - New Grad @ SeatGeek | Jobright.ai</title><script id="job-posting" type="application/ld+json">{"title":"Software Engineer - New Grad","hiringOrganization":{"name":"SeatGeek","sameAs":"https://seatgeek.com"}}</script>` };
    if (String(url).includes('boards-api.greenhouse.io/v1/boards/seatgeek/')) return { ok:true, json:async () => ({ jobs:[{ title:'Software Engineer - New Grad', absolute_url:'https://job-boards.greenhouse.io/seatgeek/jobs/123' }] }) };
    return { ok:false, status:404 };
  };
  const result = await resolveJobrightUrl('https://jobright.ai/jobs/info/another-id', fakeFetch);
  assert.equal(result.url, 'https://job-boards.greenhouse.io/seatgeek/jobs/123');
});
