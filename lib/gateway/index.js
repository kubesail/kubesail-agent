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
  REDIS_SERVERS,
  GATEWAY_AGENT_LISTEN_PORT,
  GATEWAY_HTTP_LISTEN_PORT,
  GATEWAY_HTTPS_LISTEN_PORT,
  NO_SOCKETS_CONNECTED,
  SOCKET_CONNECTED_ELSEWHERE,
  SOCKET_CONNECTED_HERE,
  SHUTDOWN_GRACE
} = require('../shared/config')
const logger = require('../shared/logger')
const { initProm } = require('../shared/prom')
const { sampleArray, writeHeader } = require('../shared')
const agentAuthHandler = require('./agentAuthHandler')

let ca
if (TLS_CHAIN_PATH && fs.existsSync(TLS_CHAIN_PATH)) ca = TLS_CHAIN_PATH // eslint-disable-line

class KsGateway {
  // Indicates gateway is ready to take traffic
  // will fail healthchecks when falsey (used mainly to prevent recieving traffic before we're ready)
  gatewayReady = false

  // Maps hostnames to socket IDs which are connected locally, to this instance
  localSocketMapping = {}
  // Maps socket IDs to hostnames
  localSocketReverseMapping = {}

  agentRegistrationServer = https.createServer({
    key: fs.readFileSync(TLS_KEY_PATH), // eslint-disable-line
    cert: fs.readFileSync(TLS_CERT_PATH), // eslint-disable-line
    ca: ca,
    honorCipherOrder: true
  })

  agentRegistrationSocketServer = socketIO(this.agentRegistrationServer)

  async handleStream(
    protocol /*: string */,
    host /*: string */,
    socket /*: Socket */,
    data /*: any */
  ) {
    // FQDN means we don't support being access with an IP Address (DNS only!)
    if (!validator.isFQDN(host)) return socket.end(writeHeader(400, protocol, 'NO_HOST'))
    const socketStatus = await this.getSocketStatus(host)

    logger.debug('handleStream', { protocol, host, socketStatus })

    if (socketStatus === NO_SOCKETS_CONNECTED) {
      // TODO: We should use our own cert to reply with a valid HTTP response here - like a 503 (as we do with http)
      socket.end(writeHeader(503, protocol, NO_SOCKETS_CONNECTED))
      // socket.pipe(this.errorMessageServer)
    } else if (socketStatus === SOCKET_CONNECTED_ELSEWHERE) {
      // TODO: We can handle this using socket.io rooms, untested / stub for now
      socket.end(writeHeader(503, protocol, SOCKET_CONNECTED_ELSEWHERE))
    } else if (socketStatus === SOCKET_CONNECTED_HERE) {
      const stream = socketIoStream.createStream()
      const agentSocket = this.localSocketMapping[host]
      socketIoStream(agentSocket).emit(protocol, stream, { host })

      // Write the initial data in this chunk
      stream.write(data)

      // Setup bi-directional pipe
      socket.pipe(stream)
      stream.pipe(socket)

      // Cleanup when we're done!
      socket.on('close', () => {
        stream.end()
      })
      stream.on('close', () => {
        socket.end()
      })
    }
  }

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

  // Determines if the socket is connected locally, remotely, or not at all
  getSocketStatus(host /*: string */) /*: number */ {
    return new Promise((resolve, reject) => {
      // If the socket happens to be connected to this local instance, let's fast-return that
      if (this.localSocketMapping[host]) resolve(SOCKET_CONNECTED_HERE)
      else {
        const namespace = this.agentRegistrationSocketServer.of(host)
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

  init() {
    const redisAdapter = socketIoRedis(sampleArray(REDIS_SERVERS))
    this.agentRegistrationSocketServer.adapter(redisAdapter)

    this.agentRegistrationSocketServer.on('connection', socket => {
      const agentData = agentAuthHandler(socket)
      if (!agentData) return socket.disconnect()

      socket.emit('agentData', agentData)

      socket.on('disconnect', msg => {
        const domains = this.localSocketReverseMapping[socket.id]

        logger.debug('Socket disconnected, cleaning up', { socketId: socket.id, domains })
        for (let i = 0; i < domains.length; i++) {
          const host = domains[i]
          delete this.localSocketMapping[host]
        }
        delete this.localSocketReverseMapping[socket.id]
      })

      logger.debug('Agent connected', { agentData })
      for (let i = 0; i < agentData.validDomains.length; i++) {
        const domain = agentData.validDomains[i]
        this.localSocketMapping[domain] = socket
        if (this.localSocketReverseMapping[socket.id]) {
          this.localSocketReverseMapping[socket.id].push(domain)
        } else {
          this.localSocketReverseMapping[socket.id] = [domain]
        }
      }
    })

    redisAdapter.pubClient.on('error', err => {
      throw err
    })
    redisAdapter.subClient.on('error', err => {
      throw err
    })

    initProm()
    process.once('SIGINT', this.interrupt)
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
  }
}

module.exports = KsGateway
