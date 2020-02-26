// @flow

function addSocketMapping(
  socket /*: Net.Socket */,
  validDomains /*: Array<string> */,
  localSocketMapping /*: Array<any> */,
  localSocketReverseMapping /*: Array<any> */
) {
  for (let i = 0; i < validDomains.length; i++) {
    const domain = validDomains[i]
    localSocketMapping[domain] = socket
    if (localSocketReverseMapping[socket.id]) {
      localSocketReverseMapping[socket.id].push(domain)
    } else {
      localSocketReverseMapping[socket.id] = [domain]
    }
  }
}

module.exports = addSocketMapping
