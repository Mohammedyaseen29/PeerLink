/// <reference lib="webworker" />

import { CacheableResponsePlugin } from 'workbox-cacheable-response'
import { ExpirationPlugin } from 'workbox-expiration'
import { NavigationRoute, registerRoute } from 'workbox-routing'
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching'
import { CacheFirst } from 'workbox-strategies'

const MAX_RANGE_BYTES = 1024 * 1024
const BROKER_TIMEOUT_MS = 30_000
const PREVIEW_PATH = /^\/__peerlink_preview\/[^/]+$/
const MIME_TYPE_PATTERN = /^[\w!#$&^_.+-]+\/[\w!#$&^_.+-]+(?:\s*;\s*[\w!#$&^_.+-]+=(?:"[^"\r\n]*"|[\w!#$&^_.+-]+))*$/

type PrecacheEntry = string | {
  url: string
  revision?: string | null
  integrity?: string
}

interface PeerLinkServiceWorker extends ServiceWorkerGlobalScope {
  __WB_MANIFEST: PrecacheEntry[]
}

interface BrokerReply {
  size: number
  mimeType: string
  data: ArrayBuffer
}

interface PreviewRangeMessage {
  type: 'peerlink_preview_range'
  fileId: string
  start: number
  end: number
  requestId: string
}

class BrokerFailure extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

const sw = globalThis as unknown as PeerLinkServiceWorker

sw.addEventListener('install', (event) => {
  event.waitUntil(sw.skipWaiting())
})

sw.addEventListener('activate', (event) => {
  event.waitUntil(sw.clients.claim())
})

function isPreviewPath(pathname: string): boolean {
  return PREVIEW_PATH.test(pathname)
}

function decodeFileId(pathname: string): string | undefined {
  const match = PREVIEW_PATH.exec(pathname)
  if (!match) return undefined

  try {
    const fileId = decodeURIComponent(match[0].slice('/__peerlink_preview/'.length))
    if (!fileId || fileId.includes('/') || fileId.includes('\\') || fileId === '.' || fileId === '..') {
      return undefined
    }
    return fileId
  } catch {
    return undefined
  }
}

function parseRange(value: string | null): { start: number; end: number | null } | undefined {
  if (!value) return undefined

  const match = /^bytes=(\d+)-(\d*)$/i.exec(value.trim())
  if (!match) return undefined

  const start = Number(match[1])
  const end = match[2] ? Number(match[2]) : null
  if (!Number.isSafeInteger(start) || (end !== null && !Number.isSafeInteger(end)) || (end !== null && end < start)) {
    return undefined
  }
  return { start, end }
}

function previewHeaders(mimeType?: string): Headers {
  const headers = new Headers({
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, no-store, max-age=0',
    Expires: '0',
    Pragma: 'no-cache',
    'X-Content-Type-Options': 'nosniff'
  })
  if (mimeType) headers.set('Content-Type', mimeType)
  return headers
}

function emptyResponse(status: number, contentRange?: string, mimeType?: string): Response {
  const headers = previewHeaders(mimeType)
  headers.set('Content-Length', '0')
  if (contentRange) headers.set('Content-Range', contentRange)
  return new Response(null, { status, headers })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function validateBrokerReply(value: unknown, start: number, end: number): BrokerReply | undefined {
  if (!isRecord(value)) return undefined

  const { size, mimeType, data } = value
  if (
    typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0 ||
    typeof mimeType !== 'string' || mimeType.length > 255 || !MIME_TYPE_PATTERN.test(mimeType) ||
    !(data instanceof ArrayBuffer)
  ) {
    return undefined
  }

  const expectedLength = start >= size ? 0 : Math.min(end, size - 1) - start + 1
  if (data.byteLength !== expectedLength) return undefined
  return { size, mimeType, data }
}

function requestId(): string {
  return typeof sw.crypto.randomUUID === 'function'
    ? sw.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function askPage(
  client: WindowClient,
  signal: AbortSignal,
  fileId: string,
  start: number,
  end: number
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel()
    const port = channel.port1
    let settled = false

    const finish = (callback: (value: never) => void, value: unknown) => {
      if (settled) return
      settled = true
      sw.clearTimeout(timeout)
      signal.removeEventListener('abort', onAbort)
      port.onmessage = null
      port.onmessageerror = null
      port.close()
      callback(value as never)
    }

    const onAbort = () => finish(reject, new DOMException('Preview request aborted', 'AbortError'))
    const timeout = sw.setTimeout(() => {
      finish(reject, new BrokerFailure(504, 'Preview broker timed out'))
    }, BROKER_TIMEOUT_MS)

    port.onmessage = (event: MessageEvent<unknown>) => finish(resolve, event.data)
    port.onmessageerror = () => finish(reject, new BrokerFailure(502, 'Invalid preview broker message'))
    port.start()

    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })

    const message: PreviewRangeMessage = {
      type: 'peerlink_preview_range',
      fileId,
      start,
      end,
      requestId: requestId()
    }

    try {
      client.postMessage(message, [channel.port2])
    } catch {
      finish(reject, new BrokerFailure(503, 'Preview page is unavailable'))
    }
  })
}

async function handlePreviewRequest(event: FetchEvent, request: Request, url: URL): Promise<Response> {
  const fileId = decodeFileId(url.pathname)
  if (!fileId) return emptyResponse(400)

  const range = parseRange(request.headers.get('Range'))
  const start = range?.start ?? 0
  const requestedEnd = range?.end ?? start + MAX_RANGE_BYTES - 1
  const end = Math.min(
    requestedEnd,
    start + MAX_RANGE_BYTES - 1,
    Number.MAX_SAFE_INTEGER
  )

  if (!event.clientId) return emptyResponse(503)

  try {
    const client = await sw.clients.get(event.clientId)
    if (!client || client.type !== 'window') return emptyResponse(503)

    const reply = await askPage(client as WindowClient, request.signal, fileId, start, end)
    if (isRecord(reply) && Object.hasOwn(reply, 'error')) {
      if (typeof reply.error === 'string' && reply.error.length > 0) return emptyResponse(503)
      return emptyResponse(502)
    }

    const metadata = validateBrokerReply(reply, start, end)
    if (!metadata) return emptyResponse(502)
    if (!range || start >= metadata.size) {
      return emptyResponse(416, `bytes */${metadata.size}`, metadata.mimeType)
    }

    const actualEnd = Math.min(end, metadata.size - 1)
    const contentLength = actualEnd - start + 1
    const headers = previewHeaders(metadata.mimeType)
    headers.set('Content-Length', String(contentLength))
    headers.set('Content-Range', `bytes ${start}-${actualEnd}/${metadata.size}`)

    return new Response(request.method === 'HEAD' ? null : metadata.data, {
      status: 206,
      headers
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    if (error instanceof BrokerFailure) return emptyResponse(error.status)
    return emptyResponse(503)
  }
}

const previewMatch = ({ request, url }: { request: Request; url: URL }) =>
  url.origin === sw.location.origin && isPreviewPath(url.pathname) &&
  (request.method === 'GET' || request.method === 'HEAD')

registerRoute(
  previewMatch,
  ({ event, request, url }) => handlePreviewRequest(event as FetchEvent, request, url),
  'GET'
)
registerRoute(
  previewMatch,
  ({ event, request, url }) => handlePreviewRequest(event as FetchEvent, request, url),
  'HEAD'
)

cleanupOutdatedCaches()
precacheAndRoute((self as unknown as PeerLinkServiceWorker).__WB_MANIFEST)
registerRoute(new NavigationRoute(createHandlerBoundToURL('index.html')))

for (const [host, cacheName] of [
  ['fonts.googleapis.com', 'google-fonts-cache'],
  ['fonts.gstatic.com', 'gstatic-fonts-cache']
] as const) {
  registerRoute(
    ({ url }) => url.origin === `https://${host}`,
    new CacheFirst({
      cacheName,
      plugins: [
        new CacheableResponsePlugin({ statuses: [0, 200] }),
        new ExpirationPlugin({ maxEntries: 10, maxAgeSeconds: 60 * 60 * 24 * 365 })
      ]
    }),
    'GET'
  )
}
