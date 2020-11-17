const Libp2p = require('libp2p')
const WebSockets = require('libp2p-websockets')
const { NOISE } = require('libp2p-noise')
const MPLEX = require('libp2p-mplex');
const Multiaddr = require('multiaddr')
const PeerId = require('peer-id')
const pipe = require('it-pipe')
const KadDHT = require('libp2p-kad-dht')
// const Bootstrap = require('libp2p-bootstrap')

import process from 'process';
import prompts from 'prompts';

const peerInfoMap = new Map<string, Peer>()
const connectPeerSet = new Set<string>()

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
                connectPeerSet.add(arr[1])
                const peer = await node.peerRouting.findPeer(PeerId.createFromB58String(arr[1]))

                console.log('Found it, multiaddrs are:')
                peer.multiaddrs.forEach((ma) => console.log(`${ma.toString()}/p2p/${peer.id.toB58String()}`))
            }
            catch (err) {
                connectPeerSet.delete(arr[1])
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
                connectPeerSet.add(id)
                await node.dial(arr[1])
            }
            catch (err) {
                connectPeerSet.delete(id)
                console.error('\n$ Error, dial', err)
            }
        }
        else if (arr[0] === 'disconnectpeer' || arr[0] === 'd') {
            try {
                await node.hangUp(PeerId.createFromB58String(arr[1]))
            }
            catch (err) {
                let peer = peerInfoMap.get(arr[1])
                if (peer) {
                    peer.abort()
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
        else if (arr[0] === 'sendmsg' || arr[0] === 's') {
            let peer = peerInfoMap.get(arr[1])
            if (peer) {
                peer.jsonRPCNotify('echo', arr[2])
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

const handlRPCMsg = (node, peer: Peer, method: string, params?: any) => {
    console.log('\n$ Receive request, method', method)
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
        default:
            console.log('\n$ Receive unkonw message:', params)
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
            dht: KadDHT,
            // peerDiscovery: [Bootstrap]
        },
        config:{
            dht: {
                enabled: true
            },
            // peerDiscovery: {
            //     bootstrap: {
            //         interval: 60e3,
            //         enabled: true,
            //         list: ['...']
            //     }
            // }
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
        if (connectPeerSet.has(id) && !peerInfoMap.has(id)) {
            connectPeerSet.delete(id)
            console.log('\n$ Connected to', id)
            connection.newStream('/wuhu').then(({ stream }) => {
                console.log('create stream', id)
                let peer = new Peer(id, handlRPCMsg.bind(undefined, node))
                peerInfoMap.set(id, peer)
                peer.pipeStream(stream)
            }).catch((err) => {
                console.error('\n$ Error, newStream', err.message)
            })
        }
    })
    
    node.connectionManager.on('peer:disconnect', (connection) => {
        let id = connection.remotePeer._idB58String
        console.log('\n$ Disconnected to', id)

        let peer = peerInfoMap.get(id)
        if (peer) {
            peer.abort()
            peerInfoMap.delete(id)
        }
    })

    // Handle messages for the protocol
    await node.handle('/wuhu', ({ connection, stream, protocol }) => {
        let id = connection.remotePeer._idB58String
        if (!peerInfoMap.has(id)) {
            console.log('\n$ Receive', protocol, 'from', id)
            let peer = new Peer(id, handlRPCMsg.bind(undefined, node))
            peerInfoMap.set(id, peer)
            peer.pipeStream(stream)
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

/////////////////////////////////////

class Peer {
    private abortFlag: boolean = false;

    private msgQueue: string[] = [];
    private msgQueueResolve: (msg: string) => void;

    private jsonRPCId: number = 0
    private jsonRPCRequestMap = new Map<string, [(params: any) => void, (reason?: any) => void, any]>()
    private jsonRPCMsgHandler: (peer: Peer, method: string, params?: any) => Promise<any> | any 

    private peerId: string

    constructor(peerId: string, jsonRPCMsgHandler: (peer: Peer, method: string, params?: any) => Promise<any> | any) {
        this.peerId = peerId
        this.jsonRPCMsgHandler = jsonRPCMsgHandler
    }

    getPeerId() {
        return this.peerId
    }

    async pipeStream(stream: any) {
        pipe(this.makeAsyncGenerator(), stream.sink);
        pipe(stream.source, async (source) => {
            for await (let data of source) {
                this.jsonRPCReceiveMsg(data)
            }
        })
    }

    abort() {
        this.abortFlag = true

        for (let [idString, [resolve, reject, handler]] of this.jsonRPCRequestMap) {
            clearTimeout(handler)
            reject(new Error('jsonrpc abort'))
        }
        this.jsonRPCRequestMap.clear()
    }

    addToQueue(msg: string) {
        if (this.msgQueueResolve) {
            this.msgQueueResolve(msg)
            this.msgQueueResolve = undefined
        }
        else {
            this.msgQueue.push(msg)
            if (this.msgQueue.length > 10) {
                console.warn('\n$ Drop message:', this.msgQueue.shift())
            }
        }
    }

    async* makeAsyncGenerator() {
        while (!this.abortFlag) {
            yield this.msgQueue.length > 0 ? Promise.resolve(this.msgQueue.shift()) : new Promise<string>(r => { this.msgQueueResolve = r })
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

    private _jsonRPCNotify(id: string, method?: string, params?: any) {
        let req = {
            jsonrpc: "2.0",
            id,
            method,
            params
        }
        this.addToQueue(JSON.stringify(req))
    }

    jsonRPCNotify(method: string, params?: any) {
        this._jsonRPCNotify(`${++this.jsonRPCId}`, method, params)
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