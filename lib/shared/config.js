// @flow

const { getRelease } = require('./node')
const RELEASE = getRelease().substr(0, 7)
const APP_ENV = process.env.APP_ENV || 'local'
const LOGGING_LABEL = process.env.LOGGING_LABEL || 'kubesail-agent'

const config = {
  LOG_FILE: process.env.LOG_FILE,
  LOG_LEVEL: process.env.LOG_LEVEL || 'debug',
  LOGGING_LABEL,
  APP_ENV,
  RELEASE,
  REDIS_SERVERS: [{ host: 'redis', port: 6379 }],
  REDIS_SESSION_SERVERS: [{ host: 'redis', port: 6379 }],
  GATEWAY_LISTEN_PORT: parseInt(process.env.GATEWAY_LISTEN_PORT || 4000, 10),
  METRICS_LISTEN_PORT: parseInt(process.env.METRICS_LISTEN_PORT || 5000, 10),
  AGENT_HTTP_LISTEN_PORT: parseInt(process.env.METRICS_LISTEN_PORT || 8080, 10),
  AGENT_GATEWAY_TARGET: process.env.AGENT_GATEWAY_TARGET || 'https://kubesail-gateway:4000',
  TLS_KEY_PATH: process.env.TLS_KEY_PATH || `${process.cwd()}/secrets/tls.key.pem`,
  TLS_CERT_PATH: process.env.TLS_CERT_PATH || `${process.cwd()}/secrets/tls.crt.pem`,
  TLS_CHAIN_PATH: process.env.TLS_CHAIN_PATH
}

module.exports = config
