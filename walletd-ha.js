// Copyright (c) 2018, Brandon Lehmann, The TurtleCoin Developers
// 
// Please see the included LICENSE file for more information.

'use strict'

const WalletdRPC = require('turtlecoin-rpc').Walletd
const WebSocket = require('./lib/websocket.js')
const pty = require('node-pty')
const util = require('util')
const inherits = require('util').inherits
const EventEmitter = require('events').EventEmitter
const fs = require('fs')
const path = require('path')
const os = require('os')
const Storage = require('node-storage')
const nonce = require('nonce')()

const Walletd = function (opts) {
  opts = opts || {}
  if (!(this instanceof Walletd)) return new Walletd(opts)

  this.appName = opts.appName || 'default'
  this.pollingInterval = opts.pollingInterval || 10
  this.saveInterval = opts.saveInterval || 10
  this.scanInterval = opts.scanInterval || 5
  this.maxPollingFailures = opts.maxPollingFailures || 3
  this.timeout = opts.timeout || 2000
  this.enableWebSocket = opts.enableWebSocket || true

  // Begin walletd options
  this.path = opts.path || path.resolve(__dirname, './walletd')
  this.config = opts.config || false
  this.localNode = opts.localNode || false
  this.testnet = opts.testnet || false
  this.dataDir = opts.dataDir || path.resolve(os.homedir(), './.TurtleCoin')
  this.bindAddress = opts.bindAddress || '127.0.0.1'
  this.bindPort = opts.bindPort || 8070
  this.rpcPassword = opts.rpcPassword || false
  this.rpcLegacySecurity = opts.rpcLegacySecurity || false
  this.containerFile = opts.containerFile || false
  this.containerPassword = opts.containerPassword || false
  // The following options have been disabled as if you want to generate a new container you
  // should do it outside the scope of this wrapper.
  // this.generateContainer = opts.generateContainer || false
  // this.viewKey = opts.viewKey || false
  // this.spendKey = opts.spendKey || false
  // this.mnemonicSeed = opts.mnemonicSeed || false
  this.logFile = opts.logFile || false
  this.logLevel = opts.logLevel || 4
  this.syncFromZero = opts.syncFromZero || false
  this.daemonAddress = opts.daemonAddress || '127.0.0.1'
  this.daemonPort = opts.daemonPort || 11898
  this.p2pBindIp = opts.p2pBindIp || false
  this.p2pBindPort = opts.p2pBindPort || false
  this.p2pExternalPort = opts.p2pExternalPort || false
  this.allowLocalIp = opts.allowLocalIp || false
  this.peers = opts.peers || false
  this.priorityNodes = opts.priorityNodes || false
  this.exclusiveNodes = opts.exclusiveNodes || false
  this.seedNode = opts.seedNode || false
  this.hideMyPort = opts.hideMyPort || false

  // Begin RPC API options
  this.defaultMixin = (opts.defaultMixin !== undefined) ? opts.defaultMixin : 7
  this.defaultFee = (opts.defaultFee !== undefined) ? opts.defaultFee : 0.1
  this.defaultBlockCount = opts.defaultBlockCount || 1
  this.decimalDivisor = opts.decimalDivisor || 100
  this.defaultFirstBlockIndex = opts.defaultFirstBlockIndex || 1
  this.defaultUnlockTime = opts.defaultUnlockTime || 0
  this.defaultFusionThreshold = opts.defaultFusionThreshold || 10000000

  // make sure our paths make sense
  if (this.logFile) {
    this.logFile = fixPath(this.logFile)
  }
  this.path = fixPath(this.path)
  this.config = fixPath(this.config)
  this.containerFile = fixPath(this.containerFile)
  this.dataDir = fixPath(this.dataDir)

  this.db = new Storage(util.format('data/%s.json', this.appName))
  this.knownBlockCount = 0
  this.isRunning = false

  this._setupAPI()
  this._setupWebSocket()

  this.on('synced', () => {
    if (this.scanIntervalPtr) return
    this.scanIntervalPtr = setInterval(() => {
      if (!this.synced) return

      var height = this.db.get('scanHeight')
      if (!height) height = 1

      if (height >= this.knownBlockCount) return // we don't scan if we're at the top of the chain
      var cnt = this.knownBlockCount - height
      if (cnt > 100) {
        cnt = 1000
      } else if (cnt > 100) {
        cnt = 100
      } else if (cnt > 10) {
        cnt = 10
      } else {
        cnt = 1
      }
      if ((height + cnt) > this.knownBlockCount) {
        cnt = (this.knownBlockCount - height - 1)
      }
      this.emit('scan', height, (height + cnt))
      this.api.getTransactions({
        firstBlockIndex: height,
        blockCount: cnt
      }).then((transactions) => {
        for (var i = 0; i < transactions.length; i++) {
          this.emit('transaction', transactions[i])
        }
        this.db.put('scanHeight', (height + cnt))
      }).catch((err) => {
        this.emit('error', util.format('Error scanning transactions from %s to %s: %s', height, (height + cnt), err))
      })
    }, (this.scanInterval * 1000))
  })

  this.on('down', () => {
    this.isRunning = false
  })
}
inherits(Walletd, EventEmitter)

Walletd.prototype.start = function () {
  this.emit('info', 'Attempting to start walletd...')
  this.synced = false
  var args = this._buildargs()
  if (!args) {
    this.emit('error', 'Could not build the walletd arguments... please check your config and try again')
    return false
  }

  this.child = pty.spawn(this.path, args, {
    name: 'xterm-color',
    cols: 80,
    rows: 30,
    cwd: process.env.HOME,
    env: process.env
  })

  this.child.on('error', (err) => {
    this.emit('error', util.format('Error in child process: %s', err))
    this.emit('down')
  })

  this.child.on('data', (data) => {
    data = data.trim()
    data = data.split('\r\n')
    for (var i = 0; i < data.length; i++) {
      this._stdio(data[i])
      this.emit('data', data[i])
    }
  })

  this.child.on('close', (exitcode) => {
    // as crazy as this sounds, we need to pause a moment before bubbling up the closed event
    setTimeout(() => {
      this.emit('close', exitcode)
    }, 2000)
  })

  this.emit('start', util.format('%s%s', this.path, args.join(' ')))
}

Walletd.prototype.stop = function () {
  if (this.saveIntervalPtr) {
    clearInterval(this.saveIntervalPtr)
    this.saveIntervalPtr = null
  }

  if (this.pollingIntervalPtr) {
    clearInterval(this.pollingIntervalPtr)
    this.pollingIntervalPtr = null
  }

  if (this.scanIntervalPtr) {
    clearInterval(this.scanIntervalPtr)
    this.scanIntervalPtr = null
  }

  this.synced = false

  if (this.child) this.write('exit')
  setTimeout(() => {
    if (this.child) this.child.kill()
  }, (this.timeout * 2))
}

Walletd.prototype.write = function (data) {
  this._write(util.format('%s\r', data))
}

Walletd.prototype._stdio = function (data) {
  if (data.indexOf('Loading container') !== -1) {
    this.emit('info', 'Walletd is loading the wallet container...')
  } else if (data.indexOf('Container loaded') !== -1) {
    this.emit('info', 'Walletd has loaded the wallet container...')
  } else if (data.indexOf('Wallet loading is finished') !== -1) {
    this.emit('info', 'Wallet loading has finished')
    this.api.getAddresses().then((addresses) => {
      this.emit('info', util.format('Started walletd with base public address: %s', addresses[0]))
    }).catch((err) => {
      this.emit('warning', util.format('Error retrieving addresses from wallet: %s', err))
    })
    this._startChecks()
  }
}

Walletd.prototype._startChecks = function () {
  this.pollingIntervalPtr = setInterval(() => {
    this.api.getStatus().then((result) => {
      this.emit('status', result)
      this.knownBlockCount = result.blockCount
      if ((result.knownBlockCount - result.blockCount) > 1) {
        this.synced = false
      } else if ((result.blockCount + 1) === result.knownBlockCount || result.blockCount === result.knownBlockCount) {
        if (!this.synced) {
          this.synced = true
          this.emit('synced')
        }
      }
      this._triggerUp()
    }).catch((err) => {
      this.emit('error', util.format('Error retrieving wallet status: %s', err))
      this._triggerDown()
    })
  }, (this.pollingInterval * 1000))

  this.saveIntervalPtr = setInterval(() => {
    if (this.synced) {
      this.api.save().then(() => {
        this.emit('save')
      }).catch((err) => {
        this.emit('error', util.format('Error when saving wallet container: %s', err))
      })
    }
  }, (this.saveInterval * 1000))
}

Walletd.prototype._triggerDown = function () {
  if (!this.trigger) {
    this.trigger = setTimeout(() => {
      this.emit('down')
    }, (this.pollingInterval * this.maxPollingFailures))
  }
}

Walletd.prototype._triggerUp = function () {
  if (!this.isRunning) {
    this.isRunning = true
    this.emit('alive')
  }
  if (this.trigger) {
    clearTimeout(this.trigger)
    this.trigger = null
  }
}

Walletd.prototype._write = function (data) {
  this.child.write(data)
}

Walletd.prototype._buildargs = function () {
  var args = ''

  // Walletd specific options
  if (this.config) args = util.format('%s --config %s', args, this.config)
  if (this.localNode) args = util.format('%s --local', args)
  if (this.testnet) args = util.format('%s --testnet', args)
  if (this.dataDir) args = util.format('%s --data-dir %s', args, this.dataDir)
  args = util.format('%s --bind-address %s', args, this.bindAddress)
  args = util.format('%s --bind-port %s', args, this.bindPort)
  if (this.rpcPassword) {
    args = util.format('%s --rpc-password %s', args, this.rpcPassword)
  } else if (this.rpcLegacySecurity) {
    args = util.format('%s --rpc-legacy-security', args)
  } else {
    this.emit('error', 'Cannot start without either an RPC password or RPC Legacy Security Enabled')
    return false
  }
  if (!this.containerFile) {
    this.emit('error', 'Cannot start without defining a container file')
    return false
  }
  if (!fs.existsSync(this.containerFile)) {
    this.emit('error', 'Wallet container file does not exist. Please check your path and try again')
    return false
  }
  args = util.format('%s --container-file %s', args, this.containerFile)
  if (!this.containerPassword) {
    this.emit('warning', 'No wallet container password defined. This may work... but you really should use a password')
  } else {
    args = util.format('%s --container-password %s', args, this.containerPassword)
  }

  if (this.logFile) {
    args = util.format('%s --log-file %s', args, this.logFile)
  }
  args = util.format('%s --log-level %s', args, this.logLevel)
  if (this.syncFromZero) {
    args = util.format('%s --SYNC_FROM_ZERO', args)
  }

  // Remote node options
  if (this.daemonAddress) {
    args = util.format('%s --daemon-address %s', args, this.daemonAddress)
  }
  if (this.daemonPort) {
    args = util.format('%s --daemon-port %s', args, this.daemonPort)
  }

  // Local node options
  if (this.p2pBindIp) args = util.format('%s --p2p-bind-ip %s', args, this.p2pBindIp)
  if (this.p2pBindPort) args = util.format('%s --p2p-bind-port %s', args, this.p2pBindPort)
  if (this.p2pExternalPort) args = util.format('%s --p2p-external-port %s', args, this.p2pExternalPort)
  if (this.allowLocalIp) args = util.format('%s --allow-local-ip', args)
  if (Array.isArray(this.peers)) {
    this.peers.forEach((peer) => {
      args = util.format('%s --add-peer %s', args, peer)
    })
  } else if (this.peers) {
    args = util.format('%s --add-peer %s', args, this.peers)
  }
  if (Array.isArray(this.priorityNodes)) {
    this.priorityNodes.forEach((peer) => {
      args = util.format('%s --add-priority-node %s', args, peer)
    })
  } else if (this.priorityNodes) {
    args = util.format('%s --add-priority-node %s', args, this.priorityNodes)
  }
  if (Array.isArray(this.exclusiveNodes)) {
    this.exclusiveNodes.forEach((peer) => {
      args = util.format('%s --add-exclusive-node %s', args, peer)
    })
  } else if (this.exclusiveNodes) {
    args = util.format('%s --add-exclusive-node %s', args, this.exclusiveNodes)
  }
  if (this.seedNode) args = util.format('%s --seed-node %s', args, this.seednode)
  if (this.hideMyPort) args = util.format('%s --hide-my-port', args)
  return args.split(' ')
}

Walletd.prototype._setupAPI = function () {
  this.api = new WalletdRPC({
    host: this.bindAddress,
    port: this.bindPort,
    timeout: this.timeout,
    rpcPassword: this.rpcPassword,
    defaultMixin: this.defaultMixin,
    defaultFee: this.defaultFee,
    defaultBlockCount: this.defaultBlockCount,
    decimalDivisor: this.decimalDivisor,
    defaultFirstBlockIndex: this.defaultFirstBlockIndex,
    defaultUnlockTime: this.defaultUnlockTime,
    defaultFusionThreshold: this.defaultFusionThreshold
  })
}

Walletd.prototype._setupWebSocket = function () {
  if (this.enableWebSocket) {
    this.webSocket = new WebSocket({
      password: this.rpcPassword,
      port: (this.bindPort + 1)
    })

    this.webSocket.on('connection', (socket) => {
      this.emit('info', util.format('[WEBSOCKET] Client connected with socketId: %s', socket.id))
    })

    this.webSocket.on('disconnect', (socket) => {
      this.emit('info', util.format('[WEBSOCKET] Client disconnected with socketId: %s', socket.id))
    })

    this.webSocket.on('error', (err) => {
      this.emit('error', util.format('[WEBSOCKET] %s', err))
    })

    this.webSocket.on('auth.success', (socket) => {
      this._registerWebSocketClientEvents(socket)
      if (this.isRunning) {
        this.webSocket.send({socket: socket, event: 'alive'})
      }
      this.emit('info', util.format('[WEBSOCKET] Client authenticated with socketId: %s', socket.id))
    })

    this.webSocket.on('auth.failure', (socket) => {
      this.emit('warning', util.format('[WEBSOCKET] Client failed authentication with socketId: %s', socket.id))
    })

    this.webSocket.on('ready', () => {
      this.emit('info', util.format('Accepting WebSocket connections on %s:%s with password: %s', this.bindAddress, (this.bindPort + 1), this.webSocket.password))
    })

    this.webSocket.on('error', (err) => {
      this.error(util.format('WebSocket Error: %s', err))
    })

    this.on('close', (exitcode) => {
      this.webSocket.broadcast({event: 'close', data: exitcode})
    })

    this.on('data', (data) => {
      this.webSocket.broadcast({event: 'data', data})
    })

    this.on('down', () => {
      this.webSocket.broadcast({event: 'down'})
    })

    this.on('error', (err) => {
      this.webSocket.broadcast({event: 'error', data: err})
    })

    this.on('info', (info) => {
      this.webSocket.broadcast({event: 'info', data: info})
    })

    this.on('save', () => {
      this.webSocket.broadcast({event: 'save'})
    })

    this.on('scan', (fromBlock, toBlock) => {
      this.webSocket.broadcast({event: 'scan', data: {fromBlock, toBlock}})
    })

    this.on('status', (status) => {
      this.webSocket.broadcast({event: 'status', data: status})
    })

    this.on('synced', () => {
      this.webSocket.broadcast({event: 'synced'})
    })

    this.on('transaction', (transaction) => {
      this.webSocket.broadcast({event: 'transaction', data: transaction})
    })

    this.on('warning', (warning) => {
      this.webSocket.broadcast({event: 'info', data: warning})
    })

    this.on('alive', () => {
      this.webSocket.broadcast({event: 'alive'})
    })
  }
}

Walletd.prototype._registerWebSocketClientEvents = function (socket) {
  var that = this
  var events = Object.getPrototypeOf(this.api)
  events = Object.getOwnPropertyNames(events).filter((f) => {
    return (f !== 'constructor' && !f.startsWith('_'))
  })
  socket.setMaxListeners(socket.getMaxListeners() + events.length)

  for (var i = 0; i < events.length; i++) {
    (function () {
      var evt = events[i]
      socket.on(evt, (data) => {
        try {
          data = JSON.parse(data)
        } catch (e) {
          data = {}
        }
        data.nonce = data.nonce || nonce()
        that.api[evt](data).then((result) => {
          socket.emit(evt, {nonce: data.nonce, data: result})
        }).catch((err) => {
          socket.emit(evt, {nonce: data.nonce, error: err.toString()})
        })
      })
    })()
  }
}

function fixPath (oldPath) {
  if (!oldPath) return false
  oldPath = oldPath.replace('~', os.homedir())
  oldPath = path.resolve(oldPath)
  return oldPath
}

module.exports = Walletd
