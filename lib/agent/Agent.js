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
const { readFile } = require('fs/promises')
const { promisify } = require('util')
const { toASCII } = require('punycode/')
const _ = require('lodash')
const spdy = require('spdy')
const isbot = require('isbot')
const dbus = require('dbus-next')
const bcrypt = require('bcryptjs')
const fetch = require('node-fetch')
const httpProxy = require('http-proxy')
const safeTimers = require('safe-timers')
const socketio = require('socket.io-client')
const { isIP, isFQDN } = require('validator')
const { Client } = require('kubernetes-client')
const socketioStream = require('socket.io-stream')
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
  RELEASE
} = require('../shared/config')

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
    dbus: true
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

  // Tracks users currently requests events from namespaces
  usersWatchingEvents = []

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
          logger.silly('Skipping setResolver: KUBESAIL_AGENT_GATEWAY_TARGET is not an FQDN', {
            KUBESAIL_AGENT_GATEWAY_TARGET
          })
          return
        }
        resolved = await this.dns.resolve4(KUBESAIL_AGENT_GATEWAY_TARGET)
        logger.debug('Successfully resolved DNS address for agent target', { resolved })
        if (this.dns.usingFallback && resolved) this.status.gatewayTargets = resolved
      } catch (err) {
        if (this.dns.usingFallback) throw err
        logger.warn(
          'Unable to resolve DNS - Falling back to CloudFlare DNS as backup! Please check your cluster for DNS capabilities!',
          { errMsg: err.message, code: err.code }
        )
        this.dns.usingFallback = true
        this.dns.resolver.setServers([sampleArray(['1.1.1.1', '1.0.0.1', '8.8.8.8'])])
        return this.dns.setResolver()
      }
    },
    // Used by https requests (see kubesailApiRequest) to overload their built-in DNS resolver
    lookup: (hostname, _opts, cb) => {
      if (isFQDN(hostname)) {
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

  // KubeSail Ingress Controller
  keepAliveAgent = new http.Agent({
    keepAlive: true,
    maxSockets: 25,
    maxTotalSockets: 2048,
    maxFreeSockets: 256,
    timeout: 10000
  })

  reverseProxyTLSContexts = {}

  reverseProxy = httpProxy.createProxyServer({
    ws: true,
    http2: true,
    xfwd: true,
    toProxy: true,
    proxyTimeout: 10000,
    timeout: 10000,
    agent: this.keepAliveAgent
  })

  httpServer = http.createServer((req, res) => {
    res.writeHead(301, { Location: 'https://' + req.headers.host + req.url })
    res.end()
  })

  httpsServer = spdy.createServer(
    {
      key: fs.readFileSync(TLS_KEY_PATH, 'utf8'),
      cert: fs.readFileSync(TLS_CERT_PATH, 'utf8'),
      // honorCipherOrder: true,
      SNICallback: (domain, cb) => {
        for (const d in this.reverseProxyTLSContexts) {
          if (domain === d || domain.endsWith(d)) {
            logger.silly('SNICallback: Using certificate', { domain: d })
            return cb(null, this.reverseProxyTLSContexts[d])
          }
        }
        logger.silly('SNICallback: Using default certificate', {
          domain,
          ctxs: this.reverseProxyTLSContexts
        })
        cb(null, null)
      }
    },
    async (req, res) => {
      const result = await this.k8s.findServiceForRequest(req, res)
      if (result?.ip && result?.port) {
        const target = `${result.protocol || 'http'}://${result.ip}:${result.port}`
        this.reverseProxy.web(req, res, { target })
      } else if (!res.headersSent) {
        return res.end('KS_INTERNAL_ERROR_002 NO PROXY BACKEND\n\n')
      }
    }
  )

  // Websocket connection to the KubeSail Gateway
  gatewaySocket = null

  createGatewaySocket = () => {
    const connectionOptions = {}
    if (process.env.NODE_ENV === 'development') {
      connectionOptions.ca = fs.readFileSync(TLS_CERT_PATH)
      connectionOptions.insecure = true
      connectionOptions.rejectUnauthorized = false
    }
    const connectionString = [
      `https://${this.status.gatewayTargets[0]}`,
      KUBESAIL_AGENT_GATEWAY_PORT ? `:${KUBESAIL_AGENT_GATEWAY_PORT}` : '',
      `?initVersion=2&username=${KUBESAIL_AGENT_USERNAME || ''}&key=${KUBESAIL_AGENT_KEY || ''}&secret=${
        KUBESAIL_AGENT_SECRET || ''
      }&initialID=${KUBESAIL_AGENT_INITIAL_ID || NODE_NAME || ''}`
    ]
      .filter(Boolean)
      .join('')
    if (isIP(this.status.gatewayTargets[0])) {
      logger.warn(
        "Note, we're using a resolved IP address to connect to KubeSail, because DNS on this cluster appears to be non-operational! It is recommended that you enable DNS and restart the agent pod.",
        { resolvedGatewayTarget: this.status.gatewayTargets[0] }
      )
      connectionOptions.insecure = true
      connectionOptions.rejectUnauthorized = false
    }
    this.gatewaySocket = socketio(connectionString, {
      autoConnect: false,
      transports: ['websocket'],
      timeout: 5000,
      ...connectionOptions
    })
  }

  async init() {
    logger.info(`kubesail-agent starting in "${LOG_LEVEL}" mode`, { version: RELEASE })
    this.reverseProxy.on('proxyReq', function (proxyReq, _req, _res, _options) {
      // proxyReq.setHeader('X-Special-Proxy-Header', 'foobar');
    })
    this.httpsServer.on('upgrade', async (req, socket, head) => {
      const result = await this.k8s.findServiceForRequest(req)
      if (!result) {
        return socket.end()
      }
      this.reverseProxy.ws(req, socket, { ...head, target: `http://${result.ip}:${result.port}` })
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
      if (this.status.registered) {
        const kubeConfig = await this.k8s.generateKubeConfig()
        this.gatewaySocket.emit('config-response', { kubeConfig, assertUsers: false })
      }
    })
    await this.k8s.init()

    this.registerWithGateway().then(async () => {
      this.status.registered = true
      logger.info('KubeSail Agent registered and ready! KubeSail support information:', {
        clusterAddress: this.status.clusterAddress,
        agentKey: this.status.agentKey
      })
      try {
        await this.installCertificate('kube-system', 'k8g8-tls', this.status.clusterAddress)
      } catch (err) {
        if (err.code === 404) {
          this.features.k8g8Cert = false
          return
        } else throw err
      }
      await this.updateHostMap()
      this.k8s.watchResources()
      safeTimers.setInterval(() => {
        this.gatewaySocket.emit('health-check', this.generateHealthCheckData())
      }, 3 * 60 * 1000)
      safeTimers.setTimeout(() => {
        this.gatewaySocket.emit('health-check', this.generateHealthCheckData())
      }, 2500)
      this.getPublicIPAddress()
      safeTimers.setInterval(() => this.getPublicIPAddress(), 15 * 60 * 1000)
    })
  }

  generateHealthCheckData = () => {}

  kubesailApiRequest = (
    path /*: string */,
    method /*: string */ = 'POST',
    data /*: ?Object */,
    retries /*: ?number */ = 0,
    retryLimit /*: ?number */ = 0,
    timeout /*: ?number */ = 5000
  ) => {
    return new Promise((resolve, reject) => {
      const [KubeSailApiTarget, KubeSailApiPort] = KUBESAIL_API_TARGET.split(':')
      const options = {
        hostname: KubeSailApiTarget,
        headers: { 'Content-Type': 'application/json' },
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
    return (stream, { host }) => {
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
          targetHost,
          targetPort,
          firewall: this.firewall,
          clusterAddress: this.clusterAddress
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
      const socket = new net.Socket()
      socket.setTimeout(10000)
      socket.on('error', err => {
        if (err.code === 'EPIPE') return
        logger.warn('requestHandler: error on socket:', errObj(err))
        stream.end(`HTTP/1.1 500 KS_SOCKET_ERROR\n\n`)
        return socket.end()
      })
      stream.on('error', err => {
        if (err.message === 'stream.push() after EOF') {
          logger.debug('stream: stream.push() after EOF', errObj(err))
        } else {
          logger.warn('requestHandler: error on stream:', errObj(err))
        }
        return socket.end()
      })
      socket.on('close', () => stream.end())
      stream.on('close', () => socket.end())
      socket.connect(targetPort, targetHost, () => socket.pipe(stream).pipe(socket))
    }
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
          this.gatewaySocket.emit('config-response', {
            kubeConfig: await this.k8s.generateKubeConfig(),
            assertUsers: false
          })
        }
        resolve()
      })
      this.gatewaySocket.on('health-check', () => {
        logger.debug('Agent received health-check request!')
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
        this.gatewaySocket.emit('config-response', {
          kubeConfig: await this.k8s.generateKubeConfig(),
          assertUsers: true
        })
      })
      this.gatewaySocket.on('kube-watch', async ({ username, namespace, startOrStop }) => {
        if (startOrStop === 'start') {
          if (!this.usersWatchingEvents.find(u => u.namespace === namespace && u.username === username)) {
            logger.debug('User starting to watch namespace events', { username, namespace })
            this.usersWatchingEvents.push({ username, namespace })
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
          logger.silly('User no longer watching namespace events', { username, namespace })
          this.usersWatchingEvents = this.usersWatchingEvents.filter(
            u => u.username !== username && u.namespace !== namespace
          )
        }
      })
      this.gatewaySocket.on('connect', async () => {
        if (this.status.registered) {
          logger.info('Connected to KubeSail', { gateway: KUBESAIL_AGENT_GATEWAY_TARGET })
        }
        this.gatewaySocket.emit('init', { kubeConfig: await this.k8s.generateKubeConfig() })
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
        this.writeFramebufferAnimation('lib/agent/images/qr-scanned.gif')
      })
      this.gatewaySocket.on('set-credentials', async credentials => {
        const { agentKey, agentSecret, username } = credentials
        logger.info('Server claimed!', { username, agentKey })
        this.framebuffer.drawImage('lib/agent/images/qr-setup-configuring.png')
        try {
          const secretName = 'kubesail-agent'
          await this.k8s.client.api.v1
            .namespaces(process.env.POD_NAMESPACE || 'kubesail-agent')
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
            .namespaces(process.env.POD_NAMESPACE || 'kubesail-agent')
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
        if (!this.status.registerRejected) {
          logger.error('Gateway closed connection, reconnecting!', { reason })
          process.exit(1)
        }
      })
      this.gatewaySocket.on('connect_error', error => {
        logger.error(`Disconnected from KubeSail Gateway ("${error.description.message}") Reconnecting...`, {
          code: error.code || error.description.code,
          message: error.description.message,
          gateway: KUBESAIL_AGENT_GATEWAY_TARGET,
          port: KUBESAIL_AGENT_GATEWAY_PORT,
          resolved: this.status.gatewayTargets[0]
        })
        this.reconnect()
      })
      this.gatewaySocket.on('connect_timeout', timeout => {
        logger.error('gatewaySocket connect_timeout:', timeout)
        this.reconnect()
      })
      this.gatewaySocket.on('register-rejected', status => {
        this.status.registerRejected = true
        logger.error(
          'KubeSail agentKey and agentSecret rejected! Please re-install this agent at https://kubesail.com/clusters',
          { status }
        )
      })
      this.gatewaySocket.open()
    })
  }

  getPublicIPAddress() {}

  async installCertificate(namespace, secretName, hostname) {
    if (!namespace || !secretName || !hostname)
      throw new Error('invalid arguments passed to installCertificate')
    const secret = await this.k8s.client.api.v1.namespaces(namespace).secrets(secretName).get()
    if (secret) {
      logger.debug(
        `installCertificate: Installing TLS certificate from secret "${namespace}/${secretName}" for hostname "${hostname}"`
      )
      this.reverseProxyTLSContexts[hostname] = tls.createSecureContext({
        key: Buffer.from(secret.body.data['tls.key'], 'base64').toString('ascii'),
        cert: Buffer.from(secret.body.data['tls.crt'], 'base64').toString('ascii')
      })
      if (namespace === 'kube-system' && secretName === 'k8g8-tls') this.features.k8g8Cert = true
    }
  }

  currentHostMap = {}
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
            if (this.reverseProxyTLSContexts[host]) continue
            this.installCertificate(doc.metadata.namespace, cert.secretName, host).catch(err => {
              if (err.code === 404) {
                logger.debug(
                  `installCertificate: Failed to find secret "${doc.metadata.namespace}/${cert.secretName}" referenced by ingress "${doc.metadata.namespace}/${doc.metadata.name}"`
                )
              } else throw err
            })
          }
        }
        for (const rule of doc?.spec?.rules || []) {
          desiredHostMap[rule.host] = doc?.metadata?.annotations?.['kubesail.com/firewall'] || '0.0.0.0/0'
        }
      })
    if (_.isEqual(desiredHostMap, this.currentHostMap)) return
    this.dbus.writeAvahiHosts()
    this.currentHostMap = desiredHostMap
    const { res, body } = await this.kubesailApiRequest('/agent/host-mapping-request', 'POST', {
      agentKey: KUBESAIL_AGENT_KEY,
      agentSecret: KUBESAIL_AGENT_SECRET,
      desiredIngressMap: desiredHostMap
    })
    if (!body) return
    try {
      const json = JSON.parse(body)
      if (res.statusCode !== 200) {
        logger.debug('updateHostMap: Failed to set hostnames:', {
          response: json,
          desiredHostMap,
          statusCode: res.statusCode
        })
        return
      }
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
    findServiceForRequest: async (req, res) => {
      const host = (req.headers.host || '').split(':')[0]
      // Bot / malice detection
      const isBot = isbot(req.headers['user-agent'])
      if (isBot) {
        logger.debug('requestHandler: rejecting request, detected bot')
        if (res) {
          res.writeHead(404, { 'Content-Type': 'text/plain' })
          return res.end('Sorry, no bots allowed')
        } else return
      }
      // Find ingress matching this rule
      const ingress = this.docs.find(i => i.kind === 'Ingress' && i.spec.rules.find(r => r.host === host))
      const rule = (ingress?.spec?.rules || []).find(r => r.host === host)
      if (!ingress || !rule) {
        logger.debug('requestHandler: No app is installed at this address', {
          host,
          rule: !!rule,
          ingress: !!ingress
        })
        if (res) {
          res.writeHead(404, { 'Content-Type': 'text/plain' })
          return res.end('No app is installed at this address')
        } else return
      }
      // Basic auth
      const annotations = ingress?.metadata?.annotations || {}
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
            s.kind === 'Service' &&
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
            `requestHandler: Ingress contained ingress.kubernetes.io/auth-secret annotation but I couldn't find the specified secret, or it didn't contain a 'data.auth' key.`
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
          ingNamespace: ingress.metadata.namespace
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
        return (
          selectorKeys.filter(
            key => (service?.spec?.selector || {})[key] === (e?.metadata?.labels || {})[key]
          ).length === selectorKeys.length
        )
      })
      if (!endpoint?.subsets || endpoint.subsets.length === 0 || endpoint.subsets[0].addresses.length === 0) {
        if (res) {
          res.writeHead(404, { 'Content-Type': 'text/html' })
          fs.createReadStream('lib/agent/static/launching.html').pipe(res)
        }
        return
      }
      // Determine service backend
      const servicePort = path?.backend?.service?.port?.number || path?.backend?.service?.port?.name
      const port = service.spec.ports.find(p => p.name === servicePort || p.port === servicePort)
      // Note that we use the service's IP instead of the endpoint's IP
      // This is because we want to make sure that we let Kubernetes handle the networking complexity as much as possible
      // This is effectively the difference between talking to kube-proxy and talking to the container port directly
      // kube-proxy incurs some performance cost, but adds a lot of resilience! Thanks to @kalaspuffar for this recommendation!
      return { port: port.port, ip: service.spec.clusterIP }
    },
    watchResources: () => {
      const connect = async (group, version, kind) => {
        const options = {
          qs: {
            resourceVersion: this.status.watchAllResourceVersion,
            timeoutSeconds: 21600
          }
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
        if (!stream) {
          return logger.error('watchAll Unable to watch resource', { group, kind, version })
        }
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
              clearTimeout(reconnectTimeout)
              connect(group, version, kind)
            }, 100)
          }
        }
        stream.on('error', function (err) {
          if (err.message === 'aborted') return
          logger.error('watchAll stream error', { group, kind, version, errMsg: err.message })
        })
        stream.on('disconnect', function () {
          logger.debug('watchAll stream disconnect', { group, kind, version })
          reconnect()
        })
        stream.on('end', function () {
          logger.debug('watchAll stream end', { group, kind, version })
          reconnect()
        })
        stream.on('pause', () => logger.info('watchAll stream pause'))
        stream.on('data', async event => {
          if (event.type === 'ERROR') {
            if (event.object.code === 410) {
              // 410 === Expired (resource version too old)
              this.status.watchAllResourceVersion = undefined
            } else logger.error('watchAll error', { group, version, kind, event })
            reconnect()
            return stream.destroy()
          } else if (event.status === 'Failure') {
            let errorLevel = 'error'
            if (kind.toLowerCase() === 'ingress' && version === 'v1') errorLevel = 'debug'
            logger[errorLevel]('Watch stream Failure!', { group, version, kind, event })
            lastErrorSeen = event.code
            reconnect()
            return stream.destroy()
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
          const eventKind = event.object.kind
          const eventName = event.object.metadata.name
          const eventNamespace = event.object.metadata.namespace

          this.k8s.filterResourceValues(event.object)

          // Track selected resources in this.docs
          let madeChange = false
          if (['Ingress', 'Service', 'Endpoints'].includes(eventKind)) {
            if (event.type === 'ADDED') {
              const exists = this.docs.find(
                d => d.metadata.name === eventName && d.metadata.namespace === eventNamespace
              )
              if (!exists) {
                madeChange = true
                this.docs.push(event.object)
              }
            } else if (event.type === 'MODIFIED') {
              const newPile = this.docs.map(d => {
                if (
                  d.metadata.name === eventName &&
                  d.metadata.namespace === eventNamespace &&
                  parseInt(event.object.metadata.resourceVersion, 10) >
                    parseInt(d.metadata.resourceVersion, 10)
                ) {
                  madeChange = true
                  return event.object
                } else {
                  return d
                }
              })
              if (madeChange) {
                this.docs = newPile
              }
            } else if (event.type === 'DELETED') {
              const newPile = this.docs.filter(
                d => d.metadata.name !== eventName && d.metadata.namespace !== eventNamespace
              )
              if (newPile.length < this.docs.length) madeChange = true
              this.docs = newPile
            }
          }

          if (eventKind === 'Secret') {
            if (eventNamespace === 'kube-system' && eventName === 'k8g8-tls') {
              if (event.type === 'ADDED') {
                this.reverseProxyTLSContexts[this.status.clusterAddress] = tls.createSecureContext({
                  key: Buffer.from(event.object.data['tls.key'], 'base64').toString('ascii'),
                  cert: Buffer.from(event.object.data['tls.crt'], 'base64').toString('ascii')
                })
                this.features.k8g8Cert = true
              } else if (event.type === 'DELETED') {
                this.features.k8g8Cert = false
                this.reverseProxyTLSContexts[this.status.clusterAddress] = null
              }
            }
          } else if (eventKind === 'Deployment') {
            const appLabel = (event.object?.metadata?.annotations || {})['kubesail.com/template']
            if (appLabel) {
              if (event.type === 'ADDED') {
                const created = new Date(event.object.metadata.creationTimestamp)
                if (madeChange && created > this.status.startupDate) {
                  logger.info('Installing KubeSail Template!', {
                    event: event.type,
                    app: appLabel,
                    namespace: eventNamespace
                  })
                  this.framebuffer.drawLogo(appLabel)
                }
              }
            }
          } else if (eventKind === 'Ingress') {
            if (madeChange && this.status.registered) this.updateHostMap()
          } else if (eventKind === 'Endpoints') {
            return
          }
          // Send selected events to KubeSail
          if (
            this.usersWatchingEvents.find(u => u.namespace === eventNamespace) &&
            this.filterKubeEvents(event)
          ) {
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
          } else logger.silly('Dropping event:', { event })
        })
      }
      DOCUMENTS_TO_WATCH.forEach(async doc => await connect(doc.group, doc.version, doc.kind.toLowerCase()))
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
          this.writeFramebufferImage(imageFile)
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
              logger.debug('PiBox Framebuffer response:', { path, status: res.statusCode })
              resolve()
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
