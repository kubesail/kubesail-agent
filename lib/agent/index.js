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
const { uniq, isEqual } = require('lodash')
const { isIP, isFQDN } = require('validator')

const logger = require('../shared/logger')
const { initProm } = require('../shared/prom')
const { sampleArray, writeHeader, kubesailApiRequest } = require('../shared')
const {
  KUBESAIL_AGENT_HTTP_LISTEN_PORT,
  KUBESAIL_AGENT_GATEWAY_TARGET,
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
  INTERNAL_HTTPS_RESPONDER_PORT,
  AUTO_INSTALL_CLUSTER_FEATURES,
  DOCUMENTS_TO_WATCH,
  KUBESAIL_API_TARGET,
  RELEASE
} = require('../shared/config')

const WATCH_STREAM_TIMEOUT_SECONDS = 21600
const KUBERNETES_SPEC_VERSION = '1.19-certs'

// Uncomment the `setServers` lines to test invalid/non-working DNS fallback in development
// dns.setServers(['127.0.0.53'])
const resolver = new dns.Resolver()
// resolver.setServers(['127.0.0.53'])
const resolve4 = promisify(resolver.resolve4).bind(resolver)
let resolvedGatewayTarget = KUBESAIL_AGENT_GATEWAY_TARGET
let warnedAboutMissingCertManager = false

process.on('unhandledRejection', err => {
  throw err
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

class KsAgent {
  // Used to track resources in the cluster we're in.
  // Endpoints are tracked to follow the ingress controller we'll be passing traffic to
  // Services will be tracked in the future to pass traffic directly, rather than using an ingress controller (ie: we'll be the ingress controller)
  // Certificates will be tracked so that we can possibly provide totally valid HTTPS end-to-end without using the SNI tricks.
  resources /*: { endpoints: Array<Object>, services: Array<Object>, certificates: Array<Object> } */ =
    {
      endpoints: [],
      services: [],
      certificates: []
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
      res.end('No ingress controller found!')
    }
  )

  constructor() {
    if (!KUBESAIL_AGENT_KEY || !KUBESAIL_AGENT_SECRET) {
      throw new Error(
        'No KUBESAIL_AGENT_KEY or KUBESAIL_AGENT_SECRET defined! Please provide these environment variables!'
      )
    }
    this.http.on('error', function serverErrorHandler(error /*: Error */) {
      throw error
    })
  }

  async setResolver() {
    let resolved
    try {
      if (!isFQDN(KUBESAIL_AGENT_GATEWAY_TARGET)) return
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
    logger.info('kubesail-agent starting!', {
      autoInstall: AUTO_INSTALL_CLUSTER_FEATURES,
      version: RELEASE
    })
    initProm()

    await this.setResolver()
    const connectionString = `${resolvedGatewayTarget}?username=${
      KUBESAIL_AGENT_USERNAME || ''
    }&key=${KUBESAIL_AGENT_KEY || ''}&secret=${KUBESAIL_AGENT_SECRET || ''}&initialID=${
      KUBESAIL_AGENT_INITIAL_ID || ''
    }`
    if (isIP(resolvedGatewayTarget)) {
      logger.warn(
        "Note, we're using a resolved IP address to connect to KubeSail, because DNS on this cluster appears to be non-operational! It is recommended that you enable DNS and restart the agent pod.",
        { resolvedGatewayTarget }
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

    logger.silly('Connecting to Kubernetes API...')
    const spec = await this.k8sClient.backend.http({ method: 'GET', pathname: '/openapi/v2' })
    this.k8sClient._addSpec(spec.body)

    this.agentHttpsReplier.listen(INTERNAL_HTTPS_RESPONDER_PORT, '127.0.0.1')
    this.http.listen(KUBESAIL_AGENT_HTTP_LISTEN_PORT)

    logger.silly('Registering with KubeSail...')

    // Note that this promise does not resolve until we've been verified, which may never happen!
    this.registerWithGateway().then(async () => {
      logger.info('KubeSail Agent registered and ready! KubeSail support information:', {
        clusterAddress: this.clusterAddress,
        agentKey: this.agentKey,
        version: RELEASE
      })
      await this.checkPublicIP()

      this.gatewaySocket.emit('health-check', this.healthCheckData({ automated: true }))
      setInterval(async () => {
        this.gatewaySocket.emit('health-check', this.healthCheckData({ automated: true }))
      }, 60000)

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
      features: {
        metrics: !!this.metricsServerEndpoint,
        ingressController: !!(this.ingressControllerEndpoint || this.useNodeIPRouting),
        certManager: this.certManagerDetected
        // pvcSupport: false,
      },
      ...data
    }
  }

  async checkPublicIP() {
    try {
      const resp = await kubesailApiRequest({
        method: 'PUT',
        path: '/whatsmyip',
        headers: {
          username: KUBESAIL_AGENT_USERNAME,
          'agent-key': KUBESAIL_AGENT_KEY,
          'agent-secret': KUBESAIL_AGENT_SECRET
        }
      })
      this.myPublicIP = resp.json.ip
    } catch (err) {
      console.error(
        'Failed to fetch current public IP address! Possibly we have no internet connection?'
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

      stream.on('error', function (err) {
        logger.error('watchAll stream error', { group, kind, version, errMsg: err.message })
        if (!reconnectTimeout) {
          reconnectTimeout = setTimeout(() => {
            clearTimeout(reconnectTimeout)
            connect(group, version, kind)
          })
        }
      })
      stream.on('disconnect', function () {
        logger.debug('watchAll stream disconnect', { group, kind, version })
        if (!reconnectTimeout) {
          reconnectTimeout = setTimeout(() => {
            clearTimeout(reconnectTimeout)
            connect(group, version, kind)
          }, 100)
        }
      })
      stream.on('end', function () {
        if (!reconnectTimeout) {
          reconnectTimeout = setTimeout(() => {
            clearTimeout(reconnectTimeout)
            connect(group, version, kind)
          }, 100)
        }
      })
      stream.on('pause', function () {
        logger.info('watchAll stream pause')
      })
      stream.on('data', async event => {
        if (event.type === 'ERROR') {
          logger.error('watchAll error', { event })
          return stream.destroy()
        }
        // Track resource version
        const newVersion = parseInt(event.object.metadata.resourceVersion, 10)
        if (!this.watchAllResourceVersion || newVersion > this.watchAllResourceVersion) {
          this.watchAllResourceVersion = newVersion
        }
        const eventKind = event.object.kind
        const eventName = event.object.metadata.name
        const eventNamespace = event.object.metadata.namespace

        if (eventKind === 'Namespace' && eventName === 'cert-manager') {
          if (event.type === 'ADDED') {
            this.certManagerDetected = true
            setTimeout(async () => {
              await this.refreshClientSpec()
              this.installCertIssuer()
            }, 60000)
          } else if (event.type === 'DELETED') {
            this.certManagerDetected = false
          }
          logger.debug('Emitting health-check due to detected cert-manager change')
          this.gatewaySocket.emit('health-check', this.healthCheckData())
        }

        // Keep track of Ingresses across the system
        if (eventKind === 'Ingress') {
          if (event.type === 'ADDED') {
            logger.debug('watchForIngresses: Detected new ingress:', { eventName, eventNamespace })
            this.ingresses.push(event.object)
          } else if (event.type === 'MODIFIED') {
            this.ingresses = this.ingresses.map(ing => {
              if (ing.metadata.name === eventName && ing.metadata.namespace === eventNamespace) {
                return event.object
              }
              return ing
            })
          } else if (event.type === 'DELETED') {
            this.ingresses = this.ingresses.filter(
              ing => ing.metadata.name !== eventName && ing.metadata.namespace !== eventNamespace
            )
          }
          await this.setIngressHostnames()
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
              this.metricsServerEndpoint = null
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
        logger.silly('watchAll: not sending event:', debugInfo)
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
      const req = https.request({ ...options, path }, res => {
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
  reconnect = async (time = 2500) => {
    this.reconnectionCount = this.reconnectionCount + 1
    time = time + Math.floor(Math.random() * Math.floor(time)) * this.reconnectionCount
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
                writeHeader(stream, data, 503, protocol, 'KS_AGENT_NO_INGRESS_CONTROLLER')
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
              writeHeader(stream, data, 503, protocol, 'KS_AGENT_INVALID_DOMAIN')
            })
          }
          const socket = new net.Socket()
          socket.connect(port, proxyTarget, () => {
            socket.pipe(stream).pipe(socket)
          })
          socket.on('close', () => {
            try {
              stream.end()
            } catch (err) {
              logger.error('requestHandler() failed to close stream on socket close', {
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
              logger.error('requestHandler() failed to close socket on stream close', {
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
            logger.warn('requestHandler() error on socket:', {
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
            logger.warn('requestHandler() error on stream:', {
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

        if (!this.agentReady) {
          const namespaces = await this.k8sClient.api.v1.namespaces.get()
          await this.findCertManagerNamespace(namespaces)
          await this.findIngressControllerEndpoints(namespaces)
          await this.findMetricsServerEndpoints()
          await this.findIngresses()
          await this.watchAll(DOCUMENTS_TO_WATCH)
          this.agentReady = true
        }

        this.setIngressHostnames()

        resolve()
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
        const kubeConfig = this.generateKubeConfig()
        this.gatewaySocket.emit('config-response', { kubeConfig })
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
        logger.debug('Connected to gateway socket!', { KUBESAIL_AGENT_GATEWAY_TARGET })
      })
      this.gatewaySocket.on('error', error => {
        throw new Error(`Gateway Socket Errored! Reason: "${error.description.code}"`)
      })

      this.gatewaySocket.on('disconnect', reason => {
        logger.error('Gateway closed connection, reconnecting!', { reason })
        this.reconnect()
      })
      this.gatewaySocket.on('connect_error', error => {
        logger.error(
          `Disconnected from KubeSail Gateway ("${error.description.message}") Reconnecting...`
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

  async refreshClientSpec() {
    const spec = await this.k8sClient.backend.http({ method: 'GET', pathname: '/openapi/v2' })
    this.k8sClient = new Client({ version: KUBERNETES_SPEC_VERSION })
    this.k8sClient._addSpec(spec.body)
  }

  certManagerDetected = false
  async findCertManagerNamespace(namespaces) {
    if (!namespaces) namespaces = await this.k8sClient.api.v1.namespaces.get()
    if (namespaces.body.items.find(namespace => namespace.metadata.name === 'cert-manager')) {
      this.certManagerDetected = true
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

  metricsServerEndpoint = null
  async setMetricsServerEndpoint(endpoint) {
    logger.debug('Found metrics server endpoint!', {
      name: endpoint.metadata.name,
      namespace: endpoint.metadata.namespace
    })
    this.metricsServerEndpoint = true
    this.gatewaySocket.emit('health-check', this.healthCheckData())
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
          res => {
            if ((res.headers.server || '').split('/')[0] === 'nginx') {
              logger.warn(
                `We'll route traffic to this Node's HostPort ${INGRESS_CONTROLLER_PORT_HTTP} & ${INGRESS_CONTROLLER_PORT_HTTPS}, because it appears you have a hostPort nginx ingress controller enabled!`
              )
              this.useNodeIPRouting = true
            } else {
              logger.warn(
                'Unable to determine Ingress Controller! You can install an ingress controller via the KubeSail.com interface!'
              )
              // Try checking again to see if a host-port controller has been installed
              setTimeout(() => this.findIngressControllerEndpoints(), 60000)
            }
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
    const baseApi = this.k8sClient.apis.extensions ? 'extensions' : 'networking.k8s.io'
    const ingVersion = this.k8sClient.apis[baseApi].v1beta1 ? 'v1beta1' : 'v1'
    if (
      this.k8sClient.apis[baseApi] &&
      this.k8sClient.apis[baseApi][ingVersion] &&
      this.k8sClient.apis[baseApi][ingVersion].ingresses
    )
      this.ingressApi = this.k8sClient.apis[baseApi][ingVersion]

    if (this.ingressApi) {
      this.ingresses = (await this.ingressApi.ingresses.get()).body.items
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

  ingresses = []
  ingressHostnames = []
  async setIngressHostnames() {
    if (!this.clusterAddress) return
    const newIngressHostnames = uniq(
      this.ingresses
        .map(doc => doc.spec && doc.spec.rules && doc.spec.rules.map(rule => rule.host))
        .flat()
        .filter(Boolean)
    ).sort()

    if (!isEqual(newIngressHostnames, this.ingressHostnames)) {
      this.ingressHostnames = newIngressHostnames
      const { res, body } = await this.apiRequest('/agent/host-mapping-request', 'POST', {
        agentKey: KUBESAIL_AGENT_KEY,
        agentSecret: KUBESAIL_AGENT_SECRET,
        ingressHostnames: newIngressHostnames
      })
      if (body) {
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
            newIngressHostnames
          })
        }
      }
    }
  }
}

module.exports = KsAgent
