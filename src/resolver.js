const BLOCKED_HOSTS = [
  'jobright.ai', 'www.jobright.ai', 'google.com', 'googleapis.com', 'gstatic.com',
  'facebook.com', 'twitter.com', 'x.com', 'linkedin.com', 'crunchbase.com',
  'cloudfront.net', 'sentry.io', 'segment.io'
];
const ATS_HINTS = ['greenhouse.io', 'lever.co', 'myworkdayjobs.com', 'ashbyhq.com', 'smartrecruiters.com', 'icims.com', 'bamboohr.com', 'jobvite.com', 'applytojob.com'];
const AGGREGATORS = ['indeed.com', 'ziprecruiter.com', 'glassdoor.com', 'builtin.com', 'talent.com', 'jooble.org', 'simplyhired.com'];

function decode(value) {
  return value.replace(/\\u0026/g, '&').replace(/\\u003d/g, '=').replace(/\\u002f/gi, '/').replace(/\\\//g, '/').replace(/&amp;/g, '&');
}

function extractTitle(html) {
  const match = html.match(/<meta[^>]+(?:property|name)=["']og:title["'][^>]+content=["']([^"']+)/i)
    || html.match(/<title[^>]*>([^<]+)/i);
  return match ? decode(match[1]).replace(/\s*\|\s*Jobright.*$/i, '').trim() : 'Original job posting';
}

function score(candidate) {
  let url;
  try { url = new URL(candidate); } catch { return -Infinity; }
  const host = url.hostname.replace(/^www\./, '');
  if (!['http:', 'https:'].includes(url.protocol)) return -Infinity;
  if (BLOCKED_HOSTS.some(item => host === item || host.endsWith(`.${item}`))) return -Infinity;
  let points = 0;
  if (ATS_HINTS.some(item => host.endsWith(item))) points += 100;
  if (/\b(job|jobs|career|careers|position|posting|apply|requisition)\b/i.test(url.href)) points += 35;
  if (/\.(js|css|png|jpe?g|svg|webp|woff2?|ico)(\?|$)/i.test(url.pathname)) points -= 200;
  if (/privacy|terms|support|help|blog|news/i.test(url.pathname)) points -= 70;
  if (url.searchParams.has('gh_jid') || url.searchParams.has('jobId')) points += 30;
  return points;
}

function extractCandidates(html) {
  const decoded = decode(html);
  const matches = decoded.match(/https?:\/\/[^\s"'<>\\]+/g) || [];
  return [...new Set(matches.map(raw => raw.replace(/[),;]+$/, '')))]
    .map(url => ({ url, score: score(url) }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score);
}

function extractJobData(html) {
  const match = html.match(/<script[^>]+id=["']job-posting["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!match) return {};
  try {
    const data = JSON.parse(match[1]);
    return {
      title: data.title || '',
      company: data.hiringOrganization?.name || '',
      companyUrl: data.hiringOrganization?.sameAs || ''
    };
  } catch { return {}; }
}

function searchScore(candidate, job) {
  let url;
  try { url = new URL(candidate); } catch { return -Infinity; }
  const host = url.hostname.replace(/^www\./, '');
  if (BLOCKED_HOSTS.some(item => host === item || host.endsWith(`.${item}`))) return -Infinity;
  if (AGGREGATORS.some(item => host === item || host.endsWith(`.${item}`))) return -Infinity;
  let points = score(candidate);
  let companyHost = '';
  try { companyHost = new URL(job.companyUrl).hostname.replace(/^www\./, ''); } catch {}
  if (companyHost && (host === companyHost || host.endsWith(`.${companyHost}`))) points += 150;
  const terms = job.title.toLowerCase().split(/[^a-z0-9]+/).filter(term => term.length > 3);
  const haystack = decodeURIComponent(url.pathname).toLowerCase();
  points += terms.filter(term => haystack.includes(term)).length * 9;
  if (/\/jobs?\//i.test(url.pathname)) points += 30;
  return points;
}

function extractSearchResults(xml) {
  return [...xml.matchAll(/<item>[\s\S]*?<link>(https?:\/\/[^<]+)<\/link>[\s\S]*?<\/item>/gi)]
    .map(match => decode(match[1]));
}

function normalizedTitle(value = '') {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function titleMatchScore(left, right) {
  const a = normalizedTitle(left);
  const b = normalizedTitle(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const aTerms = new Set(a.split(' ').filter(term => term.length > 1));
  const bTerms = new Set(b.split(' ').filter(term => term.length > 1));
  const overlap = [...aTerms].filter(term => bTerms.has(term)).length;
  return overlap / Math.max(aTerms.size, bTerms.size);
}

function companySlugs(job) {
  const slugs = [];
  const company = (job.company || '').toLowerCase().replace(/\b(inc|llc|ltd|corp|corporation|company|co)\b\.?/g, '').trim();
  if (company) {
    slugs.push(company.replace(/[^a-z0-9]/g, ''));
    slugs.push(company.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''));
  }
  try {
    const hostPart = new URL(job.companyUrl).hostname.replace(/^www\./, '').split('.')[0];
    slugs.push(hostPart);
  } catch {}
  return [...new Set(slugs.filter(Boolean))];
}

async function discoverFromAts(job, fetcher) {
  const requests = companySlugs(job).flatMap(slug => [
    { kind: 'greenhouse', url: `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=false` },
    { kind: 'lever', url: `https://api.lever.co/v0/postings/${slug}?mode=json` },
    { kind: 'ashby', url: `https://api.ashbyhq.com/posting-api/job-board/${slug}` }
  ]);
  const responses = await Promise.all(requests.map(async request => {
    try {
      const response = await fetcher(request.url, {
        headers: { 'user-agent': 'RightToSource/1.0', accept: 'application/json' },
        signal: AbortSignal.timeout(8_000)
      });
      if (!response.ok) return [];
      const data = await response.json();
      if (request.kind === 'greenhouse') return (data.jobs || []).map(item => ({ title: item.title, url: item.absolute_url }));
      if (request.kind === 'lever') return (Array.isArray(data) ? data : []).map(item => ({ title: item.text, url: item.hostedUrl || item.applyUrl }));
      return (data.jobs || []).map(item => ({ title: item.title, url: item.jobUrl || item.applyUrl }));
    } catch { return []; }
  }));
  return responses.flat()
    .map(item => ({ ...item, match: titleMatchScore(job.title, item.title) }))
    .filter(item => item.url && item.match >= 0.6)
    .sort((a, b) => b.match - a.match)[0]?.url || null;
}

async function findViaSearch(job, fetcher) {
  if (!job.title || !job.company) return null;
  const query = `\"${job.title}\" ${job.company} jobs`;
  try {
    const response = await fetcher(`https://search.brave.com/search?q=${encodeURIComponent(query)}&source=web`, {
      headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124 Safari/537.36', accept: 'text/html' },
      signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) return null;
    const html = decode(await response.text());
    const links = [...html.matchAll(/<a[^>]+href=["'](https?:\/\/[^"']+)["'][^>]*>/gi)].map(match => match[1]);
    const results = [...new Set(links)]
      .map(url => ({ url, score: searchScore(url, job) }))
      .filter(item => item.score > 20)
      .sort((a, b) => b.score - a.score);
    return results[0]?.url || null;
  } catch { return null; }
}

async function resolveJobrightUrl(input, fetcher = fetch) {
  let source;
  try { source = new URL(String(input || '').trim()); } catch { const error = new Error('Paste a valid Jobright or Simplify URL.'); error.code = 'BAD_URL'; throw error; }
  const host = source.hostname.toLowerCase().replace(/^www\./, '');
  const isJobright = host === 'jobright.ai' && source.pathname.includes('/jobs/info/');
  const simplifyMatch = host === 'simplify.jobs' && source.pathname.match(/^\/p\/([a-f0-9-]{20,})\//i);
  if (!isJobright && !simplifyMatch) {
    const error = new Error('That does not look like a Jobright or Simplify job posting URL.'); error.code = 'BAD_URL'; throw error;
  }

  if (simplifyMatch) {
    try {
      const redirect = await fetcher(`https://simplify.jobs/jobs/click/${simplifyMatch[1]}`, {
        redirect: 'manual',
        headers: { 'user-agent': 'Mozilla/5.0 (compatible; RightToSource/1.0)' },
        signal: AbortSignal.timeout(10_000)
      });
      const location = redirect.headers?.get?.('location');
      if (location && score(location) > 0) {
        return {
          url: location,
          title: source.pathname.split('/').slice(3).join(' ').replace(/-/g, ' ') || 'Original job posting',
          source: new URL(location).hostname.replace(/^www\./, ''),
          isSearchFallback: false
        };
      }
    } catch {}
  }

  const response = await fetcher(source, {
    redirect: 'follow',
    headers: { 'user-agent': 'Mozilla/5.0 (compatible; RightToSource/1.0)', accept: 'text/html,application/xhtml+xml' },
    signal: AbortSignal.timeout(12_000)
  });
  if (!response.ok) throw new Error(`${isJobright ? 'Jobright' : 'Simplify'} returned ${response.status}. Try again in a moment.`);
  const html = await response.text();
  const candidates = extractCandidates(html);
  const job = extractJobData(html);
  const resolvedUrl = candidates[0]?.url || await discoverFromAts(job, fetcher) || await findViaSearch(job, fetcher);
  if (!resolvedUrl) throw new Error('The official employer URL could not be verified yet. Please try again in a moment.');
  return { url: resolvedUrl, title: extractTitle(html), source: new URL(resolvedUrl).hostname.replace(/^www\./, ''), isSearchFallback: false };
}

module.exports = { resolveJobrightUrl, extractCandidates, extractTitle, extractJobData, extractSearchResults, titleMatchScore, companySlugs, discoverFromAts, score };
