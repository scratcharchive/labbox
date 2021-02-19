import { useCallback, useContext, useEffect, useState } from "react"
import { LabboxProviderContext } from "./LabboxProvider"

interface SubfeedManagerInterface {
    getMessages: (a: {feedUri: string, subfeedName: any, position: number, waitMsec: number}) => Promise<any[]>
    appendMessages: (a: {feedUri: string, subfeedName: any, messages: any[]}) => void
}

class Subfeed {
    messages: any[] = []
    loadedInitialMessages = false
    _changeCallbacks: (() => void)[] = []
    _active = false
    constructor(private feedUri: string | undefined, private subfeedName: any | undefined, private subfeedManager: SubfeedManagerInterface | undefined) {
        this._active = true
        this._start()
    }
    onChange(callback: () => void) {
        this._changeCallbacks.push(callback)
    }
    cleanup() {
        this._active = false
    }
    async _start() {
        if ((this.feedUri === undefined) || (this.subfeedName === undefined)) return
        while (this._active) {
            if (this.subfeedManager) {
                const msgs = await this.subfeedManager.getMessages({feedUri: this.feedUri, subfeedName: this.subfeedName, position: this.messages.length, waitMsec: 12000})
                if (msgs.length > 0) {
                    this.messages = [...this.messages, ...msgs]
                    this.loadedInitialMessages = true
                    this._changeCallbacks.forEach(cb => cb())
                }
                else {
                    if (!this.loadedInitialMessages) {
                        this.loadedInitialMessages = true
                        this._changeCallbacks.forEach(cb => cb())
                    }
                }
            }
            await sleepMsec(100)
        }
    }
}

export const useSubfeed = (a: {feedUri: string | undefined, subfeedName: any | undefined, onMessages?: (messages: any[]) => void}) => {
    const { feedUri, subfeedName, onMessages } = a
    const { subfeedManager } = useContext(LabboxProviderContext)
    const [messages, setMessages] = useState<any[]>([])
    const [loadedInitialMessages, setLoadedInitialMessages] = useState<boolean>(false)
    useEffect(() => {
        let lastMessageReportedIndex = 0
        const subfeed = new Subfeed(feedUri, subfeedName, subfeedManager)
        const reportMessages = () => {
            if (lastMessageReportedIndex < subfeed.messages.length) {
                if (onMessages) {
                    onMessages(subfeed.messages.slice(lastMessageReportedIndex))
                }
                lastMessageReportedIndex = subfeed.messages.length
            }
        }
        subfeed.onChange(() => {
            setMessages(subfeed.messages)
            setLoadedInitialMessages(subfeed.loadedInitialMessages)
            reportMessages()
        })
        setMessages(subfeed.messages)
        setLoadedInitialMessages(subfeed.loadedInitialMessages)
        reportMessages()
        return () => {
            subfeed.cleanup()
        }
    }, [subfeedManager, feedUri, subfeedName, onMessages])
    const appendMessages = useCallback(
        (messages: any[]) => {
            if ((feedUri !== undefined) && (subfeedName !== undefined)) subfeedManager?.appendMessages({feedUri, subfeedName, messages})
        },
        [feedUri, subfeedName, subfeedManager]
    )
    return {messages, loadedInitialMessages, appendMessages}
}

const sleepMsec = (m: number) => new Promise(r => setTimeout(r, m));

export default useSubfeed