// @flow

const net = require('net')
const https = require('https')
const fs = require('fs')
const sni = require('sni')
const httpHeaders = require('http-headers')
const socketIO = require('socket.io')
const { isFQDN, isIP, isIPRange } = require('validator')
const CIDRMatcher = require('cidr-matcher')
const socketIoStream = require('socket.io-stream')
const LRU = require('lru-cache')
const logger = require('../shared/logger')
const { initProm, bandwidthRecv, bandwidthSent } = require('../shared/prom')
const redis = require('./redis')
const { kubesailApiRequest } = require('../shared')
const {
  TLS_KEY_PATH,
  TLS_CERT_PATH,
  TLS_CHAIN_PATH,
  GATEWAY_AGENT_LISTEN_PORT,
  GATEWAY_HTTP_LISTEN_PORT,
  GATEWAY_HTTPS_LISTEN_PORT,
  GATEWAY_ADDRESS,
  GATEWAY_INTERNAL_ADDRESS,
  INTERNAL_HTTPS_RESPONDER_PORT_501,
  INTERNAL_HTTPS_RESPONDER_PORT_503,
  ALWAYS_VALID_DOMAINS,
  KUBESAIL_API_SECRET,
  KUBESAIL_FIREWALL_WHITELIST,
  KUBESAIL_API_TARGET,
  RELEASE
} = require('../shared/config')

// Generic error handler for proxy sockets.
function proxyServerErrorHandler(socket, name) {
  return err => {
    let level = 'warn'
    if (err.code === 'EPIPE' || err.code === 'ECONNRESET' || err.message === 'Connection aborted') {
      level = 'silly'
    }
    logger[level](`proxyServerErrorHandler: ${name}: error:`, {
      errMsg: err.message,
      code: err.code,
      type: err.type,
      clusterAddress: socket.__clusterAddress
    })
    socket.end()
  }
}

function readCA() {
  return TLS_CHAIN_PATH && fs.existsSync(TLS_CHAIN_PATH)
    ? [fs.readFileSync(TLS_CHAIN_PATH)]
    : undefined
}

module.exports = class Gateway {
  // A list of hostname to array of sockets, or a gateway address
  // Structured like:
  // { "hostname.com": { socketId: string, gateway: string, firewall: string } }
  // Only one of socketId or gateway will be set
  // SocketId are 20 characters
  // gateway is a URI, eg: a-dev-cluster.erulabs.dev.k8g8.com (lets say a very high estimate is 50 characters)
  // firewall is a comma delineated list of CIDR masks, no longer than 64 characters
  // So (20 or 50) + 64 = ~99 bytes * 25,000 = 2.5mb, or well within comfortable range for V8
  // If we wind up with more than 25,000 entries, yay! But also, why hasn't this cluster been sharded yet!!
  // Additionally, when this instance has the socketId, we do not store the gateway address in memory
  // If we miss a hostMap entry, we'll request it from redis!
  hostMap = new LRU({ max: 25000 })

  // A list of locally connected sockets
  socketMap = {}

  // Responsible for proxying HTTP requests (based on HOST header)
  httpProxyServer = net.createServer(async socket => {
    socket.on('error', proxyServerErrorHandler(socket, 'http'))
    socket.once('data', data => this.handleStream('http', socket, data))
  })

  // Responsible for proxying TLS requests (based on SNI header)
  httpsProxyServer = net.createServer(socket => {
    socket.on('error', proxyServerErrorHandler(socket, 'https'))
    socket.once('data', data => this.handleStream('https', socket, data))
  })

  // Responsible for writing replies to un-proxyable requests (listens internally)
  gatewayHttps501Replier = https.createServer(
    {
      key: fs.readFileSync(TLS_KEY_PATH),
      cert: fs.readFileSync(TLS_CERT_PATH),
      ca: readCA(),
      honorCipherOrder: true
    },
    (req, res) => {
      logger.debug('gatewayHttpsReplier: 501', {
        host: req.headers.host,
        url: req.url,
        method: req.method,
        message: this.nextReplierMessage
      })
      res.writeHead(501, 'KUBESAIL-GATEWAY')
      res.end(this.nextReplierMessage || 'KubeSail gateway 501')
    }
  )
  gatewayHttps503Replier = https.createServer(
    {
      key: fs.readFileSync(TLS_KEY_PATH),
      cert: fs.readFileSync(TLS_CERT_PATH),
      ca: readCA(),
      honorCipherOrder: true
    },
    (req, res) => {
      logger.debug('gatewayHttpsReplier: 503', {
        host: req.headers.host,
        url: req.url,
        method: req.method,
        message: this.nextReplierMessage
      })
      res.writeHead(503, 'KUBESAIL-GATEWAY')
      res.end(this.nextReplierMessage || 'KubeSail gateway 503')
    }
  )

  // Gateway server (express) responds to configuration requests from the KubeSail API
  gatewayServer = require('./gatewayServer').call(this)

  // HTTPS Wrapper around Gateway express server
  gatewayHTTPSServer = https.createServer(
    {
      key: fs.readFileSync(TLS_KEY_PATH),
      cert: fs.readFileSync(TLS_CERT_PATH),
      ca: readCA(),
      honorCipherOrder: true
    },
    this.gatewayServer
  )

  // SocketIO server, sharing port with Gateway Server
  agentRegistrationSocketServer = socketIO(this.gatewayHTTPSServer)

  constructor() {
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

  writeHeader(
    socket /*: net.Socket */,
    data /*: Buffer */,
    code /*: number */,
    protocol /*: string */ = 'http',
    message /*: string */
  ) {
    const portMap = {
      501: INTERNAL_HTTPS_RESPONDER_PORT_501,
      503: INTERNAL_HTTPS_RESPONDER_PORT_503
    }
    if (protocol === 'http') {
      socket.end(`HTTP/1.1 ${code} ${message}\n\n`)
    } else {
      this.nextReplierMessage = message
      const tunnelToResponder = new net.Socket()
      tunnelToResponder.connect(portMap[code] || portMap['503'], '127.0.0.1')
      tunnelToResponder.write(data)
      tunnelToResponder.pipe(socket).pipe(tunnelToResponder)
      socket.on('close', () => tunnelToResponder.end())
      tunnelToResponder.on('close', () => socket.end())
      tunnelToResponder.on('error', err => {
        logger.error('writeHeader: Unexpected error on forwarding socket', {
          errMsg: err.message,
          code: err.code
        })
        socket.end()
      })
    }
  }

  // Configures an agent to receive traffic
  // Rebroadcasts to other gateways with the agents configuration
  async addAgentSocketMapping(
    options /*: { agentKey: string|void, clusterAddress: string, socket: Socket|void, gateway: void|string, firewall: Object, email: string, refreshCredentials: boolean|void } */
  ) {
    const { agentKey, gateway, firewall = {}, email, refreshCredentials = false } = options
    let { socket, clusterAddress } = options
    const existingRaw = await this.redis.get(`hm|${agentKey}`)
    const existingData = existingRaw ? JSON.parse(existingRaw) : {}
    const saveData /*: Object */ = Object.assign({}, existingData, options)
    delete saveData.socket

    ALWAYS_VALID_DOMAINS.forEach(d => (firewall[d] = 1))
    if (!clusterAddress) clusterAddress = existingData.clusterAddress
    if (!clusterAddress) {
      logger.error(
        'addAgentSocketMapping unable to update addAgentSocketMapping without a clusterAddress!',
        { options, agentKey }
      )
      return
    }
    // If there is no rule for the cluster's Kubernetes API, we'll add `1` here, which means "kubesail.com only"
    if (!firewall[clusterAddress]) firewall[clusterAddress] = 1
    if (!socket && this.socketMap[agentKey]) socket = this.socketMap[agentKey]
    if (socket) socket.__clusterAddress = clusterAddress

    logger.silly('addAgentSocketMapping', {
      agentKey,
      clusterAddress,
      gateway,
      firewall,
      socket: !!socket
    })
    if (socket) {
      if (!gateway) saveData.gateway = GATEWAY_INTERNAL_ADDRESS
      saveData.remoteAddr = socket.handshake.address.split(':').pop()
    }
    const json = JSON.stringify(saveData)
    await this.redis.set(`akhm|${agentKey}`, json)
    const alreadyWrittenToRedis = json !== existingRaw

    if (!alreadyWrittenToRedis) await this.redis.publish('add-agent', json)

    for (const host in firewall) {
      this.hostMap.set(host, saveData)
      await this.redis.set(`hm|${host}`, json)
    }

    // TODO: Remove this, this is for legacy agents!
    saveData.domains = firewall
    logger.debug('addAgentSocketMapping', { saveData })
    try {
      if (socket)
        socket.emit('agent-data', { ...saveData, gateway: undefined, email, refreshCredentials })
    } catch (err) {
      logger.error('addAgentSocketMapping: failed to emit agent-data', {
        agentKey,
        errMsg: err.message,
        code: err.code,
        stack: err.stack
      })
    }
  }

  async removeAgentSocket(agentKey /*: string */) {
    await this.redis.del(`akhm|${agentKey}`)
    if (this.socketMap[agentKey]) {
      logger.info('removeAgentSocket:', { agentKey, hasSocketMapping: !!this.socketMap[agentKey] })
      for (const host in this.socketMap[agentKey].firewall) {
        this.hostMap.del(host)
        await this.redis.del(`hm|${host}`)
      }
      delete this.socketMap[agentKey]
    } else {
      await this.redis.publish('remove-agent', JSON.stringify({ agentKey }))
    }
  }

  // Takes a hostname as a string, returns "hostData",
  // which is the stored firewall/socket for a destination agent
  async getAgentSocketStatus(hostname /*: string */) /*: false|Object */ {
    let result = await this.readAgentSocketStatus(hostname)
    if (!result) {
      // Wildcard support
      const hostNameParts = hostname.split('.') // ['foo', 'bar', 'com']
      while (hostNameParts.shift() && !result) {
        if (hostNameParts.length < 2) break
        if (hostname.endsWith('k8g8.com') && hostNameParts.length < 4) break
        hostname = ['*', ...hostNameParts].join('.')
        result = await this.readAgentSocketStatus(hostname) // *.bar.com
      }
    }
    if (!result) {
      logger.silly('Unable to determine socket status!', { hostname })
      return { hostname }
    }
    return { result, hostname }
  }

  async readAgentSocketStatus(host /*: string */) /*: false|Object */ {
    let hostData = this.hostMap.get(host)
    if (!hostData) {
      const fromDb = await this.redis.get(`hm|${host}`)
      if (fromDb) {
        hostData = JSON.parse(fromDb)
        this.hostMap.set(host, hostData)
      } else {
        logger.silly('getAgentSocketStatus: returned false', { host })
        return false
      }
    }
    if (hostData.agentKey && this.socketMap[hostData.agentKey]) {
      return { ...hostData, socket: this.socketMap[hostData.agentKey] }
    }
    return hostData
  }

  messageAgent = async (agentKey /*: string */, key /*: string */, value /*: any */) => {
    if (this.socketMap[agentKey]) {
      logger.debug('messageAgent Emitting message to agent:', { agentKey, key, value })
      try {
        this.socketMap[agentKey].emit(key, value)
      } catch (err) {
        logger.error('messageAgent: Failed to emit to agent socket!', {
          errMsg: err.message,
          code: err.code,
          stack: err.stack
        })
      }
    } else {
      logger.silly('messageAgent publishing to redis:', { agentKey, key, value })
      this.redis.publish(agentKey, JSON.stringify({ key, value }))
    }
  }

  agentSocketConnectionHandler = async (
    socket /*: Socket */
  ) /*: false|{ validDomains: Array<string>, clusterAddress: string } */ => {
    const agentKey = socket.handshake.query.key
    const agentSecret = socket.handshake.query.secret
    const username = socket.handshake.query.username
    const initialID = socket.handshake.query.initialID || ''
    const initVersion = socket.handshake.query.initVersion || ''

    socket.on('disconnect', async reason => {
      if (this.socketMap[agentKey] && !this.socketMap[agentKey].connected) {
        logger.debug('Agent disconnected!', { reason, agentKey })
        this.removeAgentSocket(agentKey)
        kubesailApiRequest({
          method: 'PUT',
          path: '/agent/disconnect',
          data: { agentKey, agentSecret, gatewaySecret: KUBESAIL_API_SECRET }
        }).catch(err => {
          logger.error('Failed to post /agent/disconnect', {
            agentKey,
            disconnectReason: reason,
            errMsg: err.message
          })
        })
      } else {
        logger.silly(
          'Agent disconnect event fired but agent is still connected (quick reconnect)',
          { reason, agentKey }
        )
      }
    })

    socket.on('error', function (err) {
      logger.error('agentSocketConnectionHandler() socket error', { agentKey, errMsg: err.message })
    })

    socket.on('config-response', async ({ kubeConfig, assertUsers }) => {
      logger.debug('Received config-response. POSTing to API.', { agentKey })
      try {
        await kubesailApiRequest({
          method: 'POST',
          path: '/agent/config',
          data: {
            agentKey,
            agentSecret,
            gatewaySecret: KUBESAIL_API_SECRET,
            kubeConfig,
            assertUsers
          }
        })
      } catch (err) {
        logger.error('Failed to post /agent/config (config-response)', { agentKey })
        this.removeAgentSocket(agentKey)
        socket.disconnect()
      }
    })

    socket.on('health-check', async (data = {}) => {
      const socketMapData = this.socketMap[agentKey]
      if (!socketMapData) {
        logger.warn(
          'Received health-check for socket that we did not have a socket-mapping for! Disconnecting!',
          { agentKey }
        )
        this.removeAgentSocket(agentKey)
        return socket.disconnect()
      }

      await this.redis.setex(
        'healthcheck|' + agentKey,
        180,
        JSON.stringify({
          lastCheckIn: Date.now().toString(),
          ...data
        })
      )

      try {
        await kubesailApiRequest({
          method: 'POST',
          path: '/agent/config',
          data: {
            agentKey,
            agentSecret,
            gatewaySecret: KUBESAIL_API_SECRET,
            ...data
          }
        })
      } catch (err) {
        logger.error('Failed to post /agent/config (health-check)', {
          agentKey,
          errMsg: err.message,
          stack: err.stack
        })
        this.removeAgentSocket(agentKey)
        return socket.disconnect()
      }
    })

    const init = async (data = {}) => {
      let status
      let json = {}
      try {
        const resp = await kubesailApiRequest({
          method: 'POST',
          path: '/agent/register',
          data: {
            username,
            agentKey,
            agentSecret,
            gatewaySecret: KUBESAIL_API_SECRET,
            gatewayAddress: GATEWAY_ADDRESS,
            initialID,
            config: data.kubeConfig
          }
        })
        status = resp.status
        json = resp.json || {}
      } catch (err) {
        logger.error('Failing to post /agent/register to kube api!', {
          agentKey,
          KUBESAIL_API_TARGET,
          errMsg: err.message,
          stack: err.stack
        })
        return socket.disconnect()
      }

      let { clusterAddress, firewall, email } = json
      if (!firewall) firewall = {}

      if (status === 200) {
        // AGENT_REGISTER_VALID
        socket.clusterAddress = clusterAddress
        this.socketMap[agentKey] = socket
        logger.info('Agent registered! Sending configuration', {
          agentKey,
          clusterAddress,
          firewall
        })
        await this.addAgentSocketMapping({
          agentKey,
          socket,
          clusterAddress,
          firewall,
          email,
          refreshCredentials: true
        })
      } else if (status === 202) {
        // AGENT_REGISTER_PENDING
        const { clusterAddress } = json
        logger.info('New agent pending', { agentKey })
        socket.clusterAddress = clusterAddress
        this.socketMap[agentKey] = socket
      } else if (status >= 400 && status < 500) {
        logger.info('Disconnected agent due to rejected agentSocketConnectionHandler reply', {
          agentKey,
          status
        })
        socket.emit('register-rejected', status, () => {
          this.removeAgentSocket(agentKey)
          return socket.disconnect()
        })
      } else {
        logger.warn('Disconnected agent due to errored agentSocketConnectionHandler reply', {
          agentKey,
          status
        })
        this.removeAgentSocket(agentKey)
        return socket.disconnect()
      }
    }
    if (initVersion === '2') {
      socket.on('init', data => init(data))
    } else {
      init()
    }
  }

  async proxyToGateway(
    host /*: string */,
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
          .on('error', proxyServerErrorHandler(socket, 'socketPipeErr SOCKET_CONNECTED_ELSEWHERE'))
          .pipe(proxySocket)
          .on('error', proxyServerErrorHandler(proxySocket, 'streamErr SOCKET_CONNECTED_ELSEWHERE'))
      }
    )
    socket.on('close', () => {
      try {
        proxySocket.end()
      } catch (err) {
        logger.error('proxyToGateway: failed to close proxySocket on socket close', {
          host,
          agentKey: hostData.agentKey
        })
      }
    })
    proxySocket.on('close', () => {
      try {
        socket.end()
      } catch (err) {
        logger.error('proxyToGateway: failed to close socket on proxySocket close', {
          host,
          agentKey: hostData.agentKey
        })
      }
    })
    socket.on('error', proxyServerErrorHandler(socket, 'socket SOCKET_CONNECTED_ELSEWHERE'))
    proxySocket.on('error', async err => {
      if (err.code === 'ETIMEDOUT') {
        logger.info('proxySocket ETIMEDOUT', { host, agentKey: hostData.agentKey })
        socket.end()
        await this.messageAgent(hostData.agentKey, 'health-check')
        setTimeout(async () => {
          const checkin = await this.redis.get('healthcheck|' + hostData.agentKey)
          if (!checkin) {
            logger.info(
              'ETIMEDOUT Handler: Agent is not responding to health-checks, cleaning up agent-data and host-data!',
              { host, agentKey: hostData.agentKey }
            )
            this.hostMap.del(host)
            await this.removeAgentSocket(hostData.agentKey)
            await this.redis.del(`hm|${host}`)
          } else {
            logger.error(
              'ETIMEDOUT Handler: Got TIMEOUT but agent is responding to health checks?',
              { host, agentKey: hostData.agentKey }
            )
          }
        }, 5000)
      } else {
        proxyServerErrorHandler(socket, 'proxySocket SOCKET_CONNECTED_ELSEWHERE')(err)
      }
    })
  }

  async proxyLocalSocket(
    hostData /*: Object */,
    protocol /*: string */,
    host /*: string */,
    socket /*: Socket */,
    remoteAddr /*: string */,
    data /*: any */
  ) {
    const stream = socketIoStream.createStream({ allowHalfOpen: false })

    try {
      socketIoStream(hostData.socket).emit(protocol, stream, { host })
    } catch (err) {
      logger.error('proxyLocalSocket: socketIoStream failed!', {
        agentKey: hostData.agentKey,
        errMsg: err.message,
        remoteAddr
      })
      socket.end()
      stream.end()
      return
    }

    // Cleanup when we're done!
    socket.on('close', async () => {
      stream.end()
      bandwidthRecv.inc({ agentKey: hostData.agentKey }, socket.bytesWritten)
      bandwidthSent.inc({ agentKey: hostData.agentKey }, socket.bytesRead)
    })

    stream.on('close', () => socket.end())
    stream.on('error', proxyServerErrorHandler(stream, 'streamErr'))

    // Write the initial data in this chunk
    try {
      stream.write(data)
    } catch (err) {
      logger.error(
        'proxyLocalSocket: SOCKET_CONNECTED_HERE Failed to write initial HELO down agent-socket-stream',
        { agentKey: hostData.agentKey, errMsg: err.message }
      )
      this.writeHeader(socket, data, 503, protocol, 'KS_GATEWAY_AGENT_ERROR')
      stream.end()
      return
    }

    // Setup bi-directional pipe
    socket
      .pipe(stream)
      .on('error', proxyServerErrorHandler(stream, 'streamPipeErr SOCKET_CONNECTED_HERE'))
      .pipe(socket)
      .on('error', proxyServerErrorHandler(socket, 'socketPipeErr SOCKET_CONNECTED_HERE'))
  }

  async handleStream(protocol /*: string */, socket /*: Socket */, data /*: any */) {
    // Note that this implies we do not support being behind a proxy
    // TODO: Parse PROXY PROTOCOL V2 and support that
    const remoteAddr = socket.remoteAddress.substring(
      socket.remoteAddress.lastIndexOf(':') + 1,
      socket.remoteAddress.length
    )

    if (!isIP(remoteAddr)) {
      logger.warn('Got IPV6 request! Returning 501', { protocol, host })
      return this.writeHeader(socket, data, 501, protocol, 'KS_GATEWAY_UNSUPPORTED_PROTOCOL')
    }

    let host
    if (protocol === 'http') {
      const headers = httpHeaders(data)
      host = headers && headers.headers ? (headers.headers.host || '').split(':')[0] : ''
    } else if (protocol === 'https') {
      const sniHost = sni(data) || ''
      host = sniHost.split(':')[0] || ''
    }

    // If we receive a request that is pointed at _us_, forward it to the gateway-agent service
    if (host && (host === GATEWAY_ADDRESS || host === 'kubesail-gateway')) {
      logger.silly('Forwarding request from ingress server to gateway-agent server', { host })
      const tunnelToResponder = new net.Socket()
      tunnelToResponder.connect(GATEWAY_AGENT_LISTEN_PORT, '127.0.0.1')
      tunnelToResponder.write(data)
      tunnelToResponder.pipe(socket).pipe(tunnelToResponder)
      tunnelToResponder.on('error', err => {
        logger.error('handleStream: Error forwarding request to gateway-agent server', {
          errMsg: err.message,
          code: err.code
        })
        socket.end()
      })
      return
    }

    // FQDN means we don't support being accessed with an IP Address (DNS only!)
    if (!host || !isFQDN(host)) {
      logger.debug('handleStream: Received request with invalid host header or SNI header', {
        protocol,
        host,
        GATEWAY_ADDRESS
      })
      return this.writeHeader(socket, data, 501, protocol, 'KS_GATEWAY_NO_HOST')
    }

    const { result, hostname } = await this.getAgentSocketStatus(host)

    if (!result) {
      logger.silly('handleStream: no result from getAgentSocketStatus', { host })
      return this.writeHeader(socket, data, 503, protocol, 'KS_GATEWAY_NO_AGENT_CONNECTED')
    }

    if (!result.firewall || !result.firewall[host]) {
      logger.error('proxyLocalSocket: Received request for host it does not have!', {
        host,
        agentKey: result.agentKey
      })
      socket.end()
      return
    }
    let firewall = result.firewall[host]
    const effectiveFirewall = (firewall && typeof firewall === 'string' ? firewall : '')
      .split(',')
      .concat(KUBESAIL_FIREWALL_WHITELIST)
      .map(f =>
        f === 'local'
          ? [
              '10.0.0.0/8',
              '172.16.0.0/12',
              '192.168.0.0/16',
              result.remoteAddr ? `${result.remoteAddr}/32` : null
            ]
          : f.trim()
      )
      .flat()
      .filter(f => f && typeof f === 'string' && isIPRange(f))

    const debugInfo = {
      host,
      effectiveFirewall,
      agentKey: result.agentKey,
      KUBESAIL_FIREWALL_WHITELIST,
      remoteAddr,
      socketRemoteAddr: result.remoteAddr,
      firewallItem: result.firewall[host]
    }
    try {
      const matcher = new CIDRMatcher(effectiveFirewall)
      if (!matcher.contains(remoteAddr)) {
        logger.debug('Firewall REJECT!', debugInfo)
        return this.writeHeader(socket, data, 501, protocol, 'KS_GATEWAY_REJECTED')
      }
    } catch (err) {
      logger.error('Failed to construct or test CIDRMatcher. Debug info: ', {
        errMsg: err.message,
        code: err.code,
        stack: err.stack,
        ...debugInfo
      })
      return this.writeHeader(socket, data, 501, protocol, 'KS_GATEWAY_INTERNAL_ERROR')
    }

    if (result.socket) {
      logger.silly('ACCEPT, proxyLocalSocket', debugInfo)
      return this.proxyLocalSocket(result, protocol, hostname, socket, remoteAddr, data)
    } else if (result.gateway && result.gateway !== GATEWAY_INTERNAL_ADDRESS) {
      logger.silly('ACCEPT, proxyToGateway', { gateway: result.gateway, ...debugInfo })
      return this.proxyToGateway(host, result, protocol, socket, data)
    } else {
      logger.warn('handleStream: unknown status from getAgentSocketStatus, disconnecting', {
        host,
        result,
        GATEWAY_INTERNAL_ADDRESS,
        agentKey: result.agentKey
      })
      this.hostMap.del(hostname)
      if (result.agentKey) await this.removeAgentSocket(result.agentKey)
      await this.redis.del(`hm|${hostname}`)
      return this.writeHeader(socket, data, 503, protocol, 'KS_GATEWAY_NO_AGENT_CONNECTED_CLEANUP')
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
        logger.silly('Emitting message to socket:', { key: data.key, value: data.value })
        try {
          this.socketMap[channel].emit(data.key, data.value)
        } catch (err) {
          logger.error('Failed to emit message to socket after redis sub message', {
            key: data.key,
            value: data.value,
            errMsg: err.message,
            code: err.code,
            stack: err.stack
          })
        }
      }
    })
    this.redisSub.subscribe('agents')
    process.once('SIGINT', this.interrupt)

    this.agentRegistrationSocketServer.on('connection', this.agentSocketConnectionHandler)
    this.gatewayHttps503Replier.listen(INTERNAL_HTTPS_RESPONDER_PORT_503, '127.0.0.1', () => {
      this.gatewayHttps501Replier.listen(INTERNAL_HTTPS_RESPONDER_PORT_501, '127.0.0.1', () => {
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
                GATEWAY_ADDRESS,
                GATEWAY_INTERNAL_ADDRESS,
                NODE_ENV: process.env.NODE_ENV,
                RELEASE
              })
            })
          })
        })
      })
    })
  }
}
