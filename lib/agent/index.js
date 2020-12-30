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

const logger = require('../shared/logger')
const { initProm } = require('../shared/prom')
const { sampleArray, writeHeader, kubesailApiReqest } = require('../shared')
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
  INTERNAL_HTTPS_RESPONDER_PORT,
  DOCUMENTS_TO_WATCH,
  KUBESAIL_API_TARGET,
  RELEASE
} = require('../shared/config')

const SEARCH_INTERVAL_TIME_MS = 30000

// Uncomment the `setServers` lines to test invalid/non-working DNS fallback in development
// dns.setServers(['127.0.0.53'])
const resolver = new dns.Resolver()
// resolver.setServers(['127.0.0.53'])
const resolve4 = promisify(resolver.resolve4).bind(resolver)

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
  resources /*: { endpoints: Array<Object>, services: Array<Object>, certificates: Array<Object> } */ = {
    endpoints: [],
    services: [],
    certificates: []
  }

  ingressControllerEndpoint = null
  ingressControllerNamespace = null

  // Indicates agent is ready to take traffic
  // will fail healthchecks when falsey (used mainly to prevent recieving traffic before we're ready)
  agentReady = false

  // Will be set to true if our registration has been rejected by the API. We'll need to be updated!
  registerRejected = false

  // A 'kubernetes-client' connection to the cluster we're located in, using our in-pod service account
  k8sClient = new Client()

  // Our socket with a KubeSail Gateway instance
  gatewaySocket = null

  // The DNS name of our cluster from the internet - retrieved from agent-data
  clusterAddress /*: string */ = ''

  // Domains the gateway will be forwarding to us (and its firewall configuration)
  firewall /* Object */ = {}

  // Users currently watching resources via agent-kube-watch
  usersWatchingEvents = []

  // KubeWatch streams open
  watchingStreams = []

  // Currently using fallback DNS servers
  usingFallbackResolver = false

  // If we cant find an ingress controller, but it appears that NODE_IP:443 is open, we'll forward traffic there
  // This covers the common `microk8s enable ingress` use-case
  useNodeIPRouting = false

  // The Agent's http server is primarily used for healthchecks and nothing more
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
  agentHttpsReplyer = https.createServer(
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
    try {
      const resolved = await resolve4('api.kubesail.com')
      logger.silly('Successfully resolved DNS address for agent target', { resolved })
    } catch (err) {
      if (this.usingFallbackResolver) throw err
      logger.error(
        'Unable to resolve DNS! Falling back to CloudFlare DNS as backup! Please check your cluster for DNS capabiltiies!',
        { errMsg: err.message, code: err.code }
      )
      this.usingFallbackResolver = true
      resolver.setServers(['1.1.1.1'])
      return this.setResolver()
    }
  }

  // Starts the Agent service, connects tunnels and marks agentReady when ready.
  async init() {
    logger.info('kubesail-agent starting!', { version: RELEASE })
    initProm()

    await this.setResolver()
    const connectionString = `${KUBESAIL_AGENT_GATEWAY_TARGET}?username=${
      KUBESAIL_AGENT_USERNAME || ''
    }&key=${KUBESAIL_AGENT_KEY || ''}&secret=${KUBESAIL_AGENT_SECRET || ''}&initialID=${
      KUBESAIL_AGENT_INITIAL_ID || ''
    }`
    this.gatewaySocket = socketio(connectionString, {
      autoConnect: false,
      transports: ['websocket'],
      timeout: 5000,
      ...connectionOptions
    })

    logger.info('Connecting to Kubernetes API...')
    const spec = await this.k8sClient.backend.http({ method: 'GET', pathname: '/openapi/v2' })
    this.k8sClient._addSpec(spec.body)

    await this.findIngressControllerEndpoints()
    if (!this.ingressControllerNamespace || !this.ingressControllerEndpoint) {
      logger.warn(
        `Unable to determine Ingress Controller! You can install an ingress controller via the KubeSail.com interface!`
      )
    } else {
      await this.watchForIngressEndpointChanges()
    }
    await this.findIngresses()
    await this.watchAll(DOCUMENTS_TO_WATCH)

    this.agentHttpsReplyer.listen(INTERNAL_HTTPS_RESPONDER_PORT, '127.0.0.1', () => {
      this.http.listen(KUBESAIL_AGENT_HTTP_LISTEN_PORT, () => {
        this.agentReady = true
      })
    })

    logger.debug('Checking for cert-manager APIs')
    const retryCertManagerIssuerCreation = () => {
      setTimeout(async () => {
        logger.debug('retryCertManagerIssuerCreation: Loading new cluster spec')
        // Reload spec to fetch new resources:
        const spec = await this.k8sClient.backend.http({ method: 'GET', pathname: '/openapi/v2' })
        this.k8sClient = new Client()
        this.k8sClient._addSpec(spec.body)
        await tryCertManagerIssuerCreation()
      }, SEARCH_INTERVAL_TIME_MS)
    }

    const tryCertManagerIssuerCreation = async () => {
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
          logger.debug(
            'Unable to find cert-manager installation. Will try to create clusterIssuer once it exists!'
          )
          return retryCertManagerIssuerCreation()
        }

        try {
          const clusterIssuers = await this.k8sClient.apis['cert-manager.io'][
            preferredCertManagerVersion
          ].clusterissuers.get()
          if (!clusterIssuers.body.items.find(item => item.metadata.name === 'letsencrypt')) {
            logger.info('Creating new ClusterIssuer for LetsEncrypt!')
            await this.k8sClient.apis['cert-manager.io'][
              preferredCertManagerVersion
            ].clusterissuers.post({
              body: {
                apiVersion: `cert-manager.io/${preferredCertManagerVersion}`,
                kind: 'ClusterIssuer',
                metadata: { name: 'letsencrypt', namespace: 'cert-manager' },
                spec: {
                  acme: {
                    email: KUBESAIL_AGENT_EMAIL,
                    server: 'https://acme-v02.api.letsencrypt.org/directory',
                    privateKeySecretRef: { name: 'letsencrypt' },
                    solvers: [{ http01: { ingress: { class: 'nginx' } } }]
                  }
                }
              }
            })
          }
        } catch (err) {
          const details = { message: err.message, code: err.statusCode, stack: err.stack }
          if (err.statusCode === 500) {
            logger.warn(
              'Unable to create ClustuerIssuer, cert-manager is probably still starting up. Retrying in 30 seconds.',
              details
            )
          } else {
            logger.error(
              'Unknown error occured while trying to create ClusterIssuer. Please report this issue to KubeSail support! Retrying in 30 seconds.',
              details
            )
          }
          retryCertManagerIssuerCreation()
        }
      } else {
        logger.debug(
          'Unable to find cert-manager installation. Will try to create clusterIssuer once it exists!'
        )
        retryCertManagerIssuerCreation()
      }
    }
    await tryCertManagerIssuerCreation()

    logger.info('Registering with KubeSail...')
    await this.checkPublicIP()

    // Note that this promise does not resolve until we've been verified, which may never happen!
    this.registerWithGateway().then(async () => {
      logger.info('KubeSail Agent registered and ready! KubeSail support information:', {
        clusterAddress: this.clusterAddress,
        agentKey: this.agentKey,
        version: RELEASE
      })

      this.gatewaySocket.emit('health-check', this.healthCheckData({ automated: true }))
      setInterval(async () => {
        this.gatewaySocket.emit('health-check', this.healthCheckData({ automated: true }))
      }, 10000)

      setInterval(async () => {
        await this.checkPublicIP()
      }, 600000)
    })
  }

  healthCheckData(data = {}) {
    return {
      usingFallbackResolver: this.usingFallbackResolver,
      agentVersion: RELEASE,
      myPublicIP: this.myPublicIP,
      ...data
    }
  }

  async checkPublicIP() {
    try {
      const resp = await kubesailApiReqest('GET', '/whatsmyip')
      this.myPublicIP = resp.json.ip
    } catch (err) {
      console.error(
        'Failed to fetch current public IP address! Possibly we have no internet connection?'
      )
    }
  }

  async watchAll(docsToWatch /*: Array<Object> */) {
    const connect = async (group, version, kind, resourceVersion) => {
      const options = { parameters: {} }

      if (!isNaN(parseInt(resourceVersion, 10))) {
        options.parameters.resourceVersion = resourceVersion
      }

      let stream
      if (kind === 'namespace') {
        stream = await this.k8sClient.api[version].namespaces.watch[kind].getObjectStream(options)
      } else if (group === 'core') {
        stream = await this.k8sClient.api[version].watch[kind].getObjectStream(options)
      } else {
        let baseApi = this.k8sClient.apis[group][version]
        if (!baseApi && version !== 'v1' && this.k8sClient.apis[group].v1)
          baseApi = this.k8sClient.apis[group].v1
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
            connect(group, version, kind, resourceVersion)
            reconnectTimeout = null
          })
        }
      })
      stream.on('disconnect', function () {
        logger.debug('watchAll stream disconnect', { group, kind, version })
        if (!reconnectTimeout) {
          reconnectTimeout = setTimeout(() => {
            connect(group, version, kind, resourceVersion)
            reconnectTimeout = null
          }, 100)
        }
      })
      stream.on('close', function () {
        logger.silly('watchAll: stream closed', { group, kind, version })
      })
      stream.on('end', function () {
        if (!reconnectTimeout) {
          reconnectTimeout = setTimeout(() => {
            connect(group, version, kind, resourceVersion)
            reconnectTimeout = null
          }, 100)
        }
      })
      stream.on('pause', function () {
        logger.info('watchAll stream pause')
      })
      stream.on('data', async event => {
        if (event.type === 'ERROR' && event.object.code === 410) {
          logger.error('Got ERROR event type - reconnecting stream!', { event })
          stream.destroy()
          await connect(group, version, kind, 'newest')
        } else if (event.type === 'ERROR') {
          logger.error('watchAll Unknown error', {
            event,
            resourceVersion
          })
          stream.destroy()
        } else {
          if (
            this.usersWatchingEvents.find(
              u => u.namespace === event?.object?.metadata?.namespace
            ) &&
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
      if (
        event.type === 'MODIFIED' &&
        [
          'cert-manager-cainjector-leader-election',
          'cert-manager-cainjector-leader-election-core',
          'cert-manager-controller',
          'ingress-controller-leader-nginx'
        ].includes(event.object.metadata.name)
      ) {
        logger.silly('watchAll: not sending event:', debugInfo)
        return false
      } else {
        logger.debug('watchAll: sending event:', debugInfo)
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
        resolve(res)
        res.on('error', errHandler)
      })
      req.on('error', errHandler)
      if (data) {
        const postData = JSON.stringify(data)
        req.write(postData)
      }
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
      const requestHandler = protocol => (stream, { host }) => {
        // TODO: These port numbers should be configurable (findIngressControllerEndpoints has this info)
        let port = 80
        if (protocol === 'https') port = 443

        let proxyTarget
        if (host === this.clusterAddress || ADDITIONAL_CLUSTER_HOSTNAMES.includes(host)) {
          const uri = new url.URL(this.k8sClient.backend.requestOptions.baseUrl)
          proxyTarget = uri.host
          port = uri.port || 443
          logger.silly('Forwarding request to Kubernetes API', {
            proxyTarget,
            port,
            host,
            firewall: this.firewall,
            clusterAddress: this.clusterAddress
          })
        } else if (this.firewall[host]) {
          if (this.resources.endpoints.length) {
            proxyTarget = sampleArray(this.resources.endpoints)
          } else if (this.useNodeIPRouting && process.env.NODE_IP) {
            proxyTarget = process.env.NODE_IP
          } else {
            logger.warn(
              'Received request, but no Ingress controller was found! You can install one on KubeSail.com in your cluster settings page.',
              { host }
            )
            return stream.once('data', data => {
              writeHeader(stream, data, 503, protocol, 'NO_INGRESS_CONTROLLER')
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
            writeHeader(stream, data, 503, protocol, 'INVALID_DOMAIN')
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
              errMsg: err.message
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
              errMsg: err.message
            })
          }
        })
        socket.on('error', err => {
          if (err.message === 'Connection aborted') return socket.end()
          logger.warn('requestHandler() error on socket:', {
            host,
            proxyTarget,
            errMsg: err.message
          })
          stream.end()
        })
        stream.on('error', err => {
          if (err.message === 'Connection aborted') return socket.end()
          else if (err.message === 'stream.push() after EOF') {
            logger.debug('stream: stream.push() after EOF', {
              host,
              proxyTarget,
              errMsg: err.message
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

      this.gatewaySocket.on('agent-data', agentData => {
        logger.info('Agent recieved new agent-data from gateway!', {
          clusterAddress: agentData.clusterAddress,
          firewall: agentData.firewall
        })
        this.clusterAddress = agentData.clusterAddress
        this.agentKey = agentData.agentKey
        this.firewall = agentData.firewall
        this.setIngressHostnames()
        resolve()
      })

      this.gatewaySocket.on('health-check', () => {
        logger.silly('Agent recieved health-check!')
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
          logger.silly('User starting to watch namespace events', { username })
          this.usersWatchingEvents.push({ username, namespace })
        } else {
          logger.debug('User no longer watching namespace events', { username })
          this.usersWatchingEvents = this.usersWatchingEvents.filter(
            u => u.username !== username && u.namespace !== namespace
          )
        }
      })

      this.gatewaySocket.on('connect', () => {
        logger.info('Connected to gateway socket!', { KUBESAIL_AGENT_GATEWAY_TARGET })
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

  // Tries to determine the endpoint for the ingress controller so we can pass traffic to it
  async findIngressControllerEndpoints() {
    const namespaces = await this.k8sClient.api.v1.namespaces.get()
    const ingressControllerNamespace = namespaces.body.items.find(ns => {
      return INGRESS_CONTROLLER_NAMESPACE.split(',').includes(ns.metadata.name)
    })
    if (ingressControllerNamespace) {
      const endpoints = await this.k8sClient.api.v1
        .namespaces(ingressControllerNamespace.metadata.name)
        .endpoints()
        .get()
      const endpoint = endpoints.body.items.find(ep => {
        return INGRESS_CONTROLLER_ENDPOINT.split(',').includes(ep.metadata.name)
      })
      if (endpoint) {
        return await this.setIngressControllerEndpoint(endpoint)
      }
    }

    // Microk8s creates a hostPort pod in the `ingress` namespace
    if (process.env.NODE_IP && namespaces.body.items.find(ns => ns.metadata.name === 'ingress')) {
      try {
        const req = https.request(
          {
            hostname: process.env.NODE_IP,
            port: 443,
            method: 'GET',
            timeout: 1000,
            insecure: true,
            rejectUnauthorized: false,
            path: '/'
          },
          res => {
            if (res.statusCode === 200 || res.statusCode === 404) {
              console.log(`HEADERS: ${JSON.stringify(res.headers)}`, {
                server: res.headers.server.split('/')
              })
              logger.warn(
                `We\'ll route traffic to this Node's HostPort 80 & 443, because it appears you have a hostPort ingress controller enabled!`
              )
              this.useNodeIPRouting = true
            }
          }
        )
        req.on('error', _err => {})
        req.end()
      } catch (err) {}
    }
  }

  // Sets this.resources.endpoints to the address/port of the ingress controller
  async setIngressControllerEndpoint(endpoint /*: Object */) {
    this.ingressControllerNamespace = endpoint.metadata.name
    this.ingressControllerEndpoint = endpoint.metadata.namespace

    logger.silly('setIngressControllerEndpoint start:', { endpoint })
    if (endpoint && typeof endpoint === 'object' && Array.isArray(endpoint.subsets)) {
      this.resources.endpoints = Array.prototype.concat(
        ...endpoint.subsets
          .map(subset => {
            if (subset && Array.isArray(subset.addresses)) {
              return subset.addresses.map(address => address.ip)
            }
          })
          .filter(Boolean)
      )
      logger.silly('setIngressControllerEndpoint end:', { endpoints: this.resources.endpoints })
    }
  }

  // Watch for changes to the ingress endpoint
  async watchForIngressEndpointChanges() {
    if (!this.ingressControllerNamespace || !this.ingressControllerEndpoint) {
      logger.warn(
        'watchForIngressEndpointChanges cannot watch for ingress controller, none found initially!'
      )
      return
    }

    if (this.ingressEndpointWatchStream) this.ingressEndpointWatchStream.close()

    this.ingressEndpointWatchStream = await this.k8sClient.api.v1.watch
      .namespaces(this.ingressControllerNamespace)
      .endpoints(this.ingressControllerEndpoint)
      .getObjectStream()

    this.ingressEndpointWatchStream.on('error', err => {
      logger.error('watchForIngressEndpointChanges stream error', { errMsg: err.message })
    })
    this.ingressEndpointWatchStream.on('disconnect', () => {
      logger.info('watchForIngressEndpointChanges stream disconnect', {})
      setTimeout(() => this.watchForIngressEndpointChanges(), 2500)
    })

    this.ingressEndpointWatchStream.on('data', async event => {
      if (event.type === 'ADDED' || event.type === 'MODIFIED') {
        this.setIngressControllerEndpoint(event.object)
      }
    })
  }

  // Tries to determine the endpoint for the ingress controller so we can pass traffic to it
  async findIngresses() {
    const baseApi = this.k8sClient.apis['extensions'] ? 'extensions' : 'networking.k8s.io'
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
        'Unable to find Ingress support in this Kubernetes cluster! Traffic forwarding to HTTP services will not work! Please report this issue to KubeSail! https://gitter.im/KubeSail',
        { baseApi, ingVersion, debugKeys }
      )
    }
  }

  // Watch for changes to the ingress endpoint
  async watchForIngresses() {
    if (!this.ingressApi) {
      logger.error('Unable to watchForIngresses, initial findIngresses may have failed')
      return
    }
    const stream = await this.ingressApi.watch.ingresses // .namespaces('*')
      .getObjectStream()

    stream.on('error', err => {
      logger.error('watchForIngresses stream error', { errMsg: err.message })
    })
    stream.on('disconnect', () => {
      logger.info('watchForIngresses stream disconnect', {})
      this.watchForIngresses()
    })

    stream.on('data', async event => {
      if (event.type === 'ADDED') {
        this.ingresses.push(event.object)
      }
      if (event.type === 'MODIFIED') {
        this.ingresses = this.ingresses.map(ing => {
          if (
            ing.metadata.name === event.object.metadata.name &&
            ing.metadata.namespace === event.object.metadata.namespace
          ) {
            return event.object
          }
          return ing
        })
      }
      if (event.type === 'DELETED') {
        this.ingresses = this.ingresses.filter(
          ing =>
            ing.metadata.name !== event.object.metadata.name &&
            ing.metadata.namespace !== event.object.metadata.namespace
        )
      }
      await this.setIngressHostnames()
    })
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
      logger.debug('Sending hostMappingRequest', { newIngressHostnames })
      const { statusCode } = await this.apiRequest('/agent/host-mapping-request', 'POST', {
        agentKey: KUBESAIL_AGENT_KEY,
        agentSecret: KUBESAIL_AGENT_SECRET,
        ingressHostnames: newIngressHostnames
      })
      logger.silly('hostMappingRequest status', { statusCode })
    }
  }
}

module.exports = KsAgent
