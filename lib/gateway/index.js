// @flow

/* flow-include
export type KsGatewayConfig = {}
*/

const net = require('net')
const http = require('http')
const https = require('https')
const fs = require('fs')
const socketIO = require('socket.io')
const socketIoRedis = require('socket.io-redis')
const sni = require('sni')

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

  agentRegistrationServer = https.createServer({
    key: fs.readFileSync(TLS_KEY_PATH), // eslint-disable-line
    cert: fs.readFileSync(TLS_CERT_PATH), // eslint-disable-line
    ca: ca,
    honorCipherOrder: true
  })

  agentRegistrationSocketServer = socketIO(this.agentRegistrationServer)

  httpProxyServer = http.createServer(async (req, res) => {
    const host = req.headers.host
    if (!host) {
      res.writeHead(400)
      return res.end('NO_HOST')
    }
    const socketStatus = await this.getSocketStatus(host)

    logger.debug('httpProxyServer', { host, socketStatus })

    switch (socketStatus) {
      case NO_SOCKETS_CONNECTED:
        res.writeHead(503)
        res.end(NO_SOCKETS_CONNECTED)
        break
      case SOCKET_CONNECTED_ELSEWHERE:
        res.writeHead(200)
        res.end(SOCKET_CONNECTED_ELSEWHERE)
        break
      case SOCKET_CONNECTED_HERE:
        res.writeHead(200)
        res.end(SOCKET_CONNECTED_HERE)
        break
      default:
        throw new Error('Unknown socket status!')
    }
  })

  httpsProxyServer = net.createServer(socket => {
    socket.once('data', async data => {
      const host = sni(data)

      if (!host) {
        logger.debug('httpsProxyServer No SNI, rejecting')
        return socket.end()
      }
      const socketStatus = await this.getSocketStatus(host)

      logger.debug('httpsProxyServer', { host, socketStatus })

      switch (socketStatus) {
        // TODO: We should use our own cert to reply with a valid HTTP response here - like a 503 (as we do with http)
        case NO_SOCKETS_CONNECTED:
          socket.end()
          break
        case SOCKET_CONNECTED_ELSEWHERE:
          socket.end()
          break
        case SOCKET_CONNECTED_HERE:
          socket.end()
          break
        default:
          throw new Error('Unknown socket status!')
      }
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
      const agentToken = socket.handshake.query.token
      logger.debug('Agent connected', { agentToken })
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
