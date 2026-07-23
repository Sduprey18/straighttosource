const test = require('node:test');
const assert = require('node:assert/strict');
const {
  extractCandidates,
  extractJobData,
  extractTitle,
  isSpecificJobUrl,
  resolveJobrightUrl,
  titleMatchScore,
  verifyResolvedUrl
} = require('../src/resolver');

test('ranks an ATS job URL above unrelated links', () => {
  const html = '<a href="https://example.com/blog">x</a><script>{"applyUrl":"https:\\/\\/boards.greenhouse.io\\/acme\\/jobs\\/123"}</script>';
  assert.equal(extractCandidates(html)[0].url, 'https://boards.greenhouse.io/acme/jobs/123');
});

test('extracts and cleans the Jobright title', () => {
  assert.equal(extractTitle('<meta property="og:title" content="Designer @ Acme | Jobright.ai">'), 'Designer @ Acme');
});

test('recognizes an exact job title inside a search-result label', () => {
  assert.equal(
    titleMatchScore(
      'Software Engineering Intern, BS, Summer 2027',
      'Google › Careers Software Engineering Intern, BS, Summer 2027 - Google'
    ),
    1
  );
});

test('rejects non-Jobright input', async () => {
  await assert.rejects(() => resolveJobrightUrl('https://example.com/job/1'), /does not look/);
});

test('resolves a Simplify posting through its direct click redirect', async () => {
  const fakeFetch = async url => {
    if (String(url).includes('/jobs/click/702c05a8')) {
      return { status:307, headers:{ get:name => name === 'location' ? 'https://jobs.ashbyhq.com/january/job-id/application?utm_source=Simplify' : null } };
    }
    if (String(url).includes('/p/702c05a8')) {
      return {
        ok:true,
        text:async () => '<title>Software Engineer | Simplify</title><script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"jobPosting":{"title":"Software Engineer","active":true}}}}</script>'
      };
    }
    return { ok:false, status:403 };
  };
  const result = await resolveJobrightUrl('https://simplify.jobs/p/702c05a8-f884-4a1b-ae93-29a370a5442f/Software-Engineer', fakeFetch);
  assert.equal(result.url, 'https://jobs.ashbyhq.com/january/job-id/application?utm_source=Simplify');
  assert.equal(result.source, 'jobs.ashbyhq.com');
});

test('reads Jobright current structured job data and its closed state', () => {
  const html = '<script id="jobright-helper-job-detail-info" type="application/json">{"jobResult":{"jobTitle":"Platform Engineer","isDeleted":true},"companyResult":{"companyName":"Acme","companyURL":"https://acme.example"}}</script>';
  assert.deepEqual(extractJobData(html), {
    title:'Platform Engineer',
    company:'Acme',
    companyUrl:'https://acme.example',
    applicationUrl:'',
    isClosed:true
  });
});

test('reports a closed Jobright posting instead of a generic verification failure', async () => {
  let calls = 0;
  const fakeFetch = async () => {
    calls++;
    return {
      ok:true,
      text:async () => '<title>Software Engineer @ Apple | Jobright.ai</title><script id="jobright-helper-job-detail-info" type="application/json">{"jobResult":{"jobTitle":"Software Engineer","isDeleted":true},"companyResult":{"companyName":"Apple","companyURL":"https://apple.com"}}</script>'
    };
  };
  await assert.rejects(
    () => resolveJobrightUrl('https://jobright.ai/jobs/info/closed-id', fakeFetch),
    /job is closed/
  );
  assert.equal(calls, 1);
});

test('reports a closed Simplify posting even when its click route still redirects', async () => {
  const fakeFetch = async url => {
    if (String(url).includes('/jobs/click/')) {
      return { headers:{ get:name => name === 'location' ? 'https://jobs.example.com/jobs/123' : null } };
    }
    return {
      ok:true,
      text:async () => '<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"jobPosting":{"title":"Engineer","active":false,"visible":false}}}}</script>'
    };
  };
  await assert.rejects(
    () => resolveJobrightUrl('https://simplify.jobs/p/702c05a8-f884-4a1b-ae93-29a370a5442f/Engineer', fakeFetch),
    /job is closed/
  );
});

test('rejects generic careers and search pages as job destinations', async () => {
  assert.equal(isSpecificJobUrl('https://jobs.apple.com/en-us/search'), false);
  assert.equal(isSpecificJobUrl('https://example.com/careers'), false);
  assert.equal(isSpecificJobUrl('https://jobs.apple.com/en-us/details/12345'), true);
  const redirected = await verifyResolvedUrl(
    'https://jobs.example.com/jobs/12345',
    { title:'Software Engineer' },
    async () => ({
      ok:true,
      url:'https://example.com/careers',
      headers:{ get:() => 'text/html' },
      text:async () => '<title>Careers</title>'
    })
  );
  assert.equal(redirected, null);
});

test('finds an official job on a company-branded jobs domain', async () => {
  const fakeFetch = async url => {
    const value = String(url);
    if (value.includes('jobright.ai/jobs/info')) {
      return {
        ok:true,
        text:async () => '<title>Data Center Controls Technician @ Amazon | Jobright.ai</title><script id="jobright-helper-job-detail-info" type="application/json">{"jobResult":{"jobTitle":"Data Center Controls Technician","isDeleted":false},"companyResult":{"companyName":"Amazon","companyURL":"https://amazon.com"}}</script>'
      };
    }
    if (value.includes('search.yahoo.com')) {
      return {
        ok:true,
        text:async () => '<a href="https://www.amazon.jobs/en/jobs/3186055/data-center-controls-technician">Data Center Controls Technician - Amazon Jobs</a>'
      };
    }
    if (value.includes('amazon.jobs/en/jobs/3186055')) return { ok:false, status:403 };
    return { ok:false, status:404 };
  };
  const result = await resolveJobrightUrl('https://jobright.ai/jobs/info/amazon-id', fakeFetch);
  assert.equal(result.url, 'https://www.amazon.jobs/en/jobs/3186055/data-center-controls-technician');
});

test('resolves a posting from embedded page data', async () => {
  const fakeFetch = async () => ({ ok:true, text:async () => '<title>Engineer | Jobright.ai</title><script>https://jobs.lever.co/acme/abc</script>' });
  const result = await resolveJobrightUrl('https://jobright.ai/jobs/info/abc', fakeFetch);
  assert.equal(result.url, 'https://jobs.lever.co/acme/abc');
});

test('discovers an exact posting linked by the official employer site', async () => {
  let calls = 0;
  const fakeFetch = async url => {
    calls++;
    if (calls === 1) return { ok:true, text:async () => `<title>Software Engineer @ Acme | Jobright.ai</title><script id="job-posting" type="application/ld+json">{"title":"Software Engineer","hiringOrganization":{"name":"Acme","sameAs":"https://acme.com"}}</script>` };
    if (String(url).includes('boards-api') || String(url).includes('lever.co') || String(url).includes('ashbyhq') || String(url).includes('recruitee.com')) return { ok:false, status:404 };
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

test('resolves dynamically through a public Recruitee board', async () => {
  const fakeFetch = async url => {
    if (String(url).includes('jobright.ai/jobs/info')) {
      return {
        ok:true,
        text:async () => `<title>Product Designer @ Fleur | Jobright.ai</title><script id="job-posting" type="application/ld+json">{"title":"Product Designer","hiringOrganization":{"name":"Fleur","sameAs":"https://fleur.com"}}</script>`
      };
    }
    if (String(url).includes('fleur.recruitee.com/api/offers')) {
      return {
        ok:true,
        json:async () => ({
          offers:[{ title:'Product Designer', careers_url:'https://fleur.recruitee.com/o/product-designer' }]
        })
      };
    }
    return { ok:false, status:404 };
  };
  const result = await resolveJobrightUrl('https://jobright.ai/jobs/info/recruitee-id', fakeFetch);
  assert.equal(result.url, 'https://fleur.recruitee.com/o/product-designer');
});

test('discovers and queries a Workday board linked by the employer', async () => {
  const fakeFetch = async url => {
    const value = String(url);
    if (value.includes('jobright.ai/jobs/info')) {
      return {
        ok:true,
        text:async () => `<title>Full-Stack Software Engineer Internship (Summer 2027) @ CCI | Jobright.ai</title><script id="job-posting" type="application/ld+json">{"title":"Full-Stack Software Engineer Internship (Summer 2027)","hiringOrganization":{"name":"CCI","sameAs":"https://cci.example"}}</script>`
      };
    }
    if (value === 'https://cci.example/') {
      return { ok:true, text:async () => '<a href="/careers/">Careers</a>' };
    }
    if (value.startsWith('https://cci.example/careers')) {
      return { ok:true, text:async () => '<a href="https://osv-cci.wd1.myworkdayjobs.com/CCICareers">View open roles</a>' };
    }
    if (value === 'https://osv-cci.wd1.myworkdayjobs.com/CCICareers') {
      return { ok:true, text:async () => '<script>window.workday = { tenant: "osv_cci", siteId: "CCICareers" };</script>' };
    }
    if (value.includes('/wday/cxs/osv_cci/CCICareers/jobs')) {
      return {
        ok:true,
        json:async () => ({
          jobPostings:[{
            title:'Full-Stack Software Engineer Internship (Summer 2027)',
            externalPath:'/job/Stamford-CT/Full-Stack-Software-Engineer-Internship--Summer-2027-_R1350'
          }]
        })
      };
    }
    return { ok:false, status:404 };
  };
  const result = await resolveJobrightUrl('https://jobright.ai/jobs/info/workday-id', fakeFetch);
  assert.equal(
    result.url,
    'https://osv-cci.wd1.myworkdayjobs.com/en-US/CCICareers/job/Stamford-CT/Full-Stack-Software-Engineer-Internship--Summer-2027-_R1350'
  );
});

test('resolves the reproduced Rippling listing through the generic search pipeline', async () => {
  let searchCalls = 0;
  const fakeFetch = async url => {
    if (String(url).includes('jobright.ai/jobs/info')) {
      return {
        ok:true,
        text:async () => `<title>Software Engineer Intern - Backend Focused - Winter 2027 @ Rippling | Jobright.ai</title><script id="job-posting" type="application/ld+json">{"title":"Software Engineer Intern - Backend Focused - Winter 2027","hiringOrganization":{"name":"Rippling","sameAs":"https://www.rippling.com"}}</script>`
      };
    }
    if (String(url).includes('search.yahoo.com')) {
      searchCalls++;
      return {
        ok:true,
        text:async () => '<a href="https://r.search.yahoo.com/x/RU=https%3a%2f%2fats.rippling.com%2frippling%2fjobs%2f00cbc991-d2fb-452c-a8b6-2978f109a484/RK=2/RS=x">Software Engineer Intern - Backend Focused - Winter 2027</a>'
      };
    }
    return { ok:false, status:404 };
  };
  const result = await resolveJobrightUrl('https://jobright.ai/jobs/info/rippling-id', fakeFetch);
  assert.equal(result.url, 'https://ats.rippling.com/rippling/jobs/00cbc991-d2fb-452c-a8b6-2978f109a484');
  assert.equal(searchCalls, 1);
});

test('retries the web-search fallback after a transient provider failure', async () => {
  let searchCalls = 0;
  const fakeFetch = async url => {
    if (String(url).includes('jobright.ai/jobs/info')) {
      return {
        ok:true,
        text:async () => `<title>Platform Engineer @ Acme | Jobright.ai</title><script id="job-posting" type="application/ld+json">{"title":"Platform Engineer","hiringOrganization":{"name":"Acme","sameAs":"https://acme.com"}}</script>`
      };
    }
    if (!String(url).includes('search.yahoo.com') && !String(url).includes('search.brave.com')) {
      return { ok:false, status:404 };
    }
    searchCalls++;
    if (searchCalls === 1) return { ok:false, status:503 };
    return { ok:true, text:async () => '<a href="https://careers.acme.com/jobs/platform-engineer">Platform Engineer</a>' };
  };
  const result = await resolveJobrightUrl('https://jobright.ai/jobs/info/search-retry-id', fakeFetch);
  assert.equal(result.url, 'https://careers.acme.com/jobs/platform-engineer');
  assert.equal(searchCalls, 2);
});

test('uses an independent search provider when the first one has no result', async () => {
  const providers = [];
  const fakeFetch = async url => {
    if (String(url).includes('jobright.ai/jobs/info')) {
      return {
        ok:true,
        text:async () => `<title>Data Engineer @ Northstar | Jobright.ai</title><script id="job-posting" type="application/ld+json">{"title":"Data Engineer","hiringOrganization":{"name":"Northstar","sameAs":"https://northstar.example"}}</script>`
      };
    }
    if (String(url).includes('search.yahoo.com')) {
      providers.push('yahoo');
      return { ok:true, text:async () => '<a href="https://indeed.com/viewjob?id=1">Data Engineer</a>' };
    }
    if (String(url).includes('search.brave.com')) {
      providers.push('brave');
      return { ok:true, text:async () => '<a href="https://jobs.workable.com/northstar/j/data-engineer">Data Engineer</a>' };
    }
    return { ok:false, status:404 };
  };
  const result = await resolveJobrightUrl('https://jobright.ai/jobs/info/multi-search-id', fakeFetch);
  assert.equal(result.url, 'https://jobs.workable.com/northstar/j/data-engineer');
  assert.deepEqual(providers, ['yahoo', 'yahoo', 'brave']);
});
