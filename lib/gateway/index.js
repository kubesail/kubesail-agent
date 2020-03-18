// @flow

/* flow-include
export type KsGatewayConfig = {}
*/

const net = require('net')
const https = require('https')
const fs = require('fs')
const socketIoStream = require('socket.io-stream')
const sni = require('sni')
const httpHeaders = require('http-headers')
const socketIoRedis = require('socket.io-redis')
const socketIO = require('socket.io')
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
const { writeHeader, sampleArray } = require('../shared')
const agentAuthHandler = require('./agentAuthHandler')
const redis = require('./redis')

let ca
if (TLS_CHAIN_PATH && fs.existsSync(TLS_CHAIN_PATH)) ca = TLS_CHAIN_PATH // eslint-disable-line
if (!fs.existsSync(TLS_KEY_PATH) || !fs.existsSync(TLS_CERT_PATH)) {
  throw new Error(`Gateway is missing TLS_KEY_PATH or TLS_CERT_PATH! ${TLS_KEY_PATH}`)
}
if (process.env.NODE_ENV !== 'development' && ALWAYS_VALID_DOMAINS.length > 0) {
  throw new Error('ALWAYS_VALID_DOMAINS is set and NODE_ENV is not development!')
}
if (!process.env.GATEWAY_INTERNAL_ADDRESS) {
  throw new Error('GATEWAY_INTERNAL_ADDRESS is not set, exiting!')
}

class KsGateway {
  // Indicates gateway is ready to take traffic
  // will fail healthchecks when falsey (used mainly to prevent recieving traffic before we're ready)
  gatewayReady = false

  // Maps hostnames to socket IDs which are connected locally, to this instance
  localSocketMapping = {}
  // Maps socket IDs to hostnames
  localSocketReverseMapping = {}

  redis /*: any */

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
    (req, res) => {
      logger.debug('gatewayHttpsReplyer got request!', { host: req.headers.host, url: req.url })
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

          logger.info('agentRegistrationServer /agent/verify', { agentKey })

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
    socket /*: Socket */,
    data /*: any */
  ) {
    // FQDN means we don't support being access with an IP Address (DNS only!)
    if (!host || !validator.isFQDN(host)) {
      logger.debug('Received request with no host header', { protocol, host })
      return writeHeader(socket, data, 400, protocol, 'NO_HOST')
    }
    const { status, gatewayAddress } = await this.getSocketStatus(host)
    const debugInfo = { host, protocol }

    if (status === NO_SOCKETS_CONNECTED) {
      logger.debug('handleStream() getSocketStatus returned NO_SOCKETS_CONNECTED', debugInfo)
      // TODO: We should use our own cert to reply with a valid HTTP response here - like a 503 (as we do with http)
      writeHeader(socket, data, 503, protocol, NO_SOCKETS_CONNECTED)
      // socket.pipe(this.errorMessageServer)
    } else if (status === SOCKET_CONNECTED_ELSEWHERE && gatewayAddress) {
      logger.debug('handleStream() getSocketStatus returned SOCKET_CONNECTED_ELSEWHERE', {
        ...debugInfo,
        proxyTo: gatewayAddress
      })

      const proxySocket = new net.Socket()

      logger.debug('handleStream() Forwarding to adjacent gateway request', {
        host,
        protocol,
        gatewayAddress
      })
      proxySocket.connect(
        protocol === 'http' ? GATEWAY_HTTP_LISTEN_PORT : GATEWAY_HTTPS_LISTEN_PORT,
        gatewayAddress,
        () => {
          logger.silly('handleStream() Forwarding to gateway: connected!')
          proxySocket.write(data)
          proxySocket.pipe(socket).pipe(proxySocket)
        }
      )
      socket.on('close', () => {
        try {
          proxySocket.end()
        } catch (err) {
          logger.error('handleStream() failed to close proxySocket on socket close')
        }
      })
      proxySocket.on('close', () => {
        try {
          socket.end()
        } catch (err) {
          logger.error('handleStream() failed to close socket on proxySocket close')
        }
      })
      socket.on('error', err => {
        logger.warn('handleStream() error on socket:', { errMsg: err.message })
      })
      proxySocket.on('error', err => {
        logger.warn('handleStream() error on proxySocket:', { errMsg: err.message })
      })
    } else if (status === SOCKET_CONNECTED_HERE) {
      logger.debug('handleStream() getSocketStatus returned SOCKET_CONNECTED_HERE', debugInfo)
      const stream = socketIoStream.createStream()
      const agentSocket = this.localSocketMapping[host]
      socketIoStream(agentSocket).emit(protocol, stream, { host })

      // Write the initial data in this chunk
      stream.write(data)

      // Setup bi-directional pipe
      socket.pipe(stream).pipe(socket)

      // Cleanup when we're done!
      socket.on('close', () => stream.end())
      stream.on('close', () => socket.end())
    } else {
      logger.error('handleStream() unknown status from getSocketStatus(), disconnecting')
      socket.end()
    }
  }

  // Determines if the socket is connected locally, remotely, or not at all
  getSocketStatus(
    host /*: string */
  ) /*: Promise<{ status: number|string, gatewayAddress?: string }> */ {
    return new Promise((resolve, reject) => {
      // If the socket happens to be connected to this local instance, let's fast-return that
      if (this.localSocketMapping[host]) resolve({ status: SOCKET_CONNECTED_HERE })
      else {
        const namespace = this.agentRegistrationSocketServer.in(host)
        namespace.clients(async (err, clients) => {
          if (err) reject(err)
          else if (clients.length === 0) resolve({ status: NO_SOCKETS_CONNECTED })
          else {
            if (!this.redis) {
              throw new Error(
                'Gateway does not have a handle to redis! Cannot distribute requests!'
              )
            }
            const gatewayAddress = await this.redis.get(sampleArray(clients))
            if (!gatewayAddress) {
              logger.error(
                "getSocketStatus() A socket was connected to another gateway, but had no entry in the session table! This should'nt happen!"
              )
              resolve({ status: NO_SOCKETS_CONNECTED })
            } else {
              resolve({ status: SOCKET_CONNECTED_ELSEWHERE, gatewayAddress })
            }
          }
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
    this.redis = await redis('SESSION').waitForReady()
    const redisSession = await redis('SESSION', true).waitForReady()
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
