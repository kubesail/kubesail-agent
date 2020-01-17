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
  GATEWAY_HTTPS_LISTEN_PORT
} = require('../shared/config')
const logger = require('../shared/logger')
const { initProm } = require('../shared/prom')
const { sampleArray } = require('../shared/node')
const agentAuthHandler = require('./agentAuthHandler')

const NO_SOCKETS_CONNECTED = 'NO_SOCKETS_CONNECTED'
const SOCKET_CONNECTED_ELSEWHERE = 'SOCKET_CONNECTED_ELSEWHERE'
const SOCKET_CONNECTED_HERE = 'SOCKET_CONNECTED_HERE'

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

  async handleStream(protocol /*: string */, host /*: string */, socket /*: Socket */) {
    // FQDN means we don't support being access with an IP Address (DNS only!)
    if (!validator.isFQDN(host)) return socket.end('HTTP/1.1 400 NO_HOST\n\n')
    const socketStatus = await this.getSocketStatus(host)

    if (socketStatus === NO_SOCKETS_CONNECTED) {
      // TODO: We should use our own cert to reply with a valid HTTP response here - like a 503 (as we do with http)
      socket.end(`HTTP/1.1 503 ${NO_SOCKETS_CONNECTED}\n\n`)
    } else if (socketStatus === SOCKET_CONNECTED_ELSEWHERE) {
      // TODO: We can handle this using socket.io rooms, untested / stub for now
      socket.end(`HTTP/1.1 503 ${SOCKET_CONNECTED_ELSEWHERE}\n\n`)
    } else if (socketStatus === SOCKET_CONNECTED_HERE) {
      logger.debug('handleStream', { protocol, host, socketStatus })

      const stream = socketIoStream.createStream()
      const agentSocket = this.localSocketMapping[host]
      socketIoStream(agentSocket).emit(protocol, stream, { host })

      socket.pipe(stream)
      stream.pipe(socket)
    }
  }

  httpProxyServer = net.createServer(async socket => {
    socket.on('data', async data => {
      const parseHeaders = httpHeaders(data)
      if (parseHeaders && parseHeaders.headers && parseHeaders.headers.host)
        this.handleStream('http', parseHeaders.headers.host, socket)
    })
  })

  httpsProxyServer = net.createServer(socket => {
    socket.once('data', async data => {
      const host = sni(data)
      this.handleStream('http', host, socket)
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

  init() {
    const redisAdapter = socketIoRedis(sampleArray(REDIS_SERVERS))
    this.agentRegistrationSocketServer.adapter(redisAdapter)

    this.agentRegistrationSocketServer.on('connection', socket => {
      const agentData = agentAuthHandler(socket)
      if (!agentData) return socket.disconnect()

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
