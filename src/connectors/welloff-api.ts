import 'dotenv/config';

const baseUrl = process.env.WELLOFF_API_URL ?? 'http://localhost:3000';

async function post<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`WellOff API ${path} returned ${res.status}: ${text}`);
  }

  return res.json() as Promise<T>;
}

export async function callMetaAds(
  action: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  return post('/api/meta-ads', { action, ...params });
}

export async function callGoogleAds(
  action: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  return post('/api/google-ads', { action, ...params });
}
