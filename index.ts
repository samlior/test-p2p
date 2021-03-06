const Libp2p = require('libp2p')
const WebSockets = require('libp2p-websockets')
const { NOISE } = require('libp2p-noise')
const MPLEX = require('libp2p-mplex');
const Multiaddr = require('multiaddr')
const PeerId = require('peer-id')
const pipe = require('it-pipe')
const KadDHT = require('libp2p-kad-dht')
const GossipSub = require('libp2p-gossipsub')
const uint8ArrayFromString = require('uint8arrays/from-string')
const uint8ArrayToString = require('uint8arrays/to-string')
const CID = require('cids')
const multihashing = require('multihashing-async')
const MulticastDNS = require('libp2p-mdns')
const TCP = require('libp2p-tcp')
// const Bootstrap = require('libp2p-bootstrap')

import process from 'process';
import prompts from 'prompts';

const JSONRPCProtocol = '/JSONRPCProtocol'
const NewBlockTopic = '/NewBlock'

const peerInfoMap = new Map<string, Peer>()
const fakeDatabase = new Map<string, any>()
let localBlockHeight = 0

const stringToCID = async (str: string) => {
    const bytes = new TextEncoder().encode(str)
    const hash = await multihashing(bytes, 'sha2-256')
    return new CID(1, 'keccak-256', hash)
}

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

        if (arr[0] === 'add' || arr[0] === 'a') {
            node.peerStore.addressBook.set(PeerId.createFromB58String(arr[1]), [new Multiaddr(arr[2])])
        }
        else if (arr[0] === 'find' || arr[0] === 'f') {
            try {
                const peer = await node.peerRouting.findPeer(PeerId.createFromB58String(arr[1]))

                console.log('Found it, multiaddrs are:')
                peer.multiaddrs.forEach((ma) => console.log(`${ma.toString()}/p2p/${peer.id.toB58String()}`))
            }
            catch (err) {
                console.error('\n$ Error, findPeer', err)
            }
        }
        else if (arr[0] === 'connect' || arr[0] === 'c') {
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
                await node.dial(arr[1])
            }
            catch (err) {
                console.error('\n$ Error, dial', err)
            }
        }
        else if (arr[0] === 'ls') {
            console.log('peers:')
            for (let [peerIdString] of node.peerStore.peers.entries()) {
                console.log(peerIdString)
            }
            console.log('connected peers:')
            for (let [id] of peerInfoMap) {
                console.log(id)
            }
        }
        else if (arr[0] === 'fetch') {
            let peer = peerInfoMap.get(arr[1])
            if (peer) {
                try {
                    let results = await peer.jsonRPCRequest('ls')
                    console.log('fetch result:', results)
                }
                catch (err) {
                    console.error('$ Error, fetch', err)
                }
            }
            else {
                console.warn('$ Can not find peer')
            }
        }
        else if (arr[0] === 'disconnect' || arr[0] === 'd') {
            let peer = peerInfoMap.get(arr[1])
            if (peer) {
                try {
                    await peer.jsonRPCNotify('disconnect', [node.peerId._idB58String], true)
                    await new Promise(r => setTimeout(r, 500))
                    await node.hangUp(PeerId.createFromB58String(arr[1]))
                }
                catch (err) {
                    console.error('$ Error, disconnect', err)
                }
            }
            else {
                console.warn('$ Can not find peer')
            }
        }
        else if (arr[0] === 'send' || arr[0] === 's') {
            let peer = peerInfoMap.get(arr[1])
            if (peer) {
                peer.jsonRPCNotify('echo', arr[2])
            }
            else {
                console.warn('$ Can not find peer')
            }
        }
        else if (arr[0] === 'mine' || arr[0] === 'm') {
            let block = {
                height: Number(arr[2]),
                blockHash: arr[1],
                transactions: ['tx1', 'tx2', 'tx3']
            }
            if (block.height <= localBlockHeight) {
                console.warn('$ New block must higher than local block')
                continue
            }
            let publishBlockInfo = {
                height: block.height,
                blockHash: block.blockHash,
            }
            localBlockHeight = block.height
            fakeDatabase.set(block.blockHash, block)
            await node.contentRouting.provide(await stringToCID(block.blockHash))
            await node.pubsub.publish(NewBlockTopic, uint8ArrayFromString(JSON.stringify(publishBlockInfo)))
        }
        else if (arr[0] === 'lsblock') {
            console.log('localBlockHeight', localBlockHeight)
            for (let [hash, block] of fakeDatabase) {
                console.log(block)
            }
        }
        else {
            console.warn('$ Invalid command')
            continue
        }
    }
}

/////////////////////////////////////////

const handlJSONRPCMsg = (node, peer: Peer, method: string, params?: any) => {
    console.log('\n$ Receive jsonrpc request, method', method)
    switch (method) {
        case 'echo':
            console.log('\n$ Receive echo message:', params)
            break;
        case 'ls':
            let arr = []
            for (let [peerIdString] of node.peerStore.peers.entries()) {
                arr.push(peerIdString)
            }
            return arr;
        case 'disconnect':
            if (!params) {
                console.warn('\n$ Invalid request', params)
                return
            }
            let id = params[0]
            node.hangUp(PeerId.createFromB58String(id)).catch(err => console.error('\n$ Error, hangUp', err))
            break;
        case 'getBlockByHash':
            if (!params) {
                console.warn('\n$ Invalid request', params)
                return
            }
            let hash = params[0]
            let result = fakeDatabase.get(hash)
            return result
        default:
            console.log('\n$ Receive unkonw message:', method, params)
    }
}

const handleGossipMsg = async (node, topic: string, msg: { data: Uint8Array }) => {
    console.log('\n$ Receive gossip, topic', topic)
    switch (topic) {
        case NewBlockTopic:
            try {
                let publishBlockInfo = JSON.parse(uint8ArrayToString(msg.data))
                if (publishBlockInfo.height <= localBlockHeight) {
                    console.warn('\n$ Gossip receive block height', publishBlockInfo.height, ', but less or equal than local block height', localBlockHeight)
                    return
                }
                for await (const provider of node.contentRouting.findProviders(await stringToCID(publishBlockInfo.blockHash), { timeout: 3e3, maxNumProviders: 3 })) {
                    let id = provider.id._idB58String
                    let peer = peerInfoMap.get(id)
                    if (peer) {
                        let block = await peer.jsonRPCRequest('getBlockByHash', [publishBlockInfo.blockHash])
                        console.log('\n$ Get block from', id, block)
                        if (block.height > localBlockHeight) {
                            localBlockHeight = block.height
                            fakeDatabase.set(block.blockHash, block)
                        }
                        return
                    }
                }
            }
            catch (err) {
                console.error('\n$ Error, handle gossip msg', topic, err)
            }
            break; 
        default:
            console.log('\n$ Receive unkonw gossip:', topic, msg)
    }
}

/////////////////////////////////////////

(async () => {
    const peerkey = await PeerId.create({ bits: 1024, keyType: 'Ed25519' })

    const node = await Libp2p.create({
        peerId: peerkey,
        addresses: {
            listen: ['/ip4/0.0.0.0/tcp/0', '/ip4/0.0.0.0/tcp/0/ws']
        },
        modules: {
            transport: [TCP, WebSockets],
            connEncryption: [NOISE],
            streamMuxer: [MPLEX],
            dht: KadDHT,
            pubsub: GossipSub,
            peerDiscovery: [MulticastDNS]
            // peerDiscovery: [Bootstrap]
        },
        config:{
            dht: {
                kBucketSize: 20,
                enabled: true,
                randomWalk: {
                    enabled: true,
                    interval: 3e3,
                    timeout: 10e3
                }
            },
            peerDiscovery: {
                autoDial: true,
                [MulticastDNS.tag]: {
                    interval: 1e3,
                    enabled: true
                }
                // bootstrap: {
                //     interval: 60e3,
                //     enabled: true,
                //     list: ['...']
                // }
            },
            pubsub: {
                enabled: true,
                emitSelf: false,
                signMessages: true,
                strictSigning: true
            }
        },
        connectionManager: {
            autoDialInterval: 3e3,
            minConnections: 3,
            maxConnections: 20
        }
    })

    node.on('peer:discovery', (peer) => {
        console.log('\n$ Discovered', peer._idB58String) // Log discovered peer
    })

    node.on('error', (err) => {
        console.error('\n$ Error', err.message)
    })
    
    node.connectionManager.on('peer:connect', (connection) => {
        let id = connection.remotePeer._idB58String
        connection.newStream(JSONRPCProtocol).then(({ stream }) => {
            let peer = peerInfoMap.get(id)
            if (!peer || peer.isWriting()) {
                if (peer) {
                    peer.abort()
                    peerInfoMap.delete(id)
                }
                peer = new Peer(id, handlJSONRPCMsg.bind(undefined, node))
                peerInfoMap.set(id, peer)
            }
            console.log('\n$ Connected to', id)
            peer.pipeWriteStream(stream)
        }).catch((err) => {
            console.error('\n$ Error, newStream', err.message)
        })
    })
    
    node.connectionManager.on('peer:disconnect', (connection) => {
        let id = connection.remotePeer._idB58String
        console.log('\n$ Disconnected to', id)

        let peer = peerInfoMap.get(id)
        if (peer) {
            peer.abort()
            peerInfoMap.delete(id)
        }
        node.hangUp(connection.remotePeer).catch(err => console.error('\n$ Error, hangUp', err))
    })

    // Handle messages for the protocol
    await node.handle(JSONRPCProtocol, ({ connection, stream, protocol }) => {
        let id = connection.remotePeer._idB58String
        let peer = peerInfoMap.get(id)
        if (!peer || peer.isReading()) {
            if (peer) {
                peer.abort()
                peerInfoMap.delete(id)
            }
            peer = new Peer(id, handlJSONRPCMsg.bind(undefined, node))
            peerInfoMap.set(id, peer)
        }
        console.log('\n$ Receive', protocol, 'from', id)
        peer.pipeReadStream(stream)
    })
    
    // start libp2p
    await node.start()
    console.log('Libp2p has started', peerkey.toB58String())
    node.multiaddrs.forEach((ma) => {
        console.log(ma.toString() + '/p2p/' + peerkey.toB58String())
    })

    node.pubsub.on(NewBlockTopic, handleGossipMsg.bind(undefined, node, NewBlockTopic))
    await node.pubsub.subscribe(NewBlockTopic)

    startPrompts(node)
})();

/////////////////////////////////////

type MsgObject = {
    data: string,
    resolve?: () => void,
    reject?: (reason?: any) => void
};

class Peer {
    private abortResolve: () => void
    private abortPromise = new Promise<void>((resolve) => { this.abortResolve = resolve })
    private abortFlag: boolean = false;

    private msgQueue: MsgObject[] = [];
    private msgQueueResolve: (msg: MsgObject) => void;
    private msgQueueReject: (reason?: any) => void;

    private jsonRPCId: number = 0
    private jsonRPCRequestMap = new Map<string, [(params: any) => void, (reason?: any) => void, any]>()
    private jsonRPCMsgHandler: (peer: Peer, method: string, params?: any) => Promise<any> | any 

    private peerId: string
    private writing: boolean = false
    private reading: boolean = false

    constructor(peerId: string, jsonRPCMsgHandler: (peer: Peer, method: string, params?: any) => Promise<any> | any) {
        this.peerId = peerId
        this.jsonRPCMsgHandler = jsonRPCMsgHandler
    }

    getPeerId() {
        return this.peerId
    }

    pipeWriteStream(stream: any) {
        this.writing = true
        pipe(this.makeAsyncGenerator(), stream.sink);
    }

    pipeReadStream(stream: any) {
        this.reading = true
        pipe(stream.source, async (source) => {
            const it = source[Symbol.asyncIterator]()
            while (!this.abortFlag) {
                const result = await Promise.race([this.abortPromise, it.next()])
                if (this.abortFlag)
                    break
                const { done, value } = result  
                if (done)
                    break
                this.jsonRPCReceiveMsg(value)
            }
        })
    }

    isWriting() {
        return this.writing
    }

    isReading() {
        return this.reading
    }

    abort() {
        this.abortFlag = true
        this.abortResolve()
        if (this.msgQueueReject) {
            this.msgQueueReject(new Error('msg queue abort'))
            this.msgQueueReject = undefined
            this.msgQueueResolve = undefined
        }
        for (let msgObject of this.msgQueue) {
            if (msgObject.reject) {
                msgObject.reject(new Error('msg queue abort'))
            }
        }
        this.msgQueue = []

        for (let [idString, [resolve, reject, handler]] of this.jsonRPCRequestMap) {
            clearTimeout(handler)
            reject(new Error('jsonrpc abort'))
        }
        this.jsonRPCRequestMap.clear()
    }

    private _addToQueue(msg: MsgObject) {
        if (this.msgQueueResolve) {
            this.msgQueueResolve(msg)
            this.msgQueueResolve = undefined
            this.msgQueueReject = undefined
        }
        else {
            this.msgQueue.push(msg)
            if (this.msgQueue.length > 10) {
                console.warn('\n$ Drop message:', this.msgQueue.shift().data)
            }
        }
    }

    addToQueue(msgData: string, waiting: boolean = false) {
        return waiting ? new Promise<void>((resolve, reject) => {
            let msgObject: MsgObject = {
                data: msgData,
                resolve,
                reject
            }
            this._addToQueue(msgObject)
        }) : this._addToQueue({
            data: msgData
        })
    }

    async* makeAsyncGenerator() {
        while (!this.abortFlag) {
            let p = this.msgQueue.length > 0 ?
                Promise.resolve(this.msgQueue.shift()) :
                new Promise<MsgObject>((resolve, reject) => {
                    this.msgQueueResolve = resolve
                    this.msgQueueReject = reject
                })
            yield p.then(msg => {
                if (msg.resolve) {
                    msg.resolve()
                }
                return msg.data
            }).catch(() => {
                return { length: 0 }
            })
        }
    }

    jsonRPCRequest(method: string, params?: any, timeout = 5000) {
        let idString = `${++this.jsonRPCId}`
        let req = {
            jsonrpc: "2.0",
            id: idString,
            method,
            params
        }
        this.addToQueue(JSON.stringify(req))
        return new Promise<any>((resolve, reject) => {
            this.jsonRPCRequestMap.set(idString, [resolve, reject, setTimeout(() => {
                if (this.jsonRPCRequestMap.has(idString)) {
                    this.jsonRPCRequestMap.delete(idString)
                    reject(new Error('jsonrpc timeout'))
                }
            }, timeout)])
        })
    }

    private _jsonRPCNotify(id: string, method?: string, params?: any, waiting: boolean = false) {
        let req = {
            jsonrpc: "2.0",
            id,
            method,
            params
        }
        return this.addToQueue(JSON.stringify(req), waiting)
    }

    jsonRPCNotify(method: string, params?: any, waiting?: false): void;
    jsonRPCNotify(method: string, params?: any, waiting?: true): Promise<void>;
    jsonRPCNotify(method: string, params?: any, waiting?: boolean): Promise<void> | void;
    jsonRPCNotify(method: string, params?: any, waiting: boolean = false) {
        return this._jsonRPCNotify(`${++this.jsonRPCId}`, method, params, waiting)
    }

    jsonRPCReceiveMsg(data: any) {
        try {
            let obj = JSON.parse(data)
            let info = this.jsonRPCRequestMap.get(obj.id)
            if (info) {
                let [resolve, reject, handler] = info
                clearTimeout(handler)
                resolve(obj.params)
                this.jsonRPCRequestMap.delete(obj.id)
            }
            else {
                let result = this.jsonRPCMsgHandler(this, obj.method, obj.params)
                if (result !== undefined) {
                    if (result.then === undefined) {
                        result = Promise.resolve(result)
                    }
                    result.then((params => {
                        if (params !== undefined) {
                            this._jsonRPCNotify(obj.id, undefined, params)
                        }
                    }))
                }
            }
        }
        catch (err) {
            console.error('\n$ Error, handleMsg', err)
        }
    }
}