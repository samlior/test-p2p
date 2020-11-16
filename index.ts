const Libp2p = require('libp2p')
const WebSockets = require('libp2p-websockets')
const { NOISE } = require('libp2p-noise')
const MPLEX = require('libp2p-mplex');
const Multiaddr = require('multiaddr')
const PeerId = require('peer-id')
const pipe = require('it-pipe')
const lp = require('it-length-prefixed')
// const Bootstrap = require('libp2p-bootstrap')
const KadDHT = require('libp2p-kad-dht')

import process from 'process';

import prompts from 'prompts';

type PeerQueue = {
    abort: () => void,
    addToQueue: (msg: string) => void,
    makeAsyncGenerator: () => AsyncGenerator<any, void, unknown>,
}

type PeerJSONRPC = {
    notify: (method: string, params: any) => void,
    request: (method: string, params: any, timeout?: number) => Promise<any>,
    receiveMsg: (data: any, handleMsg: (method: string, params: any) => void) => void,
    abort: () => void
}

const peerInfoMap = new Map<string, [PeerQueue, PeerJSONRPC]>()

const connectQueueSet = new Set<string>()

const startPrompts = async (node) => {
    while (true) {
        const response = await prompts({
            type: 'text',
            name: 'cmd',
            message: '> '
        });
        
        if (response.cmd === undefined) {
            process.exit(0)
        }

        let arr = (response.cmd as string).split(' ')
        if (!Array.isArray(arr)) {
            console.warn('$ Invalid command')
            continue
        }

        if (arr[0] === 'addpeer' || arr[0] === 'a') {
            node.peerStore.addressBook.set(PeerId.createFromB58String(arr[1]), [new Multiaddr(arr[2])])
        }
        else if (arr[0] === 'findpeer' || arr[0] === 'f') {
            try {
                connectQueueSet.add(arr[1])
                const peer = await node.peerRouting.findPeer(PeerId.createFromB58String(arr[1]))

                console.log('Found it, multiaddrs are:')
                peer.multiaddrs.forEach((ma) => console.log(`${ma.toString()}/p2p/${peer.id.toB58String()}`))
            }
            catch (err) {
                connectQueueSet.delete(arr[1])
                console.error('\n$ Error, findPeer', err)
            }
        }
        else if (arr[0] === 'connectpeer' || arr[0] === 'c') {
            let pos = arr[1].lastIndexOf('/')
            if (pos === -1) {
                console.warn('$ Invalid command')
                continue
            }
            let id = arr[1].substr(pos + 1)
            if (id === undefined) {
                console.warn('$ Invalid command')
                continue
            }

            try {
                connectQueueSet.add(id)
                await node.dial(arr[1])
            }
            catch (err) {
                connectQueueSet.delete(id)
                console.error('\n$ Error, dial', err)
            }
        }
        else if (arr[0] === 'disconnectpeer' || arr[0] === 'd') {
            try {
                await node.hangUp(PeerId.createFromB58String(arr[1]))
            }
            catch (err) {
                let info = peerInfoMap.get(arr[1])
                if (info) {
                    info[0].abort()
                    info[1].abort()
                    peerInfoMap.delete(arr[1])
                }
                console.error('\n$ Error, hangUp', err)
            }
        }
        else if (arr[0] === 'ls') {
            for (let [peerIdString] of node.peerStore.peers.entries()) {
                console.log(peerIdString)
            }
        }
        else if (arr[0] === 'sendmsg' || arr[0] === 's') {
            let info = peerInfoMap.get(arr[1])
            if (info) {
                info[1].notify('echo', arr[1])
            }
            else {
                console.warn('$ Can not find peer')
            }
        }
        else {
            console.warn('$ Invalid command')
            continue
        }
    }
}

/////////////////////////////////////////

(async () => {
    const peerkey = await PeerId.create({ bits: 1024, keyType: 'Ed25519' })

    const node = await Libp2p.create({
        peerId: peerkey,
        addresses: {
            listen: [`/ip4/127.0.0.1/tcp/0/ws`]
        },
        modules: {
            transport: [WebSockets],
            connEncryption: [NOISE],
            streamMuxer: [MPLEX],
            // peerDiscovery: [Bootstrap],
            dht: KadDHT
        },
        config:{
            // peerDiscovery: {
            //     bootstrap: {
            //         interval: 60e3,
            //         enabled: true,
            //         list: [
            //             addr
            //         ]
            //     }
            // },
            dht: {
                enabled: true
            }
        }
    })

    node.on('peer:discovery', (peer) => {
        console.log('\n$ Discovered', peer._idB58String) // Log discovered peer
    })

    node.on('error', (err) => {
        console.error('\n$ Error', err.message)
    })
    
    node.connectionManager.on('peer:connect', async (connection) => {
        let id = connection.remotePeer._idB58String
        console.log('\n$ Connected to', id)

        if (connectQueueSet.has(id)) {
            connectQueueSet.delete(id)
            if (!peerInfoMap.has(id)) {
                connection.newStream('/wuhu').then(({ stream }) => {
                    let queue = makeMsgQueue()
                    let jsonrpc = makeJSONRPC(queue.addToQueue)
                    peerInfoMap.set(id, [queue, jsonrpc])
                    pipe(queue.makeAsyncGenerator(), lp.encode(), stream.sink);
                }).catch((err) => {
                    console.error('\n$ Error, newStream', err.message)
                })
            }
        }
    })
    
    node.connectionManager.on('peer:disconnect', (connection) => {
        let id = connection.remotePeer._idB58String
        console.log('\n$ Disconnected to', id)

        let info = peerInfoMap.get(id)
        if (info) {
            info[0].abort()
            info[1].abort()
            peerInfoMap.delete(id)
        }
    })

    // Handle messages for the protocol
    await node.handle('/wuhu', async ({ connection, stream, protocol }) => {
        let id = connection.remotePeer._idB58String
        console.log('\n$ Receive', protocol, 'from', id)
        if (!peerInfoMap.has(id)) {
            connection.newStream('/wuhu').then(({ stream }) => {
                let queue = makeMsgQueue()
                let jsonrpc = makeJSONRPC(queue.addToQueue)
                peerInfoMap.set(id, [queue, jsonrpc])
                pipe(queue.makeAsyncGenerator(), lp.encode(), stream.sink);
                pipe(stream.source, lp.decode(), async (dataStream) => {
                    for await (let data of dataStream) {
                        jsonrpc.receiveMsg(data, (method: string, params: any) => {
                            // ...
                        })
                    }
                })
            }).catch((err) => {
                console.error('\n$ Error, newStream', err.message)
            })
        }
        else {
            let receiveMsg = peerInfoMap.get(id)[1].receiveMsg
            pipe(stream.source, lp.decode(), async (dataStream) => {
                for await (let data of dataStream) {
                    receiveMsg(data, (method: string, params: any) => {
                        // ...
                    })
                }
            })
        }
    })
    
    // start libp2p
    await node.start()
    console.log('Libp2p has started', peerkey.toB58String())
    node.multiaddrs.forEach((ma) => {
        console.log(ma.toString() + '/p2p/' + peerkey.toB58String())
    })
    startPrompts(node)
})();

/////////////////////////////////////////

const makeMsgQueue = () => {
    const queue = []
    let queueResolve;
    let abortFlag = false;

    const abort = () => {
        abortFlag = true
    }

    const addToQueue = (msg: string) => {
        if (Array.isArray(msg)) {
            msg.forEach(e => addToQueue(e))
        }
        else {
            if (queueResolve) {
                queueResolve(msg)
                queueResolve = undefined
            }
            else {
                queue.push(msg)
                if (queue.length > 10) {
                    queue.shift()
                }
            }
        }
    }

    const makeAsyncGenerator = async function* () {
        while (!abortFlag) {
            yield queue.length > 0 ? Promise.resolve(queue.shift()) : new Promise(r => { queueResolve = r })
        }
    }
    
    return { addToQueue, makeAsyncGenerator, abort }
}

/////////////////////////////////////////

const makeJSONRPC = (addToQueue: (msg: string) => void) => {
    const reqQueueMap = new Map<string, [(str: any) => void, (reason?: any) => void, any]>()
    let id = 0

    const abort = () => {
        for (let [idString, [resolve, reject, handler]] of reqQueueMap) {
            clearTimeout(handler)
            reject(new Error('jsonrpc abort'))
        }
        reqQueueMap.clear()
    }

    const request = (method: string, params: any, timeout = 5000) => {
        let idString = `${++id}`
        let req = {
            jsonrpc: "2.0",
            id: idString,
            method,
            params
        }
        addToQueue(JSON.stringify(req))
        return new Promise<any>((resolve, reject) => {
            reqQueueMap.set(idString, [resolve, reject, setTimeout(() => {
                if (reqQueueMap.has(idString)) {
                    reqQueueMap.delete(idString)
                    reject(new Error('jsonrpc timeout'))
                }
            }, timeout)])
        })
    }

    const notify = (method: string, params: any) => {
        let idString = `${++id}`
        let req = {
            jsonrpc: "2.0",
            id: idString,
            method,
            params
        }
        addToQueue(JSON.stringify(req))
    }

    const receiveMsg = (data: any, handleMsg: (method: string, params: any) => void) => {
        try {
            let obj = JSON.parse(data)
            let info = reqQueueMap.get(obj.id)
            if (info) {
                let [resolve, reject, handler] = info
                clearTimeout(handler)
                resolve(obj.params)
                reqQueueMap.delete(obj.id)
            }
            else {
                handleMsg(obj.method, obj.params)
            }
        }
        catch (err) {
            console.error('\n$ Error, handleMsg', err)
        }
    }

    return { request, notify, receiveMsg, abort }
}