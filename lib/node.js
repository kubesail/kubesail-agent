// @flow

const fs = require('fs')

// Becomes unnecessary with Node 11, but kills node when a promise is rejected and unhandled
process.on('unhandledRejection', err => {
  throw err
})

function setPTimeout(ms /*: number */) /*: Promise<any> */ {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function getRelease() {
  try {
    return fs.readFileSync('.release').toString()
  } catch (err) {
    return 'development'
  }
}

module.exports = {
  getRelease,
  setPTimeout
}
