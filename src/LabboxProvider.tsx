import React, { createContext, FunctionComponent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BasePlugin, WorkspaceInfo } from '.';
import ApiConnection from './ApiConnection';
import { HitherContext } from './hither';
import initializeHitherInterface from './initializeHitherInterface';
import { AppendOnlyLog, dummyAppendOnlyLog } from './useFeedReducer';
import WorkspaceSubfeed from './WorkspaceSubfeed';
export type { CalculationPool } from './hither';

export const LabboxProviderContext = createContext<{
    plugins: BasePlugin[]
    websocketStatus: 'connected' | 'disconnected' | 'waiting',
    serverInfo: ServerInfo | null
    initialLoadComplete: boolean
    workspaceInfo?: WorkspaceInfo
    workspaceSubfeed: AppendOnlyLog
    onReconnectWebsocket: () => void
}>({
    plugins: [],
    websocketStatus: 'waiting',
    serverInfo: null,
    initialLoadComplete: false,
    workspaceSubfeed: dummyAppendOnlyLog,
    onReconnectWebsocket: () => { }
})

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
        if (!apiConfig?.jupyterMode) {
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
        }
        else {
            // jupyter mode
            let _iterating = false
            const model = apiConfig.jupyterModel
            if (!model) throw Error('No jupyter model.')
            y._registerSendMessage(msg => {
                console.info('SENDING MESSAGE', msg)
                if (msg.type === 'hitherCreateJob') _startIterating(300)
                model.send(msg, {})
            })
            model.on('msg:custom', (msgs: any[]) => {
                console.info('RECEIVED MESSAGES', msgs)
                if (msgs.length > 0) {
                    _startIterating(300) // start iterating more often if we got a message from the server (because there's activity)
                }
                for (let msg of msgs) {
                    if (msg.type === 'hitherJobCreated') {
                        y.handleHitherJobCreated(msg)
                    }
                    else if (msg.type === 'hitherJobFinished') {
                        y.handleHitherJobFinished(msg)
                    }
                    else if (msg.type === 'hitherJobError') {
                        y.handleHitherJobError(msg)
                    }
                    else if (msg.type === 'debug') {
                        console.info('DEBUG MESSAGE', msg)
                    }
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
    jupyterMode?: boolean
    jupyterModel?: {
        send: (msg: any, o: any) => void
        on: (a: 'msg:custom', callback: (msgs: any[]) => void) => void
    }
}

type Props = {
    children: React.ReactNode
    extensionContext: ExtensionContextImpl<any>
    workspaceInfo?: WorkspaceInfo
    apiConfig?: ApiConfig
    status?: {active: boolean}
}

const useWorkspaceSubfeed = (apiConnection: ApiConnection, workspaceInfo?: WorkspaceInfo) => {
    return useMemo(() => {
        const x = new WorkspaceSubfeed(apiConnection)
        if (workspaceInfo) x.initialize(workspaceInfo)
        return x
    }, [apiConnection, workspaceInfo])
}

export const LabboxProvider: FunctionComponent<Props> = ({ children, extensionContext, workspaceInfo, apiConfig, status }) => {
    const apiConnection = useMemo(() => (new ApiConnection(apiConfig?.webSocketUrl)), [apiConfig?.webSocketUrl])
    const websocketStatus = useWebsocketStatus(apiConnection)
    const serverInfo = useServerInfo(apiConnection)
    const initialLoadComplete = useInitialLoadComplete(apiConnection)
    const hither = useHitherInterface(apiConnection, apiConfig, status)
    const workspaceSubfeed = useWorkspaceSubfeed(apiConnection, workspaceInfo)
    const onReconnectWebsocket = useCallback(() => {
        apiConnection.reconnect()
        if (workspaceInfo) workspaceSubfeed.initialize(workspaceInfo)
    }, [apiConnection, workspaceSubfeed, workspaceInfo])
    const value = useMemo(() => ({
        plugins: extensionContext.plugins,
        websocketStatus,
        serverInfo,
        initialLoadComplete,
        workspaceSubfeed,
        workspaceInfo,
        onReconnectWebsocket
    }), [extensionContext.plugins, websocketStatus, serverInfo, initialLoadComplete, onReconnectWebsocket, workspaceSubfeed, workspaceInfo])
    return (
        <LabboxProviderContext.Provider value={value}>
            <HitherContext.Provider value={hither}>
                {children}
            </HitherContext.Provider>
        </LabboxProviderContext.Provider>
    )
}

const sleepMsec = (m: number) => new Promise(r => setTimeout(r, m));