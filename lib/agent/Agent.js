/*!
 * KubeSail Agent
 * Copyright(c) 2019-2022 KubeSail inc
 * MIT Licensed
 */

// KubeSail Agent and Ingress Controller
// See https://kubesail.com for more
// Works with any Kubernetes cluster -- don't have one? Buy one at https://pibox.io/ to support this project!

const fs = require('fs')
const dns = require('dns')
const net = require('net')
const tls = require('tls')
const url = require('url')
const path = require('path')
const http = require('http')
const https = require('https')
const { X509Certificate } = require('crypto')
const http2 = require('node:http2')
const { promisify } = require('util')
const { readFile } = require('fs/promises')
const { nanoid } = require('nanoid')
const { toASCII } = require('punycode/')
const _ = require('lodash')
const LRU = require('lru-cache')
const dbus = require('dbus-next')
const bcrypt = require('bcryptjs')
const { fetch } = require('fetch-h2')
const safeTimers = require('safe-timers')
const socketio = require('socket.io-client')
const { isIP, isFQDN } = require('validator')
const { Client } = require('kubernetes-client')
const socketioStream = require('@sap_oss/node-socketio-stream')
const http2Proxy = require('./http2Proxy')
const logger = require('../shared/logger')
const { initProm } = require('../shared/prom')
const { sampleArray, setPTimeout } = require('../shared')
const {
  KUBESAIL_AGENT_GATEWAY_TARGET,
  KUBESAIL_AGENT_GATEWAY_PORT,
  KUBESAIL_AGENT_INITIAL_ID,
  KUBESAIL_AGENT_USERNAME,
  KUBESAIL_AGENT_KEY,
  KUBESAIL_AGENT_EMAIL,
  KUBESAIL_AGENT_SECRET,
  KUBESAIL_AGENT_INGRESS_CONTROLLER_PORT,
  KUBESAIL_AGENT_INGRESS_CONTROLLER_HTTP_PORT,
  KUBESAIL_API_TARGET,
  ADDITIONAL_CLUSTER_HOSTNAMES,
  TLS_KEY_PATH,
  TLS_CERT_PATH,
  LOG_LEVEL,
  DOCUMENTS_TO_WATCH,
  KUBERNETES_SPEC_VERSION,
  NODE_NAME,
  POD_NAMESPACE,
  RELEASE,
  KUBESAIL_WWW_TARGET
} = require('../shared/config')
const crawlerUserAgents = require('../crawler-user-agents.json')

class KubesailAgent {
  // An array of Kubernetes documents
  docs = []

  // Features are flags that we use to inform the dashboard and KubeSail API about what we do and don't support
  features = {
    // metrics: boolean: set to true if we detect metrics-server is installed
    // required for some metrics, graphs, various panels in KubeSail dashboard
    metrics: false,
    // k8g8Cert: false or string: set to either false if no k8g8 wildcard certificate has been installed
    // Or set to the expiration time of the certificate (if a renewal is required)
    k8g8Cert: false,
    // mDNS: set to true if we're able to write to DBUS and have AVAHI installed
    // mDNS addresses are domain names like "pibox.local"
    mDNS: false,
    // Deactivated if we can't get a dbus socket
    dbus: true,
    // hostPortHTTP: Set to true if the kubesail-agent is able to expose this nodes port 80 and 443 directly
    hostPortHTTP: false
  }

  // A mutable blob representing some data about this particular instance of the Agent
  status = {
    startupTime: Date.now(),
    // Required: KubeSail agent key - the primary identifier
    agentKey: KUBESAIL_AGENT_KEY,
    // optional, email address of the user who installed this agent (only used in certain installation methods)
    userEmail: KUBESAIL_AGENT_EMAIL,
    // Which gateways should we talk to (note these can be hosts or IP addresses, as we'll use certificate pinning either way)
    gatewayTargets: [KUBESAIL_AGENT_GATEWAY_TARGET],
    // Marked as true if we have an open socket connection to a gateway
    connected: false,
    // Marked as true if registered and attached to KubeSail.com
    registered: false,
    // Internet IP address as seen from the kubesail api - this is where DDNS will point at!
    publicIP: null,
    // LAN IP address of the node that this agent is located on
    privateIP: process.env.HOST_LAN_ADDRESS || process.env.NODE_IP,
    // FQDN of this cluster - this address always targets the Kubernetes API directly
    clusterAddress: null,
    // Marked as true if registration failed
    registerRejected: false,
    // Used to track the last seen Kubernetes resource
    k8sResourceVersion: null
  }

  // Domains the gateway will be forwarding to us (and its firewall configuration)
  // firewall a hash of hostnames and a comma delineated list of CIDR masks
  firewall = {
    // 'hostname.com': '0.0.0.0/0,1.1.1.1/32'
  }

  // Used for kubesail agent auth proxy
  authMap = new LRU({ max: 100 })

  // Tracks users currently requests events from namespaces
  usersWatchingEvents = []

  // Remote address tracking (used to relay real-remote-IP information through sockets)
  remoteAddressTracking = {}

  // We use a fairly complex DNS stack here because it's *very* possible
  // that DNS does not work properly in the Kubernetes cluster we live in
  dns = {
    // Marked as true if we're using our own DNS providers instead of the clusters
    usingFallback: false,
    resolver: new dns.Resolver(),
    resolve4: null,
    // Determines if we need to use a fallback DNS server or if our assigned DNS service works properly
    setResolver: async () => {
      if (!this.dns.resolve4) {
        this.dns.resolve4 = promisify(this.dns.resolver.resolve4).bind(this.dns.resolver)
      }
      let resolved
      try {
        if (!isFQDN(KUBESAIL_AGENT_GATEWAY_TARGET)) {
          logger.debug('Skipping setResolver: KUBESAIL_AGENT_GATEWAY_TARGET is not an FQDN', {
            KUBESAIL_AGENT_GATEWAY_TARGET
          })
          return
        }
        const newResolver = new dns.Resolver()
        const resolve4 = promisify(newResolver.resolve4).bind(newResolver)
        resolved = await resolve4(KUBESAIL_AGENT_GATEWAY_TARGET)
        if (this.dns.usingFallback && resolved) {
          logger.info('DNS appears to be online! Reverting resolver back to defaults. Emitting health-check.')
          this.status.gatewayTargets = resolved
          this.dns.usingFallback = false
          this.dns.resolver = newResolver
          this.dns.resolve4 = resolve4
          this.gatewaySocket.emit('health-check', this.generateHealthCheckData())
        } else {
          logger.debug('Successfully resolved DNS address for agent target:', {
            target: KUBESAIL_AGENT_GATEWAY_TARGET,
            resolved
          })
        }
      } catch (err) {
        this.dns.usingFallback = true
        this.dns.resolver.setServers([sampleArray(['1.1.1.1', '1.0.0.1', '8.8.8.8'])])
        logger.warn(
          'Unable to resolve DNS - Falling back to CloudFlare DNS as backup! Please check your cluster for DNS capabilities! Trying again in 10 seconds',
          { errMsg: err.message, errCode: err.code }
        )
        setTimeout(() => this.dns.setResolver(), 10000)
      }
    },
    // Used by https requests (see kubesailApiRequest) to overload their built-in DNS resolver
    lookup: (hostname, _opts, cb) => {
      if (isFQDN(hostname)) {
        // TODO: Catch error!
        this.dns.resolve4(hostname).then(results => {
          const host = sampleArray(results)
          cb(null, host, 4)
        })
      } else {
        dns.lookup(hostname, { all: true }, (err, results) => {
          if (err) throw err
          if (results[0]) cb(null, results[0].address, results[0].family)
          else throw new Error('Unable to resolve api DNS')
        })
      }
    }
  }

  keepAliveAgent = new http.Agent({
    keepAlive: true,
    maxSockets: 256,
    maxTotalSockets: 16384,
    maxFreeSockets: 4096
  })

  keepAliveAgentHTTPS = new https.Agent({
    keepAlive: true,
    maxSockets: 256,
    maxTotalSockets: 16384,
    maxFreeSockets: 4096
  })

  reverseProxyTLSContexts = {}

  httpServer = http.createServer((req, res) => {
    this.proxyRequestHandler('http')(req, res)
  })

  httpsServer = http2.createSecureServer({
    key: fs.readFileSync(TLS_KEY_PATH, 'utf8'),
    cert: fs.readFileSync(TLS_CERT_PATH, 'utf8'),
    allowHTTP1: true,
    agent: this.keepAliveAgentHTTPS,
    SNICallback: (domain, cb) => {
      if (this.reverseProxyTLSContexts[domain]) {
        return cb(null, this.reverseProxyTLSContexts[domain])
      } else {
        for (const d in this.reverseProxyTLSContexts) {
          if (domain.endsWith(d)) {
            return cb(null, this.reverseProxyTLSContexts[d])
          }
        }
        if (this.reverseProxyTLSContexts['*']) {
          return cb(null, this.reverseProxyTLSContexts['*'])
        }
        logger.debug('Warning, no usable TLS contexts available!', {
          contexts: Object.keys(this.reverseProxyTLSContexts),
          domain
        })
        return cb(null, null)
      }
    }
  })

  proxyRequestHandler = protocol => async (req, res) => {
    const result = await this.k8s.findServiceForRequest(req, res)
    if (result?.ip && result?.port) {
      req._ingress = result.ingress
      req._endpoint = result.endpoint

      if (protocol === 'http' && req?._ingress?.spec?.tls) {
        // Redirect HTTP to HTTPS if it's available unless ssl-redirects are disabled
        if (req._ingress?.metadata?.annotations?.['ingress.kubernetes.io/ssl-redirect'] !== 'false') {
          res.statusCode = 308
          res.setHeader('Location', 'https://' + result.host + result.path)
          return res.end()
        }
      }

      http2Proxy.web(
        req,
        res,
        {
          port: result.port,
          hostname: result.ip,
          protocol: result.protocol,
          proxyTimeout: 30000,
          onReq: this.reverseProxyRequest(result.protocol),
          onRes: this.reverseProxyResponse(result.protocol)
        },
        err => {
          if (err) {
            const debugObj = {
              errMsg: err.message,
              code: err.code,
              url: req.url,
              port: result.port,
              hostname: result.ip,
              protocol: result.protocol,
              ingressName: req._ingress?.metadata?.name,
              ingressRev: req._ingress?.metadata?.resourceVersion,
              endpointName: req._endpoint?.metadata?.name,
              endpointRev: req._endpoint?.metadata?.resourceVersion,
              stack: err.stack
            }
            if (['ECONNRESET', 'ECONNREFUSED'].includes(err.code)) {
              logger.debug('reverseProxy: backend service disconnected unexpectedly', debugObj)
              return res.end(`App says: ${err.code}`)
            } else if (['HPE_INVALID_CONSTANT'].includes(err.code)) {
              logger.warn(
                "reverseProxy: backend service returned unexpected data! Perhaps this isn't a webserver?",
                debugObj
              )
              return res.end(
                `Backend app isn't speaking HTTP - perhaps it is not a web-app? (HPE_INVALID_CONSTANT)`
              )
            } else {
              logger.warn('reverseProxy received error from backend service', debugObj)
              return res.end(`KS_PROXY_APP_ERROR: ${err.code || 'UNKNOWN'}`)
            }
          }
        }
      )
    } else if (!res.headersSent) {
      return res.end('KS_INTERNAL_ERROR_003 NO PROXY BACKEND\n\n')
    }
  }

  reverseProxyRequest = protocol => (req, options) => {
    if (this.remoteAddressTracking[req.connection.remotePort]) {
      const remoteAddr = this.remoteAddressTracking[req.connection.remotePort] + ''
      this.remoteAddressTracking[req.connection.remotePort] = null
      delete this.remoteAddressTracking[req.connection.remotePort]
      options.headers['x-forwarded-for'] = [remoteAddr, req.socket.remoteAddress].filter(Boolean).join(',')
      options.headers['x-real-ip'] = remoteAddr
    } else {
      options.headers['x-forwarded-for'] = req.socket.remoteAddress
    }
    options.headers['x-forwarded-proto'] = 'https'
    const host = req.headers.host || req.headers[':authority'].split(':')[0]
    options.headers['x-forwarded-host'] = host
    options.headers['host'] = host
    let p
    let agent
    if (protocol === 'http') {
      p = http
      agent = this.keepAliveAgent
    } else if (protocol === 'https') {
      p = https
      agent = this.keepAliveAgentHTTPS
      options.rejectUnauthorized = false
    } else throw new Error(`Invalid protocol "${protocol}" passed to reverseProxyRequest`)
    return p.request({ ...options, agent })
  }

  reverseProxyResponse = _protocol => (req, res, proxyRes) => {
    const annotations = req._ingress?.metadata?.annotations || {}
    if (annotations['kubesail.com/force-cache']) {
      const cacheable = [
        'text/css',
        'text/javascript',
        'font/woff2',
        'image/png',
        'image/jpeg',
        'image/svg+xml'
      ]
      const cc = proxyRes.headers['cache-control'] || ''
      const ct = proxyRes.headers['content-type']
      if (proxyRes.headers.etag) {
        // Static assets with an etag usually come from things like vue, nuxt and django. If they use a misconfigured cache-control header
        // We'll fix that automatically. Tandoor Recipes is a good example of this issue.
        if (
          (req.url.startsWith('/static/') || (req.url.includes('_nuxt/') && cacheable.includes(ct))) &&
          cc.includes('max-age=0')
        ) {
          proxyRes.headers['cache-control'] = 'max-age=31536000, private, stale-while-revalidate=86400'
        } else if (!cc && cacheable.includes(ct)) {
          // If we have an etag but no cache-control header
          proxyRes.headers['cache-control'] = 'max-age=86400, private, stale-while-revalidate=300'
        } else if (!cc) {
          logger.debug('Not setting cache control on asset with etag:', { url: req.url, cc, ct })
        }
      }
    }
    proxyRes.headers['x-powered-by'] = `kubesail-agent ${RELEASE}`
    res.writeHead(proxyRes.statusCode, proxyRes.headers)
    proxyRes.pipe(res)
  }

  // Websocket connection to the KubeSail Gateway
  gatewaySocket = null

  createGatewaySocket = () => {
    if (this.gatewaySocket) return this.gatewaySocket
    const connectionOptions = {}
    if (process.env.NODE_ENV === 'development') {
      connectionOptions.ca = fs.readFileSync(TLS_CERT_PATH)
      connectionOptions.insecure = true
      connectionOptions.rejectUnauthorized = false
    }

    // Allows for easier development of multiple gateways in development mode
    let gatewayPort = KUBESAIL_AGENT_GATEWAY_PORT
    let gatewayTarget = this.status.gatewayTargets[0]
    if (process.env.NODE_ENV === 'development') {
      if (gatewayTarget.endsWith('dev.k8g8.com') || gatewayTarget.endsWith('dev.kubegateway.com')) {
        gatewayTarget = 'kubesail-gateway'
        gatewayPort = '8443'
      } else if (
        gatewayTarget.endsWith('dev-two.k8g8.com') ||
        gatewayTarget.endsWith('dev-two.kubegateway.com')
      ) {
        gatewayTarget = 'kubesail-gateway-two'
        gatewayPort = '8444'
      }
    }

    const connectionString = [
      `https://${gatewayTarget}`,
      gatewayPort ? `:${gatewayPort}` : '',
      `?initVersion=2&username=${KUBESAIL_AGENT_USERNAME || ''}&key=${KUBESAIL_AGENT_KEY || ''}&secret=${
        KUBESAIL_AGENT_SECRET || ''
      }&initialID=${KUBESAIL_AGENT_INITIAL_ID || NODE_NAME || ''}`
    ]
      .filter(Boolean)
      .join('')
    if (isIP(gatewayTarget)) {
      logger.warn(
        "Note, we're using a resolved IP address to connect to KubeSail, because DNS on this cluster appears to be non-operational! It is recommended that you enable DNS and restart the agent pod.",
        { resolvedGatewayTarget: gatewayTarget, port: gatewayPort }
      )
      connectionOptions.insecure = true
      connectionOptions.rejectUnauthorized = false
    }
    logger.silly('createGatewaySocket: creating socket', { gatewayTarget, gatewayPort })
    this.gatewaySocket = socketio(connectionString, {
      autoConnect: false,
      transports: ['websocket'],
      timeout: 5000,
      ...connectionOptions
    })
  }

  async init() {
    logger.info(`kubesail-agent starting in "${LOG_LEVEL}" mode`, { version: RELEASE })
    this.httpsServer.on('request', this.proxyRequestHandler('https'))
    this.httpsServer.on('upgrade', async (req, socket, head) => {
      const result = await this.k8s.findServiceForRequest(req)
      if (!result) {
        logger.debug(
          'reverseProxy: got upgrade request, but could not find service for request. Disconnecting.',
          { headers: req?.headers }
        )
        return socket.end()
      }
      const settings = {
        hostname: result.ip,
        port: result.port,
        proxyTimeout: 30000,
        protocol: result.protocol,
        target: `http://${result.ip}:${result.port}`,
        // Allow backend certificates to be invalid
        rejectUnauthorized: false
      }
      logger.silly('Upgrading request to websocket', settings)
      http2Proxy.ws(req, socket, head, { ...head, ...settings }).catch(err => {
        const debugObj = {
          errMsg: err.message,
          code: err.code,
          url: req.url,
          port: result.port,
          hostname: result.ip,
          protocol: result.protocol,
          ingressName: req._ingress?.metadata?.name,
          ingressRev: req._ingress?.metadata?.resourceVersion,
          endpointName: req._endpoint?.metadata?.name,
          endpointRev: req._endpoint?.metadata?.resourceVersion,
          stack: err.stack
        }
        if (['ECONNRESET', 'ECONNREFUSED'].includes(err.code)) {
          logger.debug('reverseProxy: backend service websocket disconnected unexpectedly', debugObj)
          return socket.end()
        } else {
          logger.warn('reverseProxy received error from backend websocket service', debugObj)
          return socket.end()
        }
      })
    })
    this.httpsServer.on('sessionError', err => {
      logger.debug('server sessionError', { errMsg: err.message })
    })
    this.httpsServer.on('tlsClientError', (err, socket) => {
      if (err.code === 'ERR_SSL_SSLV3_ALERT_CERTIFICATE_UNKNOWN') {
        logger.debug(
          'TLS Server using incompletely verified certificate! ERR_SSL_SSLV3_ALERT_CERTIFICATE_UNKNOWN',
          { errMsg: err.message, code: err.code }
        )
        // } else if (err.code === 'ERR_SSL_TLSV1_ALERT_UNKNOWN_CA') {
        //   logger.debug('Warning, serving self-signed certificate!')
      } else {
        logger.debug('server tlsClientError', { errMsg: err.message, code: err.code })
      }
    })
    this.httpsServer.on('error', err => {
      logger.error('httpsServer: Error', { errMsg: err.message })
    })
    this.httpServer.listen(KUBESAIL_AGENT_INGRESS_CONTROLLER_HTTP_PORT, '0.0.0.0')
    this.httpsServer.listen(KUBESAIL_AGENT_INGRESS_CONTROLLER_PORT, '0.0.0.0')
    initProm()
    this.dbus.init()
    await this.dns.setResolver()
    this.createGatewaySocket()
    // Note that this does not fire initially, only when the file actually changes after-the-fact
    fs.watchFile('/var/run/secrets/kubernetes.io/serviceaccount/token', async () => {
      logger.silly('ServiceAccount Token has changed! Emitting refreshed auth to KubeSail')
      this.k8s.client = new Client({ version: KUBERNETES_SPEC_VERSION })
      if (this.status.registered) await this.emitConfigResponse()
    })
    await this.k8s.init()
    this.k8s.ensureHostPort()

    this.registerWithGateway().then(async () => {
      this.status.registered = true
      logger.info('KubeSail Agent registered and ready! KubeSail support information:', {
        clusterAddress: this.status.clusterAddress,
        agentKey: this.status.agentKey
      })
      const k8g8Cert = this.docs.find(
        s =>
          s?.kind === 'Secret' && s?.metadata?.namespace === 'kube-system' && s?.metadata?.name === 'k8g8-tls'
      )
      if (k8g8Cert) {
        await this.installCertificate('kube-system', 'k8g8-tls', this.status.clusterAddress, k8g8Cert)
      }
      await this.updateHostMap()
      this.k8s.watchResources()
      if (this.healthCheckInterval) safeTimers.clearInterval(this.healthCheckInterval)
      this.healthCheckInterval = safeTimers.setInterval(() => {
        if (this.status.connected) {
          logger.silly('Emitting periodic health-check')
          this.gatewaySocket.emit('health-check', this.generateHealthCheckData())
        }
      }, 5 * 60 * 1000)
      safeTimers.setTimeout(() => {
        if (this.status.connected) {
          logger.silly('Emitting initial delayed health-check')
          this.gatewaySocket.emit('health-check', this.generateHealthCheckData())
        }
      }, 1500)
      this.checkPublicIP()
      setInterval(async () => {
        await this.checkPublicIP()
      }, 15 * 60 * 1000)
      setInterval(async () => {
        const resp = await this.k8s.client.api.v1.namespaces('kube-system').secrets('k8g8-tls').get()
        const cert = Buffer.from(resp.body.data['tls.crt'], 'base64')
        await this.checkK8g8CertificateExpiration(cert)
      }, 6 * 60 * 60 * 1000)
    })
  }

  generateHealthCheckData = (data = {}) => {
    const healthCheckData = {
      usingFallbackResolver: this.dns.usingFallback,
      agentVersion: RELEASE,
      myPublicIP: this.status.publicIP,
      features: this.features,
      ...data
    }
    logger.silly('generateHealthCheckData', { healthCheckData })
    return healthCheckData
  }

  async checkPublicIP() {
    const { privateIP, publicIP } = this.status
    logger.debug('Checking public IP for DDNS', { privateIP, lastPublic: publicIP })
    try {
      const { body } = await this.kubesailApiRequest(`/whatsmyip/${privateIP}`, 'PUT', null, 0, 0, 5000, {
        username: KUBESAIL_AGENT_USERNAME,
        'agent-key': KUBESAIL_AGENT_KEY,
        'agent-secret': KUBESAIL_AGENT_SECRET
      })
      try {
        const json = JSON.parse(body)
        if (json.ip !== publicIP) {
          logger.debug('Updated DDNS', {
            privateIP,
            lastPublic: this.status.publicIP,
            ip: json.ip
          })
          this.status.publicIP = json.ip
        }
      } catch (err) {
        logger.error('Failed to parse response from KubeSail API.', { errMsg: err.message })
      }
    } catch (err) {
      logger.error('Failed to fetch current public IP address! Possibly we have no internet connection?', {
        errMsg: err.message
      })
    }
  }

  emitConfigResponse = async () => {
    this.gatewaySocket.emit('config-response', {
      kubeConfig: await this.k8s.generateKubeConfig(),
      assertUsers: false
    })
  }

  kubesailApiRequest = (
    path /*: string */,
    method /*: string */ = 'POST',
    data /*: ?Object */,
    retries /*: ?number */ = 0,
    retryLimit /*: ?number */ = 0,
    timeout /*: ?number */ = 5000,
    headers = {}
  ) => {
    return new Promise((resolve, reject) => {
      const [KubeSailApiTarget, KubeSailApiPort] = KUBESAIL_API_TARGET.split(':')
      const options = {
        hostname: KubeSailApiTarget,
        headers: { 'Content-Type': 'application/json', ...headers },
        port: KubeSailApiPort,
        method,
        timeout
      }
      if (process.env.NODE_ENV === 'development') {
        options.insecure = true
        options.rejectUnauthorized = false
      }
      const errHandler = e => {
        if (e.code === 'ECONNRESET' || e.code === 'ECONNREFUSED' || e.code === 'EAI_AGAIN') {
          logger.error('Failed to post to KubeSail API', {
            errMsg: e.message,
            code: e.code,
            retries,
            retryLimit
          })
          if (retries < retryLimit) {
            return safeTimers.setTimeout(() => {
              resolve(this.kubesailApiRequest(path, method, data, ++retries))
            }, (retries + 1) * 1000)
          }
        }
        reject(new Error(`Failed to post to KubeSail API: ${method} ${path}`))
      }
      logger.silly('kubesailApiRequest:', { path, method })
      const req = https.request({ ...options, path, lookup: this.dns.lookup }, res => {
        res.on('error', errHandler)
        let body = ''
        res.on('data', d => {
          body = body + d
        })
        res.on('end', () => resolve({ res, body }))
      })
      req.on('error', errHandler)
      if (data) req.write(JSON.stringify(data))
      req.end()
    })
  }

  requestHandler(protocol) {
    return (stream, { host, remoteAddr }) => {
      let targetPort
      let targetHost
      const errObj = err => {
        return {
          host,
          target: targetHost + ':' + targetPort,
          errMsg: err.message,
          name: err.name,
          code: err.code
        }
      }
      if (host === this.status.clusterAddress || ADDITIONAL_CLUSTER_HOSTNAMES.includes(host)) {
        const uri = new url.URL(this.k8s.client.backend.requestOptions.baseUrl)
        targetHost = uri.host
        targetPort = uri.port || 443 // If there is no explicit port on the interface, it's 443
        logger.silly('Forwarding request to Kubernetes API', {
          target: targetHost + ':' + targetPort,
          clusterAddress: this.status.clusterAddress
        })
      } else {
        if (protocol === 'https') {
          targetHost = '127.0.0.1'
          targetPort = KUBESAIL_AGENT_INGRESS_CONTROLLER_PORT
        } else {
          targetHost = '127.0.0.1'
          targetPort = KUBESAIL_AGENT_INGRESS_CONTROLLER_HTTP_PORT
        }
      }
      if (!targetHost || !targetPort) {
        logger.error('requestHandler: Unable to determine target', { targetHost, targetPort })
        return stream.end(`HTTP/1.1 500 KS_INTERNAL_ERROR_001\n\n`)
      }
      stream.on('close', () => socket.end())
      stream.pause()
      const socket = net.connect(
        { noDelay: true, keepAlive: true, port: targetPort, host: targetHost },
        () => {
          if (targetHost === '127.0.0.1' && remoteAddr) {
            const address = socket.address()
            this.remoteAddressTracking[address.port] = remoteAddr
          }
          socket.on('close', () => stream.end())
          stream.on('error', err => {
            if (err.message === 'stream.push() after EOF') {
              logger.debug('stream: stream.push() after EOF', errObj(err))
            } else {
              logger.warn('requestHandler: error on stream:', errObj(err))
            }
            return socket.end()
          })
          stream.resume()
          socket.pipe(stream)
          stream.pipe(socket)
        }
      )
      socket.on('error', err => {
        if (err.code === 'EPIPE') return
        logger.warn('requestHandler: error on socket:', errObj(err))
        stream.end(`HTTP/1.1 500 KS_SOCKET_ERROR\n\n`)
        return socket.end()
      })
    }
  }

  reconnectionCount = 0
  reconnectTimeout = null
  reconnect = async (time = 3000) => {
    if (this.status.registerRejected) return
    this.reconnectionCount = this.reconnectionCount + 1
    time = Math.min(time + Math.floor(Math.random() * Math.floor(time)) * this.reconnectionCount, 15000)
    if (this.reconnectTimeout) clearInterval(this.reconnectTimeout)
    logger.debug(`Reconnecting in ${Math.floor(time / 1000)} seconds...`)
    this.reconnectTimeout = setTimeout(() => {
      if (this.status.registerRejected) return
      this.gatewaySocket.open()
    }, time)
  }

  async registerWithGateway() {
    return new Promise((resolve, _reject) => {
      socketioStream(this.gatewaySocket).on('http', this.requestHandler('http'))
      socketioStream(this.gatewaySocket).on('https', this.requestHandler('https'))
      this.gatewaySocket.on('agent-data', async agentData => {
        logger.silly('Agent received new agent-data from gateway!', {
          clusterAddress: agentData.clusterAddress,
          firewall: agentData.firewall,
          email: agentData.email
        })
        this.firewall = agentData.firewall
        this.status.clusterAddress = agentData.clusterAddress
        this.status.agentKey = agentData.agentKey
        this.status.email = agentData.email
        if (agentData.wasCreated) {
          this.framebuffer.drawImage('lib/agent/images/qr-setup-finished.png')
          this.framebuffer.statsScreen(12)
        }
        if (agentData.refreshCredentials) {
          logger.silly('Gateway asked us to refresh credentials')
          await this.emitConfigResponse()
        }
        resolve()
      })
      this.gatewaySocket.on('health-check', () => {
        logger.debug('Agent received health-check request')
        this.gatewaySocket.emit('health-check', this.generateHealthCheckData())
      })
      this.gatewaySocket.on('removed', () => {
        logger.error(
          'Agent has been removed from KubeSail - please uninstall me! kubectl delete -f https://byoc.kubesail.com/uninstall.yaml'
        )
        this.gatewaySocket.close()
      })
      this.gatewaySocket.on('config-request', async () => {
        logger.debug('Received config-request', { clusterAddress: this.status.clusterAddress })
        await this.emitConfigResponse()
      })
      this.gatewaySocket.on('kube-watch', async ({ username, namespace, startOrStop }) => {
        if (startOrStop === 'start') {
          if (!this.usersWatchingEvents.find(u => u.namespace === namespace && u.username === username)) {
            logger.debug('User starting to watch namespace events', { username, namespace })
            this.usersWatchingEvents.push({ username, namespace })
          } else {
            logger.debug('User starting to watch events, but user is already watching events!')
          }
          // TODO: Restore metricsData
          // if (Object.keys(this.metricsData.nodes).length > 0) {
          //   try {
          //     await this.kubesailApiRequest('/agent/metrics', 'POST', {
          //       agentKey: KUBESAIL_AGENT_KEY,
          //       agentSecret: KUBESAIL_AGENT_SECRET,
          //       namespace,
          //       metricsData: this.metricsData
          //     })
          //   } catch (err) {
          //     logger.warn('KubeWatch: Failed to post /agent/metrics data', {
          //       errMsg: err.message,
          //       code: err.code
          //     })
          //   }
          // }
        } else {
          // TODO: Cleanup filemanager and SSH pods
          logger.silly('User no longer watching namespace events', { username, namespace })
          this.usersWatchingEvents = this.usersWatchingEvents.filter(
            u => u.username !== username && u.namespace !== namespace
          )
        }
      })
      this.gatewaySocket.on('disk-stats', async () => {
        logger.debug('Agent received disk-stats request, fetching.')
        const res = await this.framebuffer.request('/disk-stats')
        if (!res || res.statusCode !== 200) {
          logger.debug('Invalid response from framebuffer!', { status: res?.statusCode })
          await this.kubesailApiRequest('/agent/disk-stats/error', 'POST', {
            agentKey: KUBESAIL_AGENT_KEY,
            agentSecret: KUBESAIL_AGENT_SECRET
          })
          return
        }
        const data = []
        res.on('data', chunk => data.push(chunk))
        res.on('end', async () => {
          try {
            const diskStats = JSON.parse(Buffer.concat(data).toString())
            // logger.debug('Framebuffer replies with:', { diskStats })
            if (diskStats) {
              await this.kubesailApiRequest('/agent/disk-stats', 'POST', {
                agentKey: KUBESAIL_AGENT_KEY,
                agentSecret: KUBESAIL_AGENT_SECRET,
                diskStats
              })
            } else {
              logger.warn('Framebuffer replied with invalid diskStats!', {
                statusCode: res.statusCode,
                diskStats
              })
            }
          } catch (err) {
            logger.warn('Failed to post disk stats!', { errMsg: err.message })
          }
        })
      })
      this.gatewaySocket.on('connect', async () => {
        if (this.status.registerRejected) return
        if (this.status.registered) {
          logger.info('Connected to KubeSail', { gateway: KUBESAIL_AGENT_GATEWAY_TARGET })
        }
        this.gatewaySocket.emit('init', {
          kubeConfig: await this.k8s.generateKubeConfig(),
          agentVersion: RELEASE
        })
        this.status.connected = true
        logger.silly('Socket connected, emitting "init"')
      })
      this.gatewaySocket.on('error', error => {
        throw new Error(`Gateway Socket Errored! Reason: "${error.description.code}"`)
      })
      // Fired by gateway when we're pending verification
      // The presence of a pendingKey implies we're waiting to be claimed
      // If we're pending verification with an agent key/secret, we don't need a pendingKey
      this.gatewaySocket.on('pending', async pendingKey => {
        if (pendingKey) {
          const qrUri = `https://kubesail.com/qr/${pendingKey}`
          logger.info(
            `Pending verification. Either scan the QR code on the screen, or install the agent manually at ${qrUri}`
          )
          await this.framebuffer.drawImage('lib/agent/images/qr-setup-init.png')
          this.framebuffer.drawQRCode(qrUri)
        } else {
          logger.info('Pending verification. Please visit kubesail.com to verify this cluster!')
          this.framebuffer.drawImage('lib/agent/images/qr-setup-pending-verify.png')
        }
      })
      this.gatewaySocket.on('qr-scanned', () => {
        logger.debug('QR Scanned')
        this.framebuffer.drawAnimation('lib/agent/images/qr-scanned.gif')
      })
      this.gatewaySocket.on('set-credentials', async credentials => {
        const { agentKey, agentSecret, username } = credentials
        logger.info('Server claimed!', { username, agentKey })
        this.framebuffer.drawImage('lib/agent/images/qr-setup-configuring.png')
        try {
          const secretName = 'kubesail-agent'
          await this.k8s.client.api.v1
            .namespaces(POD_NAMESPACE || 'kubesail-agent')
            .secrets(secretName)
            .patch({
              body: {
                apiVersion: 'v1',
                kind: 'Secret',
                metadata: { name: secretName },
                data: { KUBESAIL_AGENT_SECRET: Buffer.from(agentSecret).toString('base64') }
              }
            })
        } catch (err) {
          logger.error('Unable to find local kubesail-agent secret to patch. Please install manually', {
            code: err.status,
            errMsg: err.message
          })
          return
        }
        try {
          const containers = [
            {
              name: 'agent',
              env: [
                { name: 'KUBESAIL_AGENT_KEY', value: agentKey },
                { name: 'KUBESAIL_AGENT_USERNAME', value: username }
              ]
            }
          ]
          await this.k8s.client.apis.apps.v1
            .namespaces(POD_NAMESPACE || 'kubesail-agent')
            .deployments('kubesail-agent')
            .patch({
              body: {
                apiVersion: 'v1/apps',
                kind: 'Deployment',
                metadata: { name: 'kubesail-agent' },
                spec: { template: { spec: { containers } } }
              }
            })
        } catch (err) {
          logger.error('Unable to find local kubesail-agent deployment to patch. Please install manually', {
            code: err.status,
            errMsg: err.message
          })
        }
      })
      this.gatewaySocket.on('disconnect', reason => {
        this.status.connected = false
        logger.error('Gateway closed connection, reconnecting!', { reason })
        this.reconnect()
      })
      this.gatewaySocket.on('connect_error', error => {
        this.status.connected = false
        logger.error(
          `Disconnected from KubeSail Gateway ("${
            error?.description?.message || error.message
          }") Reconnecting...`,
          {
            code: error.code || error.code,
            message: error?.description?.message || error.message,
            gateway: KUBESAIL_AGENT_GATEWAY_TARGET,
            port: KUBESAIL_AGENT_GATEWAY_PORT,
            resolved: this.status.gatewayTargets[0]
          }
        )
      })
      this.gatewaySocket.on('connect_timeout', timeout => {
        this.status.connected = false
        logger.error('gatewaySocket connect_timeout:', timeout)
      })
      this.gatewaySocket.on('register-rejected', status => {
        this.status.registerRejected = true
        this.status.registered = false
        this.status.connected = false
        logger.error(
          'KubeSail agentKey and agentSecret rejected! Please re-install this agent at https://kubesail.com/clusters',
          { status }
        )
      })
      this.gatewaySocket.open()
    })
  }

  async installCertificate(namespace, secretName, hostname, secret) {
    if (!namespace || !secretName || !hostname)
      throw new Error('invalid arguments passed to installCertificate')
    if (!secret) {
      try {
        const resp = await this.k8s.client.api.v1.namespaces(namespace).secrets(secretName).get()
        if (resp) secret = resp.body
      } catch (err) {
        logger.debug('installCertificate: Unable to get latest version of secret', { namespace, secretName })
      }
    }
    if (secret) {
      if (!secret.data['tls.crt'] || !secret.data['tls.key']) {
        logger.warn(
          `installCertificate: Secret "${namespace}/${secretName}" did not contain a tls.crt or tls.key field, skipping`
        )
        return
      }

      const key = Buffer.from(secret.data['tls.key'], 'base64')
      const cert = Buffer.from(secret.data['tls.crt'], 'base64')
      const secureContext = tls.createSecureContext({ key, cert })

      // Special handling for the k8g8-tls wildcard certificate
      if (namespace === 'kube-system' && secretName === 'k8g8-tls') {
        this.reverseProxyTLSContexts['*'] = secureContext
        const needsRenewal = await this.checkK8g8CertificateExpiration(cert)
        const tlsValidFor = Buffer.from(secret?.data?.clusterAddress || '', 'base64').toString('ascii')
        if (tlsValidFor !== hostname) {
          logger.warn(
            `installCertificate: Found a k8g8-tls certificate but the hostname didn't match. Wiping it and requesting a new certificate.`
          )
          await this.k8s.client.api.v1.namespaces(namespace).secrets(secretName).delete()
          return
        } else if (!needsRenewal) {
          this.features.k8g8Cert = true
        }
      }
      logger.debug(
        `installCertificate: ${
          this.reverseProxyTLSContexts[hostname] ? 'Replacing' : 'Installing'
        } TLS certificate from secret "${namespace}/${secretName}" for hostname "${hostname}"`
      )
      this.reverseProxyTLSContexts[hostname] = secureContext
    }
  }

  async checkK8g8CertificateExpiration(certificate) {
    const { validTo } = new X509Certificate(certificate)
    const validUntil = Date.parse(validTo)
    const expiresIn = validUntil - Date.now()
    const needsRenewal = expiresIn < 1000 * 60 * 60 * 24
    const expiresHuman = `${Math.round(expiresIn / 1000 / 60 / 60, 1)}h`

    if (needsRenewal) {
      logger.warn(
        `checkK8g8CertificateExpiration: k8g8 certificate needs renewal! Requesting a new certificate.`,
        { expiresIn: expiresHuman }
      )
      this.features.k8g8Cert = false
      this.gatewaySocket.emit('health-check', this.generateHealthCheckData())
    } else {
      logger.debug('checkK8g8CertificateExpiration: Certificate still valid for', { expiresIn: expiresHuman })
    }
    return needsRenewal
  }

  async cleanupOldPods() {
    const podsToCleanup = this.docs.filter(d => {
      return (
        d.kind === 'Pod' && d?.metadata?.labels?.app === 'filemanager' && d?.metadata?.labels?.safeToDelete
      )
    })
    podsToCleanup.forEach(async d => {
      const namespace = d.metadata.namespace
      const pod = d.metadata.name
      logger.debug('cleanupOldPods: Deleting utility pod:', { namespace, pod })
      await this.k8s.client.api.v1.namespaces(namespace).pods(pod).delete()
    })
  }

  currentHostMap = {}
  failedToFindSecretWarning = []
  async updateHostMap() {
    if (!this.status.registered) {
      throw new Error('Cannot call updateHostMap before registration')
    }
    const desiredHostMap = {}
    this.docs
      .filter(d => d.kind === 'Ingress')
      .forEach(doc => {
        for (const cert of doc?.spec?.tls || []) {
          if (!cert.secretName) continue
          for (const host of cert.hosts || []) {
            this.installCertificate(doc.metadata.namespace, cert.secretName, host).catch(err => {
              if (err.code === 404) {
                const key = `${doc.metadata.namespace}/${cert.secretName}`
                if (!this.failedToFindSecretWarning.includes(key)) {
                  this.failedToFindSecretWarning.push(key)
                  logger.debug(
                    `installCertificate: Failed to find secret "${key}" referenced by ingress "${doc.metadata.namespace}/${doc.metadata.name}"`
                  )
                }
              } else throw err
            })
          }
        }
        for (const rule of doc?.spec?.rules || []) {
          desiredHostMap[rule.host] = doc?.metadata?.annotations?.['kubesail.com/firewall'] || '0.0.0.0/0'
        }
      })
    if (_.isEqual(desiredHostMap, this.currentHostMap)) {
      logger.silly('updateHostMap: No action required, host map already up-to-date', { desiredHostMap })
      return
    }

    for (const host of Object.keys(this.firewall)) {
      if (host !== this.status.cluster && !desiredHostMap[host]) {
        logger.silly('Firewall: removing host', { host })
        delete this.firewall[host]
      }
    }

    this.currentHostMap = desiredHostMap
    logger.debug('updateHostMap: submitting new host-map request', { desiredHostMap })
    const { res, body } = await this.kubesailApiRequest('/agent/host-mapping-request', 'POST', {
      agentKey: KUBESAIL_AGENT_KEY,
      agentSecret: KUBESAIL_AGENT_SECRET,
      desiredIngressMap: desiredHostMap
    })
    if (res.statusCode !== 200 || !body) {
      logger.warn('updateHostMap: Failed to set hostnames:', {
        desiredHostMap,
        statusCode: res.statusCode
      })
      return
    }
    this.dbus.writeAvahiHosts()
    try {
      const json = JSON.parse(body)
      if (json.validHostnames.length > 0) {
        const humanReadableFirewall = {}
        for (const hostname of json.validHostnames) {
          if (!this.firewall[hostname]) continue
          humanReadableFirewall[hostname] = this.firewall[hostname]
        }
        logger.info(
          'KubeSail ingress forwarding successful! The following domains are now active:',
          humanReadableFirewall
        )
      }
    } catch (err) {
      logger.debug('updateHostMap: Unexpected reply from KubeSail api /agent/host-mapping-request', {
        errMsg: err.message,
        statusCode: res.statusCode
      })
    }
  }

  k8s = {
    client: new Client({ version: KUBERNETES_SPEC_VERSION }),
    init: async () => {
      const filterKind = (kind, items) => {
        return items.map(i => {
          i.kind = kind
          return this.k8s.filterResourceValues(i)
        })
      }
      // Nodes
      const nodes = await this.k8s.client.api.v1.nodes.get()
      this.docs.push(...filterKind('Node', nodes.body.items))
      // Deployments
      const deployments = await this.k8s.client.apis.apps.v1.deployments.get()
      this.docs.push(...filterKind('Deployment', deployments.body.items))
      // Services
      const services = await this.k8s.client.api.v1.services.get()
      this.docs.push(...filterKind('Service', services.body.items))
      // Ingresses (do a little searching to get the right API)
      const baseIngApi = this.k8s.client.apis['networking.k8s.io'] ? 'networking.k8s.io' : 'extensions'
      const ingVersion = this.k8s.client.apis[baseIngApi].v1 ? 'v1' : 'v1beta1'
      this.ingressApi = this.k8s.client?.apis?.[baseIngApi]?.[ingVersion]
      if (this.ingressApi) {
        const ingresses = await this.ingressApi.ingresses.get()
        this.docs.push(...filterKind('Ingress', ingresses.body.items))
      }
      // Endpoints
      const endpoints = await this.k8s.client.api.v1.endpoints.get()
      this.docs.push(...filterKind('Endpoints', endpoints.body.items))
      // Pods
      const pods = await this.k8s.client.api.v1.pods.get()
      this.docs.push(...filterKind('Pods', pods.body.items))
      this.cleanupOldPods()
      // Secrets
      const secrets = await this.k8s.client.api.v1.secrets.get()
      this.docs.push(...filterKind('Secret', secrets.body.items))
    },
    filterResourceValues: object => {
      // Cleanup the object (unused fields we don't need to waste bandwidth on)
      if (object?.metadata?.managedFields) {
        object.metadata.managedFields = null
        delete object.metadata.managedFields
      }
      if (object?.metadata?.annotations) {
        delete object.metadata.annotations['kubectl.kubernetes.io/last-applied-configuration']
        delete object.metadata.annotations['objectset.rio.cattle.io/applied']
      }
      return object
    },
    filterKubeEvents: event => {
      if (event && event.object && event.object.metadata) {
        if (event.object.kind === 'Endpoint' || event.object.kind === 'Endpoints') {
          return false
        } else if (
          event.type === 'MODIFIED' &&
          [
            'cert-manager-cainjector-leader-election',
            'cert-manager-cainjector-leader-election-core',
            'ingress-controller-leader-public',
            'cert-manager-controller',
            'ingress-controller-leader-nginx'
          ].includes(event.object.metadata.name)
        ) {
          return false
        }
        return true
      }
    },
    trackResource: (eventType, doc) => {
      // Track selected resources in this.docs
      let madeChange = false
      if (['Ingress', 'Service', 'Endpoints', 'Secret', 'Deployment'].includes(doc.kind)) {
        const docMatch = d => {
          return (
            d.kind === doc.kind &&
            d.metadata.name === doc.metadata.name &&
            d.metadata.namespace === doc.metadata.namespace
          )
        }
        if (doc.kind === 'Ingress') {
          logger.silly(`k8s: ${eventType} ${doc.kind} ${doc.metadata.namespace}/${doc.metadata.name}`)
        }
        if (eventType === 'ADDED') {
          const exists = this.docs.find(docMatch)
          if (!exists) {
            madeChange = true
            this.docs.push(doc)
          }
        } else if (eventType === 'MODIFIED') {
          const existing = this.docs.findIndex(d => {
            const oldVersion = parseInt(d.metadata.resourceVersion, 10)
            const newVersion = parseInt(doc.metadata.resourceVersion, 10)
            return docMatch(d) && newVersion >= oldVersion
          })
          madeChange = true
          if (existing > -1) this.docs[existing] = doc
          else this.docs.push(doc)
        } else if (eventType === 'DELETED') {
          const newPile = this.docs.filter(d => docMatch(d) === false)
          if (newPile.length < this.docs.length) {
            madeChange = true
            this.docs = newPile
          }
        }
      }
      return madeChange
    },

    ensureHostPort: async () => {
      let kubesailAgent = this.docs.find(
        s =>
          s?.kind === 'Deployment' &&
          s?.metadata?.name === 'kubesail-agent' &&
          s?.metadata?.namespace === POD_NAMESPACE
      )
      const hasHostPort = !!kubesailAgent.spec.template.spec.containers[0].ports.find(p => p.hostPort)
      if (hasHostPort) return

      logger.silly('ensureHostPort: Checking if we can bind host-port 80 and 443')
      try {
        await this.k8s.client.api.v1.namespaces(POD_NAMESPACE).pods('host-port-test').delete()
      } catch (err) {
        if (err.code !== 404) throw err
      }
      try {
        await this.k8s.client.api.v1.namespaces(POD_NAMESPACE).pods.post({
          body: {
            apiVersion: 'v1',
            kind: 'Pod',
            metadata: {
              name: 'host-port-test',
              deletionGracePeriodSeconds: 0,
              labels: { safeToDelete: 'true' }
            },
            spec: {
              nodeName: NODE_NAME,
              terminationGracePeriodSeconds: 0,
              containers: [
                {
                  name: 'host-port-test',
                  image: kubesailAgent.spec.template.spec.containers[0].image,
                  imagePullPolicy: 'IfNotPresent',
                  command: ['sleep', '300'],
                  ports: [
                    { containerPort: 4080, name: 'web', protocol: 'TCP', hostPort: 80 },
                    { containerPort: 4443, name: 'websecure', protocol: 'TCP', hostPort: 443 }
                  ]
                }
              ]
            }
          }
        })
      } catch (err) {
        if (err.code !== 409) {
          logger.debug('ensureHostPort: Failed to launch host-port-test', {
            code: err.code,
            errMsg: err.message
          })
          return
        }
      }

      let checkOnPod = true
      let attempts = 0
      await setPTimeout(1000)
      while (checkOnPod) {
        const pod = await this.k8s.client.api.v1.namespaces(POD_NAMESPACE).pods('host-port-test').get()
        if (pod) {
          if (pod.body.status.phase === 'Pending') {
            // No-op, just wait
          } else if (pod.body.status.phase === 'Failed' && pod.body.status.reason === 'NodePorts') {
            logger.warn('Unable to bind host ports 80 and 443. ".local" domains may not work properly.', {
              errMsg: pod.body.status.message
            })
            checkOnPod = false
            this.features.hostPortHTTP = false
          } else if (pod.body.status.phase === 'Running' && pod.body.status.containerStatuses[0].ready) {
            logger.info('Host Port 80 and 443 appear to be available! Restarting self to bind ports...')
            checkOnPod = false
            this.features.hostPortHTTP = true
            // Find the latest document - it may have been updated before now
            const updatedAgentDoc = await this.k8s.client.apis.apps.v1
              .namespaces(POD_NAMESPACE || 'kubesail-agent')
              .deployments('kubesail-agent')
              .get()
            kubesailAgent = updatedAgentDoc.body
            kubesailAgent.spec.template.spec.containers[0].ports = [
              { containerPort: 5000, name: 'metrics', protocol: 'TCP' },
              { containerPort: 6000, name: 'http', protocol: 'TCP' },
              { containerPort: 4080, hostPort: 80, name: 'web', protocol: 'TCP' },
              { containerPort: 4443, hostPort: 443, name: 'websecure', protocol: 'TCP' }
            ]
            await this.k8s.client.apis.apps.v1
              .namespaces(POD_NAMESPACE || 'kubesail-agent')
              .deployments('kubesail-agent')
              .patch({ body: kubesailAgent })
          } else {
            logger.warn('ensureHostPort: Unknown pod status:', { status: pod.body.status })
          }
        }
        if (checkOnPod === false) {
          await this.k8s.client.api.v1.namespaces(POD_NAMESPACE).pods('host-port-test').delete()
        }
        attempts++
        if (attempts > 10) checkOnPod = false
        await setPTimeout(2500)
      }
    },

    findServiceForRequest: async (req, res) => {
      const host =
        (req?.headers?.host || '').split(':')[0] || (req?.headers?.[':authority'] || '').split(':')[0]
      const reqPath = req.url || req.path || req.headers[':path']

      // Find ingress matching this rule
      const ingresses = this.docs.filter(i => {
        return (
          i.kind === 'Ingress' &&
          Array.isArray(i?.spec?.rules) &&
          i.spec.rules.find(r => host && r?.host === host)
        )
      })
      const ingressWithPathMatch = ingresses.find(i =>
        i.spec.rules.find(
          r => Array.isArray(r?.http?.paths) && r.http.paths.find(p => p.path && p.path === reqPath)
        )
      )

      const remoteAddress = req.socket.remoteAddress
      logger.silly('Routing request:', {
        reqPath,
        remoteAddress,
        firewall: this.firewall[host],
        ingresses: ingresses.map(i => i.metadata.name)
      })
      const ingress = ingressWithPathMatch || ingresses[0]
      const rule = (ingress?.spec?.rules || []).find(r => r.host === host)
      const annotations = ingress?.metadata?.annotations || {}

      const basicAuth = annotations['kubesail.com/basic-auth']
      if (basicAuth) {
        const authHeader = req.headers.authorization
        if (!authHeader) {
          res.writeHead(401, { 'WWW-Authenticate': 'Basic' })
          return res.end('You are not authenticated!')
        }
        try {
          const [username, password] = new Buffer.from(authHeader.split(' ')[1], 'base64')
            .toString()
            .split(':')
          const [realUsername, realPassword] = new Buffer.from(basicAuth, 'base64').toString().split(':')
          if (username !== realUsername || password !== realPassword) {
            logger.info('Invalid authentication', { host })
            res.writeHead(401, { 'WWW-Authenticate': 'Basic' })
            return res.end('You are not authenticated!')
          }
        } catch (err) {
          logger.error('Unable to parse basic-auth annotation!', { errMsg: err.message, stack: err.stack })
          res.writeHead(500)
          return res.end('Internal error, see logs')
        }
      }

      // Bot / malice detection
      if (!annotations['kubesail.com/disable-bot-protection']) {
        if (req.headers['user-agent']) {
          let isBot = false
          for (let i = 0; i < crawlerUserAgents.length; i++) {
            if (RegExp(crawlerUserAgents[i].pattern).test(req.headers['user-agent'])) {
              logger.debug('requestHandler: rejecting request, detected bot', {
                userAgent: req.headers['user-agent'],
                pattern: crawlerUserAgents[i].pattern
              })
              isBot = crawlerUserAgents[i].pattern
              break
            }
          }
          if (isBot) {
            if (res) {
              res.writeHead(444, { 'Content-Type': 'text/plain' })
              return res.end(`Sorry, no bots allowed. (${isBot})`)
            } else return
          }
        }
      }

      // TODO: Display helpful page here for users who have browsed to the IP address of their pibox
      // if (isIP(host) && ipaddrJs.parse(host).range() === 'private') {
      //   return res.end('Nodes ip?\n\n')
      // }

      if (!ingress || !rule) {
        logger.debug('requestHandler: No app is installed at this address', {
          host,
          rule: !!rule,
          ingress: !!ingress,
          firewall: !!this.firewall[host],
          ingresses: this.docs.filter(i => i.kind === 'Ingress').length,
          totalDocs: this.docs.length
        })
        if (res) {
          res.writeHead(404, { 'Content-Type': 'text/plain' })
          return res.end('No app is installed at this address')
        } else return
      }

      // Default to assuming the backend is HTTP
      let backendProtocol = 'http'
      if ((annotations['ingress.kubernetes.io/backend-protocol'] || '').toLowerCase() === 'https') {
        backendProtocol = 'https'
      }

      // Basic auth
      if (
        annotations['ingress.kubernetes.io/auth-type'] === 'basic' &&
        annotations['ingress.kubernetes.io/auth-secret']
      ) {
        if (!req.headers.authorization) {
          if (res) {
            res.setHeader('WWW-Authenticate', 'Basic')
            res.statusCode = 401
            return res.end('You are not authenticated!')
          } else return
        }
        const secret = this.docs.find(
          s =>
            s.kind === 'Secret' &&
            s.metadata.namespace === ingress.metadata.namespace &&
            s.metadata.name === annotations['ingress.kubernetes.io/auth-secret']
        )
        if (secret && secret?.data?.auth) {
          const [username, password] = (Buffer.from(secret?.data?.auth, 'base64').toString() || '').split(':')
          const [authUser, authPass] = Buffer.from(req.headers.authorization.split(' ')[1], 'base64')
            .toString()
            .split(':')
          const isMatch = await bcrypt.compare(authPass, password)
          if (authUser !== username || !isMatch) {
            if (res) {
              res.writeHead(401, { 'Content-Type': 'text/plain', 'WWW-Authenticate': 'Basic' })
              return res.end('Sorry, invalid credentials')
            } else return
          }
        } else {
          logger.warn(
            `requestHandler: Ingress contained ingress.kubernetes.io/auth-secret annotation but I couldn't find the specified secret, or it didn't contain a 'data.auth' key.`,
            {
              secret: !!secret,
              secretName: annotations['ingress.kubernetes.io/auth-secret'],
              namespace: ingress.metadata.namespace
            }
          )
          res.writeHead(401, { 'Content-Type': 'text/plain', 'WWW-Authenticate': 'Basic' })
          return res.end('Sorry, invalid credentials')
        }
      }

      // KubeSail Agent Auth
      if (req._ingress?.metadata?.annotations?.['kubesail.com/agent-auth']) {
        let authenticated = false
        const cookies = (req.getHeader('Cookie') || '').split(';').map(v => v.split('='))
        const cookie = cookies.find(c => c[0] === `kubesail-agent-auth`)
        const query = (req.path.split('?')[1] || '').startsWith('kubesail-agent-auth-nonce=')
        if (query) {
          // if  2nd step in auth flow then ask API
          const nonce = req.path.split('kubesail-agent-auth-nonce=')[1]
          const { res } = await this.kubesailApiRequest('/agent/proxy-auth', 'POST', {
            agentKey: KUBESAIL_AGENT_KEY,
            agentSecret: KUBESAIL_AGENT_SECRET,
            nonce
          })
          if (res.statusCode === 200) {
            const newAuthCookie = nanoid()
            this.authMap.set(newAuthCookie, 1)
            res.writeHead(307, { Location: '/', 'Set-Cookie': newAuthCookie })
            return res.end()
          }
        } else if (cookie) {
          // check LRU cache if user had an auth cookie
          const authCookieValue = cookie[1]
          const userInfo = this.authMap.get(authCookieValue)
          if (userInfo) authenticated = true
        }
        // Bail early if not authenticated
        if (!authenticated) {
          // TODO clear cookie
          return res.end(
            `Please <a href="${KUBESAIL_WWW_TARGET}/login?agentProxyAuth=${KUBESAIL_AGENT_KEY}&redirect=${encodeURIComponent(
              req.host + req.path
            )}">login</a>.`
          )
        }
      }

      // Find associated path and service
      const path = rule.http.paths[0]
      const serviceName = path?.backend?.service?.name
      const service = this.docs.find(
        s =>
          s.kind === 'Service' &&
          s.metadata.namespace === ingress.metadata.namespace &&
          s.metadata.name === serviceName
      )
      if (!service) {
        const message = `Ingress exists but points at a service named "${serviceName}" that doesn't exist`
        logger.debug(`requestHandler: ${message}`, {
          host,
          serviceName,
          ingNamespace: ingress.metadata.namespace,
          servicesTracked: this.docs.filter(s => s.kind === 'Service').length
        })
        if (res) {
          res.writeHead(404, { 'Content-Type': 'text/plain' })
          return res.end(message)
        } else return
      }
      // Determine if an endpoint is online
      const endpoint = this.docs.find(e => {
        if (e.kind !== 'Endpoints') return
        const selectorKeys = Object.keys(service.spec.selector)
        const matchesSelectors =
          selectorKeys.filter(
            key => (service?.spec?.selector || {})[key] === (e?.metadata?.labels || {})[key]
          ).length === selectorKeys.length
        // Don't bother selecting an endpoint if it has no addresses
        return matchesSelectors && (e?.subsets || []).length > 0
      })

      let ip
      let port
      if (
        !endpoint?.subsets ||
        endpoint.subsets.length === 0 ||
        (endpoint.subsets[0]?.addresses || []).length === 0 ||
        (endpoint.subsets[0]?.ports || []).length === 0
      ) {
        // If we wanted to talk to the service proxy instead of the endpoint directly, we could target:
        const servicePort = path?.backend?.service?.port?.number || path?.backend?.service?.port?.name
        ip = service.spec.clusterIP
        port = (service.spec.ports.find(p => p.name === servicePort || p.port === servicePort) || {}).port
      } else {
        // We'll skip the service proxy and talk directly to the endpoint when possible
        ip = endpoint.subsets[0].addresses[0].ip
        port = endpoint.subsets[0].ports[0].port
      }
      // res.writeHead(404, { 'Content-Type': 'text/html' })
      // fs.createReadStream('lib/agent/static/launching.html').pipe(res)
      return { host, port, ip, protocol: backendProtocol, service, ingress, endpoint, path: reqPath }
    },
    watchResources: async () => {
      const connect = async (group, version, kind) => {
        const options = {
          qs: { resourceVersion: this.status.watchAllResourceVersion, timeoutSeconds: 21600 }
        }
        let stream
        if (group === 'core') {
          stream = await this.k8s.client.api[version].watch[kind].getObjectStream(options)
        } else {
          const baseApi = this.k8s.client.apis[group][version]
            ? this.k8s.client.apis[group][version]
            : this.k8s.client.apis[group].v1beta1
          if (baseApi?.watch?.[kind]?.getObjectStream) {
            stream = await baseApi.watch[kind].getObjectStream(options)
          }
        }
        if (!stream) return logger.error('watchAll Unable to watch resource', { group, kind, version })
        let reconnectTimeout = null
        let lastErrorSeen = null
        function reconnect() {
          if (!reconnectTimeout) {
            if (lastErrorSeen === 404 && kind.toLowerCase() === 'ingress' && version === 'v1') {
              logger.debug(
                'watchAll reconnecting with v1beta1 ingress (v1 was not found). Outdated version of Kubernetes?'
              )
              version = 'v1beta1'
            }
            reconnectTimeout = setTimeout(() => {
              logger.silly('watchAll: reconnecting...', { group, version, kind })
              clearTimeout(reconnectTimeout)
              connect(group, version, kind)
            }, 1000)
          }
        }
        stream.on('error', function (err) {
          logger.error('watchAll stream error', { group, kind, version, errMsg: err.message })
          reconnect()
        })
        stream.on('disconnect', function () {
          logger.debug('watchAll stream disconnect', { group, kind, version })
          reconnect()
        })
        stream.on('end', function () {
          logger.silly('watchAll stream end', { group, kind, version })
          reconnect()
        })
        stream.on('pause', () => logger.info('watchAll stream pause'))
        stream.on('data', async event => {
          if (event.type === 'ERROR') {
            if (event.object.code === 410) {
              // 410 === Expired (resource version too old)
              this.status.watchAllResourceVersion = undefined
              logger.debug('watchAll: Resource version too old, reconnecting')
            } else logger.error('watchAll error', { group, version, kind, event })
            stream.destroy()
            reconnect()
          } else if (event.status === 'Failure') {
            logger.error('Watch stream Failure!', { group, version, kind, event })
            lastErrorSeen = event.code
            stream.destroy()
            reconnect()
          }
          // Track resource version
          const newVersion = parseInt(event?.object?.metadata?.resourceVersion, 10)
          if (!newVersion) {
            logger.error('Unexpected data from watch stream!', { group, version, kind, event })
            return
          }
          if (!this.status.watchAllResourceVersion || newVersion > this.status.watchAllResourceVersion) {
            this.status.watchAllResourceVersion = newVersion
          }
          this.k8s.filterResourceValues(event.object)
          const changed = this.k8s.trackResource(event.type, event.object)
          if (event.object.kind === 'Secret') {
            if (event.object.type === 'kubernetes.io/tls') {
              const isK8g8TLS =
                event?.object?.metadata?.namespace === 'kube-system' &&
                event?.object?.metadata?.name === 'k8g8-tls'

              if (isK8g8TLS) {
                if (event.type === 'ADDED') {
                  await this.installCertificate(
                    'kube-system',
                    'k8g8-tls',
                    this.status.clusterAddress,
                    event.object
                  )
                } else if (event.type === 'DELETED') {
                  this.features.k8g8Cert = false
                }
              } else {
                const hostnames = (
                  (event?.object?.metadata?.annotations || [])['cert-manager.io/common-name'] || ''
                )
                  .split(',')
                  .filter(Boolean)
                for (const hostname of hostnames) {
                  if (event.type === 'ADDED') {
                    await this.installCertificate(
                      event?.object?.metadata?.namespace,
                      event?.object?.metadata?.name,
                      hostname,
                      event.object
                    )
                  } else if (event.type === 'DELETED') {
                    this.reverseProxyTLSContexts[hostname] = null
                  }
                }
              }
            }
          } else if (event.object.kind === 'Deployment') {
            const appLabel = (event.object?.metadata?.annotations || {})['kubesail.com/template']
            if (appLabel) {
              if (event.type === 'ADDED') {
                const created = new Date(event.object.metadata.creationTimestamp)
                if (changed && created > this.status.startupDate) {
                  logger.info('Installing KubeSail Template!', {
                    event: event.type,
                    app: appLabel,
                    namespace: event.object.metadata.namespace
                  })
                  this.framebuffer.drawLogo(appLabel)
                }
              }
            }
          } else if (event.object.kind === 'Ingress') {
            if (changed && this.status.registered) this.updateHostMap()
          } else if (event.object.kind === 'Endpoints') {
            return
          }
          // Send selected events to KubeSail
          const userWantsEvent = this.usersWatchingEvents.find(
            u => u.namespace === event.object.metadata.namespace
          )
          const filtered = this.k8s.filterKubeEvents(event)
          if (filtered && userWantsEvent) {
            try {
              await this.kubesailApiRequest('/agent/event', 'POST', {
                agentKey: KUBESAIL_AGENT_KEY,
                agentSecret: KUBESAIL_AGENT_SECRET,
                event,
                retryLimit: 0,
                timeout: 8000
              })
            } catch (err) {
              logger.warn('Failed to post Kubernetes event to KubeSail Api!', {
                errCode: err.code,
                errMsg: err.message
              })
            }
          }
        })
      }
      for (const i in DOCUMENTS_TO_WATCH) {
        const doc = DOCUMENTS_TO_WATCH[i]
        await connect(doc.group, doc.version, doc.kind.toLowerCase())
      }
    },
    refreshClientSpec: async () => {
      const spec = await this.k8s.client.backend.http({ method: 'GET', pathname: '/openapi/v2' })
      this.k8s.client = new Client({ version: KUBERNETES_SPEC_VERSION })
      try {
        this.k8s.client._addSpec(spec.body)
      } catch (err) {
        logger.error('Failed to load Cluster Spec!', { errMsg: err.message, name: err.name })
      }
    },
    generateKubeConfig: async () => {
      // Read the mounted service account credentials and build a kube config object to send back to KubeSail
      // Adapted from https://github.com/godaddy/kubernetes-client/blob/0f9ec26b381c8603e7727c3346edb35e1db2deb1/backends/request/config.js#L143
      const root = '/var/run/secrets/kubernetes.io/serviceaccount/'
      const caPath = path.join(root, 'ca.crt')
      const tokenPath = path.join(root, 'token')
      const namespacePath = path.join(root, 'namespace')
      const ca = await readFile(caPath, 'utf8')
      const token = await readFile(tokenPath, 'utf8')
      const namespace = await readFile(namespacePath, 'utf8')
      const cluster = { 'certificate-authority-data': ca, server: this.status.clusterAddress }
      const context = { user: 'byoc', namespace, cluster: 'byoc' }
      const user = { token }
      return {
        apiVersion: 'v1',
        kind: 'Config',
        preferences: {},
        'current-context': 'byoc',
        contexts: [{ name: 'byoc', context }],
        clusters: [{ name: 'byoc', cluster }],
        users: [{ name: 'byoc', user }]
      }
    }
  }

  framebuffer = {
    drawLogo: appLabel => {
      const imageFile = `lib/agent/images/tmpl-${encodeURIComponent(appLabel)}.png`
      fs.stat(imageFile, async (err, _stats) => {
        if (err && err.code === 'ENOENT') {
          const res = await fetch(`https://api.kubesail.com/template/${appLabel}/icon.png`)
          const fileStream = fs.createWriteStream(imageFile)
          res.body.pipe(fileStream)
          res.body.on('error', err => {
            logger.error('drawAppLogo: Failed to download template logo!', {
              errMsg: err.message,
              code: err.code
            })
          })
          fileStream.on('finish', async () => {
            await this.framebuffer.drawColor('#000000')
            this.framebuffer.drawImage(imageFile)
            this.framebuffer.statsScreen(12)
          })
        } else if (!err) {
          this.framebuffer.drawImage(imageFile)
          this.statsOn(12)
        } else {
          logger.error('drawAppLogo: Failed to fetch template logo!', {
            errMsg: err.message,
            code: err.code
          })
        }
      })
    },
    drawQRCode: data => {
      logger.silly('writeQRCode', { data })
      return this.framebuffer.request(`/qr?content=${encodeURIComponent(data)}`)
    },
    drawImage: async path => {
      const file = await readFile(path)
      return this.framebuffer.request(`/image`, 'POST', req => req.write(file))
    },
    drawColor: hex => {
      return new Promise((resolve, _reject) => {
        hex = hex.replace('#', '')
        const color = {
          r: parseInt(hex.substring(0, 2), 16),
          g: parseInt(hex.substring(2, 4), 16),
          b: parseInt(hex.substring(4, 6), 16)
        }
        return this.framebuffer.request(`/rgb`, 'POST', req => {
          req.write(JSON.stringify(color))
          resolve()
        })
      })
    },
    drawAnimation: path => {
      return this.framebuffer.request('/gif', 'POST', async req => {
        req.write(await readFile(path))
      })
    },
    statsScreen: async delay => {
      await setPTimeout(delay * 1000)
      return this.framebuffer.request(`/stats/on`, 'POST')
    },
    request: (path, method = 'GET', callback) => {
      const socketPath = '/var/run/pibox/framebuffer.sock'
      return new Promise((resolve, reject) => {
        fs.stat(socketPath, (err, _stats) => {
          if (err && err.code === 'ENOENT') return resolve()
          else if (err) return reject(err)
          try {
            const req = http.request({ socketPath, path, method }, res => {
              logger.debug('PiBox Framebuffer response:', { path, status: res.statusCode, body: res.body })
              resolve(res)
            })
            req.on('error', err => {
              logger.warn('Failed to write framebuffer request', { path, errMsg: err.message })
            })
            if (callback) callback(req)
            req.end()
          } catch (err) {
            logger.error('Framebuffer request failed', {
              path,
              method,
              errMsg: err.message,
              name: err.name,
              code: err.code
            })
          }
        })
      })
    }
  }

  dbus = {
    systemBus: null,
    init: () => {
      this.dbus.systemBus = dbus.systemBus()
      this.dbus.systemBus.on('error', err => {
        if (err.code === 'ENOENT') {
          logger.warn(
            'Unable to publish ".local" DNS addresses to your network. Please install `avahi-daemon` and restart the agent.',
            { errMsg: err.message, type: err.type, error: err.text }
          )
        } else {
          if (err.type && err.type === 'org.freedesktop.DBus.Error.AccessDenied') {
            logger.warn(
              'An SELinux policy is preventing us from access DBUS. mDNS (.local dns names) will not work.',
              { type: err.type, error: err.text }
            )
          } else logger.error('Unknown DBUS error! Please report to KubeSail:', err)
        }
        this.features.dbus = false
      })
    },
    localHostnameAvahiGroups: {},
    writeAvahiHosts: async () => {
      logger.silly('writeAvahiHosts: starting', { dbusAvailable: this.features.dbus })
      const newLocalHostnames = [{ rule: { host: 'pibox.local' } }]
      this.docs
        .filter(d => d.kind === 'Ingress')
        .forEach(
          ing =>
            ing.spec &&
            ing.spec.rules &&
            ing.spec.rules.find(rule => {
              if (rule?.host && typeof rule.host === 'string') {
                if (rule.host.endsWith('.local') && !this.dbus.localHostnameAvahiGroups[rule.host])
                  newLocalHostnames.push({ ing, rule })
              } else {
                logger.warn(
                  `Ignoring ingress rule in "${ing?.metadata?.namespace || 'unknown'}/${
                    ing?.metadata?.name || 'unknown'
                  }" - invalid host string.`
                )
              }
            })
        )
      if (this.features.dbus && newLocalHostnames.length > 0) {
        logger.info(`Publishing .local DNS addresses (aliased to "${process.env.NODE_IP}")`, {
          hosts: newLocalHostnames.map(l => l.rule.host)
        })
        newLocalHostnames.forEach(async hostname => {
          // TODO: Filter NODE_NAME out - we shouldn't allow localHostname.rule.host === NODE_NAME
          try {
            const avahiInterface = await this.dbus.systemBus.getProxyObject('org.freedesktop.Avahi', '/')
            const server = avahiInterface.getInterface('org.freedesktop.Avahi.Server')
            const entryGroupPath = await server.EntryGroupNew()
            const entryGroup = await this.dbus.systemBus.getProxyObject(
              'org.freedesktop.Avahi',
              entryGroupPath
            )
            const entryGroupInt = entryGroup.getInterface('org.freedesktop.Avahi.EntryGroup')
            await entryGroupInt.AddRecord(
              -1, // IF_UNSPEC (all interfaces)
              -1, // PROTO_UNSPEC (all protocols)
              0,
              toASCII(hostname.rule.host), // mDNS name
              0x01, // CLASS_IN
              0x01, // TYPE_A (A record. TYPE_CNAME is 0x05) https://github.com/lathiat/avahi/blob/d1e71b320d96d0f213ecb0885c8313039a09f693/avahi-sharp/RecordBrowser.cs#L39
              60, // TTL
              Uint8Array.from(process.env.NODE_IP.split('.'))
            )
            await entryGroupInt.Commit()
            this.dbus.localHostnameAvahiGroups[hostname.rule.host] = entryGroupInt
          } catch (err) {
            if (err.message === 'Local name collision' && hostname.rule.host === 'pibox.local') {
              // We don't strictly care about local name collisions, particularly for our pibox.local address
              // which ideally is already published by the host avahi (assuming we're named 'pibox')
            } else logger.error('Failed to write .local DNS addresses', { errMsg: err.message })
          }
        })
      }
    }
  }
}

module.exports = KubesailAgent
