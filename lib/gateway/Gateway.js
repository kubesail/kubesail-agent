// @flow

const net = require('net')
const https = require('https')
const fs = require('fs')

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
  // So (20 or 50) + 64 = ~99 bytes * 250,000 = 25mb, or well within comfortable range for V8
  // If we wind up with more than 250,000 entries, yay! But also, why hasn't this cluster been sharded yet!!
  // Additionally, when this instance has the socketId, we do not store the gateway address in memory
  // If we miss a hostMap entry, we'll request it from redis!
  hostMap = new LRU({ max: 250000 })

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
  kubesailApiReqest = (method, path, data) /*: Promise<{ json: any, status: number }> */ => {
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
      })
      req.on('error', e => {
        logger.error('Failed to post event to KubeSail API', {
          errMsg: e.message,
          code: e.code,
          type: e.type
        })
      })

      req.write(JSON.stringify(data))
      req.end()
    })
  }

  // Configures an agent to recieve traffic
  // Rebroadcasts to other gateways with the agents configuration
  async addAgentSocketMapping({
    agentKey,
    socket,
    gateway,
    clusterAddress,
    domains
  }) /*: { agentKey: string|void, socket: Socket|void, gateway: void|string, domains: Object } */ {
    if (gateway === GATEWAY_INTERNAL_ADDRESS) return
    const existingRaw = await this.redis.get(`hm|${agentKey}`)
    const existingData = existingRaw ? JSON.parse(existingRaw) : {}
    const saveData /*: Object */ = Object.assign({}, existingData, {
      domains,
      gateway,
      clusterAddress,
      agentKey
    })
    if (!socket && this.socketMap[agentKey]) socket = this.socketMap[agentKey]

    logger.debug('addAgentSocketMapping', { agentKey, gateway, domains, socket: !!socket })
    if (socket && !gateway) {
      saveData.gateway = GATEWAY_INTERNAL_ADDRESS
      socket.emit('agent-data', saveData)
      await this.redis.publish('add-agent', JSON.stringify(saveData))
    }
    const json = JSON.stringify(saveData)
    this.redis.set(`akhm|${agentKey}`, json)
    const alreadyWrittenToRedis = json !== existingRaw
    for (const host in domains) {
      logger.debug('addAgentSocketMapping', { host })
      this.hostMap.set(host, saveData)
      if (!alreadyWrittenToRedis) this.redis.set(`hm|${host}`, json)
    }
  }

  async removeAgentSocket(agentKey /*: string */) {
    if (this.socketMap[agentKey]) {
      for (const host in this.socketMap[agentKey].domains) {
        this.hostMap.del(host)
        this.redis.del(`hm|${host}`)
      }
      this.redis.del(`akhm|${agentKey}`)
    } else {
      await this.redis.publish('remove-agent', JSON.stringify({ agentKey }))
    }
  }

  async getAgentSocketStatus(host /*: string */) /*: false|Object */ {
    let hostData = this.hostMap.get(host)
    if (!hostData) {
      const fromDb = await this.redis.get(`hm|${host}`)
      if (fromDb) {
        hostData = JSON.parse(fromDb)
        this.hostMap.set(host, hostData)
      } else {
        logger.debug('getAgentSocketStatus() returned false', { host })
        return false
      }
    }
    if (hostData.agentKey && this.socketMap[hostData.agentKey]) {
      return { ...hostData, socket: this.socketMap[hostData.agentKey] }
    }
    if (hostData) return hostData
    else {
      logger.error('Unable to determine socket status!')
      return false
    }
  }

  messageAgent = async (agentKey /*: string */, key /*: string */, value /*: any */) => {
    if (this.socketMap[agentKey]) {
      logger.debug('messageAgent Emitting message to agent:', { key, value })
      this.socketMap[agentKey].emit(key, value)
    } else {
      logger.debug('messageAgent publishing to redis:', { key, value })
      this.redis.publish(agentKey, JSON.stringify({ key, value }))
    }
  }

  agentSocketConnectionHandler = async (
    socket /*: Socket */
  ) /*: false|{ validDomains: Array<string>, clusterAddress: string } */ => {
    const agentKey = socket.handshake.query.key
    const agentSecret = socket.handshake.query.secret
    const username = socket.handshake.query.username

    socket.on('disconnect', async () => {
      this.removeAgentSocket(agentKey)
      await this.kubesailApiReqest('PUT', '/agent/disconnect', {
        agentKey,
        agentSecret,
        gatewaySecret: KUBESAIL_API_SECRET
      })
    })

    socket.on('error', function (err) {
      logger.error('agentSocketConnectionHandler() socket error', { errMsg: err.message })
    })

    socket.on('config-response', async ({ kubeConfig }) => {
      logger.debug('Received config-response. POSTing to API.')
      await this.kubesailApiReqest('POST', '/agent/config', {
        agentKey,
        agentSecret,
        gatewaySecret: KUBESAIL_API_SECRET,
        kubeConfig
      })
    })

    socket.on('health-check', async ({ agentVersion }) => {
      logger.debug('Received health-check. POSTing to API.')
      await this.kubesailApiReqest('POST', '/agent/config', {
        agentKey,
        agentSecret,
        gatewaySecret: KUBESAIL_API_SECRET,
        agentVersion
      })
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
      let { clusterAddress, firewall, domains } = json
      if (!domains) domains = {}
      ALWAYS_VALID_DOMAINS.forEach(d => (domains[d] = 1))
      domains[clusterAddress] = 1
      this.socketMap[agentKey] = socket

      logger.info('Agent registered! Sending configuration', {
        clusterAddress,
        firewall,
        domains
      })
      socket.__clusterAddress = clusterAddress
      await this.addAgentSocketMapping({
        agentKey,
        socket,
        clusterAddress,
        domains
      })
    } else if (status === 202) {
      // AGENT_REGISTER_PENDING
      logger.info('New agent pending', { agentKey })
      this.socketMap[agentKey] = socket
    } else {
      logger.warn('Disconnected agent due to invalid agentSocketConnectionHandler reply', {
        status
      })
      socket.disconnect()
    }
  }

  async proxyToGateway(
    hostData /*: Object */,
    protocol /*: string */,
    socket /*: Socket */,
    data /*: any */
  ) {
    const proxySocket = new net.Socket()
    proxySocket.connect(
      protocol === 'http' ? GATEWAY_HTTP_LISTEN_PORT : GATEWAY_HTTPS_LISTEN_PORT,
      hostData.gateway,
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
    hostData /*: Object */,
    protocol /*: string */,
    host /*: string */,
    socket /*: Socket */,
    ipv4 /*: string */,
    data /*: any */
  ) {
    if (!hostData.domains[host]) {
      logger.error('proxyLocalSocket() Recieved request for host it does not have!')
      socket.close()
      return
    }

    logger.debug('proxyLocalSocket', { host })

    let firewall = hostData.domains[host]
    if (typeof firewall === 'number') firewall = ''
    const matcher = new CIDRMatcher(
      (firewall || '').split(',').concat(KUBESAIL_FIREWALL_WHITELIST).filter(Boolean)
    )

    if (!matcher.contains(ipv4)) {
      logger.debug('Firewall REJECT!', { host, firewall, KUBESAIL_FIREWALL_WHITELIST, ipv4 })
      return writeHeader(socket, data, 501, protocol, 'UNSUPPORTED_PROTOCOL')
    }

    const stream = socketIoStream.createStream({ allowHalfOpen: true })

    try {
      socketIoStream(hostData.socket).emit(protocol, stream, { host })
    } catch (err) {
      logger.error('proxyLocalSocket() socketIoStream failed!', { errMsg: err.message })
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
        'proxyLocalSocket(SOCKET_CONNECTED_HERE) Failed to write initial HELO down agent-socket-stream',
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
      logger.debug('Received request with invalid host header', { protocol, host })
      return writeHeader(socket, data, 501, protocol, 'NO_HOST')
    }

    const address = socket.remoteAddress
    const ipv4 = address.substring(address.lastIndexOf(':') + 1, address.length)

    if (!isIP(ipv4)) {
      logger.warn('Got IPV6 request! Returning 501')
      return writeHeader(socket, data, 501, protocol, 'UNSUPPORTED_PROTOCOL')
    }

    const result = await this.getAgentSocketStatus(host)

    if (!result) {
      writeHeader(socket, data, 502, protocol, 'NO_SOCKETS_CONNECTED')
    } else if (result.socket) {
      this.proxyLocalSocket(result, protocol, host, socket, ipv4, data)
    } else if (result.gateway && result.gateway !== GATEWAY_INTERNAL_ADDRESS) {
      this.proxyToGateway(result, protocol, socket, data)
    } else {
      logger.error('handleStream() unknown status from getSocketStatus(), disconnecting', {
        result
      })
      socket.end()
    }
  }

  interrupt() {
    this.gatewayHTTPSServer.close()
    this.httpProxyServer.close()
    this.httpsProxyServer.close()
    this.waitForConnectionDrain().then(process.exit)
  }

  waitForConnectionDrain(waited = 0) {
    return new Promise((resolve, reject) => {
      const pollInterval = 250
      const maxWait = 60 * 1000
      if (waited > maxWait) resolve()
      this.gatewayHTTPSServer.getConnections(function (err, gateway) {
        if (err) return reject(err)
        this.httpProxyServer.getConnections(function (err, http) {
          if (err) return reject(err)
          this.httpsProxyServer.getConnections(function (err, https) {
            if (err) return reject(err)
            if (gateway + http + https > 0) {
              logger.info('Waiting for connections to drain...', { gateway, http, https })
              setTimeout(() => {
                resolve(this.waitForConnectionDrain(waited + pollInterval))
              }, pollInterval)
            } else {
              resolve()
            }
          })
        })
      })
    })
  }

  async init() {
    initProm()
    this.redis = await redis('SHARED').waitForReady()
    this.redisSub = await redis('SHARED', true).waitForReady()
    this.redisSub.on('message', (channel, message) => {
      const data = JSON.parse(message)
      if (channel === 'add-agent') this.addAgentSocketMapping(data)
      else if (this.socketMap[channel]) {
        logger.debug('Emitting message to socket:', data.key, data.value)
        this.socketMap[channel].emit(data.key, data.value)
      }
    })
    this.redisSub.subscribe('agents')
    process.once('SIGINT', this.interrupt)

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
