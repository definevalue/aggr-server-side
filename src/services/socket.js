const { statSync, unlinkSync } = require('fs')
const net = require('net')
const { EventEmitter } = require('stream')
const config = require('../config')
const { indexes } = require('./connections')

require('../typedef')

class SocketService extends EventEmitter {
  constructor() {
    super()

    /**
     * @type {net.Socket}
     */
    this.clusterSocket = null

    /**
     * @type {net.Server}
     */
    this.serverSocket = null

    this.clusterSocket = null
    this.clusteredCollectors = []

    if (config.influxCollectors) {
      if (config.api && !config.collect) {
        // CLUSTER NODE (node is dedicated to serving data)
        this.createCluster()

        return
      } else if (!config.api && config.collect) {
        // COLLECTOR NODE (node is just collecting + storing data)

        this.connectToCluster()
      }
    }
  }

  /**
   * Called from a collector node
   * Connect current collector node to cluster node
   * WILL try to reconnect if it fails
   * @returns {void}
   */
  connectToCluster() {
    if (this.clusterSocket) {
      console.warn('[socket/collector] already connected (aborting)')
      return
    }

    console.debug('[socket/collector] connecting to cluster..')

    this.clusterSocket = net.createConnection(config.influxCollectorsClusterSocketPath)

    this.clusterSocket.on('connect', () => {
      console.log('[socket/collector] successfully connected to cluster')
      this.clusterSocket.write(
        JSON.stringify({
          op: 'welcome',
          data: {
            markets: config.pairs,
            indexes: indexes.map(a => a.id),
          },
        }) + '#'
      )
    })

    // store current incoming to be filled by potentialy partial chunks
    this.pendingSocketData = ''

    this.clusterSocket
      .on(
        'data',
        this.parseSocketData.bind(this, (data) => {
          this.emit(data.op, data.data)
        })
      )
      .on('close', hadError => {
        // collector never close connection with cluster by itself
        console[hadError ? 'error' : 'log'](`[socket/collector] cluster closed`)

        // schedule reconnection
        this.reconnectCluster()
      })
      .on('error', (error) => {
        // the close even destroy the previous strem and may trigger error
        // reconnect in this situation as well
        this.reconnectCluster()
      })
  }

  /**
   * Handle connectToCluster failure and unexpected close
   * @returns {void}
   */
  reconnectCluster() {
    if (this.clusterSocket) {
      // ensure previous stream is donezo
      this.clusterSocket.destroy()
      this.clusterSocket = null
    }

    if (this._clusterConnectionTimeout) {
      clearTimeout(this._clusterConnectionTimeout)
    } else {
      console.log(`[socket/collector] schedule reconnect to cluster (${config.influxCollectorsReconnectionDelay / 1000}s)`)
    }

    this._clusterConnectionTimeout = setTimeout(() => {
      this._clusterConnectionTimeout = null

      this.connectToCluster()
    }, config.influxCollectorsReconnectionDelay)
  }

  /**
   * Create cluster unix socket
   * And listen for collectors joining
   *
   * Only called once
   */
  createCluster() {
    try {
      if (statSync(config.influxCollectorsClusterSocketPath)) {
        console.debug(`[socket/cluster] unix socket was not closed properly last time`)
        unlinkSync(config.influxCollectorsClusterSocketPath)
      }
    } catch (error) {}

    this.serverSocket = net.createServer((socket) => {
      console.log('[socket/cluster] collector connected successfully')

      socket.on('end', () => {
        console.log('[socket/cluster] collector disconnected (unexpectedly)')

        const index = this.clusteredCollectors.indexOf(socket)

        if (index !== -1) {
          this.clusteredCollectors.splice(index, 1)
        }

        socket.destroy()
      })

      // store current incoming to be filled by potentialy partial chunks
      this.pendingSocketData = ''

      socket.on(
        'data',
        this.parseSocketData.bind(this, (data) => {
          if (data.op === 'welcome') {
            // this is our welcome message
            const { markets, indexes } = data.data
            socket.markets = markets
            socket.indexes = indexes

            console.log('[socket/cluster] registered collector with indexes', socket.indexes.join(', '))

            this.clusteredCollectors.push(socket)
            return
          }

          this.emit(data.op, data.data)
        })
      )
    })

    this.serverSocket.on('error', (error) => {
      console.error(`[socket/cluster] server socket error`, error)
    })

    this.serverSocket.listen(config.influxCollectorsClusterSocketPath)
  }

  parseSocketData(callback, data) {
    // data is a stringified json inside a buffer
    // BUT it can also be a part of a json, or contain multiple

    // convert to string
    const stringData = data.toString()

    // complete data has a # char at it's end
    const incompleteData = stringData[stringData.length - 1] !== '#'

    if (stringData.indexOf('#') !== -1) {
      // data has delimiter

      // split chunks using given delimiter
      const chunks = stringData.split('#')

      for (let i = 0; i < chunks.length; i++) {
        if (!chunks[i].length) {
          // chunk is empty (last one can be as # used as divider:
          // partial_chunk#complete_chunk#*empty_chunk <-)
          // complete_chunk#complete_chunk#*empty_chunk <-)
          // partial_chunk#*empty_chunk <-)
          // complete_chunk#*empty_chunk <-)
          continue
        }

        // add to already existing incoming data (if i not last: this is a end of chunk)
        this.pendingSocketData += chunks[i]

        if (i === chunks.length - 1 && incompleteData) {
          // last chunk and incomplete
          // wait for next data event
          continue
        }

        // this is a complete chunk either because i < last OR last and # at this end of the total stringData
        let json

        try {
          json = JSON.parse(this.pendingSocketData)
        } catch (error) {
          console.error('[storage/influx] failed to parse socket data', error.message, this.pendingSocketData)
        }

        if (json) {
          try {
            callback(json)
          } catch (error) {
            console.error('[storage/influx] failed to execute callback data', error, json)
          }
        }

        // flush incoming data for next chunk
        this.pendingSocketData = ''
      }
    } else {
      // no delimiter in payload so this *has* to be incomplete data
      this.pendingSocketData += stringData
    }
  }

  getNodeByMarket(market) {
    const isIndex = market.indexOf(':') === -1

    for (let j = 0; j < this.clusteredCollectors.length; j++) {
      if (
        (isIndex && this.clusteredCollectors[j].indexes.indexOf(market) !== -1) ||
        (!isIndex && this.clusteredCollectors[j].markets.indexOf(market) !== -1)
      ) {
        return this.clusteredCollectors[j]
      }
    }
  }

  async close() {
    if (this.clusterSocket) {
      console.log('[socket/collector] closing cluster connection')
      await new Promise((resolve) => {
        this.clusterSocket.end(() => {
          console.log('[socket/collector] successfully closed cluster connection')
          resolve()
        })
      })
    }
  }
}

module.exports = new SocketService()
