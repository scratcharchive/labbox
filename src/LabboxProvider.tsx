import axios from 'axios';
import Cookie from 'js-cookie';
import React, { createContext, FunctionComponent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BasePlugin } from '.';
import ApiConnection from './ApiConnection';
import { HitherContext } from './hither';
import initializeHitherInterface from './initializeHitherInterface';
export type { CalculationPool } from './hither';

export class ExtensionContextImpl<Plugin extends BasePlugin> {
    plugins: Plugin[] = []
    registerPlugin(p: Plugin) {
        this.plugins.push(p)
    }
}

type HandlerType = 'local' | 'remote'

export interface ServerInfo {
    nodeId?: string
    defaultFeedId?: string
    labboxConfig?: {
        compute_resource_uri: string
        job_handlers: {
            local: {
                type: HandlerType
            },
            partition1: {
                type: HandlerType
            },
            partition2: {
                type: HandlerType
            },
            partition3: {
                type: HandlerType
            },
            timeseries: {
                type: HandlerType
            }
        }
    }
}

const useWebsocketStatus = (apiConnection: ApiConnection) => {
    const [websocketStatus, setWebsocketStatus] = useState<'connected' | 'disconnected' | 'waiting'>(apiConnection.isConnected() ? 'connected' : (apiConnection.isDisconnected() ? 'disconnected' : 'waiting'))
    useEffect(() => {
        apiConnection.onConnect(() => {
            setWebsocketStatus('connected')
        })
        apiConnection.onDisconnect(() => {
            setWebsocketStatus('disconnected')
        })
    }, [apiConnection])
    return websocketStatus
}

const useServerInfo = (apiConnection: ApiConnection) => {
    const [serverInfo, setServerInfo] = useState<ServerInfo | null>(null)
    useEffect(() => {
        apiConnection.onMessage(msg => {
            const type0 = msg.type;
            if (type0 === 'reportServerInfo') {
                setServerInfo(msg.serverInfo)
            }
        });
    }, [apiConnection])
    return serverInfo
}

const useInitialLoadComplete = (apiConnection: ApiConnection) => {
    const [initialLoadComplete, setInitialLoadComplete] = useState<boolean>(false)
    useEffect(() => {
        apiConnection.onMessage(msg => {
            const type0 = msg.type;
            if (type0 === 'reportInitialLoadComplete') {
                setInitialLoadComplete(true)
            }
        });
    }, [apiConnection])
    return initialLoadComplete
}

const useHitherInterface = (apiConnection: ApiConnection, apiConfig: ApiConfig | undefined, status?: {active: boolean}) => {
    const state = useRef<{ queuedHitherJobMessages: any[] }>({ queuedHitherJobMessages: [] })
    const hither = useMemo(() => {
        const y = initializeHitherInterface(apiConfig?.baseSha1Url)
        
        y._registerSendMessage((msg) => {
            if (!apiConnection.isDisconnected()) {
                apiConnection.sendMessage(msg)
            }
            else {
                // being disconnected is not the same as not being connected
                // if connection has not yet been established, then the message will be queued in the apiConnection
                // but if disconnected, we will handle queuing here
                state.current.queuedHitherJobMessages.push(msg)
                if (msg.type === 'hitherCreateJob') {
                    state.current.queuedHitherJobMessages.push(msg)
                }
            }
        })
        apiConnection.onMessage(msg => {
            const type0 = msg.type;
            if (type0 === 'hitherJobFinished') {
                y.handleHitherJobFinished(msg);
            }
            else if (type0 === 'hitherJobError') {
                y.handleHitherJobError(msg);
            }
            else if (type0 === 'hitherJobCreated') {
                y.handleHitherJobCreated(msg);
            }
        });
        apiConnection.onConnect(() => {
            console.info('Connected to API server')
            state.current.queuedHitherJobMessages.forEach(msg => {
                apiConnection.sendMessage(msg)
            })
            state.current.queuedHitherJobMessages = []
        })
        if (apiConfig?.jupyterMode) {
            // jupyter mode
            let _iterating = false
            const model = apiConfig.jupyterModel
            if (!model) throw Error('No jupyter model.')
            model.on('msg:custom', (msgs: any[]) => {
                console.info('RECEIVED MESSAGES', msgs)
                if (msgs.length > 0) {
                    _startIterating(300) // start iterating more often if we got a message from the server (because there's activity)
                }
            })
            let _iterate_interval = 200
            const _startIterating = (interval: number) => {
                _iterate_interval = interval
                if (_iterating) {
                    model.send({ type: 'iterate' }, {})
                    return
                }
                _iterating = true
                    ; (async () => {
                        while (_iterating) {
                            // if (y.getNumActiveJobs() === 0) { // don't do this anymore because we also need to handle updates to kachery feeds
                            //     _iterating = false
                            //     return
                            // }
                            model.send({ type: 'iterate' }, {})
                            await sleepMsec(_iterate_interval)
                            _iterate_interval = Math.min(5000, _iterate_interval + 50) // decrease the rate of iteration over time
                            if ((status) && (!status.active)) _iterating = false
                        }
                    })()
            }
            _startIterating(300)
        }
        return y
    }, [apiConfig, apiConnection])
    return hither
}

export type ApiConfig = {
    webSocketUrl: string // `ws://${window.location.hostname}:15308`
    baseSha1Url: string // `http://${window.location.hostname}:15309/sha1`
    baseFeedUrl?: string // `http://${window.location.hostname}:15309/feed`
    jupyterMode?: boolean
    jupyterModel?: {
        send: (msg: any, o: any) => void
        on: (a: 'msg:custom', callback: (msgs: any[]) => void) => void
    }
}

type Props = {
    children: React.ReactNode
    extensionContext: ExtensionContextImpl<any>
    apiConfig?: ApiConfig
    status?: {active: boolean}
}

type SubfeedMessageRequest = {
    requestId: string
    feedUri: string
    subfeedName: any
    position: number
    waitMsec: number
    callback: (numNewMessages: number) => void
}

class SubfeedManager {
    _subfeedMessageRequests: {[key: string]: SubfeedMessageRequest} = {}
    constructor(private apiConnection: ApiConnection, private baseFeedUrl: string | undefined) {
        apiConnection.onMessage(msg => {
            if (msg.type === 'subfeedMessageRequestResponse') {
                const requestId = msg.requestId as string
                const numNewMessages = msg.numNewMessages as number
                if (requestId in this._subfeedMessageRequests) {
                    const cb = this._subfeedMessageRequests[requestId].callback
                    delete this._subfeedMessageRequests[requestId]
                    cb(numNewMessages)
                }
            }
        })
    }
    async getMessages(a: {feedUri: string, subfeedName: any, position: number, waitMsec: number}): Promise<any[]> {
        const url = `${this.baseFeedUrl}/getMessages`
        const { feedUri, subfeedName, position, waitMsec } = a
        const headers = this._postHeaders()
        const result = await axios.post(url, {feedUri, subfeedName, position, waitMsec}, {headers})
        const messages = result.data as any[]
        if (messages.length > 0) {
            return messages
        }
        if (waitMsec > 0) {
            return new Promise((resolve, reject) => {
                let completed = false
                const req: SubfeedMessageRequest = {
                    requestId: randomString(10),
                    feedUri,
                    subfeedName,
                    position,
                    waitMsec,
                    callback: (numNewMessages: number) => {
                        if (numNewMessages > 0) {
                            this.getMessages({feedUri, subfeedName, position, waitMsec: 0}).then(messages => {
                                if (completed) return
                                completed = true
                                resolve(messages)
                            }).catch(err => {
                                if (completed) return
                                completed = true
                                reject(err)
                            })
                        }
                        else {
                            completed = true
                            resolve([])
                        }
                    }
                }
                this._subfeedMessageRequests[req.requestId] = req
                this.apiConnection.sendMessage({
                    type: 'subfeedMessageRequest',
                    requestId: req.requestId,
                    feedUri: req.feedUri,
                    subfeedName: req.subfeedName,
                    position: req.position,
                    waitMsec: req.waitMsec
                })
                setTimeout(() => {
                    if (!completed) {
                        console.warn('Did not get the expected response for subfeed message request')
                        completed = true
                        resolve([])
                    }
                }, waitMsec + 2000)
            })
        }
        else return []
    }
    async appendMessages(a: {feedUri: string, subfeedName: any, messages: any[]}) {
        const { feedUri, subfeedName, messages } = a
        const url = `${this.baseFeedUrl}/appendMessages`
        const headers = this._postHeaders()
        await axios.post(url, {feedUri, subfeedName, messages}, {headers})
    }
    _postHeaders() {
        // see https://pypi.org/project/jupyter-openbis-server/
        const xsrf_token = Cookie.get('_xsrf')
        if (!xsrf_token) throw Error('No _xsrf cookie found')
        return {
            "X-XSRFToken": xsrf_token,
            "credentials": "same-origin"
        }
    }
}

export const LabboxProviderContext = createContext<{
    plugins: BasePlugin[]
    websocketStatus: 'connected' | 'disconnected' | 'waiting',
    serverInfo: ServerInfo | null
    initialLoadComplete: boolean
    subfeedManager?: SubfeedManager
    onReconnectWebsocket: () => void
}>({
    plugins: [],
    websocketStatus: 'waiting',
    serverInfo: null,
    initialLoadComplete: false,
    onReconnectWebsocket: () => { }
})

export const LabboxProvider: FunctionComponent<Props> = ({ children, extensionContext, apiConfig, status }) => {
    const apiConnection = useMemo(() => (new ApiConnection(apiConfig)), [apiConfig])
    const websocketStatus = useWebsocketStatus(apiConnection)
    const serverInfo = useServerInfo(apiConnection)
    const initialLoadComplete = useInitialLoadComplete(apiConnection)
    const hither = useHitherInterface(apiConnection, apiConfig, status)
    const subfeedManager = useMemo(() => (new SubfeedManager(apiConnection, apiConfig?.baseFeedUrl)), [])
    const onReconnectWebsocket = useCallback(() => {
        apiConnection.reconnect()
    }, [apiConnection])
    const value = useMemo(() => ({
        plugins: extensionContext.plugins,
        websocketStatus,
        serverInfo,
        initialLoadComplete,
        subfeedManager,
        onReconnectWebsocket
    }), [extensionContext.plugins, websocketStatus, serverInfo, initialLoadComplete, onReconnectWebsocket])
    return (
        <LabboxProviderContext.Provider value={value}>
            <HitherContext.Provider value={hither}>
                {children}
            </HitherContext.Provider>
        </LabboxProviderContext.Provider>
    )
}

function randomString(num_chars: number) {
    var text = "";
    var possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    for (var i = 0; i < num_chars; i++)
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    return text;
}

const sleepMsec = (m: number) => new Promise(r => setTimeout(r, m));