// @flow

const net = require('net')
const https = require('https')
const fs = require('fs')
const crypto = require('crypto')

const sni = require('sni')
const httpHeaders = require('http-headers')
const socketIO = require('socket.io')
const { isFQDN, isIP } = require('validator')
const CIDRMatcher = require('cidr-matcher')
const socketIoStream = require('socket.io-stream')
const LRU = require('lru-cache')

const gatewayVersion = require('../../package.json').version
const logger = require('../shared/logger')
const { initProm } = require('../shared/prom')
const redis = require('./redis')
const { writeHeader, getWeek } = require('../shared')
const {
  TLS_KEY_PATH,
  TLS_CERT_PATH,
  TLS_CHAIN_PATH,
  GATEWAY_AGENT_LISTEN_PORT,
  GATEWAY_HTTP_LISTEN_PORT,
  GATEWAY_HTTPS_LISTEN_PORT,
  GATEWAY_ADDRESS,
  GATEWAY_INTERNAL_ADDRESS,
  NO_SOCKETS_CONNECTED,
  SOCKET_CONNECTED_ELSEWHERE,
  SOCKET_CONNECTED_HERE,
  INTERNAL_HTTPS_RESPONDER_PORT,
  ALWAYS_VALID_DOMAINS,
  KUBESAIL_API_TARGET,
  KUBESAIL_API_SECRET,
  KUBESAIL_FIREWALL_WHITELIST
} = require('../shared/config')

const [KubeSailApiTarget, KubeSailApiPort] = KUBESAIL_API_TARGET.split(':')

// Generic error handler for proxy sockets.
function proxyServerErrorHandler(name) {
  return err => {
    logger.warn(`${name}: error:`, {
      errMsg: err.message,
      code: err.code,
      type: err.type
    })
  }
}

module.exports = class Gateway {
  // A list of hostname to array of sockets, or a gateway address
  // Structured like:
  // { "hostname.com": { socketId: string, gateway: string, firewall: string } }
  // Only one of socketId or gateway will be set
  // SocketId are 20 characters
  // gateway is a URI, eg: test.erulabs.kubesail-gateway.default.svc.cluster.local (lets say a very high estimate is 50 characters)
  // firewall is a comma delinated list of CIDR masks, no longer than 64 characters
  // So 20 + 50 + 64 = 134 bytes * 200000 = 26mb, or well within comfortable range for V8
  // If we wind up with more than 200,000 entries, yay! But also, why hasn't this cluster been sharded yet!!
  // If we miss a hostMap entry, we'll request it from redis!
  hostMap = new LRU({ max: 200000 })

  // A list of locally connected sockets
  socketMap = {}

  // Responsible for proxying HTTP requests (based on HOST header)
  httpProxyServer = net.createServer(async socket => {
    socket.once('data', async data => {
      const hostHeader = (httpHeaders(data).headers.host || '').split(':')[0]
      this.handleStream('http', hostHeader, socket, data)
    })
    socket.on('error', proxyServerErrorHandler('http'))
  })

  // Responsible for proxying TLS requests (based on SNI header)
  httpsProxyServer = net.createServer(socket => {
    socket.once('data', async data => {
      const host = (sni(data) || '').split(':')[0]
      this.handleStream('https', host, socket, data)
    })
    socket.on('error', proxyServerErrorHandler('https'))
  })

  // Responsible for writing replies to un-proxyable requests (listens internally)
  gatewayHttpsReplyer = https.createServer(
    {
      key: fs.readFileSync(TLS_KEY_PATH),
      cert: fs.readFileSync(TLS_CERT_PATH),
      ca: this.ca,
      honorCipherOrder: true
    },
    (req, res) => {
      logger.debug('gatewayHttpsReplyer', {
        host: req.headers.host,
        url: req.url,
        method: req.method
      })
      res.writeHead(503)
      res.end('')
    }
  )

  // Gateway server (express) responds to configuration requests from the KubeSail API
  gatewayServer = require('./gatewayServer').call(this)

  // HTTPS Wrapper around Gateway express server
  gatewayHTTPSServer = https.createServer(
    {
      key: fs.readFileSync(TLS_KEY_PATH),
      cert: fs.readFileSync(TLS_CERT_PATH),
      ca: this.ca,
      honorCipherOrder: true
    },
    this.gatewayServer
  )

  // SocketIO server, sharing port with Gateway Server
  agentRegistrationSocketServer = socketIO(this.gatewayHTTPSServer)

  constructor() {
    if (TLS_CHAIN_PATH && fs.existsSync(TLS_CHAIN_PATH)) {
      this.ca = TLS_CHAIN_PATH
    }
    if (!fs.existsSync(TLS_KEY_PATH) || !fs.existsSync(TLS_CERT_PATH)) {
      throw new Error(`Gateway is missing TLS_KEY_PATH or TLS_CERT_PATH! ${TLS_KEY_PATH}`)
    }
    if (process.env.NODE_ENV !== 'development' && ALWAYS_VALID_DOMAINS.length > 0) {
      throw new Error('ALWAYS_VALID_DOMAINS is set and NODE_ENV is not development!')
    }
    if (!GATEWAY_INTERNAL_ADDRESS) {
      throw new Error('GATEWAY_INTERNAL_ADDRESS is not set, exiting!')
    }
  }

  // Gateway makes HTTPS requests to KubeSail API for things like agent disconnection / registration, etc
  // kubesailApiReqest is a simple wrapper around `https.request`.
  // This could probably be replaced by `got` or something modern
  async kubesailApiReqest(method, path, data) /*: Promise<{ json: any, status: number }> */ {
    return new Promise((resolve, reject) => {
      const options /*: Object */ = {
        hostname: KubeSailApiTarget,
        headers: { 'Content-Type': 'application/json' },
        port: KubeSailApiPort,
        method
      }
      if (process.env.NODE_ENV === 'development') {
        options.insecure = true
        options.rejectUnauthorized = false
      }
      const req = https.request({ ...options, path }, res => {
        res.on('error', err => {
          logger.error('Gateway got error talking to KubeSail Api on socket disconnect!', {
            errMsg: err.message,
            code: err.code
          })
        })
        let buff = ''
        res.on('data', data => {
          buff = buff + data
        })
        res.on('close', () => {
          resolve({ status: res.statusCode, json: JSON.parse(buff) })
        })
        res.on('error', reject)
      })
      req.write(JSON.stringify(data))
      req.end()
    })
  }

  // Configures an agent to recieve traffic
  async addAgentSocketMapping(
    socket /*: Socket|string */,
    options /*: { domains: Array<string>, firewall: Object } */
  ) {
    if (typeof socket === 'object' && !options.gateway) {
      options.gateway = GATEWAY_INTERNAL_ADDRESS
      await this.redis.publish('add-agent', JSON.stringify({ socket: socket.id, options }))
    } else if (typeof socket === 'string' && options.gateway) {
    }
  }

  async removeAgentSocket(socket /*: Socket */) {}

  async getAgentSocketStatus(host /*: string */) {}

  async updateAgentFirewall(host /*: string */, firewall /*: Object */) {}

  async agentSocketConnectionHandler(
    socket /*: Socket */,
    retries /*: number */ = 0
  ) /*: false|{ validDomains: Array<string>, clusterAddress: string } */ {
    const agentKey = socket.handshake.query.key
    const agentSecret = socket.handshake.query.secret
    const username = socket.handshake.query.username

    socket.on('disconnect', async () => {
      this.removeAgentSocket(socket)
      await this.kubesailApiReqest('PUT', '/agent/disconnect', {
        agentKey,
        agentSecret,
        gatewaySecret: KUBESAIL_API_SECRET
      })
    })

    socket.on('error', function (err) {
      logger.error('agentSocketConnectionHandler() socket error', { errMsg: err.message })
    })

    const { status, json } = await this.kubesailApiReqest('POST', '/agent/register', {
      username,
      agentKey,
      agentSecret,
      gatewaySecret: KUBESAIL_API_SECRET,
      gatewayAddress: GATEWAY_ADDRESS
    })

    logger.debug('New socket connection!', { GATEWAY_INTERNAL_ADDRESS })

    if (status === 200) {
      // AGENT_REGISTER_VALID
      let { clusterAddress, firewall, validDomains } = json
      validDomains = validDomains.concat(ALWAYS_VALID_DOMAINS).filter(Boolean)
      logger.info('Agent registered! Sending configuration', {
        clusterAddress,
        firewall,
        validDomains
      })
      socket.__clusterAddress = clusterAddress
      await this.addAgentSocketMapping(socket, {
        domains: [clusterAddress, ...validDomains]
      })
      socket.emit('agent-data', { validDomains, clusterAddress })
    } else if (status === 202) {
      // AGENT_REGISTER_PENDING
      logger.info('New agent pending', { agentKey })
    } else {
      logger.warn('Disconnected agent due to invalid agentSocketConnectionHandler reply', {
        status
      })
      socket.disconnect()
    }
  }

  async proxyToGateway(
    gatewayAddress /*: string */,
    protocol /*: string */,
    host /*: string */,
    socket /*: Socket */,
    ipv4 /*: string */,
    data /*: any */
  ) {
    logger.info('handleStream() getSocketStatus returned SOCKET_CONNECTED_ELSEWHERE', {
      host,
      ipv4,
      proxyTo: gatewayAddress,
      GATEWAY_INTERNAL_ADDRESS
    })

    const proxySocket = new net.Socket()

    proxySocket.connect(
      protocol === 'http' ? GATEWAY_HTTP_LISTEN_PORT : GATEWAY_HTTPS_LISTEN_PORT,
      gatewayAddress,
      () => {
        proxySocket.write(data)
        proxySocket
          .pipe(socket)
          .on('error', proxyServerErrorHandler('socketPipeErr SOCKET_CONNECTED_ELSEWHERE'))
          .pipe(proxySocket)
          .on('error', proxyServerErrorHandler('streamErr SOCKET_CONNECTED_ELSEWHERE'))
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
    socket.on('error', proxyServerErrorHandler('socket SOCKET_CONNECTED_ELSEWHERE'))
    proxySocket.on('error', proxyServerErrorHandler('proxySocket SOCKET_CONNECTED_ELSEWHERE'))
  }

  async proxyLocalSocket(
    protocol /*: string */,
    host /*: string */,
    socket /*: Socket */,
    ipv4 /*: string */,
    data /*: any */
  ) {
    const socketId = this.hostnameToSocketMapping[host]
    const agentSocket = this.socketMapping[socketId]

    if (!agentSocket || !agentSocket.__agentKey) {
      throw new Error(
        `Got SOCKET_CONNECTED_HERE, but no hostnameToSocketMapping existed. Host: ${host}`
      )
    }

    const firewall = await this.redis.get(`fw:${host}`)

    const matcher = new CIDRMatcher(
      (firewall || '').split(',').concat(KUBESAIL_FIREWALL_WHITELIST).filter(Boolean)
    )

    if (!matcher.contains(ipv4)) {
      logger.debug('Firewall REJECT!', { host, firewall, KUBESAIL_FIREWALL_WHITELIST, ipv4 })
      return writeHeader(socket, data, 501, protocol, 'UNSUPPORTED_PROTOCOL')
    }

    const stream = socketIoStream.createStream({ allowHalfOpen: true })

    try {
      socketIoStream(agentSocket).emit(protocol, stream, { host })
    } catch (err) {
      logger.error('handleStream() socketIoStream failed!', { errMsg: err.message })
      socket.close()
      stream.close()
      return
    }

    // Cleanup when we're done!
    socket.on('close', async () => {
      stream.end()

      // Collect bandwidth metrics for this connection!
      const date = new Date()
      const key = `${host}-${getWeek()}`

      // One week in minutes is 604800 (7 * 24 * 60 * 60)
      // We will keep bandwidth stored to the minute, so 10080 slots (7 * 24 * 60)
      // To calculate what slot we're currently in: d.getDay() * d.getHours() * d.getMinutes()
      const currentSlot = date.getDay() * date.getHours() * date.getMinutes()

      // Expire bandwidth stats after 3 months
      const expireDate = new Date()
      expireDate.setMonth(expireDate.getMonth() + 3)
      const expireAt = Math.floor(expireDate.getTime() / 1000)

      await this.redis.zincrby(`${key}-rcv`, socket.bytesWritten, currentSlot)
      await this.redis.expireat(`${key}-rcv`, expireAt)

      await this.redis.zincrby(`${key}-sent`, socket.bytesRead, currentSlot)
      await this.redis.expireat(`${key}-sent`, expireAt)

      await this.redis.zincrby(`${key}-reqs`, 1, currentSlot)
      await this.redis.expireat(`${key}-reqs`, expireAt)
    })

    stream.on('close', () => socket.end())
    stream.on('error', proxyServerErrorHandler('streamErr'))

    // Write the initial data in this chunk
    try {
      stream.write(data)
    } catch (err) {
      logger.error(
        'handleStream(SOCKET_CONNECTED_HERE) Failed to write initial HELO down agent-socket-stream',
        { errMsg: err.message }
      )
      writeHeader(socket, data, 503, protocol, 'AGENT_ERROR')
      stream.end()
      return
    }

    // Setup bi-directional pipe
    socket
      .pipe(stream)
      .on('error', proxyServerErrorHandler('streamPipeErr SOCKET_CONNECTED_HERE'))
      .pipe(socket)
      .on('error', proxyServerErrorHandler('socketPipeErr SOCKET_CONNECTED_HERE'))
  }

  async handleStream(
    protocol /*: string */,
    host /*: string */,
    socket /*: Socket */,
    data /*: any */
  ) {
    // FQDN means we don't support being accessed with an IP Address (DNS only!)
    if (!host || !isFQDN(host)) {
      logger.debug('Received request with no host header', { protocol, host })
      return writeHeader(socket, data, 501, protocol, 'NO_HOST')
    }

    const address = socket.remoteAddress
    const ipv4 = address.substring(address.lastIndexOf(':') + 1, address.length)

    if (!isIP(ipv4)) {
      logger.warn('Got IPV6 request! Returning 501')
      return writeHeader(socket, data, 501, protocol, 'UNSUPPORTED_PROTOCOL')
    }

    const { status, gatewayAddress } = await this.getSocketStatus(host)

    if (status === SOCKET_CONNECTED_HERE) {
      this.proxyLocalSocket(protocol, host, socket, ipv4, data)
    } else if (status === NO_SOCKETS_CONNECTED) {
      // logger.debug('handleStream() getSocketStatus returned NO_SOCKETS_CONNECTED', debugInfo)
      writeHeader(socket, data, 502, protocol, NO_SOCKETS_CONNECTED)
    } else if (status === SOCKET_CONNECTED_ELSEWHERE && gatewayAddress) {
      this.proxyToGateway(gatewayAddress, protocol, host, socket, ipv4, data)
    } else {
      logger.error('handleStream() unknown status from getSocketStatus(), disconnecting')
      socket.end()
    }
  }

  async init() {
    initProm()
    this.redis = await redis('SHARED').waitForReady()
    this.redisSub = await redis('SHARED', true).waitForReady()
    this.redisSub.on('message', function (channel, message) {
      logger.debug('Regis sub got message:', channel, message)
    })
    this.redisSub.subscribe('agents')

    this.agentRegistrationSocketServer.on('connection', this.agentSocketConnectionHandler)
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
              NODE_ENV: process.env.NODE_ENV,
              gatewayVersion
            })
          })
        })
      })
    })
  }
}
