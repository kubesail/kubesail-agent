// @flow

const https = require('https')
/* flow-include
const net = require('net')
*/

// const Redis = require('./redis')
const logger = require('../shared/logger')
const {
  KUBESAIL_API_SECRET,
  KUBESAIL_API_TARGET,
  GATEWAY_ADDRESS,
  ALWAYS_VALID_DOMAINS,
  GATEWAY_INTERNAL_ADDRESS
} = require('../shared/config')

const [KubeSailApiTarget, KubeSailApiPort] = KUBESAIL_API_TARGET.split(':')

// const redis = Redis('CACHE')
const AGENT_REGISTER_VALID = 200
const AGENT_REGISTER_PENDING = 202

module.exports = async function agentAuthHandler(
  socket /*: Socket */,
  retries /*: number */ = 0
) /*: false|{ validDomains: Array<string>, clusterAddress: string } */ {
  const agentKey = socket.handshake.query.key
  const agentSecret = socket.handshake.query.secret
  const username = socket.handshake.query.username

  const removeSocket = () => {
    socket.leave(socket.__agentKey)
    socket.leave(socket.__clusterAddress)
    const domains = this.localSocketReverseMapping[socket.id]
    if (domains) {
      for (let i = 0; i < domains.length; i++) {
        const host = domains[i]
        delete this.localSocketMapping[host]
        socket.leave(host)
      }
    }
    delete this.localSocketMapping[socket.__clusterAddress]
    delete this.localSocketReverseMapping[socket.id]
  }

  const bindSocketEvents = () => {
    socket.__agentKey = agentKey
    socket.join(agentKey)
    socket.on('config-response', ({ kubeConfig }) => {
      logger.debug('Received config-response. POSTing to API.')
      const req = https.request({ ...options, path: '/agent/config' }, res => {
        logger.info('agent config-response from api', { statusCode: res.statusCode })
      })
      req.write(
        JSON.stringify({ kubeConfig, agentKey, agentSecret, gatewaySecret: KUBESAIL_API_SECRET })
      )
      req.end()
    })

    socket.on('disconnect', msg => {
      removeSocket()
      logger.debug('Socket disconnected, cleaning up', { socketId: socket.id })
    })
  }

  logger.debug('Setting socket id mapping:', {
    socketId: socket.id,
    gatewayAddress: GATEWAY_INTERNAL_ADDRESS
  })
  await this.redis.set(socket.id, GATEWAY_INTERNAL_ADDRESS)

  const postData = JSON.stringify({
    username,
    agentKey,
    agentSecret,
    gatewaySecret: KUBESAIL_API_SECRET,
    gatewayAddress: GATEWAY_ADDRESS
  })

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

  const req = https.request({ ...options, path: '/agent/register' }, res => {
    if (res.statusCode === AGENT_REGISTER_VALID || res.statusCode === AGENT_REGISTER_PENDING) {
      bindSocketEvents()
    }
    if (res.statusCode === AGENT_REGISTER_VALID) {
      let buff = ''
      res.on('data', chunk => (buff = buff + chunk))
      res.on('end', () => {
        const parsed = JSON.parse(buff)
        const clusterAddress = parsed.clusterAddress
        const validDomains = parsed.validDomains.concat(ALWAYS_VALID_DOMAINS).filter(Boolean)
        logger.info('Agent registered! Sending configuration', {
          agentKey,
          validDomains,
          clusterAddress
        })
        socket.__clusterAddress = clusterAddress
        this.addSocketMapping(socket, [clusterAddress, ...validDomains])
        socket.emit('agent-data', { validDomains, clusterAddress })
      })
    } else if (res.statusCode === AGENT_REGISTER_PENDING) {
      logger.info('New agent pending', { agentKey })
    } else {
      logger.debug('Disconnected agent due to invalid agentAuthHandler reply' + res.statusCode)
      socket.disconnect()
    }
  })

  req.on('error', e => {
    logger.error('Failed to register agent with KubeSail API', {
      errMsg: e.message,
      code: e.code,
      type: e.type,
      retries
    })
    const retry = () => {
      setTimeout(() => {
        agentAuthHandler.call(this, socket, retries)
      }, Math.min(retries, 30) * 1500)
      retries++
    }
    if (e.code === 'ECONNREFUSED') retry()
  })

  req.write(postData)
  req.end()
}
