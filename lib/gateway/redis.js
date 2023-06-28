// @flow

const Redis = require('ioredis')
const { REDIS_SERVERS } = require('../shared/config')
const logger = require('../shared/logger')

/* flow-include
type redisTargets = 'SHARED'
*/

const redisOptions = {
  lazyConnect: true,
  connectTimeout: 10000,
  retryStrategy: function (times) {
    return Math.min(times * 500, 3000)
  },
  reconnectOnError: function (err) {
    if (err.code === 'ETIMEDOUT' || err.code === 'ECONNREFUSED') {
      logger.error(`Redis ${err.code}! Reconnecting...`)
    } else if (err.message.slice(0, 'READONLY'.length) === 'READONLY') {
      logger.error('Connected to READONLY Redis instance! Reconnecting...')
    } else {
      logger.error('Redis reconnectOnError: Unknown!', {
        errCode: err.code,
        errMessage: err.message,
        err
      })
    }
    return 2
  }
}

const redises = {
  SHARED: { handle: undefined, servers: REDIS_SERVERS }
}

module.exports = function redis(target /*: redisTargets */, forceNew /*: boolean */ = false) {
  if (!redises[target]) throw new Error(`No such redis "${target}" defined!`)
  if (redises[target].handle && !forceNew) return redises[target].handle

  const redisHost = redises[target].servers[0].host
  const redisPort = redises[target].servers[0].port

  let handle
  if (redises[target].servers.length > 1) {
    handle = new Redis.Cluster(redises[target].servers, { redisOptions })
  } else if (redises[target].servers.length === 1) {
    handle = Redis.createClient(redisPort, redisHost, redisOptions)
  } else {
    // Dummy, for testing - errors on use
    handle = new Redis({
      lazyConnect: true,
      enableOfflineQueue: false,
      reconnectOnError: () => false
    })
  }

  handle.on('error', err => {
    logger.error('Unknown Redis error (handler)!', {
      redisHost,
      redisPort,
      errCode: err.code,
      errMessage: err.message
    })
  })

  handle.waitForReady = function () {
    return new Promise((resolve, reject) => {
      let resolved = false
      const connected = () => {
        if (resolved) return
        resolved = true
        resolve(handle)
      }
      if (handle.status === 'ready' || handle.status === 'connected') return connected()
      else if (handle.status !== 'connecting') {
        handle.once('connect', () => connected())
        handle.connect().catch(_err => {})
      }
    })
  }

  if (forceNew) return handle
  else {
    redises[target].handle = handle
    return redises[target].handle
  }
}
