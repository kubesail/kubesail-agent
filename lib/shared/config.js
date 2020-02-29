// @flow

const fs = require('fs')

// Parses a string of URIs like: "host:port,host:port..."
// into an array of objects like: [ { host: "host", port: "port" }]
function parseUris(urisStr /*: any */) /*: Array<{ host: string, port: number }> */ {
  if (typeof urisStr !== 'string') return []
  const uris = urisStr.split(',')
  const out = []
  for (let i = 0; i < uris.length; i++) {
    const [host, port] = uris[i].split(':')
    out.push({ host, port: parseInt(port, 10) })
  }
  return out
}

function getRelease() {
  try {
    return fs.readFileSync('.release').toString()
  } catch (err) {
    return 'development'
  }
}

const RELEASE = getRelease().substr(0, 7)
const LOGGING_LABEL = process.env.LOGGING_LABEL || 'kubesail-agent'

const config = {
  // Common options:
  METRICS_LISTEN_PORT: parseInt(process.env.METRICS_LISTEN_PORT || 5000, 10),
  TLS_KEY_PATH: process.env.TLS_KEY_PATH || `${process.cwd()}/secrets/tls.key`,
  TLS_CERT_PATH: process.env.TLS_CERT_PATH || `${process.cwd()}/secrets/tls.crt`,
  TLS_CHAIN_PATH: process.env.TLS_CHAIN_PATH,

  // Logging options:
  LOG_LEVEL: process.env.LOG_LEVEL || 'debug',
  LOGGING_LABEL,
  RELEASE,

  // Gateway options:
  REDIS_SERVERS: parseUris(process.env.REDIS_SERVERS || 'kubesail-gateway-redis:6379'),
  GATEWAY_AGENT_LISTEN_PORT: parseInt(process.env.GATEWAY_HTTPS_LISTEN_PORT || 8000, 10), // Used for agents to register
  GATEWAY_HTTP_LISTEN_PORT: parseInt(process.env.GATEWAY_HTTP_LISTEN_PORT || 8080, 10), // Used for inbound http traffic
  GATEWAY_HTTPS_LISTEN_PORT: parseInt(process.env.GATEWAY_HTTPS_LISTEN_PORT || 8443, 10), // Used for inbound https traffic,
  INTERNAL_HTTPS_RESPONDER_PORT: 9000,
  KUBESAIL_API_SECRET: process.env.KUBESAIL_API_SECRET || 'KUBESAIL_API_SECRET',
  KUBESAIL_API_TARGET: process.env.KUBESAIL_API_TARGET || 'api.kubesail.com',
  GATEWAY_ADDRESS: process.env.GATEWAY_ADDRESS || 'kubesail-gateway.default.svc.cluster.local',
  SHUTDOWN_GRACE: parseInt(process.env.SHUTDOWN_GRACE || 3000, 10),

  // Agent Options:
  KUBESAIL_AGENT_USERNAME: process.env.KUBESAIL_AGENT_USERNAME,
  KUBESAIL_AGENT_KEY: process.env.KUBESAIL_AGENT_KEY,
  KUBESAIL_AGENT_SECRET: process.env.KUBESAIL_AGENT_SECRET,
  AGENT_HTTP_LISTEN_PORT: parseInt(process.env.METRICS_LISTEN_PORT || 6000, 10), // Used for healthchecks internally on the agent cluster
  AGENT_GATEWAY_TARGET: process.env.AGENT_GATEWAY_TARGET || 'https://kubesail-gateway:8000', // Used to register with the gateway
  INGRESS_CONTROLLER_NAMESPACE: process.env.INGRESS_CONTROLLER_NAMESPACE || 'default',
  INGRESS_CONTROLLER_ENDPOINT:
    process.env.INGRESS_CONTROLLER_ENDPOINT || 'my-ingress-controller-nginx-ingress',

  // Constants
  NO_SOCKETS_CONNECTED: 'NO_SOCKETS_CONNECTED',
  SOCKET_CONNECTED_ELSEWHERE: 'SOCKET_CONNECTED_ELSEWHERE',
  SOCKET_CONNECTED_HERE: 'SOCKET_CONNECTED_HERE',

  // Helpers
  getRelease,
  parseUris
}

module.exports = config
