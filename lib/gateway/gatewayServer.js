// @flow

const express = require('express')

const bodyParser = require('body-parser')
const timeout = require('connect-timeout')
const helmet = require('helmet')
const morgan = require('morgan')
const { isFQDN } = require('validator')

const logger = require('../shared/logger')
const { LOG_FORMAT, KUBESAIL_API_SECRET, RELEASE } = require('../shared/config')
// const redis = require('./redis')

function getRealIp(req /*: express$Request */) {
  let realIp =
    req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress || req.address
  // Some proxies will append a list of ip addresses - the "remote ip" is the first in the list
  if (realIp && realIp.indexOf(',') > -1) {
    realIp = realIp.split(',')[0]
  }
  const ipv4 = realIp.substring(realIp.lastIndexOf(':') + 1, realIp.length)
  return ipv4
}

morgan.token('remote-addr', getRealIp)
morgan.token('x-real-ip', req => req.headers['x-real-ip'])
morgan.token('x-forwarded-for', req => req.headers['x-forwarded-for'])
morgan.token('conn-addr', req => req?.socket?.remoteAddress || '')
morgan.token('sanitized-url', (req, _res) => req.path.replace(KUBESAIL_API_SECRET, 'KUBESAIL_API_SECRET'))

module.exports = function () {
  const server = express()
  server.use(bodyParser.urlencoded({ extended: false }))
  const bodyParserJson = bodyParser.json()
  server.use(timeout(30000))
  server.use(bodyParserJson)
  server.use(
    morgan(LOG_FORMAT, {
      skip: function skipHealthCheckLogs(req, res) {
        return (
          (req.method === 'OPTIONS' || req.path === '/health' || req.path === '/healthz') &&
          res.statusCode === 200
        )
      }
    })
  )
  if (process.env.NODE_ENV !== 'development') {
    server.use(helmet.hsts({ maxAge: 31536000000, includeSubDomains: true, force: true }))
  }
  server.use(function (_req, res, next) {
    res.setHeader('X-Powered-By', `KubeSail Gateway ${RELEASE}`)
    next()
  })

  // Webhook called when verified by user from KubeSail.com
  server.post('/agent/verify/:secret', async (req, res) => {
    if (req.params.secret !== KUBESAIL_API_SECRET) return res.sendStatus(403)
    const { agentKey, clusterAddress, email, wasCreated } = req.body
    if (!isFQDN(clusterAddress)) {
      logger.debug('/agent/verify received non-FQDN clusterAddress', { clusterAddress })
      return res.sendStatus(400)
    }
    // Update the mapping for this agentKey
    await this.addAgentSocketMapping({
      wasCreated,
      agentKey,
      clusterAddress,
      firewall: { [clusterAddress]: 1 },
      email,
      refreshCredentials: true
    })

    logger.info('/agent/verify complete', { agentKey, clusterAddress })
    return res.sendStatus(202)
  })

  server.post('/agent/:secret/claim', async (req, res) => {
    if (req.params.secret !== KUBESAIL_API_SECRET) return res.sendStatus(403)
    const { agentKey, agentSecret, username, pendingKey } = req.body
    if (this.unclaimedAgents[pendingKey]) {
      logger.debug('Claiming un-claimed agent', { pendingKey, agentKey })
      this.unclaimedAgents[pendingKey].emit('set-credentials', { agentKey, agentSecret, username })
      return res.sendStatus(200)
    } else {
      logger.debug("Couldn't find agent to claim", { pendingKey })
      return res.sendStatus(404)
    }
  })

  server.post('/agent/:secret/qr-scanned', async (req, res) => {
    if (req.params.secret !== KUBESAIL_API_SECRET) return res.sendStatus(403)
    const { pendingKey } = req.body
    if (this.unclaimedAgents[pendingKey]) {
      logger.debug('Emitting QR Scanned event', { pendingKey })
      this.unclaimedAgents[pendingKey].emit('qr-scanned')
      return res.sendStatus(200)
    } else {
      logger.debug("Couldn't find agent to emit QR scan event to", { pendingKey })
      return res.sendStatus(400)
    }
  })

  // Webhook when KubeSail API requests a new config from the agent
  server.put('/agent/config-request/:secret', async (req, res) => {
    if (req.params.secret !== KUBESAIL_API_SECRET) return res.sendStatus(403)
    const { agentKey } = req.body
    logger.info('config-request request:', { agentKey })
    await this.messageAgent(agentKey, 'config-request')
    return res.sendStatus(200)
  })

  // Ask the agent for its disk stats
  server.put('/agent/disk-stats/:secret', async (req, res) => {
    if (req.params.secret !== KUBESAIL_API_SECRET) return res.sendStatus(403)
    const { agentKey } = req.body
    logger.info('disk-stats request:', { agentKey })
    await this.messageAgent(agentKey, 'disk-stats')
    return res.sendStatus(200)
  })

  server.put('/agent/:secret/:agentKey', async (req, res) => {
    if (req.params.secret !== KUBESAIL_API_SECRET) return res.sendStatus(403)
    const { agentKey } = req.params
    const { firewall, clusterAddress } = req.body
    logger.debug('AgentConfigUpdate', {
      agentKey,
      clusterAddress,
      firewall: JSON.stringify(firewall)
    })
    await this.addAgentSocketMapping({ agentKey, clusterAddress, firewall })
    return res.sendStatus(200)
  })

  server.delete('/agent/:secret/:agentKey', async (req, res) => {
    if (req.params.secret !== KUBESAIL_API_SECRET) return res.sendStatus(403)
    const { agentKey } = req.params
    logger.info('Un-registering agent', { agentKey })
    await this.redis.setex(agentKey, process.env.NODE_ENV ? 30 : 3600 * 24, 'removed')
    await this.messageAgent(agentKey, 'remove-cluster')
    return res.sendStatus(200)
  })

  server.get('/agent/health/:secret/:agentKey', async (req, res) => {
    if (req.params.agentKey && req.params.secret === KUBESAIL_API_SECRET) {
      const agentKey = req.params.agentKey
      await this.messageAgent(agentKey, 'health-check')
      const [connected, healthData] = await this.redis.mget(`akhm|${agentKey}`, `healthcheck|${agentKey}`)
      let healthCheckData = {}
      // Backwards compatibility
      if (healthData && healthData[0] !== '{') {
        healthCheckData = { lastCheckIn: healthData }
      } else {
        try {
          healthCheckData = JSON.parse(healthData || {})
        } catch (err) {
          logger.error('Failed to parse healthCheckData', { healthData })
        }
      }
      return res.send({ connected: !!connected, ...healthCheckData })
    } else return res.sendStatus(403)
  })

  server.put('/agent/watch/:startOrStop/:secret', async (req, res) => {
    if (KUBESAIL_API_SECRET !== req.params.secret) return res.sendStatus(403)
    const { startOrStop } = req.params
    const { username, agentKey, namespace } = req.body
    await this.messageAgent(agentKey, 'kube-watch', { username, startOrStop, namespace })
    logger.silly('Emitting kube-watch request to agent', {
      username,
      namespace,
      agentKey,
      startOrStop
    })
    return res.sendStatus(202)
  })

  server.get('/stats/:secret', async (req, res) => {
    if (req.params.secret !== KUBESAIL_API_SECRET) return res.sendStatus(403)
    let adminStats = {
      hostMapSize: this.hostMap.size,
      socketMapSize: Object.keys(this.socketMap).length
    }
    logger.info('admin stats', adminStats)
    const agentKey = req.query.agentKey
    if (agentKey) {
      const [connected, healthData] = await this.redis.mget(`akhm|${agentKey}`, `healthcheck|${agentKey}`)
      adminStats.connected = !!connected
      if (healthData) {
        adminStats.healthCheckData = JSON.parse(healthData)
      }
    }

    const memUsage = process.memoryUsage()
    logger.info('Memory Usage', memUsage)

    return res.send({ adminStats, memUsage })
  })

  server.get('/health', (req, res) => {
    return res.sendStatus(200)
  })

  return server
}
