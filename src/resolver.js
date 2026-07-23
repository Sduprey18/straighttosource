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
const NON_JOB_HOSTS = [
  ...AGGREGATORS, 'linkedin.com', 'facebook.com', 'twitter.com', 'x.com',
  'crunchbase.com', 'youtube.com', 'instagram.com'
];
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

function hostMatches(host, domain) {
  return host === domain || host.endsWith(`.${domain}`);
}

function isGenericJobsUrl(candidate) {
  try {
    const url = new URL(candidate);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    if (/^\/(?:jobs?|careers?|opportunities|open-roles?|join-us|work-with-us)?$/i.test(path)) return true;
    if (/(?:^|\/)(?:search|job-search|jobs-search|find-jobs|open-positions)(?:\/|$)/i.test(path)) return true;
    if (/^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?(?:jobs?|careers?)$/i.test(path)) return true;
    return false;
  } catch {
    return true;
  }
}

function isSpecificJobUrl(candidate) {
  let url;
  try { url = new URL(candidate); } catch { return false; }
  if (!['http:', 'https:'].includes(url.protocol) || isGenericJobsUrl(candidate)) return false;
  const host = url.hostname.replace(/^www\./, '');
  if (NON_JOB_HOSTS.some(item => hostMatches(host, item))) return false;

  const hasJobIdentifier = [...url.searchParams.keys()].some(key =>
    /^(?:gh_jid|job_?id|jid|posting_?id|position_?id|requisition_?id|req_?id)$/i.test(key)
      && url.searchParams.get(key)
  );
  if (hasJobIdentifier) return true;

  const segments = url.pathname.split('/').filter(Boolean);
  const markerIndex = segments.findIndex(segment =>
    /^(?:jobs?|positions?|postings?|requisitions?|details?|vacancies|opportunities|apply)$/i.test(segment)
  );
  if (markerIndex >= 0 && segments.length > markerIndex + 1) return true;

  const isAts = ATS_HINTS.some(item => hostMatches(host, item));
  return isAts && segments.length >= 2;
}

function score(candidate) {
  let url;
  try { url = new URL(candidate); } catch { return -Infinity; }
  const host = url.hostname.replace(/^www\./, '');
  if (!['http:', 'https:'].includes(url.protocol)) return -Infinity;
  if (BLOCKED_HOSTS.some(item => hostMatches(host, item))) return -Infinity;
  let points = 0;
  if (ATS_HINTS.some(item => hostMatches(host, item))) points += 100;
  if (/\b(job|jobs|career|careers|position|posting|apply|requisition)\b/i.test(url.href)) points += 35;
  if (/\.(js|css|png|jpe?g|svg|webp|woff2?|ico)(\?|$)/i.test(url.pathname)) points -= 200;
  if (/privacy|terms|support|help|blog|news/i.test(url.pathname)) points -= 70;
  if (url.searchParams.has('gh_jid') || url.searchParams.has('jobId')) points += 30;
  if (isGenericJobsUrl(candidate)) points -= 200;
  if (isSpecificJobUrl(candidate)) points += 80;
  return points;
}

function extractCandidates(html) {
  const decoded = decode(html);
  const matches = decoded.match(/https?:\/\/[^\s"'<>\\]+/g) || [];
  return [...new Set(matches.map(raw => raw.replace(/[),;]+$/, '')))]
    .map(url => ({ url, score: score(url) }))
    .filter(item => item.score > 0 && isSpecificJobUrl(item.url))
    .sort((a, b) => b.score - a.score);
}

function parseScriptJson(html, id) {
  const pattern = new RegExp(`<script[^>]+id=["']${id}["'][^>]*>([\\s\\S]*?)<\\/script>`, 'i');
  const match = html.match(pattern);
  if (!match) return null;
  try { return JSON.parse(match[1]); } catch { return null; }
}

function extractJsonLdJob(html) {
  for (const match of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const parsed = JSON.parse(match[1]);
      const items = Array.isArray(parsed) ? parsed : parsed['@graph'] || [parsed];
      const posting = items.find(item => {
        const type = item?.['@type'];
        return type === 'JobPosting' || (Array.isArray(type) && type.includes('JobPosting'));
      });
      if (posting) return posting;
    } catch {}
  }
  return null;
}

function extractJobData(html) {
  const legacy = parseScriptJson(html, 'job-posting') || {};
  const jsonLd = extractJsonLdJob(html) || {};
  const helper = parseScriptJson(html, 'jobright-helper-job-detail-info') || {};
  const nextData = parseScriptJson(html, '__NEXT_DATA__') || {};
  const jobright = helper.jobResult || {};
  const jobrightCompany = helper.companyResult || {};
  const simplify = nextData.props?.pageProps?.jobPosting || {};
  const structured = Object.keys(jsonLd).length ? jsonLd : legacy;
  const validThrough = structured.validThrough ? Date.parse(structured.validThrough) : NaN;
  const textSaysClosed = /(?:this|the) job (?:has closed|is closed|is no longer (?:available|accepting applications))/i.test(html);

  return {
    title: jobright.jobTitle || simplify.title || structured.title || '',
    company: jobrightCompany.companyName || structured.hiringOrganization?.name || '',
    companyUrl: jobrightCompany.companyURL || structured.hiringOrganization?.sameAs || '',
    applicationUrl: jobright.applyLink || jobright.originalUrl || '',
    isClosed: jobright.isDeleted === true
      || simplify.active === false
      || (simplify.active == null && simplify.visible === false)
      || (Number.isFinite(validThrough) && validThrough < Date.now())
      || textSaysClosed
  };
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

function companyTerms(job) {
  return [...new Set(
    String(job.company || '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(term => term.length >= 4 && !['company', 'group', 'holdings', 'services', 'technologies'].includes(term))
  )];
}

function isCompanyBrandedHost(host, job) {
  const labels = host.toLowerCase().split('.');
  return companyTerms(job).some(term => labels.some(label => label === term || label.startsWith(`${term}-`)));
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
  const belongsToCompany = companyHost && hostMatches(host, companyHost);
  const isAts = ATS_HINTS.some(item => hostMatches(host, item));
  const isCompanyBrand = isCompanyBrandedHost(host, job);
  if (!belongsToCompany && !isAts && !isCompanyBrand) return -Infinity;
  if (!isSpecificJobUrl(link.url)) return -Infinity;

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
  if (isCompanyBrand) points += 50;
  return points;
}

function isCareersPage(link, companyHost) {
  try {
    const url = new URL(link.url);
    const host = url.hostname.replace(/^www\./, '');
    const belongsToCompany = hostMatches(host, companyHost);
    const isAts = ATS_HINTS.some(item => hostMatches(host, item));
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

function closedJobError() {
  const error = new Error('This job is closed and is no longer accepting applications.');
  error.code = 'JOB_CLOSED';
  return error;
}

async function verifyResolvedUrl(candidate, job, fetcher) {
  if (!candidate || !isSpecificJobUrl(candidate)) return null;

  try {
    const response = await fetcher(candidate, {
      redirect: 'follow',
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; RightToSource/1.0)',
        accept: 'text/html,application/xhtml+xml'
      },
      signal: AbortSignal.timeout(7_000)
    });
    if (!response.ok) return candidate;

    const finalUrl = response.url || candidate;
    if (!isSpecificJobUrl(finalUrl)) return null;
    const contentType = response.headers?.get?.('content-type') || '';
    if (contentType && !contentType.includes('html')) return finalUrl;

    const html = await response.text();
    const destination = extractJobData(html);
    if (destination.isClosed) throw closedJobError();
    if (destination.title && job.title && titleMatchScore(job.title, destination.title) < 0.45) return null;
    return finalUrl;
  } catch (error) {
    if (error?.code === 'JOB_CLOSED') throw error;
    // Many ATS sites reject server-side checks while the same job URL works in a browser.
    return candidate;
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

  let simplifyRedirect = null;
  if (simplifyMatch) {
    try {
      const redirect = await fetcher(`https://simplify.jobs/jobs/click/${simplifyMatch[1]}`, {
        redirect: 'manual',
        headers: { 'user-agent': 'Mozilla/5.0 (compatible; RightToSource/1.0)' },
        signal: AbortSignal.timeout(10_000)
      });
      const location = redirect.headers?.get?.('location');
      if (location && isSpecificJobUrl(location)) simplifyRedirect = location;
    } catch {}
  }

  const response = await fetcher(source, {
    redirect: 'follow',
    headers: { 'user-agent': 'Mozilla/5.0 (compatible; RightToSource/1.0)', accept: 'text/html,application/xhtml+xml' },
    signal: AbortSignal.timeout(12_000)
  });
  if (!response.ok) {
    if (simplifyRedirect) {
      return {
        url: simplifyRedirect,
        title: source.pathname.split('/').slice(3).join(' ').replace(/-/g, ' ') || 'Original job posting',
        source: new URL(simplifyRedirect).hostname.replace(/^www\./, ''),
        isSearchFallback: false
      };
    }
    throw new Error(`${isJobright ? 'Jobright' : 'Simplify'} returned ${response.status}. Try again in a moment.`);
  }
  const html = await response.text();
  const job = extractJobData(html);
  if (job.isClosed) throw closedJobError();
  if (!job.title) job.title = extractTitle(html);

  const embeddedCandidates = [
    simplifyRedirect,
    job.applicationUrl,
    ...extractCandidates(html).map(item => item.url)
  ].filter(Boolean);
  let resolvedUrl = null;
  for (const candidate of embeddedCandidates) {
    resolvedUrl = await verifyResolvedUrl(candidate, job, fetcher);
    if (resolvedUrl) break;
  }

  const discoverers = [discoverFromAts, discoverFromCompanySite, findViaSearch];
  for (const discover of discoverers) {
    if (resolvedUrl) break;
    const candidate = await discover(job, fetcher);
    resolvedUrl = await verifyResolvedUrl(candidate, job, fetcher);
  }

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
  score,
  isSpecificJobUrl,
  isGenericJobsUrl,
  verifyResolvedUrl
};
