/* eslint-disable eslint-plugin-n/no-unsupported-features/node-builtins */
/**
 * CCR upstreamproxy 使用的 CONNECT-over-WebSocket relay。
 *
 * 监听 localhost TCP，接收 curl/gh/kubectl 等客户端的 HTTP CONNECT，并通过
 * WebSocket 将字节 tunnel 到 CCR upstreamproxy endpoint。CCR 服务端终止 tunnel、
 * 对 TLS 执行 MITM、注入组织配置的凭据（如 DD-API-KEY），再转发到真实 upstream。
 *
 * 使用 WebSocket 而非原始 CONNECT 的原因：CCR ingress 是按路径前缀路由的 GKE L7，
 * cdk-constructs 没有 connect_matcher。session-ingress tunnel
 *（sessions/tunnel/v1alpha/tunnel.proto）已经采用此模式。
 *
 * 协议：字节封装为 UpstreamProxyChunk protobuf 消息
 *（`message UpstreamProxyChunk { bytes data = 1; }`），以兼容服务端的
 * gateway.NewWebSocketStreamAdapter。
 */

import { createServer, type Socket as NodeSocket } from 'node:net'
import { logForDebugging } from '../services/infra/debug.js'
import { getWebSocketTLSOptions } from '../services/http/mtls.js'
import { getWebSocketProxyAgent, getWebSocketProxyUrl } from '../services/http/proxy.js'

// CCR 容器位于 egress gateway 后方，无法直接出站，因此 WebSocket upgrade 必须经过
// 其他请求共用的 HTTP CONNECT proxy。undici 的 globalThis.WebSocket 在 upgrade 时
// 不读取全局 dispatcher，所以 Node 下使用 ws 包并显式传入 agent，与 SessionsWebSocket
// 相同。Bun 原生 WebSocket 可直接接受 proxy URL。在 startNodeRelay 中预加载，
// 使 openTunnel 保持同步，避免 CONNECT 状态机竞争。
type WSCtor = typeof import('ws').default
let nodeWSCtor: WSCtor | undefined

// openTunnel 所需接口的交集。undici 的 globalThis.WebSocket 与 ws 包都通过属性式
// onX handler 满足此接口。
type WebSocketLike = Pick<
  WebSocket,
  'onopen' | 'onmessage' | 'onerror' | 'onclose' | 'send' | 'close' | 'readyState' | 'binaryType'
>

// Envoy 单请求 buffer 上限。第一周的 Datadog payload 不会达到该值，但需预先支持，
// 避免为 git push 重写 relay。
const MAX_CHUNK_BYTES = 512 * 1024

// Sidecar 空闲超时为 50 秒，因此要在此之前发送 ping。
const PING_INTERVAL_MS = 30_000

/**
 * 手工编码 UpstreamProxyChunk protobuf 消息。
 *
 * 对 `message UpstreamProxyChunk { bytes data = 1; }`，wire 格式为：
 *   tag = (field_number << 3) | wire_type = (1 << 3) | 2 = 0x0a
 *   随后依次为 varint 长度与实际字节。
 *
 * 通用方案是 protobufjs，但单字段 bytes 消息的手工编码仅需约 10 行，
 * 还能避免在热点路径引入运行时依赖。
 */
export function encodeChunk(data: Uint8Array): Uint8Array {
  const len = data.length
  // 对长度做 varint 编码；大多数 chunk 的长度只需 1～3 字节。
  const varint: number[] = []
  let n = len
  while (n > 0x7f) {
    varint.push((n & 0x7f) | 0x80)
    n >>>= 7
  }
  varint.push(n)
  const out = new Uint8Array(1 + varint.length + len)
  out[0] = 0x0a
  out.set(varint, 1)
  out.set(data, 1 + varint.length)
  return out
}

/**
 * 解码 UpstreamProxyChunk。返回 data 字段，格式错误时返回 null。
 * 允许服务端发送表示 keepalive 的零长度 chunk。
 */
export function decodeChunk(buf: Uint8Array): Uint8Array | null {
  if (buf.length === 0) {
    return new Uint8Array(0)
  }
  if (buf[0] !== 0x0a) {
    return null
  }
  let len = 0
  let shift = 0
  let i = 1
  while (i < buf.length) {
    const b = buf[i]!
    len |= (b & 0x7f) << shift
    i++
    if ((b & 0x80) === 0) {
      break
    }
    shift += 7
    if (shift > 28) {
      return null
    }
  }
  if (i + len > buf.length) {
    return null
  }
  return buf.subarray(i, i + len)
}

export type UpstreamProxyRelay = {
  port: number
  stop: () => void
}

type ConnState = {
  ws?: WebSocketLike
  connectBuf: Buffer
  pinger?: ReturnType<typeof setInterval>
  // CONNECT header 之后、ws.onopen 触发前收到的字节。TCP 可能把 CONNECT 与
  // ClientHello 合并成一个 packet，WebSocket handshake 尚未完成时 socket data
  // 回调也可能再次触发；若无此 buffer，两种情况都会静默丢失字节。
  pending: Buffer[]
  wsOpen: boolean
  // 服务端的 200 Connection Established 已转发、tunnel 开始承载 TLS 后设置。
  // 此后写入明文 502 会破坏客户端 TLS 流，因此只能关闭连接。
  established: boolean
  // WebSocket onerror 后总会触发 onclose；若不加守卫，第二个 handler 会对已结束的
  // socket 再调用 sock.end()。因此只允许首个调用方处理。
  closed: boolean
}

/**
 * 最小 socket 抽象，使 CONNECT parser 与 WebSocket tunnel 装配不依赖运行时。
 * 各实现自行处理写入背压：Bun 的 sock.write() 可能只写一部分，需要显式把尾部排队；
 * Node 的 net.Socket 始终使用 buffer，不会丢失字节。
 */
type ClientSocket = {
  write: (data: Uint8Array | string) => void
  end: () => void
}

function newConnState(): ConnState {
  return {
    connectBuf: Buffer.alloc(0),
    pending: [],
    wsOpen: false,
    established: false,
    closed: false,
  }
}

/**
 * 启动 relay，返回绑定的临时端口和 stop 函数。
 * 有 Bun 时使用 Bun.listen，否则使用 Node 的 net.createServer；CCR 容器在 Node 而非
 * Bun 下运行 CLI。
 */
export async function startUpstreamProxyRelay(opts: {
  wsUrl: string
  sessionId: string
  token: string
}): Promise<UpstreamProxyRelay> {
  const authHeader = `Basic ${Buffer.from(`${opts.sessionId}:${opts.token}`).toString('base64')}`
  // WS upgrade 本身受鉴权保护（proto authn: PRIVATE_API）：gateway 要求 upgrade
  // 请求携带 session-ingress JWT；它与隧道 CONNECT 内的 Proxy-Authorization 分开。
  const wsAuthHeader = `Bearer ${opts.token}`

  const relay =
    typeof Bun !== 'undefined'
      ? startBunRelay(opts.wsUrl, authHeader, wsAuthHeader)
      : await startNodeRelay(opts.wsUrl, authHeader, wsAuthHeader)

  logForDebugging(`[upstreamproxy] relay listening on 127.0.0.1:${relay.port}`)
  return relay
}

function startBunRelay(
  wsUrl: string,
  authHeader: string,
  wsAuthHeader: string,
): UpstreamProxyRelay {
  // Bun TCP socket 不会自动缓冲部分写入：sock.write() 返回实际交给内核的字节数，
  // 其余内容会被静默丢弃。内核缓冲区填满时，将尾部加入队列并交给 drain handler
  // 刷出。该状态按 socket 保存，因为 adapter 闭包的生命周期长于单次 handler 调用。
  type BunState = ConnState & { writeBuf: Uint8Array[] }

  // eslint-disable-next-line custom-rules/require-bun-typeof-guard -- caller dispatches on typeof Bun
  const server = Bun.listen<BunState>({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      open(sock) {
        sock.data = { ...newConnState(), writeBuf: [] }
      },
      data(sock, data) {
        const st = sock.data
        const adapter: ClientSocket = {
          write: (payload) => {
            const bytes = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload
            if (st.writeBuf.length > 0) {
              st.writeBuf.push(bytes)
              return
            }
            const n = sock.write(bytes)
            if (n < bytes.length) {
              st.writeBuf.push(bytes.subarray(n))
            }
          },
          end: () => sock.end(),
        }
        handleData(adapter, st, data, wsUrl, authHeader, wsAuthHeader)
      },
      drain(sock) {
        const st = sock.data
        while (st.writeBuf.length > 0) {
          const chunk = st.writeBuf[0]!
          const n = sock.write(chunk)
          if (n < chunk.length) {
            st.writeBuf[0] = chunk.subarray(n)
            return
          }
          st.writeBuf.shift()
        }
      },
      close(sock) {
        cleanupConn(sock.data)
      },
      error(sock, err) {
        logForDebugging(`[upstreamproxy] client socket error: ${err.message}`)
        cleanupConn(sock.data)
      },
    },
  })

  return {
    port: server.port,
    stop: () => server.stop(true),
  }
}

// 导出此函数以便测试直接覆盖 Node 路径；测试运行器是 Bun，
// 因此 startUpstreamProxyRelay 的运行时分派总会选择 Bun。
export async function startNodeRelay(
  wsUrl: string,
  authHeader: string,
  wsAuthHeader: string,
): Promise<UpstreamProxyRelay> {
  nodeWSCtor = (await import('ws')).default
  const states = new WeakMap<NodeSocket, ConnState>()

  const server = createServer((sock) => {
    const st = newConnState()
    states.set(sock, st)
    // Node 的 sock.write() 会在内部缓冲；返回 false 表示出现背压，但字节已入队，
    // 因此无需跟踪尾部也能保证正确性。初期 payload 不会对缓冲区造成压力。
    const adapter: ClientSocket = {
      write: (payload) => {
        sock.write(typeof payload === 'string' ? payload : Buffer.from(payload))
      },
      end: () => sock.end(),
    }
    sock.on('data', (data) => handleData(adapter, st, data, wsUrl, authHeader, wsAuthHeader))
    sock.on('close', () => cleanupConn(states.get(sock)))
    sock.on('error', (err) => {
      logForDebugging(`[upstreamproxy] client socket error: ${err.message}`)
      cleanupConn(states.get(sock))
    })
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (addr === null || typeof addr === 'string') {
        reject(new Error('upstreamproxy: server has no TCP address'))
        return
      }
      resolve({
        port: addr.port,
        stop: () => server.close(),
      })
    })
  })
}

/**
 * 每条连接共用的数据 handler。阶段 1 累积 CONNECT 请求；
 * 阶段 2 通过 WS 隧道转发客户端字节。
 */
function handleData(
  sock: ClientSocket,
  st: ConnState,
  data: Buffer,
  wsUrl: string,
  authHeader: string,
  wsAuthHeader: string,
): void {
  // 阶段 1：持续累积，直至收到以 CRLF CRLF 结尾的完整 CONNECT 请求。
  // curl/gh 通常会在一个数据包中发送，但不能依赖这一行为。
  if (!st.ws) {
    st.connectBuf = Buffer.concat([st.connectBuf, data])
    const headerEnd = st.connectBuf.indexOf('\r\n\r\n')
    if (headerEnd === -1) {
      // 防止客户端始终不发送 CRLFCRLF。
      if (st.connectBuf.length > 8192) {
        sock.write('HTTP/1.1 400 Bad Request\r\n\r\n')
        sock.end()
      }
      return
    }
    const reqHead = st.connectBuf.subarray(0, headerEnd).toString('utf8')
    const firstLine = reqHead.split('\r\n')[0] ?? ''
    const m = firstLine.match(/^CONNECT\s+(\S+)\s+HTTP\/1\.[01]$/i)
    if (!m) {
      sock.write('HTTP/1.1 405 Method Not Allowed\r\n\r\n')
      sock.end()
      return
    }
    // 暂存 CONNECT header 之后到达的字节，待 WS 打开后由 openTunnel 刷出。
    const trailing = st.connectBuf.subarray(headerEnd + 4)
    if (trailing.length > 0) {
      st.pending.push(Buffer.from(trailing))
    }
    st.connectBuf = Buffer.alloc(0)
    openTunnel(sock, st, firstLine, wsUrl, authHeader, wsAuthHeader)
    return
  }
  // 阶段 2：WS 已创建。尚未 OPEN 时先缓冲并由 ws.onopen 刷出；
  // 打开后将客户端字节分块发送到 WS。
  if (!st.wsOpen) {
    st.pending.push(Buffer.from(data))
    return
  }
  forwardToWs(st.ws, data)
}

function openTunnel(
  sock: ClientSocket,
  st: ConnState,
  connectLine: string,
  wsUrl: string,
  authHeader: string,
  wsAuthHeader: string,
): void {
  // core/websocket/stream.go 根据 upgrade 请求的 Content-Type 选择 JSON 或
  // binary-proto（默认 JSON）。若缺少 application/proto，服务器会用
  // protojson.Unmarshal 解析手工编码的二进制 chunk，并以 EOF 静默失败。
  const headers = {
    'Content-Type': 'application/proto',
    Authorization: wsAuthHeader,
  }
  let ws: WebSocketLike
  if (nodeWSCtor) {
    ws = new nodeWSCtor(wsUrl, {
      headers,
      agent: getWebSocketProxyAgent(wsUrl),
      ...getWebSocketTLSOptions(),
    }) as unknown as WebSocketLike
  } else {
    ws = new globalThis.WebSocket(wsUrl, {
      // @ts-expect-error — Bun extension; not in lib.dom WebSocket types
      headers,
      proxy: getWebSocketProxyUrl(wsUrl),
      tls: getWebSocketTLSOptions() || undefined,
    })
  }
  ws.binaryType = 'arraybuffer'
  st.ws = ws

  ws.onopen = () => {
    // 首个 chunk 携带 CONNECT 行和 Proxy-Authorization，供服务器鉴权并确定
    // 目标 host:port。服务器会通过隧道返回自己的 “HTTP/1.1 200”，这里只做转发。
    const head = `${connectLine}\r\nProxy-Authorization: ${authHeader}\r\n\r\n`
    ws.send(encodeChunk(Buffer.from(head, 'utf8')))
    // 刷出 WS 握手期间到达的所有内容，包括 CONNECT 数据包的尾部字节，
    // 以及 onopen 前触发的 data() callback 所收到的数据。
    st.wsOpen = true
    for (const buf of st.pending) {
      forwardToWs(ws, buf)
    }
    st.pending = []
    // 并非所有 WS 实现都提供 ping()；空 chunk 可作为服务器能够忽略的应用层保活包。
    st.pinger = setInterval(sendKeepalive, PING_INTERVAL_MS, ws)
  }

  ws.onmessage = (ev) => {
    const raw =
      ev.data instanceof ArrayBuffer
        ? new Uint8Array(ev.data)
        : new Uint8Array(Buffer.from(ev.data))
    const payload = decodeChunk(raw)
    if (payload && payload.length > 0) {
      st.established = true
      sock.write(payload)
    }
  }

  ws.onerror = (ev) => {
    const msg = 'message' in ev ? String(ev.message) : 'websocket error'
    logForDebugging(`[upstreamproxy] ws error: ${msg}`)
    if (st.closed) {
      return
    }
    st.closed = true
    if (!st.established) {
      sock.write('HTTP/1.1 502 Bad Gateway\r\n\r\n')
    }
    sock.end()
    cleanupConn(st)
  }

  ws.onclose = () => {
    if (st.closed) {
      return
    }
    st.closed = true
    sock.end()
    cleanupConn(st)
  }
}

function sendKeepalive(ws: WebSocketLike): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(encodeChunk(new Uint8Array(0)))
  }
}

function forwardToWs(ws: WebSocketLike, data: Buffer): void {
  if (ws.readyState !== WebSocket.OPEN) {
    return
  }
  for (let off = 0; off < data.length; off += MAX_CHUNK_BYTES) {
    const slice = data.subarray(off, off + MAX_CHUNK_BYTES)
    ws.send(encodeChunk(slice))
  }
}

function cleanupConn(st: ConnState | undefined): void {
  if (!st) {
    return
  }
  if (st.pinger) {
    clearInterval(st.pinger)
  }
  if (st.ws && st.ws.readyState <= WebSocket.OPEN) {
    try {
      st.ws.close()
    } catch {
      // already closing
    }
  }
  st.ws = undefined
}
