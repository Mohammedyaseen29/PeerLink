/// <reference lib="webworker" />

import { CacheableResponsePlugin } from 'workbox-cacheable-response'
import { ExpirationPlugin } from 'workbox-expiration'
import { NavigationRoute, registerRoute } from 'workbox-routing'
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching'
import { CacheFirst } from 'workbox-strategies'
import { getMetaData, readFileRange, type FileMetadata } from './ProgressDB'
import { checkPreviewSize, MAX_TEXT_PREVIEW_BYTES, safePreviewMime } from './previewPolicy'

const MAX_RANGE_BYTES = 1024 * 1024
const BROKER_TIMEOUT_MS = 30_000
const DOWNLOAD_PATH = /^\/__peerlink_download\/([A-Za-z0-9_-]{16,128})$/
const DOWNLOAD_TOKEN_TTL_MS = 5 * 60_000
const MAX_DOWNLOAD_TOKENS = 32
const PREVIEW_PATH = /^\/__peerlink_preview\/[^/]+$/
const LOCAL_PREVIEW_PATH = /^\/__peerlink_local_preview\/([^/]+)$/
const MIME_TYPE_PATTERN = /^[\w!#$&^_.+-]+\/[\w!#$&^_.+-]+(?:\s*;\s*[\w!#$&^_.+-]+=(?:"[^"\r\n]*"|[\w!#$&^_.+-]+))*$/

type PrecacheEntry = string | {
  url: string
  revision?: string | null
  integrity?: string
}

interface PeerLinkServiceWorker extends ServiceWorkerGlobalScope {
  __WB_MANIFEST: PrecacheEntry[]
}

declare const self: PeerLinkServiceWorker

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

interface DownloadRegistration {
  token: string
  fileId: string
  name: string
  size: number
}

interface DownloadToken extends DownloadRegistration {
  ownerClientId: string
  expiresAt: number
}

class BrokerFailure extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

const sw = globalThis as unknown as PeerLinkServiceWorker
const downloadTokens = new Map<string, DownloadToken>()

sw.addEventListener('message', (event) => {
  if (event.data && typeof event.data === 'object' && event.data.type === 'PEERLINK_CLAIM_CLIENT') {
    const replyPort = event.ports[0]
    if (!replyPort) return

    const reply = (message: { type: string; error?: string }) => {
      try { replyPort.postMessage(message) } catch { /* The requesting page may have closed the channel. */ }
      try { replyPort.close() } catch { /* The channel may already be closed. */ }
    }
    const claim = sw.clients.claim().then(
      () => reply({ type: 'PEERLINK_CLAIM_CLIENT_ACK' }),
      (error: unknown) => reply({
        type: 'PEERLINK_CLAIM_CLIENT_ERROR',
        error: error instanceof Error ? error.message : String(error)
      })
    )
    event.waitUntil(claim)
  } else if (event.data && typeof event.data === 'object' && event.data.type === 'SKIP_WAITING') {
    event.waitUntil(sw.skipWaiting())
  } else if (event.data && typeof event.data === 'object' && event.data.type === 'PEERLINK_REGISTER_DOWNLOAD') {
    const port = event.ports[0]
    if (!port) return
    const source = event.source as Client | null
    const registration = event.data as DownloadRegistration & { type: string }
    const reply = (type: string, error?: string) => {
      try { port.postMessage({ type, error }) } catch { /* The page may have closed the channel. */ }
      try { port.close() } catch { /* The channel may already be closed. */ }
    }
    const operation = registerDownload(source, registration).then(
      () => reply('PEERLINK_DOWNLOAD_REGISTERED'),
      (error: unknown) => reply('PEERLINK_DOWNLOAD_REGISTER_ERROR', error instanceof Error ? error.message : String(error))
    )
    event.waitUntil(operation)
  } else if (event.data && typeof event.data === 'object' && event.data.type === 'PEERLINK_DOWNLOAD_CAPABILITY') {
    const port = event.ports[0]
    if (!port) return
    try { port.postMessage({ type: 'PEERLINK_DOWNLOAD_CAPABILITY_ACK', version: 2 }) }
    finally { port.close() }
  }
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
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "sandbox; default-src 'none'; media-src 'self' blob:; img-src 'self' blob:; style-src 'unsafe-inline'"
  })
  if (mimeType) headers.set('Content-Type', safePreviewMime(mimeType))
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

function pruneDownloadTokens(): void {
  const now = Date.now()
  for (const [token, value] of downloadTokens) if (value.expiresAt <= now) downloadTokens.delete(token)
}

function validDownloadMetadata(metadata: FileMetadata | null, size: number): metadata is FileMetadata {
  if (!metadata || metadata.status !== 'complete' || !Number.isSafeInteger(metadata.size) || metadata.size !== size ||
      !Number.isSafeInteger(metadata.totalChunks) || metadata.totalChunks < 0 || metadata.receivedChunks !== metadata.totalChunks) return false
  if (metadata.chunkSize !== undefined && (!Number.isSafeInteger(metadata.chunkSize) || metadata.chunkSize < 1 ||
      metadata.chunkSize > MAX_RANGE_BYTES || metadata.totalChunks !== Math.ceil(metadata.size / metadata.chunkSize))) return false
  if (metadata.size === 0) return metadata.totalChunks === 0
  if (metadata.totalChunks < 1) return false
  return true
}

function safeAttachmentName(name: string): string {
  const safe = name.replace(/[\u0000-\u001f\u007f/\\]/g, '_').slice(0, 255).trim()
  return safe && safe !== '.' && safe !== '..' ? safe : 'download'
}

function attachmentHeaders(name: string, size: number): Headers {
  const safeName = safeAttachmentName(name)
  const fallbackName = safeName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  const encodedName = encodeURIComponent(safeName).replace(/['()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
  return new Headers({
    'Cache-Control': 'private, no-store, max-age=0',
    'Content-Disposition': `attachment; filename="${fallbackName}"; filename*=UTF-8''${encodedName}`,
    'Content-Length': String(size),
    'Content-Type': 'application/octet-stream',
    Expires: '0',
    Pragma: 'no-cache',
    'X-Content-Type-Options': 'nosniff'
  })
}

async function notifyDownloadOwner(value: DownloadToken, type: string, message?: string, bytes?: number): Promise<void> {
  try {
    const owner = await sw.clients.get(value.ownerClientId)
    if (owner?.type === 'window') owner.postMessage({ type, token: value.token, message, bytes })
  } catch { /* The initiating page may have closed. */ }
}

async function notifyDownloadClient(clientId: string | undefined, token: string, type: string, message?: string): Promise<void> {
  if (!clientId) return
  try {
    const client = await sw.clients.get(clientId)
    if (client?.type === 'window' && new URL(client.url).origin === sw.location.origin) {
      client.postMessage({ type, token, message })
    }
  } catch { /* The requesting page may have closed. */ }
}

async function registerDownload(source: Client | null, value: DownloadRegistration): Promise<void> {
  if (!source || source.type !== 'window' || !/^[A-Za-z0-9_-]{16,128}$/.test(value.token) ||
      typeof value.fileId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value.fileId) ||
      typeof value.name !== 'string' || value.name.length < 1 || value.name.length > 255 ||
      !Number.isSafeInteger(value.size) || value.size < 0) {
    throw new Error('The download request is invalid or no longer available.')
  }
  const sourceUrl = new URL(source.url)
  if (sourceUrl.origin !== sw.location.origin) throw new Error('Large downloads are available only from this PeerLink page.')

  pruneDownloadTokens()
  if (downloadTokens.has(value.token)) throw new Error('This download link has already been used.')
  if (downloadTokens.size >= MAX_DOWNLOAD_TOKENS) throw new Error('Too many large downloads are already open. Finish one and retry.')

  const metadata = await getMetaData(value.fileId)
  if (!validDownloadMetadata(metadata, value.size)) throw new Error(`"${safeAttachmentName(value.name)}" is incomplete or has invalid file metadata.`)

  downloadTokens.set(value.token, {
    ...value,
    name: safeAttachmentName(value.name),
    ownerClientId: source.id,
    expiresAt: Date.now() + DOWNLOAD_TOKEN_TTL_MS
  })
}

function textDownloadError(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: new Headers({
      'Cache-Control': 'private, no-store, max-age=0',
      'Content-Type': 'text/plain; charset=utf-8',
      'X-Content-Type-Options': 'nosniff'
    })
  })
}

async function handleDownloadRequest(event: FetchEvent, request: Request, url: URL): Promise<Response> {
  const match = DOWNLOAD_PATH.exec(url.pathname)
  if (!match || url.origin !== sw.location.origin) return textDownloadError(404, 'This download link is invalid.')

  let finishLifetime!: () => void
  const streamLifetime = new Promise<void>(resolve => { finishLifetime = resolve })
  event.waitUntil(streamLifetime)
  const fail = async (status: number, message: string, ownerToken?: DownloadToken): Promise<Response> => {
    finishLifetime()
    const token = ownerToken ?? downloadTokens.get(match[1])
    if (token) await notifyDownloadOwner(token, 'PEERLINK_DOWNLOAD_ERROR', message)
    else await notifyDownloadClient(event.clientId || undefined, match[1], 'PEERLINK_DOWNLOAD_ERROR', message)
    return textDownloadError(status, message)
  }

  pruneDownloadTokens()
  const token = downloadTokens.get(match[1])
  downloadTokens.delete(match[1])
  if (!token || token.expiresAt <= Date.now()) return fail(410, 'This large-file download link expired. Start the download again.', token)
  if (request.method !== 'GET') return fail(405, 'This download link only accepts a file download request.', token)
  if (request.headers.has('Range')) return fail(416, 'This one-use download link cannot resume a partial download. Start it again from PeerLink.', token)

  try {
    const owner = await sw.clients.get(token.ownerClientId)
    if (!owner || owner.type !== 'window' || new URL(owner.url).origin !== sw.location.origin) {
      return fail(410, 'The PeerLink page that started this download is no longer available. Start it again.', token)
    }
    if (event.clientId) {
      const requester = await sw.clients.get(event.clientId)
      if (requester && requester.type === 'window' && new URL(requester.url).origin !== sw.location.origin) {
        return fail(403, 'This download link can only be opened from PeerLink.', token)
      }
    }

    const metadata = await getMetaData(token.fileId)
    if (!validDownloadMetadata(metadata, token.size)) {
      return fail(409, `"${safeAttachmentName(token.name)}" is incomplete or has invalid file metadata.`, token)
    }

    let firstRange: ArrayBuffer | null = null
    if (metadata.size > 0) {
      const firstRangeEnd = Math.min(metadata.size, MAX_RANGE_BYTES) - 1
      firstRange = await readFileRange(token.fileId, metadata, 0, firstRangeEnd)
      if (firstRange.byteLength !== firstRangeEnd + 1) throw new Error('The first file range is incomplete.')
    }

    let offset = 0
    let lastProgressAt = 0
    let finished = false
    const finish = (type: string, message?: string) => {
      if (finished) return
      finished = true
      finishLifetime()
      void notifyDownloadOwner(token, type, message)
    }
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (offset >= metadata.size) {
          controller.close()
          finish('PEERLINK_DOWNLOAD_FINISHED')
          return
        }
        try {
          const end = Math.min(offset + MAX_RANGE_BYTES, metadata.size) - 1
          const expected = end - offset + 1
          const data = firstRange ?? await readFileRange(token.fileId, metadata, offset, end)
          firstRange = null
          if (data.byteLength !== expected) throw new Error(`File range at byte ${offset} is incomplete.`)
          offset += data.byteLength
          controller.enqueue(new Uint8Array(data))
          if (Date.now() - lastProgressAt >= 5_000) {
            lastProgressAt = Date.now()
            void notifyDownloadOwner(token, 'PEERLINK_DOWNLOAD_PROGRESS', undefined, offset)
          }
          if (offset >= metadata.size) {
            controller.close()
            finish('PEERLINK_DOWNLOAD_FINISHED')
          }
        } catch (error) {
          const message = `Unable to stream "${safeAttachmentName(token.name)}": ${error instanceof Error ? error.message : String(error)}`
          controller.error(error)
          finish('PEERLINK_DOWNLOAD_ERROR', message)
        }
      },
      cancel() { finish('PEERLINK_DOWNLOAD_CANCELLED', 'The browser cancelled this download.') }
    })
    await notifyDownloadOwner(token, 'PEERLINK_DOWNLOAD_READY')
    return new Response(body, { status: 200, headers: attachmentHeaders(token.name, metadata.size) })
  } catch (error) {
    const message = `Unable to start "${safeAttachmentName(token.name)}": ${error instanceof Error ? error.message : String(error)}`
    return fail(409, message, token)
  }
}

const downloadMatch = ({ request, url }: { request: Request; url: URL }) =>
  url.origin === sw.location.origin && DOWNLOAD_PATH.test(url.pathname) && request.method === 'GET'

registerRoute(downloadMatch, ({ event, request, url }) => handleDownloadRequest(event as FetchEvent, request, url), 'GET')

/** Completed local files are independent of the room and any page/peer broker. */
async function handleLocalPreviewRequest(event: FetchEvent, request: Request, url: URL): Promise<Response> {
  if (url.origin !== sw.location.origin) return emptyResponse(403)
  const match = LOCAL_PREVIEW_PATH.exec(url.pathname)
  if (!match || !['GET', 'HEAD'].includes(request.method)) return emptyResponse(405)
  let fileId: string
  try { fileId = decodeURIComponent(match[1]) } catch { return emptyResponse(400) }
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(fileId)) return emptyResponse(400)
  const metadata = await getMetaData(fileId)
  if (!metadata || !validDownloadMetadata(metadata, metadata.size)) return emptyResponse(404)
  try { checkPreviewSize(metadata) } catch { return emptyResponse(413) }
  const size = metadata.mimeType.startsWith('text/') ? Math.min(metadata.size, MAX_TEXT_PREVIEW_BYTES) : metadata.size
  let start = 0
  let end = size - 1
  const rawRange = request.headers.get('Range')
  if (rawRange !== null) {
    const range = /^bytes=(\d*)-(\d*)$/i.exec(rawRange.trim())
    if (!range || (!range[1] && !range[2])) return emptyResponse(416, `bytes */${size}`, metadata.mimeType)
    if (!range[1]) {
      const suffix = Number(range[2])
      if (!Number.isSafeInteger(suffix) || suffix < 1) return emptyResponse(416, `bytes */${size}`, metadata.mimeType)
      start = Math.max(0, size - suffix)
    } else {
      start = Number(range[1])
      end = range[2] ? Number(range[2]) : size - 1
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) return emptyResponse(416, `bytes */${size}`, metadata.mimeType)
      end = Math.min(end, size - 1)
    }
    if (start >= size || size === 0) return emptyResponse(416, `bytes */${size}`, metadata.mimeType)
  }
  const headers = previewHeaders(metadata.mimeType)
  headers.set('Content-Length', String(Math.max(0, end - start + 1)))
  if (rawRange !== null) headers.set('Content-Range', `bytes ${start}-${end}/${size}`)
  const status = rawRange !== null ? 206 : 200
  if (request.method === 'HEAD' || size === 0) return new Response(null, { status, headers })
  let finishLifetime!: () => void
  event.waitUntil(new Promise<void>(resolve => { finishLifetime = resolve }))
  let finished = false
  let cancelled = false
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined
  const finish = () => {
    if (finished) return
    finished = true
    request.signal.removeEventListener('abort', abort)
    finishLifetime()
  }
  const abort = () => {
    if (finished) return
    cancelled = true
    streamController?.error(new DOMException('Preview canceled', 'AbortError'))
    finish()
  }
  request.signal.addEventListener('abort', abort, { once: true })
  let offset = start
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller
      if (request.signal.aborted) abort()
    },
    async pull(controller) {
      try {
        if (cancelled) throw new DOMException('Preview canceled', 'AbortError')
        const nextEnd = Math.min(offset + MAX_RANGE_BYTES - 1, end)
        const data = await readFileRange(fileId, metadata, offset, nextEnd)
        if (cancelled) return
        if (data.byteLength !== nextEnd - offset + 1) throw new Error('Local preview range is incomplete.')
        offset += data.byteLength
        controller.enqueue(new Uint8Array(data))
        if (offset > end) { controller.close(); finish() }
      } catch (error) { if (!cancelled) controller.error(error); finish() }
    },
    cancel() { cancelled = true; finish() }
  })
  return new Response(body, { status, headers })
}

for (const method of ['GET', 'HEAD'] as const) {
  registerRoute(({ url }: { url: URL }) => url.origin === sw.location.origin && LOCAL_PREVIEW_PATH.test(url.pathname),
    ({ event, request, url }) => handleLocalPreviewRequest(event as FetchEvent, request, url), method)
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
    checkPreviewSize(metadata)
    if (metadata.mimeType.startsWith('text/')) {
      const size = Math.min(metadata.size, MAX_TEXT_PREVIEW_BYTES)
      if (request.headers.has('Range') && (!range || start >= size)) return emptyResponse(416, `bytes */${size}`, metadata.mimeType)
      const actualEnd = Math.min(end, size - 1)
      const headers = previewHeaders(metadata.mimeType)
      const data = metadata.data.slice(0, Math.max(0, actualEnd - start + 1))
      headers.set('Content-Length', String(data.byteLength))
      if (range) headers.set('Content-Range', `bytes ${start}-${actualEnd}/${size}`)
      return new Response(request.method === 'HEAD' ? null : data, { status: range ? 206 : 200, headers })
    }
    if (!request.headers.has('Range')) {
      const headers = previewHeaders(metadata.mimeType)
      headers.set('Content-Length', String(metadata.size))
      if (request.method === 'HEAD' || metadata.size === 0) return new Response(null, { status: 200, headers })

      // Images and documents normally request the whole resource, not a Range.
      // Stream bounded peer ranges instead of rejecting them or buffering the entire file.
      const controller = new AbortController()
      const onAbort = () => controller.abort()
      request.signal.addEventListener('abort', onAbort, { once: true })
      let finishLifetime!: () => void
      event.waitUntil(new Promise<void>(resolve => { finishLifetime = resolve }))
      let offset = 0
      let first: ArrayBuffer | null = metadata.data
      const finish = () => {
        request.signal.removeEventListener('abort', onAbort)
        finishLifetime()
      }
      const body = new ReadableStream<Uint8Array>({
        async pull(stream) {
          try {
            if (request.signal.aborted || controller.signal.aborted) throw new DOMException('Preview canceled', 'AbortError')
            const rangeEnd = Math.min(offset + MAX_RANGE_BYTES, metadata.size) - 1
            const reply = first ? null : await askPage(client as WindowClient, controller.signal, fileId, offset, rangeEnd)
            const next = first ? metadata : validateBrokerReply(reply, offset, rangeEnd)
            if (!next || next.size !== metadata.size || next.mimeType !== metadata.mimeType) throw new Error('The peer preview changed or became unavailable.')
            first = null
            stream.enqueue(new Uint8Array(next.data))
            offset += next.data.byteLength
            if (offset >= metadata.size) { stream.close(); finish() }
          } catch (error) {
            controller.abort()
            stream.error(error)
            finish()
          }
        },
        cancel() { controller.abort(); finish() }
      })
      return new Response(body, { status: 200, headers })
    }
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
precacheAndRoute(self.__WB_MANIFEST)
registerRoute(new NavigationRoute(
  createHandlerBoundToURL('index.html'),
  import.meta.env.DEV ? { allowlist: [/^\/$/, /^\/index\.html$/] } : undefined
))

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
