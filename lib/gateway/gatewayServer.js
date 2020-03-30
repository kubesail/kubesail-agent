// @flow

const express = require('express')

const bodyParser = require('body-parser')
const timeout = require('connect-timeout')
const helmet = require('helmet')
const morgan = require('morgan')
const { isFQDN } = require('validator')

const logger = require('../shared/logger')
const { LOG_FORMAT, KUBESAIL_API_SECRET } = require('../shared/config')

morgan.token('remote-addr', function getRealIp(req /*: express$Request */) {
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
  return realIp
})

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

  server.post('/agent/verify/:secret', async (req, res) => {
    if (req.params.secret !== KUBESAIL_API_SECRET) return res.sendStatus(403)
    const { agentKey, clusterAddress } = req.body

    if (!isFQDN(clusterAddress)) {
      logger.debug('/agent/verify recieved non-FQDN clusterAddress', { clusterAddress })
      return res.sendStatus(400)
    }

    // Request the config from the agent
    // TODO: Store a key in redis indicating its been verified and we need this agents config.
    // If the agent isn't currently connected, it won't get its config-request :(
    this.agentRegistrationSocketServer.to(agentKey).emit('config-request', clusterAddress)

    // Either way, send the agent it's configuration
    this.agentRegistrationSocketServer.to(agentKey).emit('agent-data', {
      validDomains: [],
      clusterAddress
    })

    this.agentRegistrationSocketServer.in(agentKey).adapter.clients(async (err, sockets) => {
      if (err) throw err
      for (const socket of sockets) {
        await this.addSocketMapping(socket, [clusterAddress])
      }
    })

    logger.info('gatewayHTTPSServer /agent/verify', { agentKey })
    res.sendStatus(202)
  })

  server.get('/agent/health/:secret/:agentKey', (req, res) => {
    if (req.params.agentKey && req.params.secret === KUBESAIL_API_SECRET) {
      this.agentRegistrationSocketServer.to(req.params.agentKey).emit('health-check')
      const { connected } = this.agentRegistrationSocketServer.in(req.params.agentKey)
      return res.send({ connected: !!connected })
    } else return res.sendStatus(403)
  })

  server.get('/agent/metrics/:secret', (req, res) => {
    if (req.params.agentKey && req.params.secret === KUBESAIL_API_SECRET) {
      return res.send({})
    } else return res.sendStatus(403)
  })

  server.get('/health', (req, res) => {
    res.sendStatus(200)
  })

  return server
}
