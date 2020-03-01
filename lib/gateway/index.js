// @flow

/* flow-include
export type KsGatewayConfig = {}
*/

const net = require('net')
const https = require('https')
const fs = require('fs')
const socketIO = require('socket.io')
const socketIoRedis = require('socket.io-redis')
const socketIoStream = require('socket.io-stream')
const sni = require('sni')
const httpHeaders = require('http-headers')
const validator = require('validator')

const {
  TLS_KEY_PATH,
  TLS_CERT_PATH,
  TLS_CHAIN_PATH,
  GATEWAY_AGENT_LISTEN_PORT,
  GATEWAY_HTTP_LISTEN_PORT,
  GATEWAY_HTTPS_LISTEN_PORT,
  NO_SOCKETS_CONNECTED,
  SOCKET_CONNECTED_ELSEWHERE,
  SOCKET_CONNECTED_HERE,
  SHUTDOWN_GRACE,
  INTERNAL_HTTPS_RESPONDER_PORT,
  ALWAYS_VALID_DOMAINS
} = require('../shared/config')
const logger = require('../shared/logger')
const { initProm } = require('../shared/prom')
const { writeHeader } = require('../shared')
const agentAuthHandler = require('./agentAuthHandler')
const redis = require('./redis')

let ca
if (TLS_CHAIN_PATH && fs.existsSync(TLS_CHAIN_PATH)) ca = TLS_CHAIN_PATH // eslint-disable-line
if (!fs.existsSync(TLS_KEY_PATH) || !fs.existsSync(TLS_CERT_PATH)) {
  throw new Error('Gateway is missing TLS_KEY_PATH or TLS_CERT_PATH!')
}
if (process.env.NODE_ENV !== 'development' && ALWAYS_VALID_DOMAINS.length > 0) {
  throw new Error('ALWAYS_VALID_DOMAINS is set and NODE_ENV is not development!')
}

class KsGateway {
  // Indicates gateway is ready to take traffic
  // will fail healthchecks when falsey (used mainly to prevent recieving traffic before we're ready)
  gatewayReady = false

  // Maps hostnames to socket IDs which are connected locally, to this instance
  localSocketMapping = {}
  // Maps socket IDs to hostnames
  localSocketReverseMapping = {}

  httpProxyServer = net.createServer(async socket => {
    // Wait for first HELO
    socket.once('data', async data => {
      const parseHeaders = httpHeaders(data)
      if (parseHeaders && parseHeaders.headers && parseHeaders.headers.host)
        this.handleStream('http', parseHeaders.headers.host, socket, data)
    })
  })

  httpsProxyServer = net.createServer(socket => {
    socket.once('data', async data => {
      const host = sni(data)
      this.handleStream('https', host, socket, data)
    })
  })

  // Used when we don't have a valid backend target for an HTTPS request
  gatewayHttpsReplyer = https.createServer(
    {
      key: fs.readFileSync(TLS_KEY_PATH), // eslint-disable-line
      cert: fs.readFileSync(TLS_CERT_PATH), // eslint-disable-line
      ca: ca,
      honorCipherOrder: true
    },
    (_req, res) => {
      res.writeHead(503)
      res.end()
    }
  )

  agentRegistrationServer = https.createServer(
    {
      key: fs.readFileSync(TLS_KEY_PATH), // eslint-disable-line
      cert: fs.readFileSync(TLS_CERT_PATH), // eslint-disable-line
      ca: ca,
      honorCipherOrder: true
    },
    (req, res) => {
      if (req.url === '/agent/verify') {
        let buf = ''
        req.on('data', d => {
          buf += d
        })
        req.on('end', () => {
          const { wasCreated, agentKey, agentSecret, clusterAddress } = JSON.parse(buf)

          // If this is a new cluster, request the config from the agent
          // TODO: Store a key in redis indicating its been verified and we need this agents config.
          // If the agent isn't currently connected, it won't get its config-request :(
          if (wasCreated) {
            this.agentRegistrationSocketServer
              .to(agentKey + '|' + agentSecret)
              .emit('config-request')
          }

          // Either way, send the agent it's configuration
          this.agentRegistrationSocketServer.to(agentKey + '|' + agentSecret).emit('agentData', {
            validDomains: [],
            clusterAddress
          })

          res.writeHead(202)
          res.end('OK')
        })
      } else {
        res.writeHead(404)
        res.end('Not Found')
      }
    }
  )

  agentRegistrationSocketServer = socketIO(this.agentRegistrationServer)

  async handleStream(
    protocol /*: string */,
    host /*: string */,
    socket /*: net.Socket */,
    data /*: any */
  ) {
    // FQDN means we don't support being access with an IP Address (DNS only!)
    if (!host || !validator.isFQDN(host)) {
      logger.debug('Received request with no host header', { host })
      return writeHeader(socket, 400, protocol, 'NO_HOST')
    }
    const socketStatus = await this.getSocketStatus(host)

    if (socketStatus === NO_SOCKETS_CONNECTED) {
      logger.debug('handleStream() getSocketStatus returned NO_SOCKETS_CONNECTED', { host })
      // TODO: We should use our own cert to reply with a valid HTTP response here - like a 503 (as we do with http)
      writeHeader(socket, 503, protocol, NO_SOCKETS_CONNECTED)
      // socket.pipe(this.errorMessageServer)
    } else if (socketStatus === SOCKET_CONNECTED_ELSEWHERE) {
      logger.debug('handleStream() getSocketStatus returned SOCKET_CONNECTED_ELSEWHERE', { host })
      // TODO: We can handle this using socket.io rooms, untested / stub for now
      writeHeader(socket, 503, protocol, SOCKET_CONNECTED_ELSEWHERE)
    } else if (socketStatus === SOCKET_CONNECTED_HERE) {
      logger.debug('handleStream() getSocketStatus returned SOCKET_CONNECTED_HERE', { host })
      const stream = socketIoStream.createStream()
      const agentSocket = this.localSocketMapping[host]
      socketIoStream(agentSocket).emit(protocol, stream, { host })

      // Write the initial data in this chunk
      stream.write(data)

      // Setup bi-directional pipe
      socket.pipe(stream).pipe(socket)

      // Cleanup when we're done!
      socket.on('close', () => {
        stream.end()
      })
      stream.on('close', () => {
        socket.end()
      })
    }
  }

  // Determines if the socket is connected locally, remotely, or not at all
  getSocketStatus(host /*: string */) /*: Promise<number|string> */ {
    return new Promise((resolve, reject) => {
      // If the socket happens to be connected to this local instance, let's fast-return that
      if (this.localSocketMapping[host]) resolve(SOCKET_CONNECTED_HERE)
      else {
        const namespace = this.agentRegistrationSocketServer.in(host)
        namespace.clients((err, clients) => {
          if (err) reject(err)
          else if (clients.length === 0) resolve(NO_SOCKETS_CONNECTED)
          else resolve(SOCKET_CONNECTED_ELSEWHERE)
        })
      }
    })
  }

  interrupt() {
    this.agentRegistrationServer.close()
    this.agentRegistrationServer.getConnections(function(err, count) {
      if (!err && count) {
        logger.error('Waiting for clients to disconnect. Grace', SHUTDOWN_GRACE)
        setTimeout(function() {
          process.exit()
        }, SHUTDOWN_GRACE)
      } else if (err) {
        logger.error('Error while receiving interrupt! Attempt to bail, no grace.', err)
        process.exit()
      }
    })
  }

  async init() {
    const redisSession = await redis('SESSION').waitForReady()
    const redisSessionSub = await redis('SESSION', true).waitForReady()

    const redisAdapter = socketIoRedis({
      pubClient: redisSession,
      subClient: redisSessionSub
    })
    this.agentRegistrationSocketServer.adapter(redisAdapter)

    this.agentRegistrationSocketServer.on('connection', agentAuthHandler.bind(this))

    initProm()
    process.once('SIGINT', this.interrupt)
    this.gatewayHttpsReplyer.listen(INTERNAL_HTTPS_RESPONDER_PORT, '127.0.0.1', () => {
      this.agentRegistrationServer.listen(GATEWAY_AGENT_LISTEN_PORT, () => {
        this.httpProxyServer.listen(GATEWAY_HTTP_LISTEN_PORT, () => {
          this.httpsProxyServer.listen(GATEWAY_HTTPS_LISTEN_PORT, () => {
            this.gatewayReady = true
            logger.info('kubesail-gateway ready!', {
              ports: {
                http: GATEWAY_HTTP_LISTEN_PORT,
                https: GATEWAY_HTTPS_LISTEN_PORT,
                agent: GATEWAY_AGENT_LISTEN_PORT
              },
              NODE_ENV: process.env.NODE_ENV
            })
          })
        })
      })
    })
  }
}

module.exports = KsGateway
