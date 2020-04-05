// @flow

const net = require('net')
const fs = require('fs')
const path = require('path')
const http = require('http')
const https = require('https')
const url = require('url')

const { Client } = require('kubernetes-client')
const socketio = require('socket.io-client')
const socketioStream = require('socket.io-stream')

const logger = require('../shared/logger')
const { initProm } = require('../shared/prom')
const { sampleArray, writeHeader } = require('../shared')
const {
  KUBESAIL_AGENT_HTTP_LISTEN_PORT,
  KUBESAIL_AGENT_GATEWAY_TARGET,
  KUBESAIL_AGENT_USERNAME,
  KUBESAIL_AGENT_KEY,
  KUBESAIL_AGENT_SECRET,
  TLS_KEY_PATH,
  TLS_CERT_PATH,
  INGRESS_CONTROLLER_NAMESPACE,
  INGRESS_CONTROLLER_ENDPOINT,
  INTERNAL_HTTPS_RESPONDER_PORT,
  DOCUMENTS_TO_WATCH,
  KUBESAIL_API_TARGET
} = require('../shared/config')
const [KubeSailApiTarget, KubeSailApiPort] = KUBESAIL_API_TARGET.split(':')

if (!fs.existsSync(TLS_CERT_PATH)) {
  throw new Error(`TLS_CERT_PATH ${TLS_CERT_PATH} does not exist! Exiting!`)
}

const connectionOptions = {}
// TODO: Remove this, even in development!
if (process.env.NODE_ENV === 'development') {
  connectionOptions.ca = fs.readFileSync(TLS_CERT_PATH)
  connectionOptions.insecure = true
  connectionOptions.rejectUnauthorized = false
}

const connectionString = `${KUBESAIL_AGENT_GATEWAY_TARGET}?username=${KUBESAIL_AGENT_USERNAME ||
  ''}&key=${KUBESAIL_AGENT_KEY || ''}&secret=${KUBESAIL_AGENT_SECRET || ''}`

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

  // Indicates agent is ready to take traffic
  // will fail healthchecks when falsey (used mainly to prevent recieving traffic before we're ready)
  agentReady = false

  // A 'kubernetes-client' connection to the cluster we're located in, using our in-pod service account
  k8sClient = new Client()

  // Our established socket with a KubeSail Gateway instance
  gatewaySocket = socketio(connectionString, {
    autoConnect: false,
    transports: ['websocket'],
    timeout: 5000,
    ...connectionOptions
  })

  // Our current namespace
  ourNamespace /*: string */

  // The DNS name of our cluster from the internet - retrieved from agent-data
  clusterAddress /*: string */ = ''

  // Domains the gateway will be forwarding to us
  validDomains /* string */ = []

  // Rules used to filter traffic
  firewallRules = {}

  // Users currently watching resources via agent-kube-watch
  watchingNamespaces = {}

  // KubeWatch streams open
  watchingStreams = []

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
      res.sendStatus(404)
    }
  )

  constructor() {
    if (!KUBESAIL_AGENT_KEY || !KUBESAIL_AGENT_SECRET) {
      throw new Error(
        'No KUBESAIL_AGENT_KEY or KUBESAIL_AGENT_SECRET defined! Please provide these environment variables!'
      )
    }

    // Load namespace programatically if we're in a Kube cluster
    if (!this.ourNamespace) {
      const namespaceFile = '/run/secrets/kubernetes.io/serviceaccount/namespace'
      if (fs.existsSync(namespaceFile)) {
        this.ourNamespace = fs.readFileSync(namespaceFile).toString()
      } else {
        throw new Error(
          'Could not determine our namespace and none defined in config! Are we running in a Kubernetes cluster?'
        )
      }
    }

    this.http.on('error', function serverErrorHandler(error /*: Error */) {
      throw error
    })
  }

  // Starts the Agent service, connects tunnels and marks agentReady when ready.
  async init() {
    logger.debug('kubesail-agent starting!')

    // Begins the metrics service
    initProm()

    // Load specific openapi spec for the cluster we're in - this is a bit slow but it helps support various versions of kube better.
    const spec = await this.k8sClient.backend.http({ method: 'GET', pathname: '/openapi/v2' })
    this.k8sClient._addSpec(spec.body)

    // Determine the ingress controller's address and watch for future changes to it
    await this.findIngressControllerEndpoints()
    await this.watchForIngressEndpointChanges()
    await this.registerWithGateway()
    await this.watchAll(DOCUMENTS_TO_WATCH)

    logger.debug('kubesail-agent start to listen...')

    this.agentHttpsReplyer.listen(INTERNAL_HTTPS_RESPONDER_PORT, '127.0.0.1', () => {
      this.http.listen(KUBESAIL_AGENT_HTTP_LISTEN_PORT, () => {
        this.agentReady = true
        logger.info('kubesail-agent ready!', {
          clusterAddress: this.clusterAddress,
          validDomains: this.validDomains
        })
      })
    })
  }

  watchAll = async (docsToWatch /*: Array<Object> */) => {
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
        stream = await this.k8sClient.apis[group][version].watch[kind].getObjectStream(options)
      }

      stream.on('error', function(err) {
        logger.error('watchAll() stream error', { errMsg: err.message })
        connect(group, version, kind, resourceVersion)
      })
      stream.on('disconnect', function() {
        logger.info('watchAll() stream disconnect')
        connect(group, version, kind, resourceVersion)
      })
      stream.on('close', function() {
        logger.debug('watchAll() stream closed')
      })
      stream.on('end', function() {
        logger.silly('watchAll() stream end, reconnecting')
        connect(group, version, kind, resourceVersion)
      })
      stream.on('pause', function() {
        logger.info('watchAll() stream pause')
      })
      stream.on('data', async event => {
        if (event.type === 'ERROR' && event.object.code === 410) {
          stream.destroy()
          await connect(group, version, kind, 'newest')
        } else if (event.type === 'ERROR') {
          logger.error('watchAll() Unknown error', {
            event,
            resourceVersion
          })
          stream.destroy()
        } else {
          if (
            event &&
            event.object &&
            event.object.metadata &&
            event.object.metadata.namespace &&
            this.watchingNamespaces[event.object.metadata.namespace]
          ) {
            const data = {
              agentKey: KUBESAIL_AGENT_KEY,
              agentSecret: KUBESAIL_AGENT_SECRET,
              event
            }
            const postData = JSON.stringify(data)

            const options = {
              hostname: KubeSailApiTarget,
              headers: { 'Content-Type': 'application/json' },
              port: KubeSailApiPort,
              method: 'POST'
            }

            if (process.env.NODE_ENV === 'development') {
              options.insecure = true
              options.rejectUnauthorized = false
            }

            const req = https.request({ ...options, path: '/agent/event' }, res => {
              res.on('end', async () => {})
              res.on('error', e => {
                logger.error('Failed to post event to KubeSail API', {
                  errMsg: e.message,
                  code: e.code,
                  type: e.type
                })
              })
            })

            req.on('error', e => {
              logger.error('Failed to post event to KubeSail API', {
                errMsg: e.message,
                code: e.code,
                type: e.type
              })
            })

            req.write(postData)
            req.end()
          }
        }
      })
      this.watchingStreams.push(stream)
    }

    docsToWatch.forEach(async doc => await connect(doc.group, doc.version, doc.kind.toLowerCase()))
  }

  stopWatching = async () => {
    this.watchingStreams.forEach(stream => stream.destroy())
    this.watchingStreams = []
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
        if (host === this.clusterAddress) {
          const uri = new url.URL(this.k8sClient.backend.requestOptions.baseUrl)
          proxyTarget = uri.host
          port = uri.port || 443
        } else if (this.validDomains.includes(host)) {
          if (this.resources.endpoints.length === 0) {
            logger.warn('Received request, but no Ingress controller was found!', { host })
            return writeHeader(stream, 503, protocol, 'INVALID_DOMAIN')
          }
          proxyTarget = sampleArray(this.resources.endpoints)
        }

        if (!proxyTarget) {
          logger.debug('Invalid domain provided', {
            host,
            validDomains: this.validDomains,
            endpoints: this.resources.endpoints
          })
          return writeHeader(stream, 503, protocol, 'INVALID_DOMAIN')
        }

        const socket = new net.Socket()

        logger.silly('Forwarding Ingress controller request', {
          host,
          proxyTarget,
          port
        })
        socket.connect(port, proxyTarget, () => {
          socket.pipe(stream).pipe(socket)
        })
        socket.on('close', () => {
          try {
            stream.end()
          } catch (err) {
            logger.error('requestHandler() failed to close stream on socket close')
          }
        })
        stream.on('close', () => {
          try {
            socket.end()
          } catch (err) {
            logger.error('requestHandler() failed to close socket on stream close')
          }
        })
        socket.on('error', err => {
          if (err.message === 'Connection aborted') return socket.end()
          logger.warn('requestHandler() error on socket:', { errMsg: err.message })
          stream.end()
        })
        stream.on('error', err => {
          if (err.message === 'Connection aborted') return socket.end()
          else if (err.message === 'stream.push() after EOF') {
            logger.debug('stream: stream.push() after EOF')
            return socket.end()
          }
          logger.warn('requestHandler() error on stream:', { errMsg: err.message, name: err.name })
          socket.end()
        })
      }

      socketioStream(this.gatewaySocket).on('http', requestHandler('http'))
      socketioStream(this.gatewaySocket).on('https', requestHandler('https'))

      this.gatewaySocket.on('agent-data', agentData => {
        logger.info('Agent recieved new agent-data from gateway!', { ...agentData })
        this.clusterAddress = agentData.clusterAddress
        this.validDomains = agentData.validDomains.concat(this.clusterAddress)
        this.firewallRules = agentData.firewallRules
        resolve()
      })

      this.gatewaySocket.on('health-check', () => {
        logger.debug('Agent recieved health-check!')
      })

      this.gatewaySocket.on('config-request', clusterAddress => {
        logger.info('Received config-request')
        this.clusterAddress = clusterAddress
        const kubeConfig = this.generateKubeConfig()
        this.gatewaySocket.emit('config-response', { kubeConfig })
      })

      this.gatewaySocket.on('kube-watch', ({ username, startOrStop, namespace }) => {
        if (startOrStop === 'start') {
          logger.debug('User starting to watch namespace events', { username, namespace })
          if (!this.watchingNamespaces[namespace]) {
            this.watchingNamespaces[namespace] = [username]
          } else {
            this.watchingNamespaces[namespace].push(username)
          }
        } else {
          logger.debug('User no longer watching namespace events', { username, namespace })
          if (!this.watchingNamespaces[namespace]) return
          this.watchingNamespaces[namespace] = this.watchingNamespaces[namespace].filter(
            un => username !== un
          )
          if (this.watchingNamespaces[namespace].length === 0)
            delete this.watchingNamespaces[namespace]
        }
      })

      this.gatewaySocket.on('connect', () => {
        logger.info('Connected to gateway socket.', { KUBESAIL_AGENT_GATEWAY_TARGET })
      })
      this.gatewaySocket.on('error', error => {
        logger.warn('Socket error:', { type: error.type, description: error.description })
      })
      this.gatewaySocket.on('disconnect', reason => {
        logger.warn('Socket disconnected:', { reason })
      })

      this.gatewaySocket.on('connect_error', error => {
        logger.warn('Socket connect_error:', { type: error.type, description: error.description })
      })
      this.gatewaySocket.on('connect_timeout', timeout => {
        logger.warn('Socket connect_timeout:', timeout)
      })

      logger.info('Connecting to gateway socket...', { connectionString })
      this.gatewaySocket.open()
    })
  }

  // Tries to determine the endpoint for the ingress controller so we can pass traffic to it
  async findIngressControllerEndpoints() {
    let endpoint

    try {
      endpoint = await this.k8sClient.api.v1
        .namespaces(INGRESS_CONTROLLER_NAMESPACE)
        .endpoints(INGRESS_CONTROLLER_ENDPOINT)
        .get()
    } catch (err) {
      if (err.code === 404) {
        logger.warn(
          "Hrm, I can't find an INGRESS_CONTROLLER_ENDPOINT! I won't be able to pass traffic for you...",
          {
            INGRESS_CONTROLLER_NAMESPACE,
            INGRESS_CONTROLLER_ENDPOINT
          }
        )
      } else throw err
    }

    if (endpoint) {
      await this.setIngressControllerEndpoint(endpoint.body)
    }
  }

  // Sets this.resources.endpoints to the address/port of the ingress controller
  async setIngressControllerEndpoint(endpoint /*: Object */) {
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
    }
  }

  // Watch for changes to the ingress endpoint
  async watchForIngressEndpointChanges() {
    const stream = await this.k8sClient.api.v1.watch
      .namespaces(INGRESS_CONTROLLER_NAMESPACE)
      .endpoints(INGRESS_CONTROLLER_ENDPOINT)
      .getObjectStream()

    stream.on('error', err => {
      logger.error('watchForIngressEndpointChanges() stream error', { errMsg: err.message })
    })
    stream.on('disconnect', () => {
      logger.info('watchForIngressEndpointChanges() stream disconnect', {})
      this.watchForIngressEndpointChanges()
    })

    stream.on('data', async event => {
      if (event.type === 'ADDED' || event.type === 'MODIFIED') {
        this.setIngressControllerEndpoint(event.object)
      }
    })
  }
}

module.exports = KsAgent
