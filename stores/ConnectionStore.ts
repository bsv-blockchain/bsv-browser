import { makeAutoObservable, runInAction } from 'mobx'
import AsyncStorage from '@react-native-async-storage/async-storage'

export interface Connection {
  sessionId: string
  origin: string
  relay: string
  backendIdentityKey: string
  mobileIdentityKey: string
  protocolID: string  // JSON-stringified WalletProtocol
  connectedAt: number
  status: 'active' | 'disconnected'
}

const STORAGE_KEY = 'connections'

class ConnectionStore {
  connections: Connection[] = []

  constructor() {
    makeAutoObservable(this)
    void this.load()
  }

  add(connection: Connection) {
    const idx = this.connections.findIndex(c => c.sessionId === connection.sessionId)
    if (idx >= 0) {
      this.connections[idx] = connection
    } else {
      this.connections.push(connection)
    }
    void this.save()
  }

  setStatus(sessionId: string, status: Connection['status']) {
    const conn = this.connections.find(c => c.sessionId === sessionId)
    if (conn) {
      conn.status = status
      void this.save()
    }
  }

  remove(sessionId: string) {
    this.connections = this.connections.filter(c => c.sessionId !== sessionId)
    void this.save()
  }

  private async save() {
    try {
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(this.connections))
    } catch (e) {
      console.warn('[ConnectionStore] save failed', e)
    }
  }

  private async load() {
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY)
      if (raw) {
        runInAction(() => {
          this.connections = JSON.parse(raw) as Connection[]
        })
      }
    } catch (e) {
      console.warn('[ConnectionStore] load failed', e)
    }
  }
}

const connectionStore = new ConnectionStore()
export default connectionStore
