export class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly retryAt?: number) { super(message); }
}
export type TokenSource = () => Promise<string>;
export class ApiClient {
  private blockedUntil = 0;
  constructor(readonly base: string, readonly platform: 'github' | 'gitlab', readonly token: TokenSource) {}
  async request(path: string, method = 'GET', body?: unknown, asText = false): Promise<any> {
    if (!path.startsWith('/') || path.startsWith('//')) throw new Error('Invalid API path');
    if (Date.now() < this.blockedUntil) throw new HttpError(429, 'Platform API rate limited', this.blockedUntil);
    const url = new URL(`${this.base}${path}`);
    const response = await fetch(url, {
      method, redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { accept: 'application/json', 'content-type': 'application/json',
        ...(this.platform === 'github' ? { authorization: `Bearer ${await this.token()}`, 'x-github-api-version': '2022-11-28' } : { 'private-token': await this.token() }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      const retry = response.headers.get('retry-after');
      const remaining = response.headers.get('x-ratelimit-remaining') ?? response.headers.get('ratelimit-remaining');
      let retryAt: number | undefined;
      if (response.status === 429 || (response.status === 403 && (retry !== null || remaining === '0'))) {
        const reset = Number(response.headers.get('x-ratelimit-reset') ?? response.headers.get('ratelimit-reset')) * 1000;
        const delay = retry !== null && Number.isFinite(Number(retry)) ? Date.now() + Number(retry) * 1000 : Date.parse(retry ?? '');
        retryAt = Math.max(Date.now() + 1000, Number.isFinite(delay) ? delay : reset > Date.now() ? reset : Date.now() + 60000);
        this.blockedUntil = retryAt;
      }
      await response.body?.cancel();
      throw new HttpError(response.status, `Platform API ${method} failed (${response.status})`, retryAt);
    }
    const text = await boundedText(response, 12 * 1024 * 1024);
    return asText ? text : text ? JSON.parse(text) : null;
  }
  async page(path: string, page: number, size = 100): Promise<any[]> {
    const value = await this.request(`${path}${path.includes('?') ? '&' : '?'}per_page=${size}&page=${page}`);
    if (!Array.isArray(value)) throw new Error('Expected paginated API array');
    return value;
  }
  async *items(path: string, maxPages = 100): AsyncGenerator<any> {
    for (let page = 1; page <= maxPages; page++) {
      const values = await this.page(path, page);
      yield* values;
      if (values.length < 100) return;
    }
    throw new Error('API pagination exceeds limit; refusing incomplete state');
  }
  async pages(path: string, maxPages?: number): Promise<any[]> {
    const result = [];
    for await (const item of this.items(path, maxPages)) result.push(item);
    return result;
  }
}
export async function boundedText(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(chunks).toString('utf8');
    size += value.length;
    if (size > limit) { await reader.cancel(); throw new Error('API response exceeds limit'); }
    chunks.push(value);
  }
}
