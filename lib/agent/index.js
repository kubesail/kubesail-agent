// @flow

const net = require('net')
const fs = require('fs')
const http = require('http')
const url = require('url')

const { Client } = require('kubernetes-client')
const socketio = require('socket.io-client')
const socketioStream = require('socket.io-stream')

const logger = require('../shared/logger')
const { initProm } = require('../shared/prom')
const { sampleArray } = require('../shared/node')
const {
  AGENT_HTTP_LISTEN_PORT,
  AGENT_GATEWAY_TARGET,
  AGENT_API_TOKEN,
  TLS_CERT_PATH,
  INGRESS_CONTROLLER_NAMESPACE,
  INGRESS_CONTROLLER_ENDPOINT
} = require('../shared/config')

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
  k8sClient /*: Client */ = new Client()

  // Derive the kubeApi URL from our loaded service account backend (returns a local address like 10.x.x.x)
  kubeApiUrl = new url.URL(this.k8sClient.backend.requestOptions.baseUrl)

  // Our established socket with a KubeSail Gateway instance
  gatewaySocket /*: Socket */ = socketio(`${AGENT_GATEWAY_TARGET}?token=${AGENT_API_TOKEN}`, {
    ca: fs.readFileSync(TLS_CERT_PATH),
    autoConnect: false
  })

  // Our current namespace
  ourNamespace /*: string */

  // The DNS name of our cluster from the internet - retrieved from agentData
  clusterAddress /*: string */ = ''

  // Domains the gateway will be forwarding to us
  validDomains /* string */ = []

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

  constructor() {
    if (!AGENT_API_TOKEN) {
      throw new Error('No AGENT_API_TOKEN defined! Please provide this environment variable!')
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
    // Begins the metrics service
    initProm()

    // Load specific openapi spec for the cluster we're in - this is a bit slow but it helps support various versions of kube better.
    const spec = await this.k8sClient.backend.http({ method: 'GET', pathname: '/openapi/v2' })
    this.k8sClient._addSpec(spec.body)

    // Determine the ingress controller's address and watch for future changes to it
    await this.findIngressControllerEndpoints()
    await this.watchForIngressEndpointChanges()
    await this.registerWithGateway()

    this.http.listen(AGENT_HTTP_LISTEN_PORT, () => {
      this.agentReady = true
      logger.info('kubesail-agent ready!', {
        AGENT_GATEWAY_TARGET,
        NODE_ENV: process.env.NODE_ENV
      })
    })
  }

  // Registers with the KubeSail Gateway and establishes a proxy socket
  registerWithGateway() {
    return new Promise((resolve, reject) => {
      const requestHandler = protocol => (stream, { host }) => {
        if (!this.validDomains.includes(host)) {
          logger.debug('Invalid domain provided', { host })
          stream.end(`HTTP/1.1 404 INVALID_DOMAIN\n\n`)
        } else if (`https://${host}` === this.clusterAddress) {
          logger.debug('Forwarding Kube API request', { host })
          stream.end(`HTTP/1.1 404 INVALID_DOMAIN\n\n`)
        } else {
          const endpoint = sampleArray(this.resources.endpoints)

          const socket = new net.Socket()

          // TODO: These port numbers should be configurable (findIngressControllerEndpoints has this info)
          let port = 80
          if (protocol === 'https') port = 443

          logger.debug('Forwarding Ingress controller request', {
            host,
            endpoint,
            port
          })
          socket.connect(port, endpoint, () => {
            socket.pipe(stream)
            stream.pipe(socket)
          })
          socket.on('close', () => {
            stream.end()
          })
          stream.on('close', () => {
            socket.end()
          })
        }
      }
      socketioStream(this.gatewaySocket).on('http', requestHandler('http'))
      socketioStream(this.gatewaySocket).on('https', requestHandler('https'))

      this.gatewaySocket.on('agentData', agentData => {
        this.validDomains = agentData.validDomains
        this.clusterAddress = agentData.clusterAddress
        logger.debug('Agent successfully connected to gateway!', {
          AGENT_GATEWAY_TARGET,
          agentData
        })
        resolve()
      })
      this.gatewaySocket.on('error', error => {
        logger.warn('Socket error:', { type: error.type, description: error.description })
      })
      this.gatewaySocket.on('connect_error', error => {
        logger.warn('Socket connect_error:', { type: error.type, description: error.description })
      })
      this.gatewaySocket.on('connect_timeout', timeout => {
        logger.warn('Socket connect_timeout:', timeout)
      })

      this.gatewaySocket.open()
    })
  }

  // Tries to determine the endpoint for the ingress controller so we can pass traffic to it
  async findIngressControllerEndpoints() {
    const endpoint = await this.k8sClient.api.v1
      .namespaces(INGRESS_CONTROLLER_NAMESPACE)
      .endpoints(INGRESS_CONTROLLER_ENDPOINT)
      .get()

    await this.setIngressControllerEndpoint(endpoint.body)
  }

  // Sets this.resources.endpoints to the address/port of the ingress controller
  async setIngressControllerEndpoint(endpoint /*: Object */) {
    this.resources.endpoints = Array.prototype.concat(
      ...endpoint.subsets.map(subset => {
        return subset.addresses.map(address => address.ip)
      })
    )
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
