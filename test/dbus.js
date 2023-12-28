const dbus = require('dbus-next')
const toASCII = require('punycode/').toASCII

async function test() {
  const systemBus = dbus.systemBus()

  systemBus.on('error', err => {
    if (err.code === 'ENOENT') {
      console.error(
        'Unable to publish ".local" DNS addresses to your network. Please install `avahi-daemon` and restart the agent.',
        { errMsg: err.message, type: err.type, error: err.text }
      )
    } else {
      if (err.type && err.type === 'org.freedesktop.DBus.Error.AccessDenied') {
        console.error(
          'An SELinux policy is preventing us from access DBUS. mDNS (.local dns names) will not work.',
          { type: err.type, error: err.text }
        )
      } else {
        console.error('Unknown DBUS error! Please report to KubeSail:', err)
      }
    }
  })

  console.log('getProxyObject')
  const avahiInterface = await systemBus.getProxyObject('org.freedesktop.Avahi', '/')
  console.log('getInterface')
  const server = avahiInterface.getInterface('org.freedesktop.Avahi.Server')
  console.log('EntryGroupNew')
  const entryGroupPath = await server.EntryGroupNew()
  console.log('getProxyObject')
  const entryGroup = await systemBus.getProxyObject('org.freedesktop.Avahi', entryGroupPath)
  console.log('getInterface')
  const entryGroupInt = entryGroup.getInterface('org.freedesktop.Avahi.EntryGroup')

  console.log('entryGroupInt.AddRecord: yo-its-mdns-brah.local -> 192.168.100.1')
  await entryGroupInt.AddRecord(
    -1, // IF_UNSPEC (all interfaces)
    -1, // PROTO_UNSPEC (all protocols)
    0,
    toASCII('yo-its-mdns-brah.local'), // mDNS name
    0x01, // CLASS_IN
    0x01, // TYPE_A (A record. TYPE_CNAME is 0x05) https://github.com/lathiat/avahi/blob/d1e71b320d96d0f213ecb0885c8313039a09f693/avahi-sharp/RecordBrowser.cs#L39
    60, // TTL
    Uint8Array.from('192.168.100.1'.split('.'))
  )

  console.log('entryGroupInt.Commit')
  await entryGroupInt.Commit()
  console.log('Complete!')
}

test()
