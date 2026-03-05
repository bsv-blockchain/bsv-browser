// stores/BookmarkStore.tsx
import { makeAutoObservable } from 'mobx'
import { Bookmark } from '@/shared/types/browser'
import { defaultBookmarks } from '@/shared/constants'
import AsyncStorage from '@react-native-async-storage/async-storage'
import tabStore from './TabStore'
import { isValidUrl } from '@/utils/generalHelpers'
import { Platform } from 'react-native'

export class BookmarkStore {
  bookmarks: Bookmark[] = defaultBookmarks

  constructor() {
    makeAutoObservable(this)
    if (typeof window === 'undefined' || Platform.OS == null) {
      return
    }
    this.loadBookmarks()
  }

  addBookmark(title: string, url: string) {
    if (!this.bookmarks.find(b => b.url === url)) {
      this.bookmarks.push({ title, url, added: Date.now() })
      this.saveBookmarks()
    }
  }

  editBookmark(url: string, newTitle: string, newUrl: string) {
    const bookmark = this.bookmarks.find(b => b.url === url)
    if (bookmark) {
      bookmark.title = newTitle || bookmark.title
      bookmark.url = newUrl && isValidUrl(newUrl) ? newUrl : bookmark.url
      bookmark.added = Date.now()
      this.saveBookmarks()
    }
  }

  removeBookmark(url: string) {
    this.bookmarks = this.bookmarks.filter(b => b.url !== url)
    this.saveBookmarks()
  }

  clearBookmarks() {
    this.bookmarks = []
    this.saveBookmarks()
  }

  openBookmark(url: string) {
    tabStore.newTab(url)
  }

  async saveBookmarks() {
    await AsyncStorage.setItem('bookmarks', JSON.stringify(this.bookmarks))
  }

  async loadBookmarks() {
    const savedBookmarks = await AsyncStorage.getItem('bookmarks')
    if (savedBookmarks) {
      this.bookmarks = JSON.parse(savedBookmarks)
    } else {
      this.bookmarks = defaultBookmarks
      this.saveBookmarks()
    }
  }
}

const bookmarkStore = new BookmarkStore()
export default bookmarkStore
