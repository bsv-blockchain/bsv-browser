import React from 'react'
import { ScrollView } from 'react-native'
import BookmarkTabs from './BookmarkTabs'
// import bookmarkStore from './BookmarkStore'
import bookmarkStore from '../../stores/BookmarkStore'

const Tabs: React.FC = () => {
  return (
    <ScrollView>
      {bookmarkStore.tabs.map((tab, index) => (
        <BookmarkTabs key={tab.id} tab={tab} index={index} removeTab={bookmarkStore.removeTab} />
      ))}
    </ScrollView>
  )
}

export default Tabs
