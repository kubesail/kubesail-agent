// @flow

const net = require('net')
const fs = require('fs')
const path = require('path')
const http = require('http')
const https = require('https')
const url = require('url')
const { promisify } = require('util')
const dns = require('dns')
const { Client } = require('kubernetes-client')
const socketio = require('socket.io-client')
const socketioStream = require('socket.io-stream')
const { isEqual } = require('lodash')
const { isIP, isFQDN } = require('validator')
const dbus = require('dbus-next')
const toASCII = require('punycode').toASCII

const logger = require('../shared/logger')
const { initProm } = require('../shared/prom')
const { sampleArray, kubesailApiRequest, loadSpec } = require('../shared')
const {
  KUBESAIL_AGENT_HTTP_LISTEN_PORT,
  KUBESAIL_AGENT_GATEWAY_TARGET,
  KUBESAIL_AGENT_GATEWAY_PORT,
  KUBESAIL_AGENT_INITIAL_ID,
  KUBESAIL_AGENT_USERNAME,
  KUBESAIL_AGENT_KEY,
  KUBESAIL_AGENT_EMAIL,
  KUBESAIL_AGENT_SECRET,
  ADDITIONAL_CLUSTER_HOSTNAMES,
  TLS_KEY_PATH,
  TLS_CERT_PATH,
  INGRESS_CONTROLLER_NAMESPACE,
  INGRESS_CONTROLLER_ENDPOINT,
  INGRESS_CONTROLLER_PORT_HTTP,
  INGRESS_CONTROLLER_PORT_HTTPS,
  METRICS_SERVER_ENDPOINT,
  INTERNAL_HTTPS_RESPONDER_PORT_503,
  LOG_LEVEL,
  DOCUMENTS_TO_WATCH,
  KUBESAIL_API_TARGET,
  NODE_NAME,
  RELEASE
} = require('../shared/config')

const WATCH_STREAM_TIMEOUT_SECONDS = 21600
const KUBERNETES_SPEC_VERSION = '1.22'

const resolver = new dns.Resolver()
const resolve4 = promisify(resolver.resolve4).bind(resolver)
let resolvedGatewayTarget = KUBESAIL_AGENT_GATEWAY_TARGET
let warnedAboutMissingCertManager = false
const systemBus = dbus.systemBus()

let dbusAvailable = true
systemBus.on('error', err => {
  if (err.code === 'ENOENT') {
    logger.warn(
      'Unable to publish ".local" DNS addresses to your network. Please install `avahi-daemon` and restart the agent!'
    )
  } else {
    if (err.type && err.type === 'org.freedesktop.DBus.Error.AccessDenied') {
      logger.warn(
        'An SELinux policy is preventing us from access DBUS. mDNS (.local dns names) will not work.',
        {
          type: err.type,
          error: err.text
        }
      )
    } else {
      logger.error('Unknown DBUS error! Please report to KubeSail:', err)
    }
  }
  dbusAvailable = false
})

if (!fs.existsSync(TLS_CERT_PATH)) {
  throw new Error(`TLS_CERT_PATH ${TLS_CERT_PATH} does not exist! Exiting!`)
}

const connectionOptions = {}
if (process.env.NODE_ENV === 'development') {
  connectionOptions.ca = fs.readFileSync(TLS_CERT_PATH)
  connectionOptions.insecure = true
  connectionOptions.rejectUnauthorized = false
}

const dnsLookup = (hostname, _opts, cb) => {
  if (isFQDN(hostname)) {
    resolve4(hostname).then(results => {
      const host = sampleArray(results)
      cb(null, host, 4)
    })
  } else {
    dns.lookup(hostname, { all: true }, (err, results) => {
      if (err) throw err
      if (results[0]) {
        cb(null, results[0].address, results[0].family)
      } else {
        throw new Error('Unable to resolve api DNS')
      }
    })
  }
}

class KsAgent {
  // Used to track resources in the cluster we're in.
  // Endpoints are tracked to follow the ingress controller we'll be passing traffic to
  // Services will be tracked in the future to pass traffic directly, rather than using an ingress controller (ie: we'll be the ingress controller)
  // Certificates will be tracked so that we can possibly provide totally valid HTTPS end-to-end without using the SNI tricks.
  resources /*: { endpoints: Array<Object>, services: Array<Object>, certificates: Array<Object> } */ =
    {
      ingresses: [],
      endpoints: [],
      services: [],
      certificates: []
    }

  features = {
    // metrics: boolean: set to true if we detect metrics-server is installed
    // required for some metrics, graphs, various panels in KubeSail dashboard
    metrics: false,

    // ingressController: boolean: set to true if we detect an ingress controller on this system
    ingressController: false,

    // defaultIngressClass: string: name of the ingress class to auto-append to Ingresses.
    // If there are IngressClasses, we'll save to the default class so we can append it automatically
    // Note that it -should- be automatically appended, but not all mutation controllers work properly
    defaultIngressClass: '',

    // certManager: boolean: set to true if we detect cert-manager is installed and working properly
    certManager: false,

    // k8g8Cert: false or string: set to either false if no k8g8 wildcard certificate has been installed
    // Or set to the expiration time of the certificate (if a renewal is required)
    k8g8Cert: false,

    // mDNS: set to true if we're able to write to DBUS and have AVAHI installed
    mDNS: dbusAvailable
  }

  ingressControllerEndpoint = null
  ingressControllerNamespace = null

  // Indicates agent is ready to take traffic
  // will fail health-checks when false-y (used mainly to prevent receiving traffic before we're ready)
  agentReady = false

  // Will be set to true if our registration has been rejected by the API. We'll need to be updated!
  registerRejected = false

  // A 'kubernetes-client' connection to the cluster we're located in, using our in-pod service account
  k8sClient = new Client({ version: KUBERNETES_SPEC_VERSION })

  // Our socket with a KubeSail Gateway instance
  gatewaySocket = null

  // The DNS name of our cluster from the internet - retrieved from agent-data
  clusterAddress /*: string */ = ''

  // Domains the gateway will be forwarding to us (and its firewall configuration)
  firewall /* Object */ = {}

  // Users currently watching resources via agent-kube-watch
  usersWatchingEvents = []

  // Currently using fallback DNS servers
  usingFallbackResolver = false

  // If we cant find an ingress controller, but it appears that NODE_IP:INGRESS_CONTROLLER_PORT_HTTPS is open, we'll forward traffic there
  // This covers the common `microk8s enable ingress` use-case
  useNodeIPRouting = false

  // The Agent's http server is primarily used for health-checks and nothing more
  http = http.createServer((_req, res) => {
    if (this.agentReady) {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('OK')
    } else {
      res.writeHead(503, { 'Content-Type': 'text/plain' })
      res.end('Not Healthy')
    }
  })

  // Used when we don't have a valid backend target for an HTTPS request
  agentHttpsReplier = https.createServer(
    {
      key: fs.readFileSync(TLS_KEY_PATH), // eslint-disable-line
      cert: fs.readFileSync(TLS_CERT_PATH), // eslint-disable-line
      honorCipherOrder: true
    },
    (_req, res) => {
      res.writeHead(503, { 'Content-Type': 'text/plain' })
      res.end(this.nextReplierMessage || 'No ingress controller found!')
    }
  )

  constructor() {
    this.http.on('error', function serverErrorHandler(error /*: Error */) {
      throw error
    })
    const cleanup = () => {
      for (const hostname in this.localHostnameAvahiGroups) {
        this.localHostnameAvahiGroups[this.localHostnameAvahiGroups[hostname]].Reset()
        this.localHostnameAvahiGroups[this.localHostnameAvahiGroups[hostname]].Free()
      }
      // systemBus.disconnect()
      process.exit(0)
    }
    process.on('SIGTERM', cleanup)
    process.on('SIGINT', cleanup)
  }

  async setResolver() {
    let resolved
    try {
      if (!isFQDN(KUBESAIL_AGENT_GATEWAY_TARGET)) {
        logger.silly('Skipping setResolver: KUBESAIL_AGENT_GATEWAY_TARGET is not an FQDN', {
          KUBESAIL_AGENT_GATEWAY_TARGET
        })
        return
      }
      resolved = await resolve4(KUBESAIL_AGENT_GATEWAY_TARGET)
      logger.silly('Successfully resolved DNS address for agent target', { resolved })
      if (this.usingFallbackResolver && resolved) {
        resolvedGatewayTarget = sampleArray(resolved)
      }
    } catch (err) {
      if (this.usingFallbackResolver) throw err
      logger.error(
        'Unable to resolve DNS! Falling back to CloudFlare DNS as backup! Please check your cluster for DNS capabilities!',
        { errMsg: err.message, code: err.code }
      )
      this.usingFallbackResolver = true
      resolver.setServers([sampleArray(['1.1.1.1', '1.0.0.1', '8.8.8.8'])])
      return this.setResolver()
    }
  }

  // Starts the Agent service, connects tunnels and marks agentReady when ready.
  async init() {
    logger.info(`kubesail-agent starting in ${LOG_LEVEL} mode!`, {
      version: RELEASE,
      gateway: [resolvedGatewayTarget, KUBESAIL_AGENT_GATEWAY_PORT].filter(Boolean).join(':')
    })
    initProm()

    await this.setResolver()
    const connectionString = [
      `https://${resolvedGatewayTarget}`,
      KUBESAIL_AGENT_GATEWAY_PORT ? `:${KUBESAIL_AGENT_GATEWAY_PORT}` : '',
      `?initVersion=2&username=${KUBESAIL_AGENT_USERNAME || ''}&key=${
        KUBESAIL_AGENT_KEY || ''
      }&secret=${KUBESAIL_AGENT_SECRET || ''}&initialID=${
        KUBESAIL_AGENT_INITIAL_ID || NODE_NAME || ''
      }`
    ]
      .filter(Boolean)
      .join('')

    if (isIP(resolvedGatewayTarget)) {
      logger.warn(
        "Note, we're using a resolved IP address to connect to KubeSail, because DNS on this cluster appears to be non-operational! It is recommended that you enable DNS and restart the agent pod.",
        { resolvedGatewayTarget }
      )
      connectionOptions.insecure = true
      connectionOptions.rejectUnauthorized = false
    }
    logger.silly('Connecting to Kubernetes API...', {
      baseUrl: this.k8sClient.backend.requestOptions.baseUrl
    })
    const spec = await this.k8sClient.backend.http({ method: 'GET', pathname: '/openapi/v2' })
    if (spec.statusCode !== 200) {
      throw new Error(
        'Invalid response from Kubernetes - possibly the cluster is not healthy? Cannot continue :('
      )
    }
    try {
      this.k8sClient._addSpec(spec.body)
    } catch (err) {
      logger.error('Failed to load Cluster Spec!', { errMsg: err.message, name: err.name })
    }
    await this.findIngressClassName()

    this.agentHttpsReplier.listen(INTERNAL_HTTPS_RESPONDER_PORT_503, '127.0.0.1')
    this.http.listen(KUBESAIL_AGENT_HTTP_LISTEN_PORT)

    this.gatewaySocket = socketio(connectionString, {
      autoConnect: false,
      transports: ['websocket'],
      timeout: 5000,
      ...connectionOptions
    })
    let connectedToGateway

    // Note that this does not fire initially, only when the file actually changes after-the-fact
    fs.watchFile('/var/run/secrets/kubernetes.io/serviceaccount/token', () => {
      logger.debug(
        'ServiceAccount Token has changed! Emitting refreshed authentication (config-response) to KubeSail'
      )
      this.k8sClient = new Client({ version: KUBERNETES_SPEC_VERSION })
      if (connectedToGateway) {
        this.gatewaySocket.emit('config-response', {
          kubeConfig: this.generateKubeConfig(),
          assertUsers: false
        })
      }
    })

    await this.findK8g8Certificate()

    logger.silly('Registering with KubeSail...')
    // Note that this promise does not resolve until we've been verified, which may never happen!
    this.registerWithGateway().then(async () => {
      await this.checkPublicIP()
      connectedToGateway = true
      logger.info('KubeSail Agent registered and ready! KubeSail support information:', {
        clusterAddress: this.clusterAddress,
        agentKey: this.agentKey
      })
      this.gatewaySocket.emit('health-check', this.healthCheckData())
      setInterval(async () => {
        this.gatewaySocket.emit('health-check', this.healthCheckData())
      }, 120000)
      setInterval(async () => {
        await this.checkPublicIP()
      }, 15 * 60 * 1000)
    })
  }

  healthCheckData(data = {}) {
    return {
      usingFallbackResolver: this.usingFallbackResolver,
      agentVersion: RELEASE,
      myPublicIP: this.myPublicIP,
      features: this.features,
      ...data
    }
  }

  async checkPublicIP() {
    try {
      const resp = await kubesailApiRequest({
        method: 'PUT',
        path: '/whatsmyip',
        lookup: dnsLookup,
        headers: {
          username: KUBESAIL_AGENT_USERNAME,
          'agent-key': KUBESAIL_AGENT_KEY,
          'agent-secret': KUBESAIL_AGENT_SECRET
        }
      })
      this.myPublicIP = resp.json.ip
    } catch (err) {
      console.error(
        'Failed to fetch current public IP address! Possibly we have no internet connection?',
        err.message
      )
    }
  }

  watchAllResourceVersion = undefined
  async watchAll(docsToWatch /*: Array<Object> */) {
    const connect = async (group, version, kind) => {
      const options = {
        qs: {
          resourceVersion: this.watchAllResourceVersion,
          timeoutSeconds: WATCH_STREAM_TIMEOUT_SECONDS
        }
      }
      let stream
      if (group === 'core') {
        stream = await this.k8sClient.api[version].watch[kind].getObjectStream(options)
      } else {
        const baseApi = this.k8sClient.apis[group][version]
          ? this.k8sClient.apis[group][version]
          : this.k8sClient.apis[group].v1beta1
        if (
          baseApi &&
          baseApi.watch &&
          baseApi.watch[kind] &&
          baseApi.watch[kind].getObjectStream
        ) {
          stream = await baseApi.watch[kind].getObjectStream(options)
        }
      }
      if (!stream) {
        logger.error('watchAll Unable to watch resource', { group, kind, version })
        return
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
      stream.on('pause', function () {
        logger.info('watchAll stream pause')
      })
      stream.on('data', async event => {
        if (event.type === 'ERROR') {
          if (event.object.code === 410) {
            // 410 === Expired (resource version too old)
            this.watchAllResourceVersion = undefined
          } else {
            logger.error('watchAll error', { group, version, kind, event })
          }
          reconnect()
          return stream.destroy()
        }
        if (event.status === 'Failure') {
          let errorLevel = 'error'
          if (kind.toLowerCase() === 'ingress' && version === 'v1') {
            errorLevel = 'debug'
          }
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
        if (!this.watchAllResourceVersion || newVersion > this.watchAllResourceVersion) {
          this.watchAllResourceVersion = newVersion
        }
        const eventKind = event.object.kind
        const eventName = event.object.metadata.name
        const eventNamespace = event.object.metadata.namespace

        if (
          eventKind === 'Secret' &&
          eventNamespace === 'kube-system' &&
          eventName === 'k8g8-tls'
        ) {
          if (event.type === 'ADDED') {
            this.features.k8g8Cert = true
            this.setK8g8CertAsDefault()
          } else if (event.type === 'DELETED') {
            this.features.k8g8Cert = false
          }
        }

        if (eventKind === 'Namespace' && eventName === 'cert-manager') {
          if (event.type === 'ADDED') {
            this.features.certManager = true
            setTimeout(async () => {
              await this.refreshClientSpec()
              this.installCertIssuer()
            }, 60000)
          } else if (event.type === 'DELETED') {
            this.features.certManager = false
          }
          logger.debug('Emitting health-check due to detected cert-manager change')
          this.gatewaySocket.emit('health-check', this.healthCheckData())
        }

        // Keep track of Ingresses across the system
        if (eventKind === 'Ingress') {
          if (event.type === 'ADDED') {
            logger.debug('watchForIngresses: Detected new ingress:', { eventName, eventNamespace })
            const exists = this.resources.ingresses.find(
              ing => ing.metadata.name === eventName && ing.metadata.namespace === eventNamespace
            )
            if (!exists) this.resources.ingresses.push(event.object)
          } else if (event.type === 'MODIFIED') {
            this.resources.ingresses = this.resources.ingresses.map(ing => {
              if (ing.metadata.name === eventName && ing.metadata.namespace === eventNamespace) {
                return event.object
              }
              return ing
            })
          } else if (event.type === 'DELETED') {
            this.resources.ingresses = this.resources.ingresses.filter(
              ing => ing.metadata.name !== eventName && ing.metadata.namespace !== eventNamespace
            )
          }
          await this.setIngressHostnames()
        }

        if (eventKind === 'Service') {
          if (event.type === 'ADDED') {
            const exists = this.resources.services.find(
              svc => svc.metadata.name === eventName && svc.metadata.namespace === eventNamespace
            )
            if (!exists) this.resources.services.push(event.object)
          } else if (event.type === 'MODIFIED') {
            this.resources.services = this.resources.services.map(svc => {
              if (svc.metadata.name === eventName && svc.metadata.namespace === eventNamespace) {
                return event.object
              }
              return svc
            })
          } else if (event.type === 'DELETED') {
            this.resources.services = this.resources.services.filter(
              svc => svc.metadata.name !== eventName && svc.metadata.namespace !== eventNamespace
            )
          }
        }

        // Keep track of selected Endpoints (metrics, ingress-controller, etc)
        if (eventKind === 'Endpoint') {
          if (INGRESS_CONTROLLER_ENDPOINT.split(',').includes(eventName)) {
            if (event.type === 'ADDED' || event.type === 'MODIFIED') {
              logger.debug('findIngressControllerEndpoints: Setting ingress controller endpoint', {
                eventNamespace,
                eventName
              })
              await this.setIngressControllerEndpoint(event.object)
            } else if (event.type === 'DELETED') {
              this.ingressControllerNamespace = null
              this.ingressControllerEndpoint = null
              logger.debug('Emitting health-check due to detected ingress-controller deleted')
              this.gatewaySocket.emit('health-check', this.healthCheckData())
            }
          }
          if (
            eventNamespace === 'kube-system' &&
            METRICS_SERVER_ENDPOINT.split(',').includes(eventName)
          ) {
            if (event.type === 'ADDED') {
              await this.setMetricsServerEndpoint(event.object)
            } else if (event.type === 'DELETED') {
              this.features.metrics = false
              logger.debug('Emitting health-check due to detected metrics-server deleted')
              this.gatewaySocket.emit('health-check', this.healthCheckData())
            }
          }
          return
        }

        // Send selected events to KubeSail
        if (
          this.usersWatchingEvents.find(u => u.namespace === eventNamespace) &&
          this.filterKubeEvents(event)
        ) {
          delete event.object.metadata.managedFields
          try {
            await this.apiRequest('/agent/event', 'POST', {
              agentKey: KUBESAIL_AGENT_KEY,
              agentSecret: KUBESAIL_AGENT_SECRET,
              event,
              retryLimit: 0,
              timeout: 1000
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
    docsToWatch.forEach(async doc => await connect(doc.group, doc.version, doc.kind.toLowerCase()))
  }

  filterKubeEvents = event => {
    const debugInfo = {
      type: event.type,
      kind: event.object.kind,
      name: event.object.metadata.name,
      namespace: event.object.metadata.namespace
    }
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
        // logger.silly('watchAll: not sending event:', debugInfo)
        return false
      } else {
        logger.silly('watchAll: sending event:', debugInfo)
      }
      return true
    }
    return false
  }

  apiRequest = (
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
            return setTimeout(() => {
              resolve(this.apiRequest(path, method, data, ++retries))
            }, (retries + 1) * 1000)
          }
        }
        reject(new Error(`Failed to post to KubeSail API: ${method} ${path}`))
      }
      const req = https.request({ ...options, path, lookup: dnsLookup }, res => {
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

  reconnectionCount = 0
  reconnectTimeout = null
  reconnect = async (time = 2000) => {
    this.reconnectionCount = this.reconnectionCount + 1
    time = Math.min(
      time + Math.floor(Math.random() * Math.floor(time)) * this.reconnectionCount,
      8000
    )
    if (this.reconnectTimeout) clearInterval(this.reconnectTimeout)
    this.reconnectTimeout = setTimeout(() => this.gatewaySocket.open(), time)
  }

  generateKubeConfig() {
    // Read the mounted service account credentials and build a kube config object to send back to KubeSail
    // Adapted from https://github.com/godaddy/kubernetes-client/blob/0f9ec26b381c8603e7727c3346edb35e1db2deb1/backends/request/config.js#L143
    const root = '/var/run/secrets/kubernetes.io/serviceaccount/'
    const caPath = path.join(root, 'ca.crt')
    const tokenPath = path.join(root, 'token')
    const namespacePath = path.join(root, 'namespace')

    const ca = fs.readFileSync(caPath, 'utf8')
    const token = fs.readFileSync(tokenPath, 'utf8')
    const namespace = fs.readFileSync(namespacePath, 'utf8')

    const cluster = { 'certificate-authority-data': ca, server: this.clusterAddress }
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

  writeHeader(
    socket /*: net.Socket */,
    data /*: Buffer */,
    code /*: number */,
    protocol /*: string */ = 'http',
    message /*: string */
  ) {
    const portMap = { 503: INTERNAL_HTTPS_RESPONDER_PORT_503 }
    if (protocol === 'http') {
      socket.end(`HTTP/1.1 ${code} ${message}\n\n`)
    } else {
      this.nextReplierMessage = message
      const tunnelToResponder = new net.Socket()
      tunnelToResponder.setTimeout(3000)
      tunnelToResponder.connect(portMap[code] || portMap['503'], '127.0.0.1')
      tunnelToResponder.write(data)
      tunnelToResponder.pipe(socket).pipe(tunnelToResponder)
      socket.on('close', () => tunnelToResponder.end())
      tunnelToResponder.on('close', () => socket.end())
    }
  }

  // Registers with the KubeSail Gateway and establishes a proxy socket
  async registerWithGateway() {
    return new Promise((resolve, reject) => {
      const requestHandler =
        protocol =>
        (stream, { host }) => {
          let port = INGRESS_CONTROLLER_PORT_HTTP
          if (protocol === 'https') port = INGRESS_CONTROLLER_PORT_HTTPS
          let proxyTarget
          if (host === this.clusterAddress || ADDITIONAL_CLUSTER_HOSTNAMES.includes(host)) {
            const uri = new url.URL(this.k8sClient.backend.requestOptions.baseUrl)
            proxyTarget = uri.host
            port = uri.port || INGRESS_CONTROLLER_PORT_HTTPS
            logger.silly('Forwarding request to Kubernetes API', {
              proxyTarget,
              port,
              host,
              uri,
              firewall: this.firewall,
              clusterAddress: this.clusterAddress
            })
          } else if (this.firewall[host]) {
            if (this.resources.endpoints.length) {
              const endpoint = sampleArray(this.resources.endpoints)
              proxyTarget = endpoint.ip
              port = endpoint.http || INGRESS_CONTROLLER_PORT_HTTP
              if (protocol === 'https') port = endpoint.https || INGRESS_CONTROLLER_PORT_HTTPS
            } else if (this.useNodeIPRouting && process.env.NODE_IP) {
              proxyTarget = process.env.NODE_IP
            } else {
              logger.warn(
                'Received request, but no Ingress controller was found! You can install one on KubeSail.com in your cluster settings page.',
                { host }
              )
              this.findIngressControllerEndpoints(null, true)
              return stream.once('data', data => {
                this.writeHeader(stream, data, 503, protocol, 'KS_AGENT_NO_INGRESS_CONTROLLER')
              })
            }
            logger.silly('Forwarding request to Ingress Controller', {
              proxyTarget,
              port,
              host,
              clusterAddress: this.clusterAddress
            })
          }
          if (!proxyTarget) {
            logger.debug('Invalid domain provided', {
              host,
              proxyTarget,
              firewall: this.firewall
            })
            return stream.once('data', data => {
              this.writeHeader(stream, data, 503, protocol, 'KS_AGENT_INVALID_DOMAIN')
            })
          }
          const socket = new net.Socket()
          socket.setTimeout(10000)
          socket.connect(port, proxyTarget, () => {
            socket.pipe(stream).pipe(socket)
          })
          socket.on('close', () => {
            try {
              stream.end()
            } catch (err) {
              logger.error('requestHandler: failed to close stream on socket close', {
                host,
                proxyTarget,
                errMsg: err.message,
                name: err.name
              })
            }
          })
          stream.on('close', () => {
            try {
              socket.end()
            } catch (err) {
              logger.error('requestHandler: failed to close socket on stream close', {
                host,
                proxyTarget,
                errMsg: err.message,
                name: err.name
              })
            }
          })
          socket.on('error', err => {
            if (err.message === 'Connection aborted') return socket.end()
            if (err.message.includes('EHOSTUNREACH')) {
              this.findIngressControllerEndpoints(null, true)
            }
            logger.warn('requestHandler: error on socket:', {
              host,
              proxyTarget,
              errMsg: err.message,
              name: err.name
            })
            stream.end()
          })
          stream.on('error', err => {
            if (err.message === 'Connection aborted') return socket.end()
            else if (err.message === 'stream.push() after EOF') {
              logger.debug('stream: stream.push() after EOF', {
                host,
                proxyTarget,
                errMsg: err.message,
                name: err.name
              })
              return socket.end()
            }
            logger.warn('requestHandler: error on stream:', {
              host,
              proxyTarget,
              errMsg: err.message,
              name: err.name
            })
            socket.end()
          })
        }

      socketioStream(this.gatewaySocket).on('http', requestHandler('http'))
      socketioStream(this.gatewaySocket).on('https', requestHandler('https'))

      this.gatewaySocket.on('agent-data', async agentData => {
        logger.debug('Agent received new agent-data from gateway!', {
          clusterAddress: agentData.clusterAddress,
          firewall: agentData.firewall,
          email: agentData.email
        })
        this.clusterAddress = agentData.clusterAddress
        this.agentKey = agentData.agentKey
        this.firewall = agentData.firewall
        this.email = agentData.email
        let encounteredError = false

        if (!this.agentReady) {
          let namespaces
          try {
            namespaces = await this.k8sClient.api.v1.namespaces.get()
          } catch (err) {
            encounteredError = err
            logger.error(
              'Failed to fetch namespaces! Agent unable to continue provisioning. Possibly this cluster does not allow us to gain cluster-admin access? Please report this error to KubeSail.com!',
              { errMsg: err.message, code: err.code }
            )
            // TODO: We should ideally emit a message to the socket about the error we encountered, so we can show a friendlier message on the front-end
          }
          if (namespaces) {
            await this.findCertManagerNamespace(namespaces)
            await this.findIngressControllerEndpoints(namespaces)
            await this.findMetricsServerEndpoints()
            await this.findIngresses()
            await this.watchAll(DOCUMENTS_TO_WATCH)
            this.agentReady = true
          }
        }
        if (!encounteredError) {
          if (agentData.refreshCredentials) {
            logger.debug('Agent asked to refresh credentials')
            this.gatewaySocket.emit('config-response', {
              kubeConfig: this.generateKubeConfig(),
              assertUsers: false
            })
          }
          this.setIngressHostnames()
          resolve()
        }
      })

      this.gatewaySocket.on('health-check', () => {
        logger.debug('Agent received health-check request!')
        this.gatewaySocket.emit('health-check', this.healthCheckData())
      })

      this.gatewaySocket.on('removed', () => {
        logger.error(
          'Agent has been removed from KubeSail - please uninstall me! kubectl delete -f https://byoc.kubesail.com/uninstall.yaml'
        )
        this.removed = true
        this.gatewaySocket.close()
      })

      this.gatewaySocket.on('config-request', () => {
        logger.debug('Received config-request', { clusterAddress: this.clusterAddress })
        this.gatewaySocket.emit('config-response', {
          kubeConfig: this.generateKubeConfig(),
          assertUsers: true
        })
      })

      this.gatewaySocket.on('kube-watch', ({ username, namespace, startOrStop }) => {
        if (startOrStop === 'start') {
          if (
            !this.usersWatchingEvents.find(
              u => u.namespace === namespace && u.username === username
            )
          ) {
            logger.debug('User starting to watch namespace events', { username, namespace })
            this.usersWatchingEvents.push({ username, namespace })
          }
        } else {
          logger.silly('User no longer watching namespace events', { username, namespace })
          this.usersWatchingEvents = this.usersWatchingEvents.filter(
            u => u.username !== username && u.namespace !== namespace
          )
        }
      })

      this.gatewaySocket.on('connect', () => {
        logger.info('Connected to KubeSail', { gateway: KUBESAIL_AGENT_GATEWAY_TARGET })
        this.gatewaySocket.emit('init', { kubeConfig: this.generateKubeConfig() })
      })
      this.gatewaySocket.on('error', error => {
        throw new Error(`Gateway Socket Errored! Reason: "${error.description.code}"`)
      })
      // Fired by gateway when we're pending verification
      // The presence of a pendingKey implies we're waiting to be claimed
      // If we're pending verification with an agent key/secret, we don't need a pendingKey
      this.gatewaySocket.on('pending', pendingKey => {
        if (pendingKey) {
          logger.info(
            'Pending verification. Either scan the QR code on the screen, or install the agent manually at kubesail.com'
          )
          this.writeQRCode(`https://kubesail.com/clusters?pendingKey=${pendingKey}`)
        } else {
          logger.info('Pending verification. Please visit kubesail.com to verify this cluster!')
          this.writeQRCode(`https://kubesail.com/clusters?verifyNew=true`)
        }
      })
      this.gatewaySocket.on('set-credentials', async credentials => {
        logger.debug('Claimed! New credentials:', { credentials })
        const { agentKey, agentSecret } = credentials
        try {
          const secretName = 'agent-5bkm4ftg4f' // agent-5bkm4ftg4f / kubesail-agent
          await this.k8sClient.api.v1
            .namespaces(process.env.POD_NAMESPACE || 'kubesail-agent')
            .secrets(secretName)
            .patch({
              body: {
                apiVersion: 'v1',
                kind: 'Secret',
                metadata: { name: secretName },
                data: {
                  KUBESAIL_AGENT_SECRET: Buffer.from(agentSecret).toString('base64')
                }
              }
            })
        } catch (err) {
          logger.error(
            'Unable to find local kubesail-agent secret to patch. Please install manually',
            { code: err.status, errMsg: err.message }
          )
          return
        }
        try {
          await this.k8sClient.apis.apps.v1
            .namespaces(process.env.POD_NAMESPACE || 'kubesail-agent')
            .deployments('kubesail-agent')
            .patch({
              body: {
                apiVersion: 'v1/apps',
                kind: 'Deployment',
                metadata: { name: 'kubesail-agent' },
                spec: {
                  template: {
                    spec: {
                      containers: [
                        {
                          name: 'agent',
                          env: [{ name: 'KUBESAIL_AGENT_KEY', value: agentKey }]
                        }
                      ]
                    }
                  }
                }
              }
            })
        } catch (err) {
          logger.error(
            'Unable to find local kubesail-agent deployment to patch. Please install manually',
            { code: err.status, errMsg: err.message }
          )
          return
        }
      })
      this.gatewaySocket.on('disconnect', reason => {
        logger.error('Gateway closed connection, reconnecting!', { reason })
        this.reconnect()
      })
      this.gatewaySocket.on('connect_error', error => {
        logger.error(
          `Disconnected from KubeSail Gateway ("${error.description.message}") Reconnecting...`,
          {
            code: error.code || error.description.code,
            message: error.description.message,
            gateway: KUBESAIL_AGENT_GATEWAY_TARGET,
            port: KUBESAIL_AGENT_GATEWAY_PORT,
            resolved: resolvedGatewayTarget
          }
        )
        this.reconnect()
      })
      this.gatewaySocket.on('connect_timeout', timeout => {
        logger.error('gatewaySocket connect_timeout:', timeout)
        this.reconnect()
      })
      this.gatewaySocket.on('register-rejected', status => {
        this.registerRejected = true
        logger.error(
          'KubeSail agentKey and agentSecret rejected! Please re-install this agent at https://kubesail.com/clusters',
          { status }
        )
        if (process.env.NODE_ENV === 'development') {
          setTimeout(() => {
            this.reconnect()
          }, 2500)
        }
      })
      this.gatewaySocket.open()
    })
  }

  async writeQRCode(data) {
    logger.debug('writeQRCode', { data })
    // TODO: Write QR code to cluster QR code display socket
  }

  async refreshClientSpec() {
    const spec = await this.k8sClient.backend.http({ method: 'GET', pathname: '/openapi/v2' })
    this.k8sClient = new Client({ version: KUBERNETES_SPEC_VERSION })
    try {
      this.k8sClient._addSpec(spec.body)
    } catch (err) {
      logger.error('Failed to load Cluster Spec!', { errMsg: err.message, name: err.name })
    }
  }

  async findCertManagerNamespace(namespaces) {
    if (!namespaces) namespaces = await this.k8sClient.api.v1.namespaces.get()
    if (namespaces.body.items.find(namespace => namespace.metadata.name === 'cert-manager')) {
      try {
        await this.k8sClient.apis['apiextensions.k8s.io'].v1
          .customresourcedefinitions('certificates.cert-manager.io')
          .get()
      } catch (err) {
        if (err.response.statusCode === 404) {
          logger.info('Installing cert-manager CRDs')
          fs.readFileSync('lib/agent/cert-manager.crds.json')
            .toString()
            .split('---')
            .map(d => JSON.parse(d))
            .forEach(d => {
              this.k8sClient.apis['apiextensions.k8s.io'].v1.customresourcedefinitions
                .post({ body: d })
                .then(r => {
                  if (r.statusCode !== 200 && r.statusCode !== 409) {
                    logger.info('Failed to install cert-manager CRDs', {
                      statusCode: r.statusCode,
                      message: r.message
                    })
                  }
                })
            })
        }
      }
      this.features.certManager = true
      this.installCertIssuer()
    }
  }

  async installCertIssuer() {
    if (this.k8sClient.apis['cert-manager.io']) {
      let preferredCertManagerVersion
      if (this.k8sClient.apis['cert-manager.io'].v1) preferredCertManagerVersion = 'v1'
      else if (this.k8sClient.apis['cert-manager.io'].v1beta1)
        preferredCertManagerVersion = 'v1beta1'
      else if (this.k8sClient.apis['cert-manager.io'].v1alpha3)
        preferredCertManagerVersion = 'v1alpha3'
      else if (this.k8sClient.apis['cert-manager.io'].v1alpha2)
        preferredCertManagerVersion = 'v1alpha2'

      if (!preferredCertManagerVersion) {
        logger.warn('Unable to install Certificate Issuer... Trying again in 60 seconds.')
        setTimeout(async () => {
          await this.refreshClientSpec()
          this.installCertIssuer()
        }, 30000)
      }

      try {
        const clusterIssuers = await this.k8sClient.apis['cert-manager.io'][
          preferredCertManagerVersion
        ].clusterissuers.get()
        if (!clusterIssuers.body.items.find(item => item.metadata.name === 'letsencrypt')) {
          logger.info('Creating new ClusterIssuer for LetsEncrypt!', { email: this.email })
          await this.k8sClient.apis['cert-manager.io'][
            preferredCertManagerVersion
          ].clusterissuers.post({
            body: {
              apiVersion: `cert-manager.io/${preferredCertManagerVersion}`,
              kind: 'ClusterIssuer',
              metadata: { name: 'letsencrypt', namespace: 'cert-manager' },
              spec: {
                acme: {
                  email: this.email || KUBESAIL_AGENT_EMAIL,
                  server: 'https://acme-v02.api.letsencrypt.org/directory',
                  privateKeySecretRef: { name: 'letsencrypt' },
                  solvers: [{ http01: { ingress: { class: 'public' } } }]
                }
              }
            }
          })
        }
      } catch (err) {
        const details = { message: err.message, code: err.statusCode, stack: err.stack }
        if (err.statusCode === 500) {
          logger.warn(
            'Unable to create ClusterIssuer, cert-manager is probably still starting up. Retrying in 60 seconds.',
            details
          )
        } else {
          logger.error(
            'Unknown error occurred while trying to create ClusterIssuer. Please report this issue to KubeSail support! Retrying in 30 seconds.',
            details
          )
        }
        setTimeout(async () => {
          await this.refreshClientSpec()
          this.installCertIssuer()
        }, 30000)
      }
    } else {
      if (!warnedAboutMissingCertManager) {
        logger.debug(
          'Unable to find cert-manager installation. Will try to create clusterIssuer once it exists!'
        )
      }
      warnedAboutMissingCertManager = true

      setTimeout(async () => {
        await this.refreshClientSpec()
        this.installCertIssuer()
      }, 30000)
    }
  }

  // Tries to find a metrics-server endpoint for monitoring & charting purposes
  async findMetricsServerEndpoints() {
    const endpoints = await this.k8sClient.api.v1.namespaces('kube-system').endpoints().get()
    endpoints.body.items.find(endpoint => {
      if (METRICS_SERVER_ENDPOINT.split(',').includes(endpoint.metadata.name)) {
        this.setMetricsServerEndpoint(endpoint)
        return true
      }
      return false
    })
  }

  // Tries to discover the kubesail-generated wildcard certificate for our k8g8 domains
  async findK8g8Certificate() {
    let secret
    try {
      secret = await this.k8sClient.api.v1.namespaces('kube-system').secrets('k8g8-tls').get()
    } catch (err) {
      if (err.code === 404) {
        this.features.k8g8Cert = false
        return
      } else throw err
    }
    if (secret) {
      this.features.k8g8Cert = true
      this.setK8g8CertAsDefault()
    }
  }

  async setK8g8CertAsDefault() {
    const secretName = 'k8g8-tls'
    const tlsStoreName = 'default'
    const namespace = 'kube-system'
    const traefik = this.k8sClient.apis['traefik.containo.us']
    if (traefik) {
      logger.debug('setK8g8CertAsDefault: detected traefik.containo.us')
      try {
        await traefik.v1alpha1.namespaces(namespace).tlsstore(tlsStoreName).get()
      } catch (err) {
        if (err.statusCode === 404) {
          logger.debug('setK8g8CertAsDefault: Creating TLSStore')
          try {
            await traefik.v1alpha1.namespaces(namespace).tlsstores.post({
              body: {
                apiVersion: 'traefik.containo.us/v1alpha1',
                kind: 'TLSStore',
                metadata: { name: tlsStoreName, namespace },
                spec: { defaultCertificate: { secretName } }
              }
            })
          } catch (err) {
            if (err.statusCode === 409) return
            logger.warn('Failed to create TLSStore', { code: err.statusCode, errMsg: err.message })
          }
        }
      }
    } else {
      logger.debug(
        'setK8g8CertAsDefault: unable to determine ingress controller to set default certificate to kube-system/k8g8-tls'
      )
    }
  }

  async setMetricsServerEndpoint(endpoint) {
    logger.debug('Found metrics server endpoint!', {
      name: endpoint.metadata.name,
      namespace: endpoint.metadata.namespace
    })
    this.features.metrics = true
  }

  // Some ingress controllers require a ingressClassName to be used (nginx-ingress on kube >1.19)
  async findIngressClassName() {
    const api = this.k8sClient?.apis['networking.k8s.io']?.v1?.ingressclasses
    if (!api) return
    try {
      const response = await api.get()
      const ingressClasses = response.body.items
      const defaultIngressClass = ingressClasses.find(
        i => i?.metadata?.annotations?.['ingressclass.kubernetes.io/is-default-class'] === 'true'
      )
      if (defaultIngressClass) {
        this.features.defaultIngressClass = defaultIngressClass.metadata.name
      }
    } catch (err) {
      logger.warn(
        'Failed to detect ingressClasses - this is probably okay, but you may want to report this issue to KubeSail!',
        { errMsg: err.message, stack: err.stack }
      )
    }
  }

  // Tries to determine the endpoint for the ingress controller so we can pass traffic to it
  async findIngressControllerEndpoints(namespaces, force = false) {
    // Controller endpoint may have been discovered by watchAll already, if so, no-op
    if (
      !force &&
      ((this.ingressControllerNamespace && this.ingressControllerEndpoint) || this.useNodeIPRouting)
    ) {
      return
    }
    if (!namespaces) namespaces = await this.k8sClient.api.v1.namespaces.get()
    for (const nsName of INGRESS_CONTROLLER_NAMESPACE.split(',')) {
      if (namespaces.body.items.find(namespace => namespace.metadata.name === nsName)) {
        logger.silly('findIngressControllerEndpoints: searching for namespace', {
          namespace: nsName
        })
        const endpoints = await this.k8sClient.api.v1.namespaces(nsName).endpoints().get()
        for (const endpoint of endpoints.body.items) {
          logger.silly('findIngressControllerEndpoints: searching for endpoint in namespace', {
            namespace: nsName,
            endpoint: endpoint.metadata.name
          })
          if (INGRESS_CONTROLLER_ENDPOINT.split(',').includes(endpoint.metadata.name)) {
            logger.debug('findIngressControllerEndpoints: Setting ingress controller endpoint', {
              namespace: nsName,
              endpoint: endpoint.metadata.name
            })
            this.features.ingressController = endpoint.metadata.name
            return await this.setIngressControllerEndpoint(endpoint)
          }
        }
      }
    }
    // Microk8s creates a hostPort pod in the `ingress` namespace
    if (process.env.NODE_IP && namespaces.body.items.find(ns => ns.metadata.name === 'ingress')) {
      logger.debug(
        `findIngressControllerEndpoints: Unable to find ingress controller, trying host-port ${INGRESS_CONTROLLER_PORT_HTTPS}`
      )
      try {
        const req = https.request(
          {
            hostname: process.env.NODE_IP,
            port: INGRESS_CONTROLLER_PORT_HTTPS,
            method: 'GET',
            timeout: 1000,
            insecure: true,
            rejectUnauthorized: false,
            path: '/'
          },
          _res => {
            logger.warn(
              `We'll route traffic to this Node's HostPort ${INGRESS_CONTROLLER_PORT_HTTP} & ${INGRESS_CONTROLLER_PORT_HTTPS}, because it appears you have a hostPort nginx ingress controller enabled!`
            )
            this.useNodeIPRouting = true
          }
        )
        req.on('error', _err => {})
        req.end()
      } catch (err) {}
    } else {
      logger.warn(
        'Unable to determine Ingress Controller! You can install an ingress controller via the KubeSail.com interface!'
      )
    }
  }

  // Sets this.resources.endpoints to the address/port of the ingress controller
  async setIngressControllerEndpoint(endpoint /*: Object */) {
    this.ingressControllerNamespace = endpoint.metadata.name
    this.ingressControllerEndpoint = endpoint.metadata.namespace

    if (endpoint && typeof endpoint === 'object' && Array.isArray(endpoint.subsets)) {
      this.resources.endpoints = Array.prototype.concat(
        ...endpoint.subsets
          .map(subset => {
            if (subset && Array.isArray(subset.addresses)) {
              return subset.addresses.map(address => {
                return {
                  ip: address.ip,
                  http:
                    (subset.ports.find(p => p.name === 'http' || p.name === 'web') || {}).port ||
                    INGRESS_CONTROLLER_PORT_HTTP,
                  https:
                    (subset.ports.find(p => p.name === 'https' || p.name === 'websecure') || {})
                      .port || INGRESS_CONTROLLER_PORT_HTTPS
                }
              })
            }
            return null
          })
          .filter(Boolean)
      )
      logger.debug('Emitting health-check due to ingress-controller endpoint change', {
        endpoints: this.resources.endpoints
      })
      this.gatewaySocket.emit('health-check', this.healthCheckData())
    }
  }

  async findIngresses() {
    const baseApi = this.k8sClient.apis['networking.k8s.io'] ? 'networking.k8s.io' : 'extensions'
    const ingVersion = this.k8sClient.apis[baseApi].v1beta1 ? 'v1beta1' : 'v1'
    if (
      this.k8sClient.apis[baseApi] &&
      this.k8sClient.apis[baseApi][ingVersion] &&
      this.k8sClient.apis[baseApi][ingVersion].ingresses
    )
      this.ingressApi = this.k8sClient.apis[baseApi][ingVersion]

    if (this.ingressApi) {
      try {
        this.resources.ingresses = (await this.ingressApi.ingresses.get()).body.items
      } catch (err) {
        logger.error('findIngresses: Unable to list ingresses:', err)
      }
      await this.setIngressHostnames()
    } else {
      let debugKeys = {}
      try {
        debugKeys = Object.keys(this.k8sClient.apis[baseApi][ingVersion])
      } catch (err) {}
      logger.error(
        'Unable to find Ingress support in this Kubernetes cluster! Traffic forwarding to HTTP services will not work! Please report this issue to KubeSail! https://kubesail.com/support',
        { baseApi, ingVersion, debugKeys }
      )
    }
  }

  localHostnameAvahiGroups = {}
  async writeAvahiHosts() {
    logger.debug('writeAvahiHosts: starting', { dbusAvailable })
    const newLocalHostnames = [{ rule: { host: 'pibox.local' } }]
    this.resources.ingresses.forEach(
      ing =>
        ing.spec &&
        ing.spec.rules &&
        ing.spec.rules.find(rule => {
          if (rule?.host && typeof rule.host === 'string') {
            if (rule.host.endsWith('.local') && !this.localHostnameAvahiGroups[rule.host])
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

    if (dbusAvailable && newLocalHostnames.length > 0) {
      logger.info(`Publishing .local DNS addresses (aliased to "${process.env.NODE_IP}")`, {
        hosts: newLocalHostnames.map(l => l.rule.host)
      })
      newLocalHostnames.forEach(async localHostname => {
        // TODO: Filter NODE_NAME out - we shouldn't allow localHostname.rule.host === NODE_NAME
        try {
          const avahiInterface = await systemBus.getProxyObject('org.freedesktop.Avahi', '/')
          const server = avahiInterface.getInterface('org.freedesktop.Avahi.Server')
          const entryGroupPath = await server.EntryGroupNew()
          const entryGroup = await systemBus.getProxyObject('org.freedesktop.Avahi', entryGroupPath)
          const entryGroupInt = entryGroup.getInterface('org.freedesktop.Avahi.EntryGroup')
          await entryGroupInt.AddRecord(
            -1, // IF_UNSPEC (all interfaces)
            -1, // PROTO_UNSPEC (all protocols)
            0,
            toASCII(localHostname.rule.host), // mDNS name
            0x01, // CLASS_IN
            0x01, // TYPE_A (A record. TYPE_CNAME is 0x05) https://github.com/lathiat/avahi/blob/d1e71b320d96d0f213ecb0885c8313039a09f693/avahi-sharp/RecordBrowser.cs#L39
            60, // TTL
            Uint8Array.from(process.env.NODE_IP.split('.'))
          )
          await entryGroupInt.Commit()
          this.localHostnameAvahiGroups[localHostname.rule.host] = entryGroupInt
        } catch (err) {
          if (err.message === 'Local name collision' && localHostname.rule.host === 'pibox.local') {
            // We don't strictly care about local name collisions, particularly for our pibox.local address
            // which ideally is already published by the host avahi (assuming we're named 'pibox')
          } else {
            logger.error('Failed to write .local DNS addresses', {
              errName: err.name,
              code: err.code,
              errMsg: err.message
            })
          }
        }
      })
    }
  }

  ingressHostnames = []
  async setIngressHostnames() {
    const desiredIngressMap = {}
    this.resources.ingresses.forEach(
      doc =>
        doc.spec &&
        doc.spec.rules &&
        doc.spec.rules.forEach(rule => {
          desiredIngressMap[rule.host] =
            doc?.metadata?.annotations?.['kubesail.com/firewall'] || '0.0.0.0/0'
        })
    )
    const needsIngressUpdate = !isEqual(desiredIngressMap, this.desiredIngressMap)
    if (!needsIngressUpdate) return
    logger.silly('setIngressHostnames:', { desiredIngressMap })
    this.writeAvahiHosts()
    this.desiredIngressMap = desiredIngressMap
    const { res, body } = await this.apiRequest('/agent/host-mapping-request', 'POST', {
      agentKey: KUBESAIL_AGENT_KEY,
      agentSecret: KUBESAIL_AGENT_SECRET,
      desiredIngressMap
    })
    if (!body) return
    try {
      const json = JSON.parse(body)
      if (json.validHostnames.length > 0) {
        const humanReadableFirewall = {}
        for (const hostname of json.validHostnames) {
          if (this.firewall[hostname]) {
            humanReadableFirewall[hostname] = this.firewall[hostname]
          }
        }
        logger.info(
          'KubeSail ingress forwarding successful! The following domains are now active:',
          humanReadableFirewall
        )
      }
    } catch (err) {
      logger.debug('Unexpected reply from KubeSail api!', {
        statusCode: res.statusCode,
        desiredIngressMap
      })
    }
  }
}

module.exports = KsAgent
