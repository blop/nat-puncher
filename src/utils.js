'use strict'

const ipaddr = require('ipaddr.js')
const os = require('os')

/**
 * List of popular router default IPs
 * Used as destination addresses for NAT-PMP and PCP requests
 * http://www.techspot.com/guides/287-default-router-ip-addresses/
 */
var ROUTER_IPS = ['192.168.1.1', '192.168.2.1', '192.168.11.1',
  '192.168.0.1', '192.168.0.30', '192.168.0.50', '192.168.20.1',
  '192.168.30.1', '192.168.62.1', '192.168.100.1', '192.168.102.1',
  '192.168.1.254', '192.168.10.1', '192.168.123.254', '192.168.4.1',
  '10.0.1.1', '10.1.1.1', '10.0.0.13', '10.0.0.2', '10.0.0.138'
]

/**
 * Port numbers used to probe NAT-PMP, PCP, and UPnP, which don't overlap to
 * avoid port conflicts, which can have strange and inconsistent behaviors
 * For the same reason, don't reuse for normal mappings after a probe (or ever)
 */
var NAT_PMP_PROBE_PORT = 55555
var PCP_PROBE_PORT = 55556
var UPNP_PROBE_PORT = 55557

/**
 * An object representing a port mapping returned by mapping methods
 * @typedef {Object} Mapping
 * @property {string} internalIp
 * @property {number} internalPort
 * @property {string} externalIp Only provided by PCP, undefined for other protocols
 * @property {number} externalPort The actual external port of the mapping, -1 on failure
 * @property {number} lifetime The actual (response) lifetime of the mapping
 * @property {string} protocol The protocol used to make the mapping ('natPmp', 'pcp', 'upnp')
 * @property {number} timeoutId The timeout ID if the mapping is refreshed
 * @property {array} nonce Only for PCP; the nonce field for deletion
 * @property {function} deleter Deletes the mapping from activeMappings and router
 * @property {string} errInfo Error message if failure; currently used only for UPnP
 */
var Mapping = function () {
  this.internalIp = undefined
  this.internalPort = undefined
  this.externalIp = undefined
  this.externalPort = -1
  this.lifetime = undefined
  this.protocol = undefined
  this.timeoutId = undefined
  this.nonce = undefined
  this.deleter = undefined
  this.errInfo = undefined
}

/**
 * Return the private IP addresses of the computer
 * @public
 * @method getPrivateIps
 * @return {Promise<string>} A promise that fulfills with a list of IP address,
 *                           or rejects on timeout
 */
const getPrivateIps = function () {
  return new Promise(function (F, R) {
    const i = os.networkInterfaces()
    F(Object.keys(i).map(k => i[k]).reduce((a, b) => a.concat(b), []).filter(i => !i.internal).map(i => i.address).filter(a => ipaddr.IPv4.isValid(a)))
  })
}

/**
 * Filters routerIps for only those that match any of the user's IPs in privateIps
 * i.e. The longest prefix matches of the router IPs with each user IP* @public
 * @method filterRouterIps
 * @param  {Array<string>} privateIps Private IPs to match router IPs to
 * @return {Array<string>} Router IPs that matched (one per private IP)
 */
var filterRouterIps = function (privateIps) {
  let routerIps = []
  privateIps.forEach(function (privateIp) {
    routerIps.push(longestPrefixMatch(ROUTER_IPS, privateIp))
  })
  return routerIps
}

/**
 * Creates an ArrayBuffer with a compact matrix notation, i.e.
 * [[bits, byteOffset, value],
 *  [8, 0, 1], //=> DataView.setInt8(0, 1)
 *  ... ]
 * @public
 * @method createArrayBuffer
 * @param  {number} bytes Size of the ArrayBuffer in bytes
 * @param  {Array<Array<number>>} matrix Matrix of values for the ArrayBuffer
 * @return {ArrayBuffer} An ArrayBuffer constructed from matrix
 */
var createArrayBuffer = function (bytes, matrix) {
  var buffer = new ArrayBuffer(bytes)
  var view = new DataView(buffer)
  for (var i = 0; i < matrix.length; i++) {
    var row = matrix[i]
    if (row[0] === 8) {
      view.setInt8(row[1], row[2])
    } else if (row[0] === 16) {
      view.setInt16(row[1], row[2], false)
    } else if (row[0] === 32) {
      view.setInt32(row[1], row[2], false)
    } else {
      console.error('Invalid parameters to createArrayBuffer')
    }
  }
  return Buffer.from(buffer)
}

/**
 * Return a promise that rejects in a given time with an Error message,
 * and can call a callback function before rejecting
 * @public
 * @method countdownReject
 * @param {number} time Time in seconds
 * @param {number} msg Message to encapsulate in the rejected Error
 * @param {function} callback Function to call before rejecting
 * @return {Promise} A promise that will reject in the given time
 */
var countdownReject = function (time, msg, callback) {
  return new Promise(function (F, R) {
    setTimeout(function () {
      if (callback !== undefined) {
        callback()
      }
      R(new Error(msg))
    }, time)
  })
}

/**
 * Close the OS-level sockets and discard its Freedom object
 * @public
 * @method closeSocket
 * @param {freedom_UdpSocket.Socket} socket The socket object to close
 */
var closeSocket = function (socket) {
  socket.close()
}

/**
 * Takes a list of IP addresses and an IP address, and returns the longest prefix
 * match in the IP list with the IP
 * @public
 * @method longestPrefixMatch
 * @param {Array} ipList List of IP addresses to find the longest prefix match in
 * @param {string} matchIp The router's IP address as a string
 * @return {string} The IP from the given list with the longest prefix match
 */
var longestPrefixMatch = function (ipList, matchIp) {
  var prefixMatches = []
  matchIp = ipaddr.IPv4.parse(matchIp)
  for (var i = 0; i < ipList.length; i++) {
    var ip = ipaddr.IPv4.parse(ipList[i])
    // Use ipaddr.js to find the longest prefix length (mask length)
    for (var mask = 1; mask < 32; mask++) {
      if (!ip.match(matchIp, mask)) {
        prefixMatches.push(mask - 1)
        break
      }
    }
  }
  // Find the argmax for prefixMatches, i.e. the index of the correct private IP
  var maxIndex = prefixMatches.indexOf(Math.max.apply(null, prefixMatches))
  var correctIp = ipList[maxIndex]
  return correctIp
}

/**
 * Return a random integer in a specified range
 * @public
 * @method randInt
 * @param {number} min Lower bound for the random integer
 * @param {number} max Upper bound for the random integer
 * @return {number} A random number between min and max
 */
var randInt = function (min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

/**
 * Convert an ArrayBuffer to a UTF-8 string
 * @public
 * @method arrayBufferToString
 * @param {ArrayBuffer} buffer ArrayBuffer to convert
 * @return {string} A string converted from the ArrayBuffer
 */
var arrayBufferToString = function (buffer) {
  var bytes = new Uint8Array(buffer)
  var a = []
  for (var i = 0; i < bytes.length; ++i) {
    a.push(String.fromCharCode(bytes[i]))
  }
  return a.join('')
}

/**
 * Convert a UTF-8 string to an ArrayBuffer
 * @public
 * @method stringToArrayBuffer
 * @param {string} s String to convert
 * @return {ArrayBuffer} An ArrayBuffer containing the string data
 */
var stringToArrayBuffer = function (s) {
  var buffer = new ArrayBuffer(s.length)
  var bytes = new Uint8Array(buffer)
  for (var i = 0; i < s.length; ++i) {
    bytes[i] = s.charCodeAt(i)
  }
  return Buffer.from(buffer)
}

/**
 * Returns the difference between two arrays
 * @param  {Array} listA
 * @param  {Array} listB
 * @return {Array} The difference array
 */
var arrDiff = function (listA, listB) {
  var diff = []
  listA.forEach(function (a) {
    if (listB.indexOf(a) === -1) {
      diff.push(a)
    }
  })
  return diff
}

/**
 * Adds two arrays, but doesn't include repeated elements
 * @param  {Array} listA
 * @param  {Array} listB
 * @return {Array} The sum of the two arrays with no duplicates
 */
var arrAdd = function (listA, listB) {
  var sum = []
  listA.forEach(function (a) {
    if (sum.indexOf(a) === -1) {
      sum.push(a)
    }
  })
  listB.forEach(function (b) {
    if (sum.indexOf(b) === -1) {
      sum.push(b)
    }
  })
  return sum
}
module.exports = {
  ROUTER_IPS: ROUTER_IPS,
  NAT_PMP_PROBE_PORT: NAT_PMP_PROBE_PORT,
  PCP_PROBE_PORT: PCP_PROBE_PORT,
  UPNP_PROBE_PORT: UPNP_PROBE_PORT,
  Mapping: Mapping,
  getPrivateIps: getPrivateIps,
  createArrayBuffer: createArrayBuffer,
  countdownReject: countdownReject,
  closeSocket: closeSocket,
  filterRouterIps: filterRouterIps,
  longestPrefixMatch: longestPrefixMatch,
  randInt: randInt,
  arrayBufferToString: arrayBufferToString,
  stringToArrayBuffer: stringToArrayBuffer,
  arrAdd: arrAdd,
  arrDiff: arrDiff
}
