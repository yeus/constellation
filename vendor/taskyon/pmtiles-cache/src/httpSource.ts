import { EtagMismatch, type RangeResponse, type Source } from 'pmtiles'

export interface PmtilesHttpSourceOptions {
  readonly url: string
  readonly headers?: HeadersInit
  readonly credentials?: RequestCredentials
  readonly fetch?: typeof fetch
}

const rangePattern = /^bytes (\d+)-(\d+)\/(\d+|\*)$/

const parseContentRange = (
  value: string | null,
): { start: number; end: number; total: number | undefined } | undefined => {
  if (!value) return undefined
  const match = rangePattern.exec(value.trim())
  if (!match) return undefined
  const start = Number(match[1])
  const end = Number(match[2])
  const total = match[3] === '*' ? undefined : Number(match[3])
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) return undefined
  if (total !== undefined && (!Number.isSafeInteger(total) || end >= total)) return undefined
  return { start, end, total }
}

/**
 * Explicit byte-range HTTP source for original PMTiles archives.
 *
 * The standard `pmtiles` FetchSource is intentionally replaced here so the
 * cache can reject a full `200` response, verify the exact requested length,
 * and validate `Content-Range` when the server exposes it.
 */
export const createPmtilesHttpSource = (options: PmtilesHttpSourceOptions): Source => {
  const request = options.fetch ?? fetch
  const baseHeaders = new Headers(options.headers)
  return {
    getKey: () => options.url,
    getBytes: async (
      offset: number,
      length: number,
      signal?: AbortSignal,
      expectedEtag?: string,
    ): Promise<RangeResponse> => {
      if (
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        !Number.isSafeInteger(length) ||
        length <= 0
      )
        throw new RangeError(
          'PMTiles HTTP ranges require non-negative offsets and positive lengths.',
        )
      const headers = new Headers(baseHeaders)
      headers.set('range', `bytes=${offset}-${offset + length - 1}`)
      const response = await request(options.url, {
        headers,
        signal,
        ...(options.credentials ? { credentials: options.credentials } : {}),
      })
      if (response.status !== 206 && response.status !== 200) {
        throw new Error(`PMTiles range request failed: HTTP ${response.status}`)
      }
      const data = await response.arrayBuffer()
      if (data.byteLength !== length) {
        throw new Error(
          `PMTiles range request returned ${data.byteLength} bytes instead of ${length}.`,
        )
      }
      if (response.status === 200) {
        const contentLength = Number(response.headers.get('content-length'))
        if (offset !== 0 || contentLength !== length) {
          throw new Error(
            'PMTiles server ignored the byte-range request; byte serving is required.',
          )
        }
      } else {
        const contentRangeHeader = response.headers.get('content-range')
        const contentRange = parseContentRange(contentRangeHeader)
        if (contentRangeHeader && !contentRange) {
          throw new Error('PMTiles server returned an invalid Content-Range header.')
        }
        if (
          contentRange &&
          (contentRange.start !== offset || contentRange.end !== offset + length - 1)
        ) {
          throw new Error('PMTiles server returned a different byte range than requested.')
        }
      }
      let etag = response.headers.get('etag') ?? undefined
      if (etag?.startsWith('W/')) etag = undefined
      if (expectedEtag && etag && etag !== expectedEtag) {
        throw new EtagMismatch(`Server returned non-matching ETag ${etag}.`)
      }
      return {
        data,
        ...(etag ? { etag } : {}),
        cacheControl: response.headers.get('cache-control') ?? undefined,
        expires: response.headers.get('expires') ?? undefined,
      }
    },
  }
}
