/* News is fetched through the local Atlas server, with a total request deadline. */
window.AtlasNews = (() => {
  const CACHE_MS = 5 * 60 * 1000;
  const REQUEST_TIMEOUT_MS = 10000;
  const LOCAL_SERVICE = 'http://127.0.0.1:8765';
  const cache = new Map();

  function serviceEndpoints(country) {
    const path = `/api/news?${new URLSearchParams({ country })}`;
    if (location.protocol === 'file:') return [LOCAL_SERVICE + path];
    const endpoints = [path];
    if (['localhost', '127.0.0.1', '[::1]'].includes(location.hostname) && location.port !== '8765') {
      endpoints.push(LOCAL_SERVICE + path);
    }
    return endpoints;
  }

  function safeUrl(value) {
    try {
      const url = new URL(value);
      return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : '';
    } catch { return ''; }
  }

  function normaliseArticles(articles) {
    const titles = new Set(), urls = new Set(), results = [];
    for (const article of articles) {
      const title = typeof article?.title === 'string' ? article.title.trim() : '';
      const url = safeUrl(article?.url);
      if (!title || !url) continue;
      const key = title.toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
      if (titles.has(key) || urls.has(url)) continue;
      titles.add(key); urls.add(url);
      const date = new Date(article.publishedAt || '');
      results.push({
        title, url,
        source: typeof article.source === 'string' ? article.source : new URL(url).hostname,
        image: safeUrl(article.image),
        publishedAt: Number.isNaN(date.getTime()) ? null : date.toISOString(),
      });
      if (results.length === 20) break;
    }
    return results;
  }

  async function requestNews(country, signal) {
    const controller = new AbortController();
    let timer;
    let onAbort;
    const deadline = new Promise((_, reject) => {
      onAbort = () => {
        reject(new DOMException('Request cancelled', 'AbortError'));
        controller.abort();
      };
      timer = setTimeout(() => {
        reject(new Error('The news search took too long. Please try again.'));
        controller.abort();
      }, REQUEST_TIMEOUT_MS);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
    const operation = (async () => {
      let data;
      const endpoints = serviceEndpoints(country);
      for (let index = 0; index < endpoints.length; index++) {
        try {
          const response = await fetch(endpoints[index], {
            signal: controller.signal, cache: 'no-store',
          });
          try { data = JSON.parse(await response.text()); }
          catch { throw new Error('This page is not connected to the Atlas service. Run Start Atlas.cmd and retry.'); }
          if (!response.ok) throw new Error(data?.error || 'News sources are unavailable. Please try again.');
          if (data?.country !== country || !Array.isArray(data.articles)) {
            throw new Error('The news service returned an unexpected response. Please try again.');
          }
          break;
        } catch (error) {
          if (controller.signal.aborted || index === endpoints.length - 1) throw error;
        }
      }
      return {
        articles: normaliseArticles(data.articles),
        fetchedAt: Number.isFinite(data.fetchedAt) ? data.fetchedAt : Date.now(),
        provider: typeof data.provider === 'string' ? data.provider : 'News feeds',
      };
    })();
    try {
      // The deadline rejects independently, even if a stalled fetch ignores abort.
      return await Promise.race([operation, deadline]);
    } catch (error) {
      if (error instanceof TypeError) {
        throw new Error('Cannot reach Atlas. Start the local service using Start Atlas.cmd, then open http://127.0.0.1:8765.');
      }
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  async function getStories(country, { signal } = {}) {
    if (signal?.aborted) throw new DOMException('Request cancelled', 'AbortError');
    if (typeof country !== 'string' || !country.trim()) throw new Error('Choose a country first.');
    const cached = cache.get(country);
    if (cached && Date.now() - cached.fetchedAt < CACHE_MS) return cached;
    const result = await requestNews(country, signal);
    if (result.articles.length && !signal?.aborted) cache.set(country, result);
    return result;
  }

  return { getStories, normaliseArticles };
})();
