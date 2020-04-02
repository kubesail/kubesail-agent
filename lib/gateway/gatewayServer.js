// @flow

const express = require('express')

const bodyParser = require('body-parser')
const timeout = require('connect-timeout')
const helmet = require('helmet')
const morgan = require('morgan')
const { isFQDN } = require('validator')
const CIDRMatcher = require('cidr-matcher')

const logger = require('../shared/logger')
const {
  LOG_FORMAT,
  KUBESAIL_API_SECRET,
  ALWAYS_VALID_DOMAINS,
  KUBESAIL_FIREWALL_WHITELIST
} = require('../shared/config')

function getRealIp(req /*: express$Request */) {
  let realIp =
    req.headers['x-real-ip'] ||
    req.headers['x-forwarded-for'] ||
    (req.connection && req.connection.remoteAddress) ||
    // $FlowIssue
    req.address // for websocket
  // Some proxies will append a list of ip addresses - the "remote ip" is the first in the list
  if (realIp && realIp.indexOf(',') > -1) {
    realIp = realIp.split(',')[0]
  }

  const ipv4 = realIp.substring(realIp.lastIndexOf(':') + 1, realIp.length)

  return ipv4
}

morgan.token('remote-addr', getRealIp)

module.exports = function() {
  const server = express()
  server.use(bodyParser.urlencoded({ extended: false }))
  const bodyParserJson = bodyParser.json()
  server.use(timeout(30000))
  server.use(bodyParserJson)
  server.use(
    morgan(LOG_FORMAT, {
      skip: function skipHealthCheckLogs(req, res) {
        return (req.path === '/health' || req.path === '/healthz') && res.statusCode === 200
      }
    })
  )
  if (process.env.NODE_ENV !== 'development') {
    server.use(helmet.hsts({ maxAge: 31536000000, includeSubDomains: true, force: true }))
  }

  // Firewall
  server.use((req, res, next) => {
    const ipv4 = getRealIp(req)
    const matcher = new CIDRMatcher(KUBESAIL_FIREWALL_WHITELIST)
    if (!matcher.contains(ipv4)) {
      logger.debug('Rejecting request!', { ipv4 })
      res.sendStatus(403)
    } else {
      next()
    }
  })

  server.post('/agent/verify/:secret', async (req, res) => {
    if (req.params.secret !== KUBESAIL_API_SECRET) return res.sendStatus(403)
    const { agentKey, clusterAddress } = req.body

    if (!isFQDN(clusterAddress)) {
      logger.debug('/agent/verify recieved non-FQDN clusterAddress', { clusterAddress })
      return res.sendStatus(400)
    }

    // Send the agent it's initial configuration
    this.agentRegistrationSocketServer.to(agentKey).emit('agent-data', {
      validDomains: [].concat(ALWAYS_VALID_DOMAINS).filter(Boolean),
      clusterAddress,
      firewallRules: {}
    })

    // Request the config from the agent
    // TODO: Store a key in redis indicating its been verified and we need this agents config.
    // If the agent isn't currently connected, it won't get its config-request :(
    this.agentRegistrationSocketServer.to(agentKey).emit('config-request', clusterAddress)

    this.agentRegistrationSocketServer.in(agentKey).adapter.clients(async (err, sockets) => {
      if (err) {
        logger.error('/agent/verify, adapter.clients() failure', { errMsg: err.message })
        return res.sendStatus(500)
      }
      for (const socketId of sockets) {
        const socket = this.socketMapping[socketId]
        await this.addSocketMapping(socket, [clusterAddress])
      }
      logger.info('/agent/verify complete!', { agentKey, clusterAddress })
      res.sendStatus(202)
    })
  })

  server.put('/agent/config/request/:secret', async (req, res) => {
    if (req.params.secret !== KUBESAIL_API_SECRET) return res.sendStatus(403)
    const { agentKey, clusterAddress } = req.body
    this.agentRegistrationSocketServer.to(agentKey).emit('config-request', clusterAddress)
    logger.info('Emitting config refresh request to agent', { clusterAddress })
    res.sendStatus(202)
  })

  server.get('/agent/health/:secret/:agentKey', (req, res) => {
    if (req.params.agentKey && req.params.secret === KUBESAIL_API_SECRET) {
      this.agentRegistrationSocketServer.to(req.params.agentKey).emit('health-check')
      const { connected } = this.agentRegistrationSocketServer.in(req.params.agentKey)
      return res.send({ connected: !!connected })
    } else return res.sendStatus(403)
  })

  server.put('/agent/watch/:startOrStop/:secret', async (req, res) => {
    if (KUBESAIL_API_SECRET !== req.params.secret) return res.sendStatus(403)
    const { startOrStop } = req.params
    const { username, agentKey, namespace } = req.body
    this.agentRegistrationSocketServer
      .to(agentKey)
      .emit('kube-watch', { username, startOrStop, namespace })
    logger.silly('Emitting kube-watch request to agent', { username, agentKey, startOrStop })
    res.status(202).send('{}')
  })

  server.get('/health', (req, res) => {
    res.sendStatus(200)
  })

  return server
}
