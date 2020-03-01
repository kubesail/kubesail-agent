// @flow

const Redis = require('ioredis')
const { REDIS_SERVERS } = require('../shared/config')
const logger = require('../shared/logger')

/* flow-include
type redisTargets = 'SESSION'
*/

const redisOptions = {
  retryStrategy: function(times) {
    return Math.min(times * 50, 2000)
  },
  reconnectOnError: function(err) {
    if (err.code === 'ETIMEDOUT' || err.code === 'ECONNREFUSED') {
      logger.error(`Redis ${err.code}! Reconnecting...`)
      return true
    } else if (err.message.slice(0, 'READONLY'.length) === 'READONLY') {
      logger.error('Connected to READONLY Redis instance! Reconnecting...')
      return true
    } else {
      logger.error('Unknown Redis error!', err.code, err.message)
    }
  }
}

const redises = {
  SESSION: { handle: undefined, servers: REDIS_SERVERS }
}

module.exports = function redis(target /*: redisTargets */, forceNew /*: boolean */ = false) {
  if (!redises[target]) throw new Error(`No such redis "${target}" defined!`)
  if (redises[target].handle && !forceNew) return redises[target].handle
  else {
    let handle
    if (redises[target].servers.length > 1) {
      handle = new Redis.Cluster(redises[target].servers, { redisOptions })
    } else if (redises[target].servers.length === 1) {
      handle = Redis.createClient(
        redises[target].servers[0].port,
        redises[target].servers[0].host,
        redisOptions
      )
    } else {
      // Dummy, for testing - errors on use
      handle = new Redis({
        lazyConnect: true,
        enableOfflineQueue: false,
        reconnectOnError: () => false
      })
    }

    handle.waitForReady = function(tries = 0) {
      return new Promise((resolve, reject) => {
        if (handle.status === 'ready') return resolve(handle)
        if (handle.status !== 'connecting') handle.connect()
        handle.on('connect', () => {
          resolve(handle)
        })
        handle.on('error', err => {
          if (err.message === 'connect ETIMEDOUT') {
            const tryLimit = 4
            if (++tries < tryLimit) {
              logger.error(`Redis ETIMEDOUT! Reconnecting ${tries}/${tryLimit}`)
              resolve(handle.waitForReady(tries))
            } else {
              reject(err)
            }
          }
        })
      })
    }
    if (forceNew) return handle
    else {
      redises[target].handle = handle
      return redises[target].handle
    }
  }
}
