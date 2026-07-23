const BLOCKED_HOSTS = [
  'jobright.ai', 'www.jobright.ai', 'google.com', 'googleapis.com', 'gstatic.com',
  'facebook.com', 'twitter.com', 'x.com', 'linkedin.com', 'crunchbase.com',
  'cloudfront.net', 'sentry.io', 'segment.io'
];
const ATS_HINTS = [
  'greenhouse.io', 'lever.co', 'myworkdayjobs.com', 'ashbyhq.com',
  'smartrecruiters.com', 'recruitee.com', 'workable.com', 'ats.rippling.com',
  'icims.com', 'bamboohr.com', 'jobvite.com', 'applytojob.com'
];
const AGGREGATORS = ['indeed.com', 'ziprecruiter.com', 'glassdoor.com', 'builtin.com', 'talent.com', 'jooble.org', 'simplyhired.com'];
const RESULT_CACHE_TTL = 6 * 60 * 60 * 1_000;
const RESULT_CACHE_LIMIT = 200;
const resultCache = new Map();
const inFlightResolutions = new Map();

function wait(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function cacheKey(input) {
  try {
    const url = new URL(String(input || '').trim());
    url.hash = '';
    url.search = '';
    return url.toString();
  } catch {
    return String(input || '').trim();
  }
}

function cacheResult(key, value) {
  resultCache.delete(key);
  resultCache.set(key, { value, expiresAt: Date.now() + RESULT_CACHE_TTL });
  while (resultCache.size > RESULT_CACHE_LIMIT) {
    resultCache.delete(resultCache.keys().next().value);
  }
}

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
  let companyHost = '';
  try { companyHost = new URL(job.companyUrl).hostname.replace(/^www\./, ''); } catch {}
  const belongsToCompany = companyHost && (host === companyHost || host.endsWith(`.${companyHost}`));
  if (!belongsToCompany && BLOCKED_HOSTS.some(item => host === item || host.endsWith(`.${item}`))) return -Infinity;
  if (AGGREGATORS.some(item => host === item || host.endsWith(`.${item}`))) return -Infinity;
  let points = score(candidate);
  if (belongsToCompany && points === -Infinity && ['http:', 'https:'].includes(url.protocol)) {
    points = 0;
    if (/\b(job|jobs|career|careers|position|posting|apply|requisition)\b/i.test(url.href)) points += 35;
  }
  if (belongsToCompany) points += 150;
  const terms = job.title.toLowerCase().split(/[^a-z0-9]+/).filter(term => term.length > 3);
  let haystack = url.pathname.toLowerCase();
  try { haystack = decodeURIComponent(url.pathname).toLowerCase(); } catch {}
  points += terms.filter(term => haystack.includes(term)).length * 9;
  if (/\/jobs?\//i.test(url.pathname)) points += 30;
  return points;
}

function extractSearchResults(xml) {
  return [...xml.matchAll(/<item>[\s\S]*?<link>(https?:\/\/[^<]+)<\/link>[\s\S]*?<\/item>/gi)]
    .map(match => decode(match[1]));
}

function extractPageLinks(html, baseUrl) {
  const links = [];
  for (const match of html.matchAll(/<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    try {
      const url = new URL(decode(match[1]), baseUrl).toString();
      const text = decode(match[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
      links.push({ url, text });
    } catch {}
  }
  return links;
}

function unwrapYahooUrl(candidate) {
  try {
    const url = new URL(candidate);
    if (url.hostname === 'r.search.yahoo.com') {
      const match = url.pathname.match(/\/RU=([^/]+)/);
      if (match) return decodeURIComponent(match[1]);
    }
  } catch {}
  return candidate;
}

function normalizedTitle(value = '') {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function titleMatchScore(left, right) {
  const a = normalizedTitle(left);
  const b = normalizedTitle(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const aList = a.split(' ').filter(term => term.length > 1);
  const bList = b.split(' ').filter(term => term.length > 1);
  const containsSequence = (haystack, needle) => needle.length >= 2
    && haystack.some((_, index) => needle.every((term, offset) => haystack[index + offset] === term));
  if (containsSequence(aList, bList) || containsSequence(bList, aList)) return 1;
  const aTerms = new Set(aList);
  const bTerms = new Set(bList);
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
    { kind: 'ashby', url: `https://api.ashbyhq.com/posting-api/job-board/${slug}` },
    { kind: 'recruitee', url: `https://${slug}.recruitee.com/api/offers/` }
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
      if (request.kind === 'recruitee') return (data.offers || []).map(item => ({ title: item.title, url: item.careers_url }));
      return (data.jobs || []).map(item => ({ title: item.title, url: item.jobUrl || item.applyUrl }));
    } catch { return []; }
  }));
  return responses.flat()
    .map(item => ({ ...item, match: titleMatchScore(job.title, item.title) }))
    .filter(item => item.url && item.match >= 0.6)
    .sort((a, b) => b.match - a.match)[0]?.url || null;
}

function officialLinkScore(link, job, companyHost) {
  let url;
  try { url = new URL(link.url); } catch { return -Infinity; }
  if (!['http:', 'https:'].includes(url.protocol)) return -Infinity;

  const host = url.hostname.replace(/^www\./, '');
  const belongsToCompany = companyHost && (host === companyHost || host.endsWith(`.${companyHost}`));
  const isAts = ATS_HINTS.some(item => host === item || host.endsWith(`.${item}`));
  if (!belongsToCompany && !isAts) return -Infinity;
  if (/\/(?:careers?|jobs?)(?:\/(?:students?|internships?|opportunities|open-roles?))?\/?$/i.test(url.pathname)) {
    return -Infinity;
  }

  const textMatch = titleMatchScore(job.title, link.text);
  let decodedPath = url.pathname;
  try { decodedPath = decodeURIComponent(url.pathname); } catch {}
  const pathMatch = titleMatchScore(job.title, decodedPath);
  if (Math.max(textMatch, pathMatch) < 0.55) return -Infinity;

  let points = searchScore(link.url, job);
  points += textMatch * 300;
  points += pathMatch * 180;
  if (isAts) points += 100;
  if (belongsToCompany) points += 60;
  return points;
}

function isCareersPage(link, companyHost) {
  try {
    const url = new URL(link.url);
    const host = url.hostname.replace(/^www\./, '');
    const belongsToCompany = host === companyHost || host.endsWith(`.${companyHost}`);
    const isAts = ATS_HINTS.some(item => host === item || host.endsWith(`.${item}`));
    return (belongsToCompany || isAts)
      && /(?:^|\/)(?:careers?|jobs?|join-us|open-roles?|work-with-us)(?:\/|$)/i.test(url.pathname);
  } catch {
    return false;
  }
}

async function fetchHtml(url, fetcher) {
  try {
    const response = await fetcher(url, {
      redirect: 'follow',
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; RightToSource/1.0)',
        accept: 'text/html,application/xhtml+xml'
      },
      signal: AbortSignal.timeout(6_000)
    });
    if (!response.ok) return null;
    const contentType = response.headers?.get?.('content-type') || '';
    if (contentType && !contentType.includes('html')) return null;
    return await response.text();
  } catch {
    return null;
  }
}

function bestOfficialLink(links, job, companyHost) {
  return links
    .map(link => ({ ...link, score: officialLinkScore(link, job, companyHost) }))
    .filter(link => link.score > 0)
    .sort((a, b) => b.score - a.score)[0]?.url || null;
}

async function discoverFromWorkdayLinks(links, job, fetcher) {
  const boards = [...new Set(links.map(link => link.url).filter(candidate => {
    try { return new URL(candidate).hostname.endsWith('.myworkdayjobs.com'); } catch { return false; }
  }))].slice(0, 2);

  for (const boardUrl of boards) {
    const boardHtml = await fetchHtml(boardUrl, fetcher);
    const tenant = boardHtml?.match(/\btenant:\s*["']([^"']+)/)?.[1];
    const siteId = boardHtml?.match(/\bsiteId:\s*["']([^"']+)/)?.[1];
    if (!tenant || !siteId) continue;

    try {
      const board = new URL(boardUrl);
      const endpoint = `${board.origin}/wday/cxs/${encodeURIComponent(tenant)}/${encodeURIComponent(siteId)}/jobs`;
      const response = await fetcher(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          appliedFacets: {},
          limit: 20,
          offset: 0,
          searchText: job.title
        }),
        signal: AbortSignal.timeout(6_000)
      });
      if (!response.ok) continue;
      const data = await response.json();
      const match = (data.jobPostings || [])
        .map(item => ({ ...item, match: titleMatchScore(job.title, item.title) }))
        .filter(item => item.externalPath && item.match >= 0.6)
        .sort((a, b) => b.match - a.match)[0];
      if (match) return `${board.origin}/en-US/${siteId}${match.externalPath}`;
    } catch {}
  }
  return null;
}

async function discoverFromCompanySite(job, fetcher) {
  let companyUrl;
  try { companyUrl = new URL(job.companyUrl); } catch { return null; }
  if (!['http:', 'https:'].includes(companyUrl.protocol)) return null;
  const companyHost = companyUrl.hostname.replace(/^www\./, '');

  const homepage = await fetchHtml(companyUrl, fetcher);
  const homepageLinks = homepage ? extractPageLinks(homepage, companyUrl) : [];
  const directMatch = bestOfficialLink(homepageLinks, job, companyHost);
  if (directMatch) return directMatch;

  const discoveredPages = homepageLinks
    .filter(link => isCareersPage(link, companyHost))
    .map(link => link.url);
  const fallbackPages = [
    new URL('/careers', companyUrl).toString(),
    new URL('/jobs', companyUrl).toString()
  ];
  const pages = [...new Set([...discoveredPages, ...fallbackPages])]
    .filter(url => url !== companyUrl.toString())
    .slice(0, 4);

  const pageResults = await Promise.all(pages.map(async pageUrl => {
    const html = await fetchHtml(pageUrl, fetcher);
    return html ? extractPageLinks(html, pageUrl) : [];
  }));
  const allLinks = [...homepageLinks, ...pageResults.flat()];
  const pageMatch = bestOfficialLink(allLinks, job, companyHost);
  if (pageMatch) return pageMatch;
  return discoverFromWorkdayLinks(allLinks, job, fetcher);
}

async function findViaSearch(job, fetcher) {
  if (!job.title || !job.company) return null;
  let companyHost = '';
  try { companyHost = new URL(job.companyUrl).hostname.replace(/^www\./, ''); } catch {}
  const generalQuery = `\"${job.title}\" ${job.company} jobs`;
  const queries = companyHost
    ? [`\"${job.title}\" site:${companyHost}`, generalQuery]
    : [generalQuery];
  const providers = queries.flatMap(query => [
    {
      url: `https://search.yahoo.com/search?p=${encodeURIComponent(query)}`,
      extract: (html, url) => extractPageLinks(html, url)
        .map(link => ({ ...link, url: unwrapYahooUrl(link.url) }))
    },
    {
      url: `https://search.brave.com/search?q=${encodeURIComponent(query)}&source=web`,
      extract: (html, url) => extractPageLinks(html, url)
    }
  ]);

  for (const provider of providers) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await fetcher(provider.url, {
          headers: {
            'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124 Safari/537.36',
            accept: 'text/html',
            'accept-language': 'en-US,en;q=0.9'
          },
          signal: AbortSignal.timeout(7_000)
        });
        if (!response.ok) {
          if (attempt === 0 && (response.status === 429 || response.status >= 500)) {
            await wait(75);
            continue;
          }
          break;
        }
        const html = decode(await response.text());
        const uniqueLinks = [...new Map(provider.extract(html, provider.url).map(link => [link.url, link])).values()];
        const results = uniqueLinks
          .map(link => ({ ...link, score: officialLinkScore(link, job, companyHost) }))
          .filter(item => item.score > 20)
          .sort((a, b) => b.score - a.score);
        if (results[0]?.url) return results[0].url;
        if (attempt === 0) {
          await wait(75);
          continue;
        }
        break;
      } catch {
        if (attempt === 0) {
          await wait(75);
          continue;
        }
      }
    }
  }
  return null;
}

async function resolveJobrightUrlUncached(input, fetcher) {
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
  const resolvedUrl = candidates[0]?.url
    || await discoverFromAts(job, fetcher)
    || await discoverFromCompanySite(job, fetcher)
    || await findViaSearch(job, fetcher);
  if (!resolvedUrl) throw new Error('The official employer URL could not be verified yet. Please try again in a moment.');
  return { url: resolvedUrl, title: extractTitle(html), source: new URL(resolvedUrl).hostname.replace(/^www\./, ''), isSearchFallback: false };
}

async function resolveJobrightUrl(input, fetcher = fetch) {
  // Custom fetchers are used by tests and callers that need isolated behavior.
  if (fetcher !== fetch) return resolveJobrightUrlUncached(input, fetcher);

  const key = cacheKey(input);
  const cached = resultCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  if (cached) resultCache.delete(key);
  if (inFlightResolutions.has(key)) return inFlightResolutions.get(key);

  const resolution = resolveJobrightUrlUncached(input, fetcher)
    .then(value => {
      cacheResult(key, value);
      return value;
    })
    .finally(() => inFlightResolutions.delete(key));
  inFlightResolutions.set(key, resolution);
  return resolution;
}

module.exports = {
  resolveJobrightUrl,
  extractCandidates,
  extractTitle,
  extractJobData,
  extractSearchResults,
  titleMatchScore,
  companySlugs,
  discoverFromAts,
  discoverFromCompanySite,
  discoverFromWorkdayLinks,
  findViaSearch,
  extractPageLinks,
  unwrapYahooUrl,
  score
};
