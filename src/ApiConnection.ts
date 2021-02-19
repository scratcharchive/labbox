import { ApiConfig } from "./LabboxProvider"

class ApiConnection {
    _ws: WebSocket | null = null
    _isConnected: boolean = false
    _onMessageCallbacks: ((m: any) => void)[] = []
    _onConnectCallbacks: (() => void)[] = []
    _onDisconnectCallbacks: (() => void)[] = []
    _isDisconnected = false // once disconnected, cannot reconnect - need to create a new instance
    _queuedMessages: any[] = []

    constructor(private apiConfig: ApiConfig | undefined) {
        this._start();
        this._connect()
    }
    _connect() {
        const apiConfig = this.apiConfig
        if (!apiConfig) return
        if (apiConfig.jupyterMode) {
            const model = apiConfig.jupyterModel
            if (!model) throw Error('No jupyter model.')
            model.on('msg:custom', (msgs: any[]) => {
                for (const m of msgs) {
                    this._onMessageCallbacks.forEach(cb => cb(m))
                }
            })
            this._isConnected = true
            this._onConnectCallbacks.forEach(cb => cb())
        }
        else {
            const url = apiConfig.webSocketUrl;
            if (!url) throw Error('No webSocketUrl')
            const ws = new WebSocket(url)
            this._ws = ws
            console.log(ws);
            ws.addEventListener('open', () => {
                this._isConnected = true;
                this._isDisconnected = false;
                const qm = this._queuedMessages;
                this._queuedMessages = [];
                for (let m of qm) {
                    this.sendMessage(m);
                }
                this._onConnectCallbacks.forEach(cb => cb());
            });
            ws.addEventListener('message', evt => {
                const x = JSON.parse(evt.data);
                if (!Array.isArray(x)) {
                    console.warn(x)
                    console.warn('Error getting message, expected a list')
                    return
                }
                console.info('INCOMING MESSAGES', x);
                for (const m of x) {
                    this._onMessageCallbacks.forEach(cb => cb(m))
                }
            });
            ws.addEventListener('close', () => {
                console.warn('Websocket disconnected.');
                this._isConnected = false;
                this._isDisconnected = true;
                this._onDisconnectCallbacks.forEach(cb => cb())
            })
        }
    }
    reconnect() {
        if (!this._isDisconnected) {
            throw Error('Error: Cannot reconnect if not disconnected')
        }
        this._connect()
    }
    onMessage(cb: (m: any) => void) {
        this._onMessageCallbacks.push(cb);
    }
    onConnect(cb: () => void) {
        this._onConnectCallbacks.push(cb);
        if (this._isConnected) {
            cb();
        }
    }
    onDisconnect(cb: () => void) {
        this._onDisconnectCallbacks.push(cb)
        if (this._isDisconnected) {
            cb()
        }
    }
    isDisconnected() {
        return this._isDisconnected;
    }
    isConnected() {
        return this._isConnected
    }
    sendMessage(msg: any) {
        const apiConfig = this.apiConfig
        if (!apiConfig) return
        if (apiConfig.jupyterMode) {
            const model = apiConfig.jupyterModel
            if (!model) throw Error('No jupyter model.')
            console.info('OUTGOING MESSAGE (jupyter)', msg);
            model.send(msg, {})
        }
        else {
            if ((!this._isConnected) && (!this._isDisconnected)) {
                this._queuedMessages.push(msg);
                return;
            }
            if (!this._ws) throw Error('Unexpected: _ws is null')
            console.info('OUTGOING MESSAGE', msg);
            this._ws.send(JSON.stringify(msg));
        }
    }
    async _start() {
        while (true) {
            await sleepMsec(17000);
            if (!this._isDisconnected) this.sendMessage({ type: 'keepAlive' });
        }
    }
}

const sleepMsec = (m: number) => new Promise(r => setTimeout(r, m));

export default ApiConnection