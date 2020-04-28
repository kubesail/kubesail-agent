// @flow

/* flow-include
export type KsGatewayConfig = {}
*/

const net = require('net')
const https = require('https')
const fs = require('fs')
const sni = require('sni')
const httpHeaders = require('http-headers')
const socketIoRedis = require('socket.io-redis')
const socketIO = require('socket.io')
const { isFQDN } = require('validator')

const {
  TLS_KEY_PATH,
  TLS_CERT_PATH,
  TLS_CHAIN_PATH,
  GATEWAY_AGENT_LISTEN_PORT,
  GATEWAY_HTTP_LISTEN_PORT,
  GATEWAY_HTTPS_LISTEN_PORT,
  GATEWAY_INTERNAL_ADDRESS,
  NO_SOCKETS_CONNECTED,
  // SOCKET_CONNECTED_ELSEWHERE,
  SOCKET_CONNECTED_HERE,
  SHUTDOWN_GRACE,
  INTERNAL_HTTPS_RESPONDER_PORT,
  ALWAYS_VALID_DOMAINS,
  KUBESAIL_API_TARGET,
  KUBESAIL_API_SECRET,
  KUBESAIL_FIREWALL_WHITELIST
} = require('../shared/config')
const logger = require('../shared/logger')
const { initProm, prom } = require('../shared/prom')
const redis = require('./redis')

const [KubeSailApiTarget, KubeSailApiPort] = KUBESAIL_API_TARGET.split(':')

let ca
if (TLS_CHAIN_PATH && fs.existsSync(TLS_CHAIN_PATH)) ca = TLS_CHAIN_PATH // eslint-disable-line
if (!fs.existsSync(TLS_KEY_PATH) || !fs.existsSync(TLS_CERT_PATH)) {
  throw new Error(`Gateway is missing TLS_KEY_PATH or TLS_CERT_PATH! ${TLS_KEY_PATH}`)
}
if (process.env.NODE_ENV !== 'development' && ALWAYS_VALID_DOMAINS.length > 0) {
  throw new Error('ALWAYS_VALID_DOMAINS is set and NODE_ENV is not development!')
}
if (!GATEWAY_INTERNAL_ADDRESS) {
  throw new Error('GATEWAY_INTERNAL_ADDRESS is not set, exiting!')
}
if (process.env.NODE_ENV !== 'development' && KUBESAIL_FIREWALL_WHITELIST.includes['0.0.0.0/0']) {
  throw new Error('KUBESAIL_FIREWALL_WHITELIST cannot be 0.0.0.0/0 outside of development')
}

class KsGateway {
  // Indicates gateway is ready to take traffic
  // will fail healthchecks when falsey (used mainly to prevent recieving traffic before we're ready)
  gatewayReady = false

  // Maps hostnames to socket IDs which are connected locally, to this instance
  hostnameToSocketMapping = {}

  // Maps socketIds to sockets which are connected locally, to this instance
  socketMapping = {}

  // Firewall rules
  firewallRules = {}

  redis /*: any */

  httpProxyServer = net.createServer(async socket => {
    // Wait for first HELO
    socket.once('data', async data => {
      const parseHeaders = httpHeaders(data)
      if (parseHeaders && parseHeaders.headers && parseHeaders.headers.host)
        this.handleStream('http', (parseHeaders.headers.host || '').split(':')[0], socket, data)
    })
    socket.on('error', err => {
      if (err.code !== 'EPIPE') {
        logger.warn('httpProxyServer() error on socket:', {
          errMsg: err.message,
          code: err.code,
          type: err.type
        })
      }
    })
  })

  httpsProxyServer = net.createServer(socket => {
    socket.once('data', async data => {
      const host = (sni(data) || '').split(':')[0]
      this.handleStream('https', host, socket, data)
    })
    socket.on('error', err => {
      if (err.code !== 'EPIPE') {
        logger.warn('httpsProxyServer() error on socket:', {
          errMsg: err.message,
          code: err.code,
          type: err.type
        })
      }
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
      logger.info('gatewayHttpsReplyer', {
        host: req.headers.host,
        url: req.url,
        method: req.method,
        status: 503
      })
      res.writeHead(503)
      res.end('')
    }
  )

  gatewayServer = require('./gatewayServer').call(this)
  gatewayHTTPSServer = https.createServer(
    {
      key: fs.readFileSync(TLS_KEY_PATH), // eslint-disable-line
      cert: fs.readFileSync(TLS_CERT_PATH), // eslint-disable-line
      ca: ca,
      honorCipherOrder: true
    },
    this.gatewayServer
  )

  agentRegistrationSocketServer = socketIO(this.gatewayHTTPSServer)
  agentSocketConnectionHandler = require('./agentSocketConnectionHandler').bind(this)
  handleStream = require('./handleStream').bind(this)

  updateFirewall = (newRules /*: Object */) => {
    this.firewallRules = Object.assign({}, this.firewallRules, newRules)
  }

  remoteFirewallRules = (host /*: string */) => {
    delete this.firewallRules[host]
  }

  removeAgentSocket = async (socket /*: Socket */) => {
    logger.debug('Socket disconnected, cleaning up', { socketId: socket.id })
    socket.leave(socket.__agentKey)
    this.remoteFirewallRules(socket.__clusterAddress)
    // socket.leave(socket.__clusterAddress)
    if (socket.domains) {
      for (let i = 0; i < socket.domains.length; i++) {
        const host = socket.domains[i]
        delete this.hostnameToSocketMapping[host]
        this.remoteFirewallRules(host)
        // socket.leave(host)
      }
    }
    delete this.hostnameToSocketMapping[socket.__clusterAddress]
  }

  bindAgentSocketEvents = (
    socket /*: Socket */,
    agentKey /*: string */,
    agentSecret /*: string */,
    options /*: Object */ = {}
  ) => {
    logger.debug('bindAgentSocketEvents()', { agentKey })
    options = Object.assign(
      {},
      {
        hostname: KubeSailApiTarget,
        headers: { 'Content-Type': 'application/json' },
        port: KubeSailApiPort,
        method: 'POST'
      },
      options
    )
    socket.__agentKey = agentKey
    socket.join(agentKey)
    socket.on('config-response', ({ kubeConfig }) => {
      logger.debug('Received config-response. POSTing to API.')
      const req = https.request({ ...options, path: '/agent/config' }, res => {
        logger.info('agent config-response from api', { statusCode: res.statusCode })
      })
      req.write(
        JSON.stringify({ kubeConfig, agentKey, agentSecret, gatewaySecret: KUBESAIL_API_SECRET })
      )
      req.end()
    })
  }

  addSocketMapping = async (socket /*: Socket */, validDomains /*: Array<string> */) => {
    if (typeof socket === 'string')
      throw new Error('Cannot addSocketMapping with a socketID as a string!')
    for (let i = 0; i < validDomains.length; i++) {
      const host = validDomains[i]
      if (host && isFQDN(host)) {
        logger.debug(`Adding mapping for ${host}`)
        this.hostnameToSocketMapping[host] = socket
      } else {
        throw new Error(
          `addSocketMapping cannot add non FQDN as a mapped socket! domain: "${host}"`
        )
      }
    }
  }

  // Determines if the socket is connected locally, remotely, or not at all
  getSocketStatus(
    host /*: string */
  ) /*: Promise<{ status: number|string, gatewayAddress?: string }> */ {
    return new Promise((resolve, reject) => {
      // If the socket happens to be connected to this local instance, let's fast-return that
      if (this.hostnameToSocketMapping[host]) resolve({ status: SOCKET_CONNECTED_HERE })
      else {
        // const namespace = this.agentRegistrationSocketServer.in('/').adapter
        // namespace.clients(host, async (err, clients) => {
        //   if (err) reject(err)
        //   else if (clients.length === 0) resolve({ status: NO_SOCKETS_CONNECTED })
        //   else {
        //     if (!this.redis) {
        //       throw new Error(
        //         'Gateway does not have a handle to redis! Cannot distribute requests!'
        //       )
        //     }
        //     if (clients.length > 1)
        //       logger.warn('getSocketStatus() sees multiple sockets connected!!')
        //     const gatewayAddress = await this.redis.get(clients[0])
        //     if (!gatewayAddress) {
        //       logger.error(
        //         "getSocketStatus() A socket was connected to another gateway, but had no entry in the session table! This should'nt happen!"
        //       )
        //       resolve({ status: NO_SOCKETS_CONNECTED })
        //     } else {
        //       logger.debug('getSocketStatus()', { host, gatewayAddress, clients })
        //       if (gatewayAddress === GATEWAY_INTERNAL_ADDRESS) {
        //         throw new Error('A Socket claimed to be assigned here, but it is not! Bad cleanup?')
        //       }
        //       resolve({ status: SOCKET_CONNECTED_ELSEWHERE, gatewayAddress })
        //     }
        //   }
        // })
        resolve({ status: NO_SOCKETS_CONNECTED })
      }
    })
  }

  interrupt() {
    this.gatewayHTTPSServer.close()
    this.gatewayHTTPSServer.getConnections(function (err, count) {
      if (!err && count) {
        logger.error('Waiting for clients to disconnect. Grace', SHUTDOWN_GRACE)
        setTimeout(function () {
          process.exit()
        }, SHUTDOWN_GRACE)
      } else if (err) {
        logger.error('Error while receiving interrupt! Attempt to bail, no grace.', err)
        process.exit()
      }
    })
  }

  init = async () => {
    this.redis = await redis('SHARED').waitForReady()
    this.redisSub = await redis('SHARED', true).waitForReady()

    const redisAdapter = socketIoRedis({
      pubClient: await redis('SHARED', true).waitForReady(),
      subClient: await redis('SHARED', true).waitForReady()
    })
    this.agentRegistrationSocketServer.adapter(redisAdapter)

    this.agentRegistrationSocketServer.on('connection', this.agentSocketConnectionHandler)

    initProm()

    const agentsConnectedGauge = new prom.Gauge({
      name: 'agent_sockets_connected',
      help: 'Number of Agents connected',
      registers: [prom.register]
    })

    process.once('SIGINT', this.interrupt)
    this.gatewayHttpsReplyer.listen(INTERNAL_HTTPS_RESPONDER_PORT, '127.0.0.1', () => {
      this.gatewayHTTPSServer.listen(GATEWAY_AGENT_LISTEN_PORT, () => {
        this.httpProxyServer.listen(GATEWAY_HTTP_LISTEN_PORT, () => {
          this.httpsProxyServer.listen(GATEWAY_HTTPS_LISTEN_PORT, () => {
            this.gatewayReady = true
            logger.info('kubesail-gateway ready!', {
              ports: {
                http: GATEWAY_HTTP_LISTEN_PORT,
                https: GATEWAY_HTTPS_LISTEN_PORT,
                agent: GATEWAY_AGENT_LISTEN_PORT
              },
              GATEWAY_INTERNAL_ADDRESS,
              NODE_ENV: process.env.NODE_ENV
            })

            setInterval(() => {
              const sockets = Object.keys(this.agentRegistrationSocketServer.sockets.sockets).length
              agentsConnectedGauge.set(sockets)
            }, 10000)
          })
        })
      })
    })
  }
}

module.exports = KsGateway
