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
const gatewayVersion = fs
  .readFileSync('/home/node/app/' + require('../../package.json').version)
  .toString()
  .replace('\n', '')
const logger = require('../shared/logger')
const { initProm, bandwidthRecv, bandwidthSent } = require('../shared/prom')
const redis = require('./redis')
const { writeHeader, kubesailApiRequest } = require('../shared')
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
  KUBESAIL_API_SECRET,
  KUBESAIL_FIREWALL_WHITELIST
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

module.exports = class Gateway {
  // A list of hostname to array of sockets, or a gateway address
  // Structured like:
  // { "hostname.com": { socketId: string, gateway: string, firewall: string } }
  // Only one of socketId or gateway will be set
  // SocketId are 20 characters
  // gateway is a URI, eg: a-dev-cluster.erulabs.kubesail-gateway.default.svc.cluster.local (lets say a very high estimate is 50 characters)
  // firewall is a comma delineated list of CIDR masks, no longer than 64 characters
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
      const headers = httpHeaders(data)
      const host = headers && headers.headers ? (headers.headers.host || '').split(':')[0] : ''
      this.handleStream('http', host, socket, data)
    })
    socket.on('error', proxyServerErrorHandler(socket, 'http'))
  })

  // Responsible for proxying TLS requests (based on SNI header)
  httpsProxyServer = net.createServer(socket => {
    socket.once('data', async data => {
      const sniHost = sni(data) || ''
      const host = sniHost.split(':')[0] || ''
      this.handleStream('https', host, socket, data)
    })
    socket.on('error', proxyServerErrorHandler(socket, 'https'))
  })

  // Responsible for writing replies to un-proxyable requests (listens internally)
  gatewayHttpsReplier = https.createServer(
    {
      key: fs.readFileSync(TLS_KEY_PATH),
      cert: fs.readFileSync(TLS_CERT_PATH),
      ca: this.ca,
      honorCipherOrder: true
    },
    (req, res) => {
      logger.debug('gatewayHttpsReplier', {
        host: req.headers.host,
        url: req.url,
        method: req.method,
        hostMap: this.hostMap.keys()
      })
      res.writeHead(503, 'KUBESAIL-GATEWAY')
      res.end('KubeSail gateway 503')
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

  // Configures an agent to receive traffic
  // Rebroadcasts to other gateways with the agents configuration
  async addAgentSocketMapping(
    options /*: { agentKey: string|void, clusterAddress: string, socket: Socket|void, gateway: void|string, firewall: Object, email: string } */
  ) {
    const { agentKey, gateway, firewall = {}, email } = options
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
    firewall[clusterAddress] = 1
    if (!socket && this.socketMap[agentKey]) socket = this.socketMap[agentKey]
    if (socket) socket.__clusterAddress = clusterAddress

    logger.silly('addAgentSocketMapping', {
      agentKey,
      clusterAddress,
      gateway,
      firewall,
      socket: !!socket
    })
    if (socket && !gateway) {
      saveData.gateway = GATEWAY_INTERNAL_ADDRESS
    }
    const json = JSON.stringify(saveData)
    await this.redis.set(`akhm|${agentKey}`, json)
    const alreadyWrittenToRedis = json !== existingRaw

    if (!alreadyWrittenToRedis) {
      await this.redis.publish('add-agent', JSON.stringify(saveData))
    }

    logger.silly('addAgentSocketMapping', { firewall })
    for (const host in firewall) {
      this.hostMap.set(host, saveData)
      await this.redis.set(`hm|${host}`, json)
    }

    // TODO: Remove this, this is for legacy agents!
    saveData.domains = firewall
    try {
      if (socket) socket.emit('agent-data', { ...saveData, gateway: undefined, email })
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
      logger.debug('Unable to determine socket status!', { hostname })
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

    socket.on('disconnect', async reason => {
      if (this.socketMap[agentKey] && !this.socketMap[agentKey].connected) {
        logger.debug('Agent disconnected!', { reason, agentKey })
        this.removeAgentSocket(agentKey)
        kubesailApiRequest({
          method: 'PUT',
          path: '/agent/disconnect',
          data: {
            agentKey,
            agentSecret,
            gatewaySecret: KUBESAIL_API_SECRET
          }
        }).catch(err => {
          logger.error('Failed to post /agent/disconnect', {
            agentKey,
            disconnectReason: reason,
            errMsg: err.message
          })
        })
      } else {
        logger.debug(
          'Agent disconnect event fired but agent is still connected (quick reconnect)',
          { reason, agentKey }
        )
      }
    })

    socket.on('error', function (err) {
      logger.error('agentSocketConnectionHandler() socket error', { agentKey, errMsg: err.message })
    })

    socket.on('config-response', async ({ kubeConfig }) => {
      logger.debug('Received config-response. POSTing to API.', { agentKey })
      try {
        await kubesailApiRequest({
          method: 'POST',
          path: '/agent/config',
          data: {
            agentKey,
            agentSecret,
            gatewaySecret: KUBESAIL_API_SECRET,
            kubeConfig
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
      const hasHostMapping = this.hostMap.get(socketMapData.clusterAddress)
      logger.silly('Received health-check!', { agentKey, hasHostMapping, ...data })

      await this.redis.setex(
        'healthcheck|' + agentKey,
        180,
        JSON.stringify({
          lastCheckIn: Date.now().toString(),
          ...data
        })
      )
      if (!data.automated && hasHostMapping) {
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
      }
    })

    let status
    let json

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
          initialID
        }
      })
      status = resp.status
      json = resp.json
    } catch (err) {
      logger.error('Failing to post /agent/register to kube api!', {
        agentKey,
        errMsg: err.message,
        stack: err.stack
      })
    }

    if (status === 200) {
      // AGENT_REGISTER_VALID
      let { clusterAddress, firewall, email } = json
      if (!firewall) firewall = {}
      socket.clusterAddress = clusterAddress
      this.socketMap[agentKey] = socket
      logger.info('Agent registered! Sending configuration', { agentKey, clusterAddress, firewall })
      await this.addAgentSocketMapping({
        agentKey,
        socket,
        clusterAddress,
        firewall,
        email
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
        logger.error('handleStream() failed to close proxySocket on socket close', {
          host,
          agentKey: hostData.agentKey
        })
      }
    })
    proxySocket.on('close', () => {
      try {
        socket.end()
      } catch (err) {
        logger.error('handleStream() failed to close socket on proxySocket close', {
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
    ipv4 /*: string */,
    data /*: any */
  ) {
    if (!hostData.firewall || !hostData.firewall[host]) {
      logger.error('proxyLocalSocket() Received request for host it does not have!', {
        host,
        agentKey: hostData.agentKey
      })
      socket.end()
      return
    }

    let firewall = hostData.firewall[host]
    if (typeof firewall === 'number') firewall = ''
    const matcher = new CIDRMatcher(
      (firewall || '').split(',').concat(KUBESAIL_FIREWALL_WHITELIST).filter(Boolean)
    )

    if (!matcher.contains(ipv4)) {
      logger.debug('Firewall REJECT!', {
        host,
        firewall,
        agentKey: hostData.agentKey,
        KUBESAIL_FIREWALL_WHITELIST,
        ipv4
      })
      return writeHeader(socket, data, 501, protocol, 'KS_GATEWAY_REJECTED')
    }

    const stream = socketIoStream.createStream({ allowHalfOpen: true })

    try {
      socketIoStream(hostData.socket).emit(protocol, stream, { host })
    } catch (err) {
      logger.error('proxyLocalSocket: socketIoStream failed!', {
        agentKey: hostData.agentKey,
        errMsg: err.message,
        ipv4
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
        'proxyLocalSocket(SOCKET_CONNECTED_HERE) Failed to write initial HELO down agent-socket-stream',
        { agentKey: hostData.agentKey, errMsg: err.message }
      )
      writeHeader(socket, data, 503, protocol, 'KS_GATEWAY_AGENT_ERROR')
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

  async handleStream(
    protocol /*: string */,
    host /*: string */,
    socket /*: Socket */,
    data /*: any */
  ) {
    // FQDN means we don't support being accessed with an IP Address (DNS only!)
    if (!host || !isFQDN(host)) {
      logger.debug('Received request with invalid host header or SNI header', { protocol, host })
      return writeHeader(socket, data, 501, protocol, 'KS_GATEWAY_NO_HOST')
    }

    const address = socket.remoteAddress
    const ipv4 = address.substring(address.lastIndexOf(':') + 1, address.length)

    if (!isIP(ipv4)) {
      logger.warn('Got IPV6 request! Returning 501', { protocol, host })
      return writeHeader(socket, data, 501, protocol, 'KS_GATEWAY_UNSUPPORTED_PROTOCOL')
    }

    const { result, hostname } = await this.getAgentSocketStatus(host)

    if (!result) {
      logger.debug('handleStream no result from getAgentSocketStatus', { host })
      writeHeader(socket, data, 502, protocol, 'KS_GATEWAY_NO_AGENT_CONNECTED')
    } else if (result.socket) {
      this.proxyLocalSocket(result, protocol, hostname, socket, ipv4, data)
    } else if (result.gateway && result.gateway !== GATEWAY_INTERNAL_ADDRESS) {
      this.proxyToGateway(host, result, protocol, socket, data)
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
      writeHeader(socket, data, 502, protocol, 'KS_GATEWAY_NO_AGENT_CONNECTED_CLEANUP')
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
    this.gatewayHttpsReplier.listen(INTERNAL_HTTPS_RESPONDER_PORT, '127.0.0.1', () => {
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
